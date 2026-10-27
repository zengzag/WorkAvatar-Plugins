/**
 * Outlook 单向同步引擎：本地 SQLite → Outlook（Graph API）。差异点：
 * - 不再继承 ScheduledTaskBase：start() 立即跑一次 runCheck + every(60s)，stop() 取消
 * - 配置/状态/映射归属账号存插件库 plugin_kv（calendar_outlook_sync_config / calendar_outlook_sync_state / calendar_outlook_sync_account），映射表 calendar_sync_map
 * - broadcast() 改走 ctx.ipc.broadcast('outlook-sync-changed', status)
 */
import type { PluginContext } from '@workavatar/plugin-sdk'
import type {
  CalendarEvent,
  CalendarTodo,
  OutlookSyncConfig,
  OutlookSyncResult,
  OutlookSyncStatus,
  RecurrenceRule,
} from './calendar-service'
import { getCalendarService } from './calendar-service'
import { getOutlookAuthService } from './outlook-auth'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
/** 推送到 Outlook 的目标日历名 / To Do 列表名 */
const TARGET_NAME = 'WorkAvatar'
const CONFIG_KEY = 'calendar_outlook_sync_config'
const STATE_KEY = 'calendar_outlook_sync_state'
/** 映射表归属的 Outlook 账号 id：换号登录时据此清空映射 */
const ACCOUNT_KEY = 'calendar_outlook_sync_account'
/** 远端事件回指本地 id 的单值扩展属性（Outlook 界面不可见，映射丢失后凭它精确找回） */
const LOCAL_ID_PROP = 'String {7c1f5a8e-2b64-4d9a-9f3e-8a5d1c6b0e42} Name WorkAvatarId'
/** 待办回指本地 id 的开放扩展：todoTask 不支持 singleValueExtendedProperties，只能用 open extension */
const TODO_EXT_NAME = 'com.workavatar.sync'

/** 远端对象：id + 回指的本地 id + 去重键（待办额外记录状态与到期，用于完成历史/撤销判断） */
interface RemoteObj {
  id: string
  localId?: string
  key: string
  title?: string
  hasRecurrence?: boolean
  status?: string
  dueDateTime?: string
  dueTimeZone?: string
  used: boolean
}
interface RemoteIndex {
  objs: RemoteObj[]
  byMarker: Map<string, RemoteObj[]>
  byFuzzy: Map<string, RemoteObj[]>
  /** 待办索引是否成功带出开放扩展（不支持时不能写标记，也只能按模糊键回收） */
  withExtensions?: boolean
}

const DEFAULT_CONFIG: OutlookSyncConfig = {
  enabled: true,
  auto_sync: true,
  sync_events: true,
  sync_todos: true,
}

const BYDAY_MAP: Record<string, string> = {
  SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday',
  TH: 'thursday', FR: 'friday', SA: 'saturday',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class OutlookSyncService {
  private db: any
  private schedulerJob: string | null = null
  private syncing = false
  private lastDataVersion = ''
  /** 连续同步失败计数：≥5 次后停止自动重试（防 Graph API 重试风暴） */
  private syncFailCount = 0
  private calendarId: string | null = null
  private todoListId: string | null = null
  /** 已尝试写入待办标记的远端 id（扩展写入失败时避免每轮同步重复请求） */
  private markerAttempted = new Set<string>()

  constructor(private ctx: PluginContext) {
    this.db = ctx.storage.openSqlite('index')
    this.db.exec('CREATE TABLE IF NOT EXISTS plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_sync_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        local_type TEXT NOT NULL,
        local_id TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        synced_updated_at INTEGER NOT NULL,
        synced_due INTEGER,
        synced_rule TEXT,
        synced_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_map_unique ON calendar_sync_map(target, local_type, local_id);
    `)
    // 存量库补列：记录上次推送时的到期时间与重复规则指纹，用于判定「完成推进 / 撤销 / 改期 / 改规则」
    const cols = new Set((this.db.prepare('PRAGMA table_info(calendar_sync_map)').all() as any[]).map(c => c.name))
    if (!cols.has('synced_due')) this.db.exec('ALTER TABLE calendar_sync_map ADD COLUMN synced_due INTEGER')
    if (!cols.has('synced_rule')) this.db.exec('ALTER TABLE calendar_sync_map ADD COLUMN synced_rule TEXT')
  }

  start(): void {
    // 启动先跑一次（变化即同步），随后每 60 秒检查
    this.runCheck()
    this.schedulerJob = this.ctx.services.scheduler!.every(60_000, () => this.runCheck())
  }

  stop(): void {
    if (this.schedulerJob) {
      this.ctx.services.scheduler!.cancel(this.schedulerJob)
      this.schedulerJob = null
    }
  }

  // ====== 配置 / 状态持久化 ======

  getConfig(): OutlookSyncConfig {
    try {
      const row = this.db.prepare('SELECT value FROM plugin_kv WHERE key = ?').get(CONFIG_KEY) as { value?: string } | undefined
      if (row?.value) return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) }
    } catch { /* ignore */ }
    return { ...DEFAULT_CONFIG }
  }

  setConfig(partial: Partial<OutlookSyncConfig>): OutlookSyncConfig {
    const next = { ...this.getConfig(), ...partial }
    this.db.prepare(
      `INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(CONFIG_KEY, JSON.stringify(next))
    return next
  }

  private loadState(): { last_result: OutlookSyncResult | null; last_error: string | null } {
    try {
      const row = this.db.prepare('SELECT value FROM plugin_kv WHERE key = ?').get(STATE_KEY) as { value?: string } | undefined
      if (row?.value) return JSON.parse(row.value)
    } catch { /* ignore */ }
    return { last_result: null, last_error: null }
  }

  private saveState(state: { last_result: OutlookSyncResult | null; last_error: string | null }): void {
    this.db.prepare(
      `INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(STATE_KEY, JSON.stringify(state))
  }

  getStatus(): OutlookSyncStatus {
    const auth = getOutlookAuthService(this.ctx)
    const state = this.loadState()
    return {
      signed_in: auth.isLoggedIn(),
      account: auth.getAccount(),
      config: this.getConfig(),
      syncing: this.syncing,
      last_result: state.last_result,
      last_error: state.last_error,
    }
  }

  /**
   * 登出：仅重置内存缓存与状态，保留映射表。
   * 同一账号重新登录时映射仍有效，避免全量重建造成 Outlook 侧重复；
   * 换号登录由 ensureMapAccount 检测账号变化后清空。
   */
  onLogout(): void {
    this.calendarId = null
    this.todoListId = null
    this.lastDataVersion = ''
    this.saveState({ last_result: null, last_error: null })
    this.broadcast()
  }

  /** 账号变化（换号登录）时清空映射：旧 remote_id 属于另一账号，且目标日历/列表不同 */
  private ensureMapAccount(): void {
    const current = getOutlookAuthService(this.ctx).getAccount()?.id || ''
    if (!current) return
    let stored = ''
    try {
      const row = this.db.prepare('SELECT value FROM plugin_kv WHERE key = ?').get(ACCOUNT_KEY) as { value?: string } | undefined
      stored = row?.value || ''
    } catch { /* ignore */ }
    if (stored === current) return
    if (stored) {
      this.db.prepare('DELETE FROM calendar_sync_map WHERE target = ?').run('outlook')
      this.ctx.services.logger.info('Outlook 账号变化，清空同步映射')
    }
    this.db.prepare(
      `INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(ACCOUNT_KEY, current)
  }

  // ====== 调度 ======

  /** 数据版本指纹：updated_at 最大值 + 行数，变化则触发同步 */
  private computeDataVersion(): string {
    const e = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM calendar_events').get() as any
    const t = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM calendar_todos').get() as any
    return `${e.c}:${e.m}|${t.c}:${t.m}`
  }

  private async runCheck(): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.auto_sync) return
    if (!getOutlookAuthService(this.ctx).isLoggedIn()) return
    const version = this.computeDataVersion()
    if (version === this.lastDataVersion) return
    this.lastDataVersion = version
    await this.runSync()
  }

  /** 手动触发同步（设置面板"立即同步"） */
  async syncNow(): Promise<OutlookSyncStatus> {
    await this.runSync()
    return this.getStatus()
  }

  private broadcast(): void {
    this.ctx.ipc.broadcast('outlook-sync-changed', this.getStatus())
  }

  // ====== 云端重置 ======

  /**
   * 清空云端目标日历/列表中本插件推送的全部对象并重置映射，随后全量重推。
   * 用于修复云端已产生的重复数据：结束后云端与本地一一对应、仅保留一份。
   */
  async clearRemoteAndResync(): Promise<OutlookSyncStatus> {
    const auth = getOutlookAuthService(this.ctx)
    if (this.syncing || !auth.isLoggedIn()) return this.getStatus()
    this.syncing = true
    this.broadcast()
    let purged = false
    try {
      const token = await auth.getAccessToken()
      if (!token) throw new Error(this.ctx.services.i18n.t('calendar.outlookSessionExpired'))
      const cfg = this.getConfig()
      if (cfg.sync_events) {
        this.calendarId = await this.ensureTargetCalendar(token)
        await this.purgeRemote(token, 'event')
      }
      if (cfg.sync_todos) {
        this.todoListId = await this.ensureTodoList(token)
        await this.purgeRemote(token, 'todo')
      }
      purged = true
    } catch (err: any) {
      this.ctx.services.logger.error('Clear remote failed:', err?.message)
      this.saveState({ ...this.loadState(), last_error: err?.message || this.ctx.services.i18n.t('calendar.outlookClearRemoteFailed') })
    } finally {
      this.syncing = false
      this.broadcast()
    }
    if (purged) {
      // 云端已清空：映射指向的对象已不存在，全部重置后由 runSync 全量重建
      this.db.prepare('DELETE FROM calendar_sync_map WHERE target = ?').run('outlook')
      this.lastDataVersion = ''
      this.saveState({ last_result: null, last_error: null })
      this.ctx.services.logger.info('Outlook 远端已清空，全量重推本地数据')
      // force：即使「启用同步」关闭也执行本次重推（按钮语义为清空+重推）
      await this.runSync(true)
    }
    return this.getStatus()
  }

  /** 删除目标日历/列表中本插件推送的全部远端对象（单个失败仅记录日志，尽量清完） */
  private async purgeRemote(token: string, type: 'event' | 'todo'): Promise<void> {
    const ids: string[] = []
    // 不带 $expand 拉全量：清空只需 id，事件按 WorkAvatar 分类过滤，避免误删手工日程
    let path: string | null = type === 'event'
      ? `/me/calendars/${this.calendarId}/events?$select=id,categories`
      : `/me/todo/lists/${this.todoListId}/tasks`
    while (path) {
      const json = await this.graph(token, 'GET', path)
      for (const item of json?.value || []) {
        if (type === 'event' && !(item.categories || []).includes(TARGET_NAME)) continue
        ids.push(item.id)
      }
      const next: string | undefined = json?.['@odata.nextLink']
      path = next?.startsWith(GRAPH_BASE) ? next.slice(GRAPH_BASE.length) : null
    }
    for (const id of ids) {
      try {
        const delPath = type === 'event' ? `/me/events/${id}` : `/me/todo/lists/${this.todoListId}/tasks/${id}`
        await this.graph(token, 'DELETE', delPath)
      } catch (err: any) {
        this.ctx.services.logger.error(`Purge remote ${type} ${id} failed:`, err?.message)
      }
      await sleep(150)
    }
    this.ctx.services.logger.info(`Purged remote ${type}: ${ids.length}`)
  }

  // ====== 同步主流程 ======

  async runSync(force = false): Promise<void> {
    const auth = getOutlookAuthService(this.ctx)
    if (this.syncing || !auth.isLoggedIn()) return
    const cfg = this.getConfig()
    if (!cfg.enabled && !force) return

    this.syncing = true
    this.broadcast()
    const result: OutlookSyncResult = { created: 0, updated: 0, deleted: 0, failed: 0, errors: [], synced_at: Math.floor(Date.now() / 1000) }
    let syncOk = false
    try {
      this.ensureMapAccount()
      const token = await auth.getAccessToken()
      if (!token) throw new Error(this.ctx.services.i18n.t('calendar.outlookSessionExpired'))

      if (cfg.sync_events) {
        this.calendarId = await this.ensureTargetCalendar(token)
        await this.syncEvents(token, result)
      }
      if (cfg.sync_todos) {
        this.todoListId = await this.ensureTodoList(token)
        await this.syncTodos(token, result)
      }
      syncOk = true
      this.saveState({ last_result: result, last_error: result.failed > 0 ? this.ctx.services.i18n.t('calendar.outlookSyncFailedCount', { count: result.failed }) : null })
      this.ctx.services.logger.info(`Sync done: +${result.created} ~${result.updated} -${result.deleted} !${result.failed}`)
    } catch (err: any) {
      this.ctx.services.logger.error('Sync failed:', err?.message)
      this.saveState({ ...this.loadState(), last_error: err?.message || this.ctx.services.i18n.t('calendar.outlookSyncFailed') })
    } finally {
      this.syncing = false
      // 失败（如 token 瞬时失效）时不更新版本指纹：数据未变时下个 tick 会重试同步，
      // 否则 runCheck 已提前记录版本、失败后永不自动重试。
      // 连续失败 ≥5 次后停止自动重试（避免对 Graph API 重试风暴），手动"立即同步"或
      // 数据再次变化时恢复
      if (syncOk) {
        this.syncFailCount = 0
        this.lastDataVersion = this.computeDataVersion()
      } else {
        this.syncFailCount++
        if (this.syncFailCount < 5) {
          this.lastDataVersion = ''
        }
      }
      this.broadcast()
    }
  }

  // ====== Graph API 请求 ======

  private async graph(token: string, method: string, path: string, body?: any): Promise<any> {
    const doFetch = async (tk: string) => fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tk}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    let resp = await doFetch(token)
    if (resp.status === 401) {
      // token 失效，刷新后重试一次
      const fresh = await getOutlookAuthService(this.ctx).getAccessToken()
      if (!fresh) throw new Error(this.ctx.services.i18n.t('calendar.outlookSessionExpired'))
      resp = await doFetch(fresh)
    }
    if (resp.status === 204) return null
    const json = resp.status === 204 ? null : await resp.json().catch(() => null)
    if (!resp.ok) {
      const detail = JSON.stringify(json?.error || json)
      this.ctx.services.logger.error(`Graph ${method} ${path} -> ${resp.status}: ${detail}`)
      const err: any = new Error(json?.error?.message || this.ctx.services.i18n.t('calendar.outlookGraphRequestFailed', { method, path, status: resp.status }))
      // 保留状态码与 Graph 错误码，供调用方按错误类型做降级处理（如重复规则冲突时删除重建）
      err.status = resp.status
      err.graphCode = json?.error?.innerError?.code || json?.error?.code
      throw err
    }
    return json
  }

  /** 确保 Outlook 侧存在名为 WorkAvatar 的日历 */
  private async ensureTargetCalendar(token: string): Promise<string> {
    const found = await this.graph(token, 'GET', `/me/calendars?$filter=${encodeURIComponent(`name eq '${TARGET_NAME}'`)}&$select=id,name`)
    if (found?.value?.length) return found.value[0].id
    const created = await this.graph(token, 'POST', '/me/calendars', { name: TARGET_NAME })
    this.ctx.services.logger.info(`Created Outlook calendar "${TARGET_NAME}"`)
    return created.id
  }

  /** 确保存在名为 WorkAvatar 的 To Do 列表 */
  private async ensureTodoList(token: string): Promise<string> {
    // 注意：/me/todo/lists 不支持 $select 投影（会返回 400 RequestBroker--ParseUri），需拉全量
    const lists = await this.graph(token, 'GET', '/me/todo/lists')
    const hit = (lists?.value || []).find((l: any) => l.displayName === TARGET_NAME)
    if (hit) return hit.id
    const created = await this.graph(token, 'POST', '/me/todo/lists', { displayName: TARGET_NAME })
    this.ctx.services.logger.info(`Created To Do list "${TARGET_NAME}"`)
    return created.id
  }

  // ====== 事件同步 ======

  private async syncEvents(token: string, result: OutlookSyncResult): Promise<void> {
    const calendar = getCalendarService(this.ctx)
    const items = calendar.listAllEvents()
    const mapRows = this.loadMap('event')
    const mapByLocal = new Map(mapRows.map(r => [r.local_id, r]))
    const localIds = new Set(items.map(i => i.id))
    // 映射全空但本地有数据：映射可能被旧版本登出逻辑清空过，先回收远端已有对象防重复创建
    const remoteIndex = !mapRows.length && items.length ? await this.loadEventIndex(token) : null

    for (const event of items) {
      const mapping = mapByLocal.get(event.id)
      const body = this.eventToGraphBody(event)
      try {
        if (!mapping) {
          const remoteId = remoteIndex
            ? this.takeRemote(remoteIndex, event.id, this.remoteKey(event.title, body.start.dateTime))
            : await this.findEventByLocalId(token, event.id)
          if (remoteId) {
            // 命中远端已有对象：PATCH 绑定（顺带补写标记，完成旧数据回填）
            await this.graph(token, 'PATCH', `/me/events/${remoteId}`, body)
            this.upsertMap('event', event.id, remoteId, event.updated_at)
            result.updated++
          } else {
            const created = await this.graph(token, 'POST', `/me/calendars/${this.calendarId}/events`, body)
            this.upsertMap('event', event.id, created.id, event.updated_at)
            result.created++
          }
        } else if (event.updated_at > mapping.synced_updated_at) {
          await this.graph(token, 'PATCH', `/me/events/${mapping.remote_id}`, body)
          this.upsertMap('event', event.id, mapping.remote_id, event.updated_at)
          result.updated++
        }
      } catch (err: any) {
        result.failed++
        this.pushError(result, `事件「${event.title}」: ${err?.message || err}`)
      }
      await sleep(150)
    }

    if (remoteIndex) await this.pruneEventRemote(token, remoteIndex, result)
    await this.syncDeletions(token, 'event', localIds, mapRows, result)
  }

  // ====== TODO 同步 ======

  /**
   * 待办同步（按 Graph To Do 实测语义建模）：
   *
   * To Do 的重复任务 = 一条「活动任务」+ 每次完成生成的「已完成副本」：
   * - 活动任务 id 在完成时保持不变，dueDateTime 由服务端推进到下一次，numbered 次数递减；
   * - 完成一次会在云端新增一条 completed 副本（历史）；
   * - 对重复任务 PATCH dueDateTime 会被服务端当成「换到另一个 occurrence」而派生新任务，
   *   这正是旧版本「每次修改云端多一条」的根因，因此重复任务永不 PATCH dueDateTime；
   * - 改期/跳过/改规则用 PATCH recurrence 改 startDate（实测可用），取消规则用 `recurrence: null`；
   * - 实测删除任务不会派生新任务。
   *
   * 因此：一条本地待办对应一条活动任务，完成历史由云端自己生成，映射 id 在完成时保持稳定。
   */
  private async syncTodos(token: string, result: OutlookSyncResult): Promise<void> {
    const calendar = getCalendarService(this.ctx)
    const items = calendar.listAllTodos()
    const mapRows = this.loadMap('todo')
    const mapByLocal = new Map(mapRows.map(r => [r.local_id, r]))
    const localIds = new Set(items.map(i => i.id))
    const localTitles = new Set(items.map(i => i.title))
    const remoteIndex = await this.loadTodoIndex(token)
    const remoteById = new Map(remoteIndex.objs.map(o => [o.id, o]))
    const claimed = new Set<string>()
    // 映射指向的远端对象一律保护（本轮 PATCH 失败也不能被当成「未认领副本」清理）
    const mappedRemoteIds = new Set(mapRows.map(r => r.remote_id))

    // 本地已删除的待办：先删远端，避免它们被当成「未认领副本」重复清理
    await this.syncDeletions(token, 'todo', localIds, mapRows, result)

    for (const todo of items) {
      const mapping = mapByLocal.get(todo.id)
      // 无到期时间的「重复」待办无法表达系列，按普通待办处理
      const rule = todo.recurrence_rule && todo.due_at != null ? todo.recurrence_rule : null
      try {
        // 重复系列在本地已结束（没有下一次）：云端不应再保留活动任务
        if (rule && todo.status === 'completed') {
          await this.finishTodoSeries(token, todo, mapping, remoteById, result)
          if (mapping) claimed.add(mapping.remote_id)
          continue
        }
        let remote = mapping ? remoteById.get(mapping.remote_id) : undefined
        if (remote && claimed.has(remote.id)) remote = undefined
        if (!remote) {
          if (mapping) this.deleteMap('todo', todo.id)
          remote = this.findTodoRemote(remoteIndex, todo)
          if (remote) this.ctx.services.logger.info(`Todo 远端对象缺失映射，回收 ${remote.id}`)
        }
        if (remote) {
          claimed.add(remote.id)

          // 遗留状态矫正：本地重复 ↔ 远端普通任务（旧版本曾只推过无规则的镜像）
          if (rule && !remote.hasRecurrence) {
            await this.patchTodoRecurrence(token, remote.id, todo)
            remote.hasRecurrence = true
            this.saveTodoMap(todo, remote.id)
            if (mapping) {
              mapping.synced_updated_at = todo.updated_at
              mapping.synced_due = todo.due_at
              mapping.synced_rule = this.todoRuleKey(rule)
            }
            result.updated++
          } else if (!rule && remote.hasRecurrence) {
            await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remote.id}`, { recurrence: null })
            remote.hasRecurrence = false
            result.updated++
          }

          if (!mapping || todo.updated_at !== mapping.synced_updated_at) {
            const effectiveId = rule
              ? await this.pushTodoRecurringChange(token, todo, mapping, remote, remoteIndex, result)
              : await this.patchPlainTodo(token, remote.id, todo, result)
            this.saveTodoMap(todo, effectiveId)
            claimed.add(effectiveId)
          }
          if (!remote.localId && remoteIndex.withExtensions && (!mapping || mapping.remote_id !== remote.id)) {
            await this.writeTodoMarker(token, remote.id, todo.id)
          }
          continue
        }
        const created = await this.graph(token, 'POST', `/me/todo/lists/${this.todoListId}/tasks`, this.todoToGraphBody(todo))
        claimed.add(created.id)
        this.saveTodoMap(todo, created.id)
        if (remoteIndex.withExtensions) await this.writeTodoMarker(token, created.id, todo.id)
        result.created++
      } catch (err: any) {
        if (err?.status === 404 && mapping) this.deleteMap('todo', todo.id)
        result.failed++
        this.pushError(result, `待办「${todo.title}」: ${err?.message || err}`)
      }
      await sleep(150)
    }

    await this.pruneTodoRemote(token, remoteIndex, claimed, mappedRemoteIds, localTitles, result)
  }

  /** 删除远端待办（404 视为已不存在） */
  private async deleteTodoRemote(token: string, remoteId: string): Promise<void> {
    try {
      await this.graph(token, 'DELETE', `/me/todo/lists/${this.todoListId}/tasks/${remoteId}`)
    } catch (err: any) {
      if (err?.status !== 404) throw err
    }
  }

  /** 普通（非重复）待办字段更新：允许带 dueDateTime */
  private async patchPlainTodo(token: string, remoteId: string, todo: CalendarTodo, result: OutlookSyncResult): Promise<string> {
    await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remoteId}`, this.todoToGraphBody(todo))
    result.updated++
    return remoteId
  }

  /**
   * 重复待办推送：规则变更 / 完成推进 / 撤销完成 / 改期跳过，全部避免 PATCH dueDateTime。
   * 返回最终有效的远端活动任务 id（撤销完成时可能改绑到复活的完成副本）。
   */
  private async pushTodoRecurringChange(
    token: string,
    todo: CalendarTodo,
    mapping: any,
    remote: RemoteObj,
    idx: RemoteIndex,
    result: OutlookSyncResult,
  ): Promise<string> {
    const rule = todo.recurrence_rule!
    const due = todo.due_at!
    const prevDue: number | null = mapping?.synced_due ?? null
    const ruleChanged = !mapping || mapping.synced_rule !== this.todoRuleKey(rule)

    if (ruleChanged) {
      await this.patchTodoRecurrence(token, remote.id, todo)
      result.updated++
      return remote.id
    }

    if (prevDue != null && due > prevDue) {
      // 本地完成了若干次实例：云端同样「完成」对应次数，由服务端推进活动任务并生成完成副本
      const done = (rule.overrides ?? [])
        .filter(o => o.status === 'completed' && o.recurrence_id >= prevDue && o.recurrence_id < due)
        .sort((a, b) => a.recurrence_id - b.recurrence_id)
      if (done.length > 0) {
        let last: any = null
        for (const o of done) {
          last = await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remote.id}`, {
            title: todo.title,
            body: { contentType: 'text', content: todo.description || '' },
            importance: todo.priority === 'high' ? 'high' : todo.priority === 'low' ? 'low' : 'normal',
            status: 'completed',
            completedDateTime: this.toGraphDateTime(o.completed_at ?? todo.updated_at, todo.tzid),
          })
          result.updated++
        }
        // numbered 次数用尽时服务端会清掉规则：恢复成本地规则，避免云端系列意外终止
        if (last && !last.recurrence) await this.patchTodoRecurrence(token, remote.id, todo)
        return remote.id
      }
      // 没有完成记录却前移：本地改期/跳过本次 → 用 startDate 重锚，避免服务端派生新任务
      await this.patchTodoRecurrence(token, remote.id, todo)
      result.updated++
      return remote.id
    }

    if (prevDue != null && due < prevDue) {
      // 撤销完成：优先复活该次 occurrence 的已完成副本，否则把系列锚点移回
      const reopenedId = await this.reopenTodoOccurrence(token, todo, remote, idx, result)
      if (reopenedId) return reopenedId
      await this.patchTodoRecurrence(token, remote.id, todo)
      result.updated++
      return remote.id
    }

    // 仅字段变化（标题/描述/优先级/提醒/状态）
    await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remote.id}`, this.todoFieldsBody(todo))
    result.updated++
    return remote.id
  }

  /** 撤销完成：把该次 occurrence 的已完成副本复活为活动任务，并删除原活动任务 */
  private async reopenTodoOccurrence(
    token: string,
    todo: CalendarTodo,
    live: RemoteObj,
    idx: RemoteIndex,
    result: OutlookSyncResult,
  ): Promise<string | null> {
    const dueDate = this.localDateStr(todo.due_at!, todo.tzid)
    const copy = idx.objs.find(o =>
      o.id !== live.id
      && o.status === 'completed'
      && o.title === todo.title
      && this.remoteObjDate(o, todo.tzid) === dueDate,
    )
    if (!copy) return null
    await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${copy.id}`, {
      ...this.todoFieldsBody(todo),
      status: 'notStarted',
      completedDateTime: null,
    })
    await this.deleteTodoRemote(token, live.id)
    if (!copy.hasRecurrence) await this.patchTodoRecurrence(token, copy.id, todo)
    result.updated++
    return copy.id
  }

  /** 重复系列结束时清理：完成最后一次（保留云端完成历史）→ 清规则 → 删除活动任务 */
  private async finishTodoSeries(
    token: string,
    todo: CalendarTodo,
    mapping: any,
    remoteById: Map<string, RemoteObj>,
    result: OutlookSyncResult,
  ): Promise<void> {
    if (!mapping) return
    const remote = remoteById.get(mapping.remote_id)
    if (!remote) {
      this.deleteMap('todo', todo.id)
      return
    }
    if (todo.updated_at !== mapping.synced_updated_at) {
      // 本次刚刚完成最后一次：先完成活动任务，保留云端完成副本
      const overrides = (todo.recurrence_rule?.overrides ?? [])
        .filter(o => o.status === 'completed')
        .sort((a, b) => a.recurrence_id - b.recurrence_id)
      const last = overrides[overrides.length - 1]
      const resp = await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remote.id}`, {
        status: 'completed',
        completedDateTime: this.toGraphDateTime(last?.completed_at ?? todo.updated_at, todo.tzid),
      })
      result.updated++
      // 服务端已把活动任务标记为完成（没有下一次）：保留该完成记录，只解除映射
      if (resp?.status === 'completed') {
        this.deleteMap('todo', todo.id)
        return
      }
    }
    // 清除规则后删除活动任务，避免云端继续派生下一次
    await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remote.id}`, { recurrence: null })
    await this.deleteTodoRemote(token, remote.id)
    this.deleteMap('todo', todo.id)
  }

  /** 规则指纹（不含 overrides/rdates：完成实例不应被视为规则变更） */
  private todoRuleKey(rule: RecurrenceRule): string {
    return JSON.stringify({
      freq: rule.freq, interval: rule.interval, count: rule.count, until: rule.until,
      byday: rule.byday, bymonthday: rule.bymonthday, bymonth: rule.bymonth, bysetpos: rule.bysetpos,
    })
  }

  /** numbered 规则的剩余次数：总次数 - 当前到期之前的实例（完成/跳过都会消耗次数） */
  private todoRemainingCount(todo: CalendarTodo): number | undefined {
    const rule = todo.recurrence_rule
    if (!rule?.count || !todo.due_at) return undefined
    const dueDate = this.localDateStr(todo.due_at, todo.tzid)
    const consumed = (rule.overrides ?? []).filter(o => this.localDateStr(o.recurrence_id, todo.tzid) < dueDate).length
    return Math.max(1, rule.count - consumed)
  }

  /** 本地 unix 秒 → 本地时区日期 YYYY-MM-DD */
  private localDateStr(unixSec: number, tzid?: string): string {
    return this.toGraphDateTime(unixSec, tzid || '', true).dateTime
  }

  /** 远端 dueDateTime → 本地时区日期（UTC 值需换算；Windows 时区名的 dateTime 已是当地时间） */
  private remoteObjDate(obj: RemoteObj, tzid?: string): string {
    if (!obj.dueDateTime) return ''
    const zone = obj.dueTimeZone || 'UTC'
    if (zone.toUpperCase() === 'UTC') {
      const sec = Math.floor(Date.parse(obj.dueDateTime.endsWith('Z') ? obj.dueDateTime : `${obj.dueDateTime}Z`) / 1000)
      return Number.isFinite(sec) ? this.localDateStr(sec, tzid) : ''
    }
    return obj.dueDateTime.slice(0, 10)
  }

  /** 映射丢失时回收既有活动任务：先扩展标记，再标题+截止时间，最后标题 */
  private findTodoRemote(idx: RemoteIndex, todo: CalendarTodo): RemoteObj | undefined {
    const dueKey = todo.due_at ? this.toGraphDateTime(todo.due_at, todo.tzid).dateTime : undefined
    const fuzzyKey = this.remoteKey(todo.title, dueKey)
    const pickLive = (arr?: RemoteObj[]) => arr?.find(o => !o.used && o.status !== 'completed')
    const marked = pickLive(idx.byMarker.get(todo.id))
    if (marked) { marked.used = true; return marked }
    const fuzzy = pickLive(idx.byFuzzy.get(fuzzyKey))
    if (fuzzy) { fuzzy.used = true; return fuzzy }
    const byTitle = idx.objs.find(o => !o.used && o.status !== 'completed' && o.title === todo.title)
    if (byTitle) { byTitle.used = true; return byTitle }
    return undefined
  }

  /** 重复待办：字段 + recurrence（startDate 取当前到期日，改期/改规则时活动任务一并重锚） */
  private async patchTodoRecurrence(token: string, remoteId: string, todo: CalendarTodo): Promise<void> {
    const path = `/me/todo/lists/${this.todoListId}/tasks/${remoteId}`
    const fields = this.todoFieldsBody(todo)
    const recurrence = this.todoRecurrence(todo) ?? null
    try {
      await this.graph(token, 'PATCH', path, { ...fields, recurrence })
    } catch (err: any) {
      // 部分租户不支持 endDate（until）等 range 变体：退化为 noEnd，保证规则/改期仍能落地
      const startDate = recurrence?.range?.startDate
      if (err?.status !== 400 || !startDate) throw err
      await this.graph(token, 'PATCH', path, {
        ...fields,
        recurrence: { pattern: recurrence.pattern, range: { type: 'noEnd', startDate } },
      })
    }
  }

  /** 本地重复规则 → Graph recurrence；numbered 使用剩余次数 */
  private todoRecurrence(todo: CalendarTodo): any {
    if (!todo.recurrence_rule || !todo.due_at) return undefined
    return this.ruleToGraphRecurrence(todo.recurrence_rule, todo.due_at, todo.tzid, this.todoRemainingCount(todo))
  }

  /** 重复待办可安全 PATCH 的字段（绝不含 dueDateTime） */
  private todoFieldsBody(todo: CalendarTodo): any {
    const body: any = {
      title: todo.title,
      body: { contentType: 'text', content: todo.description || '' },
      importance: todo.priority === 'high' ? 'high' : todo.priority === 'low' ? 'low' : 'normal',
      status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'inProgress' : 'notStarted',
    }
    if (todo.reminders?.length && todo.due_at) {
      const offsetMin = this.isAllDayTodo(todo)
        ? Math.min(...todo.reminders.map(r => Math.abs(r)))
        : 0
      const remindAt = todo.due_at - offsetMin * 60
      if (remindAt > Math.floor(Date.now() / 1000)) {
        body.isReminderOn = true
        body.reminderDateTime = this.toGraphDateTime(remindAt, todo.tzid)
      } else {
        body.isReminderOn = false
      }
    } else {
      body.isReminderOn = false
    }
    return body
  }

  /** 写入回指本地 id 的开放扩展；失败仅记日志（映射表仍是权威绑定） */
  private async writeTodoMarker(token: string, remoteId: string, localId: string): Promise<void> {
    if (this.markerAttempted.has(remoteId)) return
    this.markerAttempted.add(remoteId)
    try {
      await this.graph(token, 'POST', `/me/todo/lists/${this.todoListId}/tasks/${remoteId}/extensions`, {
        '@odata.type': 'microsoft.graph.openTypeExtension',
        extensionName: TODO_EXT_NAME,
        localId,
      })
    } catch (err: any) {
      this.ctx.services.logger.warn(`Todo marker write failed ${remoteId}:`, err?.message)
    }
  }

  /** 映射中存在但本地已删除的记录 → 删除远端对象 */
  private async syncDeletions(token: string, type: 'event' | 'todo', localIds: Set<string>, mapRows: any[], result: OutlookSyncResult): Promise<void> {
    for (const mapping of mapRows) {
      if (localIds.has(mapping.local_id)) continue
      try {
        const path = type === 'event'
          ? `/me/events/${mapping.remote_id}`
          : `/me/todo/lists/${this.todoListId}/tasks/${mapping.remote_id}`
        await this.graph(token, 'DELETE', path)
        this.deleteMap(type, mapping.local_id)
        result.deleted++
      } catch (err: any) {
        // 远端已被用户手工删除：映射同样失效，直接清掉
        if (err?.status === 404) {
          this.deleteMap(type, mapping.local_id)
        } else {
          result.failed++
          this.pushError(result, `删除${type === 'event' ? '事件' : '待办'} ${mapping.local_id}: ${err?.message || err}`)
        }
      }
      await sleep(150)
    }
  }

  private pushError(result: OutlookSyncResult, msg: string): void {
    if (result.errors.length < 5) result.errors.push(msg)
  }

  // ====== 映射回收 ======

  /** 去重键：标题 + 日期 + 时间（兼容全天事件的纯日期与 Graph 返回的毫秒尾巴） */
  private remoteKey(title: string, dateTime?: string): string {
    const dt = dateTime || ''
    return `${title}\u0000${dt.slice(0, 10)}\u0000${dt.slice(11, 19) || '00:00:00'}`
  }

  /** 分页拉取目标日历的全部事件：带标记的进 byMarker，其余进 byFuzzy 兜底 */
  private async loadEventIndex(token: string): Promise<RemoteIndex> {
    const idx: RemoteIndex = { objs: [], byMarker: new Map(), byFuzzy: new Map() }
    let path: string | null =
      `/me/calendars/${this.calendarId}/events?$select=id,subject,start,categories&$expand=singleValueExtendedProperties($filter=id eq '${LOCAL_ID_PROP}')`
    while (path) {
      const json = await this.graph(token, 'GET', path)
      for (const item of json?.value || []) {
        // 仅纳入本插件推送过的（带 WorkAvatar 分类），避免误伤日历里手工创建的日程
        if (!(item.categories || []).includes(TARGET_NAME)) continue
        const title = item.subject || ''
        const obj: RemoteObj = {
          id: item.id,
          localId: item.singleValueExtendedProperties?.[0]?.value || undefined,
          key: this.remoteKey(title, item.start?.dateTime),
          used: false,
        }
        idx.objs.push(obj)
        if (obj.localId) this.pushTo(idx.byMarker, obj.localId, obj)
        else this.pushTo(idx.byFuzzy, obj.key, obj)
      }
      const next: string | undefined = json?.['@odata.nextLink']
      path = next?.startsWith(GRAPH_BASE) ? next.slice(GRAPH_BASE.length) : null
    }
    return idx
  }

  /** 分页拉取目标待办列表；优先带 extensions 以便按本地 id 精确回收，租户不支持时回退普通列表 */
  private async loadTodoIndex(token: string): Promise<RemoteIndex> {
    try {
      return await this.loadTodoPages(token, true)
    } catch (err: any) {
      if (err?.status !== 400) throw err
      this.ctx.services.logger.warn('Todo list $expand=extensions unsupported, fallback to plain list')
      return await this.loadTodoPages(token, false)
    }
  }

  private async loadTodoPages(token: string, withExtensions: boolean): Promise<RemoteIndex> {
    const idx: RemoteIndex = { objs: [], byMarker: new Map(), byFuzzy: new Map(), withExtensions }
    let path: string | null = withExtensions
      ? `/me/todo/lists/${this.todoListId}/tasks?$expand=extensions`
      // 显式 select 保留 recurrence/status/due：识别旧数据、完成历史与撤销完成都依赖这些字段
      : `/me/todo/lists/${this.todoListId}/tasks?$select=id,title,status,dueDateTime,recurrence`
    while (path) {
      const json = await this.graph(token, 'GET', path)
      for (const item of json?.value || []) {
        const localId = (item.extensions || []).find((e: any) => e.extensionName === TODO_EXT_NAME)?.localId
        const obj: RemoteObj = {
          id: item.id,
          localId,
          key: this.remoteKey(item.title || '', item.dueDateTime?.dateTime),
          title: item.title || '',
          hasRecurrence: !!item.recurrence,
          status: item.status,
          dueDateTime: item.dueDateTime?.dateTime,
          dueTimeZone: item.dueDateTime?.timeZone,
          used: false,
        }
        idx.objs.push(obj)
        if (obj.localId) this.pushTo(idx.byMarker, obj.localId, obj)
        else this.pushTo(idx.byFuzzy, obj.key, obj)
      }
      const next: string | undefined = json?.['@odata.nextLink']
      path = next?.startsWith(GRAPH_BASE) ? next.slice(GRAPH_BASE.length) : null
    }
    return idx
  }

  private pushTo(map: Map<string, RemoteObj[]>, key: string, obj: RemoteObj): void {
    const arr = map.get(key)
    if (arr) arr.push(obj)
    else map.set(key, [obj])
  }

  /** 取可绑定的远端对象：先按标记精确匹配，再按去重键模糊匹配（fuzzyKey 省略则只认标记） */
  private takeRemote(idx: RemoteIndex, localId: string, fuzzyKey?: string): string | undefined {
    const pick = (arr?: RemoteObj[]) => {
      const hit = arr?.find(o => !o.used)
      if (hit) hit.used = true
      return hit
    }
    return pick(idx.byMarker.get(localId))?.id ?? pick(fuzzyKey ? idx.byFuzzy.get(fuzzyKey) : undefined)?.id
  }

  /** 映射未空时按标记精确找回单个远端事件（To Do 不支持服务端过滤，走 loadTodoIndex 客户端匹配） */
  private async findEventByLocalId(token: string, localId: string): Promise<string | null> {
    const escaped = localId.replace(/'/g, "''")
    const filter = encodeURIComponent(`singleValueExtendedProperties/any(ep: ep/id eq '${LOCAL_ID_PROP}' and ep/value eq '${escaped}')`)
    const json = await this.graph(token, 'GET', `/me/calendars/${this.calendarId}/events?$filter=${filter}&$select=id`)
    return json?.value?.[0]?.id ?? null
  }

  /** 回收后清理远端残留事件：未匹配到本地对象的副本（重复项 / 本地已删除） */
  private async pruneEventRemote(token: string, idx: RemoteIndex, result: OutlookSyncResult): Promise<void> {
    for (const obj of idx.objs) {
      if (obj.used) continue
      try {
        await this.graph(token, 'DELETE', `/me/events/${obj.id}`)
        result.deleted++
      } catch (err: any) {
        result.failed++
        this.pushError(result, `清理远端事件: ${err?.message || err}`)
      }
      await sleep(150)
    }
  }

  /**
   * 清理待办列表中的历史副本：只删「确定属于本插件」（开放扩展标记）或「与本地待办同名」
   * 的未认领对象，避免误删用户手工添加到该列表的任务。映射指向的对象一律不清理。
   */
  private async pruneTodoRemote(
    token: string,
    idx: RemoteIndex,
    claimed: Set<string>,
    mappedRemoteIds: Set<string>,
    localTitles: Set<string>,
    result: OutlookSyncResult,
  ): Promise<void> {
    for (const obj of idx.objs) {
      if (claimed.has(obj.id) || mappedRemoteIds.has(obj.id)) continue
      // completed 是重复系列的完成历史，不是重复项
      if (obj.status === 'completed') continue
      if (!obj.localId && !localTitles.has(obj.title || '')) continue
      try {
        await this.deleteTodoRemote(token, obj.id)
        result.deleted++
      } catch (err: any) {
        result.failed++
        this.pushError(result, `清理远端待办: ${err?.message || err}`)
      }
      await sleep(150)
    }
  }

  // ====== 映射表操作 ======

  private loadMap(type: 'event' | 'todo'): any[] {
    return this.db.prepare('SELECT * FROM calendar_sync_map WHERE target = ? AND local_type = ?').all('outlook', type)
  }

  private upsertMap(
    type: 'event' | 'todo',
    localId: string,
    remoteId: string,
    syncedUpdatedAt: number,
    syncedDue: number | null = null,
    syncedRule: string | null = null,
  ): void {
    this.db.prepare(
      `INSERT INTO calendar_sync_map (target, local_type, local_id, remote_id, synced_updated_at, synced_due, synced_rule, synced_at)
       VALUES ('outlook', ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(target, local_type, local_id) DO UPDATE SET remote_id = excluded.remote_id, synced_updated_at = excluded.synced_updated_at,
         synced_due = excluded.synced_due, synced_rule = excluded.synced_rule, synced_at = excluded.synced_at`
    ).run(type, localId, remoteId, syncedUpdatedAt, syncedDue, syncedRule)
  }

  /** 记录待办「已推送到的本地快照」：更新用于判变更，due/rule 用于判定完成推进、撤销与规则变更 */
  private saveTodoMap(todo: CalendarTodo, remoteId: string): void {
    this.upsertMap(
      'todo', todo.id, remoteId, todo.updated_at,
      todo.due_at, todo.recurrence_rule ? this.todoRuleKey(todo.recurrence_rule) : null,
    )
  }

  private deleteMap(type: 'event' | 'todo', localId: string): void {
    this.db.prepare('DELETE FROM calendar_sync_map WHERE target = ? AND local_type = ? AND local_id = ?').run('outlook', type, localId)
  }

  // ====== 字段转换 ======

  private get systemTz(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  }

  /** unix 秒 → Graph dateTimeTimeZone。全天事件用纯日期(YYYY-MM-DD)，否则 YYYY-MM-DDTHH:mm:ss */
  private toGraphDateTime(unixSec: number, tzid: string, allDay = false): { dateTime: string; timeZone: string } {
    const tz = tzid || this.systemTz
    const d = new Date(unixSec * 1000)
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value || '00'
    const dateStr = `${get('year')}-${get('month')}-${get('day')}`
    if (allDay) return { dateTime: dateStr, timeZone: tz }
    return { dateTime: `${dateStr}T${get('hour')}:${get('minute')}:${get('second')}`, timeZone: tz }
  }

  private reminderToGraph(reminders: number[]): { isReminderOn: boolean; reminderMinutesBeforeStart?: number } {
    if (!reminders?.length) return { isReminderOn: false }
    // Graph 事件仅支持单个提醒，取最早（绝对值最大）的一个；上限 20160 分钟（14 天）
    const minutes = Math.min(Math.max(...reminders.map(r => Math.abs(r))), 20160)
    return { isReminderOn: true, reminderMinutesBeforeStart: minutes }
  }

  /** TODO 是否「全天」（未指定具体时间）：UI 未填截止时间时默认落到当天 23:59 */
  private isAllDayTodo(todo: CalendarTodo): boolean {
    if (!todo.due_at) return false
    return this.toGraphDateTime(todo.due_at, todo.tzid).dateTime.endsWith('T23:59:00')
  }

  /**
   * 本地 RecurrenceRule → Graph patternedRecurrence。
   * bysetpos / rdates / 多值 bymonthday、实例级 overrides（单实例取消/修改）不精细同步，仅同步主规则。
   * remainingCount：重复待办按「剩余次数」下发（云端会随完成递减），事件传 undefined 用总次数。
   */
  private ruleToGraphRecurrence(rule: RecurrenceRule, startSec: number, tzid: string, remainingCount?: number): any {
    const tz = tzid || this.systemTz
    const startDate = this.toGraphDateTime(startSec, tz, true).dateTime
    const dayOfMonth = Number(startDate.slice(8, 10))
    const month = Number(startDate.slice(5, 7))
    // Graph 的 absoluteMonthly 不接受负数（最后一天用 -1），越界时回退到开始日
    const ruleDay = rule.bymonthday?.[0]
    const graphDay = ruleDay && ruleDay > 0 ? ruleDay : dayOfMonth

    let pattern: any
    switch (rule.freq) {
      case 'daily':
        pattern = { type: 'daily', interval: rule.interval }
        break
      case 'weekly': {
        const days = rule.byday?.length
          ? rule.byday.map(d => BYDAY_MAP[d]).filter(Boolean)
          : [new Date(startSec * 1000).toLocaleString('en-US', { timeZone: tz, weekday: 'long' }).toLowerCase()]
        pattern = { type: 'weekly', interval: rule.interval, daysOfWeek: days }
        break
      }
      case 'monthly':
        pattern = { type: 'absoluteMonthly', interval: rule.interval, dayOfMonth: graphDay }
        break
      case 'yearly':
        pattern = { type: 'absoluteYearly', interval: rule.interval, dayOfMonth: graphDay, month: rule.bymonth?.[0] ?? month }
        break
      default:
        return undefined
    }

    let range: any
    const count = remainingCount ?? rule.count
    if (count) {
      range = { type: 'numbered', startDate, numberOfOccurrences: count }
    } else if (rule.until) {
      // rule.until 为 unix 秒，直接传给 toGraphDateTime（其内部 ×1000 转毫秒）；
      // 误乘 1000 会得到 ~1e15 的“秒” → endDate 落到公元数万年 → Graph 报 ErrorRecurrenceEndDateTooBig
      const endDate = this.toGraphDateTime(rule.until, tz, true).dateTime
      // Graph 要求 startDate <= endDate；截至日早于开始日说明规则已失效，不同步主规则
      if (endDate < startDate) return undefined
      range = { type: 'endDate', startDate, endDate }
    } else {
      range = { type: 'noEnd', startDate }
    }
    return { pattern, range }
  }

  private eventToGraphBody(event: CalendarEvent): any {
    const tz = event.tzid
    const start = this.toGraphDateTime(event.start_at, tz, event.all_day)
    let end = this.toGraphDateTime(event.end_at, tz, event.all_day)
    if (event.all_day) {
      // 全天事件 end 必须 strict 大于 start（纯日期比较，至少 +1 天）
      if (end.dateTime <= start.dateTime) end.dateTime = this.addDays(start.dateTime, 1)
    } else if (event.end_at <= event.start_at) {
      // 异常数据：end 早于 start，兜底为开始后 1 分钟
      end = this.toGraphDateTime(event.start_at + 60, tz)
    }
    const body: any = {
      subject: event.title,
      body: { contentType: 'text', content: event.description || '' },
      start,
      end,
      isAllDay: event.all_day,
      categories: [TARGET_NAME],
      singleValueExtendedProperties: [{ id: LOCAL_ID_PROP, value: event.id }],
      ...this.reminderToGraph(event.reminders),
    }
    const recurrence = event.recurrence_rule ? this.ruleToGraphRecurrence(event.recurrence_rule, event.start_at, tz) : undefined
    if (recurrence) body.recurrence = recurrence
    return body
  }

  /** 'YYYY-MM-DD' 纯日期 +N 天（UTC 计算避免时区偏移） */
  private addDays(dateStr: string, days: number): string {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }

  /**
   * 本地待办 → Graph todoTask（新建 / 非重复待办的整条更新）。
   * 重复待办新建时同样带 recurrence；后续更新走 pushTodoRecurringChange，绝不 PATCH dueDateTime。
   */
  private todoToGraphBody(todo: CalendarTodo): any {
    const tz = todo.tzid
    const importance = todo.priority === 'high' ? 'high' : todo.priority === 'low' ? 'low' : 'normal'
    const status = todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'inProgress' : 'notStarted'
    const body: any = {
      title: todo.title,
      body: { contentType: 'text', content: todo.description || '' },
      importance,
      status,
    }
    if (todo.due_at) body.dueDateTime = this.toGraphDateTime(todo.due_at, tz)
    // Graph 要求 completedDateTime 仅当 status=completed 时存在，否则 400
    if (todo.status === 'completed' && todo.completed_at) body.completedDateTime = this.toGraphDateTime(todo.completed_at, tz)

    // To Do 提醒（Graph 仅支持单个、以绝对时刻表示）：时间对齐到「到期时间」。
    // 「全天」（未填具体时间，UI 默认当天 23:59）没有有效时刻，退化为取最晚的一个本地提醒时刻；
    // 提醒时刻已过去则不设置。
    if (todo.reminders?.length && todo.due_at) {
      const offsetMin = this.isAllDayTodo(todo)
        ? Math.min(...todo.reminders.map(r => Math.abs(r)))
        : 0
      const remindAt = todo.due_at - offsetMin * 60
      if (remindAt > Math.floor(Date.now() / 1000)) {
        body.isReminderOn = true
        body.reminderDateTime = this.toGraphDateTime(remindAt, tz)
      }
    }
    const recurrence = this.todoRecurrence(todo)
    if (recurrence) body.recurrence = recurrence
    return body
  }
}

let _instance: OutlookSyncService | null = null

export function getOutlookSyncService(ctx?: PluginContext): OutlookSyncService {
  if (!_instance) {
    if (!ctx) throw new Error('OutlookSyncService 未初始化：缺少 PluginContext')
    _instance = new OutlookSyncService(ctx)
  }
  return _instance
}

export default getOutlookSyncService
