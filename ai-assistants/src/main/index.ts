/**
 * ai-assistants 插件主进程入口。
 *
 * 内嵌网页本身完全由渲染端的 `<webview>` 承担，主进程只负责两件事：
 *  1. 把页面状态（视图模式 / 双栏站点 / 打开的标签页 / 启用的快捷站点 / 自定义网页）
 *     持久化到插件自有的 KV，使重开应用后恢复现场；
 *  2. 把自定义网页的域名经 `ctx.webview.allowOrigins` 注册进宿主的运行时白名单 ——
 *     自定义网址无法预先写进 manifest，只能运行时放行。
 *
 * 读写两端都经 `normalizeLayout` 归一化，兼容 v1.0.0 的旧结构。
 */
import type { PluginContext } from '@workavatar/plugin-sdk'
import { normalizeLayout, parseCustomSiteUrl, type AiWebLayout } from '../shared/sites'

/** 布局在插件 KV 中的键名 */
const LAYOUT_KEY = 'layout'

/**
 * 把自定义网页域名同步给宿主（整体替换本插件的运行时白名单）。
 * 宿主未声明 allowUserOrigins 时调用会抛错：吞掉即可，内置站点不受影响。
 */
function syncWebviewOrigins(ctx: PluginContext, layout: AiWebLayout): void {
  const hosts = new Set<string>()
  for (const site of layout.customSites) {
    const parsed = parseCustomSiteUrl(site.url)
    if (parsed.ok) hosts.add(parsed.hostname)
  }
  try {
    ctx.webview.allowOrigins(Array.from(hosts))
  } catch {
    /* 宿主未授予运行时域名注册能力 */
  }
}

export async function activate(ctx: PluginContext): Promise<void> {
  ctx.ipc.handle('layout-get', async () => {
    const layout = normalizeLayout(await ctx.storage.get(LAYOUT_KEY))
    // 读取时补注册一次，覆盖「宿主重启后激活完成」与「渲染端首屏创建 webview」之间的时序窗口
    syncWebviewOrigins(ctx, layout)
    return layout
  })

  ctx.ipc.handle('layout-set', async (payload: unknown) => {
    const layout: AiWebLayout = normalizeLayout(payload)
    await ctx.storage.set(LAYOUT_KEY, layout)
    syncWebviewOrigins(ctx, layout)
    return { ok: true }
  })

  syncWebviewOrigins(ctx, normalizeLayout(await ctx.storage.get(LAYOUT_KEY)))
}

export function deactivate(): void {
  // 无定时器 / 窗口 / 连接需要释放；运行时域名由宿主在插件下线时自动清理
}
