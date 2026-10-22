/**
 * AI 助手集 —— 预置站点、自定义网页与共享状态模型（主进程 / 渲染端共用）。
 *
 * ⚠️ 新增内置站点时必须同步在 `manifest.json` 的 `capabilities[webview].origins`
 * 里补上该站点域名（支持 `*.example.com` 通配，恒 https），否则宿主的
 * `will-attach-webview` 守卫会拒绝内嵌，页面将停在加载中。
 *
 * 用户自定义网页不写进 manifest，而是由主进程在布局变更时经
 * `ctx.webview.allowOrigins` 注册到宿主的运行时白名单（需 manifest 声明
 * `webview.allowUserOrigins: true`）。
 */

export interface AiWebSite {
  /** 站点 id，同时作为 webview partition 后缀（前缀见 webview.ts 的 PARTITION_PREFIX） */
  id: string
  /** 展示名 */
  name: string
  /** 站点首页 */
  url: string
  /** 站点识别色：用于图标圆点与标签页激活态，明暗主题下均可辨识 */
  color: string
  /** 用户自定义网页（可增删，域名走宿主运行时白名单） */
  custom?: boolean
}

/**
 * 统一的桌面 Chrome User-Agent。
 *
 * 必要性（实测结论）：DeepSeek 会做客户端运行环境检测，识别到 UA 中的
 * Electron 特征时会弹出「使用环境异常，建议使用官方产品」并拒绝服务；
 * 伪装成普通桌面 Chrome 后登录页正常可用。豆包等其他站点使用该 UA 亦正常。
 */
export const WEBVIEW_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const AI_WEB_SITES: AiWebSite[] = [
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/', color: '#4E6EF2' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', color: '#8B5CF6' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/', color: '#EC4899' },
  { id: 'qwen', name: '通义千问', url: 'https://www.qianwen.com/', color: '#6366F1' },
  { id: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn/', color: '#14B8A6' },
  { id: 'ernie', name: '文心一言', url: 'https://yiyan.baidu.com/', color: '#3B82F6' },
  { id: 'yuanbao', name: '腾讯元宝', url: 'https://yuanbao.tencent.com/', color: '#F59E0B' },
  { id: 'metaso', name: '秘塔', url: 'https://metaso.cn/', color: '#06B6D4' },
  { id: 'spark', name: '讯飞星火', url: 'https://xinghuo.xfyun.cn/', color: '#EF4444' },
]

/** 自定义网页数量上限：避免无限堆积域名与常驻 guest 占用内存 */
export const MAX_CUSTOM_SITES = 20

/** 自定义网页取色板（明暗主题下均可辨识） */
const CUSTOM_SITE_COLORS = [
  '#0EA5E9',
  '#8B5CF6',
  '#F97316',
  '#10B981',
  '#EC4899',
  '#EAB308',
  '#6366F1',
  '#14B8A6',
]

export function isBuiltinSiteId(id: string): boolean {
  return AI_WEB_SITES.some((site) => site.id === id)
}

/** 在内置站点与自定义网页中查找站点 */
export function getSiteById(
  id: string | null | undefined,
  customSites: AiWebSite[] = []
): AiWebSite | undefined {
  if (!id) return undefined
  return AI_WEB_SITES.find((site) => site.id === id) ?? customSites.find((site) => site.id === id)
}

/** 全部可选站点（内置 + 自定义，后者按用户添加顺序） */
export function resolveAllSites(customSites: AiWebSite[] = []): AiWebSite[] {
  return [...AI_WEB_SITES, ...customSites]
}

/** 生成自定义网页 id：随机后缀让 webview partition 互不复用，避免继承已删除站点的登录态 */
export function createCustomSiteId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 由域名稳定派生识别色，同一网站每次添加颜色一致 */
export function customSiteColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return CUSTOM_SITE_COLORS[hash % CUSTOM_SITE_COLORS.length]
}

export type CustomSiteUrlResult =
  | { ok: true; url: string; hostname: string }
  | { ok: false; reason: 'empty' | 'protocol' | 'invalid' }

/**
 * 解析并规范化用户输入的网址：缺省协议补 https，仅接受 https（宿主内嵌守卫只放行 https）。
 */
export function parseCustomSiteUrl(raw: string): CustomSiteUrlResult {
  const input = raw.trim()
  if (!input) return { ok: false, reason: 'empty' }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'protocol' }
  if (!parsed.hostname) return { ok: false, reason: 'invalid' }
  return { ok: true, url: parsed.toString(), hostname: parsed.hostname.toLowerCase() }
}

/** 网址归一化键：用于自定义网页查重（忽略末尾斜杠、锚点与主机名大小写） */
export function siteUrlKey(raw: string): string {
  try {
    const parsed = new URL(raw)
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.hostname.toLowerCase()}${path}${parsed.search}`
  } catch {
    return raw.trim()
  }
}

/** 归一化从 KV 读回的自定义网页列表，过滤非法项并按域名去重 */
export function normalizeCustomSites(raw: unknown): AiWebSite[] {
  if (!Array.isArray(raw)) return []
  const out: AiWebSite[] = []
  const ids = new Set<string>()
  const keys = new Set<string>()

  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_SITES) break
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id.trim() : ''
    if (!id.startsWith('custom-') || isBuiltinSiteId(id) || ids.has(id)) continue

    const parsed: CustomSiteUrlResult =
      typeof obj.url === 'string'
        ? parseCustomSiteUrl(obj.url)
        : { ok: false, reason: 'invalid' }
    if (!parsed.ok) continue

    const key = siteUrlKey(parsed.url)
    if (keys.has(key)) continue

    const rawName = typeof obj.name === 'string' ? obj.name.trim() : ''
    const color =
      typeof obj.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.color)
        ? obj.color
        : customSiteColor(parsed.hostname)

    ids.add(id)
    keys.add(key)
    out.push({
      id,
      name: (rawName || parsed.hostname).slice(0, 40),
      url: parsed.url,
      color,
      custom: true,
    })
  }
  return out
}

/** 视图模式：单栏 / 双栏 / 多标签页 */
export type AiWebLayoutMode = 'single' | 'split' | 'tabs'

export const LAYOUT_MODES: AiWebLayoutMode[] = ['single', 'split', 'tabs']

export function isLayoutMode(value: unknown): value is AiWebLayoutMode {
  return typeof value === 'string' && (LAYOUT_MODES as string[]).includes(value)
}

/** 标签页模式下单个标签页的状态 */
export interface AiWebTab {
  /** 稳定标识，仅用于 React key 与激活判定 */
  id: string
  siteId: string
}

/** 页面状态（持久化到插件 KV） */
export interface AiWebLayout {
  mode: AiWebLayoutMode
  /** 单栏/双栏各自承载的站点（双栏取前两项，null 表示空栏） */
  panes: [string | null, string | null]
  /** 标签页模式下打开的标签页 */
  tabs: AiWebTab[]
  /** 标签页模式下当前激活的标签页 id */
  activeTabId: string | null
  /** 站点选择菜单中出现的站点，数组顺序即菜单顺序 */
  enabledSites: string[]
  /** 用户自定义网页（与内置站点一样可切换、双栏、开标签页） */
  customSites: AiWebSite[]
}

export const DEFAULT_LAYOUT: AiWebLayout = {
  mode: 'single',
  panes: ['doubao', 'deepseek'],
  tabs: [],
  activeTabId: null,
  enabledSites: AI_WEB_SITES.map((s) => s.id),
  customSites: [],
}

export function createTabId(siteId: string): string {
  return `${siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 已启用站点（保持 enabledSites 的顺序）；空列表回退为全部可选站点 */
export function resolveEnabledSites(
  enabledSites: string[],
  customSites: AiWebSite[] = []
): AiWebSite[] {
  const list = enabledSites
    .map((id) => getSiteById(id, customSites))
    .filter((site): site is AiWebSite => site !== undefined)
  return list.length > 0 ? list : resolveAllSites(customSites)
}

/**
 * 归一化从 KV 读回的布局，防御脏数据，并兼容 v1.0.0 的 `{ split, panes }` 旧结构。
 */
export function normalizeLayout(raw: unknown): AiWebLayout {
  const fallback: AiWebLayout = {
    ...DEFAULT_LAYOUT,
    panes: [...DEFAULT_LAYOUT.panes] as [string | null, string | null],
    tabs: [],
    enabledSites: [...DEFAULT_LAYOUT.enabledSites],
    customSites: [],
  }
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>

  // 自定义网页先解析，站点 id 校验需要同时认得内置站点与自定义网页
  const customSites = normalizeCustomSites(obj.customSites)

  // 旧结构没有 mode，只有 split 布尔值
  const mode: AiWebLayoutMode = isLayoutMode(obj.mode)
    ? obj.mode
    : obj.split === true
      ? 'split'
      : 'single'

  const rawPanes = Array.isArray(obj.panes) ? obj.panes : []
  const asSiteId = (value: unknown): string | null =>
    typeof value === 'string' && getSiteById(value, customSites) ? value : null
  const panes: [string | null, string | null] = [asSiteId(rawPanes[0]), asSiteId(rawPanes[1])]

  const tabs: AiWebTab[] = []
  if (Array.isArray(obj.tabs)) {
    for (const item of obj.tabs) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const siteId = asSiteId(candidate.siteId)
      if (typeof candidate.id !== 'string' || !siteId) continue
      tabs.push({ id: candidate.id, siteId })
    }
  }

  const activeTabId =
    typeof obj.activeTabId === 'string' && tabs.some((tab) => tab.id === obj.activeTabId)
      ? obj.activeTabId
      : (tabs[0]?.id ?? null)

  const enabledRaw = Array.isArray(obj.enabledSites)
    ? obj.enabledSites.filter((value): value is string => asSiteId(value) !== null)
    : []
  const enabledSites =
    enabledRaw.length > 0
      ? Array.from(new Set(enabledRaw))
      : resolveAllSites(customSites).map((site) => site.id)

  return { mode, panes, tabs, activeTabId, enabledSites, customSites }
}

/** 从 URL 取主机名用于工具条展示（如 chat.deepseek.com），失败则原样返回 */
export function hostnameOf(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    return new URL(raw).hostname
  } catch {
    return raw
  }
}
