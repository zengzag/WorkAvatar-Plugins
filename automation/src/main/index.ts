/**
 * automation 内置插件主进程入口。
 * - 数据完全自包含于插件分库（automation-service 保证建表）
 * - IPC 经 ctx.ipc.handle 注册（通道自动加 plugin:automation: 前缀，短名见 manifest 白名单），写操作后广播 data-changed
 * - agent 工具经 ctx.contributions.registerAgentTools 注入（工具 id 不变）
 * - 调度器经 ctx.services.scheduler.every(30s) 驱动
 * - conversation 删除双向同步：订阅 ctx.services.events 的 conversation:deleted 清理关联 run 记录
 */
import type { PluginContext } from '@workavatar/plugin-sdk'
import { getAutomationService, resetAutomationService } from './automation-service'
import AutomationScheduler from './automation-scheduler'
import { createAutomationTools } from './tools'

// ====== 激活 ======

let scheduler: AutomationScheduler | null = null
let unsubscribeConversationDeleted: (() => void) | null = null
let unsubscribeModelRenamed: (() => void) | null = null
let unsubscribeEmployeeEvents: Array<() => void> = []

export function activate(ctx: PluginContext): void {
  const service = getAutomationService(ctx)
  scheduler = new AutomationScheduler(ctx)
  registerIpc(ctx)
  ctx.contributions.registerAgentTools(createAutomationTools(ctx))
  // conversation 删除双向同步：内核删除对话 → 清理关联 run 记录
  unsubscribeConversationDeleted = ctx.services.events!.subscribe('conversation:deleted', (conversationId) => {
    try { service.deleteRunByConversation(conversationId as string) } catch { /* ignore */ }
  })
  // 模型重命名同步：内核重命名模型 → 更新任务/执行历史中的 model_id
  unsubscribeModelRenamed = ctx.services.events!.subscribe('model:renamed', (payload) => {
    try {
      const { providerId, renames } = payload as { providerId: string; renames: Record<string, string> }
      service.syncModelRenames(providerId, renames)
    } catch { /* ignore */ }
    // 通知渲染端刷新员工/模型下拉选项
    ctx.ipc.broadcast('meta-changed', { scope: 'providers', ts: Date.now() })
  })
  // 员工增删改：通知渲染端刷新员工下拉选项
  const subscribeEmployee = (event: string) => {
    unsubscribeEmployeeEvents.push(ctx.services.events!.subscribe(event, () => {
      ctx.ipc.broadcast('meta-changed', { scope: 'employees', ts: Date.now() })
    }))
  }
  subscribeEmployee('employee:created')
  subscribeEmployee('employee:updated')
  subscribeEmployee('employee:deleted')
  // 供应商/模型增删改：通知渲染端刷新模型下拉选项
  unsubscribeEmployeeEvents.push(ctx.services.events!.subscribe('provider:changed', () => {
    ctx.ipc.broadcast('meta-changed', { scope: 'providers', ts: Date.now() })
  }))
  scheduler.start()
  ctx.services.logger.info('automation 插件激活完成')
}

export function deactivate(): void {
  if (scheduler) {
    scheduler.stop()
    scheduler = null
  }
  if (unsubscribeConversationDeleted) {
    unsubscribeConversationDeleted()
    unsubscribeConversationDeleted = null
  }
  if (unsubscribeModelRenamed) {
    unsubscribeModelRenamed()
    unsubscribeModelRenamed = null
  }
  unsubscribeEmployeeEvents.forEach((unsub) => { try { unsub() } catch { /* ignore */ } })
  unsubscribeEmployeeEvents = []
  resetAutomationService()
}

// ====== IPC ======

function broadcastDataChanged(ctx: PluginContext, scope: 'task' | 'run' | 'settings'): void {
  ctx.ipc.broadcast('data-changed', { scope, ts: Date.now() })
}

function registerIpc(ctx: PluginContext): void {
  const service = getAutomationService(ctx)
  const t = (key: string) => ctx.services.i18n.t(key)

  // ====== 任务 CRUD ======

  ctx.ipc.handle('list-tasks', (params: any) => {
    return service.listTasks(params || {})
  })

  ctx.ipc.handle('get-task', (id: string) => {
    if (!id) return { error: t('automation.errors.idRequired') }
    return service.getTask(id)
  })

  ctx.ipc.handle('create-task', (input: any) => {
    if (!input?.title?.trim()) return { error: t('automation.errors.titleRequired') }
    if (!input?.prompt?.trim()) return { error: t('automation.errors.promptRequired') }
    if (!input?.employee_id) return { error: t('automation.errors.employeeRequired') }
    if (!input?.provider_id) return { error: t('automation.errors.providerRequired') }
    if (typeof input?.start_at !== 'number') return { error: t('automation.errors.startAtRequired') }
    try {
      const task = service.createTask(input)
      broadcastDataChanged(ctx, 'task')
      return task
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('update-task', (input: any) => {
    if (!input?.id) return { error: t('automation.errors.idRequired') }
    try {
      const task = service.updateTask(input)
      if (task) broadcastDataChanged(ctx, 'task')
      return task
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('delete-task', async (params: any) => {
    if (!params?.id) return { error: t('automation.errors.idRequired') }
    try {
      const ok = await service.deleteTask(params.id)
      if (ok) broadcastDataChanged(ctx, 'task')
      return { success: ok }
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('toggle-task', (params: any) => {
    if (!params?.id) return { error: t('automation.errors.idRequired') }
    const task = service.toggleTask(params.id, params.enabled)
    if (task) broadcastDataChanged(ctx, 'task')
    return task
  })

  // ====== 执行 ======

  ctx.ipc.handle('run-now', async (params: any) => {
    if (!params?.id) return { error: t('automation.errors.idRequired') }
    try {
      const run = await service.runTask(params.id, 'manual')
      broadcastDataChanged(ctx, 'run')
      broadcastDataChanged(ctx, 'task')
      return run
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('preview-runs', (params: any) => {
    if (!params?.task_id) return { error: t('automation.errors.idRequired') }
    const task = service.getTask(params.task_id)
    if (!task) return { error: t('automation.errors.taskNotFound') }
    const count = Math.max(1, Math.min(10, params.count ?? 5))
    const runs = service.previewNextRuns(task, count)
    return { runs }
  })

  // ====== 运行历史 CRUD ======

  ctx.ipc.handle('list-runs', (params: any) => {
    return service.listRuns(params || {})
  })

  ctx.ipc.handle('delete-run', async (params: any) => {
    if (!params?.id) return { error: t('automation.errors.idRequired') }
    try {
      const ok = await service.deleteRun(params.id)
      if (ok) broadcastDataChanged(ctx, 'run')
      return { success: ok }
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('clear-runs', async (params: any) => {
    try {
      const count = await service.clearRuns(params?.task_id)
      broadcastDataChanged(ctx, 'run')
      return { success: true, count }
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })
}
