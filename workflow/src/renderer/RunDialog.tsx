/** 运行模板任务：填写入参并启动，随后展示执行过程；含运行历史抽屉 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Space, Spin, Tag, Tooltip, Typography, message, theme } from 'antd'
import { DeleteOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, t } from './host'
import { useWorkflowStore } from './store'
import { RunBody } from './RunDetail'
import { STATUS_COLOR, formatDuration, formatTime } from './RunTimeline'
import type { WorkflowTemplate } from '../shared/types'

interface Props {
  template: WorkflowTemplate | null
  onClose: () => void
}

export function RunDialog({ template, onClose }: Props) {
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRun = useWorkflowStore(s => s.activeRun)
  const setActiveRun = useWorkflowStore(s => s.setActiveRun)

  /** 只展示属于当前模板的运行进度，避免旧运行残留污染入参表单 */
  const showRun = !!template && !!activeRun && activeRun.templateId === template.id

  /** 入参默认值预填（模板侧配置的 defaultValue） */
  const initialValues = useMemo(() => {
    const values: Record<string, string> = {}
    for (const variable of template?.variables || []) values[variable.name] = variable.defaultValue || ''
    return values
  }, [template?.variables])

  const start = async () => {
    if (!template) return
    let values: Record<string, string> = {}
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    setStarting(true)
    setError(null)
    try {
      const res = await invoke<{ run?: PluginWorkflowRun; error?: string }>('run-start', {
        templateId: template.id,
        variables: values,
      })
      if (res?.error || !res?.run) {
        setError(res?.error || 'run failed')
        return
      }
      setActiveRun(res.run)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const abort = () => {
    if (activeRun) void invoke('run-abort', { runId: activeRun.runId })
  }

  const runActions = activeRun ? (
    <Space size={6}>
      {activeRun.status === 'running' ? (
        <Popconfirm title={t('run.abortConfirm')} onConfirm={abort} okButtonProps={{ danger: true }}>
          <Button size="small" danger>{t('run.abort')}</Button>
        </Popconfirm>
      ) : null}
    </Space>
  ) : null

  return (
    <Modal
      open={!!template}
      title={`${t('run.title')} · ${template?.name || ''}`}
      onCancel={onClose}
      footer={null}
      width={820}
      destroyOnHidden
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      {!showRun && (
        <Form
          form={form}
          layout="vertical"
          size="small"
          key={template?.id || 'none'}
          initialValues={initialValues}
        >
          {template?.variables?.length ? (
            template.variables.map(v => {
              const hasDefault = !!v.defaultValue
              return (
                <Form.Item
                  key={v.name}
                  name={v.name}
                  style={{ marginBottom: 10 }}
                  label={
                    <Space size={4}>
                      <span>{v.name}</span>
                      {v.description ? (
                        <Tooltip title={v.description}>
                          <QuestionCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
                        </Tooltip>
                      ) : null}
                      {hasDefault ? (
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          ({t('run.variableOptional')})
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                  rules={hasDefault ? [] : [{ required: true, message: t('run.variableRequired', { name: v.name }) }]}
                >
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder={hasDefault ? v.defaultValue : (v.description || '')}
                  />
                </Form.Item>
              )
            })
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('run.noVariables')}
            </Typography.Text>
          )}
          <Button type="primary" loading={starting} onClick={start} style={{ marginTop: 8 }}>
            {starting ? t('run.starting') : t('run.start')}
          </Button>
        </Form>
      )}

      {showRun && activeRun && <RunBody run={activeRun} actions={runActions} />}
    </Modal>
  )
}

/** 运行历史抽屉：状态 / 时间 / 耗时 / 进度 / 失败原因，点入详情，可删除记录 */
export function RunHistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { token } = theme.useToken()
  const { modal } = App.useApp()
  const runs = useWorkflowStore(s => s.runs)
  const setRuns = useWorkflowStore(s => s.setRuns)
  const openRunDetail = useWorkflowStore(s => s.openRunDetail)
  const deleteRun = useWorkflowStore(s => s.deleteRun)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void invoke<{ list: PluginWorkflowRun[] }>('run-list', { limit: 100 })
      .then(res => setRuns(res?.list || []))
      .catch(() => setRuns([]))
      .finally(() => setLoading(false))
  }, [open, setRuns])

  const remove = async (run: PluginWorkflowRun) => {
    const res = await deleteRun(run.runId)
    if (!res.ok) {
      message.warning(t('run.deleteRunning'))
      return
    }
    message.success(t('run.deleted'))
    // 工作区目录非空时，与普通任务一致地询问是否一并删除
    if (res.taskDirNonEmpty && res.taskDir) {
      const dir = res.taskDir
      modal.confirm({
        title: t('run.deleteDirTitle'),
        content: t('run.deleteDirContent', { path: dir }),
        okText: t('run.deleteDirOk'),
        cancelText: t('run.deleteDirCancel'),
        okButtonProps: { danger: true },
        onOk: () => invoke('run-delete-workspace', { path: dir }),
      })
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('page.runHistory')} width={480}>
      {loading && runs.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : runs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.noHistory')} />
      ) : (
        runs.map(run => {
          const done = run.nodes.filter(n => n.status === 'completed').length
          const current = run.nodes.find(n => n.status === 'running')
          return (
            <div
              key={run.runId}
              onClick={() => openRunDetail(run.runId)}
              onMouseEnter={() => setHovered(run.runId)}
              onMouseLeave={() => setHovered(null)}
              style={{
                padding: '10px 12px', marginBottom: 8, borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${hovered === run.runId ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                transition: 'border-color 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Typography.Text strong style={{ fontSize: 13, flex: 1, minWidth: 0 }} ellipsis>
                  {run.templateName || run.templateId}
                </Typography.Text>
                <Tag color={STATUS_COLOR[run.status]} style={{ marginInlineEnd: 0 }}>{t(`status.${run.status}`)}</Tag>
                {run.status !== 'running' ? (
                  <span onClick={e => e.stopPropagation()}>
                    <Popconfirm title={t('run.deleteConfirm')} onConfirm={() => remove(run)} okButtonProps={{ danger: true }}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </span>
                ) : null}
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, fontSize: 11, color: token.colorTextTertiary }}>
                <span>{formatTime(run.startedAt)}</span>
                <span>{t('run.duration')}: {formatDuration(run.startedAt, run.endedAt) ?? '-'}</span>
                <span>{t('run.nodeProgress', { done, total: run.nodes.length })}</span>
              </div>

              {current ? (
                <Typography.Text style={{ fontSize: 12, color: token.colorInfo, display: 'block', marginTop: 4 }}>
                  {t('run.currentNode', { name: current.label })}
                </Typography.Text>
              ) : null}

              {run.error ? (
                <div style={{ marginTop: 6, padding: '4px 8px', borderRadius: 4, background: token.colorErrorBg }}>
                  <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis={{ tooltip: run.error }}>
                    {run.error}
                  </Typography.Text>
                </div>
              ) : null}
            </div>
          )
        })
      )}
    </Drawer>
  )
}
