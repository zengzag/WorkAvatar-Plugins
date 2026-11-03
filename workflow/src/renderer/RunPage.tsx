/** 运行页：办公室实况为主视图，员工输出 / 结果 / 入参 / 统计按需展开 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Button,
  Drawer,
  Empty,
  Popconfirm,
  Popover,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  ExportOutlined,
  FileOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  MinusOutlined,
  RightOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluginWorkflowNodeRun, PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, t } from './host'
import { useWorkflowStore } from './store'
import { OfficeScene } from './OfficeScene'
import { RunTimeline, TranscriptSegmentList } from './RunTimeline'
import { STATUS_COLOR, avatarChar, employeeHue, formatDuration, formatTime, sumTokenUsage } from './utils'

/** 运行中每秒重渲染一次，让耗时与当前节点实时走动 */
function useLiveTick(status?: string): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'running') return
    const timer = window.setInterval(() => setTick(v => v + 1), 1000)
    return () => window.clearInterval(timer)
  }, [status])
}

/** 当前节点的最终输出：优先最后一段正文，其次节点 output */
function nodeOutputText(node: PluginWorkflowNodeRun): string {
  const events = node.events || []
  const lastText = [...events].reverse().find(event => event.type === 'text' && event.text)
  return lastText?.text || node.output || ''
}

/** 节点首条任务指令 */
function nodePrompt(node: PluginWorkflowNodeRun): string {
  return (node.events || []).find(event => event.type === 'prompt')?.text || ''
}

function NodeStatusTag({ status }: { status: string }) {
  const icon = status === 'completed'
    ? <CheckCircleFilled />
    : status === 'failed'
      ? <CloseCircleFilled />
      : status === 'running'
        ? <LoadingOutlined spin />
        : status === 'skipped'
          ? <MinusOutlined />
          : null
  return (
    <Tag color={STATUS_COLOR[status] || 'default'} icon={icon} style={{ marginInlineEnd: 0 }}>
      {t(`status.${status}`)}
    </Tag>
  )
}

/** 可折叠分区：默认展示一行摘要，点开后展示完整内容 */
function Section({ title, count, preview, defaultOpen, children }: {
  title: ReactNode
  count?: ReactNode
  preview?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="wf-sec">
      <button className="wf-sec-head" onClick={() => setOpen(v => !v)}>
        {open ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />}
        {title}
        {count != null ? <span className="wf-count">{count}</span> : null}
      </button>
      {!open && preview ? <div className="wf-sec-preview">{preview}</div> : null}
      {open ? <div className="wf-sec-body">{children}</div> : null}
    </div>
  )
}

/** 产物文件行：打开 / 在文件夹中显示 */
function ArtifactRow({ runId, filePath }: { runId: string; filePath: string }) {
  const { message } = App.useApp()
  const [busy, setBusy] = useState<'open' | 'reveal' | null>(null)

  const call = async (channel: 'run-open-artifact' | 'run-reveal-artifact', kind: 'open' | 'reveal') => {
    setBusy(kind)
    try {
      const res = await invoke<{ ok?: boolean; error?: string }>(channel, { runId, path: filePath })
      if (!res?.ok) message.error(`${t('run.openFailed')}: ${t(`run.artifactError.${res?.error || 'unknown'}`)}`)
    } catch (err: unknown) {
      message.error(`${t('run.openFailed')}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="wf-file-row">
      <div className="wf-file-icon"><FileOutlined /></div>
      <div className="wf-file-main">
        <div className="wf-file-name" title={filePath}>{filePath.split(/[\\/]/).pop() || filePath}</div>
        <div className="wf-file-path" title={filePath}>{filePath}</div>
      </div>
      <div className="wf-file-actions">
        <Tooltip title={t('run.openFile')}>
          <Button
            size="small"
            type="text"
            loading={busy === 'open'}
            icon={<ExportOutlined />}
            onClick={() => void call('run-open-artifact', 'open')}
          />
        </Tooltip>
        <Tooltip title={t('run.openFolder')}>
          <Button
            size="small"
            type="text"
            loading={busy === 'reveal'}
            icon={<FolderOpenOutlined />}
            onClick={() => void call('run-reveal-artifact', 'reveal')}
          />
        </Tooltip>
      </div>
    </div>
  )
}

/** 员工输出抽屉：指令 / 输出 / 执行过程 / 该员工产物 */
function OutputSheet({ run, nodeId, onClose }: {
  run: PluginWorkflowRun
  nodeId: string | null
  onClose: () => void
}) {
  const { token } = theme.useToken()
  const node = nodeId ? run.nodes.find(n => n.nodeId === nodeId) || null : null
  const hue = employeeHue(node?.executor || node?.label || '')
  const output = node ? nodeOutputText(node) : ''
  const prompt = node ? nodePrompt(node) : ''
  const artifacts = node ? run.artifacts.filter(a => a.nodeId === node.nodeId) : []
  const events = node?.events || []
  const duration = node?.startedAt ? formatDuration(node.startedAt, node.endedAt) : null

  return (
    <Drawer
      open={!!node}
      onClose={onClose}
      size={450}
      destroyOnHidden
      title={null}
      closable={false}
      styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' } }}
    >
      {!node ? null : (
        <>
          <div style={{ padding: '20px 20px 14px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
            <div className="wf-sheet-head">
              <div
                className="wf-avatar"
                style={{ background: `linear-gradient(145deg,hsl(${hue} 78% 66%),hsl(${hue} 62% 46%))` }}
              >
                {avatarChar(node.executor || node.label)}
              </div>
              <div className="wf-sheet-title">
                <h3>{node.executor || node.label}<NodeStatusTag status={node.status} /></h3>
                <div className="wf-sheet-role">{node.label} · {t(`node.${node.type}`)}</div>
              </div>
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} style={{ color: token.colorTextTertiary }} />
            </div>
            <div className="wf-sheet-meta" style={{ marginTop: 11 }}>
              {duration ? <span>{t('run.duration')} <b>{duration}</b></span> : null}
              {node.tokenUsage?.totalTokens ? <span>Token <b>{node.tokenUsage.totalTokens.toLocaleString()}</b></span> : null}
              {node.round ? <span>{t('template.round', { n: node.round })}</span> : null}
              {node.verdict ? <span>{t(`verdict.${node.verdict}`)}</span> : null}
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 16px' }}>
            {prompt ? (
              <Section title={t('run.instruction')} preview={prompt.replace(/\s+/g, ' ').slice(0, 80)}>
                <div style={{ fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre-wrap', color: token.colorText }}>
                  {prompt}
                </div>
              </Section>
            ) : null}

            <Section
              title={t('run.output')}
              count={node.status === 'running' ? t('run.generating') : undefined}
              defaultOpen
            >
              {node.status === 'pending' || node.status === 'skipped' ? (
                <div className="wf-waiting">
                  <LoadingOutlined />
                  <span>{t('run.waitingOutput')}</span>
                </div>
              ) : output ? (
                <div className="wf-prose">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
                  >
                    {output}
                  </ReactMarkdown>
                  {node.status === 'running' ? <span style={{ color: token.colorTextQuaternary }}>▊</span> : null}
                </div>
              ) : (
                <div className="wf-waiting">
                  <LoadingOutlined />
                  <span>{node.status === 'running' ? t('run.generating') : t('run.noOutput')}</span>
                </div>
              )}
            </Section>

            {events.length > 0 ? (
              <Section title={t('run.execution')} count={events.length} preview={t('run.executionHint')}>
                <TranscriptSegmentList events={events} nodeRunning={node.status === 'running'} />
              </Section>
            ) : null}

            {node.error ? (
              <div className="wf-sec">
                <Alert type="error" showIcon message={node.error} />
              </div>
            ) : null}

            {artifacts.length > 0 ? (
              <Section title={t('run.artifacts')} count={artifacts.length} defaultOpen>
                {artifacts.map((artifact, index) => (
                  <ArtifactRow key={`${artifact.nodeId}-${index}`} runId={run.runId} filePath={artifact.path} />
                ))}
              </Section>
            ) : null}
          </div>

          <div style={{ padding: '12px 20px', borderTop: `1px solid ${token.colorBorderSecondary}`, display: 'flex', alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 11, marginRight: 'auto' }}>
              {node.status === 'running' ? t('run.liveHint') : node.status === 'pending' ? t('run.waitingOutput') : t('run.employeeDone')}
            </Typography.Text>
            <Button size="small" onClick={onClose}>{t('run.close')}</Button>
          </div>
        </>
      )}
    </Drawer>
  )
}

/** 结果抽屉：结果 / 产出文件 / 运行入参 */
function ResultSheet({ run, open, onClose }: { run: PluginWorkflowRun; open: boolean; onClose: () => void }) {
  const result = useMemo(() => {
    const outputs = run.nodes.filter(n => n.output)
    return outputs.filter(n => n.type === 'end').pop()?.output
      || outputs[outputs.length - 1]?.output
      || ''
  }, [run.nodes])
  const nodeLabel = useMemo(() => new Map(run.nodes.map(n => [n.nodeId, n.label])), [run.nodes])
  const artifactsByNode = useMemo(() => {
    const groups = new Map<string, typeof run.artifacts>()
    for (const artifact of run.artifacts) {
      const list = groups.get(artifact.nodeId) || []
      list.push(artifact)
      groups.set(artifact.nodeId, list)
    }
    return groups
  }, [run.artifacts])
  const variableEntries = Object.entries(run.variables || {}).filter(([, value]) => String(value ?? '').trim())

  return (
    <Drawer open={open} onClose={onClose} size={540} destroyOnHidden title={t('run.result')}>
      <Tabs
        items={[
          {
            key: 'result',
            label: t('run.result'),
            children: result ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ textAlign: 'right' }}>
                  <Button
                    size="small"
                    type="text"
                    icon={<CopyOutlined />}
                    onClick={() => void navigator.clipboard.writeText(result).catch(() => {})}
                  >
                    {t('run.copy')}
                  </Button>
                </div>
                <div className="wf-prose">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{ a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
                  >
                    {result}
                  </ReactMarkdown>
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.noOutput')} />
            ),
          },
          {
            key: 'files',
            label: `${t('run.artifacts')} (${run.artifacts.length})`,
            children: run.artifacts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.noArtifacts')} />
            ) : (
              <div>
                {[...artifactsByNode.entries()].map(([nodeId, artifacts]) => (
                  <div key={nodeId} style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>{nodeLabel.get(nodeId) || nodeId}</Typography.Text>
                    {artifacts.map((artifact, index) => (
                      <ArtifactRow key={`${artifact.nodeId}-${index}`} runId={run.runId} filePath={artifact.path} />
                    ))}
                  </div>
                ))}
              </div>
            ),
          },
          {
            key: 'inputs',
            label: t('run.inputs'),
            children: variableEntries.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('run.noVariables')}</Typography.Text>
            ) : (
              <div>
                {variableEntries.map(([name, value]) => (
                  <div key={name} className="wf-input-row">
                    <div className="wf-input-key">{name}</div>
                    <div className="wf-input-val">{String(value)}</div>
                    <Button
                      size="small"
                      type="text"
                      icon={<CopyOutlined />}
                      onClick={() => void navigator.clipboard.writeText(String(value)).catch(() => {})}
                    />
                  </div>
                ))}
              </div>
            ),
          },
        ]}
      />
    </Drawer>
  )
}

/** 完整节点时间线抽屉：需要逐条查看思考与工具调用时打开 */
function TimelineDrawer({ run, open, onClose }: { run: PluginWorkflowRun; open: boolean; onClose: () => void }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!open) return
    const failed = run.nodes.filter(n => n.status === 'failed').map(n => n.nodeId)
    setExpandedKeys(new Set(failed))
    // 仅在打开时初始化一次，后续事件更新不打断用户手动展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run.runId])

  const runningId = run.nodes.find(n => n.status === 'running')?.nodeId
  useEffect(() => {
    if (!open || !runningId) return
    setExpandedKeys(prev => prev.has(runningId) ? prev : new Set(prev).add(runningId))
  }, [open, runningId])

  return (
    <Drawer open={open} onClose={onClose} size={780} destroyOnHidden title={t('run.allOutputs')}>
      <RunTimeline
        run={run}
        expandedKeys={expandedKeys}
        onToggle={(nodeId) => setExpandedKeys(prev => {
          const next = new Set(prev)
          if (next.has(nodeId)) next.delete(nodeId)
          else next.add(nodeId)
          return next
        })}
      />
    </Drawer>
  )
}

export function RunPage() {
  const { token } = theme.useToken()
  const { modal, message } = App.useApp()
  const run = useWorkflowStore(s => s.run)
  const runLoading = useWorkflowStore(s => s.runLoading)
  const closeRun = useWorkflowStore(s => s.closeRun)
  const deleteRun = useWorkflowStore(s => s.deleteRun)

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [resultOpen, setResultOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)

  useLiveTick(run?.status)

  if (runLoading) {
    return <div className="wf-run-page" style={{ alignItems: 'center', justifyContent: 'center' }}><Spin /></div>
  }

  if (!run) {
    return (
      <div className="wf-run-page" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('run.notFound')}>
          <Button onClick={closeRun}>{t('run.backToList')}</Button>
        </Empty>
      </div>
    )
  }

  const done = run.nodes.filter(n => n.status === 'completed').length
  const pct = run.nodes.length ? Math.round(done / run.nodes.length * 100) : 0
  const duration = formatDuration(run.startedAt, run.endedAt)
  const totalTokens = sumTokenUsage(run.nodes)
  const current = run.nodes.find(n => n.status === 'running')
  const liveHint = run.status === 'running'
    ? current
      ? t('run.currentNode', { name: current.label })
      : t('run.starting')
    : run.status === 'completed'
      ? t('run.finishedHint')
      : t('run.clickStationHint')

  const abort = () => {
    void invoke('run-abort', { runId: run.runId })
  }

  const remove = async () => {
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

  const stats = (
    <div className="wf-stats">
      <div className="wf-stats-title">{t('run.details')}</div>
      <div className="wf-stats-grid">
        <div className="wf-stat">
          <div className="wf-stat-label">{t('run.statNodes')}</div>
          <div className="wf-stat-value">
            {done}<span style={{ fontSize: 11, color: token.colorTextTertiary, fontWeight: 400 }}> / {run.nodes.length}</span>
          </div>
          <div className="wf-mini-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
        <div className="wf-stat">
          <div className="wf-stat-label">{t('run.duration')}</div>
          <div className="wf-stat-value">{duration || '-'}</div>
          <div className="wf-stat-sub">{formatTime(run.startedAt)}</div>
        </div>
        <div className="wf-stat">
          <div className="wf-stat-label">{t('run.statTokens')}</div>
          <div className="wf-stat-value">{totalTokens.totalTokens ? totalTokens.totalTokens.toLocaleString() : '-'}</div>
          <div className="wf-stat-sub">
            ↑{(totalTokens.promptTokens || 0).toLocaleString()} · ↓{(totalTokens.completionTokens || 0).toLocaleString()}
          </div>
        </div>
        <div className="wf-stat">
          <div className="wf-stat-label">{t('run.statArtifacts')}</div>
          <div className="wf-stat-value">{run.artifacts.length}</div>
          <div className="wf-stat-sub">{t('run.artifactCountHint')}</div>
        </div>
      </div>
    </div>
  )

  const variableEntries = Object.entries(run.variables || {}).filter(([, value]) => String(value ?? '').trim())
  const inputs = (
    <div className="wf-stats" style={{ minWidth: 280 }}>
      <div className="wf-stats-title">{t('run.inputs')}</div>
      {variableEntries.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('run.noVariables')}</Typography.Text>
      ) : (
        variableEntries.map(([name, value]) => (
          <div key={name} className="wf-input-row">
            <div className="wf-input-key">{name}</div>
            <div className="wf-input-val">{String(value)}</div>
          </div>
        ))
      )}
    </div>
  )

  return (
    <div className="wf-run-page">
      <div className="wf-run-head">
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={closeRun} title={t('run.backToList')} />
        <span className="wf-run-title">{run.templateName || t('run.detail')}</span>
        <NodeStatusTag status={run.status} />
        <div className="wf-meta">
          <span>{duration || '-'}</span>
          <span className="wf-meta-sep" />
          <span><b>{totalTokens.totalTokens ? totalTokens.totalTokens.toLocaleString() : '-'}</b> {t('run.tokens')}</span>
          <Popover content={stats} trigger="click" placement="bottomRight">
            <Button className="wf-meta-link" type="text">{t('run.details')}</Button>
          </Popover>
        </div>
        <div className="wf-run-actions">
          <Popover content={inputs} trigger="click" placement="bottomRight">
            <Button size="small" type="text" icon={<UnorderedListOutlined />}>{t('run.inputs')}</Button>
          </Popover>
          {run.status === 'running' ? (
            <Popconfirm title={t('run.abortConfirm')} onConfirm={abort} okButtonProps={{ danger: true }}>
              <Button size="small" danger>{t('run.abort')}</Button>
            </Popconfirm>
          ) : (
            <Popconfirm title={t('run.deleteConfirm')} onConfirm={() => void remove()} okButtonProps={{ danger: true }}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} title={t('run.delete')} />
            </Popconfirm>
          )}
        </div>
      </div>

      {run.error ? <Alert className="wf-run-error" type="error" showIcon message={run.error} /> : null}

      <div className="wf-office-wrap">
        {run.nodes.some(n => n.executor) ? (
          <OfficeScene
            run={run}
            onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
          />
        ) : (
          <div className="wf-office-empty">{t('run.noExecutors')}</div>
        )}
      </div>

      <div className="wf-run-foot">
        <div className="wf-progress">
          <span className="wf-progress-label">{t('run.overallProgress')}</span>
          <div className="wf-progress-bar"><i style={{ width: `${pct}%` }} /></div>
          <span className="wf-progress-count">{done} / {run.nodes.length}</span>
        </div>
        <div className="wf-foot-hint">{liveHint}</div>
        <Button size="small" type="text" icon={<UnorderedListOutlined />} onClick={() => setTimelineOpen(true)}>
          {t('run.allOutputs')}
        </Button>
        <Button size="small" onClick={() => setResultOpen(true)}>{t('run.viewResult')}</Button>
      </div>

      <OutputSheet run={run} nodeId={selectedNodeId} onClose={() => setSelectedNodeId(null)} />
      <ResultSheet run={run} open={resultOpen} onClose={() => setResultOpen(false)} />
      <TimelineDrawer run={run} open={timelineOpen} onClose={() => setTimelineOpen(false)} />
    </div>
  )
}
