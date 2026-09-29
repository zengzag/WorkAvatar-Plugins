/** 画布节点渲染：类型徽标 + 名称 + 角色摘要 + 运行态 */
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Tag, Typography, theme } from 'antd'
import { t } from './host'
import { NODE_COLORS } from './node-catalog'

export interface FlowNodePayload {
  label: string
  nodeType: string
  summary?: string
  status?: 'pending' | 'running' | 'completed' | 'failed'
  verdict?: string
  round?: number
}

/** 运行态色（仅运行视图使用） */
const STATUS_COLOR: Record<string, string> = {
  running: '#1677ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
}

export function WorkflowNodeView({ data, selected }: NodeProps) {
  const { token } = theme.useToken()
  const payload = data as unknown as FlowNodePayload
  const accent = NODE_COLORS[payload.nodeType] || token.colorPrimary
  const statusColor = payload.status ? STATUS_COLOR[payload.status] : undefined
  const borderColor = selected ? token.colorPrimary : (statusColor || token.colorBorderSecondary)

  return (
    <div
      style={{
        minWidth: 168,
        maxWidth: 240,
        padding: '8px 12px',
        borderRadius: 8,
        background: token.colorBgContainer,
        border: `1.5px solid ${borderColor}`,
        boxShadow: selected ? token.boxShadowSecondary : token.boxShadowTertiary,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: token.colorBorder }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, background: accent, flex: 'none' }} />
        <Tag
          style={{ margin: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px', borderColor: accent, color: accent, background: 'transparent' }}
        >
          {t(`node.${payload.nodeType}`)}
        </Tag>
        {payload.round ? (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {t('template.round', { n: payload.round })}
          </Typography.Text>
        ) : null}
      </div>
      <Typography.Text strong ellipsis style={{ display: 'block', fontSize: 13 }}>
        {payload.label}
      </Typography.Text>
      {payload.summary ? (
        <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 11 }}>
          {payload.summary}
        </Typography.Text>
      ) : null}
      {payload.verdict ? (
        <Typography.Text
          style={{ fontSize: 11, color: payload.verdict === 'pass' ? token.colorSuccess : token.colorError }}
        >
          {t(`verdict.${payload.verdict}`) || payload.verdict}
        </Typography.Text>
      ) : null}
      <Handle type="source" position={Position.Right} style={{ background: token.colorBorder }} />
    </div>
  )
}
