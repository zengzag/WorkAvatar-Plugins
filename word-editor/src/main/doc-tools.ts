// word-editor 的 AI 文档工具
//
// 工具在主进程定义（进入宿主 agent 工具表），实际执行经文档桥下发到渲染端，
// 由 wordcanvas 自带的 headless 编辑引擎作用于「当前打开的文档」。
// 工具名/描述面向 LLM，不做本地化。

import type { PluginToolDefinition } from '@workavatar/plugin-sdk'
import { docStore } from './doc-store'
import { docOpBridge, type DocOpOutcome } from './doc-op-bridge'
import { DOC_OPS, MUTATING_DOC_OPS } from '../shared/doc-ops'

export interface DocOpInvoker {
  request(op: string, args: Record<string, unknown>): Promise<DocOpOutcome>
}

export interface DocToolsOptions {
  /** 文档操作通道（默认走真实文档桥；单测可注入假实现） */
  bridge?: DocOpInvoker
  /** 文档内容更新后的通知（用于广播给渲染端应用） */
  onDocChanged?: (docId: string, data: string) => void
  /** AI 编辑前自动快照的标签 */
  snapshotLabel?: string
}

export type DocToolHandler = (args: Record<string, unknown>) => Promise<unknown>

/** 工具执行超时：留出余量，使文档桥自身的超时提示先生效 */
const TOOL_TIMEOUT_MS = 30_000

/** 一次 AI 回复期间的状态：首个改动前自动落一条快照，便于用户回退整轮改动 */
let turnActive = false
let turnSnapshotTaken = false

export function beginAiEditTurn(): void {
  turnActive = true
  turnSnapshotTaken = false
}

export function endAiEditTurn(): void {
  turnActive = false
}

export function createWordEditorAgentTools(options: DocToolsOptions = {}): PluginToolDefinition[] {
  const bridge = options.bridge ?? docOpBridge
  const snapshotLabel = options.snapshotLabel ?? 'AI 编辑前'
  const onDocChanged = options.onDocChanged

  const run = (op: string): DocToolHandler => {
    const mutating = MUTATING_DOC_OPS.has(op)
    return async (args) => {
      const doc = docStore.getCurrentDoc()
      if (!doc) {
        return { success: false, error: '当前没有打开的文档，请先在「文档编辑」中打开或新建文档。' }
      }
      // 本轮改动前的内容：用于首个成功改动落地前的自动快照
      const before = doc.data

      const outcome = await bridge.request(op, args ?? {}, doc.id)
      if (outcome.error) return { success: false, error: outcome.error }

      if (mutating && outcome.data) {
        // 渲染端操作的文档与主进程当前文档不一致（用户中途切换）时放弃落库，避免写错文档
        if (outcome.docId && outcome.docId !== doc.id) {
          return { success: false, error: '文档已切换，本次改动未保存，请重新发起。' }
        }
        takeTurnSnapshot(doc.id, before, snapshotLabel)
        docStore.saveData(doc.id, outcome.data)
        onDocChanged?.(doc.id, outcome.data)
      }
      return { success: true, output: outcome.output ?? '已完成。' }
    }
  }

  const tools: PluginToolDefinition[] = [
    {
      id: DOC_OPS.outline,
      name: DOC_OPS.outline,
      title: DOC_OPS.outline,
      description:
        '获取当前文档的结构概览：顶层块清单（序号、块 id、段落文本预览与字数、命名样式、表格行列）、段落与字数统计、可用样式名。' +
        '修改文档前必须先调用它了解现状与块 id；不要凭猜测编造块 id。',
      summary: '查看文档结构与块 id',
      parameters: { type: 'object', properties: {} },
      handler: run(DOC_OPS.outline),
    },
    {
      id: DOC_OPS.read,
      name: DOC_OPS.read,
      title: DOC_OPS.read,
      description:
        '读取文档正文（带顶层序号与块 id）。默认读取全文，可用 startIndex/endIndex 指定顶层块范围、用 blockIds 指定若干块、用 maxChars 限制返回长度。' +
        '需要逐字润色或核对内容时使用；内容很长时应分段读取。',
      summary: '读取文档正文',
      parameters: {
        type: 'object',
        properties: {
          startIndex: { type: 'number', description: '起始顶层块序号（含），从 0 开始' },
          endIndex: { type: 'number', description: '结束顶层块序号（含）' },
          blockIds: { type: 'array', items: { type: 'string' }, description: '只读取这些块 id' },
          maxChars: { type: 'number', description: '返回文本的最大字符数，默认 12000' },
        },
      },
      handler: run(DOC_OPS.read),
    },
    {
      id: DOC_OPS.find,
      name: DOC_OPS.find,
      title: DOC_OPS.find,
      description: '在文档中查找文本，返回匹配所在的块 id、顶层序号、字符偏移与上下文片段。用于定位待修改的位置。',
      summary: '在文档中查找文本位置',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查找的文本' },
          maxResults: { type: 'number', description: '最多返回的匹配数，默认 20' },
        },
        required: ['query'],
      },
      handler: run(DOC_OPS.find),
    },
    {
      id: DOC_OPS.setParagraphText,
      name: DOC_OPS.setParagraphText,
      title: DOC_OPS.setParagraphText,
      description:
        '用新文本整段替换某个段落的正文（保留该段已有的字符样式）。适合逐段改写、润色、纠正整段内容。' +
        'blockId 必须来自 doc_outline 或 doc_find 的结果。',
      summary: '整段替换段落正文',
      parameters: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: '目标段落块 id' },
          text: { type: 'string', description: '替换后的段落正文（纯文本）' },
        },
        required: ['blockId', 'text'],
      },
      handler: run(DOC_OPS.setParagraphText),
    },
    {
      id: DOC_OPS.replace,
      name: DOC_OPS.replace,
      title: DOC_OPS.replace,
      description:
        '查找并替换文本。默认替换全文所有匹配（逐段逐样式片段替换，格式保持不动）；all 传 false 时只替换第一处。' +
        '适合错别字修正、术语统一等精确改动。',
      summary: '查找并替换文本',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: '被替换的文本' },
          replace: { type: 'string', description: '替换成的文本，空串表示删除' },
          all: { type: 'boolean', description: '是否替换全部匹配，默认 true' },
        },
        required: ['search', 'replace'],
      },
      handler: run(DOC_OPS.replace),
    },
    {
      id: DOC_OPS.insertParagraph,
      name: DOC_OPS.insertParagraph,
      title: DOC_OPS.insertParagraph,
      description:
        '插入一个新段落。用 referenceBlockId 指定参照块（须是顶层块），position 决定插在它前面还是后面；' +
        '不传 referenceBlockId 时追加到文末。可用 styleName 直接套用命名样式（如 "Heading 1"）。' +
        '插入摘要、小标题、补充说明时使用。',
      summary: '插入新段落',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '新段落正文' },
          referenceBlockId: { type: 'string', description: '参照的顶层块 id，缺省追加到文末' },
          position: { type: 'string', enum: ['before', 'after'], description: '插在参照块之前还是之后，默认 after' },
          styleName: { type: 'string', description: '可选：命名样式，如 Title / Heading 1 / Heading 2 / Quote' },
        },
        required: ['text'],
      },
      handler: run(DOC_OPS.insertParagraph),
    },
    {
      id: DOC_OPS.deleteBlocks,
      name: DOC_OPS.deleteBlocks,
      title: DOC_OPS.deleteBlocks,
      description: '按 id 删除顶层块（段落 / 表格 / 图片）。删除前先用 doc_outline 或 doc_find 确认目标内容。',
      summary: '删除顶层块',
      parameters: {
        type: 'object',
        properties: {
          blockIds: { type: 'array', items: { type: 'string' }, description: '要删除的顶层块 id 列表' },
        },
        required: ['blockIds'],
      },
      handler: run(DOC_OPS.deleteBlocks),
    },
    {
      id: DOC_OPS.moveBlock,
      name: DOC_OPS.moveBlock,
      title: DOC_OPS.moveBlock,
      description: '把某个顶层块移动到新的顶层位置（toIndex 为移动后的序号，从 0 开始）。用于调整段落/章节顺序。',
      summary: '调整顶层块顺序',
      parameters: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: '要移动的顶层块 id' },
          toIndex: { type: 'number', description: '目标顶层序号' },
        },
        required: ['blockId', 'toIndex'],
      },
      handler: run(DOC_OPS.moveBlock),
    },
    {
      id: DOC_OPS.applyStyle,
      name: DOC_OPS.applyStyle,
      title: DOC_OPS.applyStyle,
      description:
        '为段落套用命名样式（Title / Subtitle / Heading 1 / Heading 2 / Quote / Code / Normal），会同时烘焙对应的字形与段落格式。' +
        '排版优化、标题层级整理时使用；可用样式名见 doc_outline 的返回。',
      summary: '套用命名样式',
      parameters: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: '目标段落块 id' },
          styleName: { type: 'string', description: '样式名，如 Heading 1' },
        },
        required: ['blockId', 'styleName'],
      },
      handler: run(DOC_OPS.applyStyle),
    },
  ]

  // 文档工具都作用于用户正在编辑的实时文档，重试可能造成重复改动，故统一禁用 retry
  return tools.map((tool) => ({ ...tool, noRetry: true, timeoutMs: TOOL_TIMEOUT_MS }))
}

/** 每轮 AI 回复的首次改动前落一条快照（同一轮内只落一次） */
function takeTurnSnapshot(docId: string, data: string, label: string): void {
  if (!turnActive || turnSnapshotTaken) return
  turnSnapshotTaken = true
  try {
    docStore.createSnapshot(docId, label, data)
  } catch {
    // 快照失败不影响编辑本身
  }
}
