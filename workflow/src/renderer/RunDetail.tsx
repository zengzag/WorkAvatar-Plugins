/** 运行详情：统计概要 + 运行入参 + 节点执行时间线（含 LLM/工具 transcript）+ 结果 + 产物 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, App, Button, Drawer, Popconfirm, Progress, Space, Spin, Tag, Tooltip, Typography, message, theme } from 'antd'
import {
  ApartmentOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  ExportOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
} from '@ant-design/icons'
import type { PluginWorkflowNodeRun, PluginWorkflowRun, PluginWorkflowTokenUsage } from '@workavatar/plugin-sdk'
import { invoke, t } from './host'
import { useWorkflowStore } from './store'
import { WfSection } from './wf-chat'
import { RunTimeline, STATUS_COLOR, formatDuration, formatTime } from './RunTimeline'

/** 运行中每秒重渲染一次，让耗时与当前节点实时走动 */
function useLiveTick(run: PluginWorkflowRun): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (run.status !== 'running') return
    const timer = window.setInterval(() => setTick((v) => v + 1), 1000)
    return () => window.clearInterval(timer)
  }, [run.status])
}

/** 概要统计小块 */
function StatCard({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  const { token } = theme.useToken()
  return (
    <div style={{
      flex: '1 1 0', minWidth: 120,
      border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8,
      padding: '8px 12px', background: token.colorBgContainer,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: token.colorTextTertiary }}>
        {icon}
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{label}</Typography.Text>
      </div>
      <div style={{ marginTop: 3, fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: token.colorText }}>{value}</div>
      {sub ? <div style={{ marginTop: 1 }}>{sub}</div> : null}
    </div>
  )
}

/** 节点展开集合：运行中节点自动展开；打开已结束的运行时失败节点默认展开；运行结束不强制收起 */
function useExpandedNodes(run: PluginWorkflowRun): {
  expandedKeys: Set<string>
  toggle: (nodeId: string) => void
  setAll: (expanded: boolean) => void
} {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const initializedRunId = useRef<string | null>(null)

  // 每个 run 仅初始化一次：打开时已终态 → 失败节点展开；运行中打开 → 不预置（靠自动展开，结束后保留现场）
  useEffect(() => {
    if (initializedRunId.current === run.runId) return
    initializedRunId.current = run.runId
    if (run.status !== 'running') {
      setExpandedKeys(new Set(run.nodes.filter(n => n.status === 'failed').map(n => n.nodeId)))
    }
  }, [run.runId, run.status, run.nodes])

  const runningId = run.nodes.find(n => n.status === 'running')?.nodeId
  useEffect(() => {
    if (!runningId) return
    setExpandedKeys(prev => prev.has(runningId) ? prev : new Set(prev).add(runningId))
  }, [runningId])

  return {
    expandedKeys,
    toggle: (nodeId) => setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    }),
    setAll: (expanded) => setExpandedKeys(expanded
      ? new Set(run.nodes.filter(n => n.status !== 'pending' && n.status !== 'skipped').map(n => n.nodeId))
      : new Set()),
  }
}

/** 汇总所有智能体节点的 token 用量 */
function sumTokenUsage(nodes: PluginWorkflowNodeRun[]): PluginWorkflowTokenUsage {
  const total: PluginWorkflowTokenUsage = {}
  for (const node of nodes) {
    const u = node.tokenUsage
    if (!u) continue
    total.promptTokens = (total.promptTokens || 0) + (u.promptTokens || 0)
    total.completionTokens = (total.completionTokens || 0) + (u.completionTokens || 0)
    total.totalTokens = (total.totalTokens || 0) + (u.totalTokens || 0)
    total.cachedTokens = (total.cachedTokens || 0) + (u.cachedTokens || 0)
  }
  return total
}

/** 产物文件行：路径（可复制）+ 打开文件 + 在文件夹中显示 */
function ArtifactRow({ runId, filePath }: { runId: string; filePath: string }) {
  const { token } = theme.useToken()
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
    <div style={{ display: 'flex', gap: 6, padding: '2px 0', minWidth: 0, alignItems: 'center' }}>
      <FileOutlined style={{ color: token.colorTextTertiary, fontSize: 12, flexShrink: 0 }} />
      <Typography.Text
        style={{ fontSize: 12, flex: 1, minWidth: 0 }}
        ellipsis={{ tooltip: filePath }}
        copyable={{ text: filePath, tooltips: [t('run.copy'), t('run.copied')] }}
      >
        {filePath}
      </Typography.Text>
      <Tooltip title={t('run.openFile')}>
        <Button
          size="small" type="text"
          loading={busy === 'open'}
          icon={<ExportOutlined />}
          onClick={() => call('run-open-artifact', 'open')}
        />
      </Tooltip>
      <Tooltip title={t('run.openFolder')}>
        <Button
          size="small" type="text"
          loading={busy === 'reveal'}
          icon={<FolderOpenOutlined />}
          onClick={() => call('run-reveal-artifact', 'reveal')}
        />
      </Tooltip>
    </div>
  )
}

export function RunBody({ run, actions }: { run: PluginWorkflowRun; actions?: ReactNode }) {
  const { token } = theme.useToken()
  useLiveTick(run)
  const { expandedKeys, toggle, setAll } = useExpandedNodes(run)

  const done = run.nodes.filter((n) => n.status === 'completed').length
  const failed = run.nodes.filter((n) => n.status === 'failed').length
  const current = run.nodes.find((n) => n.status === 'running')
  const progressPct = run.nodes.length ? Math.round((done / run.nodes.length) * 100) : 0
  const duration = formatDuration(run.startedAt, run.endedAt)
  const totalTokens = useMemo(() => sumTokenUsage(run.nodes), [run.nodes])

  /** 最终结果：优先结束节点产出，其次最后一个有产出的节点 */
  const result = useMemo(() => {
    const outputs = run.nodes.filter((n) => n.output)
    return outputs.filter((n) => n.type === 'end').pop()?.output
      || outputs[outputs.length - 1]?.output
      || ''
  }, [run.nodes])

  /** 产物按节点分组 */
  const nodeLabelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of run.nodes) map.set(node.nodeId, node.label)
    return map
  }, [run.nodes])
  const artifactsByNode = useMemo(() => {
    const groups = new Map<string, typeof run.artifacts>()
    for (const artifact of run.artifacts) {
      const list = groups.get(artifact.nodeId) || []
      list.push(artifact)
      groups.set(artifact.nodeId, list)
    }
    return groups
  }, [run.artifacts])

  const variableEntries = Object.entries(run.variables || {}).filter(([, v]) => String(v ?? '').trim())
  const expandableCount = run.nodes.filter(n => n.status !== 'pending' && n.status !== 'skipped').length
  const allExpanded = expandableCount > 0 && expandedKeys.size >= expandableCount

  return (
    <div>
      {/* 统计卡片区 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <StatCard
          icon={<ApartmentOutlined style={{ fontSize: 13 }} />}
          label={t('run.statNodes')}
          value={`${done}/${run.nodes.length}`}
          sub={
            <Progress
              percent={progressPct}
              size="small"
              status={failed > 0 ? 'exception' : run.status === 'running' ? 'active' : 'normal'}
              showInfo={false}
            />
          }
        />
        <StatCard
          icon={<ClockCircleOutlined style={{ fontSize: 13 }} />}
          label={t('run.duration')}
          value={duration || '-'}
          sub={<Typography.Text type="secondary" style={{ fontSize: 10 }}>{formatTime(run.startedAt)}</Typography.Text>}
        />
        <StatCard
          icon={<DatabaseOutlined style={{ fontSize: 13 }} />}
          label={t('run.statTokens')}
          value={totalTokens.totalTokens ? totalTokens.totalTokens.toLocaleString() : '-'}
          sub={totalTokens.totalTokens ? (
            <Typography.Text type="secondary" style={{ fontSize: 10 }}>
              ↑{(totalTokens.promptTokens || 0).toLocaleString()} ↓{(totalTokens.completionTokens || 0).toLocaleString()}
            </Typography.Text>
          ) : null}
        />
        <StatCard
          icon={<FolderOutlined style={{ fontSize: 13 }} />}
          label={t('run.statArtifacts')}
          value={run.artifacts.length}
        />
      </div>

      {/* 状态条 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 12px', borderRadius: 6, background: token.colorFillQuaternary, marginBottom: 12,
      }}>
        <Tag color={STATUS_COLOR[run.status]} style={{ marginInlineEnd: 0 }}>{t(`status.${run.status}`)}</Tag>
        {run.endedAt ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('run.finishedAt')}: {formatTime(run.endedAt)}
          </Typography.Text>
        ) : null}
        {actions ? <div style={{ marginInlineStart: 'auto' }}>{actions}</div> : null}
      </div>

      {run.status === 'running' ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
          {current ? t('run.currentNode', { name: current.label }) : t('run.starting')}
        </Typography.Text>
      ) : null}

      {run.error ? <Alert type="error" showIcon message={run.error} style={{ marginBottom: 12 }} /> : null}

      {/* 运行入参（默认收起，标题预览参数名） */}
      {variableEntries.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <WfSection
            title={t('run.inputs')}
            preview={variableEntries.map(([name]) => name).join(' · ')}
            defaultExpanded={false}
          >
            <div style={{
              border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, overflow: 'hidden',
              marginBottom: 4,
            }}>
              {variableEntries.map(([name, value], idx) => (
                <div
                  key={name}
                  style={{
                    display: 'flex', gap: 10, padding: '6px 10px',
                    borderTop: idx === 0 ? 'none' : `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <Typography.Text style={{ fontSize: 12, flexShrink: 0, minWidth: 90, color: token.colorTextSecondary }}>
                    {name}
                  </Typography.Text>
                  <Typography.Paragraph
                    style={{ margin: 0, fontSize: 12, flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    ellipsis={{ rows: 3, expandable: true, symbol: t('run.expandText') }}
                    copyable={{ text: String(value) }}
                  >
                    {String(value)}
                  </Typography.Paragraph>
                </div>
              ))}
            </div>
          </WfSection>
        </div>
      ) : null}

      {/* 节点时间线 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('run.nodeProgress', { done, total: run.nodes.length })}
        </Typography.Text>
        {expandableCount > 0 ? (
          <Button
            type="link" size="small" style={{ marginInlineStart: 'auto', fontSize: 12, padding: 0, height: 'auto' }}
            onClick={() => setAll(!allExpanded)}
          >
            {allExpanded ? t('run.collapseAll') : t('run.expandAll')}
          </Button>
        ) : null}
      </div>
      <RunTimeline run={run} expandedKeys={expandedKeys} onToggle={toggle} />

      {/* 最终结果（可折叠，限高滚动 + 复制） */}
      {result ? (
        <div style={{ margin: '14px 0' }}>
          <WfSection title={t('run.result')} defaultExpanded>
            <Typography.Paragraph
              style={{
                margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 300, overflow: 'auto', marginBottom: 2,
              }}
              copyable={{ text: result, tooltips: [t('run.copy'), t('run.copied')] }}
            >
              {result}
            </Typography.Paragraph>
          </WfSection>
        </div>
      ) : null}

      {/* 产出文件（按节点分组；默认收起，无产物时收起只留标题） */}
      <div>
        <WfSection
          title={`${t('run.artifacts')}（${run.artifacts.length}）`}
          defaultExpanded={run.artifacts.length > 0}
        >
          {run.artifacts.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('run.noArtifacts')}</Typography.Text>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...artifactsByNode.entries()].map(([nodeId, artifacts]) => (
                <div key={nodeId} style={{
                  border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, padding: '6px 10px',
                }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 3 }}>
                    {nodeLabelById.get(nodeId) || nodeId}
                  </Typography.Text>
                  {artifacts.map((a, index) => (
                    <ArtifactRow key={`${a.nodeId}-${index}`} runId={run.runId} filePath={a.path} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </WfSection>
      </div>
    </div>
  )
}

/** 运行详情抽屉：从运行历史点入，展示完整执行过程并支持中止 / 删除 */
export function RunDetailDrawer() {
  const { modal } = App.useApp()
  const runId = useWorkflowStore((s) => s.detailRunId)
  const run = useWorkflowStore((s) => s.detailRun)
  const closeRunDetail = useWorkflowStore((s) => s.closeRunDetail)
  const deleteRun = useWorkflowStore((s) => s.deleteRun)

  const remove = async () => {
    if (!run) return
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

  const abort = () => {
    if (run) void invoke('run-abort', { runId: run.runId })
  }

  const actions = run ? (
    <Space size={6}>
      {run.status === 'running' ? (
        <Popconfirm title={t('run.abortConfirm')} onConfirm={abort} okButtonProps={{ danger: true }}>
          <Button size="small" danger>{t('run.abort')}</Button>
        </Popconfirm>
      ) : (
        <Popconfirm title={t('run.deleteConfirm')} onConfirm={remove} okButtonProps={{ danger: true }}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      )}
    </Space>
  ) : null

  return (
    <Drawer
      open={!!runId}
      onClose={closeRunDetail}
      width={780}
      destroyOnHidden
      title={
        <Space size={8}>
          <span>{t('run.detail')}</span>
          {run ? (
            <Typography.Text type="secondary" style={{ fontSize: 13, maxWidth: 360 }} ellipsis={{ tooltip: run.templateName }}>
              {run.templateName || run.templateId}
            </Typography.Text>
          ) : null}
        </Space>
      }
    >
      {!run ? (
        <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
      ) : (
        <RunBody run={run} actions={actions} />
      )}
    </Drawer>
  )
}
