// 渲染端桥接封装：bridge + i18n + IPC 通道 + 主题

import { useState, useEffect } from 'react'
import type { PluginBridge, PluginHostCapabilities } from '@workavatar/plugin-sdk/renderer'

export interface DocMeta {
  id: string
  title: string
  updatedAt: number
  sourcePath?: string | null
}

export interface DocRecord extends DocMeta {
  /** wordcanvas Document 模型 JSON */
  data: string
}

export interface SnapshotMeta {
  id: string
  docId: string
  label: string
  createdAt: number
}

let bridge: PluginBridge | null = null
let hostI18n: ((key: string, options?: Record<string, unknown>) => string) | null = null
let hostCaps: PluginHostCapabilities | null = null

export function setBridge(b: PluginBridge): void { bridge = b }
export function setHostI18n(t: (key: string, options?: Record<string, unknown>) => string): void { hostI18n = t }
export function setHostCapabilities(c: PluginHostCapabilities | undefined): void { hostCaps = c ?? null }

export function getHostCapabilities(): PluginHostCapabilities | null {
  return hostCaps
}

export function hostT(key: string, options?: Record<string, unknown>): string {
  if (hostI18n) return hostI18n(key, options)
  return key
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('插件桥未就绪'))
  return bridge.invoke<T>(channel, payload)
}

export function onEvent(event: string, callback: (payload: unknown) => void): () => void {
  if (!bridge) return () => {}
  return bridge.onEvent(event, callback)
}

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

/** 宿主当前语言（appearance.store 写入 data-locale） */
export function getAppLocale(): 'zh-CN' | 'en-US' {
  return document.documentElement.getAttribute('data-locale') === 'en-US' ? 'en-US' : 'zh-CN'
}

export function useAppearance(): { isDark: boolean; locale: 'zh-CN' | 'en-US' } {
  const [state, setState] = useState(() => ({ isDark: isDarkTheme(), locale: getAppLocale() }))
  useEffect(() => {
    const observer = new MutationObserver(() => setState({ isDark: isDarkTheme(), locale: getAppLocale() }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-locale'] })
    return () => observer.disconnect()
  }, [])
  return state
}

// ====== IPC 通道封装 ======

export const we = {
  // 文档
  listDocs: () => invoke<Array<Omit<DocRecord, 'data'>>>('doc-list'),
  createDoc: (title?: string, data?: string) =>
    invoke<{ doc: DocRecord } | { error: string }>('doc-create', { title, data }),
  openDoc: (id: string) => invoke<{ doc: DocRecord } | { error: string }>('doc-open', { id }),
  deleteDoc: (id: string) => invoke<{ ok: boolean } | { error: string }>('doc-delete', { id }),
  renameDoc: (id: string, title: string) => invoke<{ ok: boolean } | { error: string }>('doc-rename', { id, title }),
  saveDoc: (id: string, data: string, title?: string) =>
    invoke<{ ok: boolean; updatedAt: number } | { error: string }>('doc-save', { id, data, title }),

  // 导入：主进程读字节，渲染端 wordcanvas 解析
  importDocx: (path?: string) =>
    invoke<{ bytes?: Uint8Array; name?: string; sourcePath?: string; error?: string }>('doc-import-file', { path }),

  // 导出：渲染端产出字节，主进程弹框落盘
  exportSave: (bytes: Uint8Array, format: 'docx' | 'pdf', title: string) =>
    invoke<{ ok?: boolean; path?: string; error?: string }>('export-save', { bytes, format, title }),

  // 快照
  listSnapshots: (id: string) => invoke<{ snapshots: SnapshotMeta[] } | { error: string }>('snapshot-list', { id }),
  createSnapshot: (id: string, label?: string) => invoke<{ ok: boolean } | { error: string }>('snapshot-create', { id, label }),
  restoreSnapshot: (snapshotId: string) => invoke<{ ok: boolean } | { error: string }>('snapshot-restore', { snapshotId }),
  deleteSnapshot: (id: string) => invoke<{ ok: boolean } | { error: string }>('snapshot-delete', { id }),

  // AI
  listProviders: () => invoke<any[]>('providers-list'),
  getSettings: () => invoke<{ settings: any }>('settings-get'),
  setSettings: (settings: any) => invoke<{ ok: boolean }>('settings-set', { settings }),
  sendChat: (payload: {
    providerId: string
    modelId?: string
    messages: Array<{ id?: string; role: string; content: string; images?: string[] }>
    conversationId?: string
    assistantId?: string
  }) => invoke<{ conversationId: string; workspacePath?: string | null } | { error: string }>('chat-send', payload),
  cancelChat: (conversationId?: string) => invoke<{ ok: boolean }>('chat-cancel', { conversationId }),
  chatHistory: (conversationId: string) => invoke<any[]>('chat-history', { conversationId }),
  listChats: () => invoke<Array<{ conversationId: string; title: string; updatedAt: number; workspacePath?: string | null }>>('chats-list'),
  deleteChat: (conversationId: string) =>
    invoke<{ ok: boolean; taskDir?: string; taskDirNonEmpty?: boolean } | { error: string }>('chat-delete', { conversationId }),
  openChatDir: (conversationId: string) => invoke<{ ok: boolean; error?: string }>('chat-open-dir', { conversationId }),

  // 事件
  onDocChanged: (cb: (payload: { doc: { id: string; data: string }; source: string }) => void) =>
    onEvent('doc-changed', (p) => cb(p as any)),
  onDocListChanged: (cb: () => void) => onEvent('doc-list-changed', () => cb()),
  onChatsChanged: (cb: () => void) => onEvent('chats-changed', () => cb()),
  onMetaChanged: (cb: (payload: { scope: string }) => void) => onEvent('meta-changed', (p) => cb(p as any)),
  onChatEvent: (cb: (payload: any) => void) => onEvent('chat-event', (p) => cb(p)),
}
