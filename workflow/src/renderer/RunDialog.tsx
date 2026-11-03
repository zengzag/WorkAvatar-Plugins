/** 运行启动弹窗 + 运行历史抽屉 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Drawer, Empty, Form, Input, Modal, Popconfirm, Space, Spin, Tag, Tooltip, Typography, message, theme } from 'antd'
import { DeleteOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, t } from './host'
import { useWorkflowStore } from './store'
import { ModelSelect, loadDefaultModel } from './ModelSelect'
import { STATUS_COLOR, formatDuration, formatTime } from './utils'
import type { WorkflowTemplate } from '../shared/types'

interface StartProps {
  template: WorkflowTemplate | null
  onClose: () => void
  onStarted: (run: PluginWorkflowRun) => void
}

/** 运行前填参：模板有入参时展示表单，否则直接开始 */
export function RunStartModal({ template, onClose, onStarted }: StartProps) {
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<{ providerId: string; modelId: string }>({ providerId: '', modelId: '' })

  useEffect(() => {
    if (!template) return
    let alive = true
    setModel({ providerId: '', modelId: '' })
    setError(null)
    void loadDefaultModel().then(result => { if (alive) setModel(result) })
    return () => { alive = false }
  }, [template?.id])

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
        providerId: model.providerId || undefined,
        modelId: model.modelId || undefined,
      })
      if (res?.error || !res?.run) {
        setError(res?.error || t('run.startFailed'))
        return
      }
      onStarted(res.run)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal
      open={!!template}
      title={`${t('run.title')} · ${template?.name || ''}`}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnHidden
    >
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      <Form
        form={form}
        layout="vertical"
        size="small"
        key={template?.id || 'none'}
        initialValues={initialValues}
        style={{ paddingTop: 4 }}
      >
        {template?.variables?.length ? (
          template.variables.map(variable => {
            const hasDefault = !!variable.defaultValue
            return (
              <Form.Item
                key={variable.name}
                name={variable.name}
                style={{ marginBottom: 10 }}
                label={(
                  <Space size={4}>
                    <span>{variable.name}</span>
                    {variable.description ? (
                      <Tooltip title={variable.description}>
                        <QuestionCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12 }} />
                      </Tooltip>
                    ) : null}
                    {hasDefault ? (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        ({t('run.variableOptional')})
                      </Typography.Text>
                    ) : null}
                  </Space>
                )}
                rules={hasDefault ? [] : [{ required: true, message: t('run.variableRequired', { name: variable.name }) }]}
              >
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  placeholder={hasDefault ? variable.defaultValue : (variable.description || '')}
                />
              </Form.Item>
            )
          })
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('run.noVariables')}
          </Typography.Text>
        )}
        <Form.Item
          label={t('run.model')}
          style={{ margin: '12px 0' }}
          extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('run.modelHint')}</Typography.Text>}
        >
          <ModelSelect
            providerId={model.providerId}
            modelId={model.modelId}
            onChange={(providerId, modelId) => setModel({ providerId, modelId })}
          />
        </Form.Item>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="primary" loading={starting} onClick={() => void start()}>
            {starting ? t('run.starting') : t('run.start')}
          </Button>
        </div>
      </Form>
    </Modal>
  )
}

/** 运行历史抽屉：点击进入运行页，可删除记录 */
export function RunHistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { token } = theme.useToken()
  const { modal } = App.useApp()
  const runs = useWorkflowStore(s => s.runs)
  const setRuns = useWorkflowStore(s => s.setRuns)
  const openRun = useWorkflowStore(s => s.openRun)
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
    if (res.taskDirNonEmpty && res.taskDir) {
      const taskDir = res.taskDir
      modal.confirm({
        title: t('run.deleteDirTitle'),
        content: t('run.deleteDirContent', { path: taskDir }),
        okText: t('run.deleteDirOk'),
        cancelText: t('run.deleteDirCancel'),
        okButtonProps: { danger: true },
        onOk: () => invoke('run-delete-workspace', { path: taskDir }),
      })
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('page.runHistory')} size={480}>
      {loading && runs.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : runs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.noHistory')} />
      ) : (
        runs.map(run => {
          const done = run.nodes.filter(node => node.status === 'completed').length
          const current = run.nodes.find(node => node.status === 'running')
          return (
            <div
              key={run.runId}
              onClick={() => { onClose(); void openRun(run.runId) }}
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
                  <span onClick={event => event.stopPropagation()}>
                    <Popconfirm title={t('run.deleteConfirm')} onConfirm={() => void remove(run)} okButtonProps={{ danger: true }}>
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
