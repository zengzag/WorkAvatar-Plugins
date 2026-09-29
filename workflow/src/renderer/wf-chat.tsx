/**
 * 模板任务对话展示件：完全对齐普通任务（宿主 workbench）的消息分段设计语言。
 * 复刻 ThinkingSegment / ToolCallSegment / AnswerSegment / PreviewLine 的结构与视觉：
 * 左侧竖线 + 展开箭头 + 分组图标 + 折叠态单行预览 + 等高 pre 输入/输出块。
 */
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Tooltip, Typography, theme } from 'antd'
import {
  BulbOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DownOutlined,
  LoadingOutlined,
  RightOutlined,
  SendOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PluginWorkflowNodeEvent, PluginWorkflowTokenUsage } from '@workavatar/plugin-sdk'
import { t } from './host'

const { Text } = Typography

/** 折叠态预览行：内容按容器宽度折行、仅暴露最后一行（对齐宿主 PreviewLine） */
export const WfPreviewLine: React.FC<{
  text: string
  fontSize: number
  lineHeight: number
  color: string
}> = ({ text, fontSize, lineHeight, color }) => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div
      ref={ref}
      style={{
        flex: 1, minWidth: 0, height: lineHeight, fontSize,
        lineHeight: `${lineHeight}px`, color, overflow: 'hidden',
      }}
    >
      {text}
    </div>
  )
}

interface LineProps {
  /** 展开态标题；折叠态固定用 title */
  title: string
  expanded: boolean
  onToggle: () => void
  icon: React.ReactNode
  iconColor: string
  /** 折叠态流式/内容预览（仅暴露最后一行） */
  preview?: string
  streamingDot?: boolean
  /** 标题右侧附加信息（耗时/字数/错误等） */
  extra?: React.ReactNode
  children?: React.ReactNode
}

/** 对话分段通用骨架：头部行 + 左侧贯穿竖线 + 内容区（对齐宿主 header/竖线布局） */
const WfLine: React.FC<LineProps> = ({ title, expanded, onToggle, icon, iconColor, preview, streamingDot, extra, children }) => {
  const { token } = theme.useToken()
  return (
    <div style={{ marginBottom: 2 }}>
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
        <span style={{ display: 'inline-flex', flexShrink: 0, fontSize: 12, color: iconColor }}>{icon}</span>
        <Text ellipsis style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0, maxWidth: 260 }}>{title}</Text>
        {!expanded && preview != null && preview !== '' && (
          <WfPreviewLine text={preview} fontSize={11} lineHeight={16} color={token.colorTextQuaternary} />
        )}
        {extra}
        {streamingDot && (
          <span style={{
            width: 6, height: 6, borderRadius: 3, background: token.colorPrimary, flexShrink: 0,
            animation: 'wf-pulse 1.2s ease-in-out infinite',
          }} />
        )}
        <style>{`@keyframes wf-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }`}</style>
      </div>
      {expanded && (
        <div style={{ position: 'relative' }}>
          <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
          <div style={{ position: 'relative', padding: '0 10px 10px 24px' }}>{children}</div>
        </div>
      )}
    </div>
  )
}

/** JSON 简易高亮（对齐宿主 ToolCallSegment.highlightJson 的着色语义） */
function highlightJson(
  json: string,
  colors: { key: string; string: string; number: string; boolean: string; null: string; bracket: string },
): Array<string | React.ReactElement> {
  const parts: Array<string | React.ReactElement> = []
  const regex = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|(true|false)\b|(null)\b|([{}[\]:,])/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = regex.exec(json)) !== null) {
    if (match.index > lastIndex) parts.push(json.slice(lastIndex, match.index))
    const groups: Array<[number, string, string]> = [
      [1, 'key', colors.key], [2, 'string', colors.string], [3, 'number', colors.number],
      [4, 'boolean', colors.boolean], [5, 'null', colors.null], [6, 'bracket', colors.bracket],
    ]
    for (const [gi, key, color] of groups) {
      if (match[gi] !== undefined) {
        parts.push(<span key={`${key}-${i++}`} style={{ color }}>{match[gi]}</span>)
        break
      }
    }
    lastIndex = regex.lastIndex
  }
  if (lastIndex < json.length) parts.push(json.slice(lastIndex))
  return parts
}

const isLikelyJson = (str: string) => {
  const trimmed = str.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

/** pre 输入/输出块（对齐宿主：220px 限高 + 边框 + 复制按钮在标题行） */
const WfPre: React.FC<{ text: string; expanded: boolean; maxHeight?: number }> = ({ text, expanded, maxHeight = 220 }) => {
  const { token } = theme.useToken()
  const clipped = text.length > 3000 && !expanded ? `${text.slice(0, 3000)}\n…` : text
  const highlighted = useMemo(
    () => (isLikelyJson(clipped)
      ? highlightJson(clipped, {
        key: token.colorPrimary, string: token.colorSuccess, number: token.colorWarning,
        boolean: token.colorInfo, null: token.colorTextQuaternary, bracket: token.colorTextSecondary,
      })
      : null),
    [clipped, token],
  )
  return (
    <pre style={{
      margin: 0, padding: '8px 10px',
      background: token.colorBgLayout, borderRadius: 6,
      fontSize: 12, lineHeight: 1.6, maxHeight: expanded ? 600 : maxHeight, overflow: 'auto',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      border: `1px solid ${token.colorBorderSecondary}`,
      fontFamily: token.fontFamilyCode,
    }}>
      {highlighted ?? clipped}
    </pre>
  )
}

/** 标题行内的复制按钮（对齐宿主「入参/结果」标题行的复制 icon） */
const CopyIcon: React.FC<{ text: string }> = ({ text }) => {
  const { token } = theme.useToken()
  return (
    <Tooltip title={t('run.copy')}>
      <CopyOutlined
        onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(text).catch(() => {}) }}
        style={{ fontSize: 11, color: token.colorTextQuaternary, cursor: 'pointer', flexShrink: 0 }}
      />
    </Tooltip>
  )
}

/** 任务指令（prompt）段：默认折叠 + 单行预览 + 复制 */
export const WfPromptSegment = memo(
  function WfPromptSegment({ event }: { event: PluginWorkflowNodeEvent }) {
    const { token } = theme.useToken()
    const [expanded, setExpanded] = useState(false)
    const text = event.text || ''
    return (
      <WfLine
        title={t('run.event.prompt')}
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        icon={<SendOutlined style={{ fontSize: 12, color: token.colorPrimary }} />}
        iconColor={token.colorPrimary}
        preview={!expanded ? text.replace(/\s+/g, ' ').slice(0, 200) : undefined}
        extra={<CopyIcon text={text} />}
      >
        <div style={{
          fontSize: 12, lineHeight: 1.7, color: token.colorText,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {text}
        </div>
      </WfLine>
    )
  },
  (prev, next) => prev.event.text === next.event.text,
)

/** 思考过程段：对齐宿主 ThinkingSegment（竖线 + 最大高度 + 流式预览） */
export const WfThinkingSegment = memo(
  function WfThinkingSegment({ event, streaming }: { event: PluginWorkflowNodeEvent; streaming: boolean }) {
    const { token } = theme.useToken()
    const [expanded, setExpanded] = useState(false)
    const text = event.text || ''
    return (
      <WfLine
        title={t('run.event.thinking')}
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
        icon={<BulbOutlined style={{ fontSize: 12, color: token.colorTextTertiary }} />}
        iconColor={token.colorTextTertiary}
        preview={!expanded && text ? text.slice(-160) : undefined}
        streamingDot={streaming && !expanded}
      >
        <div style={{
          background: token.colorBgLayout, borderRadius: 8, padding: '10px 12px',
          maxHeight: 220, overflow: 'auto',
          fontSize: 12, lineHeight: '20px', color: token.colorTextSecondary,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {text}
        </div>
      </WfLine>
    )
  },
  (prev, next) => prev.event.text === next.event.text && prev.streaming === next.streaming,
)

/** LLM 正文段：对齐宿主 AnswerSegment（markdown 渲染 + 流式光标），长文限高展开 */
export const WfAnswerSegment = memo(
  function WfAnswerSegment({ event, streaming }: { event: PluginWorkflowNodeEvent; streaming: boolean }) {
    const { token } = theme.useToken()
    const [expanded, setExpanded] = useState(false)
    const text = event.text || ''
    const markdownNode = useMemo(
      () => (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node: _node, ref: _ref, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          }}
        >
          {text}
        </ReactMarkdown>
      ),
      [text],
    )
    return (
      <div style={{ marginBottom: 2 }}>
        <div style={{
          background: token.colorBgLayout, borderRadius: 8, padding: '10px 12px',
          maxHeight: expanded ? 560 : 220, overflow: 'auto',
        }}>
          <div style={{ fontSize: 12, lineHeight: 1.7, color: token.colorText, wordBreak: 'break-word' }} className="markdown-content">
            {markdownNode}
          </div>
          {streaming && <span style={{ color: token.colorTextQuaternary }}>▊</span>}
        </div>
        {text.length > 2000 && (
          <div
            onClick={() => setExpanded(v => !v)}
            style={{ textAlign: 'center', padding: '4px 0', cursor: 'pointer', color: token.colorPrimary, fontSize: 11, userSelect: 'none' }}
          >
            {expanded ? t('run.collapseText') : t('run.expandText')}
          </div>
        )}
      </div>
    )
  },
  (prev, next) => prev.event.text === next.event.text && prev.streaming === next.streaming,
)

/** 工具调用卡片段：竖线点分类图标 + 工具显示名 + 流式入参预览 + 状态点（对齐宿主 ToolCallSegment） */
export const WfToolSegment = memo(
  function WfToolSegment({
    event,
    toolLabel,
    toolIcon,
  }: {
    event: PluginWorkflowNodeEvent
    toolLabel: string
    toolIcon: React.ReactNode
  }) {
    const { token } = theme.useToken()
    const [expanded, setExpanded] = useState(false)
    const [resultExpanded, setResultExpanded] = useState(false)
    const running = event.status === 'running'
    const failed = event.status === 'failed'
    const argsStr = event.input || ''
    const resultStr = event.output || ''
    const preview = running
      ? argsStr.slice(-160).replace(/\s+/g, ' ')
      : (failed ? resultStr.slice(-160).replace(/\s+/g, ' ') : undefined)

    return (
      <div style={{ marginBottom: 2 }}>
        <div
          onClick={() => setExpanded(v => !v)}
          style={{
            padding: '5px 0', cursor: 'pointer', userSelect: 'none',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {expanded
            ? <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
            : <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />}
          <span style={{ display: 'inline-flex', flexShrink: 0, fontSize: 12, color: failed ? token.colorError : token.colorTextTertiary }}>
            {toolIcon}
          </span>
          <Text ellipsis style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0, maxWidth: 220 }}>
            {toolLabel}
          </Text>
          {!expanded && preview != null && preview !== '' && (
            <WfPreviewLine text={preview} fontSize={11} lineHeight={16} color={token.colorTextQuaternary} />
          )}
          {running && (
            <span style={{ marginInlineStart: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorTextTertiary }}>
              <LoadingOutlined spin />
              {t('run.toolRunning')}
            </span>
          )}
          {failed && !running && (
            <Tooltip title={event.error || resultStr} placement="topRight">
              <span style={{ marginInlineStart: 'auto', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: token.colorError }}>
                <CloseCircleOutlined />
              </span>
            </Tooltip>
          )}
        </div>
        {expanded && (
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
            <div style={{ position: 'relative', padding: '0 10px 8px 24px' }}>
              {argsStr && (
                <div style={{ marginBottom: resultStr ? 10 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>{t('run.event.toolInput')}</Text>
                    <CopyIcon text={argsStr} />
                  </div>
                  <WfPre text={argsStr} expanded={false} maxHeight={150} />
                </div>
              )}
              {(resultStr || (!running && !failed)) && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>{t('run.event.toolOutput')}</Text>
                    {resultStr && <CopyIcon text={resultStr} />}
                  </div>
                  {resultStr
                    ? <WfPre text={resultStr} expanded={resultExpanded} maxHeight={220} />
                    : (
                      <div style={{ background: token.colorBgLayout, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 6, padding: '8px 10px', fontSize: 12, color: token.colorTextQuaternary }}>
                        {t('run.toolNoOutput')}
                      </div>
                    )}
                  {resultStr.length > 500 && (
                    <div
                      onClick={(e) => { e.stopPropagation(); setResultExpanded(v => !v) }}
                      style={{ textAlign: 'center', padding: '4px 0', cursor: 'pointer', color: token.colorPrimary, fontSize: 11, userSelect: 'none' }}
                    >
                      {resultExpanded ? t('run.collapseText') : t('run.expandText')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.event.input === next.event.input &&
    prev.event.output === next.event.output &&
    prev.event.status === next.event.status &&
    prev.event.error === next.event.error &&
    prev.toolLabel === next.toolLabel,
)

/** 错误事件段（对齐宿主失败态：红图标 + 错误文本） */
export const WfErrorSegment: React.FC<{ event: PluginWorkflowNodeEvent }> = ({ event }) => {
  const { token } = theme.useToken()
  const text = event.text || event.error || ''
  return (
    <div
      style={{
        marginBottom: 8, padding: '8px 10px', borderRadius: 6,
        background: token.colorErrorBg, border: `1px solid ${token.colorErrorBorder}`,
        fontSize: 12, lineHeight: 1.6, color: token.colorError,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}
    >
      {text}
    </div>
  )
}

/** 折叠分区通用骨架：运行入参 / 运行结果 / 产出文件 / 智能体轮次共用 */
export interface WfSectionProps {
  title: React.ReactNode
  /** 收起态单行预览（不带则不显示） */
  preview?: string
  /** 标题右侧附加内容（计数 / 操作按钮等），点击不会触发展开 */
  extra?: React.ReactNode
  defaultExpanded?: boolean
  children?: React.ReactNode
}

export const WfSection: React.FC<WfSectionProps> = memo(
  function WfSection({ title, preview, extra, defaultExpanded, children }) {
    const { token } = theme.useToken()
    const [expanded, setExpanded] = useState(defaultExpanded)
    return (
      <div>
        <div
          onClick={() => setExpanded(v => !v)}
          style={{
            padding: '5px 0', cursor: 'pointer', userSelect: 'none',
            display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {expanded
            ? <DownOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />
            : <RightOutlined style={{ fontSize: 10, color: token.colorTextQuaternary }} />}
          <Text type="secondary" style={{ fontSize: 12, flexShrink: 0, color: token.colorTextSecondary, maxWidth: 260 }}>{title}</Text>
          {!expanded && preview != null && preview !== '' && (
            <WfPreviewLine text={preview} fontSize={11} lineHeight={16} color={token.colorTextQuaternary} />
          )}
          <div onClick={e => e.stopPropagation()} style={{ marginInlineStart: 'auto', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{extra}</div>
        </div>
        {expanded && (
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 4, top: 0, bottom: 0, width: 2, background: token.colorBorder, borderRadius: 1 }} />
            <div style={{ position: 'relative', padding: '0 10px 10px 24px' }}>{children}</div>
          </div>
        )}
      </div>
    )
  },
)

/** Token 用量行（对齐宿主 TokenUsageDisplay 文案结构） */
export const WfTokenUsage: React.FC<{ usage?: PluginWorkflowTokenUsage }> = ({ usage }) => {
  const { token } = theme.useToken()
  const fmt = (v?: number) => (v ? v.toLocaleString('en-US') : '')
  if (!usage?.totalTokens) return null
  return (
    <Text style={{ fontSize: 11, color: token.colorTextQuaternary, fontVariantNumeric: 'tabular-nums' }}>
      {usage.promptTokens !== undefined && <>↑{fmt(usage.promptTokens)} </>}
      {usage.completionTokens !== undefined && <>↓{fmt(usage.completionTokens)}</>}
      {usage.promptTokens !== undefined || usage.completionTokens !== undefined
        ? <> · </>
        : null}
      {t('run.tokenTotal')}: {fmt(usage.totalTokens)}
      {usage.cachedTokens != null && usage.cachedTokens > 0 && (
        <> ({t('run.tokenCached')}: {fmt(usage.cachedTokens)})</>
      )}
    </Text>
  )
}

/** 轮次分隔线（循环回流第 N 轮） */
export function WfRoundDivider({ round }: { round: number }) {
  const { token } = theme.useToken()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 8px' }}>
      <div style={{ flex: 1, height: 1, background: token.colorBorderSecondary }} />
      <Text type="secondary" style={{ fontSize: 11 }}>{t('template.round', { n: round })}</Text>
      <div style={{ flex: 1, height: 1, background: token.colorBorderSecondary }} />
    </div>
  )
}

