// word-editor 渲染端状态（zustand）

import { create } from 'zustand'
import { we, hostT } from './store'
import type { GenericChatViewMessage, GenericChatViewSegment } from '@workavatar/plugin-sdk/renderer'
import type { SnapshotMeta } from './store'

export type ChatMessage = GenericChatViewMessage

export type SaveState = 'saved' | 'dirty' | 'saving'

interface WordEditorState {
  docs: Array<{ id: string; title: string; updatedAt: number; sourcePath?: string | null }>
  doc: (DocRecord & { html: string }) | null
  saveState: SaveState
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
  createDoc: (title?: string) => Promise<void>
  openDoc: (id: string) => Promise<void>
  deleteDoc: (id: string) => Promise<void>
  renameDoc: (id: string, title: string) => Promise<void>
  /** 编辑器内容变更：标脏 + 同步镜像 + 防抖保存 */
  updateHtml: (html: string) => void
  flushSave: () => Promise<void>
  exportDocx: (html: string) => Promise<string | null>
  exportPdf: (html: string) => Promise<string | null>

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

  /** 渲染端打开/导入文档的本地动作（由页面调用主进程 IPC 后应用） */
  applyDoc: (doc: { id: string; title: string; html: string; sourcePath?: string | null; updatedAt?: number }) => void
  /** 导入 docx（pathStorage 可选，来自 FileViewerModal "编辑文档"跳转） */
  importDoc: (path?: string) => Promise<string | null>
}

type DocRecord = { id: string; title: string; updatedAt: number; sourcePath: string | null }

// 编辑器桥（EditorCanvas 挂载时注册）：flushSave 时取最新 HTML
let editorSync: { getHtml: () => string } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 800

export function registerEditorSync(sync: { getHtml: () => string } | null): void {
  editorSync = sync
}

export const useWordEditorStore = create<WordEditorState>((set, get) => ({
  docs: [],
  doc: null,
  saveState: 'saved',
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
    set({ docs: (await we.listDocs()) as any })
  },

  applyDoc: (doc) => {
    set({
      doc: {
        id: doc.id, title: doc.title, html: doc.html,
        updatedAt: doc.updatedAt ?? Date.now(),
        sourcePath: doc.sourcePath ?? null,
      },
      saveState: 'saved',
      snapshots: [],
    })
  },

  createDoc: async (title) => {
    const res = await we.createDoc(title)
    if (res.doc) {
      get().applyDoc(res.doc)
      await get().loadDocs()
    }
  },

  openDoc: async (id) => {
    const res = await we.openDoc(id)
    if ('doc' in res && res.doc) get().applyDoc(res.doc)
  },

  deleteDoc: async (id) => {
    await we.deleteDoc(id)
    if (get().doc?.id === id) set({ doc: null })
    await get().loadDocs()
  },

  renameDoc: async (id, title) => {
    await we.renameDoc(id, title)
    const cur = get().doc
    if (cur?.id === id) set({ doc: { ...cur, title } })
    await get().loadDocs()
  },

  updateHtml: (html) => {
    const { doc } = get()
    if (!doc) return
    set({ saveState: 'dirty' })
    if (html !== doc.html) {
      set({ doc: { ...doc, html } })
      void we.syncDoc(doc.id, html)
    }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; void get().flushSave() }, SAVE_DEBOUNCE_MS)
  },

  flushSave: async () => {
    const state = get()
    if (!state.doc) return
    const html = editorSync ? editorSync.getHtml() : state.doc.html
    if (state.saveState === 'saved' && html === state.doc.html) return
    set({ saveState: 'saving' })
    const res = await we.saveDoc(state.doc.id, html, state.doc.title)
    if (res?.ok) {
      set({ doc: { ...state.doc, html, updatedAt: res.updatedAt }, saveState: 'saved' })
    } else {
      set({ saveState: 'dirty' })
    }
  },

  exportDocx: async (html) => {
    const cur = get().doc
    if (!cur) return hostT('doc.importing')
    const res = await we.exportDocx({ html, title: cur.title })
    return ('error' in res && res.error) || null
  },

  exportPdf: async (html) => {
    const cur = get().doc
    if (!cur) return hostT('doc.importing')
    const res = await we.exportPdf({ html, title: cur.title })
    return ('error' in res && res.error) || null
  },

  importDoc: async (path) => {
    const res = await we.importDocx(path)
    if ('doc' in res && res.doc) {
      get().applyDoc(res.doc)
      await get().loadDocs()
      return null
    }
    return ('error' in res && res.error) || null
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
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    await get().flushSave()
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
    set({ chats: (await we.listChats()) as any })
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
      isStreaming: false
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

  deleteMessage: async (msgId) => {
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
    // 发送前先保存（确保 AI 工具看到最新正文）
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    await get().flushSave()

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
      conversationId: conversationId ?? undefined
    })

    if ('error' in res) {
      set((state) => {
        const msgs = [...state.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, isStreaming: false, isError: true }
        }
        return { messages: msgs, isStreaming: false, chatError: res.error }
      })
      return
    }
    const conversRes = res as { conversationId?: string; workspacePath?: string | null }
    if (conversRes?.conversationId) {
      set({ conversationId: conversRes.conversationId, workspacePath: conversRes.workspacePath ?? null })
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

// ====== 对话流式事件 → segments（与 data-model 插件一致的简化版） ======

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
      let i = delta.id
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
        updated[i] = { ...updated[i], toolName: delta.name || updated[i].toolName, toolArgsRaw: (updated[i].toolArgsRaw || '') + argsText, toolCallId: delta.id || updated[i].toolCallId }
      }
      return [...msgs.slice(0, -1), { ...last, segments: updated }]
    }
    case 'tool-call': {
      const tc = payload.toolCall ?? {}
      const updated = finalizeStreamingSegs(segs)
      let i = updated.findIndex((s) => s.type === 'tool_call' && !s.isToolComplete && (s.isToolArgsStreaming === true || s.toolCallId === tc.id))
      if (i !== -1) {
        updated[i] = { ...updated[i], toolName: tc.name, toolArgs: tc.arguments, toolArgsRaw: undefined, isToolArgsStreaming: false, toolCallId: tc.id, collapsed: true }
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
      const error = payload.error ?? hostT('inline.generating')
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
