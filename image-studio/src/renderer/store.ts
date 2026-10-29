/**
 * 渲染端共享状态：宿主桥 / 设置 / 生成任务 / 作品列表 / 编辑器草稿。
 * 轻量自管理 store（useSyncExternalStore），不引入第三方状态库。
 */
import { useSyncExternalStore } from 'react'
import type { PluginBridge, PluginHostCapabilities } from '@workavatar/plugin-sdk/renderer'
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  PROVIDER_IDS,
  PURPOSE_IDS,
  PURPOSE_PRESETS,
  getModelSpec,
  getSupportedAspects,
  normalizeTier,
  type AspectRatio,
  type DefaultsSettings,
  type DensityId,
  type GenerateRequest,
  type GeneratedImage,
  type JobProgress,
  type LlmModelOption,
  type OptimizeMode,
  type PaletteId,
  type PromptExtendMode,
  type ProviderId,
  type PublicSettings,
  type PurposeId,
  type QualityTier,
  type ResolutionTier,
  type SettingsPatch,
  type TextLanguage,
  type TextSpace,
} from '../shared/types'

// ====== 宿主注入 ======

let bridge: PluginBridge | null = null
let hostI18n: ((key: string, options?: Record<string, unknown>) => string) | null = null
let hostCaps: PluginHostCapabilities | undefined

export function setBridge(value: PluginBridge): void {
  bridge = value
}
export function setHostI18n(value: (key: string, options?: Record<string, unknown>) => string): void {
  hostI18n = value
}
export function setHostCapabilities(value?: PluginHostCapabilities): void {
  hostCaps = value
}

export function t(key: string, params?: Record<string, string | number>): string {
  if (!hostI18n) return key
  return hostI18n(key, params as Record<string, unknown> | undefined)
}

/** 模型描述按当前语言解析，未提供时回退共享表 */
export function modelDesc(provider: ProviderId, modelId: string): string {
  // i18n key 按 . 分段解析，模型 ID 含点号（如 qwen-image-2.1-turbo）需替换后再查
  const key = `modelDesc.${modelId.replace(/\./g, '_')}`
  const localized = t(key)
  if (localized && localized !== key) return localized
  return getModelSpec(provider, modelId).desc
}

export function providerLabel(provider: ProviderId): string {
  if (provider === 'volcengine') return t('providerShortVolcengine')
  if (provider === 'qwen') return t('providerShortQwen')
  return t('providerShortOpenai')
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('bridge not ready'))
  return bridge.invoke<T>(channel, payload)
}

export function appLocale(): string {
  return document.documentElement.getAttribute('data-locale') || 'zh-CN'
}

export function toFileUrl(filePath: string): string {
  if (!filePath) return ''
  if (/^(https?:|data:|blob:)/i.test(filePath)) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((seg, index) => {
      const value = encodeURIComponent(seg)
      return index === 0 ? value.replace(/%3A/i, ':') : value
    })
    .join('/')
  return `app-file:///${encoded}`
}

// ====== 状态 ======

export interface RefImage {
  id: string
  dataUrl: string
  name: string
}

export interface ComposerState {
  provider: ProviderId
  model: string
  purpose: PurposeId
  prompt: string
  negativePrompt: string
  styleKey: string
  palette: PaletteId
  density: DensityId
  textSpace: TextSpace
  noText: boolean
  titleEnabled: boolean
  title: string
  subtitle: string
  textLanguage: TextLanguage
  aspect: AspectRatio
  tier: ResolutionTier
  count: number
  seed: number | null
  watermark: boolean
  promptExtend: boolean
  promptExtendMode: PromptExtendMode
  optimizeMode: OptimizeMode
  sequential: boolean
  maxImages: number
  customSizeEnabled: boolean
  customSize: string
  transparent: boolean
  quality: QualityTier
  references: RefImage[]
}

export interface JobView {
  jobId: string
  stage: JobProgress['stage']
  total: number
  completed: number
  elapsedMs: number
  startedAt: number
  provider: ProviderId
  model: string
  error?: string
}

export interface Notice {
  type: 'error' | 'warning' | 'success'
  message: string
}

export interface StudioState {
  ready: boolean
  settings: PublicSettings | null
  /** 宿主可用 LLM（提示词优化可选模型） */
  llmModels: LlmModelOption[]
  images: GeneratedImage[]
  total: number
  usageBytes: number
  dataDir: string
  /** 并行运行中的任务（LLM 工具调用可能与面板生成同时进行） */
  jobs: JobView[]
  /** 生成面板自己发起的任务，用于展示进度与取消 */
  activeJobId: string | null
  notice: Notice | null
  previewId: string | null
  filter: 'all' | 'favorite'
  purposeFilter: PurposeId | 'all'
  search: string
  sort: 'new' | 'old'
  columns: number
  settingsOpen: boolean
  settingsTab: string
  settingsProvider: ProviderId
  composer: ComposerState
}

const DRAFT_KEY = 'image-studio.draft'

function defaultsFromSettings(settings?: PublicSettings | null): DefaultsSettings {
  return { ...DEFAULT_SETTINGS.defaults, ...(settings?.defaults ?? {}) }
}

function baseComposer(settings?: PublicSettings | null): ComposerState {
  const defaults = defaultsFromSettings(settings)
  const provider = defaults.provider
  const model = settings?.providers[provider]?.defaultModel || PROVIDERS[provider].defaultModel
  const spec = getModelSpec(provider, model)
  const purpose = PURPOSE_IDS.includes(defaults.purpose) ? defaults.purpose : DEFAULT_SETTINGS.defaults.purpose
  const preset = PURPOSE_PRESETS[purpose]
  const supported = getSupportedAspects(provider, model)
  const aspect = supported.includes(preset.aspect) ? preset.aspect : supported[0]
  return {
    provider,
    model,
    purpose,
    prompt: '',
    negativePrompt: '',
    styleKey: '',
    palette: preset.palette,
    density: preset.density,
    textSpace: preset.textSpace,
    noText: preset.noText,
    titleEnabled: false,
    title: '',
    subtitle: '',
    textLanguage: 'zh',
    aspect,
    tier: normalizeTier(provider, model, aspect, preset.tier),
    count: Math.min(spec.maxOutputs, Math.max(1, defaults.count)),
    seed: null,
    watermark: defaults.watermark,
    promptExtend: defaults.promptExtend && spec.supportsPromptExtend,
    promptExtendMode: spec.promptExtendModes.includes(defaults.promptExtendMode)
      ? defaults.promptExtendMode
      : 'direct',
    optimizeMode: spec.optimizeModes.includes(defaults.optimizeMode) ? defaults.optimizeMode : 'standard',
    sequential: defaults.sequential && spec.supportsSequential,
    maxImages: Math.min(15, Math.max(1, defaults.maxImages)),
    customSizeEnabled: false,
    customSize: '',
    transparent: false,
    quality: defaults.quality,
    references: [],
  }
}

function readDraft(): Partial<ComposerState> {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<ComposerState>
    delete parsed.references
    return parsed
  } catch {
    return {}
  }
}

let state: StudioState = {
  ready: false,
  settings: null,
  llmModels: [],
  images: [],
  total: 0,
  usageBytes: 0,
  dataDir: '',
  jobs: [],
  activeJobId: null,
  notice: null,
  previewId: null,
  filter: 'all',
  purposeFilter: 'all',
  search: '',
  sort: 'new',
  columns: 3,
  settingsOpen: false,
  settingsTab: 'providers',
  settingsProvider: 'volcengine',
  composer: baseComposer(null),
}

const listeners = new Set<() => void>()

function setState(patch: Partial<StudioState> | ((prev: StudioState) => Partial<StudioState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStudio(): StudioState {
  return useSyncExternalStore(subscribe, () => state)
}

export function getState(): StudioState {
  return state
}

// ====== 草稿持久化 ======

let draftTimer: ReturnType<typeof setTimeout> | null = null

function persistDraft(composer: ComposerState): void {
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    try {
      const copy: Record<string, unknown> = { ...composer }
      delete copy.references
      localStorage.setItem(DRAFT_KEY, JSON.stringify(copy))
    } catch {
      // localStorage 不可用时忽略（不影响生成）
    }
  }, 300)
}

// ====== 初始化 ======

let initialized = false

export async function initialize(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const [settings, library, llmModels] = await Promise.all([
      invoke<PublicSettings>('settings-get'),
      invoke<{ images: GeneratedImage[]; total: number; usageBytes: number; dataDir: string }>('list-images'),
      // 宿主未开放 data/llmProviders 能力时降级为空列表，不影响生图主流程
      invoke<LlmModelOption[]>('llm-models').catch(() => [] as LlmModelOption[]),
    ])
    const draft = readDraft()
    const composer = { ...baseComposer(settings), ...draft, references: [] }
    normalizeComposer(composer, settings)
    setState({
      ready: true,
      settings,
      llmModels,
      images: library.images,
      total: library.total,
      usageBytes: library.usageBytes,
      dataDir: library.dataDir,
      composer,
      settingsProvider: composer.provider,
    })
    persistDraft(composer)
  } catch (err: any) {
    setState({
      ready: true,
      notice: { type: 'error', message: err?.message || t('errors.requestFailed') },
    })
  }
  bindEvents()
}

let eventsBound = false

function bindEvents(): void {
  if (eventsBound || !bridge) return
  eventsBound = true
  bridge.onEvent('gen-progress', (payload) => handleProgress(payload as JobProgress))
  bridge.onEvent('images-changed', () => void refreshImages())
  bridge.onEvent('settings-changed', (payload) => setState({ settings: payload as PublicSettings }))
}

function handleProgress(progress: JobProgress): void {
  const existing = state.jobs.find((item) => item.jobId === progress.jobId)
  const terminal = progress.stage === 'done' || progress.stage === 'error' || progress.stage === 'canceled'

  // 每个 jobId 独立记录，多个任务并行时互不覆盖
  let jobs = state.jobs
  if (terminal) {
    jobs = jobs.filter((item) => item.jobId !== progress.jobId)
  } else {
    const view: JobView = {
      jobId: progress.jobId,
      stage: progress.stage,
      total: progress.total,
      completed: progress.completed,
      elapsedMs: progress.elapsedMs,
      startedAt: existing?.startedAt ?? Date.now() - progress.elapsedMs,
      provider: progress.provider,
      model: progress.model,
      error: progress.error,
    }
    jobs = existing ? jobs.map((item) => (item.jobId === view.jobId ? view : item)) : [...jobs, view]
  }

  const incoming: GeneratedImage[] = progress.image
    ? [progress.image]
    : progress.images && progress.images.length > 0
      ? progress.images
      : []

  let images = state.images
  if (incoming.length > 0) {
    const seen = new Set(images.map((image) => image.id))
    const fresh = incoming.filter((image) => !seen.has(image.id))
    if (fresh.length > 0) images = [...fresh, ...images]
  }

  let notice = state.notice
  if (progress.stage === 'error') {
    notice = { type: 'error', message: progress.error || t('errors.generateFailed') }
  } else if (progress.stage === 'done' && progress.error) {
    notice = { type: 'warning', message: progress.error }
  } else if (progress.stage === 'canceled') {
    notice = { type: 'warning', message: t('canceled') }
  } else if (progress.stage === 'requesting' && progress.jobId === state.activeJobId) {
    notice = null
  }

  setState({
    jobs,
    images,
    notice,
    total: Math.max(state.total, images.length),
    activeJobId: terminal && state.activeJobId === progress.jobId ? null : state.activeJobId,
  })

  if (terminal) {
    void refreshImages()
  }
}

/** 复制文本：优先浏览器剪贴板，失败回退宿主能力（file:// 场景更可靠） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 继续尝试宿主能力
  }
  try {
    if (hostCaps?.clipboard) {
      await hostCaps.clipboard.writeText(text)
      return true
    }
  } catch {
    // 忽略
  }
  return false
}

/** 并行任务会同时触发刷新：只采纳最后一次请求的结果，避免旧快照覆盖新作品 */
let refreshSeq = 0

export async function refreshImages(): Promise<void> {
  const seq = ++refreshSeq
  try {
    const library = await invoke<{ images: GeneratedImage[]; total: number; usageBytes: number; dataDir: string }>(
      'list-images'
    )
    if (seq !== refreshSeq) return
    setState({
      images: library.images,
      total: library.total,
      usageBytes: library.usageBytes,
      dataDir: library.dataDir,
    })
  } catch {
    // 刷新失败保留现有列表
  }
}

// ====== 编辑器 ======

function normalizeComposer(composer: ComposerState, settings?: PublicSettings | null): ComposerState {
  if (!PROVIDER_IDS.includes(composer.provider)) composer.provider = 'volcengine'
  const providerMeta = PROVIDERS[composer.provider]
  if (!composer.model) {
    composer.model = settings?.providers[composer.provider]?.defaultModel || providerMeta.defaultModel
  }
  if (!PURPOSE_IDS.includes(composer.purpose)) composer.purpose = DEFAULT_SETTINGS.defaults.purpose
  const spec = getModelSpec(composer.provider, composer.model)
  const supported = getSupportedAspects(composer.provider, composer.model)
  if (!supported.includes(composer.aspect)) {
    const presetAspect = PURPOSE_PRESETS[composer.purpose].aspect
    composer.aspect = supported.includes(presetAspect) ? presetAspect : supported[0]
  }
  composer.tier = normalizeTier(composer.provider, composer.model, composer.aspect, composer.tier)
  if (composer.optimizeMode === 'fast' && !spec.optimizeModes.includes('fast')) composer.optimizeMode = 'standard'
  if (!spec.supportsPromptExtend) composer.promptExtend = false
  if (!spec.promptExtendModes.includes(composer.promptExtendMode)) composer.promptExtendMode = 'direct'
  if (!spec.supportsSequential) composer.sequential = false
  if (!spec.supportsNegativePrompt) composer.negativePrompt = ''
  if (!spec.supportsTransparent) composer.transparent = false
  if (!spec.supportsCustomSize) {
    composer.customSizeEnabled = false
    composer.customSize = ''
  }
  composer.count = Math.min(spec.maxOutputs, Math.max(1, composer.count || 1))
  if (composer.references.length > spec.maxRefImages) {
    composer.references = composer.references.slice(0, spec.maxRefImages)
  }
  return composer
}

export function setComposer(patch: Partial<ComposerState>): void {
  const composer = normalizeComposer({ ...state.composer, ...patch }, state.settings)
  persistDraft(composer)
  setState({ composer, notice: null })
}

/** 应用用途预设：比例/档位/留白/配色/密度一并重置 */
export function applyPurpose(purpose: PurposeId): void {
  const preset = PURPOSE_PRESETS[purpose]
  const composer = state.composer
  const supported = getSupportedAspects(composer.provider, composer.model)
  const aspect = supported.includes(preset.aspect) ? preset.aspect : supported[0]
  const next = normalizeComposer(
    {
      ...composer,
      purpose,
      aspect,
      tier: normalizeTier(composer.provider, composer.model, aspect, preset.tier),
      textSpace: preset.textSpace,
      noText: preset.noText,
      palette: preset.palette,
      density: preset.density,
    },
    state.settings
  )
  persistDraft(next)
  setState({ composer: next, notice: null })
}

/** 切换模型（含服务商），比例/档位自动收敛到新模型能力 */
export function switchModel(provider: ProviderId, model: string): void {
  const spec = getModelSpec(provider, model)
  const composer = normalizeComposer(
    {
      ...state.composer,
      provider,
      model,
      tier: spec.defaultTier,
      sequential: spec.supportsSequential ? state.composer.sequential : false,
    },
    state.settings
  )
  persistDraft(composer)
  setState({ composer, notice: null })
}

export function addReference(image: RefImage): { ok: boolean; error?: string } {
  const spec = getModelSpec(state.composer.provider, state.composer.model)
  if (state.composer.references.length >= spec.maxRefImages) {
    return { ok: false, error: t('errors.referenceLimit') }
  }
  const composer = { ...state.composer, references: [...state.composer.references, image] }
  setState({ composer, notice: null })
  return { ok: true }
}

export function removeReference(id: string): void {
  const composer = { ...state.composer, references: state.composer.references.filter((item) => item.id !== id) }
  setState({ composer })
}

/** 由编辑器状态构造请求（生成与「最终提示词」预览共用） */
export function buildRequest(): GenerateRequest {
  const composer = state.composer
  const spec = getModelSpec(composer.provider, composer.model)
  return {
    provider: composer.provider,
    model: composer.model,
    prompt: composer.prompt.trim(),
    negativePrompt: spec.supportsNegativePrompt ? composer.negativePrompt.trim() : '',
    aspect: composer.aspect,
    tier: normalizeTier(composer.provider, composer.model, composer.aspect, composer.tier),
    customSize: composer.customSizeEnabled ? composer.customSize.trim() : undefined,
    count: Math.min(spec.maxOutputs, Math.max(1, composer.count)),
    seed: composer.seed,
    watermark: composer.watermark,
    promptExtend: composer.promptExtend,
    promptExtendMode: composer.promptExtendMode,
    optimizeMode: spec.optimizeModes.includes(composer.optimizeMode) ? composer.optimizeMode : 'standard',
    sequential: spec.supportsSequential && composer.sequential,
    maxImages: Math.min(15, Math.max(1, composer.maxImages)),
    referenceImages: composer.references.map((item) => item.dataUrl),
    purpose: composer.purpose,
    styleKey: composer.styleKey,
    palette: composer.palette,
    density: composer.density,
    textSpace: composer.textSpace,
    noText: composer.noText,
    titleEnabled: composer.titleEnabled && (Boolean(composer.title.trim()) || Boolean(composer.subtitle.trim())),
    title: composer.title.trim(),
    subtitle: composer.subtitle.trim(),
    textLanguage: composer.textLanguage,
    transparent: Boolean(spec.supportsTransparent) && composer.transparent,
    quality: composer.quality,
  }
}

// ====== 提示词优化 ======

/** 用宿主 LLM 把用户输入改写成更易出图的提示词（模型在设置中选择） */
export async function optimizePrompt(payload: {
  prompt: string
  purposeLabel: string
  aspect: string
  styleLabel: string
}): Promise<{ prompt?: string; error?: string }> {
  try {
    return await invoke<{ prompt?: string; error?: string }>('optimize-prompt', payload)
  } catch (err: any) {
    return { error: err?.message || t('errors.optimizeFailed') }
  }
}

// ====== 生成 ======

/** 渲染端先生成任务 ID 交给主进程，保证并行任务的事件与本地面板状态确定性对应 */
function newJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export async function generate(): Promise<{ ok: boolean; error?: string }> {
  const request = buildRequest()
  if (!request.prompt) return { ok: false, error: t('errors.emptyPrompt') }

  const total = request.provider === 'volcengine' ? (request.sequential ? request.maxImages : 1) : request.count
  const clientJobId = newJobId()
  setState({
    notice: null,
    activeJobId: clientJobId,
    jobs: [
      ...state.jobs,
      {
        jobId: clientJobId,
        stage: 'queued',
        total,
        completed: 0,
        elapsedMs: 0,
        startedAt: Date.now(),
        provider: request.provider,
        model: request.model,
      },
    ],
  })

  try {
    const res = await invoke<{ jobId?: string; error?: string }>('generate', { ...request, clientJobId })
    if (res?.error) {
      setState({
        jobs: state.jobs.filter((item) => item.jobId !== clientJobId),
        activeJobId: null,
        notice: { type: 'error', message: res.error },
      })
      return { ok: false, error: res.error }
    }
    return { ok: true }
  } catch (err: any) {
    const message = err?.message || t('errors.requestFailed')
    setState({
      jobs: state.jobs.filter((item) => item.jobId !== clientJobId),
      activeJobId: null,
      notice: { type: 'error', message },
    })
    return { ok: false, error: message }
  }
}

export async function cancelJob(): Promise<void> {
  const jobId = state.activeJobId
  if (!jobId) return
  try {
    await invoke('cancel', jobId)
  } catch {
    // 取消失败时保持当前状态，等待任务自然收敛
  }
}

// ====== 作品操作 ======

export async function toggleFavorite(id: string): Promise<boolean> {
  const image = state.images.find((item) => item.id === id)
  const next = !image?.favorite
  setState({ images: state.images.map((item) => (item.id === id ? { ...item, favorite: next } : item)) })
  try {
    const updated = await invoke<GeneratedImage>('toggle-favorite', { id, favorite: next })
    if (updated && 'id' in updated) {
      setState({ images: state.images.map((item) => (item.id === id ? updated : item)) })
    }
    return next
  } catch {
    setState({ images: state.images.map((item) => (item.id === id ? { ...item, favorite: !next } : item)) })
    return !next
  }
}

export async function deleteImage(id: string): Promise<boolean> {
  try {
    const res = await invoke<{ ok?: boolean; error?: string }>('delete-image', id)
    if (res?.error) return false
    setState({
      images: state.images.filter((item) => item.id !== id),
      total: Math.max(0, state.total - 1),
      previewId: state.previewId === id ? null : state.previewId,
    })
    return true
  } catch {
    return false
  }
}

export async function saveImageAs(id: string): Promise<string> {
  const res = await invoke<{ path?: string; error?: string }>('save-image-as', id)
  return res?.path || ''
}

export async function downloadImage(id: string): Promise<string> {
  const res = await invoke<{ path?: string; error?: string }>('download-image', { id })
  return res?.path || ''
}

export async function copyImage(id: string): Promise<boolean> {
  try {
    const res = await invoke<{ ok?: boolean }>('copy-image', id)
    return Boolean(res?.ok)
  } catch {
    return false
  }
}

export function showInFolder(id: string): void {
  void invoke('show-in-folder', id)
}

export async function readImageData(id: string, full = false): Promise<string> {
  const res = await invoke<{ dataUrl?: string; error?: string }>('read-image-data', { id, full })
  return res?.dataUrl || ''
}

export async function useAsReference(id: string): Promise<{ ok: boolean; error?: string }> {
  const dataUrl = await readImageData(id, false)
  if (!dataUrl) return { ok: false, error: t('errors.imageNotFound') }
  const image = state.images.find((item) => item.id === id)
  return addReference({
    id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    dataUrl,
    name: image ? `${image.model}.png` : 'reference.png',
  })
}

export function regenerateFrom(image: GeneratedImage): void {
  let params: Record<string, any> = {}
  try {
    params = JSON.parse(image.paramsJson || '{}')
  } catch {
    params = {}
  }
  const spec = getModelSpec(image.provider, image.model)
  const composer: ComposerState = normalizeComposer(
    {
      ...baseComposer(state.settings),
      provider: image.provider,
      model: image.model,
      prompt: image.prompt,
      negativePrompt: image.negativePrompt || '',
      aspect: (params.aspect as AspectRatio) || state.composer.aspect,
      tier: (params.tier as ResolutionTier) || spec.defaultTier,
      count: Number(params.count) || 1,
      seed: typeof params.seed === 'number' ? params.seed : null,
      watermark: Boolean(params.watermark),
      promptExtend: params.promptExtend !== false,
      promptExtendMode: (params.promptExtendMode as PromptExtendMode) || 'direct',
      optimizeMode: (params.optimizeMode as OptimizeMode) || 'standard',
      sequential: Boolean(params.sequential),
      maxImages: Number(params.maxImages) || 2,
      customSizeEnabled: false,
      customSize: '',
      purpose: PURPOSE_IDS.includes(params.purpose) ? (params.purpose as PurposeId) : 'free',
      styleKey: typeof params.styleKey === 'string' ? params.styleKey : '',
      palette: (params.palette as PaletteId) || 'auto',
      density: (params.density as DensityId) || 'balanced',
      textSpace: (params.textSpace as TextSpace) || 'none',
      noText: Boolean(params.noText),
      titleEnabled: Boolean(params.titleEnabled),
      title: typeof params.title === 'string' ? params.title : '',
      subtitle: typeof params.subtitle === 'string' ? params.subtitle : '',
      textLanguage: params.textLanguage === 'en' ? 'en' : 'zh',
      transparent: Boolean(params.transparent),
      quality: (params.quality as QualityTier) || 'high',
      references: [],
    },
    state.settings
  )
  persistDraft(composer)
  setState({ composer, previewId: null, notice: null })
  void generate()
}

// ====== 设置 ======

export async function saveProvider(
  provider: ProviderId,
  patch: { apiKey?: string; baseUrl?: string; defaultModel?: string }
): Promise<PublicSettings | null> {
  try {
    const payload: SettingsPatch = { providers: { [provider]: patch } }
    const settings = await invoke<PublicSettings>('settings-save', payload)
    setState({ settings })
    return settings
  } catch {
    return null
  }
}

export async function saveDefaults(patch: Partial<DefaultsSettings>): Promise<PublicSettings | null> {
  try {
    const settings = await invoke<PublicSettings>('settings-save', { defaults: patch })
    setState({ settings })
    return settings
  } catch {
    return null
  }
}

export async function testProvider(payload: {
  provider: ProviderId
  apiKey?: string
  baseUrl?: string
  model?: string
}): Promise<{ ok: boolean; message: string }> {
  try {
    return await invoke<{ ok: boolean; message: string }>('settings-test', payload)
  } catch (err: any) {
    return { ok: false, message: err?.message || t('settings.testFailed') }
  }
}

export function openSettings(open: boolean, tab?: string, provider?: ProviderId): void {
  setState({
    settingsOpen: open,
    ...(tab ? { settingsTab: tab } : {}),
    ...(provider ? { settingsProvider: provider } : {}),
  })
}

export function setSettingsTab(tab: string): void {
  setState({ settingsTab: tab })
}

export function setSettingsProvider(provider: ProviderId): void {
  setState({ settingsProvider: provider })
}

export function setPreview(id: string | null): void {
  setState({ previewId: id })
}

export function setGalleryFilter(filter: 'all' | 'favorite'): void {
  setState({ filter })
}

export function setPurposeFilter(purpose: PurposeId | 'all'): void {
  setState({ purposeFilter: purpose })
}

export function setSearch(search: string): void {
  setState({ search })
}

export function setSort(sort: 'new' | 'old'): void {
  setState({ sort })
}

export function setColumns(columns: number): void {
  setState({ columns })
}

export function setNotice(notice: Notice | null): void {
  setState({ notice })
}

export async function openDataDir(): Promise<void> {
  await invoke('open-data-dir')
}
