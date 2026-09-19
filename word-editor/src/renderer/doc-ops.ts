// 文档操作执行器（渲染端）
//
// AI 工具下发的文档操作在这里作用于「编辑器当前内容」：用 wordcanvas 自带的 headless
// 编辑引擎（vendor query.js 的 DocumentEditor）计算新的 Document JSON，再回传主进程
// 持久化并广播 doc-changed，由编辑器整体应用。
// 之所以不直接改 DOM/编辑器内部状态：headless 引擎与渲染共用同一套模型与事务语义，
// 产出必然合法（含 revision、样式烘焙等），且不依赖编辑器未公开的内部 API。

import {
  loadQueryModule,
  type DocBlock,
  type DocDocument,
  type DocEditor,
  type DocParagraph,
  type DocQueryModule,
  type DocRunStyle,
  type DocStylesheet,
} from './wordcanvas-loader'
import { DEFAULT_STYLESHEET } from '../shared/doc-styles'
import { DOC_OPS } from '../shared/doc-ops'

export interface DocOpResult {
  /** 操作后的 Document JSON（仅写操作返回） */
  data?: string
  /** 面向 LLM 的可读结果 */
  output?: string
  /** 失败原因 */
  error?: string
  /** 实际被操作的文档 id（由渲染端宿主回填，主进程落库前校验） */
  docId?: string
}

const EMPTY_HINT = '（空）'
const MAX_READ_CHARS = 12000

/** 执行一次文档操作：加载编辑引擎 → 计算变更 */
export async function runDocOp(dataJson: string, op: string, args: Record<string, unknown>): Promise<DocOpResult> {
  let mod: DocQueryModule
  try {
    mod = await loadQueryModule()
  } catch (e) {
    return { error: `文档编辑引擎加载失败：${errText(e)}` }
  }
  return applyDocOp(mod, dataJson, op, args)
}

/** 与引擎无关的纯计算部分（单测直接注入 vendor 模块调用） */
export function applyDocOp(
  mod: DocQueryModule,
  dataJson: string,
  op: string,
  args: Record<string, unknown>
): DocOpResult {
  let doc: DocDocument
  try {
    doc = JSON.parse(dataJson) as DocDocument
  } catch {
    return { error: '文档数据解析失败' }
  }
  if (!doc || !Array.isArray(doc.blocks)) return { error: '文档数据无效' }

  try {
    switch (op) {
      case DOC_OPS.outline:
        return { output: describeOutline(mod, doc) }
      case DOC_OPS.read:
        return { output: readText(mod, doc, args) }
      case DOC_OPS.find:
        return { output: findText(mod, doc, args) }
      case DOC_OPS.setParagraphText:
        return setParagraphText(mod, doc, args)
      case DOC_OPS.replace:
        return replaceText(mod, doc, args)
      case DOC_OPS.insertParagraph:
        return insertParagraph(mod, doc, args)
      case DOC_OPS.deleteBlocks:
        return deleteBlocks(mod, doc, args)
      case DOC_OPS.moveBlock:
        return moveBlock(mod, doc, args)
      case DOC_OPS.applyStyle:
        return applyStyle(mod, doc, args)
      default:
        return { error: `未知文档操作：${op}` }
    }
  } catch (e) {
    return { error: errText(e) }
  }
}

// ====== 读操作 ======

function describeOutline(mod: DocQueryModule, doc: DocDocument): string {
  const blocks = doc.blocks
  const paragraphs = mod.getParagraphs(doc)
  const chars = paragraphs.reduce((n, p) => n + runText(p.runs).length, 0)
  const lines = [
    `顶层块 ${blocks.length} 个，段落 ${paragraphs.length} 个，正文约 ${chars} 字。`,
    `可用命名样式：${styleNames(doc).join(' / ')}`,
  ]
  if (blocks.length === 0) {
    lines.push('（文档为空，可用 doc_insert_paragraph 写入内容）')
    return lines.join('\n')
  }
  lines.push('顶层块清单：')
  blocks.forEach((b, i) => lines.push(`${i}. ${describeBlock(mod, doc, b)}`))
  return lines.join('\n')
}

function describeBlock(mod: DocQueryModule, doc: DocDocument, block: DocBlock): string {
  if (block.kind === 'paragraph') {
    const text = mod.textOf(block)
    const named = namedStyleName(doc, block)
    const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text
    return `[${block.id}] 段落${named ? `（${named}）` : ''} ${text.length} 字：${preview || EMPTY_HINT}`
  }
  if (block.kind === 'table') {
    const rows = block.rows?.length ?? 0
    const cols = block.rows?.[0]?.cells?.length ?? 0
    const header = (block.rows?.[0]?.cells ?? []).map((c) => cellText(mod, c)).filter(Boolean).join(' | ')
    return `[${block.id}] 表格 ${rows} 行 × ${cols} 列${header ? `，表头：${header}` : ''}`
  }
  const text = mod.textOf(block)
  return `[${block.id}] ${block.kind}${text ? `：${text.slice(0, 60)}` : ''}`
}

function readText(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): string {
  const blocks = doc.blocks
  if (blocks.length === 0) return '（文档为空）'

  let picked = blocks.map((block, index) => ({ block, index }))
  const ids = stringArray(args.blockIds)
  if (ids.length > 0) {
    const wanted = new Set(ids)
    picked = picked.filter((p) => wanted.has(p.block.id))
    if (picked.length === 0) return `未找到指定块：${ids.join(', ')}`
  } else {
    const start = numberArg(args.startIndex)
    const end = numberArg(args.endIndex)
    if (start !== null) picked = picked.filter((p) => p.index >= start)
    if (end !== null) picked = picked.filter((p) => p.index <= end)
  }

  const limit = Math.min(Math.max(numberArg(args.maxChars) ?? MAX_READ_CHARS, 500), 40000)
  const out: string[] = []
  let used = 0
  let truncated = false
  for (const { block, index } of picked) {
    const text = mod.textOf(block)
    const line = `${index}. [${block.id}] ${text || EMPTY_HINT}`
    if (used + line.length > limit) {
      truncated = true
      break
    }
    out.push(line)
    used += line.length
  }
  if (truncated) out.push(`…（已截断，可用 startIndex / endIndex / blockIds 分段读取）`)
  return out.join('\n')
}

function findText(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): string {
  const query = stringArg(args.query)
  if (!query) return '缺少 query 参数。'
  const max = Math.min(Math.max(numberArg(args.maxResults) ?? 20, 1), 100)
  const indexOfBlock = new Map(doc.blocks.map((b, i) => [b.id, i]))
  const hits: string[] = []

  for (const p of mod.getParagraphs(doc)) {
    const text = mod.textOf(p)
    let from = 0
    while (hits.length < max) {
      const at = text.indexOf(query, from)
      if (at === -1) break
      const snippet = text.slice(Math.max(0, at - 20), Math.min(text.length, at + query.length + 20))
      const pos = indexOfBlock.has(p.id) ? String(indexOfBlock.get(p.id)) : '嵌套块'
      hits.push(`位置 ${pos} [${p.id}] 偏移 ${at}：…${snippet}…`)
      from = at + query.length
    }
    if (hits.length >= max) break
  }
  if (hits.length === 0) return `未找到「${query}」。`
  return `找到 ${hits.length} 处匹配：\n${hits.join('\n')}`
}

// ====== 写操作 ======

function setParagraphText(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): DocOpResult {
  const blockId = stringArg(args.blockId)
  if (!blockId) return { error: '缺少 blockId 参数。' }
  const text = stringArg(args.text)

  const editor = newEditor(mod, doc)
  const paragraph = editor.getParagraph(blockId)
  if (!paragraph) return { error: `未找到段落 ${blockId}，请先用 ${DOC_OPS.outline} 获取准确的块 id。` }
  // 保留该段原有字符样式（空段落无样式可继承时用默认样式）
  const runStyle: DocRunStyle = paragraph.runs[0]?.style ?? normalRunStyle(doc)
  editor.setParagraphText(blockId, text, runStyle)
  return { data: dump(editor), output: `已更新段落 [${blockId}] 的正文（${text.length} 字）。` }
}

function replaceText(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): DocOpResult {
  const search = stringArg(args.search)
  if (!search) return { error: '缺少 search 参数。' }
  const replace = stringArg(args.replace)
  const editor = newEditor(mod, doc)

  if (args.all === false) {
    const hit = firstMatch(mod, doc, search)
    if (!hit) return { output: `未找到「${search}」，文档未改动。` }
    editor.replaceText(hit.blockId, hit.offset, hit.offset + search.length, replace)
    return { data: dump(editor), output: `已替换 1 处：「${search}」→「${replace}」（块 [${hit.blockId}]）。` }
  }

  const count = countRunMatches(mod, doc, search)
  if (count === 0) return { output: `未找到「${search}」，文档未改动。` }
  editor.replaceAllText(search, replace)
  return { data: dump(editor), output: `已替换 ${count} 处：「${search}」→「${replace}」。` }
}

function insertParagraph(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): DocOpResult {
  const text = stringArg(args.text)
  const referenceId = stringArg(args.referenceBlockId)
  const position: 'before' | 'after' = args.position === 'before' ? 'before' : 'after'
  const styleName = stringArg(args.styleName)
  const editor = newEditor(mod, doc, Boolean(styleName))

  let newId: string | null = null
  if (referenceId) {
    const ref = doc.blocks.find((b) => b.id === referenceId)
    if (!ref) {
      return { error: `块 ${referenceId} 不在文档顶层，结构性操作只能针对顶层块（见 ${DOC_OPS.outline}）。` }
    }
    // 参照块非段落时无法继承段落样式，显式给出默认样式
    const options = ref.kind === 'paragraph'
      ? { position }
      : { position, style: normalParaStyle(doc), runStyle: normalRunStyle(doc) }
    editor.insertParagraph(referenceId, text, options)
    newId = editor.lastInsertedId
  } else {
    const lastParagraph = [...doc.blocks].reverse().find((b) => b.kind === 'paragraph')
    if (lastParagraph) {
      editor.insertParagraph(lastParagraph.id, text, { position: 'after' })
      newId = editor.lastInsertedId
    } else {
      newId = appendParagraph(editor, doc, text)
    }
  }
  if (!newId) return { error: '插入段落失败。' }

  if (styleName) {
    const styled = trySetStyle(editor, doc, newId, styleName)
    if (styled) return { error: styled }
  }
  return { data: dump(editor), output: `已插入新段落 [${newId}]（${text.length} 字）${styleName ? `，样式「${styleName}」` : ''}。` }
}

function deleteBlocks(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): DocOpResult {
  const ids = stringArray(args.blockIds)
  if (ids.length === 0) return { error: '缺少 blockIds 参数。' }
  const existing = new Set(doc.blocks.map((b) => b.id))
  const targets = ids.filter((id) => existing.has(id))
  const missing = ids.filter((id) => !existing.has(id))
  if (targets.length === 0) return { error: `指定的块都不在文档顶层，未删除任何内容：${missing.join(', ')}` }

  const editor = newEditor(mod, doc)
  for (const id of targets) editor.removeBlock(id)
  const skipped = missing.length > 0 ? `；忽略不存在的 id：${missing.join(', ')}` : ''
  return { data: dump(editor), output: `已删除 ${targets.length} 个顶层块${skipped}。` }
}

function moveBlock(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): DocOpResult {
  const blockId = stringArg(args.blockId)
  if (!blockId) return { error: '缺少 blockId 参数。' }
  const toIndex = numberArg(args.toIndex)
  if (toIndex === null) return { error: '缺少 toIndex 参数。' }
  if (!doc.blocks.some((b) => b.id === blockId)) {
    return { error: `块 ${blockId} 不在文档顶层，未做改动（见 ${DOC_OPS.outline}）。` }
  }
  const editor = newEditor(mod, doc)
  editor.moveBlock(blockId, Math.trunc(toIndex))
  return { data: dump(editor), output: `已把块 [${blockId}] 移动到顶层位置 ${Math.trunc(toIndex)}。` }
}

function applyStyle(mod: DocQueryModule, doc: DocDocument, args: Record<string, unknown>): DocOpResult {
  const blockId = stringArg(args.blockId)
  const styleName = stringArg(args.styleName)
  if (!blockId || !styleName) return { error: '缺少 blockId 或 styleName 参数。' }

  const editor = newEditor(mod, doc, true)
  if (!editor.getParagraph(blockId)) return { error: `未找到段落 ${blockId}（样式只能套用在段落上）。` }
  const failed = trySetStyle(editor, doc, blockId, styleName)
  if (failed) return { error: failed }
  return { data: dump(editor), output: `已为段落 [${blockId}] 套用样式「${styleName}」。` }
}

// ====== 引擎与文档辅助 ======

/** 创建编辑引擎；needsStyles 时补齐默认样式表（命名样式依赖样式表） */
function newEditor(mod: DocQueryModule, doc: DocDocument, needsStyles = false): DocEditor {
  return new mod.DocumentEditor(needsStyles ? ensureStylesheet(doc) : doc)
}

function ensureStylesheet(doc: DocDocument): DocDocument {
  if (doc.stylesheet?.styles?.length) return doc
  return { ...doc, stylesheet: DEFAULT_STYLESHEET as DocStylesheet }
}

function trySetStyle(editor: DocEditor, doc: DocDocument, blockId: string, styleName: string): string | null {
  try {
    editor.setStyleByName(blockId, styleName)
    return null
  } catch {
    return `文档中没有样式「${styleName}」。可用样式：${styleNames(doc).join(' / ')}`
  }
}

/** 在文末追加段落（文档为空或末块非段落且无段落可参照时使用） */
function appendParagraph(editor: DocEditor, doc: DocDocument, text: string): string {
  const id = `par_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const block: DocParagraph = {
    kind: 'paragraph',
    id,
    revision: 0,
    runs: text ? [{ text, style: normalRunStyle(doc) }] : [],
    style: normalParaStyle(doc),
  }
  editor.commit([{ type: 'insertBlock', index: doc.blocks.length, block, where: 'body' }])
  return id
}

function normalStyleDef(doc: DocDocument) {
  const sheet = (doc.stylesheet?.styles?.length ? doc.stylesheet : DEFAULT_STYLESHEET) as DocStylesheet
  return sheet.styles.find((s) => s.id === sheet.defaultStyleId) ?? sheet.styles[0]
}

function normalRunStyle(doc: DocDocument): DocRunStyle {
  return { ...(normalStyleDef(doc)?.char ?? {}) }
}

function normalParaStyle(doc: DocDocument): Record<string, unknown> {
  return { ...(normalStyleDef(doc)?.para ?? {}) }
}

function styleNames(doc: DocDocument): string[] {
  const sheet = doc.stylesheet?.styles?.length ? doc.stylesheet : DEFAULT_STYLESHEET
  return sheet.styles.map((s) => s.name)
}

function namedStyleName(doc: DocDocument, block: DocBlock): string {
  const named = block.style?.namedStyle
  if (typeof named !== 'string') return ''
  const sheet = (doc.stylesheet?.styles?.length ? doc.stylesheet : DEFAULT_STYLESHEET) as DocStylesheet
  return sheet.styles.find((s) => s.id === named)?.name ?? named
}

function cellText(mod: DocQueryModule, cell: { blocks?: DocBlock[] }): string {
  return (cell.blocks ?? []).map((b) => mod.textOf(b)).filter(Boolean).join(' ')
}

function runText(runs: Array<{ text?: string }> | undefined): string {
  return (runs ?? []).map((r) => r.text ?? '').join('')
}

/** 按 replaceAllText 的语义（逐个 run 内替换）统计命中数 */
function countRunMatches(mod: DocQueryModule, doc: DocDocument, search: string): number {
  let count = 0
  for (const p of mod.getParagraphs(doc)) {
    for (const run of p.runs ?? []) {
      const text = run.text ?? ''
      let from = 0
      for (;;) {
        const at = text.indexOf(search, from)
        if (at === -1) break
        count++
        from = at + search.length
      }
    }
  }
  return count
}

function firstMatch(mod: DocQueryModule, doc: DocDocument, search: string): { blockId: string; offset: number } | null {
  for (const p of mod.getParagraphs(doc)) {
    const at = mod.textOf(p).indexOf(search)
    if (at >= 0) return { blockId: p.id, offset: at }
  }
  return null
}

function dump(editor: DocEditor): string {
  return JSON.stringify(editor.doc)
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function numberArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
