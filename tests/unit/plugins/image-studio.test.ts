import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { createMockContext } from '../../helpers/mock-plugin-context'
import { buildRequest, parseResponse } from '../../../image-studio/src/main/providers'
import { buildOptimizeMessage, cleanOptimizedPrompt } from '../../../image-studio/src/main/optimize'
import { composePrompt } from '../../../image-studio/src/shared/prompt'
import {
  PROVIDERS,
  getSupportedAspects,
  getSupportedTiers,
  normalizeTier,
  resolveSize,
  getModelSpec,
  type GenerateRequest,
} from '../../../image-studio/src/shared/types'

// mock electron（vitest node 环境无 electron）
vi.mock('electron', () => ({
  app: { getPath: () => '/mock' },
  shell: {
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => {}),
  },
  dialog: {
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromPath: () => ({ isEmpty: () => true }),
  },
  clipboard: {
    write: vi.fn(async () => {}),
  },
  ClipboardItem: class {
    constructor(public items: Record<string, unknown>) {}
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))

const baseRequest = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  provider: 'volcengine',
  model: 'doubao-seedream-4-0-250828',
  prompt: 'a cat',
  negativePrompt: '',
  aspect: '1:1',
  tier: '2K',
  count: 1,
  seed: null,
  watermark: false,
  promptExtend: true,
  promptExtendMode: 'direct',
  optimizeMode: 'standard',
  sequential: false,
  maxImages: 2,
  referenceImages: [],
  purpose: 'free',
  styleKey: '',
  palette: 'auto',
  density: 'balanced',
  textSpace: 'none',
  noText: false,
  titleEnabled: false,
  title: '',
  subtitle: '',
  textLanguage: 'zh',
  transparent: false,
  quality: 'high',
  ...over,
})

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

describe('image-studio 尺寸解析', () => {
  it('Seedream 档位映射命中官方宽高', () => {
    expect(resolveSize('volcengine', 'doubao-seedream-4-0-250828', '1:1', '1K').size).toBe('1024x1024')
    expect(resolveSize('volcengine', 'doubao-seedream-4-0-250828', '16:9', '2K').size).toBe('2848x1600')
    expect(resolveSize('volcengine', 'doubao-seedream-4-0-250828', '9:16', '4K').size).toBe('3040x5504')
  })

  it('不支持的档位回退到模型默认档位，并收敛超上限像素', () => {
    const spec = getModelSpec('volcengine', 'doubao-seedream-5-0-pro-260628')
    expect(spec.tiers).not.toContain('4K')
    expect(resolveSize('volcengine', spec.id, '1:1', '4K').size).toBe('2048x2048')
    const wide = resolveSize('volcengine', spec.id, '21:9', '2K')
    expect(wide.width * wide.height).toBeLessThanOrEqual(2048 * 2048)
    expect(wide.width % 16).toBe(0)
    expect(wide.height % 16).toBe(0)
  })

  it('火山模型列表含 Seedream 5.0 Flash，已下线 5.0 Lite', () => {
    const ids = PROVIDERS.volcengine.models.map((model) => model.id)
    expect(ids).toContain('doubao-seedream-5-0-flash-260915')
    expect(ids).not.toContain('doubao-seedream-5-0-lite-260128')
    expect(getModelSpec('volcengine', 'doubao-seedream-5-0-flash-260915').tiers).toEqual(['2K', '3K'])
  })

  it('千问 2K 不超过单边 2048', () => {
    const size = resolveSize('qwen', 'qwen-image-2.1-turbo', '16:9', '2K')
    expect(size.width).toBeLessThanOrEqual(2048)
    expect(size.height).toBeLessThanOrEqual(2048)
  })

  it('自定义尺寸优先且兼容 * 分隔', () => {
    expect(resolveSize('qwen', 'qwen-image-2.1-turbo', '1:1', '2K', '1536*1024')).toEqual({
      size: '1536x1024',
      width: 1536,
      height: 1024,
    })
  })

  it('OpenAI 固定尺寸与比例能力', () => {
    expect(getSupportedAspects('openai', 'gpt-image-1.5')).toEqual(['1:1', '3:2', '2:3'])
    expect(getSupportedAspects('openai', 'gpt-image-2')).toContain('16:9')
    expect(resolveSize('openai', 'gpt-image-1.5', '1:1', '1K').size).toBe('1024x1024')
    expect(resolveSize('openai', 'gpt-image-2', '16:9', '2K').size).toBe('1920x1080')
    expect(resolveSize('openai', 'gpt-image-2', '16:9', '4K').size).toBe('3840x2160')
    expect(getSupportedTiers('openai', 'gpt-image-2', '1:1')).toEqual(['1K'])
    expect(normalizeTier('openai', 'gpt-image-2', '1:1', '4K')).toBe('1K')
    // 1.5 不支持 16:9 → 回退到首个支持比例
    expect(resolveSize('openai', 'gpt-image-1.5', '16:9', '1K').size).toBe('1024x1024')
  })
})

describe('image-studio 提示词编排', () => {
  it('场景预设拼接留白、无文字与负向约束', () => {
    const composed = composePrompt(
      baseRequest({
        purpose: 'ppt-slide',
        textSpace: 'right',
        noText: true,
        palette: 'corporate',
      }),
      false
    )
    expect(composed.prompt).toContain('presentation slide visual')
    expect(composed.prompt).toContain('right side')
    expect(composed.prompt).toContain('no text')
    expect(composed.prompt).toContain('professional corporate palette')
    expect(composed.prompt).toContain('Avoid:')
  })

  it('指定标题时不再附加无文字约束，并写入目标语言', () => {
    const composed = composePrompt(
      baseRequest({ titleEnabled: true, title: '研究背景', subtitle: '问题与假设', noText: true, textLanguage: 'zh' }),
      true
    )
    expect(composed.prompt).toContain('"研究背景"')
    expect(composed.prompt).toContain('Simplified Chinese')
    expect(composed.prompt).not.toContain('strictly no text')
    expect(composed.negative).toContain('watermark')
  })

  it('自由创作不附加场景后缀', () => {
    const composed = composePrompt(baseRequest({ prompt: 'a cat on a sofa' }), true)
    expect(composed.prompt.startsWith('a cat on a sofa')).toBe(true)
    expect(composed.prompt).not.toContain('presentation slide')
  })

  it('风格选「无」时不拼接任何风格提示词', () => {
    expect(composePrompt(baseRequest({ prompt: 'a cat' }), true).prompt).toBe('a cat')
    expect(composePrompt(baseRequest({ prompt: 'a cat', styleKey: 'flatVector' }), true).prompt).toContain('flat vector')
  })

  it('架构图 / 流程图用途追加对应示意图描述，无文字开关默认不生效', () => {
    const architecture = composePrompt(baseRequest({ purpose: 'architecture', prompt: 'four layers' }), true)
    expect(architecture.prompt).toContain('system architecture diagram')
    expect(architecture.prompt).not.toContain('strictly no text')

    const flowchart = composePrompt(baseRequest({ purpose: 'flowchart', prompt: 'five steps' }), true)
    expect(flowchart.prompt).toContain('process flowchart diagram')
  })
})

describe('image-studio 提示词优化', () => {
  it('优化请求带上用途、比例与风格约束', () => {
    const message = buildOptimizeMessage({
      prompt: 'AI 客服系统',
      purposeLabel: '架构图',
      aspect: '16:9',
      styleLabel: '扁平矢量',
    })
    expect(message).toContain('Scene type: 架构图')
    expect(message).toContain('Aspect ratio: 16:9')
    expect(message).toContain('Style hint: 扁平矢量')
    expect(message).toContain('User request: AI 客服系统')
    // 优化只做改写，不注入任何额外限制
    expect(message).not.toContain('Text in image')
  })

  it('清理模型输出中的代码块、前缀标签与引号', () => {
    expect(cleanOptimizedPrompt('```\nPrompt: "a clean diagram"\n```')).toBe('a clean diagram')
    expect(cleanOptimizedPrompt('优化后的提示词：一幅极简架构图')).toBe('一幅极简架构图')
  })
})

describe('image-studio 服务商请求', () => {
  it('Seedream 组图与参考图字段', () => {
    const built = buildRequest(
      'volcengine',
      'https://ark.example.com/api/v3',
      'key',
      baseRequest({ sequential: true, maxImages: 3, referenceImages: [DATA_URL, 'https://a/b.png'] }),
      '2048x2048'
    )
    expect(built.url).toBe('https://ark.example.com/api/v3/images/generations')
    expect(built.headers.Authorization).toBe('Bearer key')
    expect(built.body).not.toBeInstanceOf(FormData)
    const body = built.body as Record<string, unknown>
    expect(body.sequential_image_generation).toBe('auto')
    expect(body.sequential_image_generation_options).toEqual({ max_images: 3 })
    expect(body.image).toEqual([DATA_URL, 'https://a/b.png'])
    expect(body.response_format).toBe('url')
  })

  it('千问 DashScope 协议：业务空间域名自动补全 endpoint 并嵌套请求体', () => {
    const built = buildRequest(
      'qwen',
      'https://ws-demo.cn-beijing.maas.aliyuncs.com',
      'key',
      baseRequest({
        provider: 'qwen',
        model: 'qwen-image-3.0',
        count: 2,
        promptExtend: true,
        promptExtendMode: 'direct',
        negativePrompt: 'blur',
        seed: 42,
      }),
      '2048x1152'
    )
    expect(built.url).toBe(
      'https://ws-demo.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    )
    const body = built.body as any
    expect(body.model).toBe('qwen-image-3.0')
    expect(body.input.messages[0].role).toBe('user')
    expect(body.input.messages[0].content[0].text).toBe('a cat')
    expect(body.parameters).toEqual({
      n: 2,
      size: '2048*1152',
      prompt_extend: true,
      prompt_extend_mode: 'direct',
      watermark: false,
      negative_prompt: 'blur',
      seed: 42,
    })
  })

  it('千问 DashScope 协议：完整 generation URL 与参考图', () => {
    const endpoint = 'https://ws-demo.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
    const built = buildRequest(
      'qwen',
      endpoint,
      'key',
      baseRequest({
        provider: 'qwen',
        model: 'qwen-image-3.0-pro',
        promptExtendMode: 'agent',
        referenceImages: [DATA_URL],
      }),
      '1024x1024'
    )
    expect(built.url).toBe(endpoint)
    const content = (built.body as any).input.messages[0].content as Array<Record<string, string>>
    expect(content[1].image).toBe(DATA_URL)
    // 图生图不支持 agent 增强，自动降级 direct
    expect((built.body as any).parameters.prompt_extend_mode).toBe('direct')
  })

  it('解析千问 DashScope 响应与错误', () => {
    const parsed = parseResponse('qwen', {
      output: { choices: [{ message: { content: [{ image: 'https://x/y.png' }] } }] },
    })
    expect(parsed.images[0].url).toBe('https://x/y.png')
    expect(parseResponse('qwen', { code: 'InvalidParameter', message: 'Field prompt is required' }).error).toBe(
      'Field prompt is required'
    )
  })

  it('完整 endpoint 不重复拼接', () => {
    const built = buildRequest(
      'qwen',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations',
      'key',
      baseRequest({ provider: 'qwen', model: 'qwen-image-2.1-turbo' }),
      '1024x1024'
    )
    expect(built.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations')
  })

  it('千问数量钳制、反向提示词仅在 3.0 系列生效', () => {
    const turbo = buildRequest(
      'qwen',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'key',
      baseRequest({ provider: 'qwen', model: 'qwen-image-2.1-turbo', count: 99, negativePrompt: 'blur' }),
      '1024x1024'
    )
    const turboBody = turbo.body as Record<string, unknown>
    expect(turboBody.n).toBe(6)
    expect(turboBody.negative_prompt).toBeUndefined()

    const v3 = buildRequest(
      'qwen',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'key',
      baseRequest({ provider: 'qwen', model: 'qwen-image-3.0', count: 2, negativePrompt: 'blur' }),
      '1024x1024'
    )
    const v3Body = v3.body as Record<string, unknown>
    expect(v3Body.n).toBe(2)
    expect(v3Body.negative_prompt).toBe('blur')
  })

  it('图生图场景自动降级 direct 增强模式', () => {
    const built = buildRequest(
      'qwen',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'key',
      baseRequest({
        provider: 'qwen',
        model: 'qwen-image-3.0',
        promptExtendMode: 'agent',
        referenceImages: ['https://a/b.png'],
      }),
      '1024x1024'
    )
    expect((built.body as Record<string, unknown>).prompt_extend_mode).toBe('direct')
  })

  it('OpenAI 文生图：质量与透明背景参数', () => {
    const built = buildRequest(
      'openai',
      'https://api.openai.com/v1',
      'key',
      baseRequest({
        provider: 'openai',
        model: 'gpt-image-1.5',
        transparent: true,
        quality: 'high',
        count: 2,
      }),
      '1024x1024'
    )
    expect(built.url).toBe('https://api.openai.com/v1/images/generations')
    const body = built.body as Record<string, unknown>
    expect(body.model).toBe('gpt-image-1.5')
    expect(body.n).toBe(2)
    expect(body.quality).toBe('high')
    expect(body.background).toBe('transparent')
    expect(body.output_format).toBe('png')
  })

  it('OpenAI 带参考图改走 multipart edits', () => {
    const built = buildRequest(
      'openai',
      'https://api.openai.com/v1',
      'key',
      baseRequest({ provider: 'openai', model: 'gpt-image-1.5', referenceImages: [DATA_URL] }),
      '1024x1024'
    )
    expect(built.url).toBe('https://api.openai.com/v1/images/edits')
    expect(built.headers['Content-Type']).toBeUndefined()
    expect(built.body).toBeInstanceOf(FormData)
    const form = built.body as FormData
    expect(form.get('model')).toBe('gpt-image-1.5')
    expect(form.get('size')).toBe('1024x1024')
    expect(form.getAll('image[]')).toHaveLength(1)
  })

  it('解析 url / b64 / 单图错误', () => {
    expect(parseResponse('volcengine', { data: [{ url: 'https://x/y.png', size: '2048x2048' }] }).images).toHaveLength(1)
    expect(parseResponse('openai', { data: [{ b64_json: 'aaa' }] }).images[0].base64).toBe('aaa')
    const withError = parseResponse('volcengine', { data: [{ error: { message: 'blocked' } }] })
    expect(withError.images[0].error).toBe('blocked')
  })
})

describe('image-studio activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    vi.resetModules()
    mock = createMockContext('image-studio')
  })

  it('注册 manifest 声明的全部 IPC 通道与生图工具', async () => {
    const mod = await import('../../../image-studio/src/main/index')
    mod.activate(mock.ctx)
    const channels = [
      'settings-get', 'settings-save', 'settings-test',
      'list-images', 'generate', 'cancel',
      'toggle-favorite', 'delete-image', 'save-image-as', 'download-image',
      'copy-image', 'show-in-folder', 'read-image-data', 'import-image',
      'pick-download-dir', 'open-download-dir', 'open-data-dir',
    ]
    for (const channel of channels) {
      expect(mock.ipc.handlers.has(channel)).toBe(true)
    }
    expect(mock.contributions.agentTools.map((tool) => tool.id)).toContain('image_generate')
  })

  it('设置往返：三家服务商、API Key 只返回掩码', async () => {
    const mod = await import('../../../image-studio/src/main/index')
    mod.activate(mock.ctx)
    const save = mock.ipc.handlers.get('settings-save')!
    const get = mock.ipc.handlers.get('settings-get')!

    await save({ providers: { openai: { apiKey: 'sk-1234567890abcdef' } }, defaults: { purpose: 'sci-schematic' } })
    const settings = (await get(undefined)) as any
    expect(Object.keys(settings.providers).sort()).toEqual(['openai', 'qwen', 'volcengine'])
    expect(settings.providers.openai.hasKey).toBe(true)
    expect(settings.providers.openai.keyMask).toContain('••')
    expect(JSON.stringify(settings)).not.toContain('1234567890')
    expect(settings.defaults.purpose).toBe('sci-schematic')

    const list = (await mock.ipc.handlers.get('list-images')!(undefined)) as any
    expect(list.images).toEqual([])

    const favorite = (await mock.ipc.handlers.get('toggle-favorite')!({ id: 'missing', favorite: true })) as any
    expect(favorite.error).toBe('errors.imageNotFound')
  })
})

describe('image-studio 生图工具', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    vi.resetModules()
    mock = createMockContext('image-studio')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('使用设置中的工具模型生成并返回本地图片路径', async () => {
    const mod = await import('../../../image-studio/src/main/index')
    mod.activate(mock.ctx)
    await mock.ipc.handlers.get('settings-save')!({
      providers: { qwen: { apiKey: 'test-key' } },
      defaults: { toolProvider: 'qwen', toolModel: 'qwen-image-3.0' },
    })

    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: DATA_URL }] } }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const tool = mock.contributions.agentTools.find((item) => item.id === 'image_generate')!
    const result = (await tool.handler({ prompt: 'a cat', aspect: '1:1' }, {})) as any

    expect(result.success).toBe(true)
    const filePath = String(result.generatedFiles[0].path)
    expect(fs.existsSync(filePath)).toBe(true)
    expect(result.output).toContain(filePath)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/v1/services/aigc/multimodal-generation/generation')
    expect((JSON.parse(String(init?.body)) as { model: string }).model).toBe('qwen-image-3.0')

    fs.unlinkSync(filePath)
  })
})
