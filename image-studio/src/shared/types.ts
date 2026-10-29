/**
 * image-studio 共享契约：主进程与渲染端共用（不含任何宿主内部依赖）。
 * 服务商能力、尺寸映射、用途预设、设置与作品记录均以本文件为单一事实源。
 */

export type ProviderId = 'volcengine' | 'qwen' | 'openai'

export const PLUGIN_VERSION = '1.3.0'

export type AspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3' | '21:9'

export type ResolutionTier = '1K' | '2K' | '3K' | '4K'

export type PromptExtendMode = 'direct' | 'agent'

export type OptimizeMode = 'standard' | 'fast'

export type QualityTier = 'low' | 'medium' | 'high' | 'auto'

/** 用途：决定默认比例、留白、配色与画面风格，是 PPT / 科研配图的主入口 */
export type PurposeId =
  | 'ppt-slide'
  | 'ppt-cover'
  | 'sci-schematic'
  | 'paper-figure'
  | 'chart'
  | 'infographic'
  | 'architecture'
  | 'flowchart'
  | 'poster'
  | 'free'

export type PaletteId = 'auto' | 'academic' | 'corporate' | 'warm' | 'mono' | 'darkTech' | 'pastel'

export type DensityId = 'minimal' | 'balanced' | 'rich'

export type TextSpace = 'none' | 'top' | 'bottom' | 'left' | 'right'

export type TextLanguage = 'zh' | 'en'

/** 除自由创作外的用途（用于设置项与筛选，不含 free） */
export const SCENE_PURPOSES: PurposeId[] = [
  'ppt-slide',
  'ppt-cover',
  'sci-schematic',
  'paper-figure',
  'chart',
  'infographic',
  'architecture',
  'flowchart',
  'poster',
]

export const PURPOSE_IDS: PurposeId[] = [...SCENE_PURPOSES, 'free']

export interface PurposePreset {
  aspect: AspectRatio
  tier: ResolutionTier
  textSpace: TextSpace
  noText: boolean
  palette: PaletteId
  density: DensityId
}

/** 各用途的默认排版倾向（模型不支持时会自动回退到可用比例） */
export const PURPOSE_PRESETS: Record<PurposeId, PurposePreset> = {
  'ppt-slide': { aspect: '16:9', tier: '2K', textSpace: 'right', noText: false, palette: 'auto', density: 'minimal' },
  'ppt-cover': { aspect: '16:9', tier: '2K', textSpace: 'left', noText: false, palette: 'darkTech', density: 'minimal' },
  'sci-schematic': { aspect: '16:9', tier: '2K', textSpace: 'none', noText: false, palette: 'academic', density: 'balanced' },
  'paper-figure': { aspect: '3:4', tier: '2K', textSpace: 'bottom', noText: false, palette: 'academic', density: 'balanced' },
  chart: { aspect: '16:9', tier: '2K', textSpace: 'none', noText: false, palette: 'corporate', density: 'balanced' },
  infographic: { aspect: '3:4', tier: '2K', textSpace: 'none', noText: false, palette: 'pastel', density: 'rich' },
  architecture: { aspect: '16:9', tier: '2K', textSpace: 'none', noText: false, palette: 'corporate', density: 'balanced' },
  flowchart: { aspect: '16:9', tier: '2K', textSpace: 'none', noText: false, palette: 'corporate', density: 'balanced' },
  poster: { aspect: '2:3', tier: '4K', textSpace: 'bottom', noText: false, palette: 'academic', density: 'minimal' },
  free: { aspect: '1:1', tier: '2K', textSpace: 'none', noText: false, palette: 'auto', density: 'balanced' },
}

export interface ModelSpec {
  id: string
  label: string
  /** 能力简述（渲染端按 locale 覆盖展示） */
  desc: string
  tiers: ResolutionTier[]
  defaultTier: ResolutionTier
  maxRefImages: number
  maxOutputs: number
  supportsNegativePrompt: boolean
  supportsSequential: boolean
  supportsPromptExtend: boolean
  promptExtendModes: PromptExtendMode[]
  optimizeModes: OptimizeMode[]
  /** 单图像素上限（官方尺寸表在个别比例上会略超模型上限，按此收敛） */
  maxPixels?: number
  /** 支持的比例（缺省为全部） */
  aspects?: AspectRatio[]
  /** 固定尺寸表（无「档位」概念的模型，如 OpenAI） */
  fixedSizes?: Partial<Record<AspectRatio, Partial<Record<ResolutionTier, string>>>>
  supportsCustomSize?: boolean
  supportsTransparent?: boolean
  supportsQuality?: boolean
  /** 是否支持参考图编辑（multipart /images/edits） */
  supportsEdits?: boolean
}

export interface ProviderMeta {
  id: ProviderId
  name: string
  defaultBaseUrl: string
  docsUrl: string
  models: ModelSpec[]
  defaultModel: string
}

const VOLC = (over: Partial<ModelSpec> & Pick<ModelSpec, 'id' | 'label' | 'desc'>): ModelSpec => ({
  tiers: ['2K', '4K'],
  defaultTier: '2K',
  maxRefImages: 14,
  maxOutputs: 15,
  supportsNegativePrompt: false,
  supportsSequential: true,
  supportsPromptExtend: false,
  promptExtendModes: [],
  optimizeModes: ['standard'],
  supportsEdits: true,
  ...over,
})

const QWEN = (over: Partial<ModelSpec> & Pick<ModelSpec, 'id' | 'label' | 'desc'>): ModelSpec => ({
  tiers: ['1K', '2K'],
  defaultTier: '1K',
  maxRefImages: 10,
  maxOutputs: 6,
  supportsNegativePrompt: false,
  supportsSequential: false,
  supportsPromptExtend: true,
  // 文档：prompt_extend_mode 仅 3.0 系列与 2.1 Pro 支持
  promptExtendModes: ['direct'],
  optimizeModes: [],
  supportsEdits: true,
  ...over,
})

const OPENAI = (over: Partial<ModelSpec> & Pick<ModelSpec, 'id' | 'label' | 'desc'>): ModelSpec => ({
  tiers: ['1K'],
  defaultTier: '1K',
  maxRefImages: 4,
  maxOutputs: 4,
  supportsNegativePrompt: false,
  supportsSequential: false,
  supportsPromptExtend: false,
  promptExtendModes: [],
  optimizeModes: [],
  supportsQuality: true,
  supportsEdits: true,
  ...over,
})

/** GPT Image 1.x：仅三档固定尺寸（官方不支持 16:9 与自定义尺寸） */
const OPENAI_SMALL_SIZES: ModelSpec['fixedSizes'] = {
  '1:1': { '1K': '1024x1024' },
  '3:2': { '1K': '1536x1024' },
  '2:3': { '1K': '1024x1536' },
}

/** GPT Image 2：原生 16:9 与 4K */
const OPENAI_V2_SIZES: ModelSpec['fixedSizes'] = {
  '1:1': { '1K': '1024x1024' },
  '4:3': { '1K': '1024x768' },
  '3:4': { '1K': '768x1024' },
  '16:9': { '2K': '1920x1080', '4K': '3840x2160' },
  '9:16': { '2K': '1080x1920' },
  '3:2': { '1K': '1536x1024' },
  '2:3': { '1K': '1024x1536' },
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  volcengine: {
    id: 'volcengine',
    name: 'Volcengine Seedream',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docsUrl: 'https://www.volcengine.com/docs/82379/1541523',
    defaultModel: 'doubao-seedream-4-0-250828',
    models: [
      VOLC({
        id: 'doubao-seedream-4-0-250828',
        label: 'Seedream 4.0',
        desc: '文生图 / 图生图 / 组图，1K-4K，性价比高',
        tiers: ['1K', '2K', '4K'],
        optimizeModes: ['standard', 'fast'],
      }),
      VOLC({
        id: 'doubao-seedream-5-0-flash-260915',
        label: 'Seedream 5.0 Flash',
        desc: '极速出图，2K-3K，适合快速草稿与批量迭代',
        tiers: ['2K', '3K'],
        defaultTier: '2K',
      }),
      VOLC({
        id: 'doubao-seedream-5-0-pro-260628',
        label: 'Seedream 5.0 Pro',
        desc: '旗舰画质，单图生成，1K / 2K',
        tiers: ['1K', '2K'],
        defaultTier: '2K',
        maxRefImages: 10,
        supportsSequential: false,
        maxPixels: 2048 * 2048,
      }),
    ],
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen Image',
    // DashScope 原生协议为官方推荐方式；填 /compatible-mode/v1 则自动降级为 OpenAI 兼容协议
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference',
    defaultModel: 'qwen-image-2.1-turbo',
    models: [
      QWEN({
        id: 'qwen-image-2.1-turbo',
        label: 'Qwen Image 2.1 Turbo',
        desc: '速度与质量平衡，支持最多 10 张参考图',
        supportsTransparent: true,
        promptExtendModes: [],
      }),
      QWEN({
        id: 'qwen-image-2.1-pro',
        label: 'Qwen Image 2.1 Pro',
        desc: '2.1 系列高质量版本，支持透明通道输出',
        supportsTransparent: true,
        promptExtendModes: ['direct', 'agent'],
      }),
      QWEN({
        id: 'qwen-image-3.0',
        label: 'Qwen Image 3.0',
        desc: '新一代基座，支持反向提示词与提示词增强',
        maxRefImages: 3,
        supportsNegativePrompt: true,
        promptExtendModes: ['direct', 'agent'],
      }),
      QWEN({
        id: 'qwen-image-3.0-pro',
        label: 'Qwen Image 3.0 Pro',
        desc: '3.0 旗舰，复杂指令与文字渲染更强',
        maxRefImages: 3,
        supportsNegativePrompt: true,
        promptExtendModes: ['direct', 'agent'],
      }),
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/guides/image-generation',
    defaultModel: 'gpt-image-1.5',
    models: [
      OPENAI({
        id: 'gpt-image-2',
        label: 'GPT Image 2',
        desc: '原生 16:9 / 4K，中英文字渲染能力强',
        tiers: ['1K', '2K', '4K'],
        defaultTier: '2K',
        fixedSizes: OPENAI_V2_SIZES,
        aspects: Object.keys(OPENAI_V2_SIZES) as AspectRatio[],
        supportsCustomSize: true,
      }),
      OPENAI({
        id: 'gpt-image-1.5',
        label: 'GPT Image 1.5',
        desc: '固定三档尺寸，支持透明 PNG 与参考图编辑',
        fixedSizes: OPENAI_SMALL_SIZES,
        aspects: Object.keys(OPENAI_SMALL_SIZES) as AspectRatio[],
        supportsTransparent: true,
      }),
      OPENAI({
        id: 'gpt-image-1',
        label: 'GPT Image 1',
        desc: '经典图像模型，稳定通用',
        fixedSizes: OPENAI_SMALL_SIZES,
        aspects: Object.keys(OPENAI_SMALL_SIZES) as AspectRatio[],
        supportsTransparent: true,
      }),
      OPENAI({
        id: 'gpt-image-1-mini',
        label: 'GPT Image 1 Mini',
        desc: '低成本档，适合草稿与批量尝试',
        fixedSizes: OPENAI_SMALL_SIZES,
        aspects: Object.keys(OPENAI_SMALL_SIZES) as AspectRatio[],
        supportsTransparent: true,
      }),
    ],
  },
}

export const PROVIDER_IDS: ProviderId[] = ['volcengine', 'qwen', 'openai']

/** 未知/自定义模型 ID 的兜底能力（尽量宽松，由服务端校验实际能力） */
export function getModelSpec(provider: ProviderId, modelId: string): ModelSpec {
  const meta = PROVIDERS[provider]
  const hit = meta.models.find((m) => m.id === modelId)
  if (hit) return hit
  if (provider === 'volcengine') return VOLC({ id: modelId, label: modelId, desc: '' })
  if (provider === 'qwen') return QWEN({ id: modelId, label: modelId, desc: '' })
  return OPENAI({ id: modelId, label: modelId, desc: '', fixedSizes: OPENAI_SMALL_SIZES, aspects: ['1:1', '3:2', '2:3'] })
}

export const ASPECTS: Array<{ value: AspectRatio; label: string }> = [
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '21:9', label: '21:9' },
]

/** Seedream 官方文档给出的档位 → 宽高映射（保证像素区间与宽高比合法） */
const VOLC_SIZES: Record<ResolutionTier, Record<AspectRatio, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '16:9': '1312x736',
    '9:16': '736x1312',
    '3:2': '1248x832',
    '2:3': '832x1248',
    '21:9': '1568x672',
  },
  '2K': {
    '1:1': '2048x2048',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
    '16:9': '2848x1600',
    '9:16': '1600x2848',
    '3:2': '2496x1664',
    '2:3': '1664x2496',
    '21:9': '3136x1344',
  },
  '3K': {
    '1:1': '3072x3072',
    '4:3': '3456x2592',
    '3:4': '2592x3456',
    '16:9': '4096x2304',
    '9:16': '2304x4096',
    '3:2': '3744x2496',
    '2:3': '2496x3744',
    '21:9': '4704x2016',
  },
  '4K': {
    '1:1': '4096x4096',
    '4:3': '4704x3520',
    '3:4': '3520x4704',
    '16:9': '5504x3040',
    '9:16': '3040x5504',
    '3:2': '4992x3328',
    '2:3': '3328x4992',
    '21:9': '6240x2656',
  },
}

/** 千问：单边不超过 2048，总像素 ≤ 2048*2048 */
const QWEN_SIZES: Record<'1K' | '2K', Record<AspectRatio, string>> = {
  '1K': {
    '1:1': '1024x1024',
    '4:3': '1152x864',
    '3:4': '864x1152',
    '16:9': '1280x720',
    '9:16': '720x1280',
    '3:2': '1248x832',
    '2:3': '832x1248',
    '21:9': '1512x648',
  },
  '2K': {
    '1:1': '2048x2048',
    '4:3': '2048x1536',
    '3:4': '1536x2048',
    '16:9': '2048x1152',
    '9:16': '1152x2048',
    '3:2': '2048x1360',
    '2:3': '1360x2048',
    '21:9': '2016x864',
  },
}

export interface ResolvedSize {
  size: string
  width: number
  height: number
}

function parseSize(raw: string): ResolvedSize | null {
  const m = /^\s*(\d{2,5})\s*[x*×]\s*(\d{2,5})\s*$/i.exec(raw)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!width || !height) return null
  return { size: `${width}x${height}`, width, height }
}

/** 当前模型支持的比例 */
export function getSupportedAspects(provider: ProviderId, modelId: string): AspectRatio[] {
  const spec = getModelSpec(provider, modelId)
  return spec.aspects ?? ASPECTS.map((a) => a.value)
}

/** 指定比例下可用的分辨率档位 */
export function getSupportedTiers(provider: ProviderId, modelId: string, aspect: AspectRatio): ResolutionTier[] {
  const spec = getModelSpec(provider, modelId)
  if (spec.fixedSizes) {
    const fixed = spec.fixedSizes[aspect]
    return fixed ? (Object.keys(fixed) as ResolutionTier[]) : [...spec.tiers]
  }
  return spec.tiers
}

/** 收敛到当前模型/比例可用的档位（优先向下取，其次取最大） */
export function normalizeTier(
  provider: ProviderId,
  modelId: string,
  aspect: AspectRatio,
  tier: ResolutionTier
): ResolutionTier {
  const tiers = getSupportedTiers(provider, modelId, aspect)
  if (tiers.includes(tier)) return tier
  const order: ResolutionTier[] = ['1K', '2K', '3K', '4K']
  const target = order.indexOf(tier)
  const lower = tiers.filter((t) => order.indexOf(t) <= target)
  if (lower.length > 0) return lower[lower.length - 1]
  return tiers[0] ?? '1K'
}

/** 由档位 + 比例（或自定义尺寸）解析最终像素；无法解析时回退模型默认档位 */
export function resolveSize(
  provider: ProviderId,
  modelId: string,
  aspect: AspectRatio,
  tier: ResolutionTier,
  customSize?: string
): ResolvedSize {
  const custom = customSize ? parseSize(customSize) : null
  if (custom) {
    if (provider !== 'openai') return custom
    // GPT Image 2 自定义尺寸约束：边为 16 的倍数、最长边 ≤3840、宽高比 ≤3:1、总像素上限内
    const spec = getModelSpec(provider, modelId)
    const valid =
      spec.supportsCustomSize &&
      custom.width % 16 === 0 &&
      custom.height % 16 === 0 &&
      Math.max(custom.width, custom.height) <= 3840 &&
      Math.max(custom.width / custom.height, custom.height / custom.width) <= 3 &&
      custom.width * custom.height >= 655360 &&
      custom.width * custom.height <= 8294400
    if (valid) return custom
  }
  const spec = getModelSpec(provider, modelId)
  const supportedAspect = spec.aspects ? spec.aspects.includes(aspect) : true
  const safeAspect: AspectRatio = supportedAspect ? aspect : (spec.aspects?.[0] ?? aspect)
  const safeTier = normalizeTier(provider, modelId, safeAspect, tier)

  if (spec.fixedSizes) {
    const size = spec.fixedSizes[safeAspect]?.[safeTier]
    const parsed = size ? parseSize(size) : null
    if (parsed) return parsed
    const fallbackTier = getSupportedTiers(provider, modelId, safeAspect)[0]
    const fallback = spec.fixedSizes[safeAspect]?.[fallbackTier]
    const fallbackParsed = fallback ? parseSize(fallback) : null
    if (fallbackParsed) return fallbackParsed
    return parseSize('1024x1024')!
  }

  if (provider === 'qwen') {
    const t = safeTier === '2K' ? '2K' : '1K'
    const size = QWEN_SIZES[t][safeAspect]
    const [w, h] = size.split('x').map(Number)
    return { size, width: w, height: h }
  }

  const size = VOLC_SIZES[safeTier][safeAspect]
  const [w, h] = size.split('x').map(Number)
  if (spec.maxPixels && w * h > spec.maxPixels) {
    const scale = Math.sqrt(spec.maxPixels / (w * h))
    const width = Math.floor((w * scale) / 16) * 16
    const height = Math.floor((h * scale) / 16) * 16
    return { size: `${width}x${height}`, width, height }
  }
  return { size, width: w, height: h }
}

// ====== 生成请求 / 结果 ======

export interface GenerateRequest {
  provider: ProviderId
  model: string
  /** 用户输入的画面描述（不含自动拼接的排版/风格指令） */
  prompt: string
  negativePrompt?: string
  aspect: AspectRatio
  tier: ResolutionTier
  customSize?: string
  count: number
  seed?: number | null
  watermark: boolean
  promptExtend: boolean
  promptExtendMode: PromptExtendMode
  optimizeMode: OptimizeMode
  sequential: boolean
  maxImages: number
  /** data URL / 公网 URL，顺序即参考图顺序 */
  referenceImages: string[]
  // ====== 场景化排版 ======
  purpose: PurposeId
  styleKey: string
  palette: PaletteId
  density: DensityId
  textSpace: TextSpace
  noText: boolean
  titleEnabled: boolean
  title: string
  subtitle: string
  textLanguage: TextLanguage
  transparent: boolean
  quality: QualityTier
  /** 渲染端预先生成的任务 ID（仅用于并行任务的进度关联，不落库） */
  clientJobId?: string
}

export interface GeneratedImage {
  id: string
  jobId: string
  provider: ProviderId
  model: string
  prompt: string
  negativePrompt: string
  width: number
  height: number
  filePath: string
  thumbPath: string
  favorite: boolean
  seed: number | null
  durationMs: number
  createdAt: number
  paramsJson: string
  purpose: string
}

export type JobStage = 'queued' | 'requesting' | 'downloading' | 'saving' | 'done' | 'error' | 'canceled'

export interface JobProgress {
  jobId: string
  stage: JobStage
  total: number
  completed: number
  elapsedMs: number
  provider: ProviderId
  model: string
  image?: GeneratedImage
  /** 任务终态快照（done / error / canceled 时携带本次全部产出） */
  images?: GeneratedImage[]
  error?: string
}

// ====== 设置 ======

export interface ProviderConfig {
  apiKey: string
  baseUrl: string
  defaultModel: string
}

export interface DefaultsSettings {
  provider: ProviderId
  purpose: PurposeId
  aspect: AspectRatio
  tier: ResolutionTier
  count: number
  watermark: boolean
  promptExtend: boolean
  promptExtendMode: PromptExtendMode
  optimizeMode: OptimizeMode
  sequential: boolean
  maxImages: number
  downloadDir: string
  quality: QualityTier
  /** 提示词「优化」使用的宿主 LLM（留空则用宿主默认模型） */
  optimizeProviderId: string
  optimizeModelId: string
  /** 数字员工生图工具使用的服务商与模型（留空则跟随默认服务商及其默认模型） */
  toolProvider: ProviderId | ''
  toolModel: string
}

/** 宿主 LLM 模型选项（用于设置中选择「优化」所用模型） */
export interface LlmModelOption {
  providerId: string
  providerName: string
  modelId: string
  modelName: string
}

export interface StudioSettings {
  providers: Record<ProviderId, ProviderConfig>
  defaults: DefaultsSettings
}

export const DEFAULT_SETTINGS: StudioSettings = {
  providers: {
    volcengine: {
      apiKey: '',
      baseUrl: PROVIDERS.volcengine.defaultBaseUrl,
      defaultModel: PROVIDERS.volcengine.defaultModel,
    },
    qwen: {
      apiKey: '',
      baseUrl: PROVIDERS.qwen.defaultBaseUrl,
      defaultModel: PROVIDERS.qwen.defaultModel,
    },
    openai: {
      apiKey: '',
      baseUrl: PROVIDERS.openai.defaultBaseUrl,
      defaultModel: PROVIDERS.openai.defaultModel,
    },
  },
  defaults: {
    provider: 'volcengine',
    purpose: 'ppt-slide',
    aspect: '16:9',
    tier: '2K',
    count: 1,
    watermark: false,
    promptExtend: true,
    promptExtendMode: 'direct',
    optimizeMode: 'standard',
    sequential: false,
    maxImages: 2,
    downloadDir: '',
    quality: 'high',
    optimizeProviderId: '',
    optimizeModelId: '',
    toolProvider: '',
    toolModel: '',
  },
}

export interface PublicProviderConfig {
  id: ProviderId
  baseUrl: string
  defaultModel: string
  hasKey: boolean
  keyMask: string
}

export interface PublicSettings {
  providers: Record<ProviderId, PublicProviderConfig>
  defaults: DefaultsSettings
}

export interface SettingsPatch {
  providers?: Partial<Record<ProviderId, { apiKey?: string; baseUrl?: string; defaultModel?: string }>>
  defaults?: Partial<DefaultsSettings>
}
