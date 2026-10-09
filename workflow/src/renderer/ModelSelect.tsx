/**
 * 模型选择器（模板任务内共用）：运行对话框的「运行级模型」与节点属性的「节点级模型」复用。
 * provider/model 列表经宿主运行时全局 window.electronAPI.llm.getProviders() 获取（不在插件内 import 宿主源码）。
 */
import { useEffect, useMemo, useState } from 'react'
import { Select } from 'antd'
import { t } from './host'

const SEP = '::'

interface ProviderModel {
  id?: string
  name?: string
  model?: string
  category?: 'chat' | 'embedding'
}

interface Provider {
  id: string
  name: string
  model?: string
  models_json?: string
}

let providerCache: Provider[] | null = null
let providerLoading: Promise<Provider[]> | null = null

/** 拉取 provider 列表（进程内缓存，多个选择器共享一次请求） */
async function loadProviders(): Promise<Provider[]> {
  if (providerCache) return providerCache
  if (!providerLoading) {
    providerLoading = (async () => {
      try {
        const api = (window as { electronAPI?: { llm?: { getProviders?: () => Promise<unknown> } } }).electronAPI
        const list = await api?.llm?.getProviders?.()
        providerCache = Array.isArray(list) ? (list as Provider[]) : []
      } catch {
        providerCache = []
      }
      return providerCache
    })()
  }
  return providerLoading
}

/** 解析 provider 的对话模型列表（无 models_json 时回退默认 model） */
function chatModels(provider: Provider): ProviderModel[] {
  if (provider.models_json) {
    try {
      const parsed = JSON.parse(provider.models_json) as ProviderModel[]
      const chat = parsed.filter(m => (m.category || 'chat') === 'chat')
      if (chat.length > 0) return chat
    } catch {
      /* 解析失败回退默认模型 */
    }
  }
  return provider.model ? [{ model: provider.model, name: provider.model }] : []
}

/**
 * 读取全局默认模型（记忆场景优先、回退工作台场景），用于运行对话框预填。
 * 读取失败返回空，调用方留空即由宿主回退全局默认模型。
 */
export async function loadDefaultModel(): Promise<{ providerId: string; modelId: string }> {
  const api = (window as { electronAPI?: { settings?: { get?: (params: { key: string }) => Promise<unknown> } } }).electronAPI
  for (const key of ['default_model_memory', 'default_model_workbench']) {
    try {
      const raw = await api?.settings?.get?.({ key })
      if (typeof raw !== 'string' || !raw) continue
      const parsed = JSON.parse(raw) as { provider_id?: string; model_id?: string }
      if (parsed?.provider_id) return { providerId: parsed.provider_id, modelId: parsed.model_id || '' }
    } catch {
      /* 忽略，继续尝试下一个场景 */
    }
  }
  return { providerId: '', modelId: '' }
}

interface Props {
  providerId?: string
  modelId?: string
  onChange: (providerId: string, modelId: string) => void
  placeholder?: string
  style?: React.CSSProperties
}

export function ModelSelect({ providerId, modelId, onChange, placeholder, style }: Props) {
  const [providers, setProviders] = useState<Provider[]>(providerCache || [])

  useEffect(() => {
    if (providerCache) return
    let alive = true
    void loadProviders().then(list => { if (alive) setProviders(list) })
    return () => { alive = false }
  }, [])

  const options = useMemo(() => {
    const groups = providers
      .map(provider => ({
        label: provider.name || provider.id,
        options: chatModels(provider).map(m => {
          const value = `${provider.id}${SEP}${m.model || ''}`
          return { value, label: m.name || m.model || value }
        }),
      }))
      .filter(g => g.options.length > 0)
    // 当前值不在列表中（自定义模型 / provider 已删）时补一条，保证回显不丢
    const current = providerId && modelId ? `${providerId}${SEP}${modelId}` : ''
    if (current && !groups.some(g => g.options.some(o => o.value === current))) {
      const provider = providers.find(p => p.id === providerId)
      groups.push({ label: provider?.name || providerId || '', options: [{ value: current, label: modelId || '' }] })
    }
    return groups
  }, [providers, providerId, modelId])

  return (
    <Select
      value={providerId && modelId ? `${providerId}${SEP}${modelId}` : undefined}
      onChange={(value?: string) => {
        if (!value) { onChange('', ''); return }
        const i = value.indexOf(SEP)
        onChange(value.slice(0, i), value.slice(i + SEP.length))
      }}
      options={options}
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder={placeholder ?? t('model.defaultPlaceholder')}
      style={{ width: '100%', ...style }}
    />
  )
}
