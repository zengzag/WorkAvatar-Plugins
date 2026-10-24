/**
 * 服务商协议适配：
 * - 火山方舟 Seedream：POST {baseUrl}/images/generations（OpenAI Images 风格 + Seedream 扩展字段）
 * - 阿里云百炼 Qwen Image：OpenAI 兼容 POST {baseUrl}/images/generations
 * - OpenAI：POST {baseUrl}/images/generations；带参考图时改走 multipart {baseUrl}/images/edits
 * 仅保留 HTTP 协议层，不依赖任何服务商 SDK。
 */
import { getModelSpec, type GenerateRequest, type ProviderId } from '../shared/types'

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown> | FormData
}

export interface RawImage {
  base64?: string
  url?: string
  mime?: string
  size?: string
  error?: string
}

export interface ParsedResponse {
  images: RawImage[]
  error?: string
}

export interface TestOutcome {
  ok: boolean
  code: 'ok' | 'invalidKey' | 'notFound' | 'network' | 'server' | 'unknown'
  detail?: string
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith(path)) return base
  return `${base}${path}`
}

/** 允许用户直接粘贴完整 endpoint（避免重复拼接） */
function endpoint(baseUrl: string, path = '/images/generations'): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/images\/(generations|edits)$/i.test(trimmed)) {
    return path === '/images/edits' ? trimmed.replace(/\/generations$/i, '/edits') : trimmed
  }
  return joinUrl(trimmed, path)
}

const DASHSCOPE_QWEN_PATH = '/api/v1/services/aigc/multimodal-generation/generation'

/** 千问有两种协议：compatible-mode 走 OpenAI 兼容；其余（业务空间域名 / api/v1）走 DashScope 原生 */
function isQwenDashScope(baseUrl: string): boolean {
  const trimmed = baseUrl.trim()
  if (/compatible-mode/i.test(trimmed)) return false
  return !/\/images\/(generations|edits)$/i.test(trimmed)
}

function qwenEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/multimodal-generation\/generation$/i.test(trimmed)) return trimmed
  if (/\/api\/v1$/i.test(trimmed)) return `${trimmed}/services/aigc/multimodal-generation/generation`
  return `${trimmed}${DASHSCOPE_QWEN_PATH}`
}

/** DashScope 原生请求体：input.messages + parameters，size 使用 `宽*高` */
function buildQwenDashScopeBody(
  req: GenerateRequest,
  refs: string[],
  size: string,
  outputCount: number
): Record<string, unknown> {
  const spec = getModelSpec('qwen', req.model)
  const content: Array<Record<string, string>> = [{ text: req.prompt }]
  for (const ref of refs) content.push({ image: ref })

  const parameters: Record<string, unknown> = {
    n: outputCount,
    size: size.replace(/x/i, '*'),
    prompt_extend: Boolean(req.promptExtend),
    watermark: Boolean(req.watermark),
  }
  if (spec.supportsPromptExtend && req.promptExtend) {
    parameters.prompt_extend_mode =
      spec.promptExtendModes.includes(req.promptExtendMode) && !(refs.length > 0 && req.promptExtendMode === 'agent')
        ? req.promptExtendMode
        : 'direct'
  }
  if (spec.supportsNegativePrompt && req.negativePrompt?.trim()) {
    parameters.negative_prompt = req.negativePrompt.trim()
  }
  if (typeof req.seed === 'number' && req.seed >= 0) parameters.seed = req.seed

  return {
    model: req.model,
    input: { messages: [{ role: 'user', content }] },
    parameters,
  }
}

function normalizeRefs(refs: string[]): string[] {
  return refs.map((r) => r.trim()).filter(Boolean)
}

function parseDataUrl(dataUrl: string): { buffer: Buffer; mime: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!m) return null
  const mime = m[1] || 'image/png'
  try {
    const buffer = m[2] ? Buffer.from(m[3] || '', 'base64') : Buffer.from(decodeURIComponent(m[3] || ''), 'utf8')
    return { buffer, mime }
  } catch {
    return null
  }
}

function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  return 'png'
}

export function buildRequest(
  provider: ProviderId,
  baseUrl: string,
  apiKey: string,
  req: GenerateRequest,
  size: string
): BuiltRequest {
  const spec = getModelSpec(provider, req.model)
  const refs = normalizeRefs(req.referenceImages).slice(0, spec.maxRefImages)
  const outputCount = Math.min(spec.maxOutputs, Math.max(1, Math.round(req.count || 1)))

  if (provider === 'volcengine') {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      size,
      response_format: 'url',
      watermark: req.watermark,
    }
    if (refs.length > 0) body.image = refs.length === 1 ? refs[0] : refs
    if (req.sequential && spec.supportsSequential) {
      // 文档约束：参考图数量 + 生成张数 ≤ 15
      const maxByRefs = Math.max(1, 15 - refs.length)
      body.sequential_image_generation = 'auto'
      body.sequential_image_generation_options = {
        max_images: Math.min(maxByRefs, Math.max(1, Math.round(req.maxImages || 1))),
      }
    }
    if (spec.optimizeModes.length > 0) {
      body.optimize_prompt_options = {
        mode: spec.optimizeModes.includes(req.optimizeMode) ? req.optimizeMode : 'standard',
      }
    }
    return { url: endpoint(baseUrl), headers, body }
  }

  if (provider === 'qwen') {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    if (isQwenDashScope(baseUrl)) {
      return { url: qwenEndpoint(baseUrl), headers, body: buildQwenDashScopeBody(req, refs, size, outputCount) }
    }
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      size,
      n: outputCount,
      watermark: req.watermark,
      prompt_extend: req.promptExtend,
    }
    if (spec.supportsPromptExtend && req.promptExtend) {
      body.prompt_extend_mode =
        spec.promptExtendModes.includes(req.promptExtendMode) && !(refs.length > 0 && req.promptExtendMode === 'agent')
          ? req.promptExtendMode
          : 'direct'
    }
    if (spec.supportsNegativePrompt && req.negativePrompt?.trim()) {
      body.negative_prompt = req.negativePrompt.trim()
    }
    if (typeof req.seed === 'number' && req.seed >= 0) body.seed = req.seed
    if (refs.length > 0) body.image = refs.length === 1 ? refs[0] : refs
    return { url: endpoint(baseUrl), headers, body }
  }

  // ====== OpenAI ======
  const useEdits = refs.length > 0 && Boolean(spec.supportsEdits)
  if (!useEdits) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    const body: Record<string, unknown> = {
      model: req.model,
      prompt: req.prompt,
      n: outputCount,
      size,
    }
    if (spec.supportsQuality) body.quality = req.quality === 'auto' ? 'auto' : req.quality
    if (spec.supportsTransparent && req.transparent) {
      body.background = 'transparent'
      body.output_format = 'png'
    }
    return { url: endpoint(baseUrl), headers, body }
  }

  // images/edits 仅接受文件上传，参考图须为 data URL（远程 URL 由调用方预先下载）
  const form = new FormData()
  form.append('model', req.model)
  form.append('prompt', req.prompt)
  form.append('n', String(outputCount))
  form.append('size', size)
  if (spec.supportsQuality) form.append('quality', req.quality === 'auto' ? 'auto' : req.quality)
  if (spec.supportsTransparent && req.transparent) {
    form.append('background', 'transparent')
    form.append('output_format', 'png')
  }
  for (const ref of refs) {
    const parsed = parseDataUrl(ref)
    if (!parsed) continue
    const bytes = new Uint8Array(parsed.buffer.byteLength)
    bytes.set(parsed.buffer)
    const ext = extFromMime(parsed.mime)
    form.append('image[]', new Blob([bytes], { type: parsed.mime }), `reference.${ext}`)
  }
  return {
    url: endpoint(baseUrl, '/images/edits'),
    // multipart 由运行时补 boundary，不能手动设置 Content-Type
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }
}

export function parseResponse(provider: ProviderId, json: unknown): ParsedResponse {
  if (!json || typeof json !== 'object') {
    return { images: [], error: 'InvalidResponse' }
  }
  const root = json as Record<string, any>
  const images: RawImage[] = []

  // DashScope 原生协议（千问）：output.choices[].message.content[].image
  if (provider === 'qwen') {
    const choices = Array.isArray(root.output?.choices) ? root.output.choices : []
    for (const choice of choices) {
      const content = choice?.message?.content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (part && typeof part.image === 'string' && part.image) images.push({ url: part.image })
      }
    }
  }

  // OpenAI Images 风格（火山 / OpenAI / 千问 compatible-mode）
  const data = Array.isArray(root.data) ? root.data : []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    if (item.error) {
      const error = item.error
      images.push({
        error:
          typeof error === 'string'
            ? error
            : error?.message || error?.code || 'ImageGenerationFailed',
      })
      continue
    }
    const url = typeof item.url === 'string' ? item.url : undefined
    const base64 = typeof item.b64_json === 'string' ? item.b64_json : undefined
    if (url || base64) {
      images.push({
        url,
        base64,
        mime:
          typeof item.output_format === 'string'
            ? `image/${item.output_format === 'jpg' ? 'jpeg' : item.output_format}`
            : undefined,
        size: typeof item.size === 'string' ? item.size : undefined,
      })
    }
  }
  if (images.length === 0 && root.error) {
    return { images: [], error: root.error?.message || root.error?.code || 'RequestFailed' }
  }
  if (images.length === 0) {
    // DashScope 失败时以 { code, message } 返回
    const message = root.message || root.output?.message || root.code
    if (typeof message === 'string' && message) return { images: [], error: message }
  }
  return { images }
}

/** 解析 HTTP 非 2xx 错误文案 */
export async function readErrorResponse(res: Response): Promise<string> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    return `HTTP ${res.status}`
  }
  try {
    const json = JSON.parse(text) as Record<string, any>
    const msg = json?.error?.message || json?.message || json?.error?.code || json?.code
    if (typeof msg === 'string' && msg) return msg
  } catch { /* 非 JSON，保留下方文本 */ }
  return text.slice(0, 400) || `HTTP ${res.status}`
}

/**
 * 连通性测试：故意发送空 prompt。
 * 服务端在鉴权通过后返回 400/422（参数不合法），可据此区分 Key 有效性与网络问题，且不会产生图片计费。
 */
export async function testConnection(
  provider: ProviderId,
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<TestOutcome> {
  const qwenDashScope = provider === 'qwen' && isQwenDashScope(baseUrl)
  const body: Record<string, unknown> =
    provider === 'volcengine'
      ? { model, prompt: '', size: '1024x1024' }
      : provider === 'qwen'
        ? qwenDashScope
          ? { model, input: { messages: [{ role: 'user', content: [{ text: '' }] }] }, parameters: { prompt_extend: false } }
          : { model, prompt: '', n: 1 }
        : { model, prompt: '', n: 1, size: '1024x1024' }
  let res: Response
  try {
    res = await fetch(qwenDashScope ? qwenEndpoint(baseUrl) : endpoint(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err: any) {
    return { ok: false, code: 'network', detail: err?.message || String(err) }
  }
  if (res.ok) return { ok: true, code: 'ok' }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: 'invalidKey', detail: await readErrorResponse(res) }
  }
  if (res.status === 400 || res.status === 422 || res.status === 429) {
    return { ok: true, code: 'ok' }
  }
  if (res.status === 404) {
    return { ok: false, code: 'notFound', detail: await readErrorResponse(res) }
  }
  if (res.status >= 500) {
    return { ok: false, code: 'server', detail: await readErrorResponse(res) }
  }
  return { ok: false, code: 'unknown', detail: await readErrorResponse(res) }
}
