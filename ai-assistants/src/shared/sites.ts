/**
 * AI 助手集 —— 预置站点与共享状态模型（主进程 / 渲染端共用）。
 *
 * ⚠️ 新增站点时必须同步在 `manifest.json` 的 `capabilities[webview].origins`
 * 里补上该站点域名（支持 `*.example.com` 通配，恒 https），否则宿主的
 * `will-attach-webview` 守卫会拒绝内嵌，页面将停在加载中。
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

export function getSiteById(id: string | null | undefined): AiWebSite | undefined {
  if (!id) return undefined
  return AI_WEB_SITES.find((s) => s.id === id)
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
}

export const DEFAULT_LAYOUT: AiWebLayout = {
  mode: 'single',
  panes: ['doubao', 'deepseek'],
  tabs: [],
  activeTabId: null,
  enabledSites: AI_WEB_SITES.map((s) => s.id),
}

export function createTabId(siteId: string): string {
  return `${siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 已启用站点（保持 enabledSites 的顺序）；空列表回退为全量站点 */
export function resolveEnabledSites(enabledSites: string[]): AiWebSite[] {
  const list = enabledSites
    .map((id) => getSiteById(id))
    .filter((site): site is AiWebSite => site !== undefined)
  return list.length > 0 ? list : [...AI_WEB_SITES]
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
  }
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>

  // 旧结构没有 mode，只有 split 布尔值
  const mode: AiWebLayoutMode = isLayoutMode(obj.mode)
    ? obj.mode
    : obj.split === true
      ? 'split'
      : 'single'

  const rawPanes = Array.isArray(obj.panes) ? obj.panes : []
  const asSiteId = (value: unknown): string | null =>
    typeof value === 'string' && getSiteById(value) ? value : null
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
  const enabledSites = enabledRaw.length > 0 ? Array.from(new Set(enabledRaw)) : [...fallback.enabledSites]

  return { mode, panes, tabs, activeTabId, enabledSites }
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
