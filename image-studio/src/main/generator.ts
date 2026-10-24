/**
 * 生成任务编排：同一时刻可并行多个任务，每个任务独立 AbortController。
 * 外部只通过 start() 拿到 jobId，进度经 emit 回调实时推送。
 */
import crypto from 'crypto'
import {
  getModelSpec,
  resolveSize,
  type GenerateRequest,
  type GeneratedImage,
  type JobProgress,
  type JobStage,
  type ProviderId,
} from '../shared/types'
import { composePrompt } from '../shared/prompt'
import { buildRequest, parseResponse, readErrorResponse } from './providers'
import { getApiKey, getProviderConfig } from './settings-store'
import { insertImage, newImageId, saveImageBuffer } from './images'

const REQUEST_TIMEOUT_MS = 12 * 60 * 1000

export type Translate = (key: string, params?: Record<string, string | number>) => string
export type Emit = (progress: JobProgress) => void

interface Job {
  id: string
  provider: ProviderId
  model: string
  controller: AbortController
  canceled: boolean
  timedOut: boolean
  startedAt: number
  total: number
  completed: number
  images: GeneratedImage[]
}

export class GenerationError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const jobs = new Map<string, Job>()

function jobId(): string {
  return `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mime?: string } | null {
  if (!dataUrl.startsWith('data:')) {
    try {
      return { buffer: Buffer.from(dataUrl, 'base64') }
    } catch {
      return null
    }
  }
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!m) return null
  const mime = m[1] || undefined
  const payload = m[3] || ''
  try {
    return m[2]
      ? { buffer: Buffer.from(payload, 'base64'), mime }
      : { buffer: Buffer.from(decodeURIComponent(payload), 'utf8'), mime }
  } catch {
    return null
  }
}

async function downloadBuffer(url: string, signal: AbortSignal): Promise<{ buffer: Buffer; mime?: string }> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new GenerationError('DownloadFailed', `HTTP ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  return { buffer: Buffer.from(arrayBuffer), mime: res.headers.get('content-type') || undefined }
}

function extFromMime(mime?: string): string {
  if (!mime) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  return 'png'
}

/** OpenAI 的 edits 接口只接受文件上传：参考图为公网 URL 时先下载转 data URL */
async function inlineRemoteReferences(refs: string[], signal: AbortSignal): Promise<string[]> {
  const output: string[] = []
  for (const ref of refs) {
    if (!/^https?:/i.test(ref)) {
      output.push(ref)
      continue
    }
    try {
      const downloaded = await downloadBuffer(ref, signal)
      output.push(`data:${downloaded.mime || 'image/png'};base64,${downloaded.buffer.toString('base64')}`)
    } catch {
      // 单张参考图不可用时保持原 URL，由服务商侧提示具体错误
      output.push(ref)
    }
  }
  return output
}

function stage(emit: Emit, job: Job, stageValue: JobStage, extra?: Partial<JobProgress>): void {
  emit({
    jobId: job.id,
    stage: stageValue,
    total: job.total,
    completed: job.completed,
    elapsedMs: Date.now() - job.startedAt,
    provider: job.provider,
    model: job.model,
    ...extra,
  })
}

export interface StartResult {
  jobId?: string
  error?: string
}

/** 校验并在后台启动任务；同步错误直接返回，避免渲染端等待空事件 */
export function startGeneration(req: GenerateRequest, emit: Emit, t: Translate): StartResult {
  const prompt = (req.prompt || '').trim()
  if (!prompt) return { error: t('errors.emptyPrompt') }
  const apiKey = getApiKey(req.provider)
  if (!apiKey) return { error: t('errors.noApiKey') }

  const cfg = getProviderConfig(req.provider)
  const spec = getModelSpec(req.provider, req.model)
  const size = resolveSize(req.provider, req.model, req.aspect, req.tier, req.customSize)
  const total =
    req.provider === 'volcengine'
      ? req.sequential && spec.supportsSequential
        ? Math.min(15, Math.max(1, Math.round(req.maxImages || 1)))
        : 1
      : Math.min(spec.maxOutputs, Math.max(1, Math.round(req.count || 1)))

  const id = jobId()
  const job: Job = {
    id,
    provider: req.provider,
    model: req.model,
    controller: new AbortController(),
    canceled: false,
    timedOut: false,
    startedAt: Date.now(),
    total,
    completed: 0,
    images: [],
  }
  jobs.set(id, job)
  const timeout = setTimeout(() => {
    job.timedOut = true
    job.controller.abort()
  }, REQUEST_TIMEOUT_MS)

  void run(job, req, apiKey, cfg.baseUrl, size.size, emit, t)
    .catch(() => { /* run 内部已收敛错误并推送 */ })
    .finally(() => {
      clearTimeout(timeout)
      // 保留短暂窗口供渲染端重连读取终态，随后释放
      setTimeout(() => jobs.delete(id), 60_000)
    })

  return { jobId: id }
}

export function cancelGeneration(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  job.canceled = true
  job.controller.abort()
  return true
}

/** 供数字员工工具使用：等待任务终态并返回产出 */
export function generateOnce(
  req: GenerateRequest,
  t: Translate,
  emit?: Emit
): Promise<{ images: GeneratedImage[]; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const result = startGeneration(
      req,
      (progress) => {
        emit?.(progress)
        if (!settled && (progress.stage === 'done' || progress.stage === 'error' || progress.stage === 'canceled')) {
          settled = true
          resolve({ images: progress.images ?? [], error: progress.error })
        }
      },
      t
    )
    if (result.error) resolve({ images: [], error: result.error })
  })
}

async function run(
  job: Job,
  req: GenerateRequest,
  apiKey: string,
  baseUrl: string,
  size: string,
  emit: Emit,
  t: Translate
): Promise<void> {
  try {
    stage(emit, job, 'requesting')
    const spec = getModelSpec(req.provider, req.model)
    const composed = composePrompt(req, spec.supportsNegativePrompt)
    const referenceImages =
      req.provider === 'openai'
        ? await inlineRemoteReferences(req.referenceImages, job.controller.signal)
        : req.referenceImages
    const built = buildRequest(
      req.provider,
      baseUrl,
      apiKey,
      { ...req, prompt: composed.prompt, negativePrompt: composed.negative, referenceImages },
      size
    )
    const res = await fetch(built.url, {
      method: 'POST',
      headers: built.headers,
      body: built.body instanceof FormData ? built.body : JSON.stringify(built.body),
      signal: job.controller.signal,
    })
    if (!res.ok) {
      const detail = await readErrorResponse(res)
      throw new GenerationError(`HTTP ${res.status}`, detail)
    }
    const json = await res.json()
    const parsed = parseResponse(req.provider, json)
    if (parsed.error) throw new GenerationError('ProviderError', parsed.error)
    const outputs = parsed.images
    if (outputs.length === 0) throw new GenerationError('EmptyResult', t('errors.noImage'))

    const errors: string[] = []
    for (let index = 0; index < outputs.length; index++) {
      if (job.canceled) break
      const item = outputs[index]
      if (item.error) {
        errors.push(item.error)
        continue
      }
      stage(emit, job, 'downloading')
      let buffer: Buffer | null = null
      let mime = item.mime
      if (item.base64) {
        const decoded = decodeDataUrl(item.base64)
        if (decoded) {
          buffer = decoded.buffer
          mime = mime || decoded.mime
        }
      } else if (item.url) {
        const downloaded = await downloadBuffer(item.url, job.controller.signal)
        buffer = downloaded.buffer
        mime = mime || downloaded.mime
      }
      if (!buffer) {
        errors.push(t('errors.downloadFailed'))
        continue
      }
      stage(emit, job, 'saving')
      const saved = saveImageBuffer(buffer, mime, extFromMime(mime))
      const record: GeneratedImage = {
        id: newImageId(),
        jobId: job.id,
        provider: req.provider,
        model: req.model,
        prompt: req.prompt.trim(),
        negativePrompt: (req.negativePrompt || '').trim(),
        width: saved.width,
        height: saved.height,
        filePath: saved.filePath,
        thumbPath: saved.thumbPath,
        favorite: false,
        seed: typeof req.seed === 'number' ? req.seed : null,
        durationMs: Date.now() - job.startedAt,
        createdAt: Date.now(),
        purpose: req.purpose || 'free',
        paramsJson: JSON.stringify({
          provider: req.provider,
          model: req.model,
          size,
          aspect: req.aspect,
          tier: req.tier,
          count: req.count,
          seed: req.seed ?? null,
          watermark: req.watermark,
          promptExtend: req.promptExtend,
          promptExtendMode: req.promptExtendMode,
          optimizeMode: req.optimizeMode,
          sequential: req.sequential,
          maxImages: req.maxImages,
          references: referenceImages.length,
          purpose: req.purpose,
          styleKey: req.styleKey,
          palette: req.palette,
          density: req.density,
          textSpace: req.textSpace,
          noText: req.noText,
          titleEnabled: req.titleEnabled,
          title: req.title,
          subtitle: req.subtitle,
          textLanguage: req.textLanguage,
          transparent: req.transparent,
          quality: req.quality,
        }),
      }
      insertImage(record)
      job.images.push(record)
      job.completed = job.images.length
      stage(emit, job, 'saving', { image: record })
    }

    if (job.canceled) {
      stage(emit, job, 'canceled', { images: job.images, error: t('errors.canceled') })
      return
    }
    if (job.images.length === 0) {
      throw new GenerationError('AllFailed', errors[0] || t('errors.noImage'))
    }
    stage(emit, job, 'done', { images: job.images, error: errors.length ? errors[0] : undefined })
  } catch (err: any) {
    if (job.canceled) {
      stage(emit, job, 'canceled', { images: job.images, error: t('errors.canceled') })
      return
    }
    if (job.timedOut) {
      stage(emit, job, 'error', { images: job.images, error: t('errors.timeout') })
      return
    }
    const message =
      err instanceof GenerationError && (err.code === 'HTTP 401' || err.code === 'HTTP 403')
        ? t('errors.invalidKey')
        : err?.name === 'AbortError'
          ? t('errors.canceled')
          : err?.message || t('errors.requestFailed')
    stage(emit, job, 'error', { images: job.images, error: message })
  }
}
