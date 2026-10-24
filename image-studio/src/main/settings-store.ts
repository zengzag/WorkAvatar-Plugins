/**
 * 设置读写：存于插件作用域 KV（plugin-data/image-studio/index.db）。
 * API Key 经 Electron safeStorage 加密后落库，任何返回给渲染端的结构都只含掩码。
 */
import { safeStorage } from 'electron'
import type { PluginContext } from '@workavatar/plugin-sdk'
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  PROVIDER_IDS,
  PURPOSE_IDS,
  type ProviderId,
  type PublicSettings,
  type SettingsPatch,
  type StudioSettings,
} from '../shared/types'

const SETTINGS_KEY = 'studio_settings'

let ctxRef: PluginContext | null = null
let cache: StudioSettings | null = null
/** 设置异步加载完成信号：宿主 activate 不等待 Promise，IPC/工具须先等它 */
let readyPromise: Promise<void> | null = null

function cloneDefaults(): StudioSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as StudioSettings
}

function encryptSecret(raw: string): string {
  if (!raw) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(raw).toString('base64')}`
    }
  } catch { /* 系统密钥环不可用时回退本地编码 */ }
  return `b64:${Buffer.from(raw, 'utf8').toString('base64')}`
}

function decryptSecret(value: string): string {
  if (!value) return ''
  try {
    if (value.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
    }
    if (value.startsWith('b64:')) {
      return Buffer.from(value.slice(4), 'base64').toString('utf8')
    }
  } catch {
    return ''
  }
  return value
}

function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 3)}••••••••${key.slice(-4)}`
}

function mergeSettings(raw: unknown): StudioSettings {
  const base = cloneDefaults()
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Partial<StudioSettings>
  for (const id of PROVIDER_IDS) {
    const saved = data.providers?.[id]
    if (saved) {
      base.providers[id] = {
        apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
        baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl ? saved.baseUrl : base.providers[id].baseUrl,
        defaultModel:
          typeof saved.defaultModel === 'string' && saved.defaultModel
            ? saved.defaultModel
            : base.providers[id].defaultModel,
      }
    }
  }
  if (data.defaults) {
    base.defaults = { ...base.defaults, ...data.defaults }
    if (!PROVIDER_IDS.includes(base.defaults.provider)) base.defaults.provider = DEFAULT_SETTINGS.defaults.provider
    if (!PURPOSE_IDS.includes(base.defaults.purpose)) base.defaults.purpose = DEFAULT_SETTINGS.defaults.purpose
    if (!['low', 'medium', 'high', 'auto'].includes(base.defaults.quality)) {
      base.defaults.quality = DEFAULT_SETTINGS.defaults.quality
    }
    if (base.defaults.toolProvider && !PROVIDER_IDS.includes(base.defaults.toolProvider)) {
      base.defaults.toolProvider = ''
    }
    if (typeof base.defaults.toolModel !== 'string') base.defaults.toolModel = ''
  }
  return base
}

export function initSettings(ctx: PluginContext): Promise<void> {
  ctxRef = ctx
  readyPromise = (async () => {
    try {
      const raw = await ctx.storage.get<StudioSettings>(SETTINGS_KEY)
      cache = mergeSettings(raw)
    } catch {
      cache = cloneDefaults()
    }
  })()
  return readyPromise
}

/** 等待设置加载完成（宿主不 await activate，所有依赖设置的入口需先调用） */
export async function awaitSettings(): Promise<void> {
  if (readyPromise) await readyPromise
}

export function getSettings(): StudioSettings {
  return cache ?? cloneDefaults()
}

/** 内部使用：解密后的 API Key（绝不外传渲染端） */
export function getApiKey(provider: ProviderId): string {
  return decryptSecret(getSettings().providers[provider].apiKey)
}

export function getProviderConfig(provider: ProviderId) {
  return getSettings().providers[provider]
}

/** 生图工具使用的模型：工具设置优先，未设置时跟随默认服务商及其默认模型 */
export function getToolModel(): { provider: ProviderId; model: string } {
  const settings = getSettings()
  const provider = settings.defaults.toolProvider || settings.defaults.provider
  return { provider, model: settings.defaults.toolModel || settings.providers[provider].defaultModel }
}

export function toPublicSettings(): PublicSettings {
  const settings = getSettings()
  const providers = {} as PublicSettings['providers']
  for (const id of PROVIDER_IDS) {
    const cfg = settings.providers[id]
    const key = decryptSecret(cfg.apiKey)
    providers[id] = {
      id,
      baseUrl: cfg.baseUrl,
      defaultModel: cfg.defaultModel,
      hasKey: Boolean(key),
      keyMask: maskKey(key),
    }
  }
  return { providers, defaults: settings.defaults }
}

export async function saveSettings(patch: SettingsPatch): Promise<PublicSettings> {
  const next = getSettings()
  if (patch.providers) {
    for (const id of PROVIDER_IDS) {
      const incoming = patch.providers[id]
      if (!incoming) continue
      const current = next.providers[id]
      next.providers[id] = {
        apiKey:
          incoming.apiKey === undefined
            ? current.apiKey
            : incoming.apiKey === ''
              ? ''
              : encryptSecret(incoming.apiKey.trim()),
        baseUrl: (incoming.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, '') || PROVIDERS[id].defaultBaseUrl,
        defaultModel: (incoming.defaultModel ?? current.defaultModel).trim() || PROVIDERS[id].defaultModel,
      }
    }
  }
  if (patch.defaults) {
    next.defaults = { ...next.defaults, ...patch.defaults }
    if (!PROVIDER_IDS.includes(next.defaults.provider)) next.defaults.provider = DEFAULT_SETTINGS.defaults.provider
    if (!PURPOSE_IDS.includes(next.defaults.purpose)) next.defaults.purpose = DEFAULT_SETTINGS.defaults.purpose
    if (!['low', 'medium', 'high', 'auto'].includes(next.defaults.quality)) {
      next.defaults.quality = DEFAULT_SETTINGS.defaults.quality
    }
    if (next.defaults.toolProvider && !PROVIDER_IDS.includes(next.defaults.toolProvider)) {
      next.defaults.toolProvider = ''
    }
    next.defaults.toolModel = typeof next.defaults.toolModel === 'string' ? next.defaults.toolModel.trim() : ''
    next.defaults.count = Math.min(6, Math.max(1, Math.round(next.defaults.count || 1)))
    next.defaults.maxImages = Math.min(15, Math.max(1, Math.round(next.defaults.maxImages || 1)))
    next.defaults.tier = ['1K', '2K', '3K', '4K'].includes(next.defaults.tier)
      ? next.defaults.tier
      : DEFAULT_SETTINGS.defaults.tier
  }
  cache = next
  if (ctxRef) {
    await ctxRef.storage.set(SETTINGS_KEY, next)
  }
  return toPublicSettings()
}
