// 设置抽屉：默认模型、数据目录

import { useEffect, useState } from 'react'
import { Button, Select, App, Space } from 'antd'
import { useWordEditorStore } from './word-editor.store'
import { hostT } from './store'

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const providers = useWordEditorStore((s) => s.providers)
  const selectedProviderId = useWordEditorStore((s) => s.selectedProviderId)
  const selectedModelId = useWordEditorStore((s) => s.selectedModelId)
  const { setSelectedProvider, setSelectedModel, saveSettings } = useWordEditorStore.getState()
  const { message } = App.useApp()
  const [openState, setOpenState] = useState(open)
  const provider = providers.find((p) => p.id === selectedProviderId)

  useEffect(() => { setOpenState(open) }, [open])

  return (
    <div className="we-overlay" style={{ display: openState ? 'block' : 'none' }} onClick={onClose}>
      <div className="we-drawer" style={{ width: 320, right: 0, position: 'absolute', height: '100%', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--we-border)' }}>
          <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{hostT('page.settings')}</span>
          <Button size="small" type="text" onClick={onClose}>✕</Button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <div style={{ marginBottom: 4 }}>{hostT('settings.defaultModel')}</div>
          <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
            <Select
              size="small"
              style={{ width: '50%' }}
              placeholder={hostT('settings.selectProvider')}
              value={selectedProviderId ?? undefined}
              onChange={(id) => setSelectedProvider(id)}
              options={providers.map((p) => ({ value: p.id, label: p.name || p.id }))}
            />
            <Select
              size="small"
              style={{ width: '50%' }}
              placeholder={hostT('settings.selectModel')}
              value={selectedModelId ?? undefined}
              onChange={(id) => setSelectedModel(id)}
              options={(provider?.models ?? (provider ? [provider.model] : [])).map((m: string) => ({ value: m, label: m }))}
            />
          </Space.Compact>
          <Button
            type="primary"
            size="small"
            onClick={() => {
              void (async () => {
                await saveSettings({
                  defaultProviderId: useWordEditorStore.getState().selectedProviderId ?? undefined,
                  defaultModelId: useWordEditorStore.getState().selectedModelId ?? undefined,
                })
                message.success(hostT('page.saved'))
              })()
            }}
          >
            {hostT('page.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
