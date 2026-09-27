/**
 * 画布图操作（纯函数）：业务模型 draft.graph 的节点/连线增删改。
 *
 * 注意状态职责划分（见 CanvasEditor）：
 * - 画布交互状态（拖拽位置、measured、选中）由 ReactFlow 的 useNodesState/useEdgesState 持有；
 * - 本模块只操作**业务模型**，不参与 ReactFlow 内部状态重建——
 *   若每轮从业务模型重建视图节点会丢掉 measured，导致点击/拖拽失效。
 */
import type { PluginWorkflowNodeType } from '@workavatar/plugin-sdk'
import type { WorkflowGraph, WorkflowNode, WorkflowNodeData } from '../shared/types'
import { defaultNodeData } from './node-catalog'

/** 新建节点的画布位置：按数量阶梯排布，避免完全重叠 */
export function spawnPosition(index: number): { x: number; y: number } {
  return { x: 120 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 140 }
}

/** 生成图内唯一节点 id（不复用已删除节点的序号） */
export function nextNodeId(graph: WorkflowGraph): string {
  const used = new Set((graph.nodes || []).map(n => n.id))
  let i = (graph.nodes || []).length + 1
  while (used.has(`node${i}`)) i++
  return `node${i}`
}

/** 追加节点 */
export function addNodeToGraph(
  graph: WorkflowGraph,
  type: PluginWorkflowNodeType,
  label: string,
): WorkflowGraph {
  const id = nextNodeId(graph)
  const node: WorkflowNode = {
    id,
    type,
    position: spawnPosition((graph.nodes || []).length),
    data: defaultNodeData(type, label),
  }
  return { ...graph, nodes: [...(graph.nodes || []), node] }
}

/** 删除节点，并清理其关联连线 */
export function deleteNodeFromGraph(graph: WorkflowGraph, id: string): WorkflowGraph {
  return {
    ...graph,
    nodes: (graph.nodes || []).filter(n => n.id !== id),
    edges: (graph.edges || []).filter(e => e.source !== id && e.target !== id),
  }
}

/** 更新单个节点的 data 字段 */
export function patchNodeData(
  graph: WorkflowGraph,
  id: string,
  patch: Partial<WorkflowNodeData>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: (graph.nodes || []).map(n => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
  }
}

/** 新增连线（默认走默认分支；条件分支由 EdgeInspector 事后标注） */
export function addEdgeToGraph(
  graph: WorkflowGraph,
  id: string,
  source: string,
  target: string,
  when?: string,
): WorkflowGraph {
  return {
    ...graph,
    edges: [...(graph.edges || []), { id, source, target, when }],
  }
}

/** 更新连线分支标签 */
export function patchEdge(graph: WorkflowGraph, id: string, patch: Partial<WorkflowGraph['edges'][number]>): WorkflowGraph {
  return {
    ...graph,
    edges: (graph.edges || []).map(e => (e.id === id ? { ...e, ...patch } : e)),
  }
}

/** 删除连线 */
export function deleteEdgeFromGraph(graph: WorkflowGraph, id: string): WorkflowGraph {
  return { ...graph, edges: (graph.edges || []).filter(e => e.id !== id) }
}

/** 把画布上的节点位置合并回业务模型（拖拽结束后调用） */
export function applyPositions(
  graph: WorkflowGraph,
  positions: Map<string, { x: number; y: number }>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: (graph.nodes || []).map(n => ({
      ...n,
      position: positions.get(n.id) ?? n.position,
    })),
  }
}
