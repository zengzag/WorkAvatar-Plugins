/**
 * 提示词编排：把用途、风格、配色、留白、图内文字等结构化选项组合成最终提示词。
 * 渲染端用它展示「最终提示词」，主进程用它构造请求，保证两侧完全一致。
 */
import type {
  DensityId,
  GenerateRequest,
  PaletteId,
  PurposeId,
  TextLanguage,
  TextSpace,
} from './types'

const PURPOSE_SUFFIX: Record<PurposeId, string> = {
  'ppt-slide':
    'flat vector illustration designed as a presentation slide visual, clean minimal composition, soft even lighting, subtle depth, professional corporate aesthetic, high legibility when projected',
  'ppt-cover':
    'modern presentation cover artwork, bold abstract geometric shapes, cinematic gradient lighting, strong focal point, generous clean space for a title, premium corporate aesthetic',
  'sci-schematic':
    'scientific schematic illustration, flat vector diagram style, clean uniform line weights, concrete scientific objects with short readable labels, restrained academic colors, crisp shapes, clear visual hierarchy, isolated on a plain white background, no empty placeholder boxes or frame-only layout',
  'paper-figure':
    'labeled graphical abstract for a research paper, clean scientific vector style, concrete scientific objects with short labels and clear flow arrows, cohesive restrained palette, plain white background, high clarity, no empty placeholder boxes or frame-only layout',
  chart:
    'clean data visualization illustration, flat chart-inspired graphics with bars, lines and nodes, organized grid layout, generous spacing, professional analytical aesthetic, plain white background',
  infographic:
    'modern infographic illustration, structured layout with connected blocks and icons, clear grouping, soft corporate palette, generous spacing',
  architecture:
    'clean system architecture diagram, labeled modular component blocks connected by directional arrows, layered hierarchy, aligned grid layout, flat vector style with uniform line weights, professional technical aesthetic, plain white background, no empty placeholder boxes',
  flowchart:
    'clean process flowchart diagram, labeled sequential steps connected by arrows, rounded process nodes and decision diamonds, consistent spacing, clear left-to-right flow hierarchy, flat vector style, plain white background, no empty placeholder boxes',
  poster:
    'academic conference poster background artwork, scientific visual metaphor, restrained professional palette, large calm areas reserved for text',
  free: '',
}

const STYLE_SUFFIX: Record<string, string> = {
  photography: 'cinematic photography, soft natural light, shallow depth of field, film grain, high detail',
  illustration: 'refined digital illustration, clean lines, soft palette, delicate lighting',
  threeD: '3D render, soft studio lighting, fine materials, subtle ambient occlusion, ultra detailed',
  chinese: 'Chinese ink wash painting, negative space composition, rice paper texture, muted palette',
  poster: 'commercial poster design, premium typography space, clear focal point, exquisite details',
  anime: 'Japanese anime style, bright colors, delicate line art, clean background',
  cyberpunk: 'cyberpunk, neon lights, futuristic city, high contrast colors',
  minimal: 'minimalism, generous negative space, clean background, soft shadows',
  flatVector: 'flat vector design, crisp geometric shapes, solid color fills, uniform stroke weights, no gradients',
  isometric: 'isometric 2.5D illustration, clean geometric blocks, subtle ambient shadows, technical aesthetic',
  blueprint: 'technical blueprint drawing, precise thin white lines on a deep blue grid, schematic look, monochrome',
  schematic: 'scientific schematic style, simplified geometry, uniform line weights, restrained academic colors',
  lineart: 'minimal line art, thin consistent monochrome strokes, generous white space, elegant simplicity',
  gradient: 'modern tech gradient aesthetic, deep navy background with cyan and violet glow, subtle glass panels, corporate feel',
}

const PALETTE_SUFFIX: Record<PaletteId, string> = {
  auto: '',
  academic: 'restrained academic palette of slate blue, teal, warm gray and off-white',
  corporate: 'professional corporate palette of navy, steel blue, light gray with a warm accent',
  warm: 'warm palette of amber, terracotta and cream',
  mono: 'monochrome palette of black, white and grays',
  darkTech: 'dark tech palette with a deep navy background and cyan, violet accents, subtle glow',
  pastel: 'soft pastel palette of mint, blush, sky blue and cream',
}

const DENSITY_SUFFIX: Record<DensityId, string> = {
  minimal: 'minimal composition, few elements, generous negative space, strong single focal point',
  balanced: '',
  rich: 'richly detailed composition with layered elements while keeping a clear hierarchy',
}

const TEXT_SPACE_SUFFIX: Record<TextSpace, string> = {
  none: '',
  top: 'leave a clean uncluttered empty band across the top third of the image for a title added later',
  bottom: 'leave a clean uncluttered empty band across the bottom third of the image for a caption added later',
  left: 'leave a clean uncluttered vertical empty area on the left side for a title added later',
  right: 'leave a clean uncluttered vertical empty area on the right side for a title added later',
}

const LANGUAGE_NAME: Record<TextLanguage, string> = {
  zh: 'Simplified Chinese',
  en: 'English',
}

export interface ComposedPrompt {
  prompt: string
  negative: string
}

const BASE_NEGATIVE = 'watermark, signature, logo, low resolution, jpeg artifacts, blurry, distorted, cropped'

/** 拼接最终正向提示词；negative 是否随请求发送由服务商能力决定 */
export function composePrompt(req: GenerateRequest, supportsNegativePrompt: boolean): ComposedPrompt {
  const suffix: string[] = []
  const purposeSuffix = PURPOSE_SUFFIX[req.purpose]
  if (purposeSuffix) suffix.push(purposeSuffix)
  if (req.styleKey && STYLE_SUFFIX[req.styleKey]) suffix.push(STYLE_SUFFIX[req.styleKey])
  if (PALETTE_SUFFIX[req.palette]) suffix.push(PALETTE_SUFFIX[req.palette])
  if (DENSITY_SUFFIX[req.density]) suffix.push(DENSITY_SUFFIX[req.density])
  if (TEXT_SPACE_SUFFIX[req.textSpace]) suffix.push(TEXT_SPACE_SUFFIX[req.textSpace])
  if (req.transparent) {
    suffix.push(
      req.purpose === 'free'
        ? 'isolated subject on a transparent background, no backdrop, alpha channel'
        : 'transparent background, no backdrop, alpha channel'
    )
  }

  const title = req.titleEnabled ? req.title.trim() : ''
  const subtitle = req.titleEnabled ? req.subtitle.trim() : ''
  if (title || subtitle) {
    const lines = ['Render the following text inside the image, spelled exactly and clearly, with clean professional typography:']
    if (title) lines.push(`title "${title}"`)
    if (subtitle) lines.push(`subtitle "${subtitle}"`)
    lines.push(`Text language: ${LANGUAGE_NAME[req.textLanguage]}. Do not add any other words.`)
    suffix.push(lines.join(' '))
  } else if (req.noText) {
    suffix.push('strictly no text, no letters, no numbers, no labels and no watermark anywhere in the image')
  }

  const prompt = [req.prompt.trim(), ...suffix].filter(Boolean).join('. ')

  const negativeParts = [req.negativePrompt?.trim() || '', BASE_NEGATIVE]
  if (req.noText && !title) negativeParts.push('text, letters, numbers, labels, captions')
  const negative = negativeParts.filter(Boolean).join(', ')

  // 不支持 negative_prompt 的服务商：把关键负向约束并入正向描述，仍能起作用
  if (!supportsNegativePrompt) {
    const extra = [`Avoid: ${negative}`]
    return { prompt: [prompt, ...extra].join('. '), negative }
  }
  return { prompt, negative }
}
