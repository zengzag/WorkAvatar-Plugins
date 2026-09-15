import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockContext } from '../../helpers/mock-plugin-context'

// mock electron（local-stt 仅在主进程内回退路径用到 app）
vi.mock('electron', () => ({
  app: { getPath: () => '/mock', getAppPath: () => '/mock', isPackaged: false },
}))

/**
 * voice 插件本地 STT 转录单测：
 * - worker 线程路径：native.modulePath 指向 fake sherpa-onnx 模块，端到端验证
 *   spawn worker → WAV 解码 → 识别循环 → progress/done 消息协议 → 主线程拿回结果
 * - 回退路径：modulePath 不可用时回退主进程内转录（模型缺失时快速报错而非冻结主进程）
 *
 * 注意：每个用例使用独立的临时 resources 目录（mock 默认 resources 为共享固定路径，
 * 残留的模型文件会让"模型缺失"用例意外走入 loadSherpaOnnx，导致测试环境崩溃）。
 */

async function loadLocalSTT() {
  vi.resetModules()
  const mod = await import('../../../voice/src/main/local-stt')
  return mod
}

/** 写一个 fake sherpa-onnx-node 模块（CJS），识别结果固定，isReady 立即返回 false */
function writeFakeSherpaModule(dir: string): string {
  const fakeSource = `
    class FakeStream {
      acceptWaveform() {}
      inputFinished() {}
    }
    class FakeOnlineRecognizer {
      constructor(config) {
        if (!config.modelConfig.tokens) throw new Error('missing tokens')
      }
      createStream() { return new FakeStream() }
      isReady() { return false }
      decode() {}
      getResult() { return { text: ' 测试识别文本 ' } }
      isEndpoint() { return false }
      reset() {}
    }
    module.exports = { version: 'fake', OnlineRecognizer: FakeOnlineRecognizer }
  `
  const file = path.join(dir, 'fake-sherpa-onnx-node.cjs')
  fs.writeFileSync(file, fakeSource, 'utf-8')
  return file
}

/** 写一个真实 16-bit PCM WAV（16kHz 单声道，指定秒数） */
function writeWavFile(dir: string, seconds = 1): string {
  const sampleRate = 16000
  const numSamples = sampleRate * seconds
  const dataSize = numSamples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin(i / 20) * 3000), 44 + i * 2)
  }
  const file = path.join(dir, `test-audio-${seconds}s.wav`)
  fs.writeFileSync(file, buffer)
  return file
}

interface SetupOptions {
  /** 在独立 resources 目录下写入内置模型占位文件（worker 路径需要） */
  withModelFiles?: boolean
  /** native.modulePath 返回值（缺省为空串 → worker 不可用） */
  moduleFile?: string
}

/** 独立临时目录 + mock 上下文；返回 resources 目录与模块路径供用例断言 */
function setup(options: SetupOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stt-test-'))
  const mock = createMockContext('voice')
  // 覆盖为独立 resources 目录，隔离共享 mock 目录的残留状态
  mock.ctx.paths.resources = path.join(tmpDir, 'resources')
  const resourcesDir = mock.ctx.paths.resources
  if (options.withModelFiles) {
    const modelDir = path.join(resourcesDir, 'streaming-zipformer')
    fs.mkdirSync(modelDir, { recursive: true })
    for (const f of ['tokens.txt', 'encoder.onnx', 'decoder.onnx', 'joiner.onnx']) {
      fs.writeFileSync(path.join(modelDir, f), 'fake', 'utf-8')
    }
  }
  ;(mock.services as any).native.modulePath = vi.fn(() => options.moduleFile ?? '')
  return { mock, tmpDir, resourcesDir }
}

const LOCAL_CONFIG = { modelType: 'zipformer' as const, modelDir: '(内置流式 Zipformer 模型)', language: 'zh' }

describe('voice 本地 STT worker 转录', () => {
  it('worker 线程完成转录：返回文本与分段，progress 经消息协议回传', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stt-e2e-'))
    const fakeModule = writeFakeSherpaModule(tmpDir)
    const { mock } = setup({ withModelFiles: true, moduleFile: fakeModule })
    const wavPath = writeWavFile(tmpDir, 1)

    const { default: LocalSTTService } = await loadLocalSTT()
    const svc = LocalSTTService.getInstance(mock.ctx)

    const progressCalls: Array<{ progress: number; message: string }> = []
    const result = await svc.transcribe(wavPath, LOCAL_CONFIG, (progress, message) => {
      progressCalls.push({ progress, message })
    })

    expect(result.text).toBe('测试识别文本')
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].start).toBe(0)
    expect(result.segments[0].end).toBe(1)
    // worker 内的进度消息（10 加载 / 20 处理 / 每段识别）经消息协议回传；
    // worker 只发 messageKey，由主进程按当前语言解析（mock 的 i18n 按 key 直通）
    expect(progressCalls.some(p => p.progress === 10)).toBe(true)
    expect(progressCalls.some(p => p.progress === 20)).toBe(true)
    expect(progressCalls.some(p => p.message.includes('progress.recognizingSegment'))).toBe(true)
  }, 20000)

  it('信号已中止时直接抛出 Aborted，不启动 worker', async () => {
    const { mock } = setup()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stt-abort-'))
    const wavPath = writeWavFile(tmpDir, 1)

    const { default: LocalSTTService } = await loadLocalSTT()
    const svc = LocalSTTService.getInstance(mock.ctx)

    const controller = new AbortController()
    controller.abort()
    await expect(svc.transcribe(wavPath, LOCAL_CONFIG, undefined, controller.signal)).rejects.toThrow('Aborted')
  }, 20000)

  it('worker 内部错误经消息协议上抛（模块不可用）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stt-err-'))
    // 模块文件存在但缺 OnlineRecognizer 类 → worker 内 new lib.OnlineRecognizer 抛错 → error 消息上抛
    const brokenModule = path.join(tmpDir, 'broken-sherpa.cjs')
    fs.writeFileSync(brokenModule, 'module.exports = { version: "broken" }', 'utf-8')
    const { mock } = setup({ withModelFiles: true, moduleFile: brokenModule })
    const wavPath = writeWavFile(tmpDir, 1)

    const { default: LocalSTTService } = await loadLocalSTT()
    const svc = LocalSTTService.getInstance(mock.ctx)

    // 直接调 transcribeInWorker：验证 spawn → worker 内部错误 → error 消息 → 主线程 rejects
    await expect((svc as any).transcribeInWorker(wavPath, LOCAL_CONFIG)).rejects.toThrow()
  }, 20000)

  it('modulePath 不可解析时回退主进程内转录：模型缺失快速报错', async () => {
    // modulePath 返回空串（worker 不可用）+ 独立空 resources 目录（模型缺失）→ 回退路径快速失败
    const { mock } = setup()
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-stt-fb-'))
    const wavPath = writeWavFile(tmpDir, 1)

    const { default: LocalSTTService } = await loadLocalSTT()
    const svc = LocalSTTService.getInstance(mock.ctx)

    // mock 的 ctx.services.i18n 按 key 直通，故此处断言文案 key（真实环境由插件 locale 解析）
    await expect(svc.transcribe(wavPath, LOCAL_CONFIG)).rejects.toThrow(/errors\.builtinModelFilesMissing|sherpa/)
  }, 20000)
})
