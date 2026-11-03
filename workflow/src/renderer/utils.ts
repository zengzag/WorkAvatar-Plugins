/** 运行页与输出面板共用的格式化 / 汇总工具 */
import type { PluginWorkflowNodeRun, PluginWorkflowTokenUsage } from '@workavatar/plugin-sdk'

export const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  aborted: 'warning',
  skipped: 'default',
}

/** Unix 秒 → 本地时间文案 */
export function formatTime(unixSec?: number): string {
  if (!unixSec) return '-'
  return new Date(unixSec * 1000).toLocaleString()
}

/** 运行耗时：终态取区间，进行中按当前时间实时计算；未开始返回 null */
export function formatDuration(startSec?: number, endSec?: number): string | null {
  if (!startSec) return null
  const secs = Math.max((endSec ?? Math.floor(Date.now() / 1000)) - startSec, 0)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

/** 汇总所有节点的 token 用量 */
export function sumTokenUsage(nodes: PluginWorkflowNodeRun[]): PluginWorkflowTokenUsage {
  const total: PluginWorkflowTokenUsage = {}
  for (const node of nodes) {
    const usage = node.tokenUsage
    if (!usage) continue
    total.promptTokens = (total.promptTokens || 0) + (usage.promptTokens || 0)
    total.completionTokens = (total.completionTokens || 0) + (usage.completionTokens || 0)
    total.totalTokens = (total.totalTokens || 0) + (usage.totalTokens || 0)
    total.cachedTokens = (total.cachedTokens || 0) + (usage.cachedTokens || 0)
  }
  return total
}

/** 员工配色：按名称哈希出固定色相，保证同一员工每次运行颜色一致 */
export function employeeHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return hash % 360
}

/** 头像文字：取名字最后一个字，避免「一诺」这类名字首字是一条横线 */
export function avatarChar(name: string): string {
  const trimmed = (name || '').trim()
  return trimmed ? trimmed.slice(-1) : '?'
}

/** 根据背景色判断当前是否为暗色主题 */
export function isDarkColor(hex: string): boolean {
  const value = (hex || '').trim().replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return false
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55
}
