import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'
import type { PluginMainModule } from '@workavatar/plugin-sdk'

/**
 * hello-world 能力参考插件单测：
 * - 验证 migrate → activate 的注册行为（IPC/事件/贡献点/bus respond）
 * - 验证各 IPC handler 行为（KV/sqlite/系统能力/数据与执行/协作）
 */

async function setup(): Promise<{ mod: PluginMainModule; mock: ReturnType<typeof createMockContext> }> {
  vi.resetModules()
  const mod = await import('../../../examples/hello-world/src/main/index') as PluginMainModule
  const mock = createMockContext('example-hello-world')
  // 宿主不会在单测里自动跑 migrations，须手动执行（与生产顺序一致：先迁移后 activate）
  for (const m of mod.migrations ?? []) {
    m.run({ storage: mock.ctx.storage, legacy: null, logger: mock.ctx.services.logger })
  }
  mod.activate(mock.ctx)
  return { mod, mock }
}

/** 取 IPC handler，payload 可选以便 0 参调用 */
function handler(mock: ReturnType<typeof createMockContext>, channel: string): (payload?: unknown) => Promise<unknown> | unknown {
  return mock.ipc.handlers.get(channel)! as (payload?: unknown) => Promise<unknown> | unknown
}

const IPC_CHANNELS = [
  'greet', 'count',
  'kv-get', 'kv-set', 'kv-keys', 'kv-delete',
  'memo-add', 'memo-list', 'memo-count',
  'scheduler-start', 'scheduler-stop',
  'notify', 'window-open',
  'native-borrow', 'host-native-modules',
  'data-conversations', 'execute-llm',
  'shared-set', 'shared-get',
  'bus-echo', 'publish-ping',
]

describe('migrations', () => {
  it('建表 hello_messages 供后续使用', async () => {
    const { mock } = await setup()
    const tables = mock.ctx.storage.openSqlite('index')
      .prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.some((t) => t.name === 'hello_messages')).toBe(true)
  })
})

describe('激活注册行为', () => {
  it('注册 hello 命令', async () => {
    const { mock } = await setup()
    expect(mock.contributions.commands.length).toBe(1)
    expect((mock.contributions.commands[0] as { id: string }).id).toBe('hello')
  })

  it('注册 2 个 agent 工具（一按需一常驻）', async () => {
    const { mock } = await setup()
    expect(mock.contributions.agentTools.length).toBe(2)
    const ids = mock.contributions.agentTools.map((t) => t.id)
    expect(ids).toContain('hello_memo_add')
    expect(ids).toContain('hello_memo_query')
  })

  it('注册消息快捷操作', async () => {
    const { mock } = await setup()
    expect(mock.contributions.messageActions.length).toBe(1)
    expect((mock.contributions.messageActions[0] as { id: string }).id).toBe('extract-todo')
  })

  it('注册 .wahello 文件关联', async () => {
    const { mock } = await setup()
    expect(mock.contributions.fileAssociations.has('.wahello')).toBe(true)
  })

  it('注册全局快捷键', async () => {
    const { mock } = await setup()
    expect(mock.contributions.shortcuts.length).toBe(1)
    expect((mock.contributions.shortcuts[0] as { accelerator: string }).accelerator).toBe('CommandOrControl+Shift+H')
  })

  it('订阅宿主事件 conversation:deleted', async () => {
    const { mock } = await setup()
    expect(mock.events.subscriptions.some((s) => s.event === 'conversation:deleted')).toBe(true)
  })

  it('注册 bus respond echo', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'bus-echo')({ message: '你好' })
    expect(res).toEqual({ result: { pong: '你好' } })
  })
})

describe('IPC 通道注册', () => {
  it('manifest.ipc 白名单内全部通道都有 handler', async () => {
    const { mock } = await setup()
    const registered = new Set(mock.ipc.handlers.keys())
    for (const channel of IPC_CHANNELS) {
      expect(registered.has(channel)).toBe(true)
    }
  })
})

describe('基础 IPC 行为', () => {
  it('greet 返回问候语', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'greet')({ name: 'Plugin' }) as { message: string }
    expect(res.message).toBe('Hello, Plugin!')
  })

  it('greet 无参数返回默认 World，空 name 保留空串', async () => {
    const { mock } = await setup()
    const d = await handler(mock, 'greet')() as { message: string }
    const empty = await handler(mock, 'greet')({ name: '' }) as { message: string }
    expect(d.message).toBe('Hello, World!')
    expect(empty.message).toBe('Hello, !')
  })

  it('count 递增并广播 count-changed 到渲染端', async () => {
    const { mock } = await setup()
    const r1 = await handler(mock, 'count')() as { count: number }
    const r2 = await handler(mock, 'count')() as { count: number }
    expect(r1.count).toBe(1)
    expect(r2.count).toBe(2)
    expect(mock.ipc.broadcasts.length).toBe(2)
    expect(mock.ipc.broadcasts[0]).toEqual({ event: 'count-changed', payload: { count: 1 } })
  })
})

describe('插件 KV（ctx.storage）', () => {
  it('get/set/keys/delete 往返', async () => {
    const { mock } = await setup()
    await handler(mock, 'kv-set')({ key: 'demo', value: 42 })
    expect(await handler(mock, 'kv-get')({ key: 'demo' })).toEqual({ key: 'demo', value: 42 })
    const keys = await handler(mock, 'kv-keys')() as { keys: string[] }
    expect(keys.keys).toContain('demo')
    await handler(mock, 'kv-delete')({ key: 'demo' })
    expect(await handler(mock, 'kv-get')({ key: 'demo' })).toEqual({ key: 'demo', value: null })
  })

  it('未设置的 key 返回 null', async () => {
    const { mock } = await setup()
    expect(await handler(mock, 'kv-get')({ key: 'missing' })).toEqual({ key: 'missing', value: null })
  })
})

describe('插件 SQLite 分库（memo）', () => {
  it('memo-add 空内容返回错误', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'memo-add')({ content: '  ' })
    expect(res).toEqual({ ok: false, error: 'helloWorld.err.memoEmpty' })
  })

  it('memo-add / memo-count / memo-list 链路', async () => {
    const { mock } = await setup()
    const add = await handler(mock, 'memo-add')({ content: '第一条留言' }) as { ok: boolean; id: string }
    expect(add.ok).toBe(true)
    expect(await handler(mock, 'memo-count')()).toEqual({ count: 1 })
    const list = await handler(mock, 'memo-list')() as { list: Array<{ content: string }> }
    expect(list.list[0].content).toBe('第一条留言')
  })
})

describe('系统能力', () => {
  it('scheduler-start 启动 every(30s)，scheduler-stop 取消', async () => {
    const { mock } = await setup()
    const start = await handler(mock, 'scheduler-start')() as { jobId: string }
    expect(start.jobId).toBe('job-1')
    expect(mock.services.scheduler!.every).toHaveBeenCalledWith(30000, expect.any(Function))
    await handler(mock, 'scheduler-stop')()
    expect(mock.services.scheduler!.cancel).toHaveBeenCalledWith('job-1')
    await handler(mock, 'scheduler-start')()
    expect(mock.services.scheduler!.every).toHaveBeenCalledTimes(2)
  })

  it('notify 触发系统通知', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'notify')({ title: 'Hi', body: 'hello' })
    expect(res).toEqual({ sent: true })
    expect(mock.services.notification!.notify).toHaveBeenCalledWith({ title: 'Hi', body: 'hello' })
  })

  it('window-open 以 resources/demo.html 创建子窗口', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'window-open')()
    expect(res).toEqual({ id: 'win-1' })
    expect(mock.services.windows!.create).toHaveBeenCalledWith(
      expect.objectContaining({ contentPath: 'resources/demo.html' }),
    )
  })

  it('native-borrow 成功返回 sqlite 版本', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'native-borrow')() as { ok: boolean; sqliteVersion: string }
    expect(res.ok).toBe(true)
    expect(res.sqliteVersion).toBeTruthy()
  })

  it('native-borrow 借用被拒时返回错误文案', async () => {
    const { mock } = await setup()
    ;(mock.services.native!.borrow as ReturnType<typeof vi.fn>).mockReturnValueOnce(null)
    const res = await handler(mock, 'native-borrow')()
    expect(res).toEqual({ ok: false, error: 'helloWorld.err.nativeUnavailable' })
  })

  it('host-native-modules 返回宿主原生白名单', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'host-native-modules')() as Record<string, string>
    expect(res['better-sqlite3']).toBeTruthy()
  })
})

describe('宿主数据与执行', () => {
  it('data-conversations 只读查询最近对话', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'data-conversations')()
    expect(res).toEqual({ list: [] })
    expect(mock.services.data!.query).toHaveBeenCalledWith('conversations', { limit: 5 })
  })

  it('execute-llm 调用 llm-chat', async () => {
    const { mock } = await setup()
    ;(mock.services.execute!.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce('本地化回答')
    const res = await handler(mock, 'execute-llm')({ prompt: '你好' })
    expect(res).toEqual({ ok: true, output: '本地化回答' })
    expect(mock.services.execute!.execute).toHaveBeenCalledWith({ kind: 'llm-chat', prompt: '你好' })
  })

  it('execute-llm 无 provider 时优雅返回错误', async () => {
    const { mock } = await setup()
    ;(mock.services.execute!.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('No LLM provider available'))
    const res = await handler(mock, 'execute-llm')({ prompt: '你好' })
    expect(res).toEqual({ ok: false, error: 'No LLM provider available' })
  })
})

describe('协作（shared / bus）', () => {
  it('shared-set / shared-get 命名空间往返', async () => {
    const { mock } = await setup()
    await handler(mock, 'shared-set')({ key: 'theme', value: 'dark' })
    expect(await handler(mock, 'shared-get')({ key: 'theme' })).toEqual({ key: 'theme', value: 'dark' })
    expect(await handler(mock, 'shared-get')({ key: 'missing' })).toEqual({ key: 'missing', value: null })
  })

  it('bus-echo 经 collaboration.call 白名单自调用', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'bus-echo')({ message: 'ping' })
    expect(res).toEqual({ result: { pong: 'ping' } })
  })
})

describe('事件发布', () => {
  it('publish-ping 发布 hello-ping（宿主加 plugin:<id>: 前缀）', async () => {
    const { mock } = await setup()
    await handler(mock, 'publish-ping')()
    expect(mock.events.publishes[mock.events.publishes.length - 1].event).toBe('hello-ping')
  })
})

describe('deactivate', () => {
  it('释放资源不抛错', async () => {
    const { mod, mock } = await setup()
    // 先启动定时任务，让 deactivate 有可取消对象
    await handler(mock, 'scheduler-start')()
    expect(() => mod.deactivate?.()).not.toThrow()
  })
})