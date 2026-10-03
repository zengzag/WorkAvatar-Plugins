// 文档操作桥（主进程侧）
//
// AI 工具在主进程执行，而文档内容与编辑能力都在渲染端的 wordcanvas 编辑器里。
// 故工具经 broadcast('doc-op') 把操作下发到渲染端，渲染端在当前文档上执行后
// 经 IPC 'doc-op-result' 回传结果（含执行后的 Document JSON）。

import type { PluginContext } from '@workavatar/plugin-sdk'

export interface DocOpOutcome {
  /** 执行后的 Document JSON（写操作） */
  data?: string
  /** 面向 LLM 的可读结果 */
  output?: string
  /** 失败原因（面向 LLM 的中文说明） */
  error?: string
  /** 渲染端实际操作的文档 id */
  docId?: string
}

export interface DocOpRequestPayload {
  opId: string
  op: string
  args: Record<string, unknown>
  /** 目标文档 id：多窗口下非该文档的编辑器实例忽略本次操作，避免重复执行 */
  docId?: string
}

interface PendingOp {
  resolve: (outcome: DocOpOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

/** 渲染端执行超时：文档操作都是内存内的模型计算，正常在毫秒级完成。
 *  设得比宿主工具超时短，保证超时时返回可读提示而不是被宿主中断。 */
const OP_TIMEOUT_MS = 20_000

class DocOpBridge {
  private ctx: PluginContext | null = null
  private pending = new Map<string, PendingOp>()
  private attached = false
  private seq = 0

  init(ctx: PluginContext): void {
    this.ctx = ctx
  }

  /** 渲染端挂载/卸载文档编辑器页面时上报，未挂载时工具立即失败而非等待超时 */
  setAttached(attached: boolean): void {
    this.attached = attached
  }

  /** 下发一次文档操作并等待渲染端结果 */
  request(op: string, args: Record<string, unknown>, docId?: string): Promise<DocOpOutcome> {
    if (!this.ctx) return Promise.resolve({ error: '文档编辑服务未就绪，请稍后重试。' })
    if (!this.attached) {
      return Promise.resolve({ error: '文档编辑器未打开，请先打开「文档编辑」页面再让我操作文档。' })
    }
    const opId = `op_${Date.now().toString(36)}_${(this.seq++).toString(36)}`
    return new Promise<DocOpOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(opId)
        resolve({ error: '文档操作超时，请确认文档编辑器处于打开状态后重试。' })
      }, OP_TIMEOUT_MS)
      this.pending.set(opId, { resolve, timer })
      this.ctx!.ipc.broadcast('doc-op', { opId, op, args, docId } satisfies DocOpRequestPayload)
    })
  }

  /** 渲染端回传结果（IPC handler 调用） */
  settle(payload: unknown): { ok: boolean } {
    const { opId, data, output, error, docId } = (payload ?? {}) as { opId?: string } & DocOpOutcome
    if (!opId) return { ok: false }
    const item = this.pending.get(opId)
    if (!item) return { ok: false }
    clearTimeout(item.timer)
    this.pending.delete(opId)
    item.resolve({ data, output, error, docId })
    return { ok: true }
  }

  /** 插件停用时清空挂起请求，避免工具永远等待 */
  cancelAll(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.resolve({ error: '文档操作已取消。' })
    }
    this.pending.clear()
  }
}

export const docOpBridge = new DocOpBridge()
