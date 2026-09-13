/**
 * 设置面板：视图模式 + 快捷站点（启用 / 排序）。
 *
 * 面板内联在页面右侧（而非浮层），一来避免遮住正在使用的网页，二来让布局关系一眼可见。
 */
import { Segmented, Switch, Tooltip } from 'antd'
import { CloseOutlined, DownOutlined, UpOutlined } from '@ant-design/icons'
import { AI_WEB_SITES, type AiWebLayout, type AiWebLayoutMode } from '../shared/sites'
import { buildModeOptions } from './modes'
import { t, popupContainer } from './host'

export interface SettingsPanelProps {
  layout: AiWebLayout
  onModeChange: (mode: AiWebLayoutMode) => void
  onToggleSite: (siteId: string, enabled: boolean) => void
  onMoveSite: (siteId: string, delta: -1 | 1) => void
  onReset: () => void
  onClose: () => void
}

export function SettingsPanel({
  layout,
  onModeChange,
  onToggleSite,
  onMoveSite,
  onReset,
  onClose,
}: SettingsPanelProps) {
  const enabled = layout.enabledSites
  // 至少保留一个站点，否则站点菜单会空掉
  const onlyOneLeft = enabled.length <= 1

  return (
    <aside className="aiweb-settings">
      <div className="aiweb-settings-head">
        <span className="aiweb-settings-title">{t('settings.title')}</span>
        <button
          type="button"
          className="aiweb-icon-btn"
          onClick={onClose}
          aria-label={t('settings.close')}
        >
          <CloseOutlined />
        </button>
      </div>

      <div className="aiweb-settings-body">
        <section className="aiweb-settings-section">
          <div className="aiweb-settings-label">{t('settings.mode')}</div>
          <Segmented
            block
            size="small"
            value={layout.mode}
            options={buildModeOptions(t)}
            onChange={(value) => onModeChange(value as AiWebLayoutMode)}
          />
          <p className="aiweb-settings-hint">{t('settings.modeHint')}</p>
        </section>

        <section className="aiweb-settings-section">
          <div className="aiweb-settings-label">{t('settings.sites')}</div>
          <p className="aiweb-settings-hint">{t('settings.sitesHint')}</p>

          <div className="aiweb-site-list">
            {AI_WEB_SITES.map((site) => {
              const index = enabled.indexOf(site.id)
              const on = index >= 0
              return (
                <div key={site.id} className={`aiweb-site-row${on ? '' : ' is-off'}`}>
                  <span className="aiweb-dot" style={{ background: site.color }} />
                  <span className="aiweb-site-row-name">{site.name}</span>
                  <span className="aiweb-site-row-ops">
                    <Tooltip getPopupContainer={popupContainer} title={t('settings.moveUp')}>
                      <button
                        type="button"
                        className="aiweb-mini-btn"
                        disabled={!on || index === 0}
                        onClick={() => onMoveSite(site.id, -1)}
                      >
                        <UpOutlined />
                      </button>
                    </Tooltip>
                    <Tooltip getPopupContainer={popupContainer} title={t('settings.moveDown')}>
                      <button
                        type="button"
                        className="aiweb-mini-btn"
                        disabled={!on || index === enabled.length - 1}
                        onClick={() => onMoveSite(site.id, 1)}
                      >
                        <DownOutlined />
                      </button>
                    </Tooltip>
                    <Switch
                      size="small"
                      checked={on}
                      disabled={on && onlyOneLeft}
                      onChange={(next) => onToggleSite(site.id, next)}
                    />
                  </span>
                </div>
              )
            })}
          </div>

          <p className="aiweb-settings-note">{t('settings.sitesNote')}</p>
        </section>

        <section className="aiweb-settings-section">
          <button type="button" className="aiweb-text-btn" onClick={onReset}>
            {t('settings.reset')}
          </button>
        </section>
      </div>
    </aside>
  )
}

export default SettingsPanel
