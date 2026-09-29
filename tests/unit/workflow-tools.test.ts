/**
 * 模板任务 agent 工具集单测：
 * - 覆盖「LLM 用工具从零搭出一个带回写迭代的评审流程」这一核心场景；
 * - 覆盖「validate 报错 → 用 update/edge 工具修复 → 再 validate 通过」的自检自修闭环；
 * - 验证 add_node / add_edge 的即时参数校验（错误在调用时就返回，而非拖到运行期）；
 * - 验证校验工具能捕获缺角色 / 缺分支 / 成环 / 幻觉员工 id 等结构问题。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createWorkflowTools, validateGraph } from '../../workflow/src/main/tools'
import type { WorkflowTemplate } from '../../workflow/src/shared/types'

/** 内存版模板存储，等价于插件分库行为 */
function createStore() {
  const map = new Map<string, WorkflowTemplate>()
  let seq = 0
  return {
    listTemplates: () => Array.from(map.values()),
    getTemplate: (id: string) => map.get(id) ?? null,
    saveTemplate: (input: Partial<WorkflowTemplate> & { name?: string }) => {
      const existing = input.id ? map.get(input.id) : undefined
      const now = Date.now()
      const template: WorkflowTemplate = {
        id: existing?.id || input.id || `t${++seq}`,
        name: input.name || existing?.name || 'Untitled',
        description: input.description ?? existing?.description ?? '',
        variables: input.variables ?? existing?.variables ?? [],
        graph: input.graph ?? existing?.graph ?? { nodes: [], edges: [] },
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }
      map.set(template.id, template)
      return template
    },
    deleteTemplate: (id: string) => { map.delete(id) },
  }
}

function toolsFor(store: ReturnType<typeof createStore>, employeeIds?: string[]) {
  const tools = createWorkflowTools({
    ...store,
    ...(employeeIds ? { listEmployeeIds: async () => employeeIds } : {}),
  })
  return {
    tools,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find(t => t.id === name)
      if (!tool) throw new Error(`工具不存在: ${name}`)
      return await tool.handler(args, {}) as Record<string, unknown>
    },
  }
}

describe('workflow agent tools / 工具集完备性', () => {
  it('暴露完整的模板搭建工具链（CRUD + 节点/连线 + 校验）', () => {
    const { tools } = toolsFor(createStore())
    expect(tools.map(t => t.id)).toEqual([
      'workflow_list_templates',
      'workflow_get_template',
      'workflow_create_template',
      'workflow_update_template',
      'workflow_add_node',
      'workflow_add_edge',
      'workflow_update_edge',
      'workflow_delete_edge',
      'workflow_update_node',
      'workflow_delete_node',
      'workflow_validate_template',
      'workflow_run_template',
      'workflow_delete_template',
    ])
  })

  it('全部工具声明 safe/requires_confirmation 权限与合法 JSON Schema', () => {
    const { tools } = toolsFor(createStore())
    for (const tool of tools) {
      expect(['safe', 'requires_confirmation', 'dangerous']).toContain(tool.permission)
      expect(tool.parameters.type).toBe('object')
      expect(tool.description.length).toBeGreaterThan(20)
    }
    // 删除模板不可逆，必须要求确认
    expect(tools.find(t => t.id === 'workflow_delete_template')!.permission).toBe('requires_confirmation')
  })
})

describe('workflow agent tools / LLM 搭建「撰写 → 评审 → 迭代」流程', () => {
  let store: ReturnType<typeof createStore>
  let call: ReturnType<typeof toolsFor>['call']

  beforeEach(() => {
    store = createStore()
    call = toolsFor(store).call
  })

  it('完整搭出带回写迭代的项目指南模板并通过校验', async () => {
    // 1. 创建模板 + 运行入参
    const created = await call('workflow_create_template', {
      name: '项目指南撰写与评审',
      description: '按模板撰写项目指南，经形式与技术评审后定稿',
      variables: [
        { name: '需求说明', description: '项目背景与范围' },
        { name: '模板文件', description: '指南模板的绝对路径' },
      ],
    })
    expect(created.success).toBe(true)
    const templateId = created.templateId as string

    // 2. 逐节点搭建
    const input = await call('workflow_add_node', { templateId, type: 'input', label: '输入模板与需求' })
    const loop = await call('workflow_add_node', { templateId, type: 'loop', label: '迭代控制', maxRounds: 3 })
    const write = await call('workflow_add_node', {
      templateId, type: 'agent', label: '撰写文档',
      ephemeralRole: {
        name: '撰写专家',
        systemPrompt: '你是文档撰写专家，依据模板与评审意见撰写并修改项目指南。',
      },
      instruction: '根据 {{需求说明}} 与模板 {{模板文件}} 撰写项目指南；若收到评审意见，逐条修订。',
    })
    const form = await call('workflow_add_node', {
      templateId, type: 'review', label: '形式审查',
      ephemeralRole: { name: '形式审查专家', systemPrompt: '审查行文格式：字数、排版、章节结构是否符合模板。' },
      instruction: '审查 {{node3}} 的格式合规性，逐项列出问题。',
    })
    const tech = await call('workflow_add_node', {
      templateId, type: 'review', label: '技术评审',
      ephemeralRole: { name: '技术评审专家', systemPrompt: '从技术准确性审查内容是否符合编制要求。' },
      instruction: '评审 {{node3}} 的技术内容，给出具体修改意见。',
    })
    const end = await call('workflow_add_node', { templateId, type: 'end', label: '输出定稿' })

    expect([input, loop, write, form, tech, end].every(r => r.success === true)).toBe(true)

    // 3. 连线：含评审 fail 回写到 loop 的迭代回路
    //    节点顺序：node1 输入 → node2 循环 → node3 撰写 → node4 形式审查 → node5 技术评审 → node6 结束
    const edges: Array<[string, string, string | undefined]> = [
      ['node1', 'node2', undefined],
      ['node2', 'node3', undefined],
      ['node3', 'node4', undefined],
      ['node4', 'node5', 'pass'],
      ['node4', 'node2', 'fail'],
      ['node5', 'node6', 'pass'],
      ['node5', 'node2', 'fail'],
    ]
    for (const [sourceId, targetId, when] of edges) {
      const res = await call('workflow_add_edge', { templateId, sourceId, targetId, when })
      expect(res.success).toBe(true)
    }

    // 4. 校验通过
    const validation = await call('workflow_validate_template', { templateId })
    expect(validation.problems).toEqual([])
    expect(validation.success).toBe(true)

    // 5. 结构符合预期
    const detail = await call('workflow_get_template', { templateId })
    const template = detail.template as WorkflowTemplate
    expect(template.graph.nodes).toHaveLength(6)
    expect(template.graph.edges).toHaveLength(7)
    expect(template.variables.map(v => v.name)).toEqual(['需求说明', '模板文件'])
  })

  it('声明了 ephemeralRole 的评审节点被识别为合法角色来源（无需 employeeId）', async () => {
    const created = await call('workflow_create_template', { name: 'T' })
    const templateId = created.templateId as string
    await call('workflow_add_node', {
      templateId, type: 'review', label: '评审',
      ephemeralRole: { name: '评审专家', systemPrompt: '按标准评审。' },
      instruction: '评审内容。',
    })
    const problems = (await call('workflow_validate_template', { templateId })).problems as string[]
    expect(problems.some(p => p.includes('缺少角色'))).toBe(false)
  })

  it('重复连线被拒绝（相同起点/终点/分支）', async () => {
    const created = await call('workflow_create_template', { name: 'T' })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: 'A' })
    await call('workflow_add_node', { templateId, type: 'end', label: 'B' })
    expect((await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })).success).toBe(true)
    const dup = await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })
    expect(dup.success).toBe(false)
    expect(String(dup.error)).toContain('已存在')
  })

  it('连线引用不存在的节点时报错而非静默写入', async () => {
    const created = await call('workflow_create_template', { name: 'T' })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: 'A' })
    const res = await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'ghost' })
    expect(res.success).toBe(false)
    expect(store.getTemplate(templateId)!.graph.edges).toHaveLength(0)
  })

  it('删除节点会同步清理关联连线', async () => {
    const created = await call('workflow_create_template', { name: 'T' })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: 'A' })
    await call('workflow_add_node', { templateId, type: 'end', label: 'B' })
    await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })
    const res = await call('workflow_delete_node', { templateId, nodeId: 'node1' })
    expect(res.remainingEdges).toBe(0)
    expect(store.getTemplate(templateId)!.graph.nodes.map(n => n.id)).toEqual(['node2'])
  })

  it('更新节点：可改写指令与循环轮次', async () => {
    const created = await call('workflow_create_template', { name: 'T' })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'loop', label: '循环', maxRounds: 2 })
    await call('workflow_update_node', { templateId, nodeId: 'node1', maxRounds: 5, label: '迭代控制' })
    const node = store.getTemplate(templateId)!.graph.nodes[0]
    expect(node.data.maxRounds).toBe(5)
    expect(node.data.label).toBe('迭代控制')
  })
})

describe('workflow agent tools / 即时参数校验（错误在调用时返回）', () => {
  let store: ReturnType<typeof createStore>
  let call: ReturnType<typeof toolsFor>['call']
  let templateId: string

  beforeEach(async () => {
    store = createStore()
    call = toolsFor(store, ['emp-1']).call
    templateId = (await call('workflow_create_template', { name: 'T' })).templateId as string
  })

  it('agent/review 节点缺 instruction 被拒绝', async () => {
    const res = await call('workflow_add_node', { templateId, type: 'agent', label: 'A', ephemeralRole: { name: 'R', systemPrompt: 'S' } })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('instruction')
  })

  it('临时角色缺 name 或 systemPrompt 被拒绝', async () => {
    const res = await call('workflow_add_node', { templateId, type: 'agent', label: 'A', instruction: 'x', ephemeralRole: { name: '', systemPrompt: '' } })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('ephemeralRole')
  })

  it('employeeId 与 ephemeralRole 同时提供被拒绝（互斥）', async () => {
    const res = await call('workflow_add_node', {
      templateId, type: 'agent', label: 'A', instruction: 'x',
      employeeId: 'emp-1', ephemeralRole: { name: 'R', systemPrompt: 'S' },
    })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('二选一')
  })

  it('臆造的 employeeId 被拒绝（提示先查 list_employees）', async () => {
    const res = await call('workflow_add_node', { templateId, type: 'agent', label: 'A', instruction: 'x', employeeId: 'hallucinated-id' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('数字员工不存在')
  })

  it('合法 employeeId 正常通过', async () => {
    const res = await call('workflow_add_node', { templateId, type: 'agent', label: 'A', instruction: 'x', employeeId: 'emp-1' })
    expect(res.success).toBe(true)
  })

  it('loop 节点缺 maxRounds 被拒绝', async () => {
    const res = await call('workflow_add_node', { templateId, type: 'loop', label: 'L' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('maxRounds')
  })

  it('condition 节点缺条件表达式被拒绝', async () => {
    const res = await call('workflow_add_node', { templateId, type: 'condition', label: 'C' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('条件表达式')
  })

  it('普通节点出边设置分支标签被拒绝', async () => {
    await call('workflow_add_node', { templateId, type: 'input', label: 'A' })
    await call('workflow_add_node', { templateId, type: 'end', label: 'B' })
    const res = await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2', when: 'pass' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('仅评审/条件节点')
  })

  it('非法分支标签被拒绝（仅 pass 或 fail 开头）', async () => {
    const created = await call('workflow_create_template', { name: 'T2' })
    const tid = created.templateId as string
    await call('workflow_add_node', { templateId: tid, type: 'input', label: 'A' })
    await call('workflow_add_node', { templateId: tid, type: 'review', label: 'R', instruction: '审', ephemeralRole: { name: 'x', systemPrompt: 'y' } })
    await call('workflow_add_node', { templateId: tid, type: 'end', label: 'B' })
    const res = await call('workflow_add_edge', { templateId: tid, sourceId: 'node2', targetId: 'node3', when: 'maybe' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('分支标签非法')
  })
})

describe('workflow agent tools / 修复回路闭环（validate 报错 → 工具修复 → 再通过）', () => {
  let store: ReturnType<typeof createStore>
  let call: ReturnType<typeof toolsFor>['call']
  let templateId: string

  /** 搭一个评审流程骨架（node1 输入 → node2 撰写 → node3 评审 → node4 结束），评审出边先只连默认分支 */
  async function buildReviewSkeleton() {
    const created = await call('workflow_create_template', { name: '修复回路' })
    templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: '输入' })
    await call('workflow_add_node', {
      templateId, type: 'agent', label: '撰写',
      ephemeralRole: { name: '撰写专家', systemPrompt: '撰写文档。' },
      instruction: '写初稿',
    })
    await call('workflow_add_node', {
      templateId, type: 'review', label: '评审',
      ephemeralRole: { name: '评审专家', systemPrompt: '按标准评审。' },
      instruction: '评审初稿',
    })
    await call('workflow_add_node', { templateId, type: 'end', label: '结束' })
    await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })
    await call('workflow_add_edge', { templateId, sourceId: 'node2', targetId: 'node3' })
    await call('workflow_add_edge', { templateId, sourceId: 'node3', targetId: 'node4' })
    // 评审缺少 pass/fail 分支 —— 故意留着这个错误
    await call('workflow_add_edge', { templateId, sourceId: 'node3', targetId: 'node2', when: 'fail' })
  }

  beforeEach(async () => {
    store = createStore()
    call = toolsFor(store, ['emp-1']).call
    await buildReviewSkeleton()
  })

  it('validate 报出缺 pass 分支 → update_edge 改标默认边 → 再 validate 通过', async () => {
    const first = await call('workflow_validate_template', { templateId })
    expect(first.success).toBe(false)
    expect((first.problems as string[]).some(p => p.includes('缺少 pass 分支'))).toBe(true)

    // 修复：把评审 → 结束 的默认出边改标为 pass
    const edges = store.getTemplate(templateId)!.graph.edges
    const defaultEdge = edges.find(e => e.source === 'node3' && e.target === 'node4' && !e.when)!
    const updated = await call('workflow_update_edge', { templateId, edgeId: defaultEdge.id, when: 'pass' })
    expect(updated.success).toBe(true)

    const second = await call('workflow_validate_template', { templateId })
    expect(second.problems).toEqual([])
    expect(second.success).toBe(true)
  })

  it('误加连线导致成环 → delete_edge 移除 → 再 validate 通过', async () => {
    // 修好 pass 分支后，再故意加一条回边把流程搞成环
    const edges = store.getTemplate(templateId)!.graph.edges
    const defaultEdge = edges.find(e => e.source === 'node3' && e.target === 'node4' && !e.when)!
    await call('workflow_update_edge', { templateId, edgeId: defaultEdge.id, when: 'pass' })
    const bad = await call('workflow_add_edge', { templateId, sourceId: 'node4', targetId: 'node1' })
    expect(bad.success).toBe(true)

    const cyclic = await call('workflow_validate_template', { templateId })
    expect((cyclic.problems as string[]).some(p => p.includes('入口'))).toBe(true)

    const removed = await call('workflow_delete_edge', { templateId, edgeId: bad.edgeId })
    expect(removed.success).toBe(true)
    const fixed = await call('workflow_validate_template', { templateId })
    expect(fixed.problems).toEqual([])
  })

  it('幻觉 employeeId：add_node 拒绝写入，validate 报出引用问题', async () => {
    const blocked = await call('workflow_add_node', { templateId, type: 'agent', label: '假员工', instruction: 'x', employeeId: 'no-such' })
    expect(blocked.success).toBe(false)

    // 即便数据里已经存在无效 id（如员工被删除），validate 也能报出来
    const graph = store.getTemplate(templateId)!.graph
    graph.nodes.push({ id: 'node9', type: 'agent', position: { x: 0, y: 0 }, data: { label: '离职员工', employeeId: 'deleted-emp', instruction: 'x' } })
    graph.edges.push({ id: 'e9', source: 'node1', target: 'node9' })
    store.saveTemplate({ ...store.getTemplate(templateId)!, graph })

    const res = await call('workflow_validate_template', { templateId })
    expect((res.problems as string[]).some(p => p.includes('数字员工不存在'))).toBe(true)
  })

  it('update_template 可在创建后补齐运行入参与名称', async () => {
    const updated = await call('workflow_update_template', {
      templateId,
      name: '新名称',
      variables: [{ name: '输入主题', description: '要写的主题' }],
    })
    expect(updated.success).toBe(true)
    const detail = await call('workflow_get_template', { templateId })
    const template = detail.template as WorkflowTemplate
    expect(template.name).toBe('新名称')
    expect(template.variables.map(v => v.name)).toEqual(['输入主题'])
    // 未传的字段保持不变
    expect(template.graph.nodes).toHaveLength(4)
  })

  it('update_edge 可清除标签回退默认分支，传不存在的 edgeId 报错', async () => {
    const edges = store.getTemplate(templateId)!.graph.edges
    const failEdge = edges.find(e => e.when === 'fail')!
    const cleared = await call('workflow_update_edge', { templateId, edgeId: failEdge.id, when: '' })
    expect(cleared.success).toBe(true)
    expect((cleared.edge as { when?: string }).when).toBeUndefined()

    const missing = await call('workflow_update_edge', { templateId, edgeId: 'ghost-edge', when: 'pass' })
    expect(missing.success).toBe(false)
    expect(String(missing.error)).toContain('连线不存在')
  })
})

describe('workflow agent tools / validateGraph 结构校验', () => {
  const baseNode = (id: string, type: string, data: Record<string, unknown> = {}) => ({
    id, type: type as never, position: { x: 0, y: 0 }, data: { label: id, ...data },
  })

  it('空流程报错', () => {
    expect(validateGraph({ nodes: [], edges: [] })).toEqual(['流程为空：至少需要一个节点'])
  })

  it('智能体节点缺角色与指令均被报出', () => {
    const problems = validateGraph({ nodes: [baseNode('n1', 'agent')], edges: [] })
    expect(problems.some(p => p.includes('缺少角色'))).toBe(true)
    expect(problems.some(p => p.includes('缺少任务指令'))).toBe(true)
  })

  it('评审节点缺 pass 分支被报出', () => {
    const graph = {
      nodes: [
        baseNode('n1', 'review', {
          instruction: '评审', ephemeralRole: { name: 'R', systemPrompt: 'S' },
        }),
        baseNode('n2', 'end'),
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    }
    const problems = validateGraph(graph)
    expect(problems.some(p => p.includes('缺少 pass 分支'))).toBe(true)
  })

  it('条件节点缺条件表达式被报出', () => {
    const problems = validateGraph({ nodes: [baseNode('n1', 'condition')], edges: [] })
    expect(problems.some(p => p.includes('条件表达式'))).toBe(true)
  })

  it('条件节点多条出边未标注 pass/fail 被报出', () => {
    const graph = {
      nodes: [baseNode('n1', 'condition', { instruction: '{{node0}}' }), baseNode('n2', 'end'), baseNode('n3', 'end')],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
      ],
    }
    const problems = validateGraph(graph)
    expect(problems.some(p => p.includes('when=pass'))).toBe(true)
  })

  it('普通节点出边带分支标签被报出（运行时只会走默认分支）', () => {
    const graph = {
      nodes: [baseNode('n1', 'agent', { instruction: 'x', ephemeralRole: { name: 'R', systemPrompt: 'S' } }), baseNode('n2', 'end')],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', when: 'done' }],
    }
    const problems = validateGraph(graph)
    expect(problems.some(p => p.includes('不能带分支标签'))).toBe(true)
  })

  it('评审节点的非法分支标签被报出', () => {
    const graph = {
      nodes: [
        baseNode('n1', 'review', { instruction: '审', ephemeralRole: { name: 'R', systemPrompt: 'S' } }),
        baseNode('n2', 'end'),
        baseNode('n3', 'end'),
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', when: 'pass' },
        { id: 'e2', source: 'n1', target: 'n3', when: 'maybe' },
      ],
    }
    const problems = validateGraph(graph)
    expect(problems.some(p => p.includes('无法匹配结论'))).toBe(true)
  })

  it('引用不存在的数字员工被报出（传入员工 id 清单时）', () => {
    const graph = {
      nodes: [baseNode('n1', 'agent', { instruction: 'x', employeeId: 'ghost' }), baseNode('n2', 'end')],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    }
    expect(validateGraph(graph).some(p => p.includes('数字员工不存在'))).toBe(false)
    expect(validateGraph(graph, ['emp-1']).some(p => p.includes('数字员工不存在'))).toBe(true)
    expect(validateGraph(graph, ['ghost'])).toEqual([])
  })

  it('循环节点缺 maxRounds 被报出', () => {
    const problems = validateGraph({ nodes: [baseNode('n1', 'loop')], edges: [] })
    expect(problems.some(p => p.includes('maxRounds'))).toBe(true)
  })

  it('多入口节点被报出', () => {
    const graph = {
      nodes: [baseNode('n1', 'agent', { instruction: 'x', ephemeralRole: { name: 'R', systemPrompt: 'S' } }), baseNode('n2', 'end')],
      edges: [],
    }
    expect(validateGraph(graph).some(p => p.includes('多个入口节点'))).toBe(true)
  })

  it('全成环（无入口）被报出', () => {
    const graph = {
      nodes: [
        baseNode('n1', 'agent', { instruction: 'x', ephemeralRole: { name: 'R', systemPrompt: 'S' } }),
        baseNode('n2', 'agent', { instruction: 'y', ephemeralRole: { name: 'R2', systemPrompt: 'S2' } }),
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' },
      ],
    }
    const problems = validateGraph(graph)
    expect(problems.some(p => p.includes('未找到入口节点'))).toBe(true)
    // 闭环中包含 n1/n2 两条边，但都不指向自身以外的孤立点，因此入口判定失败
    expect(problems.length).toBeGreaterThan(0)
  })

  it('悬空连线被报出', () => {
    const graph = {
      nodes: [baseNode('n1', 'input')],
      edges: [{ id: 'e1', source: 'n1', target: 'ghost' }],
    }
    expect(validateGraph(graph).some(p => p.includes('终点节点不存在'))).toBe(true)
  })

  it('节点 id 重复与类型非法被报出', () => {
    const graph = {
      nodes: [baseNode('n1', 'input'), baseNode('n1', 'bogus')],
      edges: [],
    }
    const problems = validateGraph(graph)
    expect(problems.some(p => p.includes('id 重复'))).toBe(true)
    expect(problems.some(p => p.includes('类型非法'))).toBe(true)
  })
})

describe('workflow agent tools / 列表与删除', () => {
  it('list_templates 汇总节点数、连线数与入参名', async () => {
    const store = createStore()
    const { call } = toolsFor(store)
    const created = await call('workflow_create_template', { name: 'A', variables: [{ name: 'x' }] })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: 'I' })
    await call('workflow_add_node', { templateId, type: 'end', label: 'E' })
    await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })
    const list = (await call('workflow_list_templates')).templates as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0].nodes).toBe(2)
    expect(list[0].edges).toBe(1)
    expect(list[0].variables).toEqual(['x'])
  })

  it('delete_template 删除后不可再读取', async () => {
    const store = createStore()
    const { call } = toolsFor(store)
    const created = await call('workflow_create_template', { name: 'A' })
    const templateId = created.templateId as string
    expect((await call('workflow_delete_template', { templateId })).success).toBe(true)
    expect((await call('workflow_get_template', { templateId })).success).toBe(false)
  })

  it('操作不存在的模板返回 success:false 且带 error 文案', async () => {
    const { call } = toolsFor(createStore())
    for (const name of ['workflow_get_template', 'workflow_update_template', 'workflow_add_node', 'workflow_add_edge', 'workflow_update_edge', 'workflow_delete_edge', 'workflow_validate_template']) {
      const res = await call(name, { templateId: 'ghost', edgeId: 'e', type: 'input', label: 'x', sourceId: 'a', targetId: 'b' })
      expect(res.success).toBe(false)
      expect(String(res.error)).toContain('模板不存在')
    }
  })
})

describe('workflow agent tools / 运行入参默认值与直接运行', () => {
  /** 内存运行记录：捕获传给 runTemplate 的模板与入参 */
  type RunCall = { templateId: string; variables: Record<string, string> }

  function createRunHarness() {
    const store = createStore()
    const runCalls: RunCall[] = []
    let seq = 0
    const tools = createWorkflowTools({
      ...store,
      runTemplate: async (template, variables) => {
        runCalls.push({ templateId: template.id, variables })
        return {
          run: {
            runId: `run-${++seq}`,
            templateId: template.id,
            conversationId: `conv-${seq}`,
            status: 'running',
            nodes: template.graph.nodes.map(n => ({ nodeId: n.id, label: n.data.label, type: n.type, status: 'pending' as const })),
            artifacts: [],
          },
        }
      },
    })
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const tool = tools.find(item => item.id === name)
      if (!tool) throw new Error(`工具不存在: ${name}`)
      return await tool.handler(args, {}) as Record<string, unknown>
    }
    return { store, runCalls, call }
  }

  /** 搭一个可运行的最小模板：input → end（结构合法，无需角色） */
  async function buildRunnable(call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>, opts?: { withDefault?: boolean }) {
    const created = await call('workflow_create_template', {
      name: '运行测试',
      variables: opts?.withDefault
        ? [{ name: '主题', description: '要写的主题' }, { name: '字数', defaultValue: '800' }, { name: '' }]
        : [{ name: '主题' }],
    })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: '输入' })
    await call('workflow_add_node', { templateId, type: 'end', label: '结束' })
    await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })
    return templateId
  }

  it('create 保留入参默认值并丢弃空名行', async () => {
    const { call } = createRunHarness()
    const templateId = await buildRunnable(call, { withDefault: true })
    const detail = await call('workflow_get_template', { templateId })
    const template = detail.template as WorkflowTemplate
    expect(template.variables).toEqual([
      { name: '主题', description: '要写的主题' },
      { name: '字数', defaultValue: '800' },
    ])
  })

  it('启动运行并返回 runId/conversationId，入参原样透传', async () => {
    const { runCalls, call } = createRunHarness()
    const templateId = await buildRunnable(call)
    const res = await call('workflow_run_template', { templateId, variables: { 主题: '季度总结' } })
    expect(res.success).toBe(true)
    expect(res.runId).toBe('run-1')
    expect(res.conversationId).toBe('conv-1')
    expect(res.nodeCount).toBe(2)
    expect(runCalls).toEqual([{ templateId, variables: { 主题: '季度总结' } }])
  })

  it('缺必填入参被拒绝；有默认值的入参可留空并用默认值补齐', async () => {
    const { runCalls, call } = createRunHarness()
    const templateId = await buildRunnable(call, { withDefault: true })

    const blocked = await call('workflow_run_template', { templateId })
    expect(blocked.success).toBe(false)
    expect(String(blocked.error)).toContain('主题')
    expect(runCalls).toHaveLength(0)

    const ok = await call('workflow_run_template', { templateId, variables: { 主题: '周报' } })
    expect(ok.success).toBe(true)
    expect(runCalls[0].variables).toEqual({ 主题: '周报', 字数: '800' })
  })

  it('结构有问题的模板不会启动运行', async () => {
    const { runCalls, call } = createRunHarness()
    const created = await call('workflow_create_template', { name: '坏模板' })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'agent', label: '缺角色的节点' })

    const res = await call('workflow_run_template', { templateId })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('无法运行')
    expect(runCalls).toHaveLength(0)
  })

  it('未注入运行能力时返回可读 error', async () => {
    const { call } = toolsFor(createStore())
    const created = await call('workflow_create_template', { name: 'T' })
    const templateId = created.templateId as string
    await call('workflow_add_node', { templateId, type: 'input', label: 'I' })
    await call('workflow_add_node', { templateId, type: 'end', label: 'E' })
    await call('workflow_add_edge', { templateId, sourceId: 'node1', targetId: 'node2' })

    const res = await call('workflow_run_template', { templateId })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('不支持直接运行')
  })
})
