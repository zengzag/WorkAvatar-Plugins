/**
 * 办公室实况：把有执行者的节点映射为工位上的数字员工。
 * 运行中敲键盘、完成后交接、全部完成一起庆祝；点击工位查看该员工的输出。
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Tooltip, theme } from 'antd'
import { CheckOutlined, CloseOutlined, MinusOutlined } from '@ant-design/icons'
import type { PluginWorkflowNodeRun, PluginWorkflowNodeStatus, PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { t } from './host'
import { resolveToolTitle, useToolCatalog } from './tool-catalog'
import { employeeHue, formatDuration, isDarkColor } from './utils'
import './office.css'

type RobotStyle = 'headset' | 'glasses' | 'beret' | 'headphones' | 'monocle'

const EXECUTOR_STYLES: RobotStyle[] = ['headset', 'glasses', 'beret', 'headphones']

function floorTexture(dark: boolean): string {
  const seam = dark ? '%23ffffff' : '%23a8783f'
  const seamOpacity = dark ? '.045' : '.07'
  const grainOpacity = dark ? '.03' : '.07'
  const fill = dark ? '%23ffffff' : '%23b07f47'
  const fillOpacity = dark ? '.02' : '.035'
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='96'>` +
    `<g fill='${fill}' fill-opacity='${fillOpacity}'><rect x='0' y='0' width='96' height='48'/><rect x='96' y='48' width='144' height='48'/></g>` +
    `<g stroke='${seam}' stroke-opacity='${seamOpacity}' fill='none'><path d='M0 48h240M0 96h240M96 0v48M0 48v48M168 48v48'/></g>` +
    `<g stroke='${seam}' stroke-opacity='${grainOpacity}' fill='none'><path d='M12 12q60 -5 120 0t96 0M8 30q52 -4 104 0t120 0M20 60q44 -4 88 0t120 0M10 80q60 -5 120 0t100 0'/></g>` +
    `</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/%2523/g, '%23')}")`
}

/** 头部小配件：让每位员工有一眼可辨的角色特征 */
function HeadAccessory({ style, soft, deep, accent, uid }: {
  style: RobotStyle
  soft: string
  deep: string
  accent: string
  uid: string
}) {
  if (style === 'headset') {
    return (
      <g>
        <path d="M14 14C16 3.5 48 3.5 50 14" fill="none" stroke={deep} strokeWidth="2.4" strokeLinecap="round" />
        <rect x="7.6" y="13.8" width="5.6" height="10.8" rx="2.8" fill={deep} />
        <rect x="50.8" y="13.8" width="5.6" height="10.8" rx="2.8" fill={deep} />
        <path d="M10.4 23.8c-2 5 .2 7.4 4.4 7.8" fill="none" stroke="#8f9bad" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="15.2" cy="31.4" r="1.7" fill={accent} />
      </g>
    )
  }
  if (style === 'headphones') {
    return (
      <g>
        <path d="M12.5 15C13.5 2.5 50.5 2.5 51.5 15" fill="none" stroke={deep} strokeWidth="3.4" strokeLinecap="round" />
        <rect x="5" y="13" width="8.6" height="13.6" rx="4.3" fill={`url(#wfo-metal-${uid})`} stroke={deep} strokeWidth="1.6" />
        <rect x="50.4" y="13" width="8.6" height="13.6" rx="4.3" fill={`url(#wfo-metal-${uid})`} stroke={deep} strokeWidth="1.6" />
        <rect x="7.2" y="16.4" width="4.2" height="6.8" rx="2.1" fill={accent} />
        <rect x="52.6" y="16.4" width="4.2" height="6.8" rx="2.1" fill={accent} />
      </g>
    )
  }
  if (style === 'glasses') {
    return (
      <g fill="none" stroke="rgba(255,255,255,.82)" strokeWidth="1.3">
        <rect x="21.6" y="16.4" width="9.6" height="8" rx="3.6" />
        <rect x="33.1" y="16.4" width="9.6" height="8" rx="3.6" />
        <path d="M31.2 19.4h1.9M21.6 18.8l-3-1.4M42.7 18.8l3-1.4" />
        <path d="M23.2 18.2h3.2" stroke="rgba(255,255,255,.5)" />
      </g>
    )
  }
  if (style === 'beret') {
    return (
      <g>
        <ellipse cx="27" cy="6.2" rx="15.2" ry="5.6" fill={deep} transform="rotate(-7 27 6.2)" />
        <ellipse cx="26.4" cy="4.9" rx="13.4" ry="4.4" fill={accent} transform="rotate(-7 26.4 4.9)" />
        <circle cx="27" cy="1.2" r="1.9" fill={soft} />
        <path d="M37 8.2c2.4.2 4.6.9 6.4 2" fill="none" stroke={soft} strokeWidth="1.2" strokeLinecap="round" opacity=".7" />
      </g>
    )
  }
  return (
    <g>
      <circle cx="38.6" cy="20.4" r="5.4" fill="rgba(255,255,255,.06)" stroke={soft} strokeWidth="1.4" />
      <path d="M42 24.6c1.8 2.4 2.8 5 3 7.8" fill="none" stroke="rgba(255,255,255,.4)" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M35.8 17.4c.9-.7 2.1-.9 3.2-.5" fill="none" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
    </g>
  )
}

function Eyes({ status, hue }: { status: PluginWorkflowNodeStatus; hue: number }) {
  const soft = `hsl(${hue} 88% 74%)`
  if (status === 'failed') {
    return (
      <g stroke="#ff7a7a" strokeWidth="1.8" strokeLinecap="round">
        <path d="M23.6 18.2l5.2 5.2M28.8 18.2l-5.2 5.2" />
        <path d="M35.6 18.2l5.2 5.2M40.8 18.2l-5.2 5.2" />
      </g>
    )
  }
  if (status === 'pending' || status === 'skipped') {
    return (
      <g stroke={soft} strokeWidth="1.6" strokeLinecap="round" opacity=".7">
        <path d="M23.8 20.6h5.4" />
        <path d="M35.8 20.6h5.4" />
      </g>
    )
  }
  if (status === 'completed') {
    return (
      <g stroke={soft} strokeWidth="1.9" fill="none" strokeLinecap="round">
        <path d="M23.5 21.6q3-3.8 6 0" />
        <path d="M35.5 21.6q3-3.8 6 0" />
      </g>
    )
  }
  return (
    <g fill={soft}>
      <circle cx="26.4" cy="20.4" r="2.35" />
      <circle cx="38.6" cy="20.4" r="2.35" />
    </g>
  )
}

function Mouth({ status }: { status: PluginWorkflowNodeStatus }) {
  if (status === 'failed') {
    return <path d="M29.4 26.6q2.6-2 5.2 0" stroke="#ff9a9a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  }
  if (status === 'pending' || status === 'skipped') return null
  if (status === 'completed') {
    return <path d="M29 25.2q3 3.2 6 0" stroke="rgba(255,255,255,.8)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  }
  return <path d="M30 25.6q2 1.8 4 0" stroke="rgba(255,255,255,.72)" strokeWidth="1.3" fill="none" strokeLinecap="round" />
}

function Robot({ hue, status, style }: {
  hue: number
  status: PluginWorkflowNodeStatus
  style: RobotStyle
}) {
  const uid = useId().replace(/:/g, '')
  const accent = `hsl(${hue} 72% 58%)`
  const soft = `hsl(${hue} 88% 74%)`
  const deep = `hsl(${hue} 58% 42%)`
  const sleeping = status === 'pending' || status === 'skipped'

  return (
    <svg className="wfo-robot" viewBox="0 0 64 92" aria-hidden>
      <defs>
        <linearGradient id={`wfo-shell-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" /><stop offset="55%" stopColor="#e8eef7" /><stop offset="100%" stopColor="#c3cfdd" />
        </linearGradient>
        <linearGradient id={`wfo-head-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" /><stop offset="70%" stopColor="#dfe8f3" /><stop offset="100%" stopColor="#b8c6d6" />
        </linearGradient>
        <radialGradient id={`wfo-visor-${uid}`} cx="40%" cy="22%" r="92%">
          <stop offset="0%" stopColor="#2b3548" /><stop offset="100%" stopColor="#0b1018" />
        </radialGradient>
        <linearGradient id={`wfo-accent-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={soft} /><stop offset="100%" stopColor={deep} />
        </linearGradient>
        <linearGradient id={`wfo-metal-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f4f7fb" /><stop offset="100%" stopColor="#aab7c9" />
        </linearGradient>
      </defs>
      <ellipse cx="32" cy="89.5" rx="15" ry="2.6" fill="rgba(15,28,48,.18)" />
      <g className="wfo-leg-a">
        <rect x="23" y="60" width="7.2" height="21" rx="3.6" fill="#b6c2d2" />
        <rect x="21.6" y="76.6" width="9.8" height="5.4" rx="2.7" fill={deep} />
      </g>
      <g className="wfo-leg-b">
        <rect x="33.8" y="60" width="7.2" height="21" rx="3.6" fill="#9fabbd" />
        <rect x="32.6" y="76.6" width="9.8" height="5.4" rx="2.7" fill={deep} />
      </g>
      <rect x="14.5" y="36" width="35" height="27" rx="11" fill={`url(#wfo-shell-${uid})`} stroke="rgba(15,28,48,.16)" />
      <rect x="20.6" y="43.4" width="22.8" height="13.2" rx="4.8" fill={`url(#wfo-accent-${uid})`} opacity=".95" />
      <rect x="23" y="46.4" width="18" height="2" rx="1" fill="rgba(255,255,255,.72)" />
      <rect x="23" y="50.2" width="12.5" height="2" rx="1" fill="rgba(255,255,255,.5)" />
      <circle className="wfo-lamp" cx="44.4" cy="56.6" r="1.5" fill={soft} />
      {style === 'monocle' && (
        <g>
          <path d="M35.4 44.8l5.6 2v4.4c0 2.8-2.4 4.7-5.6 5.8-3.2-1.1-5.6-3-5.6-5.8v-4.4z" fill="rgba(255,255,255,.86)" />
          <path d="m32.9 48.7 1.9 1.9 3.4-3.5" fill="none" stroke={deep} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
      <g className="wfo-arm-a">
        <rect x="6.4" y="38.4" width="8.4" height="20" rx="4.2" fill={`url(#wfo-shell-${uid})`} stroke="rgba(15,28,48,.14)" />
        <rect x="6.4" y="54.8" width="8.4" height="5.6" rx="2.8" fill={accent} />
      </g>
      <g className="wfo-arm-b">
        <rect x="49.2" y="38.4" width="8.4" height="20" rx="4.2" fill={`url(#wfo-shell-${uid})`} stroke="rgba(15,28,48,.14)" />
        <rect x="49.2" y="54.8" width="8.4" height="5.6" rx="2.8" fill={accent} />
      </g>
      <rect x="27.4" y="31" width="9.2" height="7" rx="3.2" fill="#aebbcb" />
      <g>
        <rect x="11.5" y="6" width="41" height="28" rx="12" fill={`url(#wfo-head-${uid})`} stroke="rgba(15,28,48,.16)" />
        <path d="M17 8.5C21 6.8 36 6 45 8.2" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity=".6" />
        <rect x="17" y="11.6" width="30" height="17.6" rx="8" fill={`url(#wfo-visor-${uid})`} />
        <ellipse cx="24" cy="15.2" rx="7" ry="3" fill="#ffffff" opacity=".1" />
        <rect x="8.7" y="15.8" width="3.6" height="7.2" rx="1.8" fill="#a9b6c7" />
        <rect x="51.7" y="15.8" width="3.6" height="7.2" rx="1.8" fill="#a9b6c7" />
        <HeadAccessory style={style} soft={soft} deep={deep} accent={accent} uid={uid} />
        <rect x="30.6" y="1.3" width="2.8" height="6" rx="1.4" fill="#97a4b6" />
        <circle className="wfo-lamp" cx="32" cy="1.8" r="3" fill={soft} />
        <g className="wfo-eyes"><Eyes status={status} hue={hue} /></g>
        <Mouth status={status} />
      </g>
      {sleeping && (
        <g className="wfo-zzz" fill={soft}>
          <text x="49" y="11" fontSize="9" fontWeight="700">z</text>
          <text x="57" y="4" fontSize="6.5" fontWeight="700">z</text>
        </g>
      )}
      {status === 'completed' && (
        <g className="wfo-sparkle" fill={soft}>
          <path d="M55 9l1.2 2.8L59 13l-2.8 1.2L55 17l-1.2-2.8L51 13l2.8-1.2z" />
          <circle cx="8.5" cy="17" r="1.2" />
        </g>
      )}
    </svg>
  )
}

function activityText(node: PluginWorkflowNodeRun): string {
  if (node.status === 'failed') return t('office.problem')
  if (node.status === 'completed') return t('status.completed')
  const events = node.events || []
  const last = events[events.length - 1]
  if (last?.type === 'tool') {
    const title = resolveToolTitle(last.name || '')
    return last.status === 'running'
      ? t('office.usingTool', { name: title })
      : t('office.afterTool', { name: title })
  }
  if (last?.type === 'thinking') return t('office.thinking')
  if (last?.type === 'text') return t('office.writing')
  if (last?.type === 'prompt') return t('office.readingTask')
  if (last?.type === 'error') return t('office.problem')
  return t('office.warmingUp')
}

function ScreenContent({ status }: { status: PluginWorkflowNodeStatus }) {
  if (status === 'completed') return <span className="wfo-screen-mark ok"><CheckOutlined /></span>
  if (status === 'failed') return <span className="wfo-screen-mark bad"><CloseOutlined /></span>
  if (status === 'skipped') return <span className="wfo-screen-mark off"><MinusOutlined /></span>
  return (
    <span className="wfo-screen-code" data-idle={status !== 'running' ? 'true' : undefined}>
      <i style={{ width: '54%' }} />
      <i style={{ width: '78%' }} />
      <i style={{ width: '38%' }} />
    </span>
  )
}

/** 工位：员工数据来自节点执行者；点击打开该员工的输出 */
function Station({ node, hue, robotStyle, index, hidden, receiving, onSelect, registerRef }: {
  node: PluginWorkflowNodeRun
  hue: number
  robotStyle: RobotStyle
  index: number
  hidden: boolean
  receiving: boolean
  onSelect?: (nodeId: string) => void
  registerRef: (nodeId: string, el: HTMLDivElement | null) => void
}) {
  const status = node.status
  const duration = node.startedAt ? formatDuration(node.startedAt, node.endedAt) : null
  const bubble = receiving
    ? t('office.receiving')
    : status === 'running'
      ? activityText(node)
      : status === 'failed'
        ? t('office.problem')
        : null

  const tooltip = (
    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 600 }}>{node.label}</div>
      {node.executor ? <div>{t('office.executor')}：{node.executor}</div> : null}
      <div>{t('office.statusLabel')}：{t(`status.${status}`)}</div>
      {status === 'running' ? <div>{activityText(node)}</div> : null}
      {node.round ? <div>{t('template.round', { n: node.round })}</div> : null}
      {duration ? <div>{t('run.duration')}：{duration}</div> : null}
      {node.tokenUsage?.totalTokens ? <div>{t('run.tokens')}：{node.tokenUsage.totalTokens.toLocaleString()}</div> : null}
      <div style={{ opacity: 0.7 }}>{t('office.clickHint')}</div>
    </div>
  )

  return (
    <div
      ref={(el) => registerRef(node.nodeId, el)}
      className="wfo-station"
      data-status={status}
      data-away={hidden ? 'true' : undefined}
      data-receiving={receiving ? 'true' : undefined}
      tabIndex={0}
      role="button"
      aria-label={node.executor || node.label}
      style={{
        '--wfo-hue': `hsl(${hue} 72% 58%)`,
        '--wfo-hue-soft': `hsla(${hue}, 85%, 62%, .38)`,
        '--wfo-hue-glow': `hsla(${hue}, 72%, 58%, .45)`,
        '--i': index,
      } as CSSProperties}
      onClick={() => onSelect?.(node.nodeId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.(node.nodeId)
        }
      }}
    >
      <span className="wfo-spot" />
      {bubble ? <div className="wfo-bubble">{bubble}</div> : null}
      <span className="wfo-peek">{t('office.peek')}</span>
      <Tooltip title={tooltip} mouseEnterDelay={0.3}>
        <div className="wfo-person">
          <Robot hue={hue} status={status} style={robotStyle} />
        </div>
      </Tooltip>
      <div className="wfo-monitor">
        <div className="wfo-monitor-screen">
          <ScreenContent status={status} />
        </div>
        <div className="wfo-monitor-neck" />
        <div className="wfo-monitor-base" />
      </div>
      <div className="wfo-desk">
        <div className="wfo-desk-top" />
        <div className="wfo-desk-front" />
        <div className="wfo-props">
          <span className="wfo-prop wfo-mug"><i className="wfo-steam s1" /><i className="wfo-steam s2" /></span>
          <span className="wfo-prop wfo-papers" />
          <span className="wfo-prop wfo-keyboard" />
        </div>
      </div>
      <div className="wfo-plate">
        <span className="wfo-dot" />
        {node.executor || node.label}
        {status === 'running' ? ` · ${t('status.running')}` : ''}
      </div>
    </div>
  )
}

interface Handoff {
  fromId: string
  toId: string
  name: string
  hue: number
  style: RobotStyle
  x: number
  y: number
  phase: 'walk' | 'deliver' | 'return'
  face: 'left' | 'right'
}

export function OfficeScene({ run, onSelectNode }: {
  run: PluginWorkflowRun
  onSelectNode?: (nodeId: string) => void
}) {
  const { token } = theme.useToken()
  useToolCatalog()
  const sceneRef = useRef<HTMLDivElement>(null)
  const floorRef = useRef<HTMLDivElement>(null)
  const stationRefs = useRef(new Map<string, HTMLDivElement>())
  const prevStatusRef = useRef(new Map<string, PluginWorkflowNodeStatus>())
  const seenRunRef = useRef<string | null>(null)
  const timersRef = useRef<number[]>([])
  const prevRunStatusRef = useRef(run.status)
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [celebrate, setCelebrate] = useState(false)

  /** 办公室只编排有执行者的节点（input / condition / loop / end 等流程骨架不占工位） */
  const nodes = useMemo(() => run.nodes.filter((node) => !!node.executor), [run.nodes])

  /** 同一执行者固定一种形象；评审角色优先戴单片镜 */
  const visualByExecutor = useMemo(() => {
    const map = new Map<string, { hue: number; style: RobotStyle }>()
    let styleIndex = 0
    for (const node of nodes) {
      const name = node.executor || node.label
      if (map.has(name)) continue
      const hue = employeeHue(name)
      const style: RobotStyle = node.type === 'review' ? 'monocle' : EXECUTOR_STYLES[styleIndex % EXECUTOR_STYLES.length]
      styleIndex += 1
      map.set(name, { hue, style })
    }
    return map
  }, [nodes])

  const done = nodes.filter((node) => node.status === 'completed').length
  const dark = isDarkColor(token.colorBgContainer)
  const floorTex = useMemo(() => floorTexture(dark), [dark])

  const clearTimers = () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
    timersRef.current = []
  }

  useEffect(() => clearTimers, [])

  /** 员工完成 → 下一位开工时，走过去交接数据 */
  useEffect(() => {
    if (nodes.length === 0) return
    if (seenRunRef.current !== run.runId) {
      seenRunRef.current = run.runId
      prevStatusRef.current = new Map(nodes.map((node) => [node.nodeId, node.status]))
      return
    }
    const started = nodes.findIndex(
      (node) => node.status === 'running' && prevStatusRef.current.get(node.nodeId) !== 'running',
    )
    prevStatusRef.current = new Map(nodes.map((node) => [node.nodeId, node.status]))
    if (started <= 0) return

    const fromNode = nodes[started - 1]
    const toNode = nodes[started]
    if (fromNode.status !== 'completed') return

    const floor = floorRef.current
    const fromEl = stationRefs.current.get(fromNode.nodeId)
    const toEl = stationRefs.current.get(toNode.nodeId)
    if (!floor || !fromEl || !toEl) return

    const base = floor.getBoundingClientRect()
    const fromRect = fromEl.getBoundingClientRect()
    const toRect = toEl.getBoundingClientRect()
    const from = { x: fromRect.left - base.left + fromRect.width * 0.33, y: fromRect.bottom - base.top - 10 }
    const to = {
      x: toRect.left - base.left + toRect.width * 0.33 - (toRect.width < 170 ? 62 : 80),
      y: toRect.bottom - base.top - 10,
    }
    const visual = visualByExecutor.get(fromNode.executor || fromNode.label)

    clearTimers()
    setHandoff({
      fromId: fromNode.nodeId,
      toId: toNode.nodeId,
      name: fromNode.executor || fromNode.label,
      hue: visual?.hue ?? employeeHue(fromNode.executor || fromNode.label),
      style: visual?.style ?? 'headset',
      x: from.x,
      y: from.y,
      phase: 'walk',
      face: to.x >= from.x ? 'right' : 'left',
    })
    // 下一帧再移动到目标位，确保起始位置先上屏、过渡动画生效
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setHandoff((current) => current ? { ...current, x: to.x, y: to.y } : current)
    }))
    timersRef.current.push(window.setTimeout(() => {
      setHandoff((current) => current ? { ...current, phase: 'deliver' } : current)
    }, 1040))
    timersRef.current.push(window.setTimeout(() => {
      setHandoff((current) => current ? {
        ...current,
        phase: 'return',
        x: from.x,
        y: from.y,
        face: to.x >= from.x ? 'left' : 'right',
      } : current)
    }, 1580))
    timersRef.current.push(window.setTimeout(() => setHandoff(null), 2700))
  }, [nodes, run.runId, visualByExecutor])

  /** 全流程完成：撒彩带 + 气球，所有人起身庆祝一小会儿 */
  useEffect(() => {
    const prev = prevRunStatusRef.current
    prevRunStatusRef.current = run.status
    if (prev === run.status || run.status !== 'completed') return
    setCelebrate(true)
    const timer = window.setTimeout(() => setCelebrate(false), 4300)
    return () => window.clearTimeout(timer)
  }, [run.status])

  if (nodes.length === 0) return null

  const purple = dark ? '#a371f7' : '#8250df'
  const purpleSoft = dark ? '#241c3a' : '#f3edff'
  const palette = {
    '--wfo-wall-1': dark ? '#232830' : '#eef3f9',
    '--wfo-wall-2': dark ? '#1b1f26' : '#e4ebf4',
    '--wfo-floor': dark ? '#2b2520' : '#e9d3b3',
    '--wfo-floor-line': dark ? 'rgba(255,255,255,.05)' : 'rgba(150,112,58,.12)',
    '--wfo-floor-tex': floorTex,
    '--wfo-desk': dark ? '#4a3d31' : '#d7a875',
    '--wfo-desk-edge': dark ? '#332a22' : '#b0834f',
    '--wfo-desk-front': dark ? '#3c3229' : '#c79663',
    '--wfo-screen': dark ? '#0a0e15' : '#0f1622',
    '--wfo-screen-frame': dark ? '#2a3038' : '#37455a',
    '--wfo-panel': token.colorBgContainer,
    '--wfo-line': token.colorBorderSecondary,
    '--wfo-border-strong': token.colorBorder,
    '--wfo-text': token.colorText,
    '--wfo-sub': token.colorTextSecondary,
    '--wfo-tertiary': token.colorTextTertiary,
    '--wfo-success': token.colorSuccess,
    '--wfo-error': token.colorError,
    '--wfo-accent': token.colorPrimary,
    '--wfo-accent-soft': token.colorPrimaryBg,
    '--wfo-purple': purple,
    '--wfo-purple-soft': purpleSoft,
    '--wfo-soft': token.colorFillQuaternary,
    '--wfo-sky-1': dark ? '#1b2b45' : '#a8d2ff',
    '--wfo-sky-2': dark ? '#122033' : '#e3f1ff',
    '--wfo-sun': '#ffd76a',
    '--wfo-cloud': dark ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.82)',
    '--wfo-sunbeam': dark
      ? 'linear-gradient(102deg,rgba(150,200,255,.07),transparent 60%)'
      : 'linear-gradient(102deg,rgba(255,240,190,.24),rgba(255,240,190,.06) 46%,transparent 66%)',
    '--wfo-rug': dark
      ? 'radial-gradient(ellipse at 50% 45%,rgba(255,255,255,.05),rgba(255,255,255,.025) 60%,transparent 82%)'
      : 'radial-gradient(ellipse at 50% 45%,rgba(255,255,255,.3),rgba(255,255,255,.14) 60%,transparent 82%)',
    '--wfo-mote': dark ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.55)',
    '--wfo-glass': dark ? 'rgba(26,28,33,.72)' : 'rgba(255,255,255,.74)',
    '--wfo-glass-strong': dark ? 'rgba(26,28,33,.92)' : 'rgba(255,255,255,.9)',
    '--wfo-shadow': token.boxShadowTertiary,
    '--wfo-shadow-sm': token.boxShadowTertiary,
  } as CSSProperties

  const confetti = celebrate
    ? Array.from({ length: 26 }, (_, i) => ({
      left: `${4 + (i * 37) % 92}%`,
      delay: `${(i % 9) * 0.1}s`,
      color: `hsl(${(i * 47) % 360} 80% 62%)`,
      rotate: `${(i * 63) % 180}deg`,
    }))
    : []
  const balloons = celebrate
    ? ['#ff7a7a', '#ffd76a', '#7ad3ff', '#b39dff', '#7be2b0'].map((color, i) => ({
      left: `${8 + i * 18}%`,
      bottom: `${10 + (i % 2) * 14}%`,
      color,
      delay: `${0.12 + i * 0.14}s`,
    }))
    : []

  const now = new Date()
  const hourAngle = (now.getHours() % 12) * 30 + now.getMinutes() * 0.5
  const minuteAngle = now.getMinutes() * 6
  const secondAngle = now.getSeconds() * 6
  const current = nodes.find((node) => node.status === 'running')
  const subtitle = run.status === 'completed'
    ? t('office.allDone')
    : run.status === 'failed' || run.status === 'aborted'
      ? t(`status.${run.status}`)
      : current
        ? t('run.currentNode', { name: current.label })
        : t('office.warmingUp')

  return (
    <div className="wfo" ref={sceneRef} style={palette}>
      <div className="wfo-top">
        <span className="wfo-glass">
          <span className="wfo-live" data-on={run.status === 'running' ? 'true' : undefined} />
          <b>{t('office.title')}</b>
          <span>{subtitle}</span>
        </span>
        <div className="wfo-top-right">
          <span className="wfo-glass">{t('office.progress', { done, total: nodes.length })}</span>
        </div>
      </div>

      <div className="wfo-wall">
        <div className="wfo-pendant p1" />
        <div className="wfo-pendant p2" />
        <div className="wfo-window">
          <span className="wfo-sun" />
          <span className="wfo-cloud c1" />
          <span className="wfo-cloud c2" />
        </div>
        <div className="wfo-shelf">
          <span className="wfo-book" />
          <span className="wfo-book" />
          <span className="wfo-book" />
          <span className="wfo-shelf-frame" />
        </div>
        <div className="wfo-board">
          <div className="wfo-board-title">
            <span>{t('office.board')}</span>
            <b>{nodes.length ? Math.round((done / nodes.length) * 100) : 0}%</b>
          </div>
          <div className="wfo-board-bar">
            <i style={{ width: `${nodes.length ? Math.round((done / nodes.length) * 100) : 0}%` }} />
          </div>
          <div className="wfo-board-notes"><i className="n1" /><i className="n2" /><i className="n3" /></div>
        </div>
        <div className="wfo-poster">
          <span className="p-sun" />
          <span className="p-hill h1" />
          <span className="p-hill h2" />
          <span className="p-line" />
        </div>
        <div className="wfo-clock">
          <span className="wfo-clock-hand" style={{ transform: `rotate(${hourAngle}deg)` }} />
          <span className="wfo-clock-hand wfo-clock-minute" style={{ transform: `rotate(${minuteAngle}deg)` }} />
          <span className="wfo-clock-second" style={{ transform: `rotate(${secondAngle}deg)` }} />
          <span className="wfo-clock-dot" />
        </div>
        <svg className="wfo-plant" viewBox="0 0 44 46" aria-hidden>
          <path d="M22 40c-7-3-10-9-9-16 5 2 8 6 9 11" fill="#4f9a5c" />
          <path d="M22 40c7-3 10-9 9-16-5 2-8 6-9 11" fill="#3d8850" />
          <path d="M21 40c-2-7-1-13 2-19 3 6 4 12 1 19" fill="#61b06c" />
          <path d="M13 38h18l-2.4 7H15.4z" fill="#c8784f" />
          <path d="M12 36h20v3.4H12z" fill="#d98a5f" />
        </svg>
      </div>

      <div className="wfo-floor" ref={floorRef}>
        <span className="wfo-sunbeam" />
        <div className="wfo-rug" />
        <div className="wfo-floor-lamp">
          <span className="glow" /><span className="pole" /><span className="base" /><span className="shade" />
        </div>
        <svg className="wfo-floor-plant" viewBox="0 0 44 46" aria-hidden>
          <path d="M22 40c-7-3-10-9-9-16 5 2 8 6 9 11" fill="#4f9a5c" />
          <path d="M22 40c7-3 10-9 9-16-5 2-8 6-9 11" fill="#3d8850" />
          <path d="M21 40c-2-7-1-13 2-19 3 6 4 12 1 19" fill="#61b06c" />
          <path d="M13 38h18l-2.4 7H15.4z" fill="#c8784f" />
          <path d="M12 36h20v3.4H12z" fill="#d98a5f" />
        </svg>
        <span className="wfo-mote" style={{ left: '22%', bottom: '26%', animationDelay: '.4s' }} />
        <span className="wfo-mote" style={{ left: '38%', bottom: '58%', animationDelay: '2.2s' }} />
        <span className="wfo-mote" style={{ left: '64%', bottom: '36%', animationDelay: '4.1s' }} />
        <span className="wfo-mote" style={{ left: '78%', bottom: '62%', animationDelay: '1.3s' }} />

        <div className="wfo-stations" data-celebrate={celebrate ? 'true' : undefined}>
          {nodes.map((node, index) => {
            const visual = visualByExecutor.get(node.executor || node.label)
            return (
              <Station
                key={node.nodeId}
                node={node}
                index={index}
                hue={visual?.hue ?? employeeHue(node.executor || node.label)}
                robotStyle={visual?.style ?? 'headset'}
                hidden={handoff?.fromId === node.nodeId}
                receiving={handoff?.phase === 'deliver' && handoff.toId === node.nodeId}
                onSelect={onSelectNode}
                registerRef={(nodeId, el) => {
                  if (el) stationRefs.current.set(nodeId, el)
                  else stationRefs.current.delete(nodeId)
                }}
              />
            )
          })}
        </div>

        {handoff ? (
          <div
            className="wfo-courier"
            data-face={handoff.face}
            style={{ left: handoff.x, top: handoff.y }}
          >
            <div className="wfo-bubble">
              {handoff.phase === 'deliver' ? t('office.delivered') : handoff.name}
            </div>
            <div className="wfo-face">
              <Robot hue={handoff.hue} status="running" style={handoff.style} />
            </div>
            {handoff.phase !== 'return' ? <span className="wfo-parcel" /> : null}
          </div>
        ) : null}

        {celebrate ? (
          <div className="wfo-confetti-layer" aria-hidden>
            {confetti.map((item, i) => (
              <span
                key={`c${i}`}
                className="wfo-confetti"
                style={{ left: item.left, background: item.color, animationDelay: item.delay, rotate: item.rotate }}
              />
            ))}
            {balloons.map((item, i) => (
              <span
                key={`b${i}`}
                className="wfo-balloon"
                style={{ left: item.left, bottom: item.bottom, background: item.color, animationDelay: item.delay }}
              />
            ))}
          </div>
        ) : null}

        {run.status === 'completed' ? (
          <div className="wfo-banner">
            <CheckOutlined /> {t('office.allDone')}
          </div>
        ) : null}
        {run.status === 'failed' || run.status === 'aborted' ? (
          <div className="wfo-banner error">
            <CloseOutlined /> {t(`status.${run.status}`)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
