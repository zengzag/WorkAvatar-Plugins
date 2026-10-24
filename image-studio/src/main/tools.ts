/**
 * 数字员工工具：在对话中直接生成图片，产出与插件页共用同一作品库。
 * 所用模型由插件设置中的「生图工具模型」决定。
 */
import fs from 'fs'
import path from 'path'
import type { PluginContext } from '@workavatar/plugin-sdk'
import {
  ASPECTS,
  PURPOSE_IDS,
  PURPOSE_PRESETS,
  getModelSpec,
  normalizeTier,
  type AspectRatio,
  type GenerateRequest,
  type PurposeId,
} from '../shared/types'
import { awaitSettings, getSettings, getToolModel } from './settings-store'
import { generateOnce } from './generator'

const ASPECT_VALUES = new Set<string>(ASPECTS.map((a) => a.value))
const PURPOSE_VALUES = new Set<string>(PURPOSE_IDS)

export function registerImageTool(ctx: PluginContext): void {
  const t = (key: string, params?: Record<string, string | number>) => ctx.services.i18n.t(key, params)

  ctx.contributions.registerAgentTools([
    {
      id: 'image_generate',
      name: 'image_generate',
      title: '生成图片',
      summary: '生成 PPT 配图、科研配图或通用图片，并保存到本地作品库',
      description: `生成图片并保存到本地作品库，返回图片的本地绝对路径（图片已下载落盘）。

所用服务商与模型由用户在「生图工作室 → 设置 → 生成偏好 → 生图工具模型」中配置，无需在参数中指定。

参数：
- prompt（必填）：画面描述。建议只描述主体与内容，版式/风格/留白交给 purpose 等参数控制
- purpose：用途预设，决定默认比例与画面风格。可选 ppt-slide（PPT 配图）、ppt-cover（PPT 封面）、sci-schematic（科研示意图）、paper-figure（论文插图）、chart（数据图表）、infographic（信息图）、architecture（架构图）、flowchart（流程图）、poster（学术海报）、free（自由创作）。默认取用户设置
- aspect：画面比例，可选 ${ASPECTS.map((a) => a.value).join(' / ')}；不传则用用途预设（PPT 为 16:9）
- size：自定义尺寸，如 1920x1080（优先级高于 aspect）
- title / subtitle：需要模型在图中渲染的文字（可选，易出现错字，建议改用标题排版）
- no_text：是否禁止图中出现任何文字（科研配图推荐 true）
- transparent：是否输出透明背景（需模型支持）
- reference_images：参考图数组，支持公网 URL 或 data:image/...;base64,...（图生图/多图融合）

返回每张图片的本地绝对路径。若用户未配置 API Key 会返回错误，此时提示用户打开「生图工作室 → 设置」配置。`,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述提示词' },
          purpose: {
            type: 'string',
            enum: PURPOSE_IDS,
            description: '用途预设，决定默认比例与画面风格',
          },
          aspect: {
            type: 'string',
            enum: ASPECTS.map((a) => a.value),
            description: '画面比例',
          },
          size: { type: 'string', description: '自定义尺寸，如 1920x1080' },
          title: { type: 'string', description: '图中渲染的主标题（可选）' },
          subtitle: { type: 'string', description: '图中渲染的副标题（可选）' },
          no_text: { type: 'boolean', description: '禁止图中出现文字' },
          transparent: { type: 'boolean', description: '输出透明背景' },
          reference_images: {
            type: 'array',
            items: { type: 'string' },
            description: '参考图 URL 或 data URL 数组',
          },
        },
        required: ['prompt'],
      },
      permission: 'safe',
      timeoutMs: 12 * 60 * 1000,
      handler: async (args) => {
        await awaitSettings()
        const defaults = getSettings().defaults
        const { provider, model } = getToolModel()
        const spec = getModelSpec(provider, model)
        const purpose = (
          typeof args.purpose === 'string' && PURPOSE_VALUES.has(args.purpose) ? args.purpose : defaults.purpose
        ) as PurposeId
        const aspectArg =
          typeof args.aspect === 'string' && ASPECT_VALUES.has(args.aspect)
            ? (args.aspect as AspectRatio)
            : defaults.aspect
        const title = typeof args.title === 'string' ? args.title : ''
        const subtitle = typeof args.subtitle === 'string' ? args.subtitle : ''

        const request: GenerateRequest = {
          provider,
          model,
          prompt: String(args.prompt || ''),
          negativePrompt: '',
          aspect: aspectArg,
          tier: normalizeTier(provider, model, aspectArg, defaults.tier),
          customSize: typeof args.size === 'string' ? args.size : undefined,
          count: 1,
          seed: null,
          watermark: defaults.watermark,
          promptExtend: defaults.promptExtend,
          promptExtendMode: defaults.promptExtendMode,
          optimizeMode: defaults.optimizeMode,
          sequential: false,
          maxImages: 1,
          referenceImages: Array.isArray(args.reference_images)
            ? (args.reference_images as unknown[]).filter((x): x is string => typeof x === 'string')
            : [],
          purpose,
          styleKey: '',
          palette: 'auto',
          density: 'balanced',
          textSpace: 'none',
          noText: typeof args.no_text === 'boolean' ? args.no_text : PURPOSE_PRESETS[purpose].noText,
          titleEnabled: Boolean(title || subtitle),
          title,
          subtitle,
          textLanguage: 'zh',
          transparent: Boolean(args.transparent) && Boolean(spec.supportsTransparent),
          quality: defaults.quality,
        }
        const result = await generateOnce(request, t, (progress) => ctx.ipc.broadcast('gen-progress', progress))
        if (result.images.length === 0) {
          return { success: false, error: result.error || t('errors.noImage') }
        }
        const lines = result.images.map((img) => `- ${img.filePath}`)
        const generatedFiles = result.images.map((img) => {
          let size = 0
          let mtime = img.createdAt
          try {
            const stat = fs.statSync(img.filePath)
            size = stat.size
            mtime = stat.mtimeMs
          } catch { /* 忽略统计失败 */ }
          return {
            path: img.filePath,
            name: path.basename(img.filePath),
            ext: path.extname(img.filePath).slice(1),
            size,
            mtime,
          }
        })
        return {
          success: true,
          output: `已生成 ${result.images.length} 张图片（${provider} · ${model}）：\n${lines.join('\n')}`,
          generatedFiles,
        }
      },
    },
  ])
}
