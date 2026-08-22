// 数据模型画布

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Popconfirm, Tooltip } from 'antd'
import {
  DeleteOutlined, SelectOutlined, DownOutlined, UpOutlined,
  AlignLeftOutlined, AlignCenterOutlined, AlignRightOutlined,
  VerticalAlignTopOutlined, VerticalAlignMiddleOutlined, VerticalAlignBottomOutlined,
  ColumnWidthOutlined, SortAscendingOutlined
} from '@ant-design/icons'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, SelectionMode,
  useNodesState, useEdgesState, useReactFlow,
  type Connection, type Node, type Edge, type OnNodeDrag, type NodeMouseHandler
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useDataModelStore } from '../data-model.store'
import { useAppearance, hostT } from '../store'
import { createTable, createRelationship } from '../../shared/domain'
import { TableNode, type TableNodeData } from './TableNode'
import { RelationshipEdge, type RelationshipEdgeData } from './RelationshipEdge'
import { layoutTables, NODE_WIDTH, HEADER_HEIGHT, FIELD_HEIGHT, NODE_HEIGHT_COLLAPSED, getVisibleFields } from './dagre-layout'
import { alignPositions, distributePositions, type AlignMode, type DistributeMode } from './arrange'
import { CanvasContextMenu, type ContextMenuState } from './CanvasContextMenu'

const nodeTypes = { table: TableNode }
const edgeTypes = { relationship: RelationshipEdge }

function CanvasInner() {
  const model = useDataModelStore((s) => s.model)
  const selectedTableId = useDataModelStore((s) => s.selectedTableId)
  const selectedTableIds = useDataModelStore((s) => s.selectedTableIds)
  const selectedRelationshipId = useDataModelStore((s) => s.selectedRelationshipId)
  const focusRequest = useDataModelStore((s) => s.focusRequest)
  const layoutRequest = useDataModelStore((s) => s.layoutRequest)
  const canUndo = useDataModelStore((s) => s.canUndo)
  const canRedo = useDataModelStore((s) => s.canRedo)
  const undo = useDataModelStore((s) => s.undo)
  const redo = useDataModelStore((s) => s.redo)
  const { selectTable, setSelectedTables, selectRelationship, updateTable, updateTables, updateTablePositions, removeTable, removeTables, addTable, addRelationship, removeRelationship, requestLayout } = useDataModelStore.getState()

  const { isDark } = useAppearance()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<RelationshipEdgeData>>([])
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { setCenter, getNode, getNodes, fitView } = useReactFlow()

  // 用于检测 model 是否切换（新项目加载）
  const prevModelId = useRef<string | undefined>(model?.id)

  // 当 model 切换（新项目加载）时，重新自动布局
  useEffect(() => {
    if (!model) {
      setNodes([])
      setEdges([])
      prevModelId.current = undefined
      return
    }
    if (prevModelId.current !== model.id) {
      prevModelId.current = model.id
      const width = containerRef.current?.clientWidth ?? 800
      const { nodes: laidOut } = layoutTables(model, width)
      setNodes(laidOut.map((l) => ({
        id: l.id,
        type: 'table',
        position: l.position,
        data: { table: model.tables.find((t) => t.id === l.id)!, relationships: model.relationships }
      })))
      setEdges(model.relationships.map((r) => ({
        id: r.id,
        type: 'relationship',
        source: r.sourceTableId,
        target: r.targetTableId,
        sourceHandle: `field-${r.sourceFieldId}-right`,
        targetHandle: `field-${r.targetFieldId}-left`,
        data: { relationship: r }
      })))
    }
  }, [model, setNodes, setEdges])

  // 当 model 内的 tables/relationships 变化时，同步节点数据（不重布局）
  // - 已有节点：更新 data（保留用户拖拽的 position）
  // - 新增表：使用默认位置
  // - 删除表：移除对应节点
  useEffect(() => {
    if (!model) return
    if (prevModelId.current !== model.id) return // 已由上面的 effect 处理

    const tableMap = new Map(model.tables.map((t) => [t.id, t]))

    setNodes((nds) => {
      const existing = nds.filter((n) => tableMap.has(n.id))
      const updated = existing.map((n) => {
        const table = tableMap.get(n.id)!
        // 撤销/重做后的位置回写 React Flow 节点，使位置回退/还原生效
        const position = (table.x !== n.position.x || table.y !== n.position.y)
          ? { x: table.x, y: table.y }
          : n.position
        return { ...n, data: { table, relationships: model.relationships }, position }
      })
      const existingIds = new Set(nds.map((n) => n.id))
      const newTables = model.tables.filter((t) => !existingIds.has(t.id))
      const newNodes = newTables.map((table) => ({
        id: table.id,
        type: 'table' as const,
        position: { x: table.x || 200, y: table.y || 200 },
        data: { table, relationships: model.relationships }
      }))
      return [...updated, ...newNodes]
    })

    const relEdges: Edge<RelationshipEdgeData>[] = model.relationships.map((r) => ({
      id: r.id,
      type: 'relationship',
      source: r.sourceTableId,
      target: r.targetTableId,
      sourceHandle: `field-${r.sourceFieldId}-right`,
      targetHandle: `field-${r.targetFieldId}-left`,
      data: { relationship: r },
      selected: r.id === selectedRelationshipId
    }))
    setEdges(relEdges)
  }, [model, setNodes, setEdges, selectedRelationshipId])

  // 选中态由 React Flow 管理（支持多选），通过 onSelectionChange 同步到 store
  const onSelectionChange = useCallback(({ nodes: selNodes }: { nodes: Node[] }) => {
    const ids = selNodes.map((n) => n.id)
    setSelectedTables(ids)
  }, [setSelectedTables])

  // 外部选中变化（检查器跳转等）时同步节点选中态
  useEffect(() => {
    const idSet = new Set(selectedTableIds)
    setNodes((nds) => nds.map((n) => ({ ...n, selected: idSet.has(n.id) })))
  }, [selectedTableIds, setNodes])

  // 高亮：选中表 + 直接连接的表，以及相关关系边
  const highlightedTableIds = useMemo(() => {
    if (!selectedTableId || !model) return new Set<string>()
    const set = new Set<string>([selectedTableId])
    for (const r of model.relationships) {
      if (r.sourceTableId === selectedTableId) set.add(r.targetTableId)
      if (r.targetTableId === selectedTableId) set.add(r.sourceTableId)
    }
    return set
  }, [selectedTableId, model])

  const highlightedEdgeIds = useMemo(() => {
    if (!selectedTableId || !model) return new Set<string>()
    const set = new Set<string>()
    for (const r of model.relationships) {
      if (r.sourceTableId === selectedTableId || r.targetTableId === selectedTableId) set.add(r.id)
    }
    return set
  }, [selectedTableId, model])

  // 渲染时注入高亮标记（随选中变化自动更新）
  const renderNodes = useMemo(
    () => nodes.map((n) => ({ ...n, data: { ...n.data, highlighted: highlightedTableIds.has(n.id) } })),
    [nodes, highlightedTableIds]
  )
  const renderEdges = useMemo(
    () => edges.map((e) => ({ ...e, data: { ...e.data, highlighted: highlightedEdgeIds.has(e.id) } })),
    [edges, highlightedEdgeIds]
  )

  // 响应自动排版请求（用户点击按钮 / AI 工具增删表后）
  useEffect(() => {
    if (!layoutRequest) return
    const currentModel = useDataModelStore.getState().model
    if (!currentModel || currentModel.tables.length === 0) return
    const width = containerRef.current?.clientWidth ?? 800
    const { nodes: laidOut } = layoutTables(currentModel, width)
    setNodes(laidOut.map((l) => ({
      id: l.id,
      type: 'table',
      position: l.position,
      data: { table: currentModel.tables.find((t) => t.id === l.id)!, relationships: currentModel.relationships }
    })))
    setEdges(currentModel.relationships.map((r) => ({
      id: r.id,
      type: 'relationship',
      source: r.sourceTableId,
      target: r.targetTableId,
      sourceHandle: `field-${r.sourceFieldId}-right`,
      targetHandle: `field-${r.targetFieldId}-left`,
      data: { relationship: r }
    })))
    const raf = requestAnimationFrame(() => {
      try { fitView({ padding: 0.2, duration: 300 }) } catch { /* 节点未挂载时忽略 */ }
    })
    return () => cancelAnimationFrame(raf)
  }, [layoutRequest, setNodes, setEdges, fitView])

  // 聚焦：仅在 focusRequest 变化时执行，避免 model 变化（如拖拽节点）导致视图被拉回选中表
  useEffect(() => {
    if (!focusRequest) return
    const node = getNode(focusRequest.tableId)
    if (!node) return
    const table = (node.data as TableNodeData)?.table
    if (!table) return
    const relationships = useDataModelStore.getState().model?.relationships ?? []
    const visibleCount = getVisibleFields(table, relationships).length
    const h = table.expanded
      ? HEADER_HEIGHT + Math.max((table.fields ?? []).length * FIELD_HEIGHT, 40) + 8
      : visibleCount > 0
        ? HEADER_HEIGHT + visibleCount * FIELD_HEIGHT + 8
        : NODE_HEIGHT_COLLAPSED
    const cx = node.position.x + NODE_WIDTH / 2
    const cy = node.position.y + h / 2
    setCenter(cx, cy, { zoom: 1, duration: 400 })
  }, [focusRequest, getNode, setCenter])

  const onConnect = useCallback((conn: Connection) => {
    const sourceFieldId = conn.sourceHandle?.replace(/^field-/, '').replace(/-right$/, '')
    const targetFieldId = conn.targetHandle?.replace(/^field-/, '').replace(/-left$/, '')
    if (!sourceFieldId || !targetFieldId || !conn.source || !conn.target) return
    const rel = createRelationship({
      sourceTableId: conn.source,
      sourceFieldId,
      targetTableId: conn.target,
      targetFieldId,
      sourceCardinality: 'one',
      targetCardinality: 'many'
    })
    addRelationship(rel)
  }, [addRelationship])

  const onNodeDragStop: OnNodeDrag<Node<TableNodeData>> = useCallback((_: any, node: Node) => {
    // 批量拖拽时同步所有选中表的位置，避免其余表刷新后弹回原位
    const moved = getNodes().filter((n) => n.selected)
    if (moved.length > 1) {
      updateTablePositions(moved.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })))
    } else {
      updateTable(node.id, { x: node.position.x, y: node.position.y })
    }
  }, [getNodes, updateTable, updateTablePositions])

  const onNodeClick: NodeMouseHandler<Node<TableNodeData>> = useCallback((_: any, node: Node) => {
    // 设置检查器主选中表；多选集合由 React Flow 的 onSelectionChange 管理
    useDataModelStore.setState({ selectedTableId: node.id, selectedRelationshipId: null })
  }, [])

  const onEdgeClick = useCallback((_: any, edge: Edge) => {
    selectRelationship(edge.id)
  }, [selectRelationship])

  const onPaneClick = useCallback(() => {
    setSelectedTables([])
    selectRelationship(null)
  }, [setSelectedTables, selectRelationship])

  const onPaneContextMenu = useCallback((e: React.MouseEvent<Element, MouseEvent> | MouseEvent) => {
    e.preventDefault()
    setMenu({ type: 'pane', x: e.clientX, y: e.clientY })
  }, [])

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault()
    setMenu({ type: 'node', x: e.clientX, y: e.clientY, nodeId: node.id })
  }, [])

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault()
    setMenu({ type: 'edge', x: e.clientX, y: e.clientY, edgeId: edge.id })
  }, [])

  const handleNewTable = useCallback(() => {
    const table = createTable({ name: `table_${model?.tables.length ?? 0 + 1}` })
    addTable(table)
  }, [model, addTable])

  // 批量操作
  const handleSelectAll = useCallback(() => {
    const allIds = getNodes().map((n) => n.id)
    setNodes((nds) => nds.map((n) => ({ ...n, selected: true })))
    setSelectedTables(allIds)
  }, [getNodes, setNodes, setSelectedTables])

  const handleCollapseAll = useCallback(() => {
    const allIds = getNodes().map((n) => n.id)
    updateTables(allIds, { expanded: false })
  }, [getNodes, updateTables])

  const handleExpandAll = useCallback(() => {
    const allIds = getNodes().map((n) => n.id)
    updateTables(allIds, { expanded: true })
  }, [getNodes, updateTables])

  const handleBatchCollapse = useCallback(() => {
    updateTables(selectedTableIds, { expanded: false })
  }, [selectedTableIds, updateTables])

  const handleBatchExpand = useCallback(() => {
    updateTables(selectedTableIds, { expanded: true })
  }, [selectedTableIds, updateTables])

  const handleBatchDelete = useCallback(() => {
    removeTables(selectedTableIds)
  }, [selectedTableIds, removeTables])

  // 对齐/分布：以 React Flow 内部节点（含拖拽后的最新位置）为准，
  // 同时更新画布节点位置与 model 持久化（同步 effect 只更新 data，不覆盖 position，须在此显式 setNodes）
  const applyPositions = useCallback((positions: Array<{ id: string; x: number; y: number }>) => {
    const posMap = new Map(positions.map((p) => [p.id, p]))
    setNodes((nds) => nds.map((n) => {
      const p = posMap.get(n.id)
      return p ? { ...n, position: { x: p.x, y: p.y } } : n
    }))
    updateTablePositions(positions)
  }, [setNodes, updateTablePositions])

  const handleAlign = useCallback((mode: AlignMode) => {
    const selected = getNodes().filter((n) => n.selected)
    if (selected.length < 2) return
    applyPositions(alignPositions(
      selected.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      mode
    ))
  }, [getNodes, applyPositions])

  const handleDistribute = useCallback((mode: DistributeMode) => {
    const selected = getNodes().filter((n) => n.selected)
    if (selected.length < 3) return
    applyPositions(distributePositions(
      selected.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      mode
    ))
  }, [getNodes, applyPositions])

  // 键盘快捷键：Ctrl+Z 撤销、Ctrl+Shift+Z/Ctrl+Y 重做、Ctrl+A 全选、Delete/Backspace 删除、Escape 取消选择
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
      } else if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        handleSelectAll()
      } else if (e.key === 'Escape') {
        setSelectedTables([])
        selectRelationship(null)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const s = useDataModelStore.getState()
        if (s.selectedTableIds.length > 0) {
          e.preventDefault()
          s.removeTables(s.selectedTableIds)
        } else if (s.selectedRelationshipId) {
          e.preventDefault()
          s.removeRelationship(s.selectedRelationshipId)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSelectAll, setSelectedTables, selectRelationship, redo, undo])

  const menuItems = useMemo(() => {
    if (!menu) return []
    if (menu.type === 'pane') {
      const historyItems: any[] = []
      if (canUndo) historyItems.push({ key: 'undo', label: hostT('canvas.undo'), onClick: () => undo() })
      if (canRedo) historyItems.push({ key: 'redo', label: hostT('canvas.redo'), onClick: () => redo() })
      if (historyItems.length > 0) historyItems.push({ type: 'divider' as const, key: 'divider-hist' })
      return [
        ...historyItems,
        { key: 'new-table', label: hostT('page.newTable'), onClick: handleNewTable },
        { key: 'select-all', label: hostT('canvas.selectAll'), onClick: handleSelectAll },
        { type: 'divider' as const, key: 'divider-1' },
        { key: 'collapse-all', label: hostT('canvas.collapseAll'), onClick: handleCollapseAll },
        { key: 'expand-all', label: hostT('canvas.expandAll'), onClick: handleExpandAll },
        { type: 'divider' as const, key: 'divider-2' },
        { key: 'layout', label: hostT('page.autoLayout'), onClick: requestLayout }
      ]
    }
    if (menu.type === 'node') {
      const table = model?.tables.find((t) => t.id === menu.nodeId)
      // 右键点击的节点属于多选集合时，显示批量操作
      const isMulti = selectedTableIds.length > 1 && selectedTableIds.includes(menu.nodeId)
      if (isMulti) {
        return [
          { key: 'collapse', label: hostT('table.collapse'), onClick: handleBatchCollapse },
          { key: 'expand', label: hostT('table.expand'), onClick: handleBatchExpand },
          { key: 'delete', label: hostT('canvas.deleteSelected'), danger: true, onClick: handleBatchDelete }
        ]
      }
      return [
        { key: 'edit', label: hostT('table.edit'), onClick: () => selectTable(menu.nodeId) },
        {
          key: 'toggle', label: table?.expanded ? hostT('table.collapse') : hostT('table.expand'),
          onClick: () => table && updateTable(table.id, { expanded: !table.expanded })
        },
        { key: 'add-field', label: hostT('table.addField'), onClick: () => selectTable(menu.nodeId) },
        { key: 'delete', label: hostT('table.delete'), danger: true, onClick: () => removeTable(menu.nodeId) }
      ]
    }
    return [
      { key: 'delete', label: hostT('relationship.delete'), danger: true, onClick: () => removeRelationship(menu.edgeId) }
    ]
  }, [menu, model, handleNewTable, requestLayout, selectTable, updateTable, removeTable, removeRelationship, selectedTableIds, handleSelectAll, handleCollapseAll, handleExpandAll, handleBatchCollapse, handleBatchExpand, handleBatchDelete, canUndo, canRedo, undo, redo])

  if (!model) return null

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {selectedTableIds.length > 0 && (
        <div
          style={{
            position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
            background: 'var(--dm-bg)', border: '1px solid var(--dm-border-strong)', borderRadius: 8,
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)'
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--dm-muted)', marginRight: 4 }}>{hostT('canvas.selectedCount', { count: selectedTableIds.length })}</span>
          <Tooltip title={hostT('canvas.selectAll')}>
            <Button size="small" icon={<SelectOutlined />} onClick={handleSelectAll} />
          </Tooltip>
          <Tooltip title={hostT('table.collapse')}>
            <Button size="small" icon={<UpOutlined />} onClick={handleBatchCollapse} />
          </Tooltip>
          <Tooltip title={hostT('table.expand')}>
            <Button size="small" icon={<DownOutlined />} onClick={handleBatchExpand} />
          </Tooltip>
          <Dropdown
            menu={{
              items: [
                { key: 'align-left', icon: <AlignLeftOutlined />, label: hostT('canvas.alignLeft'), onClick: () => handleAlign('left') },
                { key: 'align-center-h', icon: <AlignCenterOutlined />, label: hostT('canvas.alignCenterH'), onClick: () => handleAlign('centerH') },
                { key: 'align-right', icon: <AlignRightOutlined />, label: hostT('canvas.alignRight'), onClick: () => handleAlign('right') },
                { type: 'divider' },
                { key: 'align-top', icon: <VerticalAlignTopOutlined />, label: hostT('canvas.alignTop'), onClick: () => handleAlign('top') },
                { key: 'align-center-v', icon: <VerticalAlignMiddleOutlined />, label: hostT('canvas.alignCenterV'), onClick: () => handleAlign('centerV') },
                { key: 'align-bottom', icon: <VerticalAlignBottomOutlined />, label: hostT('canvas.alignBottom'), onClick: () => handleAlign('bottom') },
                { type: 'divider' },
                { key: 'distribute-h', icon: <ColumnWidthOutlined />, label: hostT('canvas.distributeH'), onClick: () => handleDistribute('horizontal') },
                { key: 'distribute-v', icon: <SortAscendingOutlined />, label: hostT('canvas.distributeV'), onClick: () => handleDistribute('vertical') }
              ]
            }}
          >
            <Button size="small" icon={<AlignCenterOutlined />}>{hostT('canvas.arrange')}</Button>
          </Dropdown>
          <Popconfirm title={hostT('canvas.deleteConfirm')} onConfirm={handleBatchDelete}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      )}
      <ReactFlow
        nodes={renderNodes}
        edges={renderEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={isDark ? 'dark' : 'light'}
        fitView
        minZoom={0.05}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        selectionOnDrag
        panOnDrag={[1, 2]}
        selectionMode={SelectionMode.Partial}
        deleteKeyCode={null}
      >
        <Background gap={20} size={1} />
        <Controls />
        <MiniMap
          nodeColor={(n) => (n.data as TableNodeData)?.table?.color ?? '#71717a'}
          pannable
          zoomable
        />
      </ReactFlow>
      {model.tables.length > 0 && (
        <div
          style={{
            position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 10,
            fontSize: 11, color: 'var(--dm-muted)', background: 'var(--dm-bg)', opacity: 0.85,
            border: '1px solid var(--dm-border)', borderRadius: 6, padding: '2px 10px', pointerEvents: 'none'
          }}
        >
          {hostT('canvas.hint')}
        </div>
      )}
      <CanvasContextMenu state={menu} items={menuItems} onClose={() => setMenu(null)} />
    </div>
  )
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
