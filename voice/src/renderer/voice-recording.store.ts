import { create } from 'zustand'

/** 实时识别完成的段落 */
export interface RealtimeSegment {
  start: number
  end: number
  text: string
}

/**
 * 全局录音状态 store：
 * 独立于 KMSVoiceView 组件生命周期，用于在导航栏显示录音指示器。
 * 当用户切换到其他功能模块时，录音和语音识别在后台继续运行。
 *
 * 实时识别文本/段落、录音时长等高频状态也放在此 store：
 * 由独立的小组件（字幕面板、时长显示）订阅，避免每 100ms 一次的识别结果
 * 触发整个录音页（任务列表/设置/纪要等）重渲染、占满渲染主线程导致导航点击无响应。
 */
interface VoiceRecordingState {
  /** 是否正在录音（含实时识别） */
  isRecording: boolean
  /** 是否暂停 */
  isPaused: boolean
  /** 当前录音任务 ID */
  recordingTaskId: string | null
  /** 录音时长（秒） */
  duration: number
  /** 音频电平（0-100） */
  audioLevel: number
  /** 录音来源 */
  recordSource: 'mic' | 'system' | 'both' | null
  /** 实时识别文本快照（来源 → 全文） */
  realtimeTextBySource: Record<string, string>
  /** 实时识别已完成段落（来源 → 段落数组） */
  realtimeSegmentsBySource: Record<string, RealtimeSegment[]>

  setRecording: (recording: boolean) => void
  setPaused: (paused: boolean) => void
  setRecordingTaskId: (taskId: string | null) => void
  setDuration: (duration: number) => void
  setAudioLevel: (level: number) => void
  setRecordSource: (source: 'mic' | 'system' | 'both' | null) => void
  /** 一次性写入实时识别文本 + 段落快照（合并为单次 set，避免订阅方重复重渲染） */
  setRealtimeSnapshot: (
    textBySource: Record<string, string>,
    segmentsBySource: Record<string, RealtimeSegment[]>
  ) => void
  /** 清空实时识别快照 */
  resetRealtime: () => void
  /** 重置全部状态 */
  reset: () => void
}

export const useVoiceRecordingStore = create<VoiceRecordingState>((set) => ({
  isRecording: false,
  isPaused: false,
  recordingTaskId: null,
  duration: 0,
  audioLevel: 0,
  recordSource: null,
  realtimeTextBySource: {},
  realtimeSegmentsBySource: {},

  setRecording: (recording) => set({ isRecording: recording }),
  setPaused: (paused) => set({ isPaused: paused }),
  setRecordingTaskId: (taskId) => set({ recordingTaskId: taskId }),
  setDuration: (duration) => set({ duration }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setRecordSource: (source) => set({ recordSource: source }),
  setRealtimeSnapshot: (realtimeTextBySource, realtimeSegmentsBySource) =>
    set({ realtimeTextBySource, realtimeSegmentsBySource }),
  resetRealtime: () => set({ realtimeTextBySource: {}, realtimeSegmentsBySource: {} }),
  reset: () => set({
    isRecording: false,
    isPaused: false,
    recordingTaskId: null,
    duration: 0,
    audioLevel: 0,
    recordSource: null,
    realtimeTextBySource: {},
    realtimeSegmentsBySource: {},
  }),
}))
