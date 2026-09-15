/**
 * calendar 内置插件主进程入口。
 * - 数据完全自包含于插件分库（calendar-service 保证建表）
 * - IPC 经 ctx.ipc.handle 注册（通道自动加 plugin:calendar: 前缀，短名见 manifest 白名单），写操作后广播 data-changed
 * - agent 工具经 ctx.contributions.registerAgentTools 注入（工具 id 不变）
 */
import type { PluginContext } from '@workavatar/plugin-sdk'
import { getCalendarService } from './calendar-service'
import CalendarScheduler from './calendar-scheduler'
import { getOutlookAuthService } from './outlook-auth'
import { getOutlookSyncService } from './outlook-sync'
import { createCalendarTools } from './tools'

// ====== 激活 ======

let scheduler: CalendarScheduler | null = null
let outlookSync: ReturnType<typeof getOutlookSyncService> | null = null

export function activate(ctx: PluginContext): void {
  const calendar = getCalendarService(ctx)
  const auth = getOutlookAuthService(ctx)
  const sync = getOutlookSyncService(ctx)
  outlookSync = sync
  scheduler = new CalendarScheduler(ctx)
  registerIpc(ctx)
  ctx.contributions.registerAgentTools(createCalendarTools())
  scheduler.start()
  sync.start()
  ctx.services.logger.info('calendar 插件激活完成')
}

export function deactivate(): void {
  if (scheduler) {
    scheduler.stop()
    scheduler = null
  }
  if (outlookSync) {
    outlookSync.stop()
    outlookSync = null
  }
}

// ====== IPC ======

function broadcastDataChanged(ctx: PluginContext, scope: 'event' | 'todo' | 'settings'): void {
  ctx.ipc.broadcast('data-changed', { scope, ts: Date.now() })
}

function registerIpc(ctx: PluginContext): void {
  const calendar = getCalendarService(ctx)
  const auth = getOutlookAuthService(ctx)
  const sync = getOutlookSyncService(ctx)
  const i18n = ctx.services.i18n

  // ====== 事件 ======

  ctx.ipc.handle('list-events', (params: any) => {
    if (!params || typeof params.start_at !== 'number' || typeof params.end_at !== 'number') {
      return { error: i18n.t('calendar.startEndRequired') }
    }
    return calendar.listEvents(params)
  })

  ctx.ipc.handle('create-event', (input: any) => {
    if (!input?.title || typeof input.start_at !== 'number') {
      return { error: i18n.t('calendar.titleAndStartRequired') }
    }
    const event = calendar.createEvent(input)
    broadcastDataChanged(ctx, 'event')
    return event
  })

  ctx.ipc.handle('update-event', (input: any) => {
    if (!input?.id) return { error: i18n.t('calendar.idRequired') }
    const event = calendar.updateEvent(input)
    if (event) broadcastDataChanged(ctx, 'event')
    return event
  })

  ctx.ipc.handle('update-event-instance', (input: any) => {
    if (!input?.id || typeof input.anchor_at !== 'number' || typeof input.start_at !== 'number' || typeof input.end_at !== 'number') {
      return { error: i18n.t('calendar.eventInstanceFieldsRequired') }
    }
    const event = calendar.updateEventInstance(input)
    if (event) broadcastDataChanged(ctx, 'event')
    return event
  })

  ctx.ipc.handle('delete-event', (params: any) => {
    if (!params?.id) return { error: i18n.t('calendar.idRequired') }
    const ok = calendar.deleteEvent(params.id)
    if (ok) broadcastDataChanged(ctx, 'event')
    return { success: ok }
  })

  ctx.ipc.handle('delete-event-instance', (params: any) => {
    if (!params?.id || typeof params.anchor_at !== 'number' || !params.mode) {
      return { error: i18n.t('calendar.idAnchorModeRequired') }
    }
    const ok = calendar.deleteEventInstance(params)
    if (ok) broadcastDataChanged(ctx, 'event')
    return { success: ok }
  })

  // ====== TODO ======

  ctx.ipc.handle('list-todos', (params: any) => {
    return calendar.listTodos(params || {})
  })

  ctx.ipc.handle('list-todo-instances', (params: any) => {
    if (!params || typeof params.start_at !== 'number' || typeof params.end_at !== 'number') {
      return { error: i18n.t('calendar.startEndRequired') }
    }
    return calendar.listTodoInstances(params)
  })

  ctx.ipc.handle('create-todo', (input: any) => {
    if (!input?.title) return { error: i18n.t('calendar.titleRequired') }
    const todo = calendar.createTodo(input)
    broadcastDataChanged(ctx, 'todo')
    return todo
  })

  ctx.ipc.handle('update-todo', (input: any) => {
    if (!input?.id) return { error: i18n.t('calendar.idRequired') }
    const todo = calendar.updateTodo(input)
    if (todo) broadcastDataChanged(ctx, 'todo')
    return todo
  })

  ctx.ipc.handle('delete-todo', (params: any) => {
    if (!params?.id) return { error: i18n.t('calendar.idRequired') }
    const ok = calendar.deleteTodo(params.id)
    if (ok) broadcastDataChanged(ctx, 'todo')
    return { success: ok }
  })

  ctx.ipc.handle('delete-todo-instance', (params: any) => {
    if (!params?.id || typeof params.anchor_at !== 'number' || !params.mode) {
      return { error: i18n.t('calendar.idAnchorModeRequired') }
    }
    const ok = calendar.deleteTodoInstance(params)
    if (ok) broadcastDataChanged(ctx, 'todo')
    return { success: ok }
  })

  ctx.ipc.handle('complete-todo', (params: any) => {
    if (!params?.id) return { error: i18n.t('calendar.idRequired') }
    const todo = calendar.completeTodo(params.id, params.completed, params.instance_due_at)
    if (todo) broadcastDataChanged(ctx, 'todo')
    return todo
  })

  ctx.ipc.handle('todo-stats', () => {
    return calendar.getTodoStats()
  })

  // ====== 设置 ======

  ctx.ipc.handle('get-settings', () => {
    return calendar.getSettings()
  })

  ctx.ipc.handle('set-settings', (params: any) => {
    const next = calendar.setSettings(params || {})
    broadcastDataChanged(ctx, 'settings')
    return next
  })

  // ====== 导入导出 ======

  ctx.ipc.handle('export-data', async () => {
    const { dialog } = require('electron')
    const data = calendar.exportData()
    const res = await dialog.showSaveDialog({
      title: i18n.t('calendar.exportDialogTitle'),
      defaultPath: `calendar-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    const fs = require('fs')
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf-8')
    return { ok: true, path: res.filePath, events: data.events.length, todos: data.todos.length }
  })

  ctx.ipc.handle('import-data', async () => {
    const { dialog } = require('electron')
    const res = await dialog.showOpenDialog({
      title: i18n.t('calendar.importDialogTitle'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
    const fs = require('fs')
    try {
      const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'))
      const data = raw?.data ?? raw
      if (!data || (!Array.isArray(data.events) && !Array.isArray(data.todos))) {
        return { error: i18n.t('calendar.invalidImportFile') }
      }
      const result = calendar.importData({ events: data.events, todos: data.todos })
      broadcastDataChanged(ctx, 'event')
      broadcastDataChanged(ctx, 'todo')
      return { ok: true, ...result }
    } catch (e: any) {
      return { error: i18n.t('calendar.importFailedWithReason', { reason: e?.message || String(e) }) }
    }
  })

  // ====== Outlook 同步 ======

  ctx.ipc.handle('outlook-login', async () => {
    const result = await auth.login()
    if ('error' in result && result.error) return { error: result.error }
    // 登录成功后立即触发一次全量同步
    sync.runSync().catch(() => { /* ignore */ })
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-logout', () => {
    auth.logout()
    sync.onLogout()
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-status', () => {
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-set-config', (params: any) => {
    sync.setConfig(params || {})
    return sync.getStatus()
  })

  ctx.ipc.handle('outlook-sync-now', async () => {
    return sync.syncNow()
  })
}
