/**
 * voice 内置插件主进程入口。
 * - 数据完全自包含于插件分库（voice-service 保证建表）与宿主 dataDir/voice
 * - IPC 经 ctx.ipc.handle 注册（插件桥路由 plugin:voice:<channel>），广播经 ctx.ipc.broadcast 推送
 */
import { desktopCapturer, dialog } from 'electron'
import type { PluginContext } from '@workavatar/plugin-sdk'
import VoiceService from './voice-service'
import LocalSTTService from './local-stt'
import SubtitleWindowService from './subtitle-window'
import type { VoiceSubtitleConfig } from './subtitle-window'
import type {
  VoiceCreateTaskParams,
  VoiceUpdateTaskParams,
  VoiceSettings,
} from './voice-service'

// ====== 激活 ======

let voiceService: VoiceService | null = null
let localSTT: LocalSTTService | null = null
let subtitleWindow: SubtitleWindowService | null = null

export function activate(ctx: PluginContext): void {
  localSTT = LocalSTTService.getInstance(ctx)
  subtitleWindow = SubtitleWindowService.getInstance(ctx)
  voiceService = VoiceService.getInstance(ctx)
  registerIpc(ctx)
  ctx.services.logger.info('voice 插件激活完成')
}

export function deactivate(): void {
  if (subtitleWindow) {
    subtitleWindow.destroy()
    subtitleWindow = null
  }
  if (localSTT) {
    localSTT.dispose()
    localSTT = null
  }
  voiceService = null
}

function registerIpc(ctx: PluginContext): void {
  if (!voiceService) return
  const s = voiceService
  const sub = () => subtitleWindow

  // ==================== 任务管理 ====================
  ctx.ipc.handle('list-tasks', () => s.listTasks())

  ctx.ipc.handle('get-task', (id: string) => s.getTask(id))

  ctx.ipc.handle('create-task', (params: VoiceCreateTaskParams) => {
    return s.createTask(params || {})
  })

  ctx.ipc.handle('update-task', (params: VoiceUpdateTaskParams) => {
    return s.updateTask(params || {})
  })

  ctx.ipc.handle('delete-task', (id: string) => {
    s.deleteTask(id)
    return { success: true }
  })

  // ==================== 音频保存 ====================
  ctx.ipc.handle('save-audio', (params: {
    taskId: string
    audioData: string
    format: string
    duration: number
    sampleRate: number
    channels: number
  }) => {
    return s.saveAudio(
      params.taskId,
      params.audioData,
      params.format,
      params.duration,
      params.sampleRate,
      params.channels,
    )
  })

  // 双源录音：保存第二路音频（系统音频）
  ctx.ipc.handle('save-secondary-audio', (params: { taskId: string; audioData: string; format: string }) => {
    return s.saveSecondaryAudio(params)
  })

  // 双源录音：合并 mic + system 转录文本到主任务
  ctx.ipc.handle('merge-dual-transcript', (params: { mainTaskId: string; micTaskId: string; systemTaskId: string }) => {
    return s.mergeDualSourceTranscript(params)
  })

  // ==================== 语音识别 ====================
  // 长任务：voiceService 内部已用 AbortController + 异步并发，进度经 broadcast 推送，
  // ctx.ipc.handle 等待其 resolve 即保持原语义（与宿主 fire-and-forget 模式一致）。
  ctx.ipc.handle('transcribe', async (params: { taskId: string; language?: string }) => {
    try {
      const result = await s.transcribe(params.taskId, params.language)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      ctx.services.logger.error(`IPC handler error [voice:transcribe]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('cancel-transcribe', (taskId: string) => {
    s.cancelTranscribe(taskId)
    return { success: true }
  })

  // ==================== 会议纪要生成 ====================
  ctx.ipc.handle('generate-minutes', async (params: { taskId: string; minutesType: string; customPrompt?: string }) => {
    try {
      const result = await s.generateMinutes(params.taskId, params.minutesType, params.customPrompt)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      ctx.services.logger.error(`IPC handler error [voice:generate-minutes]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('cancel-minutes', (taskId: string) => {
    s.cancelMinutes(taskId)
    return { success: true }
  })

  // ==================== 设置 ====================
  ctx.ipc.handle('get-settings', () => s.getSettings())

  ctx.ipc.handle('set-settings', (settings: VoiceSettings) => {
    s.setSettings(settings)
    return { success: true }
  })

  // ==================== 系统音频源 ====================
  ctx.ipc.handle('get-audio-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: false,
    })
    return sources.map(so => ({
      id: so.id,
      name: so.name,
      display_id: so.display_id,
    }))
  })

  // ==================== 本地模型状态检查 ====================
  ctx.ipc.handle('check-local-model', () => s.checkLocalModel())

  // ==================== 选择目录对话框 ====================
  ctx.ipc.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // ==================== 实时识别（边录音边识别） ====================
  ctx.ipc.handle('realtime-start', (params: { taskId: string; language?: string }) => {
    return s.startRealtime(params.taskId, params.language)
  })

  // feed 高频调用，快速返回（Float32Array 转换后入队异步处理）
  ctx.ipc.handle('realtime-feed', (params: { taskId: string; samples: ArrayBuffer; sampleRate: number; source?: string }) => {
    try {
      const samples = new Float32Array(params.samples)
      s.feedRealtimeAudio(params.taskId, samples, params.sampleRate, params.source)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('realtime-stop', (taskId: string) => {
    try {
      return s.stopRealtime(taskId)
    } catch (err: any) {
      ctx.services.logger.error('Realtime stop error:', err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('realtime-cancel', (taskId: string) => {
    s.cancelRealtime(taskId)
    return { success: true }
  })

  // ==================== 悬浮字幕窗口 ====================
  ctx.ipc.handle('subtitle-show', (config?: VoiceSubtitleConfig) => {
    sub()?.show(config)
    return { success: true }
  })

  ctx.ipc.handle('subtitle-hide', () => {
    sub()?.hide()
    return { success: true }
  })

  ctx.ipc.handle('subtitle-toggle', () => {
    const visible = sub()?.toggle() ?? false
    return { visible }
  })

  ctx.ipc.handle('subtitle-get-visible', () => {
    return { visible: sub()?.isVisible() ?? false }
  })
}