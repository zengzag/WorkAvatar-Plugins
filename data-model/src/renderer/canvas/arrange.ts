// 多选节点的对齐/分布（纯函数，便于单元测试）

export type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom'
export type DistributeMode = 'horizontal' | 'vertical'

export interface PositionedItem {
  id: string
  x: number
  y: number
}

/**
 * 对齐：以选中节点的包围盒为基准，将各节点移动到对齐位置。
 * - left/centerH/right：水平对齐（取包围盒左/中/右）
 * - top/centerV/bottom：垂直对齐（取包围盒顶/中/底）
 */
export function alignPositions(items: PositionedItem[], mode: AlignMode): PositionedItem[] {
  if (items.length < 2) return items
  const minX = Math.min(...items.map((i) => i.x))
  const maxX = Math.max(...items.map((i) => i.x))
  const minY = Math.min(...items.map((i) => i.y))
  const maxY = Math.max(...items.map((i) => i.y))
  const targetX = mode === 'left' ? minX : mode === 'right' ? maxX : (minX + maxX) / 2
  const targetY = mode === 'top' ? minY : mode === 'bottom' ? maxY : (minY + maxY) / 2
  return items.map((i) => ({
    ...i,
    x: mode === 'left' || mode === 'centerH' || mode === 'right' ? targetX : i.x,
    y: mode === 'top' || mode === 'centerV' || mode === 'bottom' ? targetY : i.y,
  }))
}

/**
 * 分布：按当前坐标排序，保持首尾节点不动，将中间节点等距铺开。
 * - horizontal：按 x 排序等距分布
 * - vertical：按 y 排序等距分布
 */
export function distributePositions(items: PositionedItem[], mode: DistributeMode): PositionedItem[] {
  if (items.length < 3) return items
  const sorted = [...items].sort((a, b) => (mode === 'horizontal' ? a.x - b.x : a.y - b.y))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = mode === 'horizontal' ? last.x - first.x : last.y - first.y
  const step = span / (sorted.length - 1)
  return sorted.map((i, idx) => ({
    ...i,
    x: mode === 'horizontal' ? first.x + step * idx : i.x,
    y: mode === 'vertical' ? first.y + step * idx : i.y,
  }))
}