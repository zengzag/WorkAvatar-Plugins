/**
 * image-studio 主进程入口：
 * - 设置（API Key 加密存储）/ 生成任务 / 作品库 / 本地文件操作
 * - 所有 IPC 通道经 ctx.ipc.handle 注册（宿主强制 plugin:image-studio: 前缀）
 */
import { shell } from 'electron'
import fs from 'fs'
import type { PluginContext } from '@workavatar/plugin-sdk'
import type { LlmModelOption, SettingsPatch } from '../shared/types'
import { PROVIDER_IDS } from '../shared/types'
import {
  awaitSettings,
  getApiKey,
  getProviderConfig,
  getSettings,
  initSettings,
  saveSettings,
  toPublicSettings,
} from './settings-store'
import {
  browseDirectory,
  copyImageToClipboard,
  deleteImage,
  downloadImage,
  getDataDir,
  imageCount,
  initImageStore,
  listImages,
  openDataDir,
  readImageData,
  saveImageAs,
  setFavorite,
  showImageInFolder,
  storageUsageBytes,
} from './images'
import { cancelGeneration, startGeneration } from './generator'
import { testConnection } from './providers'
import { registerImageTool } from './tools'
import { OPTIMIZE_SYSTEM_PROMPT, buildOptimizeMessage, cleanOptimizedPrompt } from './optimize'
import type { ProviderId } from '../shared/types'

export function activate(ctx: PluginContext): void {
  // 宿主 activate 不等待 Promise：设置异步加载，IPC/工具注册必须同步完成
  void initSettings(ctx)
  initImageStore(ctx)
  registerIpc(ctx)
  registerImageTool(ctx)
  ctx.services.logger.info('image-studio 插件激活完成')
}

export function deactivate(): void {
  // 无长驻资源：生成任务由 AbortController 管理，应用退出即结束
}

function registerIpc(ctx: PluginContext): void {
  const t = (key: string, params?: Record<string, string | number>) => ctx.services.i18n.t(key, params)
  const broadcast = (event: string, payload: unknown) => ctx.ipc.broadcast(event, payload)

  ctx.ipc.handle('settings-get', async () => {
    await awaitSettings()
    return toPublicSettings()
  })

  ctx.ipc.handle('settings-save', async (payload: any) => {
    await awaitSettings()
    const settings = await saveSettings((payload || {}) as SettingsPatch)
    broadcast('settings-changed', settings)
    return settings
  })

  ctx.ipc.handle('settings-test', async (payload: any) => {
    await awaitSettings()
    const provider = payload?.provider as ProviderId | undefined
    if (!provider || !PROVIDER_IDS.includes(provider)) {
      return { ok: false, message: t('errors.invalidProvider') }
    }
    const cfg = getProviderConfig(provider)
    const apiKey = payload.apiKey?.trim() || getApiKey(provider)
    if (!apiKey) return { ok: false, message: t('errors.noApiKey') }
    const baseUrl = (payload.baseUrl || cfg.baseUrl || '').trim()
    const model = (payload.model || cfg.defaultModel || '').trim()
    const outcome = await testConnection(provider, baseUrl, apiKey, model)
    if (outcome.ok) return { ok: true, message: t('settings.testSuccess') }
    const detail = outcome.detail ? ` ${outcome.detail}` : ''
    const keyMap: Record<string, string> = {
      invalidKey: 'settings.testInvalidKey',
      notFound: 'settings.testNotFound',
      network: 'settings.testNetwork',
      server: 'settings.testServer',
      unknown: 'settings.testFailed',
    }
    return { ok: false, message: `${t(keyMap[outcome.code] || 'settings.testFailed')}${detail}` }
  })

  // 宿主可用 LLM 列表（供设置中选择「优化」所用模型）
  ctx.ipc.handle('llm-models', async () => {
    const data = ctx.services.data
    if (!data) return [] as LlmModelOption[]
    try {
      const providers = ((await data.query('llmProviders')) as any[]) || []
      const options: LlmModelOption[] = []
      const seen = new Set<string>()
      for (const provider of providers) {
        const providerId = String(provider?.id || '')
        if (!providerId) continue
        const providerName = String(provider?.name || providerId)
        const models = parseChatModels(provider?.models_json)
        if (models.length === 0) {
          const fallback = String(provider?.model || '')
          if (fallback && !seen.has(`${providerId}:${fallback}`)) {
            seen.add(`${providerId}:${fallback}`)
            options.push({ providerId, providerName, modelId: fallback, modelName: fallback })
          }
          continue
        }
        for (const model of models) {
          const key = `${providerId}:${model.model}`
          if (seen.has(key)) continue
          seen.add(key)
          options.push({ providerId, providerName, modelId: model.model, modelName: model.name })
        }
      }
      return options
    } catch {
      return [] as LlmModelOption[]
    }
  })

  // 提示词优化：用宿主 LLM 把用户输入改写成可直接出图的画面描述
  ctx.ipc.handle('optimize-prompt', async (payload: any) => {
    await awaitSettings()
    const raw = String(payload?.prompt || '').trim()
    if (!raw) return { error: t('errors.emptyPrompt') }
    const execute = ctx.services.execute
    if (!execute) return { error: t('errors.optimizeUnavailable') }
    const defaults = getSettings().defaults
    try {
      const output = await execute.execute<string>({
        kind: 'llm-chat',
        providerId: defaults.optimizeProviderId || undefined,
        modelId: defaults.optimizeModelId || undefined,
        system: OPTIMIZE_SYSTEM_PROMPT,
        prompt: buildOptimizeMessage({
          prompt: raw,
          purposeLabel: typeof payload?.purposeLabel === 'string' ? payload.purposeLabel : '',
          aspect: typeof payload?.aspect === 'string' ? payload.aspect : '',
          styleLabel: typeof payload?.styleLabel === 'string' ? payload.styleLabel : '',
        }),
      })
      const optimized = cleanOptimizedPrompt(String(output ?? ''))
      if (!optimized) return { error: t('errors.optimizeFailed') }
      return { prompt: optimized }
    } catch (err: any) {
      return { error: err?.message || t('errors.optimizeFailed') }
    }
  })

  ctx.ipc.handle('list-images', (payload: any) => ({
    images: listImages(payload?.limit ?? 500),
    total: imageCount(),
    usageBytes: storageUsageBytes(),
    dataDir: getDataDir(),
  }))

  ctx.ipc.handle('generate', async (payload: any) => {
    await awaitSettings()
    const req = payload as Parameters<typeof startGeneration>[0]
    if (!req || !req.provider || !PROVIDER_IDS.includes(req.provider)) {
      return { error: t('errors.invalidProvider') }
    }
    return startGeneration(req, (progress) => broadcast('gen-progress', progress), t)
  })

  ctx.ipc.handle('cancel', (payload: any) => ({ ok: cancelGeneration(String(payload || '')) }))

  ctx.ipc.handle('toggle-favorite', (payload: any) => {
    const image = setFavorite(String(payload?.id || ''), Boolean(payload?.favorite))
    if (!image) return { error: t('errors.imageNotFound') }
    broadcast('images-changed', { type: 'favorite', id: image.id })
    return image
  })

  ctx.ipc.handle('delete-image', async (payload: any) => {
    const ok = await deleteImage(String(payload || ''))
    if (!ok) return { error: t('errors.imageNotFound') }
    broadcast('images-changed', { type: 'delete', id: payload })
    return { ok: true }
  })

  ctx.ipc.handle('save-image-as', async (payload: any) => {
    const saved = await saveImageAs(String(payload || ''))
    return { path: saved }
  })

  ctx.ipc.handle('download-image', async (payload: any) => {
    await awaitSettings()
    const dir = payload?.dir?.trim() || getSettings().defaults.downloadDir
    const saved = await downloadImage(String(payload?.id || ''), dir)
    if (!saved) return { error: t('errors.imageNotFound') }
    return { path: saved }
  })

  ctx.ipc.handle('copy-image', async (payload: any) => {
    try {
      const ok = await copyImageToClipboard(String(payload || ''))
      return ok ? { ok: true } : { error: t('errors.copyFailed') }
    } catch {
      return { error: t('errors.copyFailed') }
    }
  })

  ctx.ipc.handle('show-in-folder', (payload: any) => {
    const ok = showImageInFolder(String(payload || ''))
    return ok ? { ok: true } : { error: t('errors.imageNotFound') }
  })

  ctx.ipc.handle('read-image-data', (payload: any) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    const full = typeof payload === 'object' && Boolean(payload?.full)
    const dataUrl = readImageData(String(id || ''), { full })
    return dataUrl ? { dataUrl } : { error: t('errors.imageNotFound') }
  })

  ctx.ipc.handle('pick-download-dir', async (payload: any) => ({ path: await browseDirectory(payload) }))

  ctx.ipc.handle('open-download-dir', async (payload: any) => {
    await awaitSettings()
    const target = payload?.trim() || getSettings().defaults.downloadDir
    if (!target) return { error: t('settings.downloadDirEmpty') }
    fs.mkdirSync(target, { recursive: true })
    await shell.openPath(target)
    return { ok: true }
  })

  ctx.ipc.handle('open-data-dir', async () => {
    await openDataDir()
    return { ok: true }
  })
}

/** 解析宿主供应商 models_json 中的对话模型（跳过 embedding 等非对话模型） */
function parseChatModels(raw: unknown): Array<{ name: string; model: string }> {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter((item: any) => item && typeof item === 'object' && (item.category || 'chat') === 'chat' && item.model)
      .map((item: any) => ({ name: String(item.name || item.model), model: String(item.model) }))
  } catch {
    return []
  }
}
