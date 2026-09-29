/** 模板库首页 + 画布编辑切换 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Card, Empty, List, Popconfirm, Space, Spin, Tag, Tooltip, Typography, message, theme } from 'antd'
import { CopyOutlined, DeleteOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons'
import { usePageVisible } from '@workavatar/plugin-sdk/renderer'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, onRunEvent, onTemplatesChanged, t } from './host'
import { useWorkflowStore } from './store'
import { CanvasEditor } from './CanvasEditor'
import { RunDialog, RunHistoryDrawer } from './RunDialog'
import { RunDetailDrawer } from './RunDetail'
import { STATUS_COLOR } from './RunTimeline'
import type { WorkflowTemplate } from '../shared/types'

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
  const templates = useWorkflowStore(s => s.templates)
  const loading = useWorkflowStore(s => s.loading)
  const editing = useWorkflowStore(s => s.editing)
  const setTemplates = useWorkflowStore(s => s.setTemplates)
  const setLoading = useWorkflowStore(s => s.setLoading)
  const setEditing = useWorkflowStore(s => s.setEditing)
  const setActiveRun = useWorkflowStore(s => s.setActiveRun)
  const runs = useWorkflowStore(s => s.runs)
  const setRuns = useWorkflowStore(s => s.setRuns)
  const openRunDetail = useWorkflowStore(s => s.openRunDetail)

  const [runTarget, setRunTarget] = useState<WorkflowTemplate | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  // 页面级统一订阅运行事件：运行面板 / 历史列表 / 详情抽屉都由 store 派发更新
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

  // 拉取运行记录：驱动卡片上的最近运行状态徽标（历史抽屉打开时会再拉一次全量）
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

  // 模板可能被 LLM（agent 工具）在其它页/窗口创建或修改；主进程写操作后广播 → 立即刷新
  useEffect(() => onTemplatesChanged(() => { void reload() }), [reload])

  // 页面被 KeepAlive 缓存，切回本页时重新拉取，避免停在旧快照（首次挂载由上面的 effect 负责）
  const pageVisible = usePageVisible()
  const prevVisibleRef = useRef(true)
  useEffect(() => {
    if (pageVisible && !prevVisibleRef.current) {
      void reload()
      void loadRuns()
    }
    prevVisibleRef.current = pageVisible
  }, [pageVisible, reload, loadRuns])

  const duplicate = async (template: WorkflowTemplate) => {
    await invoke('template-duplicate', { id: template.id })
    message.success(t('template.duplicated'))
    void reload()
  }

  const remove = async (template: WorkflowTemplate) => {
    await invoke('template-delete', { id: template.id })
    void reload()
  }

  if (editing) {
    return (
      <CanvasEditor
        template={editing}
        onBack={() => { setEditing(null); void reload() }}
        onSaved={(saved) => setEditing(saved)}
      />
    )
  }

  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('page.title')}</Typography.Title>
          <Typography.Text type="secondary">{t('page.desc')}</Typography.Text>
        </div>
        <Space>
          <Button icon={<HistoryOutlined />} onClick={() => setHistoryOpen(true)}>{t('page.runHistory')}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(blankTemplate())}>
            {t('page.newTemplate')}
          </Button>
        </Space>
      </div>

      <List
        loading={loading}
        grid={{ gutter: 12, xs: 1, sm: 2, md: 3, lg: 3, xl: 4 }}
        dataSource={templates}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('page.empty')} /> }}
        renderItem={(template) => (
          <List.Item>
            <Card
              size="small"
              title={<span style={{ fontSize: 14 }}>{template.name}</span>}
              extra={(() => {
                const run = runs.find(r => r.templateId === template.id)
                return (
                  <Space size={4}>
                    {run ? (
                      <Tooltip title={t('run.viewLatestRun')}>
                        <span
                          onClick={() => openRunDetail(run.runId)}
                          style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          {run.status === 'running' ? <Spin size="small" /> : null}
                          <Tag color={STATUS_COLOR[run.status]} style={{ marginInlineEnd: 0 }}>
                            {t(`status.${run.status}`)}
                          </Tag>
                        </span>
                      </Tooltip>
                    ) : null}
                    <Tag style={{ marginInlineEnd: 0 }}>{template.graph.nodes.length}</Tag>
                  </Space>
                )
              })()}
              actions={[
                <Button key="edit" type="text" size="small" icon={<EditOutlined />} onClick={() => setEditing(template)}>
                  {t('template.edit')}
                </Button>,
                <Button key="run" type="text" size="small" icon={<PlayCircleOutlined />} onClick={() => setRunTarget(template)}>
                  {t('template.run')}
                </Button>,
                <Button key="copy" type="text" size="small" icon={<CopyOutlined />} onClick={() => duplicate(template)} />,
                <Popconfirm key="del" title={t('template.deleteConfirm')} onConfirm={() => remove(template)}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>,
              ]}
            >
              <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ fontSize: 12, minHeight: 40, marginBottom: 4 }}>
                {template.description || '—'}
              </Typography.Paragraph>
              <Typography.Text type="secondary" style={{ fontSize: 11, color: token.colorTextTertiary }}>
                {t('template.updatedAt')}: {new Date(template.updatedAt).toLocaleString()}
              </Typography.Text>
            </Card>
          </List.Item>
        )}
      />

      <RunDialog
        template={runTarget}
        onClose={() => { setRunTarget(null); setActiveRun(null) }}
      />
      <RunHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <RunDetailDrawer />
    </div>
  )
}
