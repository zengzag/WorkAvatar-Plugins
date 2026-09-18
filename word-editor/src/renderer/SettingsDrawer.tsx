// 设置抽屉：默认模型、数据目录

import { Button, Select, App, Space, Drawer } from 'antd'
import { useWordEditorStore } from './word-editor.store'
import { hostT } from './store'

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const providers = useWordEditorStore((s) => s.providers)
  const selectedProviderId = useWordEditorStore((s) => s.selectedProviderId)
  const selectedModelId = useWordEditorStore((s) => s.selectedModelId)
  const { setSelectedProvider, setSelectedModel, saveSettings } = useWordEditorStore.getState()
  const { message } = App.useApp()
  const provider = providers.find((p) => p.id === selectedProviderId)

  return (
    <Drawer title={hostT('page.settings')} placement="right" width={320} open={open} onClose={onClose}>
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
    </Drawer>
  )
}
