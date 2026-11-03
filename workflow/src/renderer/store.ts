/** 模板任务渲染端状态（zustand，与宿主共享实例） */
import { create } from 'zustand'
import type { PluginWorkflowArtifact, PluginWorkflowDeleteRunResult, PluginWorkflowNodeEvent, PluginWorkflowNodeRun, PluginWorkflowRun, PluginWorkflowRunEvent } from '@workavatar/plugin-sdk'
import type { WorkflowTemplate } from '../shared/types'
import { invoke } from './host'

export type WorkflowView = 'list' | 'edit' | 'run'

interface WorkflowState {
  templates: WorkflowTemplate[]
  loading: boolean
  /** 当前页面：模板库 / 画布编辑 / 运行详情 */
  view: WorkflowView
  /** 正在编辑的模板 */
  editing: WorkflowTemplate | null
  /** 正在查看的运行 */
  run: PluginWorkflowRun | null
  runLoading: boolean
  /** 运行历史列表 */
  runs: PluginWorkflowRun[]

  setTemplates: (list: WorkflowTemplate[]) => void
  setLoading: (loading: boolean) => void
  openEditor: (template: WorkflowTemplate) => void
  closeEditor: () => void
  /** 打开一次运行（拉取全量数据） */
  openRun: (runId: string) => Promise<void>
  /** 启动成功后直接进入运行页 */
  startRunView: (run: PluginWorkflowRun) => void
  closeRun: () => void
  setRuns: (runs: PluginWorkflowRun[]) => void
  /** 删除运行记录（IPC）；成功后从各视图移除，返回结果（含工作目录信息供二次确认） */
  deleteRun: (runId: string) => Promise<PluginWorkflowDeleteRunResult>
  /** 统一处理运行事件：轻量状态先上屏，其余事件全量拉取 */
  handleRunEvent: (event: PluginWorkflowRunEvent) => void
}

/** 把节点 transcript 事件按下标合并进节点事件数组（缺失位补洞，越界事件忽略） */
function applyNodeEvent(node: PluginWorkflowNodeRun, event: PluginWorkflowNodeEvent): PluginWorkflowNodeRun {
  const events = [...(node.events || [])]
  if (event.index < 0 || event.index > events.length) return node
  events[event.index] = event
  return { ...node, events }
}

/** 把运行事件增量应用到一条 run 上（不匹配则原样返回） */
function patchRun(run: PluginWorkflowRun, event: PluginWorkflowRunEvent): PluginWorkflowRun {
  if (run.runId !== event.runId) return run
  const nodes = run.nodes.map((node) => {
    if (node.nodeId !== event.nodeId) return node
    if (event.eventType === 'node:start') return { ...node, status: 'running' as const }
    if (event.eventType === 'node:event') {
      const data = (event.data || {}) as { event?: PluginWorkflowNodeEvent }
      return data.event ? applyNodeEvent(node, data.event) : node
    }
    if (event.eventType === 'node:end') {
      const data = (event.data || {}) as { verdict?: string; status?: PluginWorkflowNodeRun['status'] }
      return { ...node, status: data.status || 'completed', verdict: data.verdict ?? node.verdict }
    }
    return node
  })
  if (event.eventType === 'artifact') {
    const artifact = event.data as PluginWorkflowArtifact | undefined
    const artifacts = artifact && !run.artifacts.some(a => a.nodeId === artifact.nodeId && a.path === artifact.path)
      ? [...run.artifacts, artifact]
      : run.artifacts
    return { ...run, nodes, artifacts }
  }
  if (event.eventType !== 'run:end') return { ...run, nodes }
  const data = (event.data || {}) as { status?: PluginWorkflowRun['status']; error?: string }
  return {
    ...run,
    nodes,
    status: data.status || run.status,
    error: data.error ?? run.error,
    endedAt: run.endedAt || Math.floor(Date.now() / 1000),
  }
}

export const useWorkflowStore = create<WorkflowState>((set, get) => {
  /** 全量拉取一次运行并同步到所有持有它的视图（历史列表缺该条时补到顶部） */
  async function refresh(runId: string): Promise<void> {
    try {
      const res = await invoke<{ run: PluginWorkflowRun | null }>('run-get', { runId })
      const run = res?.run
      if (!run) return
      set((s) => ({
        run: s.run?.runId === runId ? run : s.run,
        runs: s.runs.some((r) => r.runId === runId)
          ? s.runs.map((r) => (r.runId === runId ? run : r))
          : [run, ...s.runs],
      }))
    } catch {
      /* 拉取失败不影响交互，下个事件会重试 */
    }
  }

  return {
    templates: [],
    loading: false,
    view: 'list',
    editing: null,
    run: null,
    runLoading: false,
    runs: [],

    setTemplates: (list) => set({ templates: list }),
    setLoading: (loading) => set({ loading }),

    openEditor: (template) => set({ editing: template, view: 'edit' }),
    closeEditor: () => set({ editing: null, view: 'list' }),

    openRun: async (runId) => {
      set({ view: 'run', run: null, runLoading: true })
      try {
        const res = await invoke<{ run: PluginWorkflowRun | null }>('run-get', { runId })
        const run = res?.run || null
        set((s) => ({
          run,
          runLoading: false,
          runs: run && !s.runs.some(r => r.runId === run.runId) ? [run, ...s.runs] : s.runs,
        }))
      } catch {
        set({ runLoading: false })
      }
    },

    startRunView: (run) => set((s) => ({
      run,
      view: 'run',
      runLoading: false,
      runs: [run, ...s.runs.filter(r => r.runId !== run.runId)],
    })),

    closeRun: () => set({ run: null, view: 'list' }),

    setRuns: (runs) => set({ runs }),

    deleteRun: async (runId) => {
      try {
        const res = await invoke<PluginWorkflowDeleteRunResult>('run-delete', { runId })
        if (!res?.ok) return { ok: false }
        set((s) => ({
          runs: s.runs.filter((r) => r.runId !== runId),
          run: s.run?.runId === runId ? null : s.run,
          view: s.run?.runId === runId ? 'list' : s.view,
        }))
        return res
      } catch {
        return { ok: false }
      }
    },

    handleRunEvent: (event) => {
      const before = get().run
      set((s) => ({
        run: s.run ? patchRun(s.run, event) : null,
        runs: s.runs.map((r) => patchRun(r, event)),
      }))
      // node:start / node:event / artifact 已做增量合并，无需全量拉取；
      // node:end / run:end 携带产出、token、终态，全量拉取一次与落库结果对齐
      if (event.eventType !== 'node:start' && event.eventType !== 'node:event' && event.eventType !== 'artifact') {
        void refresh(event.runId)
      }
      // 运行结束但当前页不是运行页时，也把该条记录补进历史列表
      if (event.eventType === 'run:end' && !before) void refresh(event.runId)
    },
  }
})
