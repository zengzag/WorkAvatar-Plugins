/**
 * 画布编辑器：左侧节点库 + 中间画布 + 右侧属性面板。
 *
 * 状态约定（对齐 data-model 插件的可用实现）：
 * - 画布节点/连线由 ReactFlow 的 useNodesState/useEdgesState 持有（含 measured 等内部字段），
 *   **不可**每轮从业务模型重建，否则会丢掉 measured，导致点击/拖拽等交互失效。
 * - 业务模型 draft.graph 为唯一事实来源；结构变化时用 effect 单向同步进 useNodesState。
 * - onNodesChange 交给 useNodesState 处理（拖拽即写回 position），再落回 draft.graph。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button, Card, Input, Popover, Space, Tooltip, Typography, message, theme } from 'antd'
import { ArrowLeftOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons'
import { invoke, t } from './host'
import type { WorkflowNode, WorkflowTemplate, WorkflowVariable } from '../shared/types'
import { NODE_CATALOG } from './node-catalog'
import {
  addEdgeToGraph,
  addNodeToGraph,
  applyPositions,
  deleteEdgeFromGraph,
  deleteNodeFromGraph,
} from './graph-ops'
import { WorkflowNodeView } from './WorkflowNode'
import { NodeInspector } from './NodeInspector'
import { EdgeInspector } from './EdgeInspector'

const nodeTypes = { workflowNode: WorkflowNodeView }

interface Props {
  template: WorkflowTemplate
  onBack: () => void
  onSaved: (template: WorkflowTemplate) => void
}

/** 业务节点 → ReactFlow 视图节点（仅在结构变化时调用，不作为每次 change 的重建源） */
function toViewNodes(template: WorkflowTemplate): Node[] {
  return template.graph.nodes.map(n => ({
    id: n.id,
    type: 'workflowNode',
    position: { ...n.position },
    data: { label: n.data?.label || n.id, nodeType: n.type },
  }))
}

function toViewEdges(template: WorkflowTemplate): Edge[] {
  return template.graph.edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.when || undefined,
  }))
}

/** 运行入参编辑器：运行时需要填写的参数（节点指令中用 {{参数名}} 引用） */
function VariablesEditor({ variables, onChange }: { variables: WorkflowVariable[]; onChange: (next: WorkflowVariable[]) => void }) {
  const update = (index: number, partial: Partial<WorkflowVariable>) => {
    onChange(variables.map((v, i) => (i === index ? { ...v, ...partial } : v)))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 340, maxHeight: 320, overflowY: 'auto' }}>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('template.variablesHint')}</Typography.Text>
      {variables.length === 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('common.none')}</Typography.Text>
      )}
      {variables.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Input
            size="small"
            value={v.name}
            placeholder={t('template.variableNamePlaceholder')}
            onChange={(e) => update(i, { name: e.target.value })}
            style={{ width: 110, flex: 'none' }}
          />
          <Input
            size="small"
            value={v.description || ''}
            placeholder={t('template.variableDescPlaceholder')}
            onChange={(e) => update(i, { description: e.target.value })}
          />
          <Tooltip title={t('template.delete')}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => onChange(variables.filter((_, j) => j !== i))} />
          </Tooltip>
        </div>
      ))}
      <Button size="small" type="dashed" block icon={<PlusOutlined />} onClick={() => onChange([...variables, { name: '', description: '' }])}>
        {t('template.addVariable')}
      </Button>
    </div>
  )
}

function CanvasInner({ template, onBack, onSaved }: Props) {
  const { token } = theme.useToken()
  const [draft, setDraft] = useState<WorkflowTemplate>(template)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // ReactFlow 自持画布状态（含 measured），业务模型变化时单向同步进来
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toViewNodes(template))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toViewEdges(template))

  /** 结构签名：节点/连线的 id 集合与位置，用于判断是否需要重建视图 */
  const signature = useMemo(() => {
    const n = draft.graph.nodes.map(x => `${x.id}@${x.position.x},${x.position.y}:${x.data?.label || ''}`).join('|')
    const e = draft.graph.edges.map(x => `${x.id}:${x.source}>${x.target}:${x.when || ''}`).join('|')
    return `${n}##${e}`
  }, [draft.graph])

  // 业务模型 → 画布：仅同步结构差异，保留 ReactFlow 的 measured 与选中态
  useEffect(() => {
    setNodes(prev => {
      const byId = new Map(prev.map(n => [n.id, n]))
      return draft.graph.nodes.map(n => {
        const old = byId.get(n.id)
        // 复用旧节点对象以保留 measured / selected 等内部字段，只覆盖位置与展示数据
        return {
          ...(old ?? { id: n.id, type: 'workflowNode', position: { ...n.position } }),
          id: n.id,
          type: 'workflowNode',
          position: { ...n.position },
          data: { label: n.data?.label || n.id, nodeType: n.type },
        } as Node
      })
    })
    setEdges(draft.graph.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.when || undefined,
    })))
    // signature 已覆盖结构内容，draft.graph 仅在结构变化时更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, setNodes, setEdges])

  // 拖拽结束：把画布位置落回业务模型（onNodesChange 高频，不逐次写业务 state）
  const persistPositions = useCallback(() => {
    const posById = new Map(nodes.map(n => [n.id, n.position]))
    setDraft(prev => ({ ...prev, graph: applyPositions(prev.graph, posById) }))
  }, [nodes])

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    const id = `e-${connection.source}-${connection.target}-${Date.now()}`
    const source = connection.source
    const target = connection.target
    setEdges(eds => addEdge({ ...connection, id }, eds))
    setDraft(prev => ({ ...prev, graph: addEdgeToGraph(prev.graph, id, source, target) }))
  }, [setEdges])

  // 选中项被删除后清理选中态，避免属性面板指向已不存在的对象
  useEffect(() => {
    if (selectedId && !draft.graph.nodes.some(n => n.id === selectedId)) setSelectedId(null)
    if (selectedEdgeId && !draft.graph.edges.some(e => e.id === selectedEdgeId)) setSelectedEdgeId(null)
  }, [draft.graph.nodes, draft.graph.edges, selectedId, selectedEdgeId])

  const addNode = useCallback((type: WorkflowNode['type'], label: string) => {
    setDraft(prev => {
      const next = addNodeToGraph(prev.graph, type, label)
      const added = next.nodes[next.nodes.length - 1]
      // 同步追加到画布状态（保留其余节点的 measured / selected）
      setNodes(nds => [...nds, {
        id: added.id,
        type: 'workflowNode',
        position: added.position,
        data: { label, nodeType: type },
      } as Node])
      return { ...prev, graph: next }
    })
  }, [setNodes])

  const deleteNode = useCallback((id: string) => {
    setNodes(nds => nds.filter(n => n.id !== id))
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id))
    setDraft(prev => ({ ...prev, graph: deleteNodeFromGraph(prev.graph, id) }))
  }, [setNodes, setEdges])

  const deleteEdge = useCallback((id: string) => {
    setEdges(eds => eds.filter(e => e.id !== id))
    setDraft(prev => ({ ...prev, graph: deleteEdgeFromGraph(prev.graph, id) }))
  }, [setEdges])

  const save = async () => {
    setSaving(true)
    try {
      const res = await invoke<{ template?: WorkflowTemplate; error?: string }>('template-save', {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        // 丢弃未命名的入参行（编辑过程中可能只填了一半）
        variables: draft.variables.filter(v => v.name.trim()),
        graph: draft.graph,
      })
      if (res?.error || !res?.template) {
        message.error(res?.error || t('common.saveFailed'))
        return
      }
      onSaved(res.template)
      message.success(t('template.saved'))
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const selectedNode = draft.graph.nodes.find(n => n.id === selectedId) || null
  const selectedEdge = draft.graph.edges.find(e => e.id === selectedEdgeId) || null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶栏：返回 / 名称 / 保存 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>
          {t('canvas.back')}
        </Button>
        <Input
          size="small"
          value={draft.name}
          placeholder={t('template.namePlaceholder')}
          onChange={(e) => setDraft(prev => ({ ...prev, name: e.target.value }))}
          style={{ maxWidth: 280 }}
        />
        <Input
          size="small"
          value={draft.description}
          placeholder={t('template.descriptionPlaceholder')}
          onChange={(e) => setDraft(prev => ({ ...prev, description: e.target.value }))}
          style={{ flex: 1, minWidth: 160 }}
        />
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <VariablesEditor
              variables={draft.variables}
              onChange={(variables) => setDraft(prev => ({ ...prev, variables }))}
            />
          }
        >
          <Button size="small">{t('template.variables')}</Button>
        </Popover>
        <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
          {t('template.save')}
        </Button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 节点库 */}
        <div style={{ width: 180, flex: 'none', borderRight: `1px solid ${token.colorBorderSecondary}`, overflowY: 'auto', padding: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {t('canvas.nodeLibrary')}
          </Typography.Text>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {NODE_CATALOG.map(item => (
              <Card
                key={item.type}
                size="small"
                hoverable
                onClick={() => addNode(item.type, t(item.labelKey))}
                styles={{ body: { padding: '6px 8px', cursor: 'pointer' } }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PlusOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
                  <Typography.Text style={{ fontSize: 12 }}>{t(item.labelKey)}</Typography.Text>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {t(item.descKey)}
                </Typography.Text>
              </Card>
            ))}
          </Space>
        </div>

        {/* 画布 */}
        <div style={{ flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={persistPositions}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelectedId(node.id); setSelectedEdgeId(null) }}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedId(null) }}
            onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null) }}
            fitView
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <Background color={token.colorBorderSecondary} gap={16} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ background: token.colorBgElevated }} />
          </ReactFlow>
          {draft.graph.nodes.length === 0 && (
            <Typography.Text
              type="secondary"
              style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: 12, pointerEvents: 'none' }}
            >
              {t('canvas.dropHint')}
            </Typography.Text>
          )}
        </div>

        {/* 属性面板 */}
        <div style={{ width: 300, flex: 'none', borderLeft: `1px solid ${token.colorBorderSecondary}`, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {selectedEdge ? t('edge.inspector') : t('canvas.inspector')}
            </Typography.Text>
            {selectedNode && (
              <Tooltip title={t('canvas.deleteNode')}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => deleteNode(selectedNode.id)} />
              </Tooltip>
            )}
            {selectedEdge && (
              <Tooltip title={t('edge.delete')}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => deleteEdge(selectedEdge.id)} />
              </Tooltip>
            )}
          </div>
          {selectedEdge ? (
            <EdgeInspector template={draft} edge={selectedEdge} onChange={setDraft} />
          ) : (
            <NodeInspector template={draft} node={selectedNode} onChange={setDraft} />
          )}
        </div>
      </div>
    </div>
  )
}

/** 画布需要 ReactFlowProvider 提供内部上下文（useReactFlow 等） */
export function CanvasEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
