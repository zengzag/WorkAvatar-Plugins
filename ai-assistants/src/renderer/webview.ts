/**
 * Electron `<webview>` 元素的最小类型契约（宿主不向插件暴露 electron.d.ts）。
 * 仅声明本插件实际用到的成员。
 */
export interface WebviewElement extends HTMLElement {
  src: string
  /** 导航到指定地址；guest 未就绪时抛错 */
  loadURL(url: string, options?: Record<string, unknown>): Promise<void>
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  getURL(): string
  getTitle(): string
}

/**
 * 分区名前缀。webview 的 Cookie / LocalStorage（也就是各站点的登录态）就落在这个命名分区里。
 *
 * ⚠️ 刻意沿用历史名 `ai-web` —— 本插件改过显示名也改过 id，但分区名一旦变了，
 * 用户所有站点的登录态会立刻失效（要重新扫码/短信登录）。除非明确要求推倒重来，不要改这里。
 * 每个站点一个独立分区：站点之间互不共享 Cookie，登录互不干扰。
 */
const PARTITION_PREFIX = 'ai-web'

/** 创建并挂载一个 webview；属性必须在 appendChild 之前设置 */
export function createWebview(options: {
  src: string
  siteId: string
  userAgent: string
}): WebviewElement {
  const wv = document.createElement('webview') as WebviewElement
  // partition 决定登录态是否跨重启保留，且首次导航后不可更改，必须先于挂载设置
  wv.setAttribute('partition', `persist:${PARTITION_PREFIX}-${options.siteId}`)
  // useragent：站点运行环境检测依赖该项，详见 shared/sites.ts 的说明
  wv.setAttribute('useragent', options.userAgent)
  // allowpopups：放行站点自身的登录弹窗（微信扫码 / 短信验证等）
  wv.setAttribute('allowpopups', '')
  wv.setAttribute('src', options.src)
  wv.className = 'aiweb-view'
  return wv
}
