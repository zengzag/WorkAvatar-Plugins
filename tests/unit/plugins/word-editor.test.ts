import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockContext } from '../../helpers/mock-plugin-context'
import type { PluginMainModule, PluginToolDefinition } from '@workavatar/plugin-sdk'
import { DOC_OPS } from '../../../word-editor/src/shared/doc-ops'

/**
 * word-editor 插件单测：
 * - 激活注册行为（IPC 通道与 manifest 白名单严格一致）
 * - 文档 CRUD / 快照 / 导入导出 IPC
 * - AI 对话 IPC（无供应商兜底、消息持久化、取消）
 *
 * 说明：文档内容为 wordcanvas Document 模型 JSON，主进程仅作不透明字符串存储与校验。
 */

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../word-editor')

async function setup(): Promise<{ mod: PluginMainModule; mock: ReturnType<typeof createMockContext> }> {
  vi.resetModules()
  const mod = await import('../../../word-editor/src/main/index') as PluginMainModule
  const mock = createMockContext('test-word-editor')
  for (const m of mod.migrations ?? []) {
    m.run({ storage: mock.ctx.storage, logger: mock.ctx.services.logger })
  }
  mod.activate(mock.ctx)
  return { mod, mock }
}

function handler(mock: ReturnType<typeof createMockContext>, channel: string): (payload?: unknown, signal?: AbortSignal) => Promise<unknown> | unknown {
  return mock.ipc.handlers.get(channel)! as (payload?: unknown, signal?: AbortSignal) => Promise<unknown> | unknown
}

/** 覆盖宿主数据查询桩（llmProviders 等） */
function stubQuery(mock: ReturnType<typeof createMockContext>, rows: unknown[]): void {
  const data = mock.services.data as unknown as { query: (entity: string) => Promise<unknown[]> }
  data.query = vi.fn(async () => rows)
}

/** 取宿主 execute 桩以便断言调用 */
function executeMock(mock: ReturnType<typeof createMockContext>): ReturnType<typeof vi.fn> {
  const execute = mock.services.execute as unknown as { execute: ReturnType<typeof vi.fn> }
  return execute.execute
}

describe('激活注册行为', () => {
  it('已注册 IPC 通道与 manifest.ipc 白名单严格一致（无遗漏、无死通道）', async () => {
    const { mock } = await setup()
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf-8')) as { ipc: string[] }
    const declared = [...manifest.ipc].sort()
    const registered = [...mock.ipc.handlers.keys()].sort()
    expect(registered).toEqual(declared)
  })
})

describe('文档 CRUD', () => {
  it('doc-create 生成合法 Document JSON（含 section 与 blocks）', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'doc-create')({ title: '测试文档' }) as { doc: { id: string; title: string; data: string } }
    expect(res.doc.title).toBe('测试文档')
    const parsed = JSON.parse(res.doc.data)
    expect(parsed.section).toBeTruthy()
    expect(Array.isArray(parsed.blocks)).toBe(true)
  })

  it('doc-create 未指定标题时用默认名', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'doc-create')({}) as { doc: { title: string } }
    expect(res.doc.title).toBe('defaults.untitledDoc')
  })

  it('doc-list 返回文档清单（不含 data）', async () => {
    const { mock } = await setup()
    await handler(mock, 'doc-create')({ title: 'A' })
    const list = await handler(mock, 'doc-list')() as Array<Record<string, unknown>>
    expect(list.length).toBe(1)
    expect(list[0].title).toBe('A')
    expect('data' in list[0]).toBe(false)
  })

  it('doc-open / doc-rename / doc-delete 全链路', async () => {
    const { mock } = await setup()
    const { doc } = await handler(mock, 'doc-create')({ title: 'A' }) as any
    const opened = await handler(mock, 'doc-open')({ id: doc.id }) as any
    expect(opened.doc.title).toBe('A')

    await handler(mock, 'doc-rename')({ id: doc.id, title: ' B ' })
    expect((await handler(mock, 'doc-open')({ id: doc.id }) as any).doc.title).toBe('B')

    await handler(mock, 'doc-delete')({ id: doc.id })
    expect((await handler(mock, 'doc-open')({ id: doc.id }) as any).error).toBeTruthy()
  })

  it('doc-save 保存文档数据并可读回', async () => {
    const { mock } = await setup()
    const { doc } = await handler(mock, 'doc-create')({}) as any
    const data = JSON.stringify({ section: {}, blocks: [{ kind: 'paragraph', id: 'p1', revision: 3, runs: [], style: {} }] })
    const saved = await handler(mock, 'doc-save')({ id: doc.id, data }) as any
    expect(saved.ok).toBe(true)
    const got = await handler(mock, 'doc-open')({ id: doc.id }) as any
    expect(got.doc.data).toBe(data)
  })

  it('doc-save 缺参数时报错', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'doc-save')({ id: 'x' }) as any
    expect(res.error).toBeTruthy()
  })

  it('doc-save 切换当前文档；删除当前文档后基于当前文档的通道报缺 id', async () => {
    const { mock } = await setup()
    const a = (await handler(mock, 'doc-create')({ title: 'A' }) as any).doc
    const b = (await handler(mock, 'doc-create')({ title: 'B' }) as any).doc
    expect(b.id).not.toBe(a.id)
    // doc-save 会把当前文档切到 a；不带 id 的快照通道应落到 a
    await handler(mock, 'doc-save')({ id: a.id, data: a.data })
    await handler(mock, 'snapshot-create')({ label: 'x' })
    expect((await handler(mock, 'snapshot-list')({}) as any).snapshots.length).toBe(1)

    await handler(mock, 'doc-delete')({ id: a.id })
    expect((await handler(mock, 'snapshot-list')({}) as any).error).toBeTruthy()
  })
})

describe('快照', () => {
  it('snapshot-create / snapshot-list / snapshot-restore / snapshot-delete 链路', async () => {
    const { mock } = await setup()
    const { doc } = await handler(mock, 'doc-create')({ title: 'S' }) as any
    const v1 = JSON.stringify({ section: {}, blocks: [{ kind: 'paragraph', id: 'p1', revision: 1, runs: [], style: {} }] })
    await handler(mock, 'doc-save')({ id: doc.id, data: v1 })
    await handler(mock, 'snapshot-create')({ id: doc.id, label: 'v1' })

    // 改内容后再存快照，随后恢复到 v1
    const v2 = JSON.stringify({ section: {}, blocks: [] })
    await handler(mock, 'doc-save')({ id: doc.id, data: v2 })
    const list = await handler(mock, 'snapshot-list')({ id: doc.id }) as any
    expect(list.snapshots.length).toBe(1)
    expect(list.snapshots[0].label).toBe('v1')

    await handler(mock, 'snapshot-restore')({ snapshotId: list.snapshots[0].id })
    const restored = await handler(mock, 'doc-open')({ id: doc.id }) as any
    expect(restored.doc.data).toBe(v1)
    expect(mock.ipc.broadcasts.some((b) => b.event === 'doc-changed')).toBe(true)

    await handler(mock, 'snapshot-delete')({ id: list.snapshots[0].id })
    const after = await handler(mock, 'snapshot-list')({ id: doc.id }) as any
    expect(after.snapshots.length).toBe(0)
  })

  it('快照上限 50 条（超出淘汰最旧）', async () => {
    const { mock } = await setup()
    const { doc } = await handler(mock, 'doc-create')({ title: 'S' }) as any
    for (let i = 0; i < 55; i++) {
      await handler(mock, 'snapshot-create')({ id: doc.id, label: `v${i}` })
    }
    const list = await handler(mock, 'snapshot-list')({ id: doc.id }) as any
    expect(list.snapshots.length).toBe(50)
    // 最新的仍在
    expect(list.snapshots[0].label).toBe('v54')
  })

  it('snapshot-restore 指定不存在的快照时报错', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'snapshot-restore')({ snapshotId: 'snap_missing' }) as any
    expect(res.error).toBeTruthy()
  })

  it('snapshot-create 未打开文档时报缺 id', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'snapshot-create')({}) as any
    expect(res.error).toBeTruthy()
  })
})

describe('导入', () => {
  it('doc-import-file 指定路径时读取字节并留档原文件', async () => {
    const { mock } = await setup()
    const tmpFile = path.join(os.tmpdir(), `wa-test-${Date.now()}.docx`)
    const bytes = Buffer.from('PK\u0003\u0004fake-docx-bytes')
    fs.writeFileSync(tmpFile, bytes)
    try {
      const res = await handler(mock, 'doc-import-file')({ path: tmpFile }) as any
      expect(res.error).toBeUndefined()
      expect(res.name).toBe(path.basename(tmpFile).replace(/\.docx$/i, ''))
      expect(Array.from(res.bytes as Uint8Array)).toEqual(Array.from(bytes))
      // 原文件已留档到插件数据目录 files/ 下
      expect(typeof res.sourcePath).toBe('string')
      expect(fs.existsSync(res.sourcePath)).toBe(true)
      expect(fs.readFileSync(res.sourcePath)).toEqual(bytes)
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  })

  it('doc-import-file 读取失败时返回错误文案', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'doc-import-file')({ path: path.join(os.tmpdir(), 'wa-not-exist.docx') }) as any
    expect(res.error).toBeTruthy()
  })
})

describe('导出落盘', () => {
  it('export-save 缺字节时报错', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'export-save')({ format: 'docx', title: 'x' }) as any
    expect(res.error).toBeTruthy()
  })
})

describe('设置 / 供应商', () => {
  it('settings-get / settings-set 往返', async () => {
    const { mock } = await setup()
    await handler(mock, 'settings-set')({ settings: { defaultProviderId: 'p1' } })
    const res = await handler(mock, 'settings-get')() as any
    expect(res.settings.defaultProviderId).toBe('p1')
  })

  it('providers-list 读取宿主 llmProviders 数据', async () => {
    const { mock } = await setup()
    stubQuery(mock, [{ id: 'p1', name: 'P1', model: 'm1', is_default: true }])
    const list = await handler(mock, 'providers-list')() as any[]
    expect(list[0].id).toBe('p1')
  })
})

describe('AI 对话', () => {
  async function setupWithProvider(): Promise<ReturnType<typeof createMockContext>> {
    const { mock } = await setup()
    stubQuery(mock, [{ id: 'p1', name: 'P1', model: 'm1', is_default: true }])
    await handler(mock, 'settings-set')({ settings: { defaultProviderId: 'p1', defaultModelId: 'm1' } })
    return mock
  }

  it('chat-send 走 execute 并持久化对话与消息', async () => {
    const mock = await setupWithProvider()
    const res = await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: '帮我改一下标题' }],
      assistantId: 'a1',
    }) as any
    expect(res.error).toBeUndefined()
    expect(res.conversationId).toBeTruthy()
    expect(executeMock(mock)).toHaveBeenCalledTimes(1)
    expect(mock.ipc.broadcasts.some((b) => b.event === 'chats-changed')).toBe(true)

    const history = await handler(mock, 'chat-history')({ conversationId: res.conversationId }) as any[]
    expect(history.length).toBe(2)
    expect(history[0]).toMatchObject({ id: 'u1', role: 'user', content: '帮我改一下标题' })
    expect(history[1]).toMatchObject({ id: 'a1', role: 'assistant' })

    const chats = await handler(mock, 'chats-list')() as any[]
    expect(chats.length).toBe(1)
    expect(chats[0].conversationId).toBe(res.conversationId)
  })

  it('chat-send 无可用供应商时报错', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'chat-send')({ messages: [{ role: 'user', content: 'hi' }] }) as any
    expect(res.error).toBeTruthy()
  })

  it('chat-send 缺消息时报错', async () => {
    const mock = await setupWithProvider()
    const res = await handler(mock, 'chat-send')({ messages: [] }) as any
    expect(res.error).toBeTruthy()
  })

  it('chat-send 无 execute 能力时报错', async () => {
    const { mock } = await setup()
    ;(mock.services as { execute?: unknown }).execute = undefined
    const res = await handler(mock, 'chat-send')({ messages: [{ role: 'user', content: 'hi' }] }) as any
    expect(res.error).toBeTruthy()
  })

  it('chat-delete 删除对话与消息（缺参数报错）', async () => {
    const mock = await setupWithProvider()
    const res = await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      assistantId: 'a1',
    }) as any
    const del = await handler(mock, 'chat-delete')({ conversationId: res.conversationId }) as any
    expect(del.ok).toBe(true)
    expect(await handler(mock, 'chat-history')({ conversationId: res.conversationId })).toEqual([])
    expect(await handler(mock, 'chats-list')()).toEqual([])

    const bad = await handler(mock, 'chat-delete')({}) as any
    expect(bad.error).toBeTruthy()
  })

  it('chat-cancel 未指定会话时取消全部进行中请求', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'chat-cancel')({}) as any
    expect(res.ok).toBe(true)
  })
})

describe('deactivate', () => {
  it('释放资源不抛错', async () => {
    const { mod } = await setup()
    expect(() => mod.deactivate?.()).not.toThrow()
  })
})

// ====== AI 文档工具（工具 → 文档桥 → 渲染端执行结果回传） ======

const EDITED_DATA = JSON.stringify({
  section: {},
  blocks: [{ kind: 'paragraph', id: 'p1', revision: 2, runs: [{ text: '新内容', style: {} }], style: {} }],
})

function agentTool(mock: ReturnType<typeof createMockContext>, id: string): PluginToolDefinition {
  const tool = (mock.contributions.agentTools as PluginToolDefinition[]).find((t) => t.id === id)
  if (!tool) throw new Error(`工具未注册: ${id}`)
  return tool
}

/** 最近一次下发给渲染端的文档操作请求 */
function lastDocOp(mock: ReturnType<typeof createMockContext>): { opId: string; op: string; args: Record<string, unknown> } {
  const hit = [...mock.ipc.broadcasts].reverse().find((b) => b.event === 'doc-op')
  if (!hit) throw new Error('未收到 doc-op 广播')
  return hit.payload as { opId: string; op: string; args: Record<string, unknown> }
}

/** 模拟渲染端执行并回传结果 */
async function replyDocOp(
  mock: ReturnType<typeof createMockContext>,
  outcome: { data?: string; output?: string; error?: string; docId?: string }
): Promise<void> {
  const payload = lastDocOp(mock)
  await handler(mock, 'doc-op-result')({ opId: payload.opId, ...outcome })
}

async function setupWithDoc(): Promise<{ mock: ReturnType<typeof createMockContext>; docId: string }> {
  const { mock } = await setup()
  stubQuery(mock, [{ id: 'p1', name: 'P1', model: 'm1', is_default: true }])
  await handler(mock, 'settings-set')({ settings: { defaultProviderId: 'p1', defaultModelId: 'm1' } })
  await handler(mock, 'doc-op-attach')({ attached: true })
  const { doc } = (await handler(mock, 'doc-create')({ title: 'T' })) as { doc: { id: string; data: string } }
  return { mock, docId: doc.id }
}

describe('AI 文档工具', () => {
  it('激活时注册全部文档工具（工具 id 与操作名一致）', async () => {
    const { mock } = await setup()
    const ids = (mock.contributions.agentTools as PluginToolDefinition[]).map((t) => t.id).sort()
    expect(ids).toEqual(Object.values(DOC_OPS).sort())
    for (const tool of mock.contributions.agentTools as PluginToolDefinition[]) {
      expect(tool.name).toBe(tool.id)
      expect(tool.description.length).toBeGreaterThan(20)
      // 作用于实时文档，禁用 retry 防止超时重试造成重复改动
      expect(tool.noRetry).toBe(true)
      expect(tool.timeoutMs).toBeGreaterThan(0)
    }
  })

  it('编辑器未挂载时工具立即返回可读错误（不等待超时）', async () => {
    const { mock } = await setupWithDoc()
    await handler(mock, 'doc-op-attach')({ attached: false })
    const res = (await agentTool(mock, DOC_OPS.outline).handler({}, {})) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toContain('未打开')
    expect(mock.ipc.broadcasts.some((b) => b.event === 'doc-op')).toBe(false)
  })

  it('无打开文档时工具返回错误', async () => {
    const { mock } = await setup()
    await handler(mock, 'doc-op-attach')({ attached: true })
    const res = (await agentTool(mock, DOC_OPS.outline).handler({}, {})) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toContain('没有打开的文档')
  })

  it('操作成功时持久化新内容并广播 doc-changed', async () => {
    const { mock, docId } = await setupWithDoc()
    const pending = agentTool(mock, DOC_OPS.setParagraphText).handler({ blockId: 'p1', text: '新内容' }, {})
    const sent = lastDocOp(mock)
    expect(sent.op).toBe(DOC_OPS.setParagraphText)
    expect(sent.args).toEqual({ blockId: 'p1', text: '新内容' })
    await replyDocOp(mock, { data: EDITED_DATA, output: '已更新', docId })

    const res = (await pending) as { success: boolean; output: string }
    expect(res).toMatchObject({ success: true, output: '已更新' })
    const opened = (await handler(mock, 'doc-open')({ id: docId })) as { doc: { data: string } }
    expect(opened.doc.data).toBe(EDITED_DATA)
    const changed = mock.ipc.broadcasts.filter((b) => b.event === 'doc-changed')
    expect(changed.length).toBe(1)
    expect((changed[0].payload as { doc: { id: string } }).doc.id).toBe(docId)
  })

  it('读操作不改动文档、不广播', async () => {
    const { mock } = await setupWithDoc()
    const pending = agentTool(mock, DOC_OPS.read).handler({}, {})
    await replyDocOp(mock, { output: '0. [p1] 文本' })
    const res = (await pending) as { success: boolean; output: string }
    expect(res.output).toContain('[p1]')
    expect(mock.ipc.broadcasts.some((b) => b.event === 'doc-changed')).toBe(false)
  })

  it('渲染端返回错误时透传给模型', async () => {
    const { mock, docId } = await setupWithDoc()
    const pending = agentTool(mock, DOC_OPS.deleteBlocks).handler({ blockIds: ['ghost'] }, {})
    await replyDocOp(mock, { error: '指定的块都不在文档顶层', docId })
    const res = (await pending) as { success: boolean; error: string }
    expect(res).toMatchObject({ success: false, error: '指定的块都不在文档顶层' })
  })

  it('渲染端操作的文档与当前文档不一致时放弃落库', async () => {
    const { mock } = await setupWithDoc()
    const pending = agentTool(mock, DOC_OPS.setParagraphText).handler({ blockId: 'p1', text: 'x' }, {})
    await replyDocOp(mock, { data: EDITED_DATA, output: '已更新', docId: 'other-doc' })
    const res = (await pending) as { success: boolean; error: string }
    expect(res.success).toBe(false)
    expect(res.error).toContain('文档已切换')
    expect(mock.ipc.broadcasts.some((b) => b.event === 'doc-changed')).toBe(false)
  })

  it('对话期间：工具改动落地，并在本轮首次改动前自动快照（同轮只落一条）', async () => {
    const { mock, docId } = await setupWithDoc()
    const execute = executeMock(mock)
    execute.mockImplementation(async (req: { tools?: PluginToolDefinition[] }) => {
      const target = (req.tools ?? []).find((t) => t.id === DOC_OPS.setParagraphText)!
      // 连续两次改动：只有首次需要快照
      for (const text of ['新内容', '再改一次']) {
        const pending = target.handler({ blockId: 'p1', text }, {})
        await replyDocOp(mock, { data: EDITED_DATA, output: `已更新：${text}`, docId })
        const res = (await pending) as { success: boolean }
        expect(res.success).toBe(true)
      }
      // 读操作不应触发额外快照
      const read = (req.tools ?? []).find((t) => t.id === DOC_OPS.read)!
      const readPending = read.handler({}, {})
      await replyDocOp(mock, { output: '内容' })
      await readPending
      return { conversationId: 'c1' }
    })

    await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: '改写第一段' }],
      assistantId: 'a1',
    })

    const list = (await handler(mock, 'snapshot-list')({ id: docId })) as { snapshots: Array<{ label: string }> }
    expect(list.snapshots.length).toBe(1)
    expect(list.snapshots[0].label).toBe('snapshot.aiEdit')
  })

  it('chat-send 把文档工具交给宿主执行引擎', async () => {
    const { mock } = await setupWithDoc()
    await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: '读一下文档' }],
      assistantId: 'a1',
    })
    const req = executeMock(mock).mock.calls[0][0] as { tools: PluginToolDefinition[]; system: string }
    expect(req.tools.length).toBe(Object.values(DOC_OPS).length)
    expect(req.system).toContain('doc_outline')
  })

  it('chat-send 透传选中文字作用域到系统提示词（只改选中范围）', async () => {
    const { mock } = await setupWithDoc()
    await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: '润色这段' }],
      assistantId: 'a1',
      scopeHint: {
        kind: 'selection',
        text: '这是一段被选中的话',
        anchor: { blockId: 'p1', offset: 2 },
        focus: { blockId: 'p1', offset: 9 },
        blockPreview: '这是一段被选中的话',
      },
    })
    const req = executeMock(mock).mock.calls[0][0] as { system: string }
    expect(req.system).toContain('用户选中的文字')
    expect(req.system).toContain('p1')
    expect(req.system).toContain('这是一段被选中的话')
    expect(req.system).toContain('只改动选中范围')
  })

  it('chat-send 透传光标作用域到系统提示词（续写落点）', async () => {
    const { mock } = await setupWithDoc()
    await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: '继续写' }],
      assistantId: 'a1',
      scopeHint: { kind: 'caret', anchor: { blockId: 'p1', offset: 4 } },
    })
    const req = executeMock(mock).mock.calls[0][0] as { system: string }
    expect(req.system).toContain('光标位置')
    expect(req.system).toContain('p1')
    expect(req.system).not.toContain('用户选中的文字')
  })

  it('chat-send 忽略结构不合法的 scopeHint', async () => {
    const { mock } = await setupWithDoc()
    await handler(mock, 'chat-send')({
      providerId: 'p1',
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      assistantId: 'a1',
      scopeHint: { kind: 'selection', anchor: { blockId: 123 } },
    })
    const req = executeMock(mock).mock.calls[0][0] as { system: string }
    expect(req.system).not.toContain('本轮作用范围')
  })
})
