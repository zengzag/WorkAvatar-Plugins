/**
 * 标签页模式的标签条：站点色点 + 站名 + 关闭；末尾为「新建标签页」。
 * 关闭按钮仅在悬停或激活时显形，避免一排叉号造成视觉噪音。
 */
import { Dropdown } from 'antd'
import { CloseOutlined, PlusOutlined } from '@ant-design/icons'
import { getSiteById, type AiWebSite, type AiWebTab } from '../shared/sites'
import { t, popupContainer } from './host'

export interface TabStripProps {
  tabs: AiWebTab[]
  activeTabId: string | null
  /** 可新建的站点（设置中启用的站点） */
  sites: AiWebSite[]
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onOpen: (siteId: string) => void
}

export function TabStrip({ tabs, activeTabId, sites, onActivate, onClose, onOpen }: TabStripProps) {
  const addMenu = {
    items: sites.map((site) => ({
      key: site.id,
      label: (
        <span className="aiweb-menu-item">
          <span className="aiweb-dot" style={{ background: site.color }} />
          {site.name}
        </span>
      ),
    })),
    onClick: ({ key }: { key: string }) => onOpen(key),
  }

  return (
    <div className="aiweb-tabs">
      {tabs.map((tab) => {
        const site = getSiteById(tab.siteId)
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            className={`aiweb-tab${active ? ' is-active' : ''}`}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onActivate(tab.id)
            }}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={site?.url ?? ''}
          >
            <span className="aiweb-dot" style={{ background: site?.color }} />
            <span className="aiweb-tab-label">{site?.name ?? tab.siteId}</span>
            <button
              type="button"
              className="aiweb-tab-close"
              aria-label={t('tab.close')}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              <CloseOutlined />
            </button>
          </div>
        )
      })}

      <Dropdown
        menu={addMenu}
        trigger={['click']}
        placement="bottomLeft"
        getPopupContainer={popupContainer}
      >
        <button type="button" className="aiweb-tab-add" aria-label={t('tab.add')} title={t('tab.add')}>
          <PlusOutlined />
        </button>
      </Dropdown>
    </div>
  )
}

export default TabStrip
