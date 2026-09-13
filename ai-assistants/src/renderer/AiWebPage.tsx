/**
 * AI 助手集主页：在宿主主窗口内托管多个 AI 网页版。
 *
 * 三种视图模式（入口在设置面板里）：
 *   - 单栏：一个站点铺满，专注使用；
 *   - 双栏：两个站点并排，便于对照同一问题的不同回答；
 *   - 标签页：多个站点收进一个窗口，标签切换不重载（guest 常驻）。
 *
 * 页面刻意没有全局顶栏 —— 唯一的常驻 UI 是各栏自己的一行工具条，
 * 视图模式与快捷站点都收进设置，把垂直空间尽量留给网页本身。
 *
 * 状态（模式 / 双栏站点 / 打开的标签页 / 启用的站点）持久化到插件 KV，重开应用恢复现场；
 * 各站点的登录态由 webview 的持久化 partition 承载，与页面状态相互独立。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PlusOutlined } from '@ant-design/icons'
import {
  AI_WEB_SITES,
  DEFAULT_LAYOUT,
  createTabId,
  getSiteById,
  normalizeLayout,
  resolveEnabledSites,
  type AiWebLayout,
  type AiWebLayoutMode,
} from '../shared/sites'
import { WebPane } from './WebPane'
import { TabStrip } from './TabStrip'
import { SettingsPanel } from './SettingsPanel'
import { getBridge, t } from './host'

type PaneIndex = 0 | 1

function cloneDefaultLayout(): AiWebLayout {
  return {
    ...DEFAULT_LAYOUT,
    panes: [...DEFAULT_LAYOUT.panes] as [string | null, string | null],
    tabs: [],
    enabledSites: [...DEFAULT_LAYOUT.enabledSites],
  }
}

export function AiWebPage() {
  const [layout, setLayout] = useState<AiWebLayout>(cloneDefaultLayout)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [ready, setReady] = useState(false)

  // 读取持久化状态
  useEffect(() => {
    let cancelled = false
    const bridge = getBridge()
    if (!bridge) {
      setReady(true)
      return
    }
    void bridge
      .invoke('layout-get')
      .then((raw) => {
        if (!cancelled) setLayout(normalizeLayout(raw))
      })
      .catch(() => {
        /* 读取失败则用默认状态 */
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 更新状态并落盘（写失败不影响本次会话） */
  const update = useCallback((mutate: (prev: AiWebLayout) => AiWebLayout) => {
    setLayout((prev) => {
      const next = mutate(prev)
      void getBridge()
        ?.invoke('layout-set', next)
        .catch(() => {
          /* 持久化失败可忽略 */
        })
      return next
    })
  }, [])

  const enabledSites = useMemo(() => resolveEnabledSites(layout.enabledSites), [layout.enabledSites])

  const switchMode = useCallback(
    (mode: AiWebLayoutMode) => {
      update((prev) => {
        if (mode !== 'tabs') return { ...prev, mode }
        if (prev.tabs.length > 0) return { ...prev, mode }
        // 首次进入标签页模式：用当前单栏站点（或首个启用站点）开一个标签页
        const siteId = prev.panes[0] ?? prev.enabledSites[0] ?? AI_WEB_SITES[0].id
        const tab = { id: createTabId(siteId), siteId }
        return { ...prev, mode, tabs: [tab], activeTabId: tab.id }
      })
    },
    [update]
  )

  const setPaneSite = useCallback(
    (index: PaneIndex, siteId: string) => {
      update((prev) => {
        const panes: [string | null, string | null] = [prev.panes[0], prev.panes[1]]
        panes[index] = siteId
        return { ...prev, panes }
      })
    },
    [update]
  )

  const openTab = useCallback(
    (siteId: string) => {
      update((prev) => {
        const tab = { id: createTabId(siteId), siteId }
        return { ...prev, tabs: [...prev.tabs, tab], activeTabId: tab.id }
      })
    },
    [update]
  )

  const closeTab = useCallback(
    (tabId: string) => {
      update((prev) => {
        const index = prev.tabs.findIndex((tab) => tab.id === tabId)
        if (index < 0) return prev
        const tabs = prev.tabs.filter((tab) => tab.id !== tabId)
        let activeTabId = prev.activeTabId
        if (activeTabId === tabId) {
          // 关闭激活页后接管右邻，没有右邻则接管左邻
          activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null
        }
        return { ...prev, tabs, activeTabId }
      })
    },
    [update]
  )

  const activateTab = useCallback(
    (tabId: string) => update((prev) => ({ ...prev, activeTabId: tabId })),
    [update]
  )

  const toggleSite = useCallback(
    (siteId: string, enabled: boolean) => {
      update((prev) => {
        const set = new Set(prev.enabledSites)
        if (enabled) set.add(siteId)
        else set.delete(siteId)
        // 按站点定义顺序归位，保证菜单顺序稳定
        const next = AI_WEB_SITES.map((site) => site.id).filter((id) => set.has(id))
        if (next.length === 0) return prev
        return { ...prev, enabledSites: next }
      })
    },
    [update]
  )

  const moveSite = useCallback(
    (siteId: string, delta: -1 | 1) => {
      update((prev) => {
        const list = [...prev.enabledSites]
        const from = list.indexOf(siteId)
        const to = from + delta
        if (from < 0 || to < 0 || to >= list.length) return prev
        ;[list[from], list[to]] = [list[to], list[from]]
        return { ...prev, enabledSites: list }
      })
    },
    [update]
  )

  const resetLayout = useCallback(() => {
    const next = cloneDefaultLayout()
    void getBridge()
      ?.invoke('layout-set', next)
      .catch(() => {
        /* 持久化失败可忽略 */
      })
    setLayout(next)
  }, [])

  const closeSplit = useCallback(() => switchMode('single'), [switchMode])
  const noopSelect = useCallback(() => {}, [])
  const toggleSettings = useCallback(() => setSettingsOpen((open) => !open), [])

  const fallbackSiteId = enabledSites[0]?.id ?? AI_WEB_SITES[0].id

  const renderStage = () => {
    if (layout.mode === 'tabs') {
      if (layout.tabs.length === 0) {
        return (
          <div className="aiweb-empty">
            <div className="aiweb-empty-title">{t('tabs.empty.title')}</div>
            <div className="aiweb-empty-text">{t('tabs.empty.text')}</div>
            <button
              type="button"
              className="aiweb-primary-btn"
              onClick={() => openTab(fallbackSiteId)}
            >
              <PlusOutlined />
              {t('tabs.empty.action')}
            </button>
          </div>
        )
      }
      // 标签页全部挂载、绝对定位堆叠，仅激活项可见 —— 切标签不重载，对话与登录态都在
      return layout.tabs.map((tab) => (
        <WebPane
          key={tab.id}
          stacked
          compact
          hidden={tab.id !== layout.activeTabId}
          site={getSiteById(tab.siteId) ?? null}
          sites={enabledSites}
          onSelectSite={noopSelect}
          settingsOpen={settingsOpen}
          onToggleSettings={toggleSettings}
        />
      ))
    }

    const isSplit = layout.mode === 'split'
    return (
      <>
        <WebPane
          site={getSiteById(layout.panes[0]) ?? null}
          sites={enabledSites}
          onSelectSite={(siteId) => setPaneSite(0, siteId)}
          // 单栏时这条工具条是唯一一行，设置按钮就落在它身上
          onToggleSettings={isSplit ? undefined : toggleSettings}
          settingsOpen={settingsOpen}
        />
        {isSplit && (
          <WebPane
            site={getSiteById(layout.panes[1]) ?? null}
            sites={enabledSites}
            onSelectSite={(siteId) => setPaneSite(1, siteId)}
            onClose={closeSplit}
            // 双栏时设置按钮落在最右一栏，位置与右侧设置面板呼应
            onToggleSettings={toggleSettings}
            settingsOpen={settingsOpen}
          />
        )}
      </>
    )
  }

  if (!ready) return <div className="aiweb-root" />

  return (
    <div className="aiweb-root">
      <div className="aiweb-content">
        <div className="aiweb-main">
          {layout.mode === 'tabs' && (
            <TabStrip
              tabs={layout.tabs}
              activeTabId={layout.activeTabId}
              sites={enabledSites}
              onActivate={activateTab}
              onClose={closeTab}
              onOpen={openTab}
            />
          )}
          <div className="aiweb-stage">{renderStage()}</div>
        </div>

        {settingsOpen && (
          <SettingsPanel
            layout={layout}
            onModeChange={switchMode}
            onToggleSite={toggleSite}
            onMoveSite={moveSite}
            onReset={resetLayout}
            onClose={toggleSettings}
          />
        )}
      </div>
    </div>
  )
}

export default AiWebPage
