// word-editor 主页面：顶部工具栏 + 编辑器画布 + AI 对话抽屉 + 版本历史

import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Dropdown, Input, Modal, Popconfirm, Select, Tooltip } from 'antd'
import {
  PlusOutlined, ImportOutlined, ExportOutlined, SettingOutlined,
  EditOutlined, SaveOutlined, RocketOutlined, HistoryOutlined,
  FileWordOutlined, FilePdfOutlined, DeleteOutlined, DownloadOutlined, UploadOutlined,
} from '@ant-design/icons'
import { useWordEditorStore, type SaveState } from './word-editor.store'
import { EditorCanvas } from './EditorCanvas'
import { AiChatPanel } from './AiChatPanel'
import { SnapshotsPanel } from './SnapshotsPanel'
import { SettingsDrawer } from './SettingsDrawer'
import { we, hostT } from './store'

export function WordEditorPage() {
  const docs = useWordEditorStore((s) => s.docs)
  const doc = useWordEditorStore((s) => s.doc)
  const saveState: SaveState = useWordEditorStore((s) => s.saveState)
  const aiPanelOpen = useWordEditorStore((s) => s.aiPanelOpen)
  const settingsOpen = useWordEditorStore((s) => s.settingsOpen)
  const { message } = App.useApp()

  const [newDocOpen, setNewDocOpen] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  const editorHandleRef = useRef<{ getHtml: () => string } | null>(null)
  const remoteCbRef = useRef<((html: string, source: string) => void) | null>(null)

  const handleReady = useCallback((handle: { getHtml: () => string }) => {
    editorHandleRef.current = handle
  }, [])

  const handleRemoteRegister = useCallback((cb: (html: string, source: string) => void) => {
    remoteCbRef.current = cb
  }, [])

  // 初始化
  useEffect(() => {
    void (async () => {
      await useWordEditorStore.getState().loadDocs()
      await useWordEditorStore.getState().loadProviders()
    })()
  }, [])

  // 订阅远程文档变更（AI 工具 / 快照恢复）
  useEffect(() => {
    const unsub = we.onDocChanged(({ doc: remote }) => {
      void useWordEditorStore.getState().loadDocs()
      remoteCbRef.current?.(remote.html, remote.id)
    })
    const unsub2 = we.onDocListChanged(() => void useWordEditorStore.getState().loadDocs())
    const unsub3 = we.onMetaChanged(() => void useWordEditorStore.getState().loadProviders())
    return () => {
      unsub(); unsub2(); unsub3()
    }
  }, [])

  // Ctrl+S 手动保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void (async () => {
          await useWordEditorStore.getState().flushSave()
          message.success(hostT('page.saved'))
        })()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

  // 消费 FileViewerModal "编辑文档"跳转携带的 ?import=<path>
  useEffect(() => {
    const hash = typeof window !== 'undefined' ? window.location.hash : ''
    const qIndex = hash.indexOf('?')
    if (qIndex === -1) return
    const params = new URLSearchParams(hash.slice(qIndex + 1))
    const importPath = params.get('import')
    if (!importPath) return
    // 清除 query（防刷新重复导入）
    window.location.hash = hash.slice(0, qIndex)
    void (async () => {
      const err = await useWordEditorStore.getState().importDoc(importPath)
      if (err) message.error(err)
      else message.success(hostT('page.imported'))
    })()
  }, [])

  const handleExportDocx = async () => {
    if (!editorHandleRef.current || !doc) return
    const err = await useWordEditorStore.getState().exportDocx(editorHandleRef.current.getHtml())
    if (err) message.error(hostT('page.exportFail', { message: err }))
    else message.success(hostT('page.exportOk'))
  }

  const handleExportPdf = async () => {
    if (!editorHandleRef.current || !doc) return
    const err = await useWordEditorStore.getState().exportPdf(editorHandleRef.current.getHtml())
    if (err) message.error(hostT('page.exportFail', { message: err }))
    else message.success(hostT('page.exportOk'))
  }

  const handleRename = async () => {
    if (!doc) return
    await useWordEditorStore.getState().renameDoc(doc.id, renameName.trim() || doc.title)
    setRenameOpen(false)
  }

  const handleChangeDoc = (id: string) => {
    if (id === doc?.id) return
    const open = () => void useWordEditorStore.getState().openDoc(id)
    if (saveState !== 'saved') {
      Modal.confirm({
        title: hostT('page.unsavedTitle'),
        content: hostT('page.unsavedDesc'),
        okText: hostT('page.saveAndOpen'),
        cancelText: hostT('page.discard'),
        onOk: async () => {
          await useWordEditorStore.getState().flushSave()
          open()
        },
        onCancel: () => open(),
      })
    } else {
      open()
    }
  }

  const docSelector = (
    <Select
      size="small"
      style={{ width: 200 }}
      value={doc?.id}
      onChange={handleChangeDoc}
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

  if (!doc) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--we-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--we-border)' }}>
          {docSelector}
          <div style={{ flex: 1 }} />
          <Button size="small" icon={<SettingOutlined />} onClick={() => useWordEditorStore.getState().setSettingsOpen(true)} />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--we-muted)' }}>
          <FileWordOutlined style={{ fontSize: 48, opacity: 0.4 }} />
          <div>{hostT('page.empty.desc')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewDocOpen(true)}>{hostT('page.newDoc')}</Button>
            <Button icon={<ImportOutlined />} loading={importing} onClick={() => void handleImport()}>{hostT('page.import')}</Button>
          </div>
        </div>

        <NewDocModal
          open={newDocOpen}
          name={newDocName}
          onNameChange={setNewDocName}
          onOk={() => void handleCreate()}
          onCancel={() => setNewDocOpen(false)}
        />
        <SettingsDrawer open={settingsOpen} onClose={() => useWordEditorStore.getState().setSettingsOpen(false)} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--we-bg)' }}>
      {/* 工具栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--we-border)' }}>
        {docSelector}
        <Tooltip title={hostT('page.save')}>
          <Button size="small" icon={<SaveOutlined />} onClick={() => {
            void (async () => {
              await useWordEditorStore.getState().flushSave()
              message.success(hostT('page.saved'))
            })()
          }}>
            {saveState !== 'saved' && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, display: 'inline-block' }} />
            )}
          </Button>
        </Tooltip>
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<HistoryOutlined />} onClick={() => { setHistoryOpen(true) }}>
          {hostT('page.history')}
        </Button>
        <Button size="small" icon={<RocketOutlined />} onClick={() => useWordEditorStore.getState().toggleAiPanel()}>
          {hostT('page.ai')}
        </Button>
        <Dropdown
          menu={{
            items: [
              { key: 'docx', icon: <DownloadOutlined />, label: hostT('page.exportDocx'), onClick: () => void handleExportDocx() },
              { key: 'pdf', icon: <FilePdfOutlined />, label: hostT('page.exportPdf'), onClick: () => void handleExportPdf() },
              { type: 'divider' },
              { key: 'import', icon: <UploadOutlined />, label: hostT('page.import'), onClick: () => void handleImport() },
            ],
          }}
        >
          <Button size="small" icon={<ExportOutlined />}>{hostT('page.export')}</Button>
        </Dropdown>
        <Button size="small" icon={<SettingOutlined />} onClick={() => useWordEditorStore.getState().setSettingsOpen(true)} />
      </div>

      {/* 主区 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {doc && (
            <EditorCanvas
              key={doc.id}
              docId={doc.id}
              initialHtml={doc.html}
              onReady={handleReady}
              onRemoteHtml={handleRemoteRegister}
            />
          )}
        </div>
        {aiPanelOpen && (
          <div
            style={{
              width: 400, flexShrink: 0, borderLeft: '1px solid var(--we-border)',
              background: 'var(--we-bg)', display: 'flex', flexDirection: 'column'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--we-border)' }}>
              <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{hostT('page.ai')}</span>
              <Button size="small" type="text" onClick={() => useWordEditorStore.getState().toggleAiPanel(false)}>{hostT('page.cancel')}</Button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <AiChatPanel />
            </div>
          </div>
        )}

        {historyOpen && (
          <div
            style={{
              width: 340, flexShrink: 0, borderLeft: '1px solid var(--we-border)',
              background: 'var(--we-bg)', display: 'flex', flexDirection: 'column'
            }}
          >
            <SnapshotsPanel onClose={() => setHistoryOpen(false)} />
          </div>
        )}
      </div>

      <NewDocModal
        open={newDocOpen}
        name={newDocName}
        onNameChange={setNewDocName}
        onOk={() => void handleCreate()}
        onCancel={() => setNewDocOpen(false)}
      />

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

function NewDocModal(props: {
  open: boolean
  name: string
  onNameChange: (v: string) => void
  onOk: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title={hostT('page.newDoc')}
      open={props.open}
      onOk={props.onOk}
      onCancel={props.onCancel}
      okText={hostT('page.create')}
      cancelText={hostT('page.cancel')}
    >
      <Input
        placeholder={hostT('page.docName')}
        value={props.name}
        onChange={(e) => props.onNameChange(e.target.value)}
        onPressEnter={props.onOk}
      />
    </Modal>
  )
}
