// AI 文档操作宿主（渲染端）
//
// 订阅主进程下发的文档操作，在当前编辑器内容上执行，并把「结果 + 操作后的 Document JSON」
// 回传主进程。主进程持久化后广播 doc-changed，由 WordEditorPage 应用到编辑器
// （与快照恢复同一条链路），避免两处各自改文档导致状态分叉。

import { we, hostT } from './store'
import { getEditorBridge, useWordEditorStore } from './word-editor.store'
import { runDocOp, type DocOpResult } from './doc-ops'

interface DocOpPayload {
  opId: string
  op: string
  args?: Record<string, unknown>
}

/** 安装文档操作宿主，返回卸载函数 */
export function installDocOpHost(): () => void {
  const unsubscribe = we.onDocOp((payload) => void handleDocOp(payload))
  void we.attachDocOp(true)
  return () => {
    unsubscribe()
    void we.attachDocOp(false)
  }
}

async function handleDocOp(payload: DocOpPayload): Promise<void> {
  const opId = payload?.opId
  if (!opId) return
  const outcome = await execute(payload)
  try {
    await we.docOpResult({ opId, ...outcome })
  } catch {
    // 主进程已超时或插件正在卸载：结果无人接收，忽略即可
  }
}

async function execute(payload: DocOpPayload): Promise<DocOpResult> {
  const bridge = getEditorBridge()
  if (!bridge) return { error: hostT('page.editorNotReady') }
  const doc = useWordEditorStore.getState().doc
  if (!doc) return { error: hostT('errors.noDoc') }
  const result = await runDocOp(bridge.getData(), payload.op, payload.args ?? {})
  // 回报实际操作的文档，主进程据此校验后再落库
  return { ...result, docId: doc.id }
}
