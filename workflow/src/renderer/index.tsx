/** 模板任务插件 — 渲染端入口 */
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'
import { setHost } from './host'
import { WorkflowPage } from './WorkflowPage'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: WorkflowPage }],
  init(host: PluginRendererHost): void {
    setHost(host)
  },
  dispose(): void {
    setHost(null)
  },
}

export default entry
