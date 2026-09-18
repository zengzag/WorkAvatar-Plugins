import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockContext } from '../../helpers/mock-plugin-context'
import type { PluginMainModule } from '@workavatar/plugin-sdk'

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
