/** 画布节点：类型图标 + 名称 + 执行者/类型摘要 */
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Typography, theme } from 'antd'
import {
  ApartmentOutlined,
  BranchesOutlined,
  DownloadOutlined,
  FlagOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import { t } from './host'
import { NODE_COLORS } from './node-catalog'

export interface FlowNodePayload {
  label: string
  nodeType: string
  summary?: string
}

function typeIcon(type: string): ReactNode {
  const style = { fontSize: 14 }
  switch (type) {
    case 'input': return <DownloadOutlined style={style} />
    case 'agent': return <RobotOutlined style={style} />
    case 'review': return <SafetyCertificateOutlined style={style} />
    case 'condition': return <BranchesOutlined style={style} />
    case 'loop': return <SyncOutlined style={style} />
    case 'parallel': return <ApartmentOutlined style={style} />
    case 'human': return <UserOutlined style={style} />
    case 'tool': return <ToolOutlined style={style} />
    case 'end': return <FlagOutlined style={style} />
    default: return <RobotOutlined style={style} />
  }
}

export function WorkflowNodeView({ data, selected }: NodeProps) {
  const { token } = theme.useToken()
  const payload = data as unknown as FlowNodePayload
  const accent = NODE_COLORS[payload.nodeType] || token.colorPrimary

  return (
    <div
      style={{
        width: 168,
        height: 62,
        padding: '0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        background: token.colorBgContainer,
        border: `1px solid ${selected ? token.colorPrimary : token.colorBorderSecondary}`,
        boxShadow: selected ? `0 0 0 3px ${token.colorPrimaryBg}, ${token.boxShadowSecondary}` : token.boxShadowTertiary,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: token.colorBorder, width: 7, height: 7 }} />
      <span
        style={{
          width: 31, height: 31, borderRadius: 9, flex: 'none',
          display: 'grid', placeItems: 'center',
          color: accent, background: `${accent}16`,
        }}
      >
        {typeIcon(payload.nodeType)}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Typography.Text strong ellipsis style={{ display: 'block', fontSize: 12.5, lineHeight: 1.35 }}>
          {payload.label}
        </Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 10.5, marginTop: 2 }}>
          {payload.summary || t(`node.${payload.nodeType}`)}
        </Typography.Text>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: token.colorBorder, width: 7, height: 7 }} />
    </div>
  )
}
