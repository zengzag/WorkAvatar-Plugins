// word-editor 插件渲染端入口

import './styles.css'
import { setBridge, setHostI18n, setHostCapabilities } from './store'
import { WordEditorPage } from './WordEditorPage'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: WordEditorPage }],

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
    setHostI18n(host.i18n.t)
    setHostCapabilities(host.hostCapabilities)
  }
}

export default entry
