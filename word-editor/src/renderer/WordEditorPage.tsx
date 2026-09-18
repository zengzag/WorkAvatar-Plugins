// word-editor 主页面：顶栏文档操作 + wordcanvas 编辑器 + AI 对话抽屉 + 版本历史

import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Dropdown, Input, Modal, Popconfirm, Select, Tooltip } from 'antd'
import {
  PlusOutlined, ImportOutlined, ExportOutlined, SettingOutlined,
  EditOutlined, SaveOutlined, RocketOutlined, HistoryOutlined,
  FileWordOutlined, FilePdfOutlined, DeleteOutlined, DownloadOutlined,
} from '@ant-design/icons'
import { useWordEditorStore, registerEditorBridge, type EditorBridge } from './word-editor.store'
import { WordCanvasHost } from './WordCanvasHost'
import { AiChatPanel } from './AiChatPanel'
import { SnapshotsPanel } from './SnapshotsPanel'
import { SettingsDrawer } from './SettingsDrawer'
import { we, hostT } from './store'

export function WordEditorPage() {
  const docs = useWordEditorStore((s) => s.docs)
  const doc = useWordEditorStore((s) => s.doc)
  const dirty = useWordEditorStore((s) => s.dirty)
  const saving = useWordEditorStore((s) => s.saving)
  const aiPanelOpen = useWordEditorStore((s) => s.aiPanelOpen)
  const settingsOpen = useWordEditorStore((s) => s.settingsOpen)
  const { message } = App.useApp()

  const bridgeRef = useRef<EditorBridge | null>(null)
  const remoteRef = useRef<(data: string) => void>(() => {})
  const syncedDocIdRef = useRef<string | null>(null)
  const initDataRef = useRef('')
  const pendingImportRef = useRef<string | null>(null)

  const [booted, setBooted] = useState(false)
  const [newDocOpen, setNewDocOpen] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  // 编辑器就绪：注册桥，处理挂起的导入
  const handleReady = useCallback((bridge: EditorBridge) => {
    bridgeRef.current = bridge
    registerEditorBridge(bridge)
    const pending = pendingImportRef.current
    if (pending !== null) {
      pendingImportRef.current = null
      void (async () => {
        const err = await useWordEditorStore.getState().importDoc(pending || undefined)
        if (err) message.error(err)
        else message.success(hostT('page.imported'))
      })()
    }
  }, [message])

  const handleRemoteRegister = useCallback((cb: (data: string) => void) => {
    remoteRef.current = cb
  }, [])

  // 初始化：加载文档列表与模型供应商，确定初始文档
  useEffect(() => {
    void (async () => {
      const store = useWordEditorStore.getState()
      await store.loadDocs()
      await store.loadProviders()
      const first = useWordEditorStore.getState().docs[0]
      if (first) {
        const res = await we.openDoc(first.id)
        if ('doc' in res && res.doc) useWordEditorStore.getState().applyDoc(res.doc)
      }
      initDataRef.current = useWordEditorStore.getState().doc?.data ?? ''
      setBooted(true)
    })()
  }, [])

  // 文档切换：同步编辑器内容
  useEffect(() => {
    if (!booted || !doc) return
    if (syncedDocIdRef.current === doc.id) return
    syncedDocIdRef.current = doc.id
    if (bridgeRef.current) {
      bridgeRef.current.setDocument(doc.data)
      registerEditorBridge(bridgeRef.current)
    }
  }, [booted, doc?.id])

  // 订阅主进程事件（快照恢复 / 列表刷新 / 供应商变化）
  useEffect(() => {
    const unsub = we.onDocChanged(({ doc: remote }) => {
      remoteRef.current(remote.data)
      const cur = useWordEditorStore.getState().doc
      if (cur && cur.id === remote.id) {
        useWordEditorStore.setState({ doc: { ...cur, data: remote.data }, dirty: false })
      }
    })
    const unsub2 = we.onDocListChanged(() => void useWordEditorStore.getState().loadDocs())
    const unsub3 = we.onMetaChanged(() => void useWordEditorStore.getState().loadProviders())
    return () => {
      unsub(); unsub2(); unsub3()
    }
  }, [])

  // 消费 FileViewerModal "编辑文档"跳转携带的 ?import=<path>
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : ''
    const qIndex = hash.indexOf('?')
    if (qIndex === -1) return
    const params = new URLSearchParams(hash.slice(qIndex + 1))
    const importPath = params.get('import')
    if (!importPath) return
    window.location.hash = hash.slice(0, qIndex)
    pendingImportRef.current = importPath
    if (bridgeRef.current) {
      pendingImportRef.current = null
      void (async () => {
        const err = await useWordEditorStore.getState().importDoc(importPath)
        if (err) message.error(err)
        else message.success(hostT('page.imported'))
      })()
    }
  }, [message])

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const store = useWordEditorStore.getState()
        if (!store.doc) return
        void (async () => {
          await store.flushSave()
          message.success(hostT('page.saved'))
        })()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [message])

  const handleSave = async () => {
    if (!doc) return
    await useWordEditorStore.getState().flushSave()
    message.success(hostT('page.saved'))
  }

  const handleCreate = async () => {
    await useWordEditorStore.getState().createDoc(newDocName.trim() || undefined)
    setNewDocOpen(false)
    setNewDocName('')
  }

  const handleImport = async () => {
    setImporting(true)
    try {
      const err = await useWordEditorStore.getState().importDoc()
      if (err) message.error(err)
      else message.success(hostT('page.imported'))
    } finally {
      setImporting(false)
    }
  }

  const handleExport = async (format: 'docx' | 'pdf') => {
    if (!doc) return
    const err = await useWordEditorStore.getState().exportDoc(format)
    if (err) message.error(hostT('page.exportFail', { message: err }))
    else message.success(hostT('page.exportOk'))
  }

  const handleRename = async () => {
    if (!doc) return
    await useWordEditorStore.getState().renameDoc(doc.id, renameName.trim() || doc.title)
    setRenameOpen(false)
    message.success(hostT('page.renamed'))
  }

  const handleToolbarExport = useCallback((bytes: Uint8Array, format: 'docx' | 'pdf') => {
    void (async () => {
      const title = useWordEditorStore.getState().doc?.title || 'document'
      const res = await we.exportSave(bytes, format, title)
      if (res?.error) message.error(hostT('page.exportFail', { message: res.error }))
      else if (res?.ok) message.success(hostT('page.exportOk'))
    })()
  }, [message])

  const docSelector = (
    <Select
      size="small"
      style={{ width: 200 }}
      value={doc?.id}
      onChange={(id) => void useWordEditorStore.getState().openDoc(id)}
      placeholder={hostT('page.title')}
      options={docs.map((d) => ({ value: d.id, label: d.title }))}
      popupRender={(menu) => (
        <>
          {menu}
          <div style={{ padding: 8, borderTop: '1px solid var(--we-border)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Button size="small" block icon={<PlusOutlined />} onClick={() => setNewDocOpen(true)}>
              {hostT('page.newDoc')}
            </Button>
            <Button size="small" block icon={<ImportOutlined />} loading={importing} onClick={() => void handleImport()}>
              {hostT('page.import')}
            </Button>
            {doc && (
              <>
                <Button size="small" block icon={<EditOutlined />} onClick={() => { setRenameName(doc.title); setRenameOpen(true) }}>
                  {hostT('page.rename')}
                </Button>
                <Popconfirm
                  title={hostT('page.deleteConfirm')}
                  onConfirm={() => { if (doc) void useWordEditorStore.getState().deleteDoc(doc.id) }}
                >
                  <Button size="small" block danger icon={<DeleteOutlined />}>
                    {hostT('page.delete')}
                  </Button>
                </Popconfirm>
              </>
            )}
          </div>
        </>
      )}
    />
  )

  return (
    <div className="we-page-root">
      {/* 顶栏：文档级操作（编辑器自带 Ribbon 负责排版） */}
      <div className="we-topbar">
        {docSelector}
        <Tooltip title={hostT('page.save')}>
          <Button size="small" icon={<SaveOutlined />} loading={saving} disabled={!doc} onClick={() => void handleSave()}>
            {dirty && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, display: 'inline-block' }} />
            )}
          </Button>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<HistoryOutlined />} disabled={!doc} onClick={() => setHistoryOpen(true)}>
          {hostT('page.history')}
        </Button>
        <Button size="small" icon={<RocketOutlined />} onClick={() => useWordEditorStore.getState().toggleAiPanel()}>
          {hostT('page.ai')}
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: 'docx', icon: <FileWordOutlined />, label: hostT('page.exportDocx'), onClick: () => void handleExport('docx') },
              { key: 'pdf', icon: <FilePdfOutlined />, label: hostT('page.exportPdf'), onClick: () => void handleExport('pdf') },
              { type: 'divider' },
              { key: 'import', icon: <DownloadOutlined />, label: hostT('page.import'), onClick: () => void handleImport() },
            ],
          }}
        >
          <Button size="small" icon={<ExportOutlined />} disabled={!doc}>{hostT('page.export')}</Button>
        </Dropdown>
        <Button size="small" icon={<SettingOutlined />} onClick={() => useWordEditorStore.getState().setSettingsOpen(true)} />
      </div>

      {/* 主区 */}
      <div className="we-main">
        <div className="we-editor-area">
          {booted && (
            <WordCanvasHost
              initialData={initDataRef.current}
              onReady={handleReady}
              onRemoteData={handleRemoteRegister}
              onToolbarExport={handleToolbarExport}
            />
          )}
          {booted && !doc && (
            <div className="we-empty">
              <FileWordOutlined style={{ fontSize: 48, opacity: 0.4 }} />
              <div>{hostT('page.empty.desc')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewDocOpen(true)}>{hostT('page.newDoc')}</Button>
                <Button icon={<ImportOutlined />} loading={importing} onClick={() => void handleImport()}>{hostT('page.import')}</Button>
              </div>
            </div>
          )}
        </div>

        {aiPanelOpen && (
          <div className="we-side-panel" style={{ width: 400 }}>
            <div className="we-side-header">
              <span className="we-side-title">{hostT('page.ai')}</span>
              <Button size="small" type="text" onClick={() => useWordEditorStore.getState().toggleAiPanel(false)}>{hostT('page.cancel')}</Button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <AiChatPanel />
            </div>
          </div>
        )}

        {historyOpen && (
          <div className="we-side-panel" style={{ width: 340 }}>
            <SnapshotsPanel onClose={() => setHistoryOpen(false)} />
          </div>
        )}
      </div>

      <Modal
        title={hostT('page.newDoc')}
        open={newDocOpen}
        onOk={() => void handleCreate()}
        onCancel={() => setNewDocOpen(false)}
        okText={hostT('page.create')}
        cancelText={hostT('page.cancel')}
      >
        <Input
          placeholder={hostT('page.docName')}
          value={newDocName}
          onChange={(e) => setNewDocName(e.target.value)}
          onPressEnter={() => void handleCreate()}
        />
      </Modal>

      <Modal
        title={hostT('page.renameTitle')}
        open={renameOpen}
        onOk={() => void handleRename()}
        onCancel={() => setRenameOpen(false)}
        okText={hostT('page.rename')}
        cancelText={hostT('page.cancel')}
      >
        <Input
          placeholder={hostT('page.docName')}
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onPressEnter={() => void handleRename()}
        />
      </Modal>

      <SettingsDrawer open={settingsOpen} onClose={() => useWordEditorStore.getState().setSettingsOpen(false)} />
    </div>
  )
}
