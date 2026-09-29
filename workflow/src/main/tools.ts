/**
 * 模板任务的 agent 工具集：让数字员工（LLM）能够自动化创建/修改/校验模板。
 *
 * 设计取舍：
 * - 不用「整份 graph 一次性覆盖」，而是提供「建模板 → 加节点 → 连线 → 存盘」的增量工具，
 *   LLM 每步都能拿到回读结果（id / 当前结构），显著降低一次生成大 JSON 的出错率。
 * - 单独提供 validate 工具，让 LLM 在运行前自查「缺角色 / 死循环 / 分支缺失」等常见问题。
 */
import type { PluginToolDefinition, PluginWorkflowRun } from '@workavatar/plugin-sdk'
import type { WorkflowGraph, WorkflowTemplate, WorkflowVariable } from '../shared/types'

/** 工具集对存储层与运行能力的依赖（由主进程注入，便于单测） */
export interface WorkflowToolDeps {
  listTemplates(): WorkflowTemplate[]
  getTemplate(id: string): WorkflowTemplate | null
  saveTemplate(input: Partial<WorkflowTemplate> & { name?: string }): WorkflowTemplate
  deleteTemplate(id: string): void
  /** 当前真实存在的数字员工 id（校验 employeeId，防 LLM 臆造；缺省则跳过校验） */
  listEmployeeIds?(): Promise<string[]>
  /** 启动一次模板运行（由主进程注入内核编排能力；缺省表示当前环境不支持直接运行） */
  runTemplate?(template: WorkflowTemplate, variables: Record<string, string>): Promise<{ run?: PluginWorkflowRun; error?: string }>
}

const NODE_TYPES = ['input', 'agent', 'review', 'condition', 'loop', 'parallel', 'human', 'tool', 'end'] as const

/** 运行入参声明的 JSON Schema（create/update 共用） */
const VARIABLE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '参数名（在指令中用 {{参数名}} 引用）' },
    description: { type: 'string', description: '运行时展示在参数标题提示图标里的说明' },
    defaultValue: { type: 'string', description: '运行时的默认值；填写后该参数可留空直接运行' },
  },
  required: ['name'],
}

/** 规范化入参声明：仅保留 name/description/defaultValue，丢弃空名行 */
function normalizeVariables(input: unknown): WorkflowVariable[] {
  if (!Array.isArray(input)) return []
  const out: WorkflowVariable[] = []
  for (const raw of input) {
    const item = (raw || {}) as WorkflowVariable
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!name) continue
    const variable: WorkflowVariable = { name }
    if (item.description != null) variable.description = String(item.description)
    if (item.defaultValue != null) variable.defaultValue = String(item.defaultValue)
    out.push(variable)
  }
  return out
}

/** 生成图内唯一节点 id */
function nextNodeId(graph: WorkflowGraph): string {
  const used = new Set((graph.nodes || []).map(n => n.id))
  let i = (graph.nodes || []).length + 1
  while (used.has(`node${i}`)) i++
  return `node${i}`
}

/** 新节点的排布位置（与画布一致：阶梯排布避免完全重叠） */
function spawnPosition(index: number): { x: number; y: number } {
  return { x: 120 + (index % 4) * 220, y: 80 + Math.floor(index / 4) * 140 }
}

/**
 * 校验流程图：返回问题列表（空数组代表通过）。
 * 覆盖 LLM 生成流程时最常见的结构性错误。
 * @param existingEmployeeIds 传入时额外核对节点引用的数字员工是否真实存在
 */
export function validateGraph(graph: WorkflowGraph, existingEmployeeIds?: string[]): string[] {
  const problems: string[] = []
  const nodes = graph.nodes || []
  const edges = graph.edges || []
  if (nodes.length === 0) return ['流程为空：至少需要一个节点']

  const ids = new Set<string>()
  const byId = new Map<string, WorkflowGraph['nodes'][number]>()
  for (const node of nodes) {
    if (ids.has(node.id)) problems.push(`节点 id 重复：${node.id}`)
    ids.add(node.id)
    byId.set(node.id, node)
    if (!NODE_TYPES.includes(node.type)) problems.push(`节点 ${node.id} 类型非法：${node.type}`)
    if (node.type === 'agent' || node.type === 'review') {
      const role = node.data?.ephemeralRole
      if (!node.data?.employeeId && !(role?.name && role.systemPrompt)) {
        problems.push(`节点「${node.data?.label || node.id}」缺少角色：需指定数字员工 employeeId，或提供临时角色（name + systemPrompt）`)
      }
      if (!String(node.data?.instruction || '').trim()) {
        problems.push(`节点「${node.data?.label || node.id}」缺少任务指令 instruction`)
      }
      const employeeId = String(node.data?.employeeId || '')
      if (employeeId && existingEmployeeIds && !existingEmployeeIds.includes(employeeId)) {
        problems.push(`节点「${node.data?.label || node.id}」引用的数字员工不存在：${employeeId}（用 list_employees 查询有效 id，或改用临时角色）`)
      }
    }
    if (node.type === 'condition' && !String(node.data?.instruction || '').trim()) {
      problems.push(`条件节点「${node.data?.label || node.id}」缺少条件表达式 instruction`)
    }
    if (node.type === 'review') {
      const outgoing = edges.filter(e => e.source === node.id)
      const hasPass = outgoing.some(e => e.when === 'pass')
      const hasFail = outgoing.some(e => e.when === 'fail')
      if (outgoing.length > 0 && !hasPass) problems.push(`评审节点「${node.data?.label || node.id}」缺少 pass 分支出边`)
      if (!hasFail && !outgoing.some(e => !e.when)) {
        problems.push(`评审节点「${node.data?.label || node.id}」缺少 fail 分支（迭代回写需 fail 回边或默认出边）`)
      }
    }
    if (node.type === 'condition') {
      const outgoing = edges.filter(e => e.source === node.id)
      if (outgoing.length > 1) {
        const hasPass = outgoing.some(e => e.when === 'pass')
        const hasFail = outgoing.some(e => e.when === 'fail')
        if (!hasPass || !hasFail) {
          problems.push(`条件节点「${node.data?.label || node.id}」有多条出边时必须分别标注 when=pass 与 when=fail`)
        }
      }
    }
    if (node.type === 'loop' && !(Number(node.data?.maxRounds) > 0)) {
      problems.push(`循环节点「${node.data?.label || node.id}」未设置有效 maxRounds`)
    }
  }

  for (const edge of edges) {
    if (!ids.has(edge.source)) problems.push(`连线起点节点不存在：${edge.source}`)
    if (!ids.has(edge.target)) problems.push(`连线终点节点不存在：${edge.target}`)
    const source = byId.get(edge.source)
    if (edge.when && source) {
      const conditional = source.type === 'review' || source.type === 'condition'
      const label = source.data?.label || source.id
      if (!conditional) {
        problems.push(`节点「${label}」不是评审/条件节点，出边不能带分支标签「${edge.when}」（普通节点只走默认分支，标签会导致流程中断）`)
      } else if (edge.when !== 'pass' && !edge.when.startsWith('fail')) {
        problems.push(`节点「${label}」的分支标签「${edge.when}」无法匹配结论（仅支持 pass 或以 fail 开头的标签）`)
      }
    }
  }

  const targets = new Set(edges.map(e => e.target))
  const entries = nodes.filter(n => !targets.has(n.id))
  if (entries.length === 0) problems.push('未找到入口节点（所有节点都有入边，疑似成环）')
  if (entries.length > 1) {
    problems.push(`存在多个入口节点（${entries.map(n => n.id).join(', ')}）：如需并行请显式使用 parallel 节点`)
  }
  return problems
}

/** 构建工具集（依赖注入） */
export function createWorkflowTools(deps: WorkflowToolDeps): PluginToolDefinition[] {
  return [
    {
      id: 'workflow_list_templates',
      name: 'workflow_list_templates',
      title: '列出模板任务模板',
      summary: '列出已有模板任务模板（id / 名称 / 节点数）',
      description: [
        '列出当前所有模板任务（Workflow）模板及其 id、名称、节点与连线数量。',
        '在创建新模板前先用本工具查看是否已有可复用模板，避免重复创建。',
      ].join('\n'),
      parameters: { type: 'object', properties: {} },
      permission: 'safe',
      handler: () => ({
        templates: deps.listTemplates().map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          nodes: (t.graph?.nodes || []).length,
          edges: (t.graph?.edges || []).length,
          variables: (t.variables || []).map(v => v.name),
        })),
      }),
    },
    {
      id: 'workflow_get_template',
      name: 'workflow_get_template',
      title: '读取模板详情',
      summary: '按 id 读取模板的完整结构（节点/连线/入参）',
      description: [
        '按 templateId 读取模板的完整定义：节点（id/type/label/角色/指令）、连线（when 分支标签）与运行入参。',
        '修改模板前先用本工具读取现状，再基于返回的 id 做增量修改。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: { templateId: { type: 'string', description: '模板 id（来自 workflow_list_templates）' } },
        required: ['templateId'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        return { success: true, template }
      },
    },
    {
      id: 'workflow_create_template',
      name: 'workflow_create_template',
      title: '创建空模板',
      summary: '创建一个空模板并返回 templateId',
      description: [
        '创建一个新的空模板任务模板，返回 templateId；随后用 workflow_add_node / workflow_add_edge 逐步搭建流程。',
        'variables 声明运行入参：name 为参数名（节点指令里用 {{参数名}} 引用）、description 为运行时的提示说明、defaultValue 为默认值（填了则运行时该参数可留空）。',
        '推荐流程：create_template → add_node(输入) → add_node(智能体/评审) → add_edge → validate_template → 交用户确认运行或直接 workflow_run_template。',
        '入参或名称后续要改，用 workflow_update_template。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '模板名称' },
          description: { type: 'string', description: '模板用途说明' },
          variables: {
            type: 'array',
            description: '运行入参声明',
            items: VARIABLE_ITEM_SCHEMA,
          },
        },
        required: ['name'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.saveTemplate({
          name: String(args.name || '').trim() || 'Untitled',
          description: String(args.description || ''),
          variables: normalizeVariables(args.variables),
          graph: { nodes: [], edges: [] },
        })
        return { success: true, templateId: template.id, template }
      },
    },
    {
      id: 'workflow_update_template',
      name: 'workflow_update_template',
      title: '修改模板信息',
      summary: '更新模板的名称/说明/运行入参（只传要改的字段）',
      description: [
        '按 templateId 更新模板级字段：name / description / variables（运行入参声明）。',
        '只传需要修改的字段，未传的字段保持不变；variables 为整体替换。',
        'variables 每项含 name（指令中 {{参数名}} 引用）、description（运行时提示）、defaultValue（默认值）。',
        '典型场景：用户补充了输入要求后，用本工具补齐 variables，再让节点指令用 {{参数名}} 引用。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          name: { type: 'string', description: '模板名称' },
          description: { type: 'string', description: '模板用途说明' },
          variables: {
            type: 'array',
            description: '运行入参声明（整体替换）',
            items: VARIABLE_ITEM_SCHEMA,
          },
        },
        required: ['templateId'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const patch: Partial<WorkflowTemplate> = {}
        if (args.name !== undefined) patch.name = String(args.name).trim() || template.name
        if (args.description !== undefined) patch.description = String(args.description)
        if (args.variables !== undefined) patch.variables = normalizeVariables(args.variables)
        const saved = deps.saveTemplate({ ...template, ...patch })
        return { success: true, template: saved }
      },
    },
    {
      id: 'workflow_add_node',
      name: 'workflow_add_node',
      title: '向模板添加节点',
      summary: '添加节点（输入/智能体/评审/条件/循环/结束等）',
      description: [
        '向指定模板追加一个节点，返回该节点 id（后续连线与指令引用都用它）。',
        `type 取值：${NODE_TYPES.join(' / ')}。`,
        '角色二选一：employeeId（已有数字员工 id，必须先用 list_employees 查询，臆造 id 会被拒绝）或 ephemeralRole（本模板专用的临时角色，需 name + systemPrompt）。',
        'ephemeralRole.tools 一般留空（使用默认工具集）；确需指定时先用 list_available_tools 查工具 id。',
        '评审节点（review）请把「评审标准」写进 instruction，结论将由 LLM 以 FINAL_VERDICT: PASS/FAIL 形式给出，据此走出边分支。',
        '条件节点（condition）的 instruction 写条件表达式（引用 {{上游节点id}}，结果为 pass/fail 时分别走对应分支）。',
        '循环节点（loop）必须给 maxRounds；智能体/评审节点必须给 instruction。参数不合法会直接返回 error，请按提示修正后重试。',
        'parallel / human / tool 节点当前按顺序执行降级，优先用 agent / review / condition 表达流程。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          type: { type: 'string', description: `${NODE_TYPES.join(' / ')}` },
          label: { type: 'string', description: '节点名称（展示用，如「撰写指南」）' },
          instruction: { type: 'string', description: '任务指令；可用 {{运行入参}} 与 {{上游节点id}} 引用数据' },
          employeeId: { type: 'string', description: '数字员工 id（与 ephemeralRole 二选一）' },
          ephemeralRole: {
            type: 'object',
            description: '本模板专用的临时角色（不落员工库）',
            properties: {
              name: { type: 'string', description: '角色名称，如「形式审查专家」' },
              systemPrompt: { type: 'string', description: '角色系统提示词：职责、评审维度、输出要求' },
              tools: { type: 'array', items: { type: 'string' }, description: '可用工具 id 列表（可选）' },
            },
            required: ['name', 'systemPrompt'],
          },
          maxRounds: { type: 'number', description: '循环节点最大轮次（loop 必填）' },
        },
        required: ['templateId', 'type', 'label'],
      },
      permission: 'safe',
      handler: async (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const type = String(args.type || '')
        if (!NODE_TYPES.includes(type as never)) return { success: false, error: `节点类型非法: ${type}` }
        const instruction = args.instruction ? String(args.instruction) : undefined
        const employeeId = args.employeeId ? String(args.employeeId) : undefined
        const ephemeralRole = args.ephemeralRole
          ? (args.ephemeralRole as WorkflowGraph['nodes'][number]['data']['ephemeralRole'])
          : undefined
        const maxRounds = args.maxRounds != null ? Number(args.maxRounds) : undefined

        if (employeeId && ephemeralRole) {
          return { success: false, error: 'employeeId 与 ephemeralRole 只能二选一' }
        }
        if (ephemeralRole && (!String(ephemeralRole.name || '').trim() || !String(ephemeralRole.systemPrompt || '').trim())) {
          return { success: false, error: 'ephemeralRole 不完整：需要 name（角色名称）与 systemPrompt（角色提示词）' }
        }
        if (employeeId && deps.listEmployeeIds) {
          const known = await deps.listEmployeeIds()
          if (!known.includes(employeeId)) {
            return { success: false, error: `数字员工不存在: ${employeeId}（先用 list_employees 查询有效 id，或改用 ephemeralRole）` }
          }
        }
        if ((type === 'agent' || type === 'review') && !String(instruction || '').trim()) {
          return { success: false, error: `${type === 'review' ? '评审' : '智能体'}节点必须提供 instruction（任务指令）` }
        }
        if (type === 'condition' && !String(instruction || '').trim()) {
          return { success: false, error: '条件节点必须提供 instruction（条件表达式）' }
        }
        if (type === 'loop' && !(maxRounds! > 0)) {
          return { success: false, error: '循环节点必须提供 maxRounds（最大轮次，正整数）' }
        }

        const id = nextNodeId(template.graph)
        const node = {
          id,
          type: type as WorkflowGraph['nodes'][number]['type'],
          position: spawnPosition(template.graph.nodes.length),
          data: {
            label: String(args.label || id),
            instruction,
            employeeId,
            ephemeralRole,
            maxRounds,
          },
        }
        const saved = deps.saveTemplate({
          ...template,
          graph: { ...template.graph, nodes: [...template.graph.nodes, node] },
        })
        return { success: true, nodeId: id, node, totalNodes: saved.graph.nodes.length }
      },
    },
    {
      id: 'workflow_add_edge',
      name: 'workflow_add_edge',
      title: '连接两个节点',
      summary: '添加节点连线，可用 when 标注 pass/fail 分支',
      description: [
        '在 sourceId → targetId 之间添加一条有向连线。',
        'when 为分支标签：仅评审/条件节点的出边可用，取值 "pass" 或以 "fail" 开头（如 "fail"）；留空表示默认分支。',
        '实现「多轮迭代」的写法：评审节点出边 pass → 后续节点，出边 fail → 回到撰写节点上方插入的 loop 节点（loop 的 maxRounds 控制上限）。',
        '回写时引擎会自动把评审意见与该节点上一轮产出注入被回写的执行节点（无需在指令里手动引用评审节点），撰写节点指令只需说明「依据评审意见逐条修订」即可。',
        '标签加错或连线加错时，分别用 workflow_update_edge / workflow_delete_edge 修正，不要重复添加。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          sourceId: { type: 'string', description: '起点节点 id' },
          targetId: { type: 'string', description: '终点节点 id' },
          when: { type: 'string', description: '分支标签：pass / fail，留空为默认分支' },
        },
        required: ['templateId', 'sourceId', 'targetId'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const sourceId = String(args.sourceId || '')
        const targetId = String(args.targetId || '')
        const nodes = template.graph.nodes || []
        if (!nodes.some(n => n.id === sourceId)) return { success: false, error: `起点节点不存在: ${sourceId}` }
        if (!nodes.some(n => n.id === targetId)) return { success: false, error: `终点节点不存在: ${targetId}` }
        const when = args.when ? String(args.when).trim() : undefined
        const sourceNode = nodes.find(n => n.id === sourceId)!
        if (when) {
          const conditional = sourceNode.type === 'review' || sourceNode.type === 'condition'
          if (!conditional) return { success: false, error: `仅评审/条件节点的出边可设置分支标签：${sourceId}（${sourceNode.data?.label || ''}）是 ${sourceNode.type} 节点` }
          if (when !== 'pass' && !when.startsWith('fail')) return { success: false, error: `分支标签非法: ${when}（仅支持 pass 或以 fail 开头）` }
        }
        const dup = (template.graph.edges || []).some(
          e => e.source === sourceId && e.target === targetId && (e.when || undefined) === when,
        )
        if (dup) return { success: false, error: '相同起点/终点/分支标签的连线已存在' }
        const edge = { id: `e-${sourceId}-${targetId}-${Date.now()}`, source: sourceId, target: targetId, when }
        const saved = deps.saveTemplate({
          ...template,
          graph: { ...template.graph, edges: [...(template.graph.edges || []), edge] },
        })
        return { success: true, edgeId: edge.id, totalEdges: saved.graph.edges.length }
      },
    },
    {
      id: 'workflow_update_edge',
      name: 'workflow_update_edge',
      title: '修改连线分支',
      summary: '修改连线的分支标签 when（pass / fail / 清除）',
      description: [
        '按 edgeId 修改连线的分支标签 when：传 "pass" / "fail" 设置分支，传空字符串或 null 清除为默认分支。',
        '典型修复：validate 报「评审节点缺少 pass 分支出边」时，把已有默认出边改标为 pass，而不是重复加线。',
        'edgeId 来自 workflow_add_edge 的返回或 workflow_get_template 的 edges[].id。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          edgeId: { type: 'string', description: '连线 id' },
          when: { type: 'string', description: '分支标签：pass / fail；空字符串或 null 表示清除为默认分支' },
        },
        required: ['templateId', 'edgeId'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const edgeId = String(args.edgeId || '')
        const edges = template.graph.edges || []
        const edge = edges.find(e => e.id === edgeId)
        if (!edge) return { success: false, error: `连线不存在: ${edgeId}` }
        const when = args.when == null || args.when === '' ? undefined : String(args.when).trim() || undefined
        if (when) {
          const sourceNode = (template.graph.nodes || []).find(n => n.id === edge.source)
          const conditional = sourceNode?.type === 'review' || sourceNode?.type === 'condition'
          if (!conditional) return { success: false, error: `仅评审/条件节点的出边可设置分支标签（${edge.source} 是 ${sourceNode?.type} 节点）` }
          if (when !== 'pass' && !when.startsWith('fail')) return { success: false, error: `分支标签非法: ${when}（仅支持 pass 或以 fail 开头）` }
        }
        const saved = deps.saveTemplate({
          ...template,
          graph: { ...template.graph, edges: edges.map(e => (e.id === edgeId ? { ...e, when } : e)) },
        })
        return { success: true, edge: saved.graph.edges.find(e => e.id === edgeId) }
      },
    },
    {
      id: 'workflow_delete_edge',
      name: 'workflow_delete_edge',
      title: '删除连线',
      summary: '删除连线（修复误加的连线或成环问题）',
      description: [
        '按 edgeId 删除连线。用于修复 validate 报出的成环/多余分支等问题。',
        'edgeId 来自 workflow_add_edge 的返回或 workflow_get_template 的 edges[].id。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          edgeId: { type: 'string', description: '连线 id' },
        },
        required: ['templateId', 'edgeId'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const edgeId = String(args.edgeId || '')
        const edges = template.graph.edges || []
        if (!edges.some(e => e.id === edgeId)) return { success: false, error: `连线不存在: ${edgeId}` }
        const saved = deps.saveTemplate({
          ...template,
          graph: { ...template.graph, edges: edges.filter(e => e.id !== edgeId) },
        })
        return { success: true, remainingEdges: saved.graph.edges.length }
      },
    },
    {
      id: 'workflow_update_node',
      name: 'workflow_update_node',
      title: '修改节点',
      summary: '更新节点的名称/指令/角色/循环轮次',
      description: [
        '按 nodeId 更新节点的部分字段（label / instruction / employeeId / ephemeralRole / maxRounds）。只需传要修改的字段。',
        '切换角色：传 employeeId 会自动清除临时角色；传 ephemeralRole 会自动清除 employeeId（二者互斥）；ephemeralRole 传 null 表示清除临时角色。',
        'employeeId 必须来自 list_employees；临时角色需同时给 name 与 systemPrompt。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          nodeId: { type: 'string', description: '节点 id' },
          label: { type: 'string' },
          instruction: { type: 'string' },
          employeeId: { type: 'string', description: '数字员工 id（设置后清除临时角色）' },
          ephemeralRole: { type: 'object', description: '临时角色 {name, systemPrompt, tools?}（设置后清除 employeeId；传 null 清除）' },
          maxRounds: { type: 'number' },
        },
        required: ['templateId', 'nodeId'],
      },
      permission: 'safe',
      handler: async (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const nodeId = String(args.nodeId || '')
        if (!template.graph.nodes.some(n => n.id === nodeId)) return { success: false, error: `节点不存在: ${nodeId}` }
        const patch: Record<string, unknown> = {}
        for (const key of ['label', 'instruction', 'maxRounds'] as const) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        if (args.maxRounds !== undefined && !(Number(args.maxRounds) > 0)) {
          return { success: false, error: 'maxRounds 必须为正整数' }
        }
        if (args.employeeId !== undefined) {
          const employeeId = args.employeeId ? String(args.employeeId) : undefined
          if (employeeId && deps.listEmployeeIds) {
            const known = await deps.listEmployeeIds()
            if (!known.includes(employeeId)) {
              return { success: false, error: `数字员工不存在: ${employeeId}（先用 list_employees 查询有效 id，或改用 ephemeralRole）` }
            }
          }
          patch.employeeId = employeeId
          if (employeeId && args.ephemeralRole === undefined) patch.ephemeralRole = undefined
        }
        if (args.ephemeralRole !== undefined) {
          const role = args.ephemeralRole as WorkflowGraph['nodes'][number]['data']['ephemeralRole'] | null
          if (role === null) {
            patch.ephemeralRole = undefined
          } else if (role && String(role.name || '').trim() && String(role.systemPrompt || '').trim()) {
            patch.ephemeralRole = role
            if (args.employeeId === undefined) patch.employeeId = undefined
          } else {
            return { success: false, error: 'ephemeralRole 不完整：需要 name（角色名称）与 systemPrompt（角色提示词）' }
          }
        }
        const saved = deps.saveTemplate({
          ...template,
          graph: {
            ...template.graph,
            nodes: template.graph.nodes.map(n => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
          },
        })
        return { success: true, node: saved.graph.nodes.find(n => n.id === nodeId) }
      },
    },
    {
      id: 'workflow_delete_node',
      name: 'workflow_delete_node',
      title: '删除节点',
      summary: '删除节点并清理其关联连线',
      description: '按 nodeId 删除节点，同时清理所有引用该节点的连线（避免残留悬空边）。',
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id' },
          nodeId: { type: 'string', description: '节点 id' },
        },
        required: ['templateId', 'nodeId'],
      },
      permission: 'safe',
      handler: (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const nodeId = String(args.nodeId || '')
        const saved = deps.saveTemplate({
          ...template,
          graph: {
            nodes: template.graph.nodes.filter(n => n.id !== nodeId),
            edges: (template.graph.edges || []).filter(e => e.source !== nodeId && e.target !== nodeId),
          },
        })
        return { success: true, remainingNodes: saved.graph.nodes.length, remainingEdges: saved.graph.edges.length }
      },
    },
    {
      id: 'workflow_validate_template',
      name: 'workflow_validate_template',
      title: '校验模板流程',
      summary: '检查流程结构问题（缺角色/分支缺失/成环等）',
      description: [
        '校验指定模板的流程图结构，返回 problems 数组（为空表示通过）。',
        '检查项：空流程、节点 id 重复、类型非法、智能体/评审节点缺角色或缺指令、条件节点缺表达式、评审/条件节点分支标签缺失或非法、循环节点缺 maxRounds、连线悬空、无入口节点、多入口节点、引用不存在的数字员工。',
        '完成搭建后必须先调用本工具确认无问题，再告知用户可以运行；按 problems 逐条修复（改节点用 update_node，改标签用 update_edge，误加连线用 delete_edge）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: { templateId: { type: 'string', description: '模板 id' } },
        required: ['templateId'],
      },
      permission: 'safe',
      handler: async (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        const employeeIds = deps.listEmployeeIds ? await deps.listEmployeeIds() : undefined
        const problems = validateGraph(template.graph, employeeIds)
        return { success: problems.length === 0, problems }
      },
    },
    {
      id: 'workflow_run_template',
      name: 'workflow_run_template',
      title: '运行模板任务',
      summary: '按模板 id 直接启动一次运行，可同时传入运行入参',
      description: [
        '按 templateId 启动一次模板任务运行（后台执行），返回 runId 与 conversationId，可在任务页查看进度与产物。',
        'variables 为运行入参对象 { 参数名: 值 }：先用 workflow_get_template 查看模板声明的入参名，再逐个填写。',
        '未传或留空的参数会用模板里声明的 defaultValue 兜底；既无值又无默认值的必填参数会被拒绝，请先向用户确认取值。',
        '仅当用户明确要求运行时才调用；运行前会自动做结构校验，结构有问题会直接返回 problems 而不会跑出半截流程。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: '模板 id（来自 workflow_list_templates）' },
          variables: {
            type: 'object',
            description: '运行入参：{ 参数名: 值 }；缺省则使用模板默认值',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['templateId'],
      },
      permission: 'safe',
      handler: async (args) => {
        const template = deps.getTemplate(String(args.templateId || ''))
        if (!template) return { success: false, error: `模板不存在: ${args.templateId}` }
        if (!deps.runTemplate) return { success: false, error: '当前环境不支持直接运行模板任务' }

        // 结构预检：缺角色/分支缺失/成环等问题直接返回 problems，不启动半截流程
        const employeeIds = deps.listEmployeeIds ? await deps.listEmployeeIds() : undefined
        const problems = validateGraph(template.graph, employeeIds)
        if (problems.length > 0) {
          return { success: false, error: `流程结构有问题，无法运行：${problems.join('；')}`, problems }
        }

        const provided = (args.variables && typeof args.variables === 'object')
          ? (args.variables as Record<string, unknown>)
          : {}
        const variables: Record<string, string> = {}
        const missing: string[] = []
        for (const variable of template.variables || []) {
          const raw = provided[variable.name]
          const value = raw != null && String(raw).trim() ? String(raw) : (variable.defaultValue || '')
          if (value) variables[variable.name] = value
          else missing.push(variable.name)
        }
        // 模板未声明的额外参数一并透传，交由用户/LLM 自行约定
        for (const [key, value] of Object.entries(provided)) {
          if (!(key in variables) && value != null) variables[key] = String(value)
        }
        if (missing.length > 0) {
          return { success: false, error: `缺少必填运行入参：${missing.join('、')}（请向用户确认取值，或在模板中为参数设置默认值）` }
        }

        const res = await deps.runTemplate(template, variables)
        if (res.error || !res.run) return { success: false, error: res.error || '运行启动失败' }
        return {
          success: true,
          runId: res.run.runId,
          conversationId: res.run.conversationId,
          status: res.run.status,
          nodeCount: res.run.nodes.length,
          hint: '运行已在后台启动，可在「任务」页查看节点进度与产出文件',
        }
      },
    },
    {
      id: 'workflow_delete_template',
      name: 'workflow_delete_template',
      title: '删除模板',
      summary: '删除指定模板（不可恢复）',
      description: '按 templateId 永久删除模板。仅在用户明确要求删除时调用。',
      parameters: {
        type: 'object',
        properties: { templateId: { type: 'string', description: '模板 id' } },
        required: ['templateId'],
      },
      permission: 'requires_confirmation',
      handler: (args) => {
        const id = String(args.templateId || '')
        if (!deps.getTemplate(id)) return { success: false, error: `模板不存在: ${id}` }
        deps.deleteTemplate(id)
        return { success: true, deleted: id }
      },
    },
  ]
}
