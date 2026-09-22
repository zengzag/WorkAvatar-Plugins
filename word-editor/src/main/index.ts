// word-editor 插件主进程入口
//
// 文档内容为 wordcanvas Document 模型 JSON（主进程仅作不透明字符串存储）。
// 导入：主进程读 .docx 字节 → 交渲染端 wordcanvas 解析为 Document；
// 导出：渲染端 wordcanvas 生成 Blob → 交主进程弹框落盘。

import path from 'path'
import fs from 'fs'
import type { PluginContext, PluginMainModule, PluginToolDefinition } from '@workavatar/plugin-sdk'
import { BLANK_DOCUMENT_JSON } from '../shared/blank-document'
import { docStore, filesDir, createTaskWorkspace, isWithinTaskRoot } from './doc-store'
import { DOC_SYSTEM_PROMPT, buildScopeHint, type ScopeHintPayload } from './system-prompt'
import { listSystemFonts } from './system-fonts'
import { docOpBridge } from './doc-op-bridge'
import { beginAiEditTurn, createWordEditorAgentTools, endAiEditTurn } from './doc-tools'

let ctxRef: PluginContext | null = null
const activeAborts = new Map<string, Set<AbortController>>()
let unsubscribeEvents: Array<() => void> = []
/** AI 文档工具（activate 时创建，供插件内对话与数字员工共用） */
let agentTools: PluginToolDefinition[] = []

function broadcast(event: string, payload?: unknown): void {
  ctxRef?.ipc.broadcast(event, payload)
}

function t(key: string, params?: Record<string, string | number>): string {
  return ctxRef?.services.i18n.t(key, params) ?? key
}

function createDocId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 弹框选择 .docx；用户取消返回 null */
async function pickDocxPath(): Promise<string | null> {
  const { dialog } = require('electron')
  const res = await dialog.showOpenDialog({
    title: t('dialog.importDocx'),
    properties: ['openFile'],
    filters: [
      { name: t('dialog.docxFilter'), extensions: ['docx'] },
      { name: 'All', extensions: ['*'] },
    ],
  })
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
}

function registerIpc(ctx: PluginContext): void {
  // ====== 文档 ======
  ctx.ipc.handle('doc-list', () => docStore.list())

  ctx.ipc.handle('doc-create', (payload: any) => {
    const title = (typeof payload?.title === 'string' && payload.title.trim()) || t('defaults.untitledDoc')
    const id = createDocId()
    docStore.save(id, title, payload?.data ? String(payload.data) : BLANK_DOCUMENT_JSON)
    docStore.setCurrentDocId(id)
    broadcast('doc-list-changed', { ts: Date.now() })
    return { doc: docStore.get(id) }
  })

  ctx.ipc.handle('doc-open', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: t('errors.missingDocId') }
    const rec = docStore.get(id)
    if (!rec) return { error: t('errors.docNotFound') }
    docStore.setCurrentDocId(id)
    return { doc: rec }
  })

  ctx.ipc.handle('doc-delete', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: t('errors.missingDocId') }
    docStore.delete(id)
    if (docStore.getCurrentDocId() === id) docStore.setCurrentDocId(null)
    broadcast('doc-list-changed', { ts: Date.now() })
    return { ok: true }
  })

  ctx.ipc.handle('doc-rename', (payload: any) => {
    const id = payload?.id
    const title = payload?.title
    if (!id || typeof title !== 'string' || !title.trim()) return { error: t('errors.missingDocName') }
    docStore.setTitle(id, title.trim())
    broadcast('doc-list-changed', { ts: Date.now() })
    return { ok: true }
  })

  ctx.ipc.handle('doc-save', (payload: any) => {
    const id = payload?.id
    const data = payload?.data
    const title = payload?.title
    if (!id || typeof data !== 'string') return { error: t('errors.missingDocId') }
    const rec = docStore.get(id)
    if (!rec) return { error: t('errors.docNotFound') }
    docStore.save(id, typeof title === 'string' && title.trim() ? title.trim() : rec.title, data)
    docStore.setCurrentDocId(id)
    return { ok: true, updatedAt: docStore.get(id)?.updatedAt ?? Date.now() }
  })

  // ====== 导入：主进程读 .docx 字节，交渲染端 wordcanvas 解析 ======
  ctx.ipc.handle('doc-import-file', async (payload: any) => {
    const absPath = payload?.path || await pickDocxPath()
    if (!absPath) return {}
    try {
      const buf = fs.readFileSync(absPath)
      // 原文件留档（溯源）
      const safeName = `${Date.now().toString(36)}_${path.basename(absPath).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`
      const dest = path.join(filesDir(ctx), safeName)
      fs.writeFileSync(dest, buf)
      return {
        bytes: new Uint8Array(buf),
        name: path.basename(absPath).replace(/\.docx$/i, ''),
        sourcePath: dest,
      }
    } catch (e) {
      return { error: t('errors.importFailed', { message: e instanceof Error ? e.message : String(e) }) }
    }
  })

  // ====== 导出：接收渲染端 wordcanvas 产出的字节并落盘 ======
  ctx.ipc.handle('export-save', async (payload: any) => {
    const { bytes, format, title } = payload ?? {}
    if (!bytes) return { error: t('errors.exportFailed', { message: 'empty payload' }) }
    const ext = format === 'pdf' ? 'pdf' : 'docx'
    const { dialog } = require('electron')
    const res = await dialog.showSaveDialog({
      title: ext === 'pdf' ? t('dialog.exportPdf') : t('dialog.exportDocx'),
      defaultPath: `${title || 'document'}.${ext}`,
      filters: ext === 'pdf'
        ? [{ name: t('dialog.pdfFilter'), extensions: ['pdf'] }]
        : [{ name: t('dialog.docxFilter'), extensions: ['docx'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false }
    try {
      fs.writeFileSync(res.filePath, Buffer.from(bytes))
      return { ok: true, path: res.filePath }
    } catch (e) {
      return { error: t('errors.exportFailed', { message: e instanceof Error ? e.message : String(e) }) }
    }
  })

  // ====== 快照 ======
  ctx.ipc.handle('snapshot-list', (payload: any) => {
    const id = payload?.id ?? docStore.getCurrentDocId()
    if (!id) return { error: t('errors.missingDocId') }
    return { snapshots: docStore.listSnapshots(id) }
  })

  ctx.ipc.handle('snapshot-create', (payload: any) => {
    const id = payload?.id ?? docStore.getCurrentDocId()
    if (!id) return { error: t('errors.missingDocId') }
    const rec = docStore.get(id)
    if (!rec) return { error: t('errors.docNotFound') }
    docStore.createSnapshot(id, payload?.label || t('page.history'), rec.data)
    return { ok: true }
  })

  ctx.ipc.handle('snapshot-restore', (payload: any) => {
    const snap = payload?.snapshotId ? docStore.getSnapshot(String(payload.snapshotId)) : null
    if (!snap) return { error: t('errors.docNotFound') }
    docStore.saveData(snap.docId, snap.data)
    docStore.setCurrentDocId(snap.docId)
    broadcast('doc-changed', { doc: { id: snap.docId, data: snap.data }, source: 'restore' })
    return { ok: true }
  })

  ctx.ipc.handle('snapshot-delete', (payload: any) => {
    if (!payload?.id) return { error: t('errors.missingDocId') }
    docStore.deleteSnapshot(String(payload.id))
    return { ok: true }
  })

  // ====== 供应商（复用宿主数据能力） ======
  ctx.ipc.handle('providers-list', async () => {
    const data = ctx.services.data
    if (!data) return []
    return (await data.query('llmProviders')) as any[]
  })

  // ====== 设置 ======
  ctx.ipc.handle('settings-get', () => ({ settings: docStore.getSettings() }))
  ctx.ipc.handle('settings-set', (payload: any) => {
    docStore.setSettings(payload?.settings ?? {})
    return { ok: true }
  })

  // ====== 系统字体（编辑器字体下拉展示 + 画布直通渲染） ======
  ctx.ipc.handle('font-list', () => ({ fonts: listSystemFonts() }))

  // ====== 文档操作桥（工具 → 渲染端活跃编辑器） ======
  // 渲染端挂载/卸载编辑页面时上报在线状态；执行结果经 doc-op-result 回传
  ctx.ipc.handle('doc-op-attach', (payload: any) => {
    docOpBridge.setAttached(payload?.attached !== false)
    return { ok: true }
  })

  ctx.ipc.handle('doc-op-result', (payload: any) => docOpBridge.settle(payload))

  // ====== AI 对话（复用宿主通用对话引擎） ======
  ctx.ipc.handle('chat-send', async (payload: any, signal?: AbortSignal) => {
    const execute = ctx.services.execute
    if (!execute) return { error: t('errors.executeUnavailable') }
    const { providerId, modelId, messages, conversationId, scopeHint } = payload ?? {}
    if (!messages || messages.length === 0) return { error: t('errors.missingMessages') }

    let resolvedProviderId = providerId
    let resolvedModelId = modelId
    if (!resolvedProviderId) {
      const settings = docStore.getSettings()
      resolvedProviderId = settings.defaultProviderId
      resolvedModelId = resolvedModelId ?? settings.defaultModelId
    }
    if (!resolvedProviderId) {
      const data = ctx.services.data
      if (data) {
        const providers = ((await data.query('llmProviders')) as any[]) ?? []
        const def = providers.find((p) => p.is_default) ?? providers[0]
        resolvedProviderId = def?.id
        if (!resolvedModelId) resolvedModelId = def?.model
      }
    }
    if (!resolvedProviderId) return { error: t('errors.noProvider') }

    const controller = new AbortController()
    const abortKey = conversationId || `pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    let abortSet = activeAborts.get(abortKey)
    if (!abortSet) { abortSet = new Set(); activeAborts.set(abortKey, abortSet) }
    abortSet.add(controller)
    const mergedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const lastMsg = messages[messages.length - 1]
    const isNewConv = !conversationId
    const convId = conversationId || `we_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    let acc = ''
    let thought = ''
    let errText = ''

    let workspacePath: string | null = null
    if (isNewConv) {
      try { workspacePath = createTaskWorkspace(ctx) } catch (e) {
        ctx.services.logger.warn('创建任务工作区失败:', e instanceof Error ? e.message : String(e))
      }
    } else {
      workspacePath = docStore.getChatWorkspacePath(conversationId)
    }
    const system = buildChatSystem(DOC_SYSTEM_PROMPT, workspacePath, normalizeScopeHint(scopeHint))

    let lastConvId: string | null = isNewConv ? null : convId

    // 本轮起止：文档工具在首个改动前自动落快照，便于用户回退整轮 AI 改动
    beginAiEditTurn()
    try {
      const result = await execute.execute(
        {
          kind: 'agent-chat',
          providerId: resolvedProviderId,
          modelId: resolvedModelId,
          messages,
          conversationId: convId,
          system,
          tools: agentTools,
          useSkills: false,
          enableThinking: true,
          minimalMode: false,
          highPermission: false,
          enableBuiltinTools: true,
          workspacePath: workspacePath ?? undefined,
        },
        {
          onChunk: (text) => { acc += text; broadcast('chat-event', { type: 'chunk', text }) },
          onThought: (tc) => { thought += tc; broadcast('chat-event', { type: 'thought', thought: tc }) },
          onToolCall: (toolCall) => broadcast('chat-event', { type: 'tool-call', toolCall }),
          onToolCallDelta: (delta) => broadcast('chat-event', { type: 'tool-call-delta', delta }),
          onToolResult: (toolResult) => broadcast('chat-event', { type: 'tool-result', ...toolResult }),
          onToolProgress: (progress) => broadcast('chat-event', { type: 'tool-progress', ...progress }),
          onDone: (metadata) => broadcast('chat-event', { type: 'done', metadata }),
          onError: (error) => {
            errText = error
            broadcast('chat-event', { type: 'error', error })
          },
        },
        mergedSignal
      )
      lastConvId = (result as { conversationId: string }).conversationId || convId

      if (lastConvId) {
        const existing = docStore.getMessages(lastConvId)
        const userMsg = { id: lastMsg?.id, role: 'user' as const, content: lastMsg?.content ?? '' }
        const assistantMsg: Record<string, unknown> = { id: payload?.assistantId, role: 'assistant', content: acc }
        if (thought) assistantMsg.reasoning_content = thought
        if (errText) assistantMsg.content = `${assistantMsg.content as string}${acc ? '\n\n' : ''}[错误] ${errText}`
        const hasUser = existing.some((m) => (m as any).role === 'user' && (m as any).content === userMsg.content)
        try {
          docStore.saveMessages(lastConvId, [...(hasUser ? existing : [...existing, userMsg]), assistantMsg])
          docStore.saveChat({
            conversationId: lastConvId,
            title: lastMsg?.content?.slice(0, 40) || t('chat.defaultTitle'),
            updatedAt: Date.now(),
            workspacePath,
          })
          broadcast('chats-changed', { ts: Date.now() })
        } catch (e) {
          ctx.services.logger.warn('持久化对话消息失败:', e instanceof Error ? e.message : String(e))
        }
      }
      return { conversationId: lastConvId, workspacePath } as { conversationId: string; workspacePath: string | null }
    } finally {
      endAiEditTurn()
      const set = activeAborts.get(abortKey)
      set?.delete(controller)
      if (set && set.size === 0) activeAborts.delete(abortKey)
    }
  })

  ctx.ipc.handle('chat-cancel', (payload: any) => {
    const targets = payload?.conversationId
      ? [activeAborts.get(payload.conversationId)].filter(Boolean)
      : [...activeAborts.values()]
    for (const set of targets) {
      for (const c of set!) c.abort()
    }
    return { ok: true }
  })

  ctx.ipc.handle('chat-history', (payload: any) => {
    if (!payload?.conversationId) return []
    return docStore.getMessages(payload.conversationId)
  })

  ctx.ipc.handle('chats-list', () => docStore.listChats())

  ctx.ipc.handle('chat-delete', (payload: any) => {
    const convId = payload?.conversationId
    if (!convId) return { error: t('errors.missingTokens') }
    const ws = docStore.getChatWorkspacePath(convId)
    docStore.deleteChat(convId)
    broadcast('chats-changed', { ts: Date.now() })
    let taskDir: string | undefined
    let taskDirNonEmpty: boolean | undefined
    if (ws && isWithinTaskRoot(ctx, ws) && fs.existsSync(ws)) {
      try {
        if (fs.readdirSync(ws).length === 0) fs.rmdirSync(ws)
        else { taskDir = ws; taskDirNonEmpty = true }
      } catch { /* ignore */ }
    }
    return { ok: true, taskDir, taskDirNonEmpty }
  })

  ctx.ipc.handle('chat-open-dir', (payload: any) => {
    const ws = payload?.conversationId ? docStore.getChatWorkspacePath(payload.conversationId) : null
    if (!ws || !fs.existsSync(ws)) return { ok: false, error: t('errors.workspaceNotFound') }
    try {
      const { shell } = require('electron')
      if (shell?.openPath) shell.openPath(ws)
    } catch { /* ignore */ }
    return { ok: true }
  })
}

function buildChatSystem(base: string, workspacePath: string | null, scope?: ScopeHintPayload | null): string {
  const doc = docStore.getCurrentDoc()
  const docInfo = doc
    ? `\n\n当前打开的文档：《${doc.title}》。`
    : '\n\n当前没有打开的文档。'
  const ws = workspacePath
    ? `\n\n当前任务工作区目录：${workspacePath}\n该目录为本次对话的专属任务文件夹，可用 file_read / file_write / file_edit / shell_exec 读取、写入其中的文件。`
    : ''
  return base + docInfo + ws + buildScopeHint(scope)
}

/** 校验渲染端上报的作用域（结构不合法时忽略，避免污染系统提示词） */
function normalizeScopeHint(raw: unknown): ScopeHintPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.kind !== 'selection' && s.kind !== 'caret') return null
  const anchor = s.anchor as { blockId?: unknown; offset?: unknown } | undefined
  if (!anchor || typeof anchor.blockId !== 'string' || typeof anchor.offset !== 'number') return null
  const scope: ScopeHintPayload = { kind: s.kind, anchor: { blockId: anchor.blockId, offset: anchor.offset } }
  if (typeof s.text === 'string' && s.text) {
    scope.text = s.text.slice(0, 8000)
  }
  if (typeof s.blockPreview === 'string') scope.blockPreview = s.blockPreview.slice(0, 100)
  const focus = s.focus as { blockId?: unknown; offset?: unknown } | undefined
  if (focus && typeof focus.blockId === 'string' && typeof focus.offset === 'number') {
    scope.focus = { blockId: focus.blockId, offset: focus.offset }
  }
  return scope
}

export const migrations = []

export function activate(ctx: PluginContext): void {
  ctxRef = ctx
  docStore.init(ctx)
  docOpBridge.init(ctx)

  // 默认打开最近文档，便于后续能力尽快可用
  const docs = docStore.list()
  if (docs.length > 0) docStore.setCurrentDocId(docs[0].id)

  registerIpc(ctx)

  // AI 文档工具：插件内对话直接使用；同时注册进宿主工具表供数字员工调用
  agentTools = createWordEditorAgentTools({
    snapshotLabel: t('snapshot.aiEdit'),
    onDocChanged: (id, data) => broadcast('doc-changed', { doc: { id, data }, source: 'ai' }),
  })
  ctx.contributions.registerAgentTools(agentTools)

  const events = ctx.services.events
  if (events) {
    unsubscribeEvents.push(events.subscribe('provider:changed', () => {
      broadcast('meta-changed', { scope: 'providers', ts: Date.now() })
    }))
  }

  ctx.services.logger.info('word-editor 插件激活完成')
}

export function deactivate(): void {
  for (const set of activeAborts.values()) {
    for (const c of set) c.abort()
  }
  activeAborts.clear()
  docOpBridge.cancelAll()
  docOpBridge.setAttached(false)
  agentTools = []
  unsubscribeEvents.forEach((unsub) => { try { unsub() } catch { /* ignore */ } })
  unsubscribeEvents = []
  ctxRef = null
}

const mod: PluginMainModule = { migrations, activate, deactivate }
export default mod
