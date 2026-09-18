// word-editor 渲染端状态（zustand）

import { create } from 'zustand'
import { we, hostT, type DocRecord, type SnapshotMeta } from './store'
import type { GenericChatViewMessage, GenericChatViewSegment } from '@workavatar/plugin-sdk/renderer'

export type ChatMessage = GenericChatViewMessage

/** 编辑器桥：由 WordCanvasHost 挂载后注册，store 经此读写文档 */
export interface EditorBridge {
  /** 当前文档的 Document JSON */
  getData: () => string
  /** 轻量变更签名（blocks 数 + revision 和），用于轮询检测改动 */
  getSignature: () => string
  /** 用 Document JSON 替换编辑器内容 */
  setDocument: (data: string) => void
  /** 用 .docx 字节打开（导入） */
  openDocx: (bytes: Uint8Array) => Promise<void>
  /** 导出为 docx / pdf 字节 */
  exportDocx: () => Promise<Uint8Array>
  exportPdf: () => Promise<Uint8Array>
}

export interface EditorBridgeHandle {
  getData: () => string
  getSignature: () => string
  setDocument: (data: string) => void
  openDocx: (bytes: Uint8Array) => Promise<void>
  exportDocx: () => Promise<Uint8Array>
  exportPdf: () => Promise<Uint8Array>
}

interface WordEditorState {
  docs: Array<Omit<DocRecord, 'data'>>
  doc: DocRecord | null
  /** 有未保存改动 */
  dirty: boolean
  saving: boolean
  snapshots: SnapshotMeta[]
  // AI 对话
  messages: ChatMessage[]
  isStreaming: boolean
  chatError: string | null
  conversationId: string | null
  chats: Array<{ conversationId: string; title: string; updatedAt: number; workspacePath?: string | null }>
  providers: any[]
  selectedProviderId: string | null
  selectedModelId: string | null
  workspacePath: string | null
  aiPanelOpen: boolean
  settingsOpen: boolean

  loadDocs: () => Promise<void>
  /** 直接应用一条文档记录（初始化 / 服务端返回时用，不触发编辑器重建） */
  applyDoc: (record: DocRecord) => void
  createDoc: (title?: string) => Promise<void>
  openDoc: (id: string) => Promise<void>
  deleteDoc: (id: string) => Promise<void>
  renameDoc: (id: string, title: string) => Promise<void>
  /** 从编辑器同步脏状态（轮询调用） */
  syncDirty: () => void
  /** 保存当前文档 */
  flushSave: () => Promise<void>
  /** 导入 .docx（可选指定路径） */
  importDoc: (path?: string) => Promise<string | null>
  /** 导出当前文档（docx / pdf），返回错误文案或 null */
  exportDoc: (format: 'docx' | 'pdf') => Promise<string | null>

  loadSnapshots: () => Promise<void>
  createSnapshot: (label?: string) => Promise<void>
  restoreSnapshot: (snapshotId: string) => Promise<void>
  deleteSnapshot: (id: string) => Promise<void>

  loadProviders: () => Promise<void>
  setSelectedProvider: (id: string | null) => void
  setSelectedModel: (id: string | null) => void
  saveSettings: (patch: { defaultProviderId?: string; defaultModelId?: string }) => Promise<void>

  sendMessage: (text: string, images?: string[]) => Promise<void>
  cancelChat: () => void
  newChat: () => void
  loadChatHistory: (conversationId: string) => Promise<void>
  loadChats: () => Promise<void>
  deleteChat: (conversationId: string) => Promise<void>
  openChatDir: (conversationId: string) => Promise<void>
  deleteMessage: (msgId: string) => void
  toggleSegment: (msgId: string, segId: string) => void

  toggleAiPanel: (open?: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

/** 编辑器桥 + 变更轮询（wordcanvas 无文档变更事件，用 revision 签名轮询检测） */
let editorBridge: EditorBridge | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastSignature = ''

const POLL_MS = 2500

export function registerEditorBridge(bridge: EditorBridge | null): void {
  editorBridge = bridge
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (!bridge) {
    lastSignature = ''
    return
  }
  lastSignature = bridge.getSignature()
  pollTimer = setInterval(() => useWordEditorStore.getState().syncDirty(), POLL_MS)
}

export const useWordEditorStore = create<WordEditorState>((set, get) => ({
  docs: [],
  doc: null,
  dirty: false,
  saving: false,
  snapshots: [],
  messages: [],
  isStreaming: false,
  chatError: null,
  conversationId: null,
  chats: [],
  providers: [],
  selectedProviderId: null,
  selectedModelId: null,
  workspacePath: null,
  aiPanelOpen: false,
  settingsOpen: false,

  loadDocs: async () => {
    set({ docs: await we.listDocs() })
  },

  applyDoc: (record) => {
    set({ doc: record, dirty: false, snapshots: [] })
  },

  createDoc: async (title) => {
    const res = await we.createDoc(title)
    if ('doc' in res && res.doc) {
      set({ doc: res.doc, dirty: false, snapshots: [] })
      await get().loadDocs()
    }
  },

  openDoc: async (id) => {
    // 切换前先保存当前文档
    if (get().dirty) await get().flushSave()
    const res = await we.openDoc(id)
    if ('doc' in res && res.doc) {
      set({ doc: res.doc, dirty: false, snapshots: [] })
    } else if ('error' in res) {
      throw new Error(hostT(res.error))
    }
  },

  deleteDoc: async (id) => {
    await we.deleteDoc(id)
    if (get().doc?.id === id) set({ doc: null, dirty: false })
    await get().loadDocs()
  },

  renameDoc: async (id, title) => {
    await we.renameDoc(id, title)
    const cur = get().doc
    if (cur?.id === id) set({ doc: { ...cur, title } })
    await get().loadDocs()
  },

  syncDirty: () => {
    if (!editorBridge || !get().doc) return
    const sig = editorBridge.getSignature()
    if (sig !== lastSignature) {
      lastSignature = sig
      if (!get().dirty) set({ dirty: true })
    }
  },

  flushSave: async () => {
    const state = get()
    if (!state.doc || !editorBridge) return
    const data = editorBridge.getData()
    if (!data) return
    set({ saving: true })
    const res = await we.saveDoc(state.doc.id, data, state.doc.title)
    lastSignature = editorBridge.getSignature()
    if ('ok' in res && res.ok) {
      set({ doc: { ...state.doc, data, updatedAt: res.updatedAt }, dirty: false, saving: false })
    } else {
      set({ saving: false })
    }
  },

  importDoc: async (path) => {
    const res = await we.importDocx(path)
    if (!res?.bytes) return res?.error ?? null
    if (!editorBridge) return hostT('page.editorNotReady')
    try {
      await editorBridge.openDocx(res.bytes)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    // wordcanvas 解析完成 → 取 Document 存为插件文档
    const data = editorBridge.getData()
    const created = await we.createDoc(res.name || hostT('defaults.importName'), data)
    if ('doc' in created && created.doc) {
      await we.renameDoc(created.doc.id, res.name || hostT('defaults.importName'))
      set({ doc: { ...created.doc, title: res.name || hostT('defaults.importName'), sourcePath: res.sourcePath ?? null }, dirty: false, snapshots: [] })
      await get().loadDocs()
    }
    lastSignature = editorBridge.getSignature()
    return null
  },

  exportDoc: async (format) => {
    if (!editorBridge) return hostT('page.editorNotReady')
    try {
      const bytes = format === 'pdf' ? await editorBridge.exportPdf() : await editorBridge.exportDocx()
      const title = get().doc?.title || 'document'
      const res = await we.exportSave(bytes, format, title)
      return res?.error ?? null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  },

  loadSnapshots: async () => {
    const cur = get().doc
    if (!cur) { set({ snapshots: [] }); return }
    const res = await we.listSnapshots(cur.id)
    set({ snapshots: (res as any)?.snapshots ?? [] })
  },

  createSnapshot: async (label) => {
    const cur = get().doc
    if (!cur) return
    if (get().dirty) await get().flushSave()
    await we.createSnapshot(cur.id, label)
    await get().loadSnapshots()
  },

  restoreSnapshot: async (snapshotId) => {
    await we.restoreSnapshot(snapshotId)
  },

  deleteSnapshot: async (id) => {
    await we.deleteSnapshot(id)
    await get().loadSnapshots()
  },

  loadProviders: async () => {
    const providers = ((await we.listProviders()) as any[]) || []
    set({ providers })
    const { settings } = await we.getSettings()
    const preferred = settings?.defaultProviderId
    const current = get().selectedProviderId
    if (preferred && providers.some((p) => p.id === preferred)) {
      set({ selectedProviderId: preferred, selectedModelId: settings?.defaultModelId ?? null })
    } else if (!(current && providers.some((p) => p.id === current)) && providers.length > 0) {
      const def = providers.find((p) => p.is_default) ?? providers[0]
      set({ selectedProviderId: def?.id ?? null, selectedModelId: def?.model ?? null })
    }
  },

  setSelectedProvider: (id) => set({ selectedProviderId: id, selectedModelId: null }),
  setSelectedModel: (id) => set({ selectedModelId: id }),

  saveSettings: async (patch) => {
    const { settings } = await we.getSettings()
    await we.setSettings({ ...(settings ?? {}), ...patch })
  },

  loadChats: async () => {
    set({ chats: await we.listChats() })
  },

  newChat: () => {
    void we.cancelChat(get().conversationId ?? undefined)
    set({ messages: [], conversationId: null, isStreaming: false, chatError: null, workspacePath: null })
  },

  loadChatHistory: async (conversationId) => {
    ensureChatEvent()
    const raw = (await we.chatHistory(conversationId)) as any[]
    const msgs: ChatMessage[] = raw.map((m) => ({
      id: m.id ?? `m-${Date.now()}-${Math.random()}`,
      role: m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : '',
      thought: m.reasoning_content,
      images: Array.isArray(m.images) ? m.images : undefined,
      segments: Array.isArray(m.segments) ? m.segments : undefined,
      isStreaming: false,
    }))
    const ws = get().chats.find((c) => c.conversationId === conversationId)?.workspacePath ?? null
    set({ messages: msgs, conversationId, workspacePath: ws, isStreaming: false })
  },

  deleteChat: async (conversationId) => {
    if (get().conversationId === conversationId) void we.cancelChat(conversationId)
    const res = await we.deleteChat(conversationId)
    if ('error' in res && res.error) throw new Error(res.error)
    if (get().conversationId === conversationId) set({ messages: [], conversationId: null, workspacePath: null })
    await get().loadChats()
  },

  openChatDir: async (conversationId) => {
    await we.openChatDir(conversationId)
  },

  deleteMessage: (msgId) => {
    const msgs = get().messages
    const idx = msgs.findIndex((m) => m.id === msgId)
    if (idx === -1 || get().isStreaming) return
    const next = [...msgs]
    next.splice(idx, 1)
    if (msgs[idx].role === 'user' && next[idx] && next[idx].role === 'assistant') next.splice(idx, 1)
    set({ messages: next })
  },

  toggleSegment: (msgId, segId) => {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== msgId || !m.segments) return m
        return {
          ...m,
          segments: m.segments.map((s) => (s.id === segId ? { ...s, collapsed: !s.collapsed } : s)),
        }
      }),
    }))
  },

  sendMessage: async (text, images) => {
    if (get().isStreaming) return
    const { selectedProviderId, selectedModelId, conversationId, messages } = get()
    if (!selectedProviderId) {
      set({ chatError: 'errors.noProvider' })
      return
    }
    if (get().dirty) await get().flushSave()

    const now = Date.now()
    const userMsg: ChatMessage = { id: `msg_${now}_u`, role: 'user', content: text, timestamp: now, images }
    const assistantMsg: ChatMessage = { id: `msg_${now}_a`, role: 'assistant', content: '', timestamp: now, isStreaming: true, segments: [] }
    set({ messages: [...messages, userMsg, assistantMsg], isStreaming: true, chatError: null })

    ensureChatEvent()

    const history = messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) => ({ id: m.id, role: m.role, content: m.content, images: m.images }))

    const res = await we.sendChat({
      providerId: selectedProviderId,
      modelId: selectedModelId ?? undefined,
      messages: [...history, { id: userMsg.id, role: 'user', content: text, images }],
      assistantId: assistantMsg.id,
      conversationId: conversationId ?? undefined,
    })

    if ('error' in res) {
      set((state) => {
        const msgs = [...state.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, isStreaming: false, isError: true }
        return { messages: msgs, isStreaming: false, chatError: res.error }
      })
      return
    }
    const convRes = res as { conversationId?: string; workspacePath?: string | null }
    if (convRes?.conversationId) {
      set({ conversationId: convRes.conversationId, workspacePath: convRes.workspacePath ?? null })
    }
    await get().loadChats()
  },

  cancelChat: () => {
    void we.cancelChat(get().conversationId ?? undefined)
    set({ isStreaming: false })
  },

  toggleAiPanel: (open) => set((s) => ({ aiPanelOpen: open ?? !s.aiPanelOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}))

// ====== 对话流式事件 → segments ======

let chatEventReady = false

function ensureChatEvent(): void {
  if (chatEventReady) return
  chatEventReady = true
  we.onChatEvent((payload: any) => {
    useWordEditorStore.setState((state) => {
      const messages = applyChatEvent(state.messages, payload)
      const done = payload?.type === 'done' || payload?.type === 'error'
      return {
        messages,
        isStreaming: done ? false : state.isStreaming,
        chatError: payload?.type === 'error' ? (payload.error ?? null) : state.chatError,
      }
    })
  })
}

function finalizeStreamingSegs(segs: GenericChatViewSegment[], keepType?: 'thinking' | 'answer'): GenericChatViewSegment[] {
  return segs.map((s) => {
    if (!s.isStreaming) return s
    if (keepType === 'thinking' && s.type !== 'thinking') return s
    if (keepType === 'answer' && s.type !== 'answer') return s
    return {
      ...s,
      isStreaming: false,
      completedAt: s.completedAt || Date.now(),
      ...(s.type === 'thinking' ? { collapsed: true } : {}),
    }
  })
}

function safeParseJson(text: string): any {
  try { return JSON.parse(text) } catch { return undefined }
}

function finalizeToolSegments(segs: GenericChatViewSegment[], error?: string): GenericChatViewSegment[] {
  return segs.map((s) => {
    if (s.type !== 'tool_call' || s.isToolComplete) return s
    return {
      ...s,
      toolArgs: s.toolArgs ?? (s.toolArgsRaw ? safeParseJson(s.toolArgsRaw) : undefined),
      toolArgsRaw: undefined,
      isToolArgsStreaming: false,
      isToolComplete: true,
      toolError: error,
      collapsed: true,
      completedAt: s.completedAt || Date.now(),
    }
  })
}

function applyChatEvent(msgs: ChatMessage[], payload: any): ChatMessage[] {
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'assistant' || !last.isStreaming) return msgs
  const segs = [...(last.segments || [])]

  switch (payload?.type) {
    case 'chunk': {
      const text = payload.text ?? ''
      if (!text) return msgs
      const updated = finalizeStreamingSegs(segs, 'thinking')
      const lastSeg = updated[updated.length - 1]
      if (lastSeg && lastSeg.type === 'answer' && lastSeg.isStreaming) {
        updated[updated.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + text }
      } else {
        updated.push({ type: 'answer', id: `${last.id}_seg_${updated.length}`, content: text, isStreaming: true, timestamp: Date.now() })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated, content: (last.content || '') + text }]
    }
    case 'thought': {
      const thought = payload.thought ?? ''
      if (!thought) return msgs
      const updated = finalizeStreamingSegs(segs, 'answer')
      const lastSeg = updated[updated.length - 1]
      if (lastSeg && lastSeg.type === 'thinking' && lastSeg.isStreaming) {
        updated[updated.length - 1] = { ...lastSeg, content: (lastSeg.content || '') + thought }
      } else {
        updated.push({ type: 'thinking', id: `${last.id}_seg_${updated.length}`, content: thought, isStreaming: true, collapsed: false, timestamp: Date.now() })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated, thought: (last.thought || '') + thought }]
    }
    case 'tool-call-delta': {
      const delta = payload.delta ?? {}
      const argsText = delta.arguments ?? ''
      const updated = finalizeStreamingSegs(segs)
      const i = delta.id
        ? updated.findIndex((s) => s.type === 'tool_call' && s.toolCallId === delta.id && !s.isToolComplete)
        : updated.findIndex((s) => s.type === 'tool_call' && s.isToolArgsStreaming === true && !s.isToolComplete)
      if (i === -1) {
        updated.push({
          type: 'tool_call', id: `${last.id}_tool_${updated.length}`,
          toolName: delta.name || '', toolCallId: delta.id || `delta_${delta.index}`,
          toolArgsRaw: argsText, isToolArgsStreaming: true, isToolComplete: false,
          collapsed: false, timestamp: Date.now(),
        })
      } else {
        updated[i] = {
          ...updated[i], toolName: delta.name || updated[i].toolName,
          toolArgsRaw: (updated[i].toolArgsRaw || '') + argsText, toolCallId: delta.id || updated[i].toolCallId,
        }
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated }]
    }
    case 'tool-call': {
      const tc = payload.toolCall ?? {}
      const updated = finalizeStreamingSegs(segs)
      const i = updated.findIndex((s) => s.type === 'tool_call' && !s.isToolComplete && (s.isToolArgsStreaming === true || s.toolCallId === tc.id))
      if (i !== -1) {
        updated[i] = {
          ...updated[i], toolName: tc.name, toolArgs: tc.arguments, toolArgsRaw: undefined,
          isToolArgsStreaming: false, toolCallId: tc.id, collapsed: true,
        }
      } else {
        updated.push({
          type: 'tool_call', id: `${last.id}_tool_${updated.length}`,
          toolName: tc.name, toolCallId: tc.id, toolArgs: tc.arguments,
          isToolComplete: false, collapsed: true, timestamp: Date.now(),
        })
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated }]
    }
    case 'tool-result': {
      const { name, result, success } = payload
      let i = -1
      for (let k = segs.length - 1; k >= 0; k--) {
        if (segs[k].type === 'tool_call' && segs[k].toolName === name && !segs[k].isToolComplete) { i = k; break }
      }
      if (i === -1) return msgs
      const prev = segs[i]
      segs[i] = {
        ...prev,
        toolArgs: prev.toolArgs ?? (prev.toolArgsRaw ? safeParseJson(prev.toolArgsRaw) : undefined),
        toolArgsRaw: undefined,
        isToolArgsStreaming: false,
        toolResult: result,
        isToolComplete: true,
        toolError: success === false ? (typeof result === 'string' ? result : undefined) : undefined,
        collapsed: true,
        completedAt: Date.now(),
      }
      return [...msgs.slice(0, -1), { ...last, segments: segs }]
    }
    case 'done': {
      const finalized = finalizeToolSegments(segs).map((s) => ({
        ...s, isStreaming: false, completedAt: s.completedAt || Date.now(),
        ...(s.type === 'thinking' ? { collapsed: true } : {}),
      }))
      return [...msgs.slice(0, -1), { ...last, segments: finalized, isStreaming: false }]
    }
    case 'error': {
      const error = payload.error ?? hostT('chat.defaultTitle')
      const finalized = finalizeToolSegments(segs, error).map((s) => ({
        ...s, isStreaming: false, completedAt: s.completedAt || Date.now(),
        ...(s.type === 'thinking' ? { collapsed: true } : {}),
      }))
      return [...msgs.slice(0, -1), { ...last, segments: finalized, isStreaming: false, isError: true, content: last.content || error }]
    }
    default:
      return msgs
  }
}
