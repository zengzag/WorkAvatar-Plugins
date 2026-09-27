/**
 * 画布图操作单测（业务模型层）。
 *
 * 说明：画布交互本身（点击添加、拖拽、选中）依赖 ReactFlow 内部状态，
 * 已通过浏览器实机验证覆盖；此处锁定业务模型层面的图操作契约，
 * 避免「节点库点击无反应」这类回归（根因曾是视图节点每轮重建导致交互失效）。
 */
import { describe, it, expect } from 'vitest'
import {
  addNodeToGraph,
  applyPositions,
  deleteEdgeFromGraph,
  deleteNodeFromGraph,
  nextNodeId,
  patchNodeData,
  spawnPosition,
} from '../../workflow/src/renderer/graph-ops'

const empty = (): import('../../workflow/src/shared/types').WorkflowGraph => ({ nodes: [], edges: [] })

describe('画布图操作 / 节点', () => {
  it('添加节点：id 依次递增且类型正确', () => {
    let g = empty()
    g = addNodeToGraph(g, 'input', '输入')
    g = addNodeToGraph(g, 'agent', '智能体')
    g = addNodeToGraph(g, 'end', '结束')
    expect(g.nodes.map(n => n.id)).toEqual(['node1', 'node2', 'node3'])
    expect(g.nodes.map(n => n.type)).toEqual(['input', 'agent', 'end'])
  })

  it('添加节点：位置阶梯排布，不会完全重叠', () => {
    let g = empty()
    for (let i = 0; i < 4; i++) g = addNodeToGraph(g, 'agent', 'A')
    expect(new Set(g.nodes.map(n => `${n.position.x},${n.position.y}`)).size).toBeGreaterThan(1)
  })

  it('nextNodeId 不复用已删除节点的序号', () => {
    let g = addNodeToGraph(empty(), 'agent', 'A')
    g = addNodeToGraph(g, 'agent', 'B')
    g = deleteNodeFromGraph(g, 'node1')
    expect(nextNodeId(g)).toBe('node3')
  })

  it('删除节点同时清理关联连线', () => {
    let g = addNodeToGraph(empty(), 'agent', 'A')
    g = addNodeToGraph(g, 'end', 'B')
    g = { ...g, edges: [{ id: 'e1', source: 'node1', target: 'node2' }] }
    g = deleteNodeFromGraph(g, 'node1')
    expect(g.nodes.map(n => n.id)).toEqual(['node2'])
    expect(g.edges).toHaveLength(0)
  })

  it('patchNodeData 只改目标节点且保留其它字段', () => {
    let g = addNodeToGraph(empty(), 'agent', 'A')
    g = addNodeToGraph(g, 'end', 'B')
    g = patchNodeData(g, 'node1', { instruction: '写指南', employeeId: 'emp1' })
    expect(g.nodes[0].data.instruction).toBe('写指南')
    expect(g.nodes[0].data.employeeId).toBe('emp1')
    expect(g.nodes[0].data.label).toBe('A')
    expect(g.nodes[1].data.instruction).toBeUndefined()
  })

  it('applyPositions 写回拖拽后的坐标', () => {
    let g = addNodeToGraph(empty(), 'agent', 'A')
    g = applyPositions(g, new Map([['node1', { x: 500, y: 320 }]]))
    expect(g.nodes[0].position).toEqual({ x: 500, y: 320 })
  })

  it('applyPositions 对未提供坐标的节点保持原位置', () => {
    const g = applyPositions(
      { nodes: [{ id: 'node1', type: 'agent', position: { x: 1, y: 2 }, data: { label: 'A' } }], edges: [] },
      new Map(),
    )
    expect(g.nodes[0].position).toEqual({ x: 1, y: 2 })
  })

  it('spawnPosition 对同一 index 稳定', () => {
    expect(spawnPosition(0)).toEqual(spawnPosition(0))
    expect(spawnPosition(1)).not.toEqual(spawnPosition(0))
  })
})

describe('画布图操作 / 连线', () => {
  it('删除连线', () => {
    const g = deleteEdgeFromGraph(
      { nodes: [], edges: [{ id: 'e1', source: 'a', target: 'b' }] },
      'e1',
    )
    expect(g.edges).toHaveLength(0)
  })
})
