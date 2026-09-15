/**
 * 单个网页栏位：精简工具条 + 内嵌 webview。
 *
 * 实现要点：webview 由 `document.createElement` 命令式创建并直接挂到容器上，
 * 全程不参与 React 协调 —— 否则任一父组件重渲染都可能重建元素，导致页面重新加载、
 * 登录态与对话上下文丢失。
 *
 * 标签页模式下多个栏位同时挂载、绝对定位堆叠，非激活栏位用 visibility 隐藏
 * （而非 display:none —— 后者会让 guest 内部尺寸归零，重新显示时不再重绘）。
 *
 * 工具条上的「关闭网页」把 guest 从容器里摘掉（销毁即释放其渲染进程占用的内存），
 * 但保留栏位与标签页本身，随时可重新打开，登录态与对话都还在。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dropdown, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseOutlined,
  DownOutlined,
  HomeOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { WEBVIEW_USER_AGENT, getSiteById, hostnameOf, type AiWebSite } from '../shared/sites'
import { createWebview, type WebviewElement } from './webview'
import { t, popupContainer } from './host'

/** guest 未在此时限内开始加载，判定为被宿主白名单守卫拦截 */
const ATTACH_TIMEOUT_MS = 6000

export interface WebPaneProps {
  site: AiWebSite | null
  /** 站点切换候选（设置中启用的站点） */
  sites: AiWebSite[]
  /** 切换本栏站点 */
  onSelectSite: (siteId: string) => void
  /** 紧凑模式（标签页模式）：隐藏站点切换，站点由所属标签页固定 */
  compact?: boolean
  /** 绝对定位堆叠（标签页模式） */
  stacked?: boolean
  /** 保留 guest 存活但不可见 */
  hidden?: boolean
  /** 提供后显示设置按钮（页面级开关，只落在最右一栏） */
  onToggleSettings?: () => void
  /** 设置面板当前是否展开（驱动按钮激活态） */
  settingsOpen?: boolean
}

export function WebPane({
  site,
  sites,
  onSelectSite,
  compact,
  stacked,
  hidden,
  onToggleSettings,
  settingsOpen,
}: WebPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<WebviewElement | null>(null)

  const [loading, setLoading] = useState(false)
  const [url, setUrl] = useState('')
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [blocked, setBlocked] = useState(false)
  /** 网页已关闭（guest 已销毁，仅剩空栏位） */
  const [closed, setClosed] = useState(false)

  const siteId = site?.id ?? null
  const siteUrl = site?.url ?? null

  const syncNavState = useCallback((wv: WebviewElement) => {
    // guest 尚未就绪时这些同步方法会抛错，忽略即可
    try {
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
      setUrl(wv.getURL() || '')
    } catch {
      /* guest not ready */
    }
  }, [])

  // 关闭网页后换站点：视为重新打开，直接加载新站点
  useEffect(() => {
    setClosed(false)
  }, [siteId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!siteId || !siteUrl || closed) {
      // 空栏 / 网页已关闭：清掉 guest（销毁 guest 即释放其渲染进程内存）
      host.replaceChildren()
      viewRef.current = null
      setBlocked(false)
      setLoading(false)
      setCanBack(false)
      setCanForward(false)
      if (!siteId || !siteUrl) setUrl('')
      return
    }

    // 站点切换：销毁旧 guest 重建。partition 只能在首次导航前设定，
    // 无法在既有 guest 上换站点；登录态不受影响（partition 是持久化的）。
    host.replaceChildren()
    setLoading(true)
    setBlocked(false)
    setUrl(siteUrl)

    const wv = createWebview({ src: siteUrl, siteId, userAgent: WEBVIEW_USER_AGENT })
    let guestAttached = false

    const markAttached = () => {
      guestAttached = true
      setBlocked(false)
    }
    const onStart = () => {
      markAttached()
      setLoading(true)
    }
    const onStop = () => {
      setLoading(false)
      syncNavState(wv)
    }
    const onDomReady = () => {
      markAttached()
      setLoading(false)
      syncNavState(wv)
    }
    const onNavigate = () => syncNavState(wv)
    const onFail = (event: Event) => {
      const code = (event as Event & { errorCode?: number }).errorCode
      // -3 = ABORTED，站点自身重定向/取消造成，不视为错误
      if (code === -3) return
      setLoading(false)
    }

    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('did-fail-load', onFail)

    // 守卫拦截探测：will-attach-webview 被 preventDefault 时 guest 根本不会创建，
    // 因而不会有任何事件；超时仍未开始加载即判定为域名未在白名单内。
    const timer = window.setTimeout(() => {
      if (!guestAttached) setBlocked(true)
    }, ATTACH_TIMEOUT_MS)

    host.appendChild(wv)
    viewRef.current = wv

    return () => {
      window.clearTimeout(timer)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('did-fail-load', onFail)
      wv.remove()
      if (viewRef.current === wv) viewRef.current = null
    }
  }, [siteId, siteUrl, closed, syncNavState])

  const goBack = () => {
    try {
      viewRef.current?.goBack()
    } catch {
      /* guest not ready */
    }
  }
  const goForward = () => {
    try {
      viewRef.current?.goForward()
    } catch {
      /* guest not ready */
    }
  }
  const reloadOrStop = () => {
    const wv = viewRef.current
    if (!wv) return
    try {
      if (loading) wv.stop()
      else wv.reload()
    } catch {
      /* guest not ready */
    }
  }
  const goHome = () => {
    if (!siteUrl) return
    try {
      void viewRef.current?.loadURL(siteUrl)
    } catch {
      /* guest not ready */
    }
  }
  /** 关掉网页（销毁 guest，释放其内存），栏位与标签页保留 */
  const closePage = () => setClosed(true)
  const reopenPage = () => setClosed(false)

  const siteMenu = {
    items: sites.map((s) => ({
      key: s.id,
      label: (
        <span className="aiweb-menu-item">
          <span className="aiweb-dot" style={{ background: s.color }} />
          {s.name}
        </span>
      ),
    })),
    onClick: ({ key }: { key: string }) => onSelectSite(key),
  }

  const rootClass = [
    'aiweb-pane',
    stacked ? 'aiweb-pane--stacked' : '',
    hidden ? 'aiweb-pane--hidden' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} aria-hidden={hidden || undefined}>
      <div className="aiweb-bar">
        {!compact && (
          <Dropdown
            menu={siteMenu}
            trigger={['click']}
            placement="bottomLeft"
            getPopupContainer={popupContainer}
          >
            <button type="button" className="aiweb-site-btn" title={site?.url ?? ''}>
              <span
                className="aiweb-dot"
                style={{ background: site?.color ?? 'var(--ant-color-text-quaternary)' }}
              />
              <span className="aiweb-site-name">{site?.name ?? t('pane.pickSite')}</span>
              <DownOutlined className="aiweb-site-caret" />
            </button>
          </Dropdown>
        )}

        <div className="aiweb-nav">
          <Tooltip placement="bottom" getPopupContainer={popupContainer} title={t('pane.back')}>
            <button
              type="button"
              className="aiweb-icon-btn"
              disabled={!canBack}
              onClick={goBack}
            >
              <ArrowLeftOutlined />
            </button>
          </Tooltip>
          <Tooltip placement="bottom" getPopupContainer={popupContainer} title={t('pane.forward')}>
            <button
              type="button"
              className="aiweb-icon-btn"
              disabled={!canForward}
              onClick={goForward}
            >
              <ArrowRightOutlined />
            </button>
          </Tooltip>
          <Tooltip
            placement="bottom"
            getPopupContainer={popupContainer}
            title={loading ? t('pane.stop') : t('pane.reload')}
          >
            <button
              type="button"
              className="aiweb-icon-btn"
              disabled={closed}
              onClick={reloadOrStop}
            >
              {loading ? <CloseOutlined /> : <ReloadOutlined />}
            </button>
          </Tooltip>
          <Tooltip placement="bottom" getPopupContainer={popupContainer} title={t('pane.home')}>
            <button type="button" className="aiweb-icon-btn" disabled={closed} onClick={goHome}>
              <HomeOutlined />
            </button>
          </Tooltip>
        </div>

        <div className="aiweb-address" title={url || siteUrl || ''}>
          {hostnameOf(url) || hostnameOf(siteUrl) || ''}
        </div>

        <div className="aiweb-nav">
          {siteId && (
            <Tooltip
              placement="bottom"
              getPopupContainer={popupContainer}
              title={t('pane.closePage')}
            >
              <button
                type="button"
                className="aiweb-icon-btn"
                disabled={closed}
                onClick={closePage}
              >
                <PoweroffOutlined />
              </button>
            </Tooltip>
          )}
          {onToggleSettings && (
            <Tooltip placement="bottom" getPopupContainer={popupContainer} title={t('settings.title')}>
              <button
                type="button"
                className={`aiweb-icon-btn${settingsOpen ? ' is-active' : ''}`}
                onClick={onToggleSettings}
              >
                <SettingOutlined />
              </button>
            </Tooltip>
          )}
        </div>

        {loading && <div className="aiweb-progress" />}
      </div>

      <div className="aiweb-body">
        <div ref={hostRef} className="aiweb-view-host" />
        {!siteId && (
          <div className="aiweb-hint">
            <div className="aiweb-hint-text">{t('pane.empty')}</div>
          </div>
        )}
        {closed && siteId && (
          <div className="aiweb-hint">
            <div className="aiweb-hint-title">{t('pane.closed.title')}</div>
            <div className="aiweb-hint-text">{t('pane.closed.text')}</div>
            <button type="button" className="aiweb-primary-btn" onClick={reopenPage}>
              <ReloadOutlined />
              {t('pane.closed.action')}
            </button>
          </div>
        )}
        {blocked && siteId && (
          <div className="aiweb-hint">
            <div className="aiweb-hint-title">{t('pane.blocked.title')}</div>
            <div className="aiweb-hint-text">
              {t('pane.blocked.text', { site: getSiteById(siteId)?.name ?? siteId })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default WebPane
