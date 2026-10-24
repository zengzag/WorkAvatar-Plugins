/**
 * 生图工作室主页面：顶部品牌栏 + 左侧生成面板 + 右侧作品库。
 */
import { useEffect } from 'react'
import { Alert, Button, Input, Tooltip } from 'antd'
import { SearchOutlined, SettingOutlined } from '@ant-design/icons'
import { PLUGIN_VERSION } from '../shared/types'
import {
  initialize,
  openSettings,
  setNotice,
  setSearch,
  t,
  useStudio,
} from './store'
import { ComposerPanel } from './components/ComposerPanel'
import { Gallery } from './components/Gallery'
import { PreviewModal } from './components/PreviewModal'
import { SettingsDrawer } from './components/SettingsDrawer'

export function ImageStudioPage() {
  const state = useStudio()

  useEffect(() => {
    void initialize()
  }, [])

  return (
    <div className="is-root">
      <header className="is-header">
        <div className="is-brand">
          <div className="is-brand-logo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.4l2.55 6.05L20.6 11l-6.05 2.55L12 19.6l-2.55-6.05L3.4 11l6.05-2.55z" />
              <path d="M18.6 15.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
            </svg>
          </div>
          <div className="is-brand-copy">
            <div className="is-brand-title">
              {t('title')}
              <span className="is-brand-version">v{PLUGIN_VERSION}</span>
            </div>
            <div className="is-brand-sub">{t('subtitle')}</div>
          </div>
        </div>
        <div className="is-header-actions">
          <Input
            allowClear
            value={state.search}
            onChange={(event) => setSearch(event.target.value)}
            prefix={<SearchOutlined />}
            placeholder={t('searchPlaceholder')}
            className="is-search"
          />
          <Tooltip title={t('settings')}>
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => openSettings(true)}
              className="is-settings-btn"
            />
          </Tooltip>
        </div>
      </header>

      <div className="is-body">
        <ComposerPanel />
        <section className="is-main">
          {state.notice && (
            <Alert
              className="is-notice"
              type={state.notice.type}
              message={state.notice.message}
              closable
              onClose={() => setNotice(null)}
              showIcon
            />
          )}
          <Gallery />
        </section>
      </div>

      <SettingsDrawer open={state.settingsOpen} onClose={() => openSettings(false)} />
      <PreviewModal />
    </div>
  )
}

export default ImageStudioPage
