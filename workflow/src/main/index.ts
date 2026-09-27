/**
 * 模板任务插件 — 主进程入口。
 *
 * 职责：
 * - 模板持久化（插件分库 workflow_templates）
 * - 运行期把画布模型转换为宿主流程定义，经 ctx.services.workflow 驱动内核编排引擎
 * - 运行事件经 ctx.ipc.broadcast('run-event') 转发渲染端
 */
import { randomUUID } from 'node:crypto'
import type { PluginContext, PluginDatabase, PluginMigration, PluginMigrationContext } from '@workavatar/plugin-sdk'
import type { PluginWorkflowGraphSpec, PluginWorkflowNodeSpec, PluginWorkflowRunEvent } from '@workavatar/plugin-sdk'
import type { EphemeralRole, WorkflowGraph, WorkflowTemplate } from '../shared/types'
import { createWorkflowTools, validateGraph } from './tools'

export const migrations: PluginMigration[] = [
  {
    version: '1-init-schema',
    description: '初始化模板任务表',
    run(ctx: PluginMigrationContext): void {
      ctx.storage.openSqlite('index').exec(`
        CREATE TABLE IF NOT EXISTS workflow_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          variables_json TEXT NOT NULL DEFAULT '[]',
          graph_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    },
  },
]

let ctxRef: PluginContext | null = null
let db: PluginDatabase | null = null
let unsubRunEvent: (() => void) | null = null

function getDb(): PluginDatabase {
  if (!db) {
    const ctx = requireContext()
    db = ctx.storage.openSqlite('index')
  }
  return db
}

function requireContext(): PluginContext {
  if (!ctxRef) throw new Error('plugin context not ready')
  return ctxRef
}

/** 读取模板；不存在返回 null */
function loadTemplate(id: string): WorkflowTemplate | null {
  const row = getDb().prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id) as TemplateRow | undefined
  return row ? rowToTemplate(row) : null
}

function listTemplates(): WorkflowTemplate[] {
  const rows = getDb()
    .prepare('SELECT * FROM workflow_templates ORDER BY updated_at DESC')
    .all() as TemplateRow[]
  return rows.map(rowToTemplate)
}

function saveTemplate(input: Partial<WorkflowTemplate> & { name?: string }): WorkflowTemplate {
  const now = Date.now()
  const existing = input.id ? loadTemplate(input.id) : null
  const template: WorkflowTemplate = {
    id: existing?.id || input.id || randomUUID(),
    name: String(input.name || existing?.name || '').trim() || 'Untitled',
    description: input.description ?? existing?.description ?? '',
    variables: Array.isArray(input.variables) ? input.variables : existing?.variables ?? [],
    graph: (input.graph as WorkflowGraph) || existing?.graph || { nodes: [], edges: [] },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  getDb().prepare(`
    INSERT INTO workflow_templates (id, name, description, variables_json, graph_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, description = excluded.description,
      variables_json = excluded.variables_json, graph_json = excluded.graph_json,
      updated_at = excluded.updated_at
  `).run(
    template.id, template.name, template.description,
    JSON.stringify(template.variables), JSON.stringify(template.graph),
    template.createdAt, template.updatedAt,
  )
  return template
}

/** 评审节点输出契约（模板语义持有在插件侧，经 spec 注入内核通用解析器） */
const REVIEW_CONTRACT = [
  '评审输出契约（强制）：先给出评审意见正文，最后必须以如下单行结论收尾，不得省略：',
  'FINAL_VERDICT: PASS 或 FINAL_VERDICT: FAIL',
].join('\n')

/** 画布模型 → 宿主流程定义（仅保留运行所需字段） */
function toGraphSpec(graph: WorkflowGraph): PluginWorkflowGraphSpec {
  const nodes: PluginWorkflowNodeSpec[] = (graph.nodes || []).map((node) => ({
    id: node.id,
    type: node.type,
    label: node.data?.label || node.id,
    employeeId: node.data?.employeeId,
    ephemeralRole: toEphemeralSpec(node.data?.ephemeralRole),
    instruction: buildInstruction(node.data),
    maxRounds: node.data?.maxRounds,
    loopTargetId: typeof node.data?.loopTargetId === 'string' ? node.data.loopTargetId : undefined,
    // 评审/条件节点的判定规则为插件语义，经 spec 注入内核通用解析器
    ...(node.type === 'review'
      ? {
          review: {
            contractSuffix: REVIEW_CONTRACT,
            markedPattern: 'FINAL_VERDICT\\s*[:：]\\s*(PASS|FAIL)',
            failKeywords: ['不通过', '不符合', '未通过', '需修改', 'not pass', 'reject'],
            defaultVerdict: 'pass' as const,
          },
        }
      : {}),
    ...(node.type === 'condition'
      ? { condition: { passKeywords: ['pass', 'true', '1', 'yes', '通过'] } }
      : {}),
  }))
  return {
    nodes,
    edges: (graph.edges || []).map((edge) => ({ from: edge.source, to: edge.target, when: edge.when })),
    entryNodeId: graph.entryNodeId || findEntryNodeId(graph),
  }
}

/** 评审节点指令：附加轮次约束（超过上限时要求给出最终结论） */
function buildInstruction(data: WorkflowGraph['nodes'][number]['data']): string {
  const parts: string[] = []
  if (data?.instruction) parts.push(data.instruction)
  if (data?.maxRounds) {
    parts.push(`本步最多迭代 ${data.maxRounds} 轮；若达到上限仍未通过，请直接给出最终结论，不再要求返工。`)
  }
  return parts.join('\n\n')
}

function toEphemeralSpec(role?: EphemeralRole): { key: string; name: string; systemPrompt: string; tools?: string[]; skills?: string[] } | undefined {
  if (!role?.name || !role.systemPrompt) return undefined
  const key = (role.key || role.name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return {
    key: key || `role-${randomUUID().slice(0, 8)}`,
    name: role.name,
    systemPrompt: role.systemPrompt,
    tools: role.tools?.length ? role.tools : undefined,
    skills: role.skills?.length ? role.skills : undefined,
  }
}

/** 入口节点：优先显式声明，否则取第一个无入边节点 */
function findEntryNodeId(graph: WorkflowGraph): string | undefined {
  const nodes = graph.nodes || []
  if (nodes.length === 0) return undefined
  const targets = new Set((graph.edges || []).map(e => e.target))
  return (nodes.find(n => !targets.has(n.id)) || nodes[0]).id
}

interface TemplateRow {
  id: string
  name: string
  description: string
  variables_json: string
  graph_json: string
  created_at: number
  updated_at: number
}

function rowToTemplate(row: TemplateRow): WorkflowTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    variables: safeParse(row.variables_json, []),
    graph: safeParse(row.graph_json, { nodes: [], edges: [] }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json || '')
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}

/** 提供给渲染端的数字员工候选列表（过滤模板内联角色） */
function listEmployeeOptions(): Promise<Array<Record<string, unknown>>> {
  const ctx = requireContext()
  const query = ctx.services.data?.query('employees', { limit: 500 })
  return (query as Promise<Array<Record<string, unknown>>> | undefined) ?? Promise.resolve([])
}

/** 当前真实存在的数字员工 id（与渲染端下拉同源，过滤运行期内联角色） */
async function listEmployeeIds(): Promise<string[]> {
  const rows = await listEmployeeOptions()
  return (rows || [])
    .map(r => String(r.id || ''))
    .filter(id => id && !id.startsWith('inline:'))
}

export function activate(ctx: PluginContext): void {
  ctxRef = ctx

  // ====== 模板 CRUD ======
  ctx.ipc.handle('template-list', () => ({ list: listTemplates() }))
  ctx.ipc.handle('template-get', (payload: unknown) => {
    const id = String((payload as { id?: string })?.id ?? '')
    return { template: loadTemplate(id) }
  })
  ctx.ipc.handle('template-save', (payload: unknown) => {
    const input = (payload ?? {}) as Partial<WorkflowTemplate> & { name?: string }
    return { template: saveTemplate(input) }
  })
  ctx.ipc.handle('template-delete', (payload: unknown) => {
    const id = String((payload as { id?: string })?.id ?? '')
    getDb().prepare('DELETE FROM workflow_templates WHERE id = ?').run(id)
    return { ok: true }
  })
  ctx.ipc.handle('template-duplicate', (payload: unknown) => {
    const id = String((payload as { id?: string })?.id ?? '')
    const source = loadTemplate(id)
    if (!source) return { error: 'template not found' }
    const copy = saveTemplate({
      name: `${source.name} (copy)`,
      description: source.description,
      variables: source.variables,
      graph: source.graph,
    })
    return { template: copy }
  })

  // ====== 运行 ======
  ctx.ipc.handle('run-start', async (payload: unknown) => {
    const { templateId, variables, conversationId } = (payload ?? {}) as {
      templateId?: string
      variables?: Record<string, string>
      conversationId?: string
    }
    const template = loadTemplate(String(templateId || ''))
    if (!template) return { error: 'template.required' }
    // 运行前结构校验：把「缺角色/分支缺失/成环」等问题在启动前反馈给用户，而不是跑出半截流程
    const problems = validateGraph(template.graph, await listEmployeeIds())
    if (problems.length > 0) return { error: problems.join('；') }
    if (!ctx.services.workflow) return { error: 'workflow capability not granted' }
    try {
      const run = await ctx.services.workflow.run({
        templateId: template.id,
        templateName: template.name,
        graph: toGraphSpec(template.graph),
        variables: variables || {},
        conversationId,
      })
      return { run }
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ctx.ipc.handle('run-get', async (payload: unknown) => {
    const runId = String((payload as { runId?: string })?.runId ?? '')
    const run = (await ctx.services.workflow?.getRun(runId)) ?? null
    return { run }
  })
  ctx.ipc.handle('run-list', async (payload: unknown) => {
    const { templateId, conversationId, limit } = (payload ?? {}) as {
      templateId?: string
      conversationId?: string
      limit?: number
    }
    const list = (await ctx.services.workflow?.listRuns({ templateId, conversationId, limit })) ?? []
    return { list }
  })
  ctx.ipc.handle('run-abort', async (payload: unknown) => {
    const runId = String((payload as { runId?: string })?.runId ?? '')
    const ok = (await ctx.services.workflow?.abortRun(runId)) ?? false
    return { ok }
  })

  // ====== 员工候选 ======
  ctx.ipc.handle('employee-options', async () => {
    const rows = await listEmployeeOptions()
    const list = (rows || [])
      .filter((r: Record<string, unknown>) => String(r.id || '').startsWith('inline:') === false)
      .map((r: Record<string, unknown>) => ({
        id: String(r.id || ''),
        name: String(r.name || ''),
        description: String(r.description || ''),
      }))
      .filter(e => e.id && e.name)
    return { list }
  })

  // ====== agent 工具：让数字员工可自动化创建/修改/校验模板 ======
  // 默认按需（onDemand）以免污染其他员工的常驻工具集；「模板设计助手」在 defaultTools 中声明后
  // 经 EmployeeRegistryService.getDefaultToolModes 覆盖为常驻，开箱即用
  ctx.contributions.registerAgentTools(
    createWorkflowTools({
      listTemplates: () => listTemplates(),
      getTemplate: (id) => loadTemplate(id),
      saveTemplate: (input) => saveTemplate(input),
      deleteTemplate: (id) => {
        getDb().prepare('DELETE FROM workflow_templates WHERE id = ?').run(id)
      },
      listEmployeeIds,
    }).map(tool => ({ ...tool, onDemand: true })),
  )

  // ====== 运行事件转发（宿主内核 → 渲染端） ======
  if (ctx.services.workflow) {
    unsubRunEvent = ctx.services.workflow.onRunEvent(undefined, (event: PluginWorkflowRunEvent) => {
      ctx.ipc.broadcast('run-event', event)
    })
  }
}

export function deactivate(): void {
  if (unsubRunEvent) {
    try { unsubRunEvent() } catch { /* ignore */ }
    unsubRunEvent = null
  }
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = null
  }
  ctxRef = null
}
