/** 渲染端宿主引用与 IPC 便捷封装 */
import type { PluginRendererHost } from '@workavatar/plugin-sdk/renderer'
import type { PluginWorkflowRun, PluginWorkflowRunEvent } from '@workavatar/plugin-sdk'

let hostRef: PluginRendererHost | null = null

export function setHost(host: PluginRendererHost | null): void {
  hostRef = host
}

export function getHost(): PluginRendererHost | null {
  return hostRef
}

export function t(key: string, options?: Record<string, unknown>): string {
  return hostRef?.i18n.t(key, options as never) ?? key
}

/** 调用插件主进程 IPC，异常统一转为 { error } */
export async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  if (!hostRef) throw new Error('plugin host not ready')
  return hostRef.bridge.invoke<T>(channel, payload)
}

export function onRunEvent(callback: (event: PluginWorkflowRunEvent) => void): () => void {
  if (!hostRef) return () => {}
  return hostRef.bridge.onEvent('run-event', (payload) => callback(payload as PluginWorkflowRunEvent))
}

/** 订阅模板变更（主进程在任意写操作后广播，含 LLM 经 agent 工具的增删改） */
export function onTemplatesChanged(callback: () => void): () => void {
  if (!hostRef) return () => {}
  return hostRef.bridge.onEvent('templates-changed', () => callback())
}

export type { PluginWorkflowRun, PluginWorkflowRunEvent }
