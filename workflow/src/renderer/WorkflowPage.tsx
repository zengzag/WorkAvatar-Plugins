/** 模板任务：模板库 / 画布编辑 / 运行详情 三视图切换 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { theme } from 'antd'
import { usePageVisible } from '@workavatar/plugin-sdk/renderer'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, onRunEvent, onTemplatesChanged, t } from './host'
import { isDarkColor } from './utils'
import { useWorkflowStore } from './store'
import { TemplateList } from './TemplateList'
import { CanvasEditor } from './CanvasEditor'
import { RunStartModal, RunHistoryDrawer } from './RunDialog'
import { RunPage } from './RunPage'
import type { WorkflowTemplate } from '../shared/types'
import './workflow.css'

/** 新建模板的空白流程（含默认输入/智能体/结束节点与示例入参，保存后可直接运行与改造） */
function blankTemplate(): WorkflowTemplate {
  const now = Date.now()
  return {
    id: '',
    name: '',
    description: '',
    variables: [
      { name: t('template.sampleVariable'), description: t('template.sampleVariableDesc') },
    ],
    graph: {
      nodes: [
        { id: 'node1', type: 'input', position: { x: 80, y: 160 }, data: { label: t('node.input'), instruction: `{{${t('template.sampleVariable')}}}` } },
        {
          id: 'node2',
          type: 'agent',
          position: { x: 360, y: 160 },
          data: {
            label: t('node.agent'),
            ephemeralRole: { key: '', name: t('template.sampleRole'), systemPrompt: t('template.sampleRolePrompt') },
            instruction: `${t('template.sampleInstruction')}\n{{node1}}`,
          },
        },
        { id: 'node3', type: 'end', position: { x: 640, y: 160 }, data: { label: t('node.end') } },
      ],
      edges: [
        { id: 'e-node1-node2', source: 'node1', target: 'node2' },
        { id: 'e-node2-node3', source: 'node2', target: 'node3' },
      ],
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function WorkflowPage() {
  const { token } = theme.useToken()
  const isDark = isDarkColor(token.colorBgContainer)
  const templates = useWorkflowStore(s => s.templates)
  const loading = useWorkflowStore(s => s.loading)
  const view = useWorkflowStore(s => s.view)
  const editing = useWorkflowStore(s => s.editing)
  const runs = useWorkflowStore(s => s.runs)
  const setTemplates = useWorkflowStore(s => s.setTemplates)
  const setLoading = useWorkflowStore(s => s.setLoading)
  const setRuns = useWorkflowStore(s => s.setRuns)
  const openEditor = useWorkflowStore(s => s.openEditor)
  const closeEditor = useWorkflowStore(s => s.closeEditor)
  const startRunView = useWorkflowStore(s => s.startRunView)

  const [runTarget, setRunTarget] = useState<WorkflowTemplate | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  // 页面级统一订阅运行事件：运行页 / 历史列表 / 模板卡片状态都由 store 派发更新
  useEffect(() => onRunEvent((event) => { useWorkflowStore.getState().handleRunEvent(event) }), [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const res = await invoke<{ list: WorkflowTemplate[] }>('template-list')
      setTemplates(res?.list || [])
    } catch {
      setTemplates([])
    } finally {
      setLoading(false)
    }
  }, [setTemplates, setLoading])

  const loadRuns = useCallback(async () => {
    try {
      const res = await invoke<{ list: PluginWorkflowRun[] }>('run-list', { limit: 100 })
      setRuns(res?.list || [])
    } catch {
      setRuns([])
    }
  }, [setRuns])

  useEffect(() => {
    void reload()
    void loadRuns()
  }, [reload, loadRuns])

  // 模板可能被 LLM（agent 工具）在其它页/窗口创建或修改；写操作后立即刷新
  useEffect(() => onTemplatesChanged(() => { void reload() }), [reload])

  // 页面被 KeepAlive 缓存，切回本页时重新拉取，避免停在旧快照
  const pageVisible = usePageVisible()
  const prevVisibleRef = useRef(true)
  useEffect(() => {
    if (pageVisible && !prevVisibleRef.current) {
      void reload()
      void loadRuns()
    }
    prevVisibleRef.current = pageVisible
  }, [pageVisible, reload, loadRuns])

  const handleRunStarted = (run: PluginWorkflowRun) => {
    startRunView(run)
    void loadRuns()
  }

  const vars = useMemo(() => ({
    '--wf-bg': token.colorBgLayout,
    '--wf-panel': token.colorBgContainer,
    '--wf-soft': token.colorFillQuaternary,
    '--wf-soft-2': token.colorFillSecondary,
    '--wf-border': token.colorBorderSecondary,
    '--wf-border-strong': token.colorBorder,
    '--wf-text': token.colorText,
    '--wf-text-2': token.colorTextSecondary,
    '--wf-text-3': token.colorTextTertiary,
    '--wf-accent': token.colorPrimary,
    '--wf-accent-soft': token.colorPrimaryBg,
    '--wf-accent-border': token.colorPrimaryBorder,
    '--wf-green': token.colorSuccess,
    '--wf-red': token.colorError,
    '--wf-amber': token.colorWarning,
    '--wf-purple': isDark ? '#a371f7' : '#8250df',
    '--wf-purple-soft': isDark ? '#241c3a' : '#f3edff',
    '--wf-shadow-1': token.boxShadowTertiary,
    '--wf-shadow-2': token.boxShadowSecondary,
    '--wf-shadow-3': token.boxShadow,
    '--wf-font-code': token.fontFamilyCode,
  }) as CSSProperties, [token, isDark])

  // antd 的 Drawer / Modal / Popover 默认挂在 body 下，需要同样的变量才能跟随明暗主题
  useEffect(() => {
    const root = document.documentElement
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, String(value))
  }, [vars])

  return (
    <div className="wf-root" style={vars}>
      {view === 'run' ? <RunPage /> : null}

      {view === 'edit' && editing ? (
        <CanvasEditor
          template={editing}
          onBack={() => { closeEditor(); void reload() }}
          onSaved={(saved) => {
            openEditor(saved)
            void reload()
          }}
        />
      ) : null}

      {view === 'list' ? (
        <TemplateList
          templates={templates}
          loading={loading}
          runs={runs}
          onRun={setRunTarget}
          onEdit={openEditor}
          onCreate={() => openEditor(blankTemplate())}
          onHistory={() => setHistoryOpen(true)}
          onChanged={() => { void reload(); void loadRuns() }}
        />
      ) : null}

      <RunStartModal
        template={runTarget}
        onClose={() => setRunTarget(null)}
        onStarted={handleRunStarted}
      />
      <RunHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  )
}
