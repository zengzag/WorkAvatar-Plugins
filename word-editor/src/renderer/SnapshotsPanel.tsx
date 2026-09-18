// 版本历史抽屉

import { useEffect } from 'react'
import { Button, Empty, App } from 'antd'
import { DeleteOutlined, RollbackOutlined } from '@ant-design/icons'
import { useWordEditorStore } from './word-editor.store'
import { hostT } from './store'

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function SnapshotsPanel({ onClose }: { onClose: () => void }) {
  const snapshots = useWordEditorStore((s) => s.snapshots)
  const { loadSnapshots, restoreSnapshot, deleteSnapshot } = useWordEditorStore.getState()
  const { message } = App.useApp()

  useEffect(() => { void loadSnapshots() }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--we-border)' }}>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{hostT('page.history')}</span>
        <Button size="small" type="text" onClick={onClose}>✕</Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {snapshots.length === 0 ? (
          <Empty description={hostT('page.historyEmpty')} style={{ marginTop: 40 }} />
        ) : (
          snapshots.map((snap) => (
            <div key={snap.id} className="we-snapshot-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>{snap.label || hostT('page.history')}</div>
                <div style={{ fontSize: 12, color: 'var(--we-muted)' }}>{formatTime(snap.createdAt)}</div>
              </div>
              <Button
                size="small"
                icon={<RollbackOutlined />}
                onClick={() => {
                  void (async () => {
                    await useWordEditorStore.getState().restoreSnapshot(snap.id)
                    message.success(hostT('page.restored'))
                  })()
                }}
              >
                {hostT('page.historyRestore')}
              </Button>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => void deleteSnapshot(snap.id)} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}
