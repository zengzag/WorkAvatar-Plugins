import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

// mock electron（vitest node 环境无 electron；outlook-auth 用 BrowserWindow）
vi.mock('electron', () => ({
  app: { getPath: () => '/mock' },
  BrowserWindow: class {
    static getAllWindows() { return [] }
    loadURL() {}
    loadFile() {}
    on() {}
    once() {}
    close() {}
    destroy() {}
    isDestroyed() { return true }
    isVisible() { return false }
    show() {}
    hide() {}
    setSize() {}
    webContents = { send: vi.fn() }
  },
  shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

/**
 * calendar 插件单测：验证 activate 注册行为 + IPC handler 数据操作。
 */

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../calendar/src/main/index')
  return mod
}

describe('calendar 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('calendar')
  })

  it('注册 23 个 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const channels = ['list-events', 'create-event', 'update-event', 'update-event-instance', 'delete-event', 'delete-event-instance',
      'list-todos', 'list-todo-instances', 'create-todo', 'update-todo', 'delete-todo', 'delete-todo-instance', 'complete-todo', 'todo-stats',
      'get-settings', 'set-settings',
      'export-data', 'import-data',
      'outlook-login', 'outlook-logout', 'outlook-status', 'outlook-set-config', 'outlook-sync-now']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
    expect(mock.ipc.handlers.size).toBe(23)
  })

  it('注册 10 个 agent 工具', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.agentTools.length).toBe(10)
    const ids = mock.contributions.agentTools.map(t => t.id)
    expect(ids).toContain('calendar_event_list')
    expect(ids).toContain('calendar_todo_create')
  })

  it('调用 scheduler.every 启动调度', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    await new Promise((r) => setTimeout(r, 0))
    expect(mock.services.scheduler!.every).toHaveBeenCalled()
  })

  it('deactivate 不抛错', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('calendar 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('calendar')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-event 创建事件', async () => {
    const handler = mock.ipc.handlers.get('create-event')!
    const res = await handler({
      title: '会议',
      start_at: Math.floor(Date.now() / 1000),
      end_at: Math.floor(Date.now() / 1000) + 3600,
    }) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.id).toBeTruthy()
  })

  it('list-events 返回已创建事件', async () => {
    const create = mock.ipc.handlers.get('create-event')!
    await create({
      title: '会议A',
      start_at: Math.floor(Date.now() / 1000),
      end_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const list = mock.ipc.handlers.get('list-events')!
    const res = await list({
      start_at: Math.floor(Date.now() / 1000) - 3600,
      end_at: Math.floor(Date.now() / 1000) + 7200,
    }) as Array<{ title: string }>
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('会议A')
  })

  it('create-todo 创建待办', async () => {
    const handler = mock.ipc.handlers.get('create-todo')!
    const res = await handler({
      title: '待办事项',
      due_at: Math.floor(Date.now() / 1000) + 3600,
    }) as { id?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.id).toBeTruthy()
  })

  it('list-todos 返回已创建待办', async () => {
    const create = mock.ipc.handlers.get('create-todo')!
    await create({ title: '待办A', due_at: Math.floor(Date.now() / 1000) + 3600 })
    const list = mock.ipc.handlers.get('list-todos')!
    const res = await list({}) as Array<{ title: string }>
    expect(res.length).toBe(1)
    expect(res[0].title).toBe('待办A')
  })

  it('complete-todo 完成待办', async () => {
    const create = mock.ipc.handlers.get('create-todo')!
    const created = await create({ title: '待办B', due_at: Math.floor(Date.now() / 1000) + 3600 }) as { id: string }
    const complete = mock.ipc.handlers.get('complete-todo')!
    const res = await complete({ id: created.id, completed: true }) as { status?: string }
    expect(res.status).toBe('completed')
  })

  it('delete-event 删除事件', async () => {
    const create = mock.ipc.handlers.get('create-event')!
    const created = await create({
      title: '待删事件',
      start_at: Math.floor(Date.now() / 1000),
      end_at: Math.floor(Date.now() / 1000) + 3600,
    }) as { id: string }
    const del = mock.ipc.handlers.get('delete-event')!
    const res = await del({ id: created.id }) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })
})

describe('calendar 插件 IPC 边界 case', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('calendar')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-event 缺 title 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-event')!
    const res = await handler({ start_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-event 缺 start_at 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-event')!
    const res = await handler({ title: 't' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('list-events 缺 start_at/end_at 拒绝', async () => {
    const handler = mock.ipc.handlers.get('list-events')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('update-event 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('update-event')!
    const res = await handler({ title: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('delete-event 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('delete-event')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-todo 缺 title 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-todo')!
    const res = await handler({ due_at: 1 }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('update-todo 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('update-todo')!
    const res = await handler({ title: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('delete-todo 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('delete-todo')!
    const res = await handler({}) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('complete-todo 缺 id 拒绝', async () => {
    const handler = mock.ipc.handlers.get('complete-todo')!
    const res = await handler({ completed: true }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('todo-stats 返回统计', async () => {
    const handler = mock.ipc.handlers.get('todo-stats')!
    const res = await handler({}) as Record<string, unknown>
    expect(res).toBeTruthy()
  })

  it('get-settings 返回默认设置', async () => {
    const handler = mock.ipc.handlers.get('get-settings')!
    const res = await handler() as Record<string, unknown>
    expect(res).toBeTruthy()
  })

  it('set-settings 更新设置', async () => {
    const set = mock.ipc.handlers.get('set-settings')!
    const res = await set({ reminders_enabled: false }) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })
})

describe('calendar 插件导入去重', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('calendar')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('导入重复事件/待办时跳过，仅导入新数据', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    // 先创建一条事件
    const create = mock.ipc.handlers.get('create-event')!
    await create({ title: '会议', start_at: 1000, end_at: 2000 })

    const res = svc.importData({
      events: [
        // 与已存在事件重复 → 跳过
        { title: '会议', start_at: 1000, end_at: 2000 },
        // 新事件 → 导入
        { title: '新会议', start_at: 3000, end_at: 4000 },
      ],
      todos: [
        // 两条相同待办 → 仅导入一条
        { title: '待办A', due_at: 5000 },
        { title: '待办A', due_at: 5000 },
      ],
    })
    expect(res.events).toBe(1)
    expect(res.skippedEvents).toBe(1)
    expect(res.todos).toBe(1)
    expect(res.skippedTodos).toBe(1)
  })

  it('export-data 返回全部事件与待办', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    const create = mock.ipc.handlers.get('create-event')!
    await create({ title: '导出事件', start_at: 1000, end_at: 2000 })
    const data = svc.exportData()
    expect(data.version).toBe(1)
    expect(data.events.length).toBe(1)
    expect(data.events[0].title).toBe('导出事件')
  })
})

describe('calendar 插件实例级 override（拖动单实例）', () => {
  let mock: ReturnType<typeof createMockContext>

  // 每周重复事件起点（周三是 weekly+byday 场景，这里用无 byday 的 weekly：每 7 天一次，与时区无关）
  const BASE_START = Math.floor(Date.UTC(2026, 8, 2, 10, 0, 0) / 1000)
  const DURATION = 3600

  beforeEach(async () => {
    mock = createMockContext('calendar')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  function createWeeklyEvent(svc: ReturnType<typeof import('../../../calendar/src/main/calendar-service').getCalendarService>): { id: string } {
    return svc.createEvent({
      title: '周会',
      start_at: BASE_START,
      end_at: BASE_START + DURATION,
      recurrence_rule: { freq: 'weekly', interval: 1 },
    })
  }

  it('update-event-instance 拖动单个实例只移动该实例，系列起点与规则不变', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    const created = createWeeklyEvent(svc)

    // 第三个实例（+14 天）移到当天 15:00
    const anchor = BASE_START + 14 * 86400
    const newStart = anchor + 5 * 3600
    const handler = mock.ipc.handlers.get('update-event-instance')!
    const res = await handler({ id: created.id, anchor_at: anchor, start_at: newStart, end_at: newStart + DURATION }) as { error?: string }
    expect(res.error).toBeUndefined()

    // 系列起点与规则未被平移
    const after = svc.getEvent(created.id)!
    expect(after.start_at).toBe(BASE_START)
    expect(after.recurrence_rule!.freq).toBe('weekly')
    expect(after.recurrence_rule!.overrides).toHaveLength(1)
    expect(after.recurrence_rule!.overrides![0].recurrence_id).toBe(anchor)

    // 展开窗口：原锚点位置消失，新时间出现，其余实例不受影响
    const instances = svc.listEvents({ start_at: BASE_START - 86400, end_at: BASE_START + 30 * 86400 })
    const starts = instances.map(i => i.instance_start_at)
    expect(starts).not.toContain(anchor)
    expect(starts).toContain(newStart)
    expect(starts).toContain(BASE_START)
    expect(starts).toContain(BASE_START + 7 * 86400)
    expect(starts).toContain(BASE_START + 21 * 86400)

    // 移动后的实例携带原始锚点（RECURRENCE-ID），再拖动/删除时以此为准
    const moved = instances.find(i => i.instance_start_at === newStart)!
    expect(moved.instance_anchor_at).toBe(anchor)
    // 未移动的实例锚点等于自身开始时间
    const natural = instances.find(i => i.instance_start_at === BASE_START)!
    expect(natural.instance_anchor_at).toBe(BASE_START)
  })

  it('锚点在窗口外被 fastForward 跳过时，override 后的实例仍能落到窗口内', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    const created = createWeeklyEvent(svc)

    // 第一个实例（系列起点）移出窗口（+100 天，落到窗口之外）
    const firstAnchor = BASE_START
    const farStart = BASE_START + 100 * 86400
    await svc.updateEventInstance({ id: created.id, anchor_at: firstAnchor, start_at: farStart, end_at: farStart + DURATION })
    // 再把第二个实例（+7 天）移到第一个实例的原位置
    const secondAnchor = BASE_START + 7 * 86400
    await svc.updateEventInstance({ id: created.id, anchor_at: secondAnchor, start_at: BASE_START, end_at: BASE_START + DURATION })

    // 窗口从系列起点开始：原起点位置仍有实例（来自第二个锚点的 override），不存在重复输出
    const instances = svc.listEvents({ start_at: BASE_START - 86400, end_at: BASE_START + 30 * 86400 })
    const atBase = instances.filter(i => i.instance_start_at === BASE_START)
    expect(atBase).toHaveLength(1)
    expect(atBase[0].instance_anchor_at).toBe(secondAnchor)
    // 第二个实例原位置消失
    const starts = instances.map(i => i.instance_start_at)
    expect(starts).not.toContain(secondAnchor)
    // farStart 已超出窗口（winEnd = BASE_START + 30d），不应出现在窗口内
    expect(starts).not.toContain(farStart)
  })

  it('update-event-instance 锚点非法时返回 null，不产生脏 override', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    const created = createWeeklyEvent(svc)

    const badAnchor = BASE_START + 3 * 86400 // weekly 规则不存在该发生点
    const res = await svc.updateEventInstance({ id: created.id, anchor_at: badAnchor, start_at: badAnchor + 1, end_at: badAnchor + 1 + DURATION })
    expect(res).toBeNull()
    const after = svc.getEvent(created.id)!
    expect(after.recurrence_rule!.overrides ?? []).toHaveLength(0)
  })

  it('update-event-instance 对非重复事件退化为整条更新', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    const created = svc.createEvent({ title: '单次事件', start_at: BASE_START, end_at: BASE_START + DURATION })
    const res = await svc.updateEventInstance({ id: created.id, anchor_at: BASE_START, start_at: BASE_START + 3600, end_at: BASE_START + 3600 + DURATION })
    expect(res).not.toBeNull()
    expect(res!.start_at).toBe(BASE_START + 3600)
  })

  it('update-event 重新提交规则时保留既有 overrides（弹窗保存不吞实例 override）', async () => {
    const { getCalendarService } = await import('../../../calendar/src/main/calendar-service')
    const svc = getCalendarService(mock.ctx)
    const created = createWeeklyEvent(svc)

    const anchor = BASE_START + 7 * 86400
    await svc.updateEventInstance({ id: created.id, anchor_at: anchor, start_at: anchor + 3600, end_at: anchor + 3600 + DURATION })

    // 模拟编辑弹窗：提交的 recurrence_rule 不含 overrides
    const updated = svc.updateEvent({ id: created.id, title: '改名后的周会', recurrence_rule: { freq: 'weekly', interval: 1 } })
    expect(updated!.title).toBe('改名后的周会')
    expect(updated!.recurrence_rule!.overrides).toHaveLength(1)
    expect(updated!.recurrence_rule!.overrides![0].recurrence_id).toBe(anchor)
  })

  it('update-event-instance 缺参数拒绝', async () => {
    const handler = mock.ipc.handlers.get('update-event-instance')!
    expect((await handler({ id: 'x' }) as { error?: string }).error).toBeTruthy()
    expect((await handler({ id: 'x', anchor_at: 1 }) as { error?: string }).error).toBeTruthy()
    expect((await handler({ id: 'x', anchor_at: 1, start_at: 2 }) as { error?: string }).error).toBeTruthy()
  })
})
