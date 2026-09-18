// AI 文档编辑会话：主进程代理"当前文档"的工具操作，改动后统一落盘 + 广播 doc-changed。
// 渲染端按 source:'ai' 应用远程文档，自身编辑同步走 doc-sync（不广播回环）。

import type { PluginContext } from '@workavatar/plugin-sdk'
import type { ToolResult } from '../shared/doc-tools'
import {
  DOC_TOOLS, getToolByName,
  setCurrentDoc as setToolDoc, getCurrentDoc as getToolDoc, consumeDirtyHtml,
} from '../shared/doc-tools'
import { docStore } from './doc-store'

let ctxRef: PluginContext | null = null

export function initDocSession(ctx: PluginContext): void {
  ctxRef = ctx
}

/** 渲染端打开/保存文档时同步镜像（仅当 AI 工具操作同一文档） */
export function syncCurrentDoc(id: string | null): void {
  if (id === null) {
    setToolDoc(null)
    return
  }
  const rec = docStore.get(id)
  if (rec) setToolDoc({ id: rec.id, title: rec.title, html: rec.html })
}

/** 渲染端把最新的正文 HTML 推给镜像（doc-sync），AI 工具随后操作以此为准 */
export function syncCurrentDocHtml(id: string, html: string): void {
  const doc = getToolDoc()
  if (doc && doc.id === id) setToolDoc({ id, title: doc.title, html })
}

/** 把工具造成的新 HTML 落盘并广播给渲染端 */
function flushAiChange(): void {
  const html = consumeDirtyHtml()
  const doc = getToolDoc()
  if (html === null || doc === null || !ctxRef) return
  docStore.saveHtml(doc.id, html)
  ctxRef.ipc.broadcast('doc-changed', {
    doc: { id: doc.id, title: doc.title, html },
    source: 'ai',
  })
}

export function applyDocTool(name: string, args: unknown): ToolResult {
  const tool = getToolByName(name)
  if (!tool) return { ok: false, error: `未知工具: ${name}` }
  if (!ctxRef) return { ok: false, error: 'DocSession 未初始化' }
  try {
    const result = tool.execute(args as Record<string, unknown>)
    if (result.ok) flushAiChange()
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `工具执行异常: ${msg}` }
  }
}

/** 生成宿主 agent 工具定义（经 registerAgentTools 注册） */
export function createDocAgentTools() {
  return DOC_TOOLS.map((tool) => ({
    id: tool.name,
    name: tool.name,
    title: tool.title,
    description: tool.description,
    summary: tool.description.split('。')[0],
    parameters: tool.parameters as any,
    onDemand: false,
    permission: 'safe' as const,
    handler: (args: Record<string, unknown>) => {
      const result = applyDocTool(tool.name, args)
      if (result.ok) {
        let output = result.message ?? ''
        if (result.data !== undefined) {
          try {
            const dataStr = JSON.stringify(result.data, null, 2)
            if (dataStr && dataStr !== '{}') output = output ? `${output}\n\n${dataStr}` : dataStr
          } catch { /* ignore */ }
        }
        return { success: true, output, ...(result.data !== undefined ? { data: result.data } : {}) }
      }
      return { success: false, error: result.error ?? '执行失败' }
    },
  }))
}
