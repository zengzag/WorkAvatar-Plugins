/**
 * image-studio 渲染端入口。
 */
import './styles.css'
import { setBridge, setHostCapabilities, setHostI18n } from './store'
import { ImageStudioPage } from './ImageStudioPage'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: ImageStudioPage }],

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
    setHostI18n(host.i18n.t)
    setHostCapabilities(host.hostCapabilities)
  },

  dispose(): void {
    // 页面卸载由 React 自动清理
  },
}

export default entry
