/**
 * 日历提醒调度器（由宿主 calendar-scheduler.service.ts 迁移而来）。
 * 差异点：
 * - 不再继承 ScheduledTaskBase，改用 ctx.services.scheduler.every(30s) 定时扫描
 * - 提醒推送：settings.enable_system_notification=false 走 ctx.ipc.broadcast('notify')，否则 ctx.services.notification.notify
 */
import type { PluginContext } from '@workavatar/plugin-sdk'
import { getCalendarService } from './calendar-service'

const TICK_INTERVAL_MS = 30_000

class CalendarScheduler {
  private jobId: string | null = null

  constructor(private ctx: PluginContext) {}

  start(): void {
    try {
      const cleaned = getCalendarService(this.ctx).cleanupOldReminders()
      if (cleaned > 0) this.ctx.services.logger.info(`Cleaned ${cleaned} old reminders`)
    } catch (err: any) {
      this.ctx.services.logger.warn('Cleanup old reminders failed:', err?.message || err)
    }
    // 启动即扫描一次，随后每 30 秒扫描
    this.checkReminders()
    this.jobId = this.ctx.services.scheduler!.every(TICK_INTERVAL_MS, () => this.checkReminders())
  }

  stop(): void {
    if (this.jobId) {
      this.ctx.services.scheduler!.cancel(this.jobId)
      this.jobId = null
    }
  }

  private async checkReminders(): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000)
      const calendar = getCalendarService(this.ctx)
      const i18n = this.ctx.services.i18n
      const due = calendar.listDueReminders(now)
      if (due.length === 0) return

      const settings = calendar.getSettings()

      for (const reminder of due) {
        const payload = reminder.payload || {}
        const title = payload.title || i18n.t('calendar.reminderDefaultTitle')
        const body = payload.body || ''
        // 通知发送失败不得中断循环：否则 markReminderFired 不执行，
        // 该提醒及后续到期提醒会留在队列每 30s 重放
        try {
          const notifyPayload = {
            title,
            body,
            clickTarget: payload.clickTarget,
            clickId: payload.clickId,
            // 渲染端与系统通知按当前语言本地化正文（插件 locale 的 calendar.* 文案键）
            i18nKey: payload.i18nKey,
            i18nParams: payload.i18nParams,
          }
          // 用户禁用系统通知时，仍走 IPC 广播（前端弹 antd notification）
          if (!settings.enable_system_notification) {
            this.ctx.ipc.broadcast('notify', { ...notifyPayload, source: 'calendar' })
          } else {
            this.ctx.services.notification!.notify({ ...notifyPayload, source: 'calendar' })
          }
        } catch (err: any) {
          this.ctx.services.logger.warn(`notify failed for reminder ${reminder.id}:`, err?.message || err)
        }
        calendar.markReminderFired(reminder.id)
        // 提醒触发后检查重复事件/TODO 的未来提醒是否耗尽，滚动再生避免 90 天后静默消失
        try {
          calendar.ensureRemindersForRecurring(reminder.target_type, reminder.target_id)
        } catch (err: any) {
          this.ctx.services.logger.warn(`ensureRemindersForRecurring failed for ${reminder.target_type}:${reminder.target_id}:`, err?.message || err)
        }
      }
      this.ctx.services.logger.info(`Fired ${due.length} reminder(s)`)
    } catch (err: any) {
      this.ctx.services.logger.error('Scheduler tick error:', err?.message || err)
    }
  }
}

export default CalendarScheduler
