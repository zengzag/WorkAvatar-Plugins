/**
 * workflow 插件 activate 集成单测：
 * 验证 IPC handler、agent 工具集与「模板设计助手」内置员工的注册契约。
 * 关键断言：员工 manifest 声明的 defaultTools 与实际注册的工具 id 必须完全对齐，
 * 否则员工开箱即用时工具不可用（宿主按 id 覆盖工具模式，id 写错会静默失效）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockContext } from '../helpers/mock-plugin-context'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '../../workflow')

async function loadPlugin() {
  vi.resetModules()
  return import('../../workflow/src/main/index')
}

/** 宿主不会在单测里自动跑 migrations，须手动执行（与生产顺序一致：先迁移后 activate） */
function activateWithMigrations(
  mod: Awaited<ReturnType<typeof loadPlugin>>,
  mock: ReturnType<typeof createMockContext>,
): void {
  for (const m of mod.migrations ?? []) {
    m.run({ storage: mock.ctx.storage, logger: mock.ctx.services.logger })
  }
  mod.activate(mock.ctx)
}

function readManifest(): {
  ipc: string[]
  employees?: Array<{ key: string; name: string; systemPrompt: string; defaultTools?: string[] }>
} {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'manifest.json'), 'utf-8'))
}

describe('workflow 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('workflow')
  })

  it('注册全部模板/运行 IPC handler', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const channels = [
      'template-list', 'template-get', 'template-save', 'template-delete', 'template-duplicate',
      'run-start', 'run-get', 'run-list', 'run-abort', 'run-delete', 'run-delete-workspace',
      'run-open-artifact', 'run-reveal-artifact',
      'employee-options',
    ]
    for (const c of channels) expect(mock.ipc.handlers.has(c)).toBe(true)
    expect(mock.ipc.handlers.size).toBe(channels.length)
  })

  it('打开产物 IPC 做安全校验：缺参数 / 运行不存在均拒绝', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const open = mock.ipc.handlers.get('run-open-artifact')!
    const reveal = mock.ipc.handlers.get('run-reveal-artifact')!
    expect(await open({})).toEqual({ ok: false, error: 'params_required' })
    expect(await reveal({ runId: 'r1' })).toEqual({ ok: false, error: 'params_required' })
    // mock 未注入 services.workflow，getRun 为空 → 运行不存在
    expect(await open({ runId: 'r1', path: 'C:/x.txt' })).toEqual({ ok: false, error: 'run_not_found' })
  })

  it('manifest.ipc 声明的通道与实际注册的完全一致', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const declared = readManifest().ipc
    expect([...mock.ipc.handlers.keys()].sort()).toEqual([...declared].sort())
  })

  it('注册完整的模板搭建 agent 工具集', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const ids = mock.contributions.agentTools.map(t => t.id)
    expect(ids).toEqual([
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

  it('agent 工具默认按需注册（不污染其他员工常驻工具集）', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    for (const tool of mock.contributions.agentTools) {
      expect(tool.onDemand).toBe(true)
    }
  })

  it('声明「模板设计助手」内置员工，且 defaultTools 全部指向真实注册的工具', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const registeredIds = new Set(mock.contributions.agentTools.map(t => t.id))

    const employees = readManifest().employees || []
    expect(employees).toHaveLength(1)
    const designer = employees[0]
    expect(designer.key).toBe('template-designer')
    expect(designer.name).toBe('模板设计助手')
    expect(designer.systemPrompt.length).toBeGreaterThan(200)

    // 工作流类工具必须都在本插件注册集合里；宿主内置工具（list_employees/ask_user）不在此断言
    const pluginTools = (designer.defaultTools || []).filter(id => id.startsWith('workflow_'))
    expect(pluginTools.length).toBeGreaterThan(0)
    for (const id of pluginTools) {
      expect(registeredIds.has(id)).toBe(true)
    }
    // 搭建与自检修复所需的工具必须全部对助手开启（缺一个都会让闭环断在某一步）；
    // 唯一例外是 workflow_delete_template（不可逆，交由用户确认后执行）
    const missing = [...registeredIds].filter(id => id.startsWith('workflow_') && id !== 'workflow_delete_template' && !(designer.defaultTools || []).includes(id))
    expect(missing, `defaultTools 缺少工具: ${missing.join(', ')}`).toEqual([])
  })

  it('locale toolNames/toolDescriptions 与注册工具双向一致（中英文）', async () => {
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const registered = new Set(mock.contributions.agentTools.map(t => t.id))
    for (const locale of ['zh-CN', 'en-US']) {
      const file = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'locale', `${locale}.json`), 'utf-8')) as {
        toolNames: Record<string, string>
        toolDescriptions: Record<string, string>
      }
      const names = new Set(Object.keys(file.toolNames))
      const descriptions = new Set(Object.keys(file.toolDescriptions))
      expect([...names].sort()).toEqual([...registered].sort())
      expect([...descriptions].sort()).toEqual([...registered].sort())
    }
  })

  it('插件声明 workflow 能力域（否则 services.workflow 不会被注入）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'manifest.json'), 'utf-8'))
    const domains = (manifest.capabilities || []).map((c: { domain: string }) => c.domain)
    expect(domains).toContain('workflow')
    expect(domains).toContain('data')
  })
})

describe('workflow 插件 IPC / 模板 CRUD', () => {
  it('template-save → template-list → template-get 往返一致', async () => {
    const mock = createMockContext('workflow')
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)

    const save = mock.ipc.handlers.get('template-save')!
    const list = mock.ipc.handlers.get('template-list')!
    const get = mock.ipc.handlers.get('template-get')!

    const saved = (await save({
      name: '项目指南撰写与评审',
      description: 'desc',
      variables: [{ name: '需求说明' }],
      graph: { nodes: [], edges: [] },
    })) as { template: { id: string; name: string } }
    expect(saved.template.name).toBe('项目指南撰写与评审')

    const listed = (await list({})) as { list: Array<{ id: string }> }
    expect(listed.list.map(t => t.id)).toContain(saved.template.id)

    const got = (await get({ id: saved.template.id })) as { template: { name: string; variables: unknown[] } }
    expect(got.template.name).toBe('项目指南撰写与评审')
    expect(got.template.variables).toHaveLength(1)
  })

  it('template-duplicate 复制出独立副本', async () => {
    const mock = createMockContext('workflow')
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const save = mock.ipc.handlers.get('template-save')!
    const dup = mock.ipc.handlers.get('template-duplicate')!

    const saved = (await save({ name: 'A', graph: { nodes: [], edges: [] } })) as { template: { id: string } }
    const copy = (await dup({ id: saved.template.id })) as { template: { id: string; name: string } }
    expect(copy.template.id).not.toBe(saved.template.id)
    expect(copy.template.name).toContain('copy')
  })

  it('template-delete 后不可再读取', async () => {
    const mock = createMockContext('workflow')
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const save = mock.ipc.handlers.get('template-save')!
    const del = mock.ipc.handlers.get('template-delete')!
    const get = mock.ipc.handlers.get('template-get')!

    const saved = (await save({ name: 'A', graph: { nodes: [], edges: [] } })) as { template: { id: string } }
    await del({ id: saved.template.id })
    const got = (await get({ id: saved.template.id })) as { template: null }
    expect(got.template).toBeNull()
  })

  it('run-start 在未提供 workflow 能力时返回 error 而非抛错', async () => {
    const mock = createMockContext('workflow')
    // 模拟未授权：删除 services.workflow
    delete ((mock.ctx.services as unknown) as Record<string, unknown>).workflow
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const runStart = mock.ipc.handlers.get('run-start')!
    const res = (await runStart({ templateId: 'missing' })) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('run-start 在启动前做结构校验，结构有问题直接返回 problems 而非跑半截流程', async () => {
    const mock = createMockContext('workflow')
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)
    const save = mock.ipc.handlers.get('template-save')!
    const runStart = mock.ipc.handlers.get('run-start')!

    const saved = (await save({
      name: '坏模板',
      graph: {
        nodes: [{ id: 'node1', type: 'agent', position: { x: 0, y: 0 }, data: { label: '撰写' } }],
        edges: [],
      },
    })) as { template: { id: string } }

    const res = (await runStart({ templateId: saved.template.id })) as { error?: string }
    expect(res.error).toContain('缺少角色')
    expect(res.error).toContain('缺少任务指令')
  })
})

describe('workflow 插件 / 模板变更广播', () => {
  it('IPC 写操作与 agent 工具写操作都会广播 templates-changed', async () => {
    const mock = createMockContext('workflow')
    const mod = await loadPlugin()
    activateWithMigrations(mod, mock)

    const save = mock.ipc.handlers.get('template-save')!
    mock.ipc.broadcasts.length = 0
    await save({ name: 'A', graph: { nodes: [], edges: [] } })
    expect(mock.ipc.broadcasts.filter(b => b.event === 'templates-changed')).toHaveLength(1)

    // LLM 在其它页/窗口经 agent 工具创建模板，同样必须广播（否则已挂载的模板库看不到）
    const createTool = mock.contributions.agentTools.find(t => t.id === 'workflow_create_template')!
    mock.ipc.broadcasts.length = 0
    await createTool.handler({ name: 'B' }, {})
    expect(mock.ipc.broadcasts.filter(b => b.event === 'templates-changed')).toHaveLength(1)

    const deleteTool = mock.contributions.agentTools.find(t => t.id === 'workflow_delete_template')!
    mock.ipc.broadcasts.length = 0
    await deleteTool.handler({ templateId: 'ghost' }, {})
    // 删除不存在的模板不触发广播（未产生实际变更）
    expect(mock.ipc.broadcasts).toHaveLength(0)
  })
})
