/**
 * 本地 STT 文件转录 worker 源码（以字符串形式内嵌，经 new Worker(source, { eval: true }) 启动）。
 * 内嵌原因：插件由 esbuild 打包为单文件 index.cjs，独立 worker 文件需要额外的构建入口与产物拷贝；
 * eval 模式的 worker 代码随主 bundle 一起分发，dev 与打包场景行为一致。
 * worker 内自行 require sherpa-onnx（主进程解析好的入口文件绝对路径经 workerData 传入），
 * 解码循环全部在该线程执行，主进程 UI/IPC/调度不再被长录音转录阻塞。
 */
export const STT_WORKER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('worker_threads')
const fs = require('fs')

let aborted = false
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'abort') aborted = true
})

function fail(err) {
  parentPort.postMessage({ type: 'error', message: String((err && err.message) || err) })
}

// 自定义 WAV 解析（与主进程 readWavFile 一致：16-bit PCM，多声道混为单声道）
function readWavFallback(filePath) {
  const stat = fs.statSync(filePath)
  if (stat.size > 500 * 1024 * 1024) throw new Error('WAV file too large (max 500MB)')
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 44) throw new Error('Invalid WAV file: too short')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV file: not a RIFF/WAVE format')
  }
  let offset = 12
  let audioFormat = 1
  let numChannels = 1
  let sampleRate = 16000
  let bitsPerSample = 16
  let dataOffset = 0
  let dataSize = 0
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') {
      audioFormat = buffer.readUInt16LE(offset + 8)
      numChannels = buffer.readUInt16LE(offset + 10)
      sampleRate = buffer.readUInt32LE(offset + 12)
      bitsPerSample = buffer.readUInt16LE(offset + 22)
    } else if (chunkId === 'data') {
      dataOffset = offset + 8
      dataSize = chunkSize
      break
    }
    offset += 8 + chunkSize
  }
  if (audioFormat !== 1) throw new Error('Unsupported WAV format: only PCM (format 1) is supported, got ' + audioFormat)
  if (bitsPerSample !== 16) throw new Error('Unsupported bit depth: only 16-bit is supported, got ' + bitsPerSample)
  const numSamples = Math.floor(dataSize / 2)
  const samples = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768.0
  }
  if (numChannels > 1) {
    const mono = new Float32Array(Math.floor(numSamples / numChannels))
    for (let i = 0; i < mono.length; i++) {
      let sum = 0
      for (let c = 0; c < numChannels; c++) sum += samples[i * numChannels + c]
      mono[i] = sum / numChannels
    }
    return { samples: mono, sampleRate }
  }
  return { samples, sampleRate }
}

function readWave(lib, filePath) {
  try {
    if (lib.readWave) {
      const wave = lib.readWave(filePath)
      if (wave && wave.samples) return { samples: wave.samples, sampleRate: wave.sampleRate }
    }
  } catch (err) { /* 回退自定义解析 */ }
  return readWavFallback(filePath)
}

const MAX_DECODE_ITERATIONS = 100000

function run() {
  const d = workerData
  parentPort.postMessage({ type: 'progress', progress: 10, messageKey: 'progress.loadingAudio' })
  const lib = require(d.moduleFile)

  const modelConfig = {
    tokens: d.modelFiles.tokens,
    numThreads: 4,
    provider: 'cpu',
    debug: 0,
    transducer: { encoder: d.modelFiles.encoder, decoder: d.modelFiles.decoder, joiner: d.modelFiles.joiner },
  }
  const recognizerConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig,
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
  }
  let rec
  if (d.isStreaming) {
    recognizerConfig.enableEndpoint = 1
    recognizerConfig.rule1MinTrailingSilence = 2.4
    recognizerConfig.rule2MinTrailingSilence = 1.2
    recognizerConfig.rule3MinUtteranceLength = 20
    rec = new lib.OnlineRecognizer(recognizerConfig)
  } else {
    rec = new lib.OfflineRecognizer(recognizerConfig)
  }

  const { samples, sampleRate } = readWave(lib, d.audioPath)
  parentPort.postMessage({ type: 'progress', progress: 20, messageKey: 'progress.processingAudio' })
  if (aborted) throw new Error('Aborted')

  const chunkSamples = Math.min(30 * sampleRate, samples.length)
  const segments = []
  let fullText = ''
  const totalChunks = chunkSamples > 0 ? Math.ceil(samples.length / chunkSamples) : 0
  let processed = 0

  for (let start = 0; start < samples.length; start += chunkSamples) {
    if (aborted) throw new Error('Aborted')
    const end = Math.min(start + chunkSamples, samples.length)
    const chunk = samples.subarray(start, end)
    const stream = rec.createStream()
    stream.acceptWaveform({ samples: chunk, sampleRate })
    if (d.isStreaming) {
      stream.inputFinished()
      let iters = 0
      while (rec.isReady(stream)) {
        if (aborted) throw new Error('Aborted')
        rec.decode(stream)
        if (++iters > MAX_DECODE_ITERATIONS) break
      }
    } else {
      rec.decode(stream)
    }
    const result = rec.getResult(stream)
    const text = ((result && result.text) || '').trim()
    if (text) {
      segments.push({ start: start / sampleRate, end: end / sampleRate, text })
      fullText += text
    }
    processed++
    parentPort.postMessage({
      type: 'progress',
      progress: 20 + Math.floor((processed / totalChunks) * 70),
      messageKey: 'progress.recognizingSegment',
      messageParams: { current: processed, total: totalChunks },
    })
  }

  parentPort.postMessage({ type: 'done', result: { text: fullText, segments } })
}

try {
  run()
} catch (err) {
  fail(err)
}
`
