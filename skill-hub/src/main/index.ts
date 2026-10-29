import type { PluginContext } from '@workavatar/plugin-sdk'

/**
 * 纯技能插件：技能由宿主扫描 <插件根>/skills/ 自动注册（source='plugin'），
 * 运行期无需任何 IPC / 工具 / 定时任务，activate 仅用于通过宿主生命周期校验。
 */
export function activate(ctx: PluginContext): void {
  ctx.services.logger.info('skill-hub 插件激活：技能已由宿主注册')
}
