/**
 * 模板任务插件的领域类型（画布数据模型）。
 * 运行期会转换为宿主 plugin-sdk 的 PluginWorkflowGraphSpec。
 */
import type { PluginWorkflowNodeType } from '@workavatar/plugin-sdk'

/** 运行入参声明 */
export interface WorkflowVariable {
  name: string
  /** 运行时展示在标题提示图标里的说明 */
  description?: string
  /** 运行时的默认值；填写后该参数可留空直接运行 */
  defaultValue?: string
}

/** 节点上的临时角色（仅在模板运行期存在的数字员工） */
export interface EphemeralRole {
  key: string
  name: string
  systemPrompt: string
  tools?: string[]
  skills?: string[]
}

/** 画布节点 */
export interface WorkflowNodeData {
  label: string
  /** 正式数字员工 id（与 ephemeralRole 二选一） */
  employeeId?: string
  ephemeralRole?: EphemeralRole
  /** 节点级模型覆盖（providerId+modelId 成对生效）；留空则用运行级选择 / 全局默认模型 */
  providerId?: string
  modelId?: string
  /** 任务指令模板，支持 {{变量}} / {{节点id}} 插值 */
  instruction?: string
  /** loop 节点：最大回环轮次 */
  maxRounds?: number
  /** loop 节点：循环体起点节点 id */
  loopTargetId?: string
  [key: string]: unknown
}

export interface WorkflowNode {
  id: string
  type: PluginWorkflowNodeType
  position: { x: number; y: number }
  data: WorkflowNodeData
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  /** 分支标签：pass / fail / 自定义；空为默认分支 */
  when?: string
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  entryNodeId?: string
}

export interface WorkflowTemplate {
  id: string
  name: string
  description?: string
  variables: WorkflowVariable[]
  graph: WorkflowGraph
  createdAt: number
  updatedAt: number
}
