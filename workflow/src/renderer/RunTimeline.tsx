/**
 * 运行节点时间线：每个节点一张可展开卡片；展开后的 transcript 区完全对齐
 * 普通任务（宿主 workbench）的消息分段设计——任务指令/思考/正文 markdown/工具调用分段、
 * 左侧竖线、折叠单行预览、220px 限高输入输出块。
 * 智能体节点多轮时按轮次分组，每轮可独立折叠；运行中自动跟随最新轮（旧轮自动收起）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Spin, Tag, Tooltip, Typography, theme } from 'antd'
import {
  BulbOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  DisconnectOutlined,
  DownOutlined,
  RightOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons'
import type {
  PluginWorkflowNodeEvent,
  PluginWorkflowNodeRun,
  PluginWorkflowRun,
  PluginWorkflowTokenUsage,
} from '@workavatar/plugin-sdk'
import { t } from './host'
import {
  WfAnswerSegment,
  WfErrorSegment,
  WfPreviewLine,
  WfPromptSegment,
  WfThinkingSegment,
  WfTokenUsage,
  WfToolSegment,
} from './wf-chat'
import { resolveToolIcon, resolveToolTitle, useToolCatalog } from './tool-catalog'

export const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  completed: 'success',
  failed: 'error',
  aborted: 'warning',
  skipped: 'default',
}

/** Unix 秒 → 本地时间文案 */
export function formatTime(unixSec?: number): string {
  if (!unixSec) return '-'
  return new Date(unixSec * 1000).toLocaleString()
}

/** 运行耗时：终态取区间，进行中按当前时间实时计算；未开始返回 null */
export function formatDuration(startSec?: number, endSec?: number): string | null {
  if (!startSec) return null
  const secs = Math.max((endSec ?? Math.floor(Date.now() / 1000)) - startSec, 0)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

/** 单节点状态图标（带状态悬浮提示） */
function StatusIcon({ status }: { status: PluginWorkflowNodeRun['status'] }) {
  const { token } = theme.useToken()
  const style = { fontSize: 14, lineHeight: '16px' }
  const icon = (() => {
    switch (status) {
      case 'running':
        return <Spin size="small" />
      case 'completed':
        return <CheckCircleFilled style={{ ...style, color: token.colorSuccess }} />
      case 'failed':
        return <CloseCircleFilled style={{ ...style, color: token.colorError }} />
      case 'skipped':
        return <DisconnectOutlined style={{ ...style, color: token.colorTextQuaternary }} />
      default:
        return <ClockCircleOutlined style={{ ...style, color: token.colorTextQuaternary }} />
    }
  })()
  return <Tooltip title={t(`status.${status}`)}>{icon}</Tooltip>
}

/** 紧凑 token 数（卡片头展示） */
function formatTokensCompact(usage?: PluginWorkflowTokenUsage): string | null {
  if (!usage?.totalTokens) return null
  return `${t('run.tokens')} ${usage.totalTokens.toLocaleString()}`
}

/** 事件 → 轮次分组（事件有序且 round 单调递增，按相邻 round 归并） */
function groupByRound(events: PluginWorkflowNodeEvent[]): Array<{ round: number; events: PluginWorkflowNodeEvent[] }> {
  const groups: Array<{ round: number; events: PluginWorkflowNodeEvent[] }> = []
  for (const event of events) {
    const round = event.round ?? 1
    const last = groups[groups.length - 1]
    if (last?.round === round) last.events.push(event)
    else groups.push({ round, events: [event] })
  }
  return groups
}

/** 轮次内分段列表（不含轮次头） */
function SegmentList({ events, nodeRunning }: { events: PluginWorkflowNodeEvent[]; nodeRunning: boolean }) {
  const last = events.length - 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {events.map((event, i) => (
        <div key={event.index}>
          {event.type === 'prompt' && <WfPromptSegment event={event} />}
          {event.type === 'thinking' && <WfThinkingSegment event={event} streaming={nodeRunning && i === last} />}
          {event.type === 'text' && <WfAnswerSegment event={event} streaming={nodeRunning && i === last} />}
          {event.type === 'tool' && (
            <WfToolSegment event={event} toolLabel={resolveToolTitle(event.name || 'tool')} toolIcon={resolveToolIcon(event.name || '')} />
          )}
          {event.type === 'error' && <WfErrorSegment event={event} />}
        </div>
      ))}
    </div>
  )
}

/** 单轮折叠组：可点击折叠；运行中新一轮开始时自动收起旧轮、展开最新轮（尊重用户手动操作过的轮次） */
function RoundCollapse({
  round, events, expanded, onToggle, nodeRunning,
}: {
  round: number
  events: PluginWorkflowNodeEvent[]
  expanded: boolean
  onToggle: () => void
  nodeRunning: boolean
}) {
  const { token } = theme.useToken()
  const counts = useMemo(() => {
    const thinking = events.filter(e => e.type === 'thinking').length
    const tools = events.filter(e => e.type === 'tool').length
    return { thinking, tools }
  }, [events])
  /** 收起态预览：优先展示该轮最终产出的正文，其次思考，最后活动 */
  const preview = useMemo(() => {
    if (expanded) return undefined
    const lastText = [...events].reverse().find(e => e.type === 'text' && e.text)?.text
      || [...events].reverse().find(e => e.type === 'thinking' && e.text)?.text
    return lastText ? lastText.replace(/\s+/g, ' ').trim() : undefined
  }, [events, expanded])

  return (
    <div>
      <div
        onClick={onToggle}
        style={{
          padding: '5px 0', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        {expanded
          ? <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
          : <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />}
        <Typography.Text strong style={{ fontSize: 11, flexShrink: 0 }}>{t('template.round', { n: round })}</Typography.Text>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0, color: token.colorTextQuaternary, fontSize: 11 }}>
          {counts.thinking > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <BulbOutlined style={{ fontSize: 11 }} />×{counts.thinking}
            </span>
          )}
          {counts.tools > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <ToolOutlined style={{ fontSize: 11 }} />×{counts.tools}
            </span>
          )}
        </span>
        {preview != null && preview !== '' && (
          <WfPreviewLine text={preview} fontSize={11} lineHeight={16} color={token.colorTextQuaternary} />
        )}
      </div>
      {expanded && (
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
          <div style={{ position: 'relative', padding: '0 10px 10px 24px' }}>
            <SegmentList events={events} nodeRunning={nodeRunning} />
          </div>
        </div>
      )}
    </div>
  )
}

/** 多轮 transcript：每组带折叠头；跟随新一轮自动收起旧轮 */
function RoundGroups({ events, nodeRunning }: { events: PluginWorkflowNodeEvent[]; nodeRunning: boolean }) {
  const groups = useMemo(() => groupByRound(events), [events])
  const [expandedKeys, setExpandedKeys] = useState<Set<number>>(() => new Set(groups.map(g => g.round)))
  const manualRounds = useRef(new Set<number>())
  const prevMaxRound = useRef(groups[groups.length - 1]?.round ?? 0)

  // 新一轮开始：自动收起未被用户手动操作过的旧轮，展开最新轮
  const maxRound = groups[groups.length - 1]?.round ?? 0
  useEffect(() => {
    if (maxRound <= prevMaxRound.current) return
    prevMaxRound.current = maxRound
    setExpandedKeys(() => {
      const next = new Set<number>()
      for (const g of groups) {
        if (g.round === maxRound || manualRounds.current.has(g.round)) next.add(g.round)
      }
      return next
    })
  }, [maxRound, groups])

  const toggle = (round: number) => {
    manualRounds.current.add(round)
    setExpandedKeys(prev => {
      const next = new Set(prev)
      if (next.has(round)) next.delete(round)
      else next.add(round)
      return next
    })
  }

  return (
    <div>
      {groups.map(g => (
        <RoundCollapse
          key={g.round}
          round={g.round}
          events={g.events}
          expanded={expandedKeys.has(g.round)}
          onToggle={() => toggle(g.round)}
          nodeRunning={nodeRunning}
        />
      ))}
    </div>
  )
}

/** transcript 分段入口：多轮节点按轮折叠分组，单轮节点直接展示分段 */
function TranscriptSegmentList({ events, nodeRunning }: { events: PluginWorkflowNodeEvent[]; nodeRunning: boolean }) {
  if (groupByRound(events).length > 1) return <RoundGroups events={events} nodeRunning={nodeRunning} />
  return <SegmentList events={events} nodeRunning={nodeRunning} />
}

interface TimelineProps {
  run: PluginWorkflowRun
  /** 受控展开集合 */
  expandedKeys: Set<string>
  onToggle: (nodeId: string) => void
}

export function RunTimeline({ run, expandedKeys, onToggle }: TimelineProps) {
  const { token } = theme.useToken()
  useToolCatalog()
  const nodes = run.nodes
  if (nodes.length === 0) return null

  return (
    <div>
      {nodes.map((node, index) => {
        const last = index === nodes.length - 1
        const duration = node.startedAt ? formatDuration(node.startedAt, node.endedAt) : null
        const expanded = expandedKeys.has(node.nodeId)
        const canExpand = node.status !== 'pending' && node.status !== 'skipped'
        const events = node.events || []
        const tokens = formatTokensCompact(node.tokenUsage)

        const header = (
          <div
            onClick={canExpand ? () => onToggle(node.nodeId) : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
              cursor: canExpand ? 'pointer' : 'default',
              opacity: node.status === 'pending' ? 0.65 : 1,
            }}
          >
            {canExpand ? (
              <span style={{ color: token.colorTextTertiary, display: 'inline-flex', fontSize: 10, width: 12 }}>
                {expanded ? <DownOutlined /> : <RightOutlined />}
              </span>
            ) : <span style={{ display: 'inline-block', width: 12 }} />}
            <Typography.Text strong style={{ fontSize: 13 }}>{node.label}</Typography.Text>
            {node.executor ? (
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <UserOutlined style={{ fontSize: 11 }} />
                {node.executor}
              </Typography.Text>
            ) : null}
            <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>{t(`node.${node.type}`)}</Tag>
            {node.round ? (
              <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>{t('template.round', { n: node.round })}</Tag>
            ) : null}
            {node.verdict ? (
              <Tag color={node.verdict === 'pass' ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
                {t(`verdict.${node.verdict}`)}
              </Tag>
            ) : null}
            <span style={{ marginInlineStart: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {tokens && !expanded ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{tokens}</Typography.Text>
              ) : null}
              {duration ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{duration}</Typography.Text>
              ) : null}
            </span>
          </div>
        )

        return (
          <div key={node.nodeId} style={{ display: 'flex', gap: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16, flexShrink: 0 }}>
              <StatusIcon status={node.status} />
              {!last && <div style={{ flex: 1, width: 1, minHeight: 16, background: token.colorBorderSecondary, margin: '4px 0' }} />}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 12 }}>
              <div
                style={{
                  border: `1px solid ${node.status === 'failed' ? token.colorErrorBorder : token.colorBorderSecondary}`,
                  borderRadius: 8,
                  background: token.colorBgContainer,
                  padding: '7px 10px',
                }}
              >
                {header}

                {expanded ? (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }} onClick={e => e.stopPropagation()}>
                    {events.length > 0 ? (
                      <TranscriptSegmentList events={events} nodeRunning={node.status === 'running'} />
                    ) : node.output ? (
                      // input/end/condition/loop 等非智能体节点：直接展示产出
                      <Typography.Paragraph
                        style={{
                          margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          background: token.colorBgLayout, padding: '8px 10px', borderRadius: 6,
                        }}
                      >
                        {node.output}
                      </Typography.Paragraph>
                    ) : node.status === 'running' ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('status.running')}…
                      </Typography.Text>
                    ) : null}

                    {node.error ? (
                      <WfErrorSegment event={{ type: 'error', index: -1, text: node.error }} />
                    ) : null}

                    <div style={{
                      display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
                      borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 6,
                    }}>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {t('run.startedAt')} {formatTime(node.startedAt)}
                      </Typography.Text>
                      {node.endedAt ? (
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {t('run.finishedAt')} {formatTime(node.endedAt)}
                        </Typography.Text>
                      ) : null}
                      <span style={{ marginInlineStart: 'auto' }}><WfTokenUsage usage={node.tokenUsage} /></span>
                    </div>
                  </div>
                ) : node.status === 'running' ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                    {t('status.running')}…
                  </Typography.Text>
                ) : node.error ? (
                  <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }} ellipsis={{ tooltip: node.error }}>
                    {node.error}
                  </Typography.Text>
                ) : null}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
