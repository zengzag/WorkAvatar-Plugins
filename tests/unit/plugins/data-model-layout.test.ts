import { describe, it, expect } from 'vitest'
import { layoutTables, computeNodeHeight, NODE_WIDTH } from '../../../data-model/src/renderer/canvas/dagre-layout'
import { createTable, createField, createRelationship, createDataModel, type DataModel } from '../../../data-model/src/shared/domain'

/** 构造一个线性链式模型（旧 dagre LR 会堆成一列，用于验证力导向铺开） */
function buildChainModel(count: number): DataModel {
  const tables = Array.from({ length: count }, (_, i) =>
    createTable({
      name: `t${i}`,
      fields: [
        createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false }),
        createField({ name: 'name', type: 'varchar', typeLength: '100' }),
      ],
    })
  )
  const rels = []
  for (let i = 0; i < count - 1; i++) {
    const src = tables[i]
    const dst = tables[i + 1]
    rels.push(createRelationship({
      sourceTableId: src.id,
      sourceFieldId: src.fields[0].id,
      targetTableId: dst.id,
      targetFieldId: dst.fields[0].id,
    }))
  }
  return createDataModel({ name: 'chain', tables, relationships: rels })
}

/** 构造一个星型模型：中心表连接多个外围表（真实 ER 常见结构） */
function buildStarModel(leafCount: number): DataModel {
  const center = createTable({
    name: 'center',
    fields: [
      createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false }),
      createField({ name: 'name', type: 'varchar', typeLength: '100' }),
    ],
  })
  const tables = [center]
  const rels = []
  for (let i = 0; i < leafCount; i++) {
    const leaf = createTable({
      name: `leaf${i}`,
      fields: [
        createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false }),
        createField({ name: 'center_id', type: 'bigint' }),
        createField({ name: 'name', type: 'varchar', typeLength: '100' }),
      ],
    })
    tables.push(leaf)
    rels.push(createRelationship({
      sourceTableId: center.id,
      sourceFieldId: center.fields[0].id,
      targetTableId: leaf.id,
      targetFieldId: leaf.fields[1].id,
    }))
  }
  return createDataModel({ name: 'star', tables, relationships: rels })
}

/** 构造一个混合模型：多个星型中心 + 中心间链式连接（表多、关系密集） */
function buildMixedModel(): DataModel {
  const tables: ReturnType<typeof createTable>[] = []
  const rels: ReturnType<typeof createRelationship>[] = []
  const centers: ReturnType<typeof createTable>[] = []
  for (let c = 0; c < 4; c++) {
    const center = createTable({
      name: `hub${c}`,
      fields: [
        createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false }),
        createField({ name: 'name', type: 'varchar', typeLength: '100' }),
      ],
    })
    tables.push(center)
    centers.push(center)
    for (let l = 0; l < 4; l++) {
      const leaf = createTable({
        name: `hub${c}_leaf${l}`,
        fields: [
          createField({ name: 'id', type: 'bigint', primaryKey: true, nullable: false }),
          createField({ name: 'hub_id', type: 'bigint' }),
          createField({ name: 'name', type: 'varchar', typeLength: '100' }),
        ],
      })
      tables.push(leaf)
      rels.push(createRelationship({
        sourceTableId: center.id,
        sourceFieldId: center.fields[0].id,
        targetTableId: leaf.id,
        targetFieldId: leaf.fields[1].id,
      }))
    }
  }
  // 中心之间链式连接
  for (let c = 0; c < centers.length - 1; c++) {
    rels.push(createRelationship({
      sourceTableId: centers[c].id,
      sourceFieldId: centers[c].fields[0].id,
      targetTableId: centers[c + 1].id,
      targetFieldId: centers[c + 1].fields[0].id,
    }))
  }
  return createDataModel({ name: 'mixed', tables, relationships: rels })
}

/** 判断两个节点矩形是否重叠（含间距容差） */
function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
  gap: number
): boolean {
  return (
    ax < bx + bw + gap &&
    bx < ax + aw + gap &&
    ay < by + bh + gap &&
    by < ay + ah + gap
  )
}

/** 统计布局中重叠的节点对数量 */
function countOverlaps(model: DataModel, width: number, gap = 10): number {
  const { nodes } = layoutTables(model, width)
  const heights = new Map<string, number>()
  for (const t of model.tables) heights.set(t.id, computeNodeHeight(t, model.relationships))
  let count = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      if (rectsOverlap(
        a.position.x, a.position.y, NODE_WIDTH, heights.get(a.id)!,
        b.position.x, b.position.y, NODE_WIDTH, heights.get(b.id)!,
        gap
      )) count++
    }
  }
  return count
}

describe('data-model 画布自动布局', () => {
  it('为所有表生成位置', () => {
    const model = buildChainModel(5)
    const { nodes, edges } = layoutTables(model, 800)
    expect(nodes.length).toBe(5)
    expect(edges.length).toBe(4)
    for (const n of nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true)
      expect(Number.isFinite(n.position.y)).toBe(true)
    }
  })

  it('链式模型在二维平面铺开，而非堆成一列', () => {
    const model = buildChainModel(12)
    const { nodes } = layoutTables(model, 800)
    const xs = nodes.map((n) => n.position.x)
    const ys = nodes.map((n) => n.position.y)
    const xSpan = Math.max(...xs) - Math.min(...xs)
    const ySpan = Math.max(...ys) - Math.min(...ys)
    expect(xSpan).toBeGreaterThan(NODE_WIDTH * 1.5)
    expect(ySpan).toBeGreaterThan(NODE_WIDTH * 1.5)
    expect(xSpan).toBeLessThan(NODE_WIDTH * 12)
    expect(ySpan).toBeLessThan(NODE_WIDTH * 12)
  })

  it('链式模型节点不重叠', () => {
    const model = buildChainModel(12)
    const overlaps = countOverlaps(model, 800)
    console.log('chain12 overlaps', overlaps)
    expect(overlaps).toBe(0)
  })

  it('星型模型节点不重叠', () => {
    const model = buildStarModel(8)
    const overlaps = countOverlaps(model, 800)
    expect(overlaps).toBe(0)
  })

  it('混合模型（20 表）节点不重叠', () => {
    const model = buildMixedModel()
    expect(model.tables.length).toBe(20)
    const overlaps = countOverlaps(model, 800)
    expect(overlaps).toBe(0)
  })

  it('空模型返回空结果', () => {
    const model = createDataModel({ name: 'empty', tables: [], relationships: [] })
    const { nodes, edges } = layoutTables(model, 800)
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
  })

  it('computeNodeHeight 折叠时按可见字段计算', () => {
    const table = createTable({
      name: 't',
      expanded: false,
      fields: [
        createField({ name: 'id', type: 'bigint', primaryKey: true }),
        createField({ name: 'a', type: 'varchar' }),
        createField({ name: 'b', type: 'varchar' }),
      ],
    })
    const rel = createRelationship({
      sourceTableId: table.id,
      sourceFieldId: table.fields[0].id,
      targetTableId: 'other',
      targetFieldId: 'x',
    })
    const h = computeNodeHeight(table, [rel])
    expect(h).toBeGreaterThan(36)
    expect(h).toBeLessThan(36 + 3 * 24 + 8)
  })
})
