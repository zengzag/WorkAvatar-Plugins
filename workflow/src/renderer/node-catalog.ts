/** 节点目录：节点类型清单、配色与默认数据 */
import type { PluginWorkflowNodeType } from '@workavatar/plugin-sdk'
import type { WorkflowNodeData } from '../shared/types'

export interface NodeCatalogItem {
  type: PluginWorkflowNodeType
  /** 默认节点名（i18n key） */
  labelKey: string
  descKey: string
  /** 是否作为流程起点使用（仅作画布提示） */
  isEntry?: boolean
}

/** 节点库清单（顺序即左侧面板展示顺序） */
export const NODE_CATALOG: NodeCatalogItem[] = [
  { type: 'input', labelKey: 'node.input', descKey: 'node.inputDesc', isEntry: true },
  { type: 'agent', labelKey: 'node.agent', descKey: 'node.agentDesc' },
  { type: 'review', labelKey: 'node.review', descKey: 'node.reviewDesc' },
  { type: 'condition', labelKey: 'node.condition', descKey: 'node.conditionDesc' },
  { type: 'loop', labelKey: 'node.loop', descKey: 'node.loopDesc' },
  { type: 'parallel', labelKey: 'node.parallel', descKey: 'node.parallelDesc' },
  { type: 'human', labelKey: 'node.human', descKey: 'node.humanDesc' },
  { type: 'tool', labelKey: 'node.tool', descKey: 'node.toolDesc' },
  { type: 'end', labelKey: 'node.end', descKey: 'node.endDesc' },
]

/** 类型配色：节点徽标与画布上的类型区分（中性 + 品牌为主，语义色仅用于评审/循环） */
export const NODE_COLORS: Record<string, string> = {
  input: '#8c8c8c',
  agent: '#1677ff',
  review: '#faad14',
  condition: '#722ed1',
  loop: '#13c2c2',
  parallel: '#2f54eb',
  human: '#eb2f96',
  tool: '#595959',
  end: '#52c41a',
}

/** 新建节点的默认数据 */
export function defaultNodeData(type: PluginWorkflowNodeType, label: string): WorkflowNodeData {
  const data: WorkflowNodeData = { label }
  if (type === 'loop') data.maxRounds = 3
  return data
}
