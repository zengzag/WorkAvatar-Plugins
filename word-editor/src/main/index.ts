// word-editor 插件主进程入口
// TODO 7b + 2 + 5 + 9 接线：文档 CRUD / 导入导出 / 快照 / AI 对话

import fs from 'fs'
import type { PluginContext, PluginMainModule } from '@workavatar/plugin-sdk'
import { docStore, filesDir, createTaskWorkspace, isWithinTaskRoot, taskRootDir } from './doc-store'
import { pickAndImportDocx, importDocx } from './docx-import'
import { saveDocxFile, savePdfFile } from './docx-export'
import { initDocSession, syncCurrentDoc, syncCurrentDocHtml, createDocAgentTools } from './doc-session'
import { DOC_SYSTEM_PROMPT } from './system-prompt'

let ctxRef: PluginContext | null = null
const activeAborts = new Map<string, Set<AbortController>>()
let unsubscribeEvents: Array<() => void> = []

function broadcast(event: string, payload?: unknown): void {
  ctxRef?.ipc.broadcast(event, payload)
}

function t(key: string, params?: Record<string, string | number>): string {
  return ctxRef?.services.i18n.t(key, params) ?? key
}

function createDocId(): string {
  return `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function registerIpc(ctx: PluginContext): void {
  // ====== 文档 ======
  ctx.ipc.handle('doc-list', () => docStore.list())

  ctx.ipc.handle('doc-create', (payload: any) => {
    const title = (typeof payload?.title === 'string' && payload.title.trim()) || t('defaults.untitledDoc')
    const id = createDocId()
    const html = payload?.html ? String(payload.html) : '<p></p>'
    docStore.save(id, title, html)
    docStore.setCurrentDocId(id)
    syncCurrentDoc(id)
    return { doc: docStore.get(id) }
  })

  ctx.ipc.handle('doc-open', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: t('errors.missingDocId') }
    const rec = docStore.get(id)
    if (!rec) return { error: t('errors.docNotFound') }
    docStore.setCurrentDocId(id)
    syncCurrentDoc(id)
    return { doc: rec }
  })

  ctx.ipc.handle('doc-get', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: t('errors.missingDocId') }
    const rec = docStore.get(id)
    if (!rec) return { error: t('errors.docNotFound') }
    return { doc: rec }
  })

  ctx.ipc.handle('doc-delete', (payload: any) => {
    const id = payload?.id
    if (!id) return { error: t('errors.missingDocId') }
    docStore.delete(id)
    if (docStore.getCurrentDocId() === id) {
      docStore.setCurrentDocId(null)
      syncCurrentDoc(null)
    }
    broadcast('doc-list-changed', { ts: Date.now() })
    return { ok: true }
  })

  ctx.ipc.handle('doc-rename', (payload: any) => {
    const id = payload?.id
    const title = payload?.title
    if (!id || typeof title !== 'string' || !title.trim()) return { error: t('errors.missingDocName') }
    docStore.setTitle(id, title.trim())
    broadcast('doc-list-changed', { ts: Date.now() })
    const rec = docStore.get(id)
    if (rec) broadcast('doc-changed', { doc: { id: rec.id, title: rec.title, html: rec.html }, source: 'self' })
    return { ok: true }
  })

  // 渲染端自动保存：写正文（AI 镜像同步 + 自动创建快照由 separate 逻辑负责）
  ctx.ipc.handle('doc-save', (payload: any) => {
    const id = payload?.id
    const html = payload?.html
    const title = payload?.title
    if (!id || typeof html !== 'string') return { error: t('errors.missingDocId') }
    const rec = docStore.get(id)
    if (!rec) return { error: t('errors.docNotFound') }
    docStore.save(id, typeof title === 'string' && title.trim() ? title.trim() : rec.title, html)
    docStore.setCurrentDocId(id)
    syncCurrentDoc(id)
    return { ok: true, updatedAt: docStore.get(id)?.updatedAt ?? Date.now() }
  })

  // AI 改动后的回写（渲染端应用远程 HTML 后 sync 回镜像，防会话态漂移）
  ctx.ipc.handle('doc-sync', (payload: any) => {
    const id = payload?.id
    const html = payload?.html
    if (id && typeof html === 'string') syncCurrentDocHtml(id, html)
    return { ok: true }
  })

  // ====== 导入 ======
  ctx.ipc.handle('doc-import-file', async (payload: any) => {
    try {
      const result = payload?.path
        ? await importDocx(ctx, String(payload.path), filesDir(ctx))
        : await pickAndImportDocx(ctx, filesDir(ctx))
      if (!result) return {}
      const id = createDocId()
      docStore.save(id, result.title || t('defaults.importName'), result.html, result.sourcePath)
      docStore.setCurrentDocId(id)
      syncCurrentDoc(id)
      broadcast('doc-list-changed', { ts: Date.now() })
      return { doc: docStore.get(id) }
    } catch (e) {
      return { error: t('errors.docxParseFailed', { message: e instanceof Error ? e.message : String(e) }) }
    }
  })

  // ====== 导出 ======
  ctx.ipc.handle('export-docx', async (payload: any) => {
    const id = payload?.id ?? docStore.getCurrentDocId()
    const html = payload?.html ?? docStore.get(id)?.html
    const title = payload?.title ?? docStore.get(id)?.title ?? 'document'
    if (typeof html !== 'string') return { error: t('errors.noDoc') }
    try {
      const r = await saveDocxFile(title, html)
      if (!r.ok && r.error) return { error: t('errors.exportFailed', { message: r.error }) }
      return r
    } catch (e) {
      return { error: t('errors.exportFailed', { message: e instanceof Error ? e.message : String(e) }) }
    }
  })

  ctx.ipc.handle('export-pdf', async (payload: any) => {
    const id = payload?.id ?? docStore.getCurrentDocId()
    const html = payload?.html ?? docStore.get(id)?.html
    const title = payload?.title ?? docStore.get(id)?.title ?? 'document'
    if (typeof html !== 'string') return { error: t('errors.noDoc') }
    try {
      const r = await savePdfFile(title, html)
      if (!r.ok && r.error) return { error: t('errors.exportFailed', { message: r.error }) }
      return r
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
    const snap = docStore.createSnapshot(id, payload?.label || t('page.history'), html2str(rec.html))
    return { snapshot: { id: snap.id, docId: snap.docId, label: snap.label, html: '', createdAt: snap.createdAt } }
  })

  ctx.ipc.handle('snapshot-restore', (payload: any) => {
    const snap = payload?.snapshotId ? docStore.getSnapshot(String(payload.snapshotId)) : null
    if (!snap) return { error: 'snapshot not found' }
    docStore.saveHtml(snap.docId, snap.html)
    docStore.setCurrentDocId(snap.docId)
    syncCurrentDoc(snap.docId)
    broadcast('doc-changed', {
      doc: { id: snap.docId, title: docStore.get(snap.docId)?.title ?? '', html: snap.html },
      source: 'restore',
    })
    return { ok: true }
  })

  ctx.ipc.handle('snapshot-delete', (payload: any) => {
    if (!payload?.id) return { error: t('errors.missingDocId') }
    docStore.deleteSnapshot(String(payload.id))
    return { ok: true }
  })

  // 划词内联 AI：单轮 LLM 改写选中文本
  ctx.ipc.handle('inline-edit', async (payload: any, signal?: AbortSignal) => {
    const execute = ctx.services.execute
    if (!execute) return { error: t('errors.executeUnavailable') }
    const { instruction, text } = payload ?? {}
    if (typeof text !== 'string' || typeof instruction !== 'string') return { error: t('errors.missingTokens') }
    let providerId = docStore.getSettings().defaultProviderId
    if (!providerId) {
      const data = ctx.services.data
      if (data) {
        const providers = (await data.query('llmProviders') as any[]) ?? []
        providerId = (providers.find((p) => p.is_default) ?? providers[0])?.id
      }
    }
    if (!providerId) return { error: t('errors.noProvider') }
    try {
      const result = await execute.execute(
        {
          kind: 'llm-chat',
          providerId,
          system: '你是文字编辑助手。直接输出处理后的文字本体，不要任何解释、前缀、引用标记或 Markdown 代码块。',
          messages: [{ role: 'user', content: `${instruction}\n\n原文：\n${text}` }],
          useSkills: false,
          enableThinking: false
        },
        undefined,
        signal
      ) as { content?: string; text?: string }
      const output = typeof result === 'string' ? result : (result?.content ?? result?.text ?? '')
      return { text: String(output).trim() }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ====== 供应商（复用宿主数据能力） ======
  ctx.ipc.handle('providers-list', async () => {
    const data = ctx.services.data
    if (!data) return []
    return data.query('llmProviders') as any[]
  })

  // ====== 设置 ======
  ctx.ipc.handle('settings-get', () => ({ settings: docStore.getSettings() }))
  ctx.ipc.handle('settings-set', (payload: any) => {
    docStore.setSettings(payload?.settings ?? {})
    return { ok: true }
  })

  // ====== AI 对话（复用宿主通用对话引擎） ======
  ctx.ipc.handle('chat-send', async (payload: any, signal?: AbortSignal) => {
    const execute = ctx.services.execute
    if (!execute) return { error: t('errors.executeUnavailable') }
    const { providerId, modelId, messages, conversationId } = payload ?? {}
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
        const providers = (await data.query('llmProviders') as any[]) ?? []
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
    const doc = docStore.getCurrentDoc()
    const system = buildChatSystem(DOC_SYSTEM_PROMPT, workspacePath)

    // 请求前同步最新文档到工具会话（渲染端刚编辑未保存的场景，渲染端发消息前先 doc-save）
    let lastConvId: string | null = isNewConv ? null : convId

    try {
      const result = await execute.execute(
        {
          kind: 'agent-chat',
          providerId: resolvedProviderId,
          modelId: resolvedModelId,
          messages,
          conversationId: convId,
          system,
          tools: createDocAgentTools(),
          useSkills: false,
          enableThinking: true,
          minimalMode: false,
          highPermission: false,
          enableBuiltinTools: true,
          workspacePath: workspacePath ?? undefined
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
          }
        },
        mergedSignal
      )
      lastConvId = (result as { conversationId: string }).conversationId || convId

      if (lastConvId) {
        const existing = docStore.getMessages(lastConvId)
        const userMsg = { id: lastMsg?.id, role: 'user' as const, content: lastMsg?.content ?? '' }
        const assistantMsg: Record<string, unknown> = { id: payload?.assistantId, role: 'assistant', content: acc }
        if (thought) assistantMsg.reasoning_content = thought
        if (errText) assistantMsg.content = (assistantMsg.content as string) + (acc ? `\n\n[错误] ${errText}` : `[错误] ${errText}`)
        const hasUser = existing.some((m) => (m as any).role === 'user' && (m as any).content === userMsg.content)
        try {
          docStore.saveMessages(lastConvId, [...(hasUser ? existing : [...existing, userMsg]), assistantMsg])
          const title = lastMsg?.content?.slice(0, 40) || t('chat.defaultTitle')
          docStore.saveChat({ conversationId: lastConvId, title, updatedAt: Date.now(), workspacePath })
          broadcast('chats-changed', { ts: Date.now() })
        } catch (e) {
          ctx.services.logger.warn('持久化对话消息失败:', e instanceof Error ? e.message : String(e))
        }
      }
      return { conversationId: lastConvId, workspacePath } as { conversationId: string; workspacePath: string | null }
    } finally {
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

  ctx.ipc.handle('chat-history', async (payload: any) => {
    if (!payload?.conversationId) return []
    return docStore.getMessages(payload.conversationId)
  })

  ctx.ipc.handle('chats-list', () => docStore.listChats())

  ctx.ipc.handle('chat-delete', (payload: any) => {
    const convId = payload?.conversationId
    if (!convId) return { error: t('errors.missingDocId') }
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

  // 打开对话的任务工作区目录
  ctx.ipc.handle('chat-open-dir', (payload: any) => {
    const ws = payload?.conversationId ? docStore.getChatWorkspacePath(payload.conversationId) : null
    if (!ws || !fs.existsSync(ws)) return { ok: false, error: t('errors.noDoc') }
    try {
      const { shell } = require('electron')
      if (shell?.openPath) shell.openPath(ws)
    } catch { /* ignore */ }
    return { ok: true }
  })

  // AI 对话的任务工作区路径（渲染端展示"打开任务文件夹"）
  ctx.ipc.handle('data-dir', () => ({ dataDir: ctx.paths.data }))
  ctx.ipc.handle('tasks-dir', () => ({ tasksDir: taskRootDir(ctx) }))
}

function buildChatSystem(base: string, workspacePath: string | null): string {
  const doc = docStore.getCurrentDoc()
  const docInfo = doc
    ? `\n\n当前打开的文档：《${doc.title}》（id=${doc.id}）。用户提出文档修改需求时，用上面的 doc_* 工具直接修改；先 doc_get_outline 了解结构再动手。完成后简要说明做了什么。`
    : '\n\n当前没有打开的文档，doc_* 工具不可用，请提示用户先在编辑器中打开/新建文档。'
  const ws = workspacePath
    ? `\n\n当前任务工作区目录：${workspacePath}\n该目录为本次对话的专属任务文件夹，可用 file_read / file_write / file_edit / shell_exec 读取、写入其中的文件。`
    : ''
  return base + docInfo + ws
}

function html2str(s: string): string { return s }

export const migrations = []

export function activate(ctx: PluginContext): void {
  ctxRef = ctx
  docStore.init(ctx)
  initDocSession(ctx)

  // 激活时默认打开最近文档（若有），便于 AI 工具尽早可用
  const docs = docStore.list()
  if (docs.length > 0) {
    docStore.setCurrentDocId(docs[0].id)
    syncCurrentDoc(docs[0].id)
  }

  registerIpc(ctx)
  ctx.contributions.registerAgentTools(createDocAgentTools())

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
  unsubscribeEvents.forEach((unsub) => { try { unsub() } catch { /* ignore */ } })
  unsubscribeEvents = []
  ctxRef = null
}

const mod: PluginMainModule = { migrations, activate, deactivate }
export default mod
