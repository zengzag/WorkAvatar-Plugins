/**
 * 画布编辑器：顶栏只保留名称/保存，节点库收进「添加节点」浮层，
 * 属性面板仅在选中节点/连线时浮出，高级项默认折叠。
 *
 * 状态约定：
 * - 画布节点/连线由 ReactFlow 的 useNodesState/useEdgesState 持有（含 measured 等内部字段），
 *   不可每轮从业务模型重建，否则会丢掉 measured，导致点击/拖拽等交互失效。
 * - 业务模型 draft.graph 为唯一事实来源；结构变化时用 effect 单向同步进 useNodesState。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background,
  Controls,
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
import { Button, Input, Menu, Modal, Popover, Tooltip, Typography, message, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  BranchesOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExpandOutlined,
  FlagOutlined,
  PlusOutlined,
  RedoOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined,
  SyncOutlined,
  ToolOutlined,
  UndoOutlined,
  UserOutlined,
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
const HISTORY_LIMIT = 100
const COALESCE_MS = 800

interface Props {
  template: WorkflowTemplate
  onBack: () => void
  onSaved: (template: WorkflowTemplate) => void
}

/** 节点类型图标（节点库浮层与画布节点共用配色语言） */
function nodeIcon(type: string, size = 14): ReactNode {
  const style = { fontSize: size }
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

function toViewNodes(template: WorkflowTemplate): Node[] {
  return template.graph.nodes.map(node => ({
    id: node.id,
    type: 'workflowNode',
    position: { ...node.position },
    data: {
      label: node.data?.label || node.id,
      nodeType: node.type,
      summary: node.data?.ephemeralRole?.name || t(`node.${node.type}`),
    },
  }))
}

function toViewEdges(template: WorkflowTemplate): Edge[] {
  return template.graph.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.when || undefined,
  }))
}

/** 模板设置：名称 / 说明 / 运行入参 */
function TemplateSettingsModal({ open, draft, onSave, onClose }: {
  open: boolean
  draft: WorkflowTemplate
  onSave: (patch: Pick<WorkflowTemplate, 'name' | 'description' | 'variables'>) => void
  onClose: () => void
}) {
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description || '')
  const [rows, setRows] = useState<WorkflowVariable[]>(draft.variables)

  useEffect(() => {
    if (!open) return
    setName(draft.name)
    setDescription(draft.description || '')
    setRows(draft.variables.length > 0 ? draft.variables.map(variable => ({ ...variable })) : [])
  }, [open, draft])

  const update = (index: number, patch: Partial<WorkflowVariable>) => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const save = () => {
    const cleaned = rows
      .map(row => ({
        name: (row.name || '').trim(),
        description: (row.description || '').trim(),
        defaultValue: (row.defaultValue || '').trim(),
      }))
      .filter(row => row.name || row.description || row.defaultValue)
    if (cleaned.some(row => !row.name)) {
      message.error(t('template.unnamedVariable'))
      return
    }
    const seen = new Set<string>()
    for (const row of cleaned) {
      if (seen.has(row.name)) {
        message.error(t('template.repeatName', { name: row.name }))
        return
      }
      seen.add(row.name)
    }
    onSave({
      name: name.trim() || draft.name,
      description,
      variables: cleaned.map(row => {
        const variable: WorkflowVariable = { name: row.name }
        if (row.description) variable.description = row.description
        if (row.defaultValue) variable.defaultValue = row.defaultValue
        return variable
      }),
    })
    onClose()
  }

  return (
    <Modal
      open={open}
      title={t('canvas.templateSettings')}
      onOk={save}
      onCancel={onClose}
      okText={t('template.save')}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnHidden
    >
      <div className="wf-field">
        <label className="wf-field-label">{t('template.name')}</label>
        <Input value={name} placeholder={t('template.namePlaceholder')} onChange={event => setName(event.target.value)} />
      </div>
      <div className="wf-field">
        <label className="wf-field-label">{t('template.description')}</label>
        <Input value={description} placeholder={t('template.descriptionPlaceholder')} onChange={event => setDescription(event.target.value)} />
      </div>
      <div className="wf-field">
        <label className="wf-field-label">{t('template.variables')}</label>
        <div className="wf-settings-head"><span>{t('template.variableName')}</span><span>{t('template.variableDesc')}</span><span>{t('template.variableDefault')}</span></div>
        {rows.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('template.variablesEmpty')}</Typography.Text>
        ) : (
          rows.map((row, index) => (
            <div className="wf-settings-row" key={index}>
              <Input
                value={row.name}
                placeholder={t('template.variableNamePlaceholder')}
                onChange={event => update(index, { name: event.target.value })}
              />
              <Input
                value={row.description || ''}
                placeholder={t('template.variableDescPlaceholder')}
                onChange={event => update(index, { description: event.target.value })}
              />
              <Input
                value={row.defaultValue || ''}
                placeholder={t('template.variableDefaultPlaceholder')}
                onChange={event => update(index, { defaultValue: event.target.value })}
                style={{ maxWidth: 140 }}
              />
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => setRows(prev => prev.filter((_, i) => i !== index))}
              />
            </div>
          ))
        )}
        <Button
          type="dashed"
          size="small"
          block
          icon={<PlusOutlined />}
          onClick={() => setRows(prev => [...prev, { name: '', description: '', defaultValue: '' }])}
          style={{ marginTop: 8 }}
        >
          {t('template.addVariable')}
        </Button>
        <div className="wf-help">{t('template.variablesHint')}</div>
      </div>
    </Modal>
  )
}

type MenuItem = Required<MenuProps>['items'][number]

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [historyFlags, setHistoryFlags] = useState({ undo: false, redo: false })
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(template))

  const { fitView, screenToFlowPosition } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toViewNodes(template))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toViewEdges(template))

  const [inspectorOpen, setInspectorOpen] = useState(false)

  const pastRef = useRef<WorkflowGraph[]>([])
  const futureRef = useRef<WorkflowGraph[]>([])
  const lastCommitRef = useRef<{ key: string; at: number } | null>(null)

  const syncHistoryFlags = useCallback(() => {
    setHistoryFlags({ undo: pastRef.current.length > 0, redo: futureRef.current.length > 0 })
  }, [])

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

  const signature = useMemo(() => {
    const nodeSignature = draft.graph.nodes
      .map(node => `${node.id}@${node.position.x},${node.position.y}:${node.data?.label || ''}:${node.data?.ephemeralRole?.name || ''}`)
      .join('|')
    const edgeSignature = draft.graph.edges.map(edge => `${edge.id}:${edge.source}>${edge.target}:${edge.when || ''}`).join('|')
    return `${nodeSignature}##${edgeSignature}`
  }, [draft.graph])

  useEffect(() => {
    setNodes(prev => {
      const byId = new Map(prev.map(node => [node.id, node]))
      return draft.graph.nodes.map(node => {
        const old = byId.get(node.id)
        return {
          ...(old ?? { id: node.id, type: 'workflowNode', position: { ...node.position } }),
          id: node.id,
          type: 'workflowNode',
          position: { ...node.position },
          data: {
            label: node.data?.label || node.id,
            nodeType: node.type,
            summary: node.data?.ephemeralRole?.name || t(`node.${node.type}`),
          },
        } as Node
      })
    })
    setEdges(draft.graph.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.when || undefined,
    })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, setNodes, setEdges])

  const persistPositions = useCallback(() => {
    const positionById = new Map(nodes.map(node => [node.id, node.position]))
    commitGraph(graph => applyPositions(graph, positionById))
  }, [nodes, commitGraph])

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    const id = `e-${connection.source}-${connection.target}-${Date.now()}`
    const source = connection.source
    const target = connection.target
    setEdges(current => addEdge({ ...connection, id }, current))
    commitGraph(graph => addEdgeToGraph(graph, id, source, target))
  }, [setEdges, commitGraph])

  useEffect(() => {
    if (selectedId && !draft.graph.nodes.some(node => node.id === selectedId)) setSelectedId(null)
    if (selectedEdgeId && !draft.graph.edges.some(edge => edge.id === selectedEdgeId)) setSelectedEdgeId(null)
    if (!selectedId && !selectedEdgeId) setInspectorOpen(false)
  }, [draft.graph.nodes, draft.graph.edges, selectedId, selectedEdgeId])

  const addNode = useCallback((type: WorkflowNode['type'], label: string, position?: { x: number; y: number }) => {
    const next = addNodeToGraph(draft.graph, type, label, position)
    const added = next.nodes[next.nodes.length - 1]
    setNodes(current => [...current, {
      id: added.id,
      type: 'workflowNode',
      position: added.position,
      data: { label, nodeType: type, summary: t(`node.${type}`) },
    } as Node])
    commitGraph(() => next)
    setSelectedId(added.id)
    setSelectedEdgeId(null)
    setInspectorOpen(true)
  }, [draft.graph, setNodes, commitGraph])

  const deleteNode = useCallback((id: string) => {
    setNodes(current => current.filter(node => node.id !== id))
    setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id))
    commitGraph(graph => deleteNodeFromGraph(graph, id))
  }, [setNodes, setEdges, commitGraph])

  const deleteEdge = useCallback((id: string) => {
    setEdges(current => current.filter(edge => edge.id !== id))
    commitGraph(graph => deleteEdgeFromGraph(graph, id))
  }, [setEdges, commitGraph])

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
      if (event.key === 'Escape') {
        setSelectedId(null)
        setSelectedEdgeId(null)
        setMenu(null)
        setInspectorOpen(false)
      }
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
        variables: draft.variables.filter(variable => variable.name.trim()),
        graph: draft.graph,
      })
      if (res?.error || !res?.template) {
        message.error(res?.error || t('template.saveFailed'))
        return
      }
      setDraft(res.template)
      setSavedSnapshot(JSON.stringify(res.template))
      onSaved(res.template)
      message.success(t('template.saved'))
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const selectedNode = draft.graph.nodes.find(node => node.id === selectedId) || null
  const selectedEdge = draft.graph.edges.find(edge => edge.id === selectedEdgeId) || null
  const dirty = useMemo(() => JSON.stringify(draft) !== savedSnapshot, [draft, savedSnapshot])

  const canvasNodeTypes = useMemo(() => nodeTypes, [])

  const addNodeContent = (
    <div style={{ width: 224 }}>
      <div style={{ fontSize: 10.5, color: token.colorTextTertiary, padding: '0 6px 7px' }}>
        {t('canvas.addNode')}
      </div>
      {NODE_CATALOG.map(item => (
        <button
          key={item.type}
          className="wf-node-add"
          onClick={() => {
            addNode(item.type, t(item.labelKey))
            setAddOpen(false)
          }}
        >
          <span
            className="wf-node-add-icon"
            style={{ color: NODE_COLORS[item.type], background: `${NODE_COLORS[item.type]}18` }}
          >
            {nodeIcon(item.type, 13)}
          </span>
          <span>
            <span className="wf-node-add-name">{t(item.labelKey)}</span>
            <span className="wf-node-add-desc">{t(item.descKey)}</span>
          </span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="wf-editor">
      <div className="wf-edit-head">
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={onBack} title={t('canvas.back')} />
        <Tooltip title={t('canvas.undo')}>
          <Button type="text" size="small" icon={<UndoOutlined />} disabled={!historyFlags.undo} onClick={undo} />
        </Tooltip>
        <Tooltip title={t('canvas.redo')}>
          <Button type="text" size="small" icon={<RedoOutlined />} disabled={!historyFlags.redo} onClick={redo} />
        </Tooltip>
        <Input
          className="wf-edit-name"
          value={draft.name}
          placeholder={t('template.namePlaceholder')}
          onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
        />
        <span className={`wf-edit-state ${dirty ? 'dirty' : ''}`}>
          {dirty ? t('canvas.unsaved') : t('canvas.saved')}
        </span>
        <div className="wf-edit-actions">
          <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
            {t('canvas.templateSettings')}
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
            {t('template.save')}
          </Button>
        </div>
      </div>

      <div className="wf-canvas">
        <div className="wf-canvas-tools">
          <Popover
            content={addNodeContent}
            trigger="click"
            placement="bottomLeft"
            open={addOpen}
            onOpenChange={setAddOpen}
          >
            <Button icon={<PlusOutlined />}>{t('canvas.addNode')}</Button>
          </Popover>
          <Tooltip title={t('canvas.fitView')}>
            <Button icon={<ExpandOutlined />} onClick={() => void fitView({ padding: 0.2 })} />
          </Tooltip>
        </div>
        <div className="wf-canvas-tip" style={{ opacity: inspectorOpen ? 0 : 1 }}>
          {t('canvas.editTip')}
        </div>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={canvasNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={persistPositions}
          onConnect={onConnect}
          onNodeClick={(_, node) => {
            setSelectedId(node.id)
            setSelectedEdgeId(null)
            setInspectorOpen(true)
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id)
            setSelectedId(null)
            setInspectorOpen(true)
          }}
          onPaneClick={() => {
            setSelectedId(null)
            setSelectedEdgeId(null)
            setInspectorOpen(false)
          }}
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
        </ReactFlow>

        {draft.graph.nodes.length === 0 ? (
          <Typography.Text
            type="secondary"
            style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              fontSize: 12, pointerEvents: 'none',
            }}
          >
            {t('canvas.dropHint')}
          </Typography.Text>
        ) : null}

        {menu ? (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
              onMouseDown={() => setMenu(null)}
              onContextMenu={(event) => { event.preventDefault(); setMenu(null) }}
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
        ) : null}
      </div>

      {inspectorOpen && (selectedNode || selectedEdge) ? (
        <aside className="wf-inspector">
          <div className="wf-insp-head">
            <span className="wf-insp-type">
              {selectedEdge ? t('edge.inspector') : t(`node.${selectedNode?.type}`)}
            </span>
            <h4>{selectedEdge ? t('edge.branchType') : selectedNode?.data?.label}</h4>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={() => {
                setSelectedId(null)
                setSelectedEdgeId(null)
                setInspectorOpen(false)
              }}
            />
          </div>
          <div className="wf-insp-body">
            {selectedEdge ? (
              <EdgeInspector template={draft} edge={selectedEdge} onChange={handleInspectorChange} />
            ) : selectedNode ? (
              <NodeInspector template={draft} node={selectedNode} onChange={handleInspectorChange} />
            ) : null}
          </div>
          <div className="wf-insp-foot">
            <Button
              onClick={() => {
                setSelectedId(null)
                setSelectedEdgeId(null)
                setInspectorOpen(false)
              }}
            >
              {t('canvas.done')}
            </Button>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                if (selectedEdge) deleteEdge(selectedEdge.id)
                else if (selectedNode) deleteNode(selectedNode.id)
                setSelectedId(null)
                setSelectedEdgeId(null)
                setInspectorOpen(false)
              }}
            >
              {selectedEdge ? t('edge.delete') : t('canvas.deleteNode')}
            </Button>
          </div>
        </aside>
      ) : null}

      <TemplateSettingsModal
        open={settingsOpen}
        draft={draft}
        onSave={(patch) => setDraft(prev => ({ ...prev, ...patch }))}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

export function CanvasEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
