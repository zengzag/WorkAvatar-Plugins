/** 运行模板任务：填写入参并启动，随后展示节点进度与产物 */
import { useEffect, useState } from 'react'
import { Alert, Button, Drawer, Empty, Form, Input, List, Modal, Space, Tag, Typography, theme } from 'antd'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, onRunEvent, t } from './host'
import { useWorkflowStore } from './store'
import type { WorkflowTemplate } from '../shared/types'

interface Props {
  template: WorkflowTemplate | null
  onClose: () => void
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  aborted: 'warning',
  skipped: 'default',
}

export function RunDialog({ template, onClose }: Props) {
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRun = useWorkflowStore(s => s.activeRun)
  const setActiveRun = useWorkflowStore(s => s.setActiveRun)

  useEffect(() => {
    if (!template) return
    const off = onRunEvent((event) => {
      useWorkflowStore.getState().applyRunEvent(event)
      if (event.eventType === 'run:end') {
        void invoke<{ run: PluginWorkflowRun | null }>('run-get', { runId: event.runId })
          .then(res => { if (res?.run) setActiveRun(res.run) })
          .catch(() => { /* ignore */ })
      }
    })
    return off
  }, [template, setActiveRun])

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

  const abort = async () => {
    if (!activeRun) return
    await invoke('run-abort', { runId: activeRun.runId })
  }

  const openTaskPage = () => {
    const conversationId = activeRun?.conversationId
    if (conversationId) window.location.hash = `#/tasks?conversation=${conversationId}`
    else window.location.hash = '#/tasks'
  }

  return (
    <Modal
      open={!!template}
      title={`${t('run.title')} · ${template?.name || ''}`}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

      {!activeRun && (
        <Form form={form} layout="vertical" size="small">
          {template?.variables?.length ? (
            template.variables.map(v => (
              <Form.Item key={v.name} name={v.name} label={v.name} extra={v.description}
                rules={[{ required: true, message: t('run.variableRequired', { name: v.name }) }]}>
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} />
              </Form.Item>
            ))
          ) : (
            <Typography.Text type="secondary">{t('template.variables')}: {t('common.none')}</Typography.Text>
          )}
          <Button type="primary" loading={starting} onClick={start} style={{ marginTop: 8 }}>
            {starting ? t('run.starting') : t('run.start')}
          </Button>
        </Form>
      )}

      {activeRun && (
        <div>
          <Space style={{ marginBottom: 12 }}>
            <Tag color={STATUS_COLOR[activeRun.status]}>{t(`status.${activeRun.status}`)}</Tag>
            <Button size="small" onClick={openTaskPage}>{t('run.openTask')}</Button>
            {activeRun.status === 'running' && (
              <Button size="small" danger onClick={abort}>{t('run.abort')}</Button>
            )}
          </Space>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('run.nodeStatus')}</Typography.Text>
          <List
            size="small"
            dataSource={activeRun.nodes}
            renderItem={(node) => (
              <List.Item style={{ padding: '6px 0' }}>
                <div style={{ width: '100%' }}>
                  <Space size={6}>
                    <Tag color={STATUS_COLOR[node.status]}>{t(`status.${node.status}`)}</Tag>
                    <Typography.Text style={{ fontSize: 13 }}>{node.label}</Typography.Text>
                    {node.verdict && (
                      <Typography.Text style={{ fontSize: 12, color: node.verdict === 'pass' ? token.colorSuccess : token.colorError }}>
                        {t(`verdict.${node.verdict}`)}
                      </Typography.Text>
                    )}
                  </Space>
                  {node.error && (
                    <Typography.Text type="danger" style={{ fontSize: 12, display: 'block' }}>{node.error}</Typography.Text>
                  )}
                </div>
              </List.Item>
            )}
          />

          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
            {t('run.artifacts')}
          </Typography.Text>
          {activeRun.artifacts.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.noArtifacts')} />
          ) : (
            <List
              size="small"
              dataSource={activeRun.artifacts}
              renderItem={(a) => (
                <List.Item style={{ padding: '4px 0' }}>
                  <Typography.Text style={{ fontSize: 12 }} ellipsis={{ tooltip: a.path }}>{a.path}</Typography.Text>
                </List.Item>
              )}
            />
          )}
        </div>
      )}
    </Modal>
  )
}

/** 运行历史抽屉 */
export function RunHistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const runs = useWorkflowStore(s => s.runs)
  const setRuns = useWorkflowStore(s => s.setRuns)
  const setActiveRun = useWorkflowStore(s => s.setActiveRun)

  useEffect(() => {
    if (!open) return
    void invoke<{ list: PluginWorkflowRun[] }>('run-list', { limit: 50 })
      .then(res => setRuns(res?.list || []))
      .catch(() => setRuns([]))
  }, [open, setRuns])

  return (
    <Drawer open={open} onClose={onClose} title={t('page.runHistory')} width={420}>
      {runs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.noHistory')} />
      ) : (
        <List
          size="small"
          dataSource={runs}
          renderItem={(run) => (
            <List.Item
              onClick={() => { setActiveRun(run); onClose() }}
              style={{ cursor: 'pointer' }}
            >
              <div>
                <Space size={6}>
                  <Tag color={STATUS_COLOR[run.status]}>{t(`status.${run.status}`)}</Tag>
                  <Typography.Text style={{ fontSize: 13 }}>{run.templateName || run.templateId}</Typography.Text>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  {run.startedAt ? new Date(run.startedAt * 1000).toLocaleString() : ''}
                </Typography.Text>
              </div>
            </List.Item>
          )}
        />
      )}
    </Drawer>
  )
}
