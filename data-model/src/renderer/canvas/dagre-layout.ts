// 画布自动布局（力导向，均匀铺开避免堆叠成一列）

import type { DataModel, Table, Relationship } from '../../shared/domain'

export const NODE_WIDTH = 260
export const NODE_HEIGHT_COLLAPSED = 40
export const FIELD_HEIGHT = 24
export const HEADER_HEIGHT = 36

/** 节点间最小水平/垂直间距（避免重叠） */
const NODE_GAP = 40

/**
 * 计算指定表在画布上应渲染的字段列表。
 * - 展开时：返回全部字段
 * - 折叠时：返回主键字段 + 在任意关系中作为端点的字段（保持原顺序去重）
 * 这样折叠后连线仍能定位到对应字段的 Handle，画布上的关系边不会消失。
 */
export function getVisibleFields(table: Table, relationships: Relationship[]): Table['fields'] {
  const fields = table.fields ?? []
  if (table.expanded) return fields
  const visibleIds = new Set<string>()
  for (const f of fields) {
    if (f.primaryKey) visibleIds.add(f.id)
  }
  for (const r of relationships) {
    if (r.sourceTableId === table.id) visibleIds.add(r.sourceFieldId)
    if (r.targetTableId === table.id) visibleIds.add(r.targetFieldId)
  }
  return fields.filter((f) => visibleIds.has(f.id))
}

export function computeNodeHeight(table: Table, relationships: Relationship[]): number {
  const fields = table.fields ?? []
  if (!table.expanded) {
    const visibleCount = getVisibleFields(table, relationships).length
    if (visibleCount === 0) return NODE_HEIGHT_COLLAPSED
    return HEADER_HEIGHT + visibleCount * FIELD_HEIGHT + 8
  }
  const fieldCount = fields.length
  return HEADER_HEIGHT + Math.max(fieldCount * FIELD_HEIGHT, 40) + 8
}

export interface LayoutResult {
  nodes: Array<{ id: string; position: { x: number; y: number } }>
  edges: Array<{ id: string; source: string; target: string }>
}

/**
 * 力导向自动布局（Fruchterman-Reingold 变体）。
 * 相比 dagre 的 LR 分层，力导向会在二维平面均匀铺开节点，
 * 避免表多时堆叠成长长的一列，整体更紧凑、更均衡。
 */
export function layoutTables(model: DataModel, width: number): LayoutResult {
  const tables = model.tables
  const rels = model.relationships
  const n = tables.length
  if (n === 0) return { nodes: [], edges: [] }

  const sizes = new Map<string, { w: number; h: number }>()
  for (const t of tables) {
    sizes.set(t.id, { w: NODE_WIDTH, h: computeNodeHeight(t, rels) })
  }

  // 无向邻接表（用于引力）
  const adj = new Map<string, Set<string>>()
  for (const t of tables) adj.set(t.id, new Set())
  for (const r of rels) {
    if (adj.has(r.sourceTableId) && adj.has(r.targetTableId)) {
      adj.get(r.sourceTableId)!.add(r.targetTableId)
      adj.get(r.targetTableId)!.add(r.sourceTableId)
    }
  }

  // 初始位置：按网格铺开，保证确定性且不重叠
  const pos = new Map<string, { x: number; y: number }>()
  const cols = Math.ceil(Math.sqrt(n))
  tables.forEach((t, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    pos.set(t.id, {
      x: col * (NODE_WIDTH + NODE_GAP),
      y: row * (NODE_HEIGHT_COLLAPSED + NODE_GAP * 2),
    })
  })

  // 力导向迭代
  const area = Math.max(2000, n * 1200)
  const k = Math.sqrt(area / n)
  const maxIter = 400
  const maxTemp = Math.sqrt(area) / 6
  // 斥力系数略低于引力，使布局紧凑；线性引力避免链式结构被拉成一条直线
  const REPULSION = 0.5
  const ATTRACTION = 1.0
  const disp = new Map<string, { x: number; y: number }>()

  for (let iter = 0; iter < maxIter; iter++) {
    for (const t of tables) disp.set(t.id, { x: 0, y: 0 })

    // 斥力：所有节点对
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = tables[i]
        const b = tables[j]
        const pa = pos.get(a.id)!
        const pb = pos.get(b.id)!
        let dx = pa.x - pb.x
        let dy = pa.y - pb.y
        let d = Math.sqrt(dx * dx + dy * dy)
        // 最小间距取两节点半宽之和，避免重叠
        const minD = (sizes.get(a.id)!.w + sizes.get(b.id)!.w) / 2 + NODE_GAP
        if (d < 1) {
          dx = 1
          dy = 0
          d = 1
        }
        // 重叠时（d < minD）斥力随 1/d 急剧增大，强力推开重叠节点
        const force = d >= minD
          ? (REPULSION * k * k) / d
          : (REPULSION * k * k * minD) / (d * d)
        const fx = (dx / d) * force
        const fy = (dy / d) * force
        const da = disp.get(a.id)!
        const db = disp.get(b.id)!
        da.x += fx
        da.y += fy
        db.x -= fx
        db.y -= fy
      }
    }

    // 引力：沿关系边（线性引力，避免链式结构被拉成一条直线）
    for (const r of rels) {
      if (!adj.has(r.sourceTableId) || !adj.has(r.targetTableId)) continue
      const pa = pos.get(r.sourceTableId)!
      const pb = pos.get(r.targetTableId)!
      const dx = pa.x - pb.x
      const dy = pa.y - pb.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const force = ATTRACTION * d / k
      const fx = (dx / d) * force
      const fy = (dy / d) * force
      const ds = disp.get(r.sourceTableId)!
      const dt = disp.get(r.targetTableId)!
      ds.x -= fx
      ds.y -= fy
      dt.x += fx
      dt.y += fy
    }

    // 更新位置，限制单步最大位移为当前温度
    const temp = maxTemp * (1 - iter / maxIter)
    for (const t of tables) {
      const p = pos.get(t.id)!
      const d = disp.get(t.id)!
      const dist = Math.sqrt(d.x * d.x + d.y * d.y) || 1
      const lim = Math.min(dist, temp)
      p.x += (d.x / dist) * lim
      p.y += (d.y / dist) * lim
    }
  }

  // 去重叠后处理：沿最小重叠方向把重叠的节点对推开，直到互不重叠
  const SEP_GAP = NODE_GAP
  for (let iter = 0; iter < 200; iter++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = tables[i]
        const b = tables[j]
        const pa = pos.get(a.id)!
        const pb = pos.get(b.id)!
        const sa = sizes.get(a.id)!
        const sb = sizes.get(b.id)!
        // 两矩形在 x/y 方向的重叠量
        const overlapX = (sa.w + sb.w) / 2 + SEP_GAP - Math.abs(pa.x - pb.x)
        const overlapY = (sa.h + sb.h) / 2 + SEP_GAP - Math.abs(pa.y - pb.y)
        if (overlapX <= 0 || overlapY <= 0) continue
        // 沿重叠量较小的方向分离，移动量最小
        if (overlapX < overlapY) {
          const dir = pa.x >= pb.x ? 1 : -1
          pa.x += dir * overlapX / 2
          pb.x -= dir * overlapX / 2
        } else {
          const dir = pa.y >= pb.y ? 1 : -1
          pa.y += dir * overlapY / 2
          pb.y -= dir * overlapY / 2
        }
        moved = true
      }
    }
    if (!moved) break
  }

  // 归一化：计算节点包围盒，水平居中到画布、垂直从顶部开始
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const t of tables) {
    const p = pos.get(t.id)!
    const s = sizes.get(t.id)!
    minX = Math.min(minX, p.x - s.w / 2)
    maxX = Math.max(maxX, p.x + s.w / 2)
    minY = Math.min(minY, p.y - s.h / 2)
    maxY = Math.max(maxY, p.y + s.h / 2)
  }
  const graphW = maxX - minX
  const graphH = maxY - minY
  const offsetX = width / 2 - (minX + graphW / 2)
  const offsetY = 40 - minY

  const nodes = tables.map((t) => {
    const p = pos.get(t.id)!
    const h = computeNodeHeight(t, rels)
    return {
      id: t.id,
      position: { x: p.x + offsetX - NODE_WIDTH / 2, y: p.y + offsetY - h / 2 },
    }
  })
  const edges = rels.map((r) => ({ id: r.id, source: r.sourceTableId, target: r.targetTableId }))
  return { nodes, edges }
}
