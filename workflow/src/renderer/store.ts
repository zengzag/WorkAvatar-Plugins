/** 模板任务渲染端状态（zustand，与宿主共享实例） */
import { create } from 'zustand'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import type { WorkflowTemplate } from '../shared/types'

interface WorkflowState {
  templates: WorkflowTemplate[]
  loading: boolean
  /** 正在编辑的模板（null = 模板库视图） */
  editing: WorkflowTemplate | null
  /** 最近一次运行（运行详情面板） */
  activeRun: PluginWorkflowRun | null
  runs: PluginWorkflowRun[]

  setTemplates: (list: WorkflowTemplate[]) => void
  setLoading: (loading: boolean) => void
  setEditing: (template: WorkflowTemplate | null) => void
  setActiveRun: (run: PluginWorkflowRun | null) => void
  setRuns: (runs: PluginWorkflowRun[]) => void
  /** 应用运行事件：只更新匹配 runId 的节点状态 */
  applyRunEvent: (event: { runId: string; eventType: string; nodeId?: string; data?: unknown }) => void
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  templates: [],
  loading: false,
  editing: null,
  activeRun: null,
  runs: [],

  setTemplates: (list) => set({ templates: list }),
  setLoading: (loading) => set({ loading }),
  setEditing: (template) => set({ editing: template }),
  setActiveRun: (run) => set({ activeRun: run }),
  setRuns: (runs) => set({ runs }),

  applyRunEvent: (event) => {
    const run = get().activeRun
    if (!run || run.runId !== event.runId) return
    const nodes = run.nodes.map((node) => {
      if (node.nodeId !== event.nodeId) return node
      if (event.eventType === 'node:start') return { ...node, status: 'running' as const }
      if (event.eventType === 'node:end') {
        const data = (event.data || {}) as { verdict?: string }
        return { ...node, status: 'completed' as const, verdict: data.verdict }
      }
      return node
    })
    const status = event.eventType === 'run:end'
      ? ((event.data as { status?: string })?.status as PluginWorkflowRun['status']) || run.status
      : run.status
    set({ activeRun: { ...run, nodes, status } })
  },
}))
