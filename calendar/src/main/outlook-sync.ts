/**
 * Outlook 单向同步引擎：本地 SQLite → Outlook（Graph API）。
 * 由宿主 outlook-sync.service.ts 迁移而来。差异点：
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
/** 远端事件回指本地 id 的单值扩展属性（Outlook 界面不可见，映射丢失后凭它精确找回）；todoTask 不支持此属性，待办仅用模糊匹配 */
const LOCAL_ID_PROP = 'String {7c1f5a8e-2b64-4d9a-9f3e-8a5d1c6b0e42} Name WorkAvatarId'

/** 远端对象：id + 回指的本地 id + 去重键 */
interface RemoteObj { id: string; localId?: string; key: string; used: boolean }
interface RemoteIndex {
  objs: RemoteObj[]
  byMarker: Map<string, RemoteObj[]>
  byFuzzy: Map<string, RemoteObj[]>
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
        synced_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_map_unique ON calendar_sync_map(target, local_type, local_id);
    `)
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
      throw new Error(json?.error?.message || this.ctx.services.i18n.t('calendar.outlookGraphRequestFailed', { method, path, status: resp.status }))
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
    const remoteIndex = !mapRows.length && items.length ? await this.loadRemoteIndex(token, 'event') : null

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

    if (remoteIndex) await this.pruneRemote(token, 'event', remoteIndex, result)
    await this.syncDeletions(token, 'event', localIds, mapRows, result)
  }

  // ====== TODO 同步 ======

  private async syncTodos(token: string, result: OutlookSyncResult): Promise<void> {
    const calendar = getCalendarService(this.ctx)
    const items = calendar.listAllTodos()
    const mapRows = this.loadMap('todo')
    const mapByLocal = new Map(mapRows.map(r => [r.local_id, r]))
    const localIds = new Set(items.map(i => i.id))
    const remoteIndex = !mapRows.length && items.length ? await this.loadRemoteIndex(token, 'todo') : null

    for (const todo of items) {
      const mapping = mapByLocal.get(todo.id)
      try {
        if (!mapping) {
          // 待办无远端标记：仅映射全空时按标题+截止时间回收，其余按新对象创建
          const remoteId = remoteIndex
            ? this.takeRemote(remoteIndex, todo.id, this.remoteKey(todo.title, todo.due_at ? this.toGraphDateTime(todo.due_at, todo.tzid).dateTime : undefined))
            : undefined
          if (remoteId) {
            // 命中已有远端任务：回写绑定（更新不发送 recurrence，见 todoToGraphBody）
            await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${remoteId}`, this.todoToGraphBody(todo, false))
            this.upsertMap('todo', todo.id, remoteId, todo.updated_at)
            result.updated++
          } else {
            const created = await this.graph(token, 'POST', `/me/todo/lists/${this.todoListId}/tasks`, this.todoToGraphBody(todo))
            this.upsertMap('todo', todo.id, created.id, todo.updated_at)
            result.created++
          }
        } else if (todo.updated_at > mapping.synced_updated_at) {
          await this.graph(token, 'PATCH', `/me/todo/lists/${this.todoListId}/tasks/${mapping.remote_id}`, this.todoToGraphBody(todo, false))
          this.upsertMap('todo', todo.id, mapping.remote_id, todo.updated_at)
          result.updated++
        }
      } catch (err: any) {
        result.failed++
        this.pushError(result, `待办「${todo.title}」: ${err?.message || err}`)
      }
      await sleep(150)
    }

    if (remoteIndex) await this.pruneRemote(token, 'todo', remoteIndex, result)
    await this.syncDeletions(token, 'todo', localIds, mapRows, result)
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
        result.failed++
        this.pushError(result, `删除${type === 'event' ? '事件' : '待办'} ${mapping.local_id}: ${err?.message || err}`)
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

  /** 分页拉取目标日历/列表的全部远端对象；事件带标记的进 byMarker，待办（无标记支持）全部进 byFuzzy 兜底 */
  private async loadRemoteIndex(token: string, type: 'event' | 'todo'): Promise<RemoteIndex> {
    const idx: RemoteIndex = { objs: [], byMarker: new Map(), byFuzzy: new Map() }
    let path: string | null = type === 'event'
      // todoTask 无 singleValueExtendedProperties 导航属性（$expand 会报 400），不能带 expand
      ? `/me/calendars/${this.calendarId}/events?$select=id,subject,start,categories&$expand=singleValueExtendedProperties($filter=id eq '${LOCAL_ID_PROP}')`
      : `/me/todo/lists/${this.todoListId}/tasks`
    while (path) {
      const json = await this.graph(token, 'GET', path)
      for (const item of json?.value || []) {
        // 事件仅纳入本插件推送过的（带 WorkAvatar 分类），避免误伤日历里手工创建的日程
        if (type === 'event' && !(item.categories || []).includes(TARGET_NAME)) continue
        const title = type === 'event' ? item.subject || '' : item.title || ''
        const dt = type === 'event' ? item.start?.dateTime : item.dueDateTime?.dateTime
        const obj: RemoteObj = {
          id: item.id,
          localId: item.singleValueExtendedProperties?.[0]?.value || undefined,
          key: this.remoteKey(title, dt),
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

  /** 映射未空时按标记精确找回单个远端事件（To Do 不支持服务端过滤，走 loadRemoteIndex 客户端匹配） */
  private async findEventByLocalId(token: string, localId: string): Promise<string | null> {
    const escaped = localId.replace(/'/g, "''")
    const filter = encodeURIComponent(`singleValueExtendedProperties/any(ep: ep/id eq '${LOCAL_ID_PROP}' and ep/value eq '${escaped}')`)
    const json = await this.graph(token, 'GET', `/me/calendars/${this.calendarId}/events?$filter=${filter}&$select=id`)
    return json?.value?.[0]?.id ?? null
  }

  /** 回收后清理远端残留：未匹配到本地对象的副本（重复项 / 本地已删除） */
  private async pruneRemote(token: string, type: 'event' | 'todo', idx: RemoteIndex, result: OutlookSyncResult): Promise<void> {
    for (const obj of idx.objs) {
      if (obj.used) continue
      try {
        const path = type === 'event'
          ? `/me/events/${obj.id}`
          : `/me/todo/lists/${this.todoListId}/tasks/${obj.id}`
        await this.graph(token, 'DELETE', path)
        result.deleted++
      } catch (err: any) {
        result.failed++
        this.pushError(result, `清理远端${type === 'event' ? '事件' : '待办'}: ${err?.message || err}`)
      }
      await sleep(150)
    }
  }

  // ====== 映射表操作 ======

  private loadMap(type: 'event' | 'todo'): any[] {
    return this.db.prepare('SELECT * FROM calendar_sync_map WHERE target = ? AND local_type = ?').all('outlook', type)
  }

  private upsertMap(type: 'event' | 'todo', localId: string, remoteId: string, syncedUpdatedAt: number): void {
    this.db.prepare(
      `INSERT INTO calendar_sync_map (target, local_type, local_id, remote_id, synced_updated_at, synced_at)
       VALUES ('outlook', ?, ?, ?, ?, unixepoch())
       ON CONFLICT(target, local_type, local_id) DO UPDATE SET remote_id = excluded.remote_id, synced_updated_at = excluded.synced_updated_at, synced_at = excluded.synced_at`
    ).run(type, localId, remoteId, syncedUpdatedAt)
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

  /**
   * 本地 RecurrenceRule → Graph patternedRecurrence。
   * bysetpos / rdates / 多值 bymonthday、实例级 overrides（单实例取消/修改）不精细同步，仅同步主规则。
   */
  private ruleToGraphRecurrence(rule: RecurrenceRule, startSec: number, tzid: string): any {
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
    if (rule.count) {
      range = { type: 'numbered', startDate, numberOfOccurrences: rule.count }
    } else if (rule.until) {
      const endDate = this.toGraphDateTime(rule.until * 1000, tz, true).dateTime
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

  private todoToGraphBody(todo: CalendarTodo, isCreate = true): any {
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

    // To Do 提醒基于截止时间；提醒时刻已过去则不设置
    if (todo.reminders?.length && todo.due_at) {
      const offsetMin = Math.max(...todo.reminders.map(r => Math.abs(r)))
      const remindAt = todo.due_at - offsetMin * 60
      if (remindAt > Math.floor(Date.now() / 1000)) {
        body.isReminderOn = true
        body.reminderDateTime = this.toGraphDateTime(remindAt, tz)
      }
    }

    // 仅在创建时发送 recurrence：To-Do 服务端无法可靠地 PATCH 更新重复规则
    //（带 range 报 Edm.Date 转换错误，空 range 报 ErrorRecurrenceEndDateTooBig），
    // 更新时省略 recurrence 以免整条 PATCH 失败，重复规则沿用远端已有值
    if (isCreate && todo.recurrence_rule && todo.due_at) {
      const recurrence = this.ruleToGraphRecurrence(todo.recurrence_rule, todo.due_at, tz)
      if (recurrence) body.recurrence = recurrence
    }
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
