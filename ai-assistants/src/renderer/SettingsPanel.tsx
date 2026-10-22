/**
 * 设置面板：视图模式 + 快捷站点（启用 / 排序 / 自定义网页增删）。
 *
 * 面板内联在页面右侧（而非浮层），一来避免遮住正在使用的网页，二来让布局关系一眼可见。
 */
import { useState } from 'react'
import { Input, Modal, Popconfirm, Segmented, Switch, Tooltip } from 'antd'
import {
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  UpOutlined,
} from '@ant-design/icons'
import {
  AI_WEB_SITES,
  MAX_CUSTOM_SITES,
  type AiWebLayout,
  type AiWebLayoutMode,
} from '../shared/sites'
import { buildModeOptions } from './modes'
import { t, siteName, popupContainer } from './host'

export interface SettingsPanelProps {
  layout: AiWebLayout
  onModeChange: (mode: AiWebLayoutMode) => void
  onToggleSite: (siteId: string, enabled: boolean) => void
  onMoveSite: (siteId: string, delta: -1 | 1) => void
  /** 添加自定义网页；成功返回 null，失败返回错误码（由面板本地化展示） */
  onAddSite: (input: { name: string; url: string }) => string | null
  onRemoveSite: (siteId: string) => void
  onReset: () => void
  onClose: () => void
}

export function SettingsPanel({
  layout,
  onModeChange,
  onToggleSite,
  onMoveSite,
  onAddSite,
  onRemoveSite,
  onReset,
  onClose,
}: SettingsPanelProps) {
  const enabled = layout.enabledSites
  // 至少保留一个站点，否则站点菜单会空掉
  const onlyOneLeft = enabled.length <= 1
  const allSites = [...AI_WEB_SITES, ...layout.customSites]
  const reachedLimit = layout.customSites.length >= MAX_CUSTOM_SITES

  const [addOpen, setAddOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftUrl, setDraftUrl] = useState('')
  const [formError, setFormError] = useState('')

  const openAdd = () => {
    setDraftName('')
    setDraftUrl('')
    setFormError('')
    setAddOpen(true)
  }

  const submitAdd = () => {
    const error = onAddSite({ name: draftName, url: draftUrl })
    if (error) {
      setFormError(t(`settings.customError.${error}`))
      return
    }
    setAddOpen(false)
  }

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
            {allSites.map((site) => {
              const index = enabled.indexOf(site.id)
              const on = index >= 0
              return (
                <div key={site.id} className={`aiweb-site-row${on ? '' : ' is-off'}`}>
                  <span className="aiweb-dot" style={{ background: site.color }} />
                  <span className="aiweb-site-row-name" title={site.url}>
                    {siteName(site)}
                  </span>
                  {site.custom && (
                    <span className="aiweb-site-row-tag">{t('settings.customTag')}</span>
                  )}
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
                    {site.custom && (
                      <Popconfirm
                        title={t('settings.customDeleteConfirm', { name: siteName(site) })}
                        okText={t('settings.customDelete')}
                        cancelText={t('settings.cancel')}
                        getPopupContainer={popupContainer}
                        onConfirm={() => onRemoveSite(site.id)}
                      >
                        <button
                          type="button"
                          className="aiweb-mini-btn"
                          aria-label={t('settings.customDelete')}
                        >
                          <DeleteOutlined />
                        </button>
                      </Popconfirm>
                    )}
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

          <button
            type="button"
            className="aiweb-text-btn aiweb-add-site-btn"
            onClick={openAdd}
            disabled={reachedLimit}
          >
            <PlusOutlined />
            {t('settings.customAdd')}
          </button>

          <p className="aiweb-settings-note">
            {reachedLimit ? t('settings.customLimit', { count: MAX_CUSTOM_SITES }) : t('settings.sitesNote')}
          </p>
        </section>

        <section className="aiweb-settings-section">
          <button type="button" className="aiweb-text-btn" onClick={onReset}>
            {t('settings.reset')}
          </button>
        </section>
      </div>

      <Modal
        open={addOpen}
        title={t('settings.customFormTitle')}
        okText={t('settings.customSave')}
        cancelText={t('settings.cancel')}
        onOk={submitAdd}
        onCancel={() => setAddOpen(false)}
        destroyOnHidden
      >
        <div className="aiweb-form-field">
          <label className="aiweb-form-label" htmlFor="aiweb-custom-name">
            {t('settings.customName')}
          </label>
          <Input
            id="aiweb-custom-name"
            value={draftName}
            maxLength={40}
            placeholder={t('settings.customNamePlaceholder')}
            onChange={(event) => setDraftName(event.target.value)}
          />
        </div>
        <div className="aiweb-form-field">
          <label className="aiweb-form-label" htmlFor="aiweb-custom-url">
            {t('settings.customUrl')}
          </label>
          <Input
            id="aiweb-custom-url"
            value={draftUrl}
            placeholder={t('settings.customUrlPlaceholder')}
            status={formError ? 'error' : undefined}
            onChange={(event) => {
              setDraftUrl(event.target.value)
              setFormError('')
            }}
            onPressEnter={submitAdd}
          />
        </div>
        {formError ? <div className="aiweb-form-error">{formError}</div> : null}
        <p className="aiweb-settings-note">{t('settings.customHint')}</p>
      </Modal>
    </aside>
  )
}

export default SettingsPanel
