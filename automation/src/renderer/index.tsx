/**
 * automation 插件渲染端入口
 */
import { setBridge } from './store'
import AutomationPage from './AutomationPage'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: AutomationPage }],

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
  },
}

export default entry
