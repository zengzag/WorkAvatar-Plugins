/**
 * 画布编辑器：左侧节点库 + 中间画布 + 右侧属性面板。
 *
 * 状态约定（对齐 data-model 插件的可用实现）：
 * - 画布节点/连线由 ReactFlow 的 useNodesState/useEdgesState 持有（含 measured 等内部字段），
 *   **不可**每轮从业务模型重建，否则会丢掉 measured，导致点击/拖拽等交互失效。
 * - 业务模型 draft.graph 为唯一事实来源；结构变化时用 effect 单向同步进 useNodesState。
 * - onNodesChange 交给 useNodesState 处理（拖拽即写回 position），再落回 draft.graph。
 *
 * 编辑历史：结构/内容变更经 commitGraph 落回业务模型并压入撤销栈，支持 Ctrl+Z / Ctrl+Shift+Z；
 * 连续输入同一对象时按 coalesceKey 合并为一条历史，避免逐字符撤销。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button, Card, Input, Menu, Modal, Space, Tooltip, Typography, message, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  ExpandOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { invoke, t } from './host'
import type { WorkflowGraph, WorkflowNode, WorkflowTemplate, WorkflowVariable } from '../shared/types'
import { NODE_CATALOG, NODE_COLORS } from './node-catalog'
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
/** 撤销栈上限 */
const HISTORY_LIMIT = 100
/** 同一对象的连续编辑合并为一条历史（毫秒） */
const COALESCE_MS = 800

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
function VariablesModal({ open, variables, onSave, onClose }: {
  open: boolean
  variables: WorkflowVariable[]
  onSave: (next: WorkflowVariable[]) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<WorkflowVariable[]>(variables)

  useEffect(() => {
    if (open) setRows(variables.length > 0 ? variables.map(v => ({ ...v })) : [])
  }, [open, variables])

  const update = (index: number, partial: Partial<WorkflowVariable>) => {
    setRows(prev => prev.map((r, i) => (i === index ? { ...r, ...partial } : r)))
  }

  const save = () => {
    const cleaned = rows
      .map(r => ({
        name: (r.name || '').trim(),
        description: (r.description || '').trim(),
        defaultValue: (r.defaultValue || '').trim(),
      }))
      .filter(r => r.name || r.description || r.defaultValue)
    if (cleaned.some(r => !r.name)) {
      message.error(t('template.unnamedVariable'))
      return
    }
    const seen = new Set<string>()
    for (const r of cleaned) {
      if (seen.has(r.name)) {
        message.error(t('template.repeatName', { name: r.name }))
        return
      }
      seen.add(r.name)
    }
    onSave(cleaned.map(r => {
      const variable: WorkflowVariable = { name: r.name }
      if (r.description) variable.description = r.description
      if (r.defaultValue) variable.defaultValue = r.defaultValue
      return variable
    }))
    onClose()
  }

  return (
    <Modal
      open={open}
      title={t('template.variables')}
      onOk={save}
      onCancel={onClose}
      okText={t('template.save')}
      cancelText={t('common.cancel')}
      width={680}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        {t('template.variablesHint')}
      </Typography.Paragraph>

      {rows.length === 0 ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
          {t('template.variablesEmpty')}
        </Typography.Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11, width: 140, flex: 'none' }}>{t('template.variableName')}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11, flex: 1 }}>{t('template.variableDesc')}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11, width: 170, flex: 'none' }}>{t('template.variableDefault')}</Typography.Text>
            <span style={{ width: 28, flex: 'none' }} />
          </div>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Input
                size="small"
                value={r.name}
                placeholder={t('template.variableNamePlaceholder')}
                onChange={(e) => update(i, { name: e.target.value })}
                style={{ width: 140, flex: 'none' }}
              />
              <Input
                size="small"
                value={r.description || ''}
                placeholder={t('template.variableDescPlaceholder')}
                onChange={(e) => update(i, { description: e.target.value })}
              />
              <Input
                size="small"
                value={r.defaultValue || ''}
                placeholder={t('template.variableDefaultPlaceholder')}
                onChange={(e) => update(i, { defaultValue: e.target.value })}
                style={{ width: 170, flex: 'none' }}
              />
              <Tooltip title={t('template.delete')}>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
                  style={{ flex: 'none' }}
                />
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      <Button
        size="small"
        type="dashed"
        block
        icon={<PlusOutlined />}
        onClick={() => setRows(prev => [...prev, { name: '', description: '', defaultValue: '' }])}
        style={{ marginTop: 12 }}
      >
        {t('template.addVariable')}
      </Button>
    </Modal>
  )
}

type MenuItem = Required<MenuProps>['items'][number]

/** 画布右键菜单定位信息 */
interface MenuState {
  x: number
  y: number
  kind: 'pane' | 'node' | 'edge'
  id?: string
  flowPosition?: { x: number; y: number }
}

function CanvasInner({ template, onBack, onSaved }: Props) {
  const { token } = theme.useToken()
  const [draft, setDraft] = useState<WorkflowTemplate>(template)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [historyFlags, setHistoryFlags] = useState({ undo: false, redo: false })

  const { fitView, screenToFlowPosition } = useReactFlow()

  // ReactFlow 自持画布状态（含 measured），业务模型变化时单向同步进来
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toViewNodes(template))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toViewEdges(template))

  // ====== 编辑历史（撤销/重做） ======
  const pastRef = useRef<WorkflowGraph[]>([])
  const futureRef = useRef<WorkflowGraph[]>([])
  const lastCommitRef = useRef<{ key: string; at: number } | null>(null)

  const syncHistoryFlags = useCallback(() => {
    setHistoryFlags({ undo: pastRef.current.length > 0, redo: futureRef.current.length > 0 })
  }, [])

  /** 落回业务模型并记录历史；coalesceKey 相同且间隔较近时合并为一条历史 */
  const commitGraph = useCallback((updater: (graph: WorkflowGraph) => WorkflowGraph, coalesceKey?: string) => {
    const prevGraph = draft.graph
    const nextGraph = updater(prevGraph)
    if (nextGraph === prevGraph) return
    setDraft(prev => ({ ...prev, graph: nextGraph }))
    const now = Date.now()
    const last = lastCommitRef.current
    const merge = !!coalesceKey && !!last && last.key === coalesceKey && now - last.at < COALESCE_MS
    if (!merge) {
      pastRef.current.push(prevGraph)
      if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift()
      futureRef.current = []
      syncHistoryFlags()
    }
    lastCommitRef.current = coalesceKey ? { key: coalesceKey, at: now } : null
  }, [draft.graph, syncHistoryFlags])

  const undo = useCallback(() => {
    const prevGraph = pastRef.current.pop()
    if (!prevGraph) return
    futureRef.current.push(draft.graph)
    lastCommitRef.current = null
    setDraft(prev => ({ ...prev, graph: prevGraph }))
    syncHistoryFlags()
  }, [draft.graph, syncHistoryFlags])

  const redo = useCallback(() => {
    const nextGraph = futureRef.current.pop()
    if (!nextGraph) return
    pastRef.current.push(draft.graph)
    lastCommitRef.current = null
    setDraft(prev => ({ ...prev, graph: nextGraph }))
    syncHistoryFlags()
  }, [draft.graph, syncHistoryFlags])

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
    commitGraph(g => applyPositions(g, posById))
  }, [nodes, commitGraph])

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    const id = `e-${connection.source}-${connection.target}-${Date.now()}`
    const source = connection.source
    const target = connection.target
    setEdges(eds => addEdge({ ...connection, id }, eds))
    commitGraph(g => addEdgeToGraph(g, id, source, target))
  }, [setEdges, commitGraph])

  // 选中项被删除后清理选中态，避免属性面板指向已不存在的对象
  useEffect(() => {
    if (selectedId && !draft.graph.nodes.some(n => n.id === selectedId)) setSelectedId(null)
    if (selectedEdgeId && !draft.graph.edges.some(e => e.id === selectedEdgeId)) setSelectedEdgeId(null)
  }, [draft.graph.nodes, draft.graph.edges, selectedId, selectedEdgeId])

  const addNode = useCallback((type: WorkflowNode['type'], label: string, position?: { x: number; y: number }) => {
    const next = addNodeToGraph(draft.graph, type, label, position)
    const added = next.nodes[next.nodes.length - 1]
    // 同步追加到画布状态（保留其余节点的 measured / selected）
    setNodes(nds => [...nds, {
      id: added.id,
      type: 'workflowNode',
      position: added.position,
      data: { label, nodeType: type },
    } as Node])
    commitGraph(() => next)
  }, [draft.graph, setNodes, commitGraph])

  const deleteNode = useCallback((id: string) => {
    setNodes(nds => nds.filter(n => n.id !== id))
    setEdges(eds => eds.filter(e => e.source !== id && e.target !== id))
    commitGraph(g => deleteNodeFromGraph(g, id))
  }, [setNodes, setEdges, commitGraph])

  const deleteEdge = useCallback((id: string) => {
    setEdges(eds => eds.filter(e => e.id !== id))
    commitGraph(g => deleteEdgeFromGraph(g, id))
  }, [setEdges, commitGraph])

  // 快捷键：撤销 / 重做 / 删除选中项；输入框内不拦截（保留原生编辑行为）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editable = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') {
        if (editable) return
        event.preventDefault()
        if (event.shiftKey) redo(); else undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        if (editable) return
        event.preventDefault()
        redo()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !editable) {
        if (selectedEdgeId) { event.preventDefault(); deleteEdge(selectedEdgeId); return }
        if (selectedId) { event.preventDefault(); deleteNode(selectedId) }
        return
      }
      if (event.key === 'Escape') { setSelectedId(null); setSelectedEdgeId(null); setMenu(null) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, deleteNode, deleteEdge, selectedId, selectedEdgeId])

  const openMenu = useCallback((event: MouseEvent | React.MouseEvent, state: Omit<MenuState, 'x' | 'y'>) => {
    event.preventDefault()
    const maxX = Math.max(window.innerWidth - 220, 8)
    const maxY = Math.max(window.innerHeight - 300, 8)
    setMenu({
      ...state,
      x: Math.min(event.clientX, maxX),
      y: Math.min(event.clientY, maxY),
    })
  }, [])

  const menuItems: MenuItem[] = useMemo(() => {
    if (!menu) return []
    const undoRedo: MenuItem[] = [
      { key: 'undo', label: t('canvas.undo'), icon: <UndoOutlined />, disabled: !historyFlags.undo },
      { key: 'redo', label: t('canvas.redo'), icon: <RedoOutlined />, disabled: !historyFlags.redo },
    ]
    if (menu.kind === 'node') {
      return [
        { key: 'delete-node', label: t('canvas.deleteNode'), icon: <DeleteOutlined />, danger: true },
        { type: 'divider' },
        ...undoRedo,
      ]
    }
    if (menu.kind === 'edge') {
      return [
        { key: 'delete-edge', label: t('edge.delete'), icon: <DeleteOutlined />, danger: true },
        { type: 'divider' },
        ...undoRedo,
      ]
    }
    return [
      {
        key: 'add',
        label: t('canvas.newNode'),
        icon: <PlusOutlined />,
        children: NODE_CATALOG.map(item => ({ key: `add:${item.type}`, label: t(item.labelKey) })),
      },
      { type: 'divider' },
      ...undoRedo,
      { type: 'divider' },
      { key: 'fit', label: t('canvas.fitView'), icon: <ExpandOutlined /> },
    ]
  }, [menu, historyFlags])

  const onMenuClick = useCallback(({ key }: { key: string }) => {
    const state = menu
    setMenu(null)
    if (!state) return
    if (key.startsWith('add:')) {
      const type = key.slice(4) as WorkflowNode['type']
      const labelKey = NODE_CATALOG.find(item => item.type === type)?.labelKey
      addNode(type, labelKey ? t(labelKey) : type, state.flowPosition)
    } else if (key === 'delete-node' && state.id) {
      deleteNode(state.id)
    } else if (key === 'delete-edge' && state.id) {
      deleteEdge(state.id)
    } else if (key === 'undo') {
      undo()
    } else if (key === 'redo') {
      redo()
    } else if (key === 'fit') {
      void fitView({ padding: 0.2 })
    }
  }, [menu, addNode, deleteNode, deleteEdge, undo, redo, fitView])

  /** 属性面板改动：整体回写 graph，并按对象合并历史 */
  const handleInspectorChange = useCallback((next: WorkflowTemplate) => {
    const key = selectedEdgeId ? `edge:${selectedEdgeId}` : selectedId ? `node:${selectedId}` : undefined
    commitGraph(() => next.graph, key)
  }, [commitGraph, selectedId, selectedEdgeId])

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
        message.error(res?.error || t('template.saveFailed'))
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

  // 画布控件与缩略图的主题适配（ReactFlow 默认样式在暗色下不可见）
  const canvasCss = `
.wf-canvas .react-flow__controls { box-shadow: ${token.boxShadowSecondary}; border-radius: 8px; overflow: hidden; }
.wf-canvas .react-flow__controls-button { background: ${token.colorBgElevated}; border-bottom: 1px solid ${token.colorBorderSecondary}; width: 26px; height: 26px; }
.wf-canvas .react-flow__controls-button:last-child { border-bottom: none; }
.wf-canvas .react-flow__controls-button:hover { background: ${token.colorFillSecondary}; }
.wf-canvas .react-flow__controls-button svg { fill: ${token.colorText}; max-width: 13px; max-height: 13px; }
.wf-canvas .react-flow__minimap { background: ${token.colorBgElevated}; border: 1px solid ${token.colorBorderSecondary}; border-radius: 8px; }
.wf-canvas .react-flow__attribution { display: none; }
`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* 顶栏：返回 / 名称 / 保存 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>
          {t('canvas.back')}
        </Button>
        <Tooltip title={t('canvas.undo')}>
          <Button size="small" type="text" icon={<UndoOutlined />} disabled={!historyFlags.undo} onClick={undo} />
        </Tooltip>
        <Tooltip title={t('canvas.redo')}>
          <Button size="small" type="text" icon={<RedoOutlined />} disabled={!historyFlags.redo} onClick={redo} />
        </Tooltip>
        <Input
          size="small"
          value={draft.name}
          placeholder={t('template.namePlaceholder')}
          onChange={(e) => setDraft(prev => ({ ...prev, name: e.target.value }))}
          style={{ maxWidth: 260 }}
        />
        <Input
          size="small"
          value={draft.description}
          placeholder={t('template.descriptionPlaceholder')}
          onChange={(e) => setDraft(prev => ({ ...prev, description: e.target.value }))}
          style={{ flex: 1, minWidth: 140 }}
        />
        <Button size="small" onClick={() => setVariablesOpen(true)}>
          {t('template.variables')}{draft.variables.length > 0 ? ` (${draft.variables.length})` : ''}
        </Button>
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
          <style>{canvasCss}</style>
          <div className="wf-canvas" style={{ width: '100%', height: '100%' }}>
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
              onPaneContextMenu={(event) => openMenu(event, {
                kind: 'pane',
                flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
              })}
              onNodeContextMenu={(event, node) => openMenu(event, { kind: 'node', id: node.id })}
              onEdgeContextMenu={(event, edge) => openMenu(event, { kind: 'edge', id: edge.id })}
              fitView
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background color={token.colorBorderSecondary} gap={16} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                maskColor={token.colorBgMask}
                nodeColor={(n) => NODE_COLORS[(n.data as { nodeType?: string })?.nodeType || ''] || token.colorPrimary}
              />
            </ReactFlow>
          </div>
          {draft.graph.nodes.length === 0 && (
            <Typography.Text
              type="secondary"
              style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: 12, pointerEvents: 'none' }}
            >
              {t('canvas.dropHint')}
            </Typography.Text>
          )}

          {/* 右键菜单：遮罩层点击即关闭 */}
          {menu && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
                onMouseDown={() => setMenu(null)}
                onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
              />
              <div style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1001 }}>
                <Menu
                  items={menuItems}
                  onClick={onMenuClick}
                  style={{
                    minWidth: 180,
                    boxShadow: token.boxShadowSecondary,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 8,
                  }}
                />
              </div>
            </>
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
            <EdgeInspector template={draft} edge={selectedEdge} onChange={handleInspectorChange} />
          ) : (
            <NodeInspector template={draft} node={selectedNode} onChange={handleInspectorChange} />
          )}
        </div>
      </div>

      <VariablesModal
        open={variablesOpen}
        variables={draft.variables}
        onSave={(variables) => setDraft(prev => ({ ...prev, variables }))}
        onClose={() => setVariablesOpen(false)}
      />
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
