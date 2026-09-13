// ai-assistants 插件渲染端入口

import { AiWebPage } from './AiWebPage'
import { setHost } from './host'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'
import './styles.css'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: AiWebPage }],

  init(host: PluginRendererHost): void {
    setHost(host.bridge, host.i18n.t)
  },
}

export default entry
