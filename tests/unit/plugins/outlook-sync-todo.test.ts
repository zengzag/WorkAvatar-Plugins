import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

// outlook-auth 依赖 electron（BrowserWindow / safeStorage），node 环境下需 mock
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
    webContents = { send: vi.fn() }
  },
  shell: { openExternal: vi.fn(async () => {}) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))

interface GraphCall { method: string; url: string; body?: any }

const ok = (data: unknown = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const noContent = () => new Response(null, { status: 204 })

/** 本地规则指纹需与实现一致（undefined 字段被 JSON.stringify 丢弃） */
const ruleKey = (rule: Record<string, unknown>) => JSON.stringify(rule)

async function setup() {
  vi.resetModules()
  const mock = createMockContext('calendar')
  const calMod = await import('../../../calendar/src/main/calendar-service')
  const syncMod = await import('../../../calendar/src/main/outlook-sync')
  const authMod = await import('../../../calendar/src/main/outlook-auth')
  const calendar = calMod.getCalendarService(mock.ctx)
  const auth = authMod.getOutlookAuthService(mock.ctx)
  vi.spyOn(auth, 'isLoggedIn').mockReturnValue(true)
  vi.spyOn(auth, 'getAccessToken').mockResolvedValue('token')
  vi.spyOn(auth, 'getAccount').mockReturnValue(null)
  const sync = syncMod.getOutlookSyncService(mock.ctx)
  sync.setConfig({ enabled: true, auto_sync: true, sync_events: false, sync_todos: true })
  const db = mock.ctx.storage.openSqlite('index')
  return { mock, calendar, sync, db }
}

function insertMap(db: any, todoId: string, remoteId: string, syncedUpdatedAt: number, syncedDue: number | null, syncedRule: string | null) {
  db.prepare(
    `INSERT INTO calendar_sync_map (target, local_type, local_id, remote_id, synced_updated_at, synced_due, synced_rule)
     VALUES ('outlook','todo',?,?,?,?,?)`
  ).run(todoId, remoteId, syncedUpdatedAt, syncedDue, syncedRule)
}

function stubFetch(handler: (call: GraphCall) => Response | undefined, calls: GraphCall[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: GraphCall = {
      method: init?.method || 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    return handler(call) ?? ok({ value: [] })
  }))
}

const listRoute = (c: GraphCall) => c.method === 'GET' && c.url.endsWith('/me/todo/lists')
const tasksRoute = (c: GraphCall) => c.method === 'GET' && c.url.includes('/tasks?$expand=extensions')

describe('Outlook 待办同步（重复系列）', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('旧版无规则的远端重复待办：PATCH 补回 recurrence，不删建', async () => {
    const { calendar, sync, db } = await setup()
    const dueAt = Math.floor(Date.now() / 1000) + 3600
    const todo = calendar.createTodo({ title: '安全生产周报', due_at: dueAt, tzid: 'Asia/Shanghai', recurrence_rule: { freq: 'weekly', interval: 1 } })
    insertMap(db, todo.id, 'R1', todo.updated_at, dueAt, null)

    const calls: GraphCall[] = []
    stubFetch((c) => {
      if (listRoute(c)) return ok({ value: [{ id: 'L1', displayName: 'WorkAvatar' }] })
      if (tasksRoute(c)) {
        return ok({
          value: [{
            id: 'R1', title: '安全生产周报', status: 'notStarted',
            dueDateTime: { dateTime: '2026-11-01T16:00:00.0000000', timeZone: 'UTC' },
            extensions: [{ extensionName: 'com.workavatar.sync', localId: todo.id }],
          }],
        })
      }
      if (c.url.includes('/tasks/R1') && c.method === 'PATCH') return ok({ id: 'R1', status: 'notStarted' })
      return undefined
    }, calls)

    await sync.runSync()

    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/tasks/R1'))
    expect(patch).toBeTruthy()
    expect(patch!.body.recurrence.pattern.type).toBe('weekly')
    // 重复任务绝不 PATCH dueDateTime（会派生新任务）
    expect(patch!.body.dueDateTime).toBeUndefined()
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/tasks'))).toBe(false)
  })

  it('重复待办完成一次：PATCH status=completed 推进，不碰 dueDateTime', async () => {
    const { calendar, sync, db } = await setup()
    const dueAt = Math.floor(Date.now() / 1000) + 3600
    const todo = calendar.createTodo({ title: '周会', due_at: dueAt, tzid: 'Asia/Shanghai', recurrence_rule: { freq: 'weekly', interval: 1 } })
    const done = calendar.completeTodo(todo.id, true)!
    expect(done.due_at).toBeGreaterThan(dueAt)

    insertMap(db, todo.id, 'R1', done.updated_at - 1, dueAt, ruleKey({ freq: 'weekly', interval: 1 }))

    const calls: GraphCall[] = []
    stubFetch((c) => {
      if (listRoute(c)) return ok({ value: [{ id: 'L1', displayName: 'WorkAvatar' }] })
      if (tasksRoute(c)) {
        return ok({
          value: [{
            id: 'R1', title: '周会', status: 'notStarted',
            dueDateTime: { dateTime: '2026-11-01T16:00:00.0000000', timeZone: 'UTC' },
            recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'] }, range: { type: 'noEnd', startDate: '2026-11-02' } },
            extensions: [{ extensionName: 'com.workavatar.sync', localId: todo.id }],
          }],
        })
      }
      if (c.url.includes('/tasks/R1') && c.method === 'PATCH') return ok({ id: 'R1', status: 'notStarted', recurrence: {} })
      return undefined
    }, calls)

    await sync.runSync()

    const patch = calls.find(c => c.method === 'PATCH' && c.body?.status === 'completed')
    expect(patch).toBeTruthy()
    expect(patch!.body.completedDateTime).toBeTruthy()
    expect(patch!.body.dueDateTime).toBeUndefined()
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)

    const row = db.prepare(`SELECT remote_id, synced_due FROM calendar_sync_map WHERE local_id = ?`).get(todo.id) as any
    expect(row.remote_id).toBe('R1')
    expect(row.synced_due).toBe(done.due_at)
  })

  it('重复系列结束：完成最后一次 → 清规则 → 删除活动任务', async () => {
    const { calendar, sync, db } = await setup()
    const dueAt = Math.floor(Date.now() / 1000) + 3600
    const todo = calendar.createTodo({ title: '一次性系列', due_at: dueAt, tzid: 'Asia/Shanghai', recurrence_rule: { freq: 'weekly', interval: 1, count: 1 } })
    const done = calendar.completeTodo(todo.id, true)!
    expect(done.status).toBe('completed')

    insertMap(db, todo.id, 'R1', done.updated_at - 1, dueAt, ruleKey({ freq: 'weekly', interval: 1, count: 1 }))

    const calls: GraphCall[] = []
    stubFetch((c) => {
      if (listRoute(c)) return ok({ value: [{ id: 'L1', displayName: 'WorkAvatar' }] })
      if (tasksRoute(c)) {
        return ok({
          value: [{
            id: 'R1', title: '一次性系列', status: 'notStarted',
            dueDateTime: { dateTime: '2026-11-01T16:00:00.0000000', timeZone: 'UTC' },
            recurrence: { pattern: { type: 'weekly', interval: 1 }, range: { type: 'numbered', startDate: '2026-11-02', numberOfOccurrences: 1 } },
            extensions: [{ extensionName: 'com.workavatar.sync', localId: todo.id }],
          }],
        })
      }
      if (c.url.includes('/tasks/R1') && c.method === 'PATCH') return ok({ id: 'R1', status: 'notStarted' })
      if (c.url.includes('/tasks/R1') && c.method === 'DELETE') return noContent()
      return undefined
    }, calls)

    await sync.runSync()

    expect(calls.some(c => c.method === 'PATCH' && c.body?.status === 'completed')).toBe(true)
    expect(calls.some(c => c.method === 'PATCH' && c.body?.recurrence === null)).toBe(true)
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/tasks/R1'))).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS c FROM calendar_sync_map WHERE local_id = ?`).get(todo.id)).toMatchObject({ c: 0 })
  })

  it('清理遗留待办副本：删 pending 重复项，保留 completed 历史', async () => {
    const { calendar, sync, db } = await setup()
    const dueAt = Math.floor(Date.now() / 1000) + 3600
    const todo = calendar.createTodo({ title: '写周报', due_at: dueAt, tzid: 'Asia/Shanghai' })
    insertMap(db, todo.id, 'R1', todo.updated_at - 1, dueAt, null)

    const calls: GraphCall[] = []
    stubFetch((c) => {
      if (listRoute(c)) return ok({ value: [{ id: 'L1', displayName: 'WorkAvatar' }] })
      if (tasksRoute(c)) {
        return ok({
          value: [
            { id: 'R1', title: '写周报', status: 'notStarted', dueDateTime: { dateTime: '2026-11-01T16:00:00.0000000', timeZone: 'UTC' }, extensions: [{ extensionName: 'com.workavatar.sync', localId: todo.id }] },
            { id: 'R2', title: '写周报', status: 'notStarted', dueDateTime: { dateTime: '2026-10-25T16:00:00.0000000', timeZone: 'UTC' }, extensions: [] },
            { id: 'R3', title: '写周报', status: 'completed', dueDateTime: { dateTime: '2026-10-18T16:00:00.0000000', timeZone: 'UTC' }, extensions: [] },
            { id: 'R4', title: '别人的任务', status: 'notStarted', dueDateTime: { dateTime: '2026-10-25T16:00:00.0000000', timeZone: 'UTC' }, extensions: [] },
          ],
        })
      }
      if (c.url.includes('/tasks/R1') && c.method === 'PATCH') return ok({ id: 'R1', status: 'notStarted' })
      if (c.method === 'DELETE') return noContent()
      return undefined
    }, calls)

    await sync.runSync()

    const deleted = calls.filter(c => c.method === 'DELETE').map(c => c.url.split('/').pop())
    expect(deleted).toEqual(['R2'])
  })
})
