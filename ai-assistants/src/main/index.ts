/**
 * ai-assistants 插件主进程入口。
 *
 * 内嵌网页本身完全由渲染端的 `<webview>` 承担，主进程只负责一件事：
 * 把页面状态（视图模式 / 双栏站点 / 打开的标签页 / 启用的快捷站点）持久化到插件自有的 KV，
 * 使重开应用后恢复现场。读写两端都经 `normalizeLayout` 归一化，兼容 v1.0.0 的旧结构。
 */
import type { PluginContext } from '@workavatar/plugin-sdk'
import { normalizeLayout, type AiWebLayout } from '../shared/sites'

/** 布局在插件 KV 中的键名 */
const LAYOUT_KEY = 'layout'

export async function activate(ctx: PluginContext): Promise<void> {
  ctx.ipc.handle('layout-get', async () => {
    const raw = await ctx.storage.get(LAYOUT_KEY)
    return normalizeLayout(raw)
  })

  ctx.ipc.handle('layout-set', async (payload: unknown) => {
    const layout: AiWebLayout = normalizeLayout(payload)
    await ctx.storage.set(LAYOUT_KEY, layout)
    return { ok: true }
  })
}

export function deactivate(): void {
  // 无定时器 / 窗口 / 连接需要释放
}
