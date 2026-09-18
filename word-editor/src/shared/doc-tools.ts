// 文档编辑工具协议（纯函数，主进程与 agent 工具共用）
// 分层设计：
// - 读取：doc_get_outline（轻量大纲）→ doc_get_blocks（区间/全量读取，含 HTML）
// - 写入：doc_replace_block / doc_insert_block / doc_delete_block / doc_apply_style
// 文档以"顶层块"为粒度（与 TipTap 文档结构的顶层节点对应）。

import { parseBlocks, textToBlock, type BlockTag } from '../main/html-blocks'

export interface ToolResult<T = unknown> {
  ok: boolean
  data?: T
  message?: string
  error?: string
}

export interface ToolDef<A = unknown, R = unknown> {
  name: string
  title: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: A) => ToolResult<R>
}

function ok<T>(data: T, message: string): ToolResult<T> {
  return { ok: true, data, message }
}
function err(error: string): ToolResult<never> {
  return { ok: false, error }
}

let currentDoc: { id: string; title: string; html: string } | null = null
/** 工具写回的最新 HTML（会话层读取后广播并持久化） */
let dirtyHtml: string | null = null

export function setCurrentDoc(doc: { id: string; title: string; html: string } | null): void {
  currentDoc = doc ? { ...doc } : null
  dirtyHtml = null
}

export function getCurrentDoc(): { id: string; title: string; html: string } | null {
  if (!currentDoc) return null
  return { ...currentDoc, html: dirtyHtml ?? currentDoc.html }
}

export function consumeDirtyHtml(): string | null {
  const d = dirtyHtml
  dirtyHtml = null
  return d
}

function requireDoc(): { id: string; title: string; html: string } | ToolResult<never> {
  if (!currentDoc) return err('当前无打开的文档（请先在编辑器中打开一个文档）')
  return currentDoc
}

/** 工具改动后写入 currentDoc.html + dirty，会话层负责统一落盘/广播 */
function commit(nextHtml: string, message: string): ToolResult<never> {
  currentDoc!.html = nextHtml
  dirtyHtml = nextHtml
  return { ok: true, data: { blocks: parseBlocks(nextHtml).length }, message }
}

// ============ 读取：轻量大纲 ============

const getOutlineTool: ToolDef = {
  name: 'doc_get_outline',
  title: '获取文档大纲',
  description: '获取当前文档的轻量大纲：逐块列出索引、标签类型（h1-h6/p/blockquote/ul/ol/table）与纯文本（长文本截断 120 字）。适合快速了解文档结构，修改前先调用。',
  parameters: { type: 'object', properties: {} },
  execute: () => {
    const doc = requireCurrent()
    if ('ok' in doc && doc.ok === false) return doc
    const dd = doc as { id: string; title: string; html: string }
    const blocks = parseBlocks(dd.html)
    const data = {
      id: dd.id,
      title: dd.title,
      blocksCount: blocks.length,
      blocks: blocks.map((b) => ({
        index: b.index,
        tag: b.tag,
        text: b.text.length > 100 ? `${b.text.slice(0, 100)}…` : b.text,
      })),
    }
    return ok(data, `文档共 ${blocks.length} 个块`)
  },
}

// ============ 读取：指定区间块 ============

const getBlockTool: ToolDef = {
  name: 'doc_get_block',
  title: '获取文档块',
  description: '获取指定索引区间的文档块完整内容（text 为纯文本、html 为原始 HTML）。用于读取要修改的段落细节。start 与 end 为闭区间索引。',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'integer', description: '起始块索引（从 0 开始）' },
      end: { type: 'integer', description: '结束块索引（含），与 start 相同即读单个块' },
    },
    required: ['start'],
  },
  execute: (args: any) => {
    const doc = requireCurrent()
    if ('ok' in doc && doc.ok === false) return doc
    const dd = doc as { id: string; title: string; html: string }
    const blocks = parseBlocks(dd.html)
    const start = Math.max(0, Math.floor(Number(args?.start ?? 0)))
    const end = Math.min(blocks.length - 1, Math.floor(Number(args?.end ?? start)))
    if (start >= blocks.length || end < start) {
      return err(`无效的块索引区间 [${start}, ${end}]（文档共 ${blocks.length} 个块）`)
    }
    const data = {
      total: blocks.length,
      blocks: blocks.slice(start, end + 1).map((b) => ({ index: b.index, tag: b.tag, text: b.text, html: b.html })),
    }
    return ok(data, `已返回块 ${start}-${end}`)
  },
}

// ============ 写入：替换块 ============

const replaceBlockTool: ToolDef = {
  name: 'doc_replace_block',
  title: '替换文档块',
  description: '按索引替换文档块内容。text 为新纯文本（自动转成对应块标签）；html 可选，用于保留格式（内联 strong/em 或完整块标签）。也可用 matchText/replaceText 做全文文本查找替换（默认替换首个命中，replaceAll=true 时全部替换）。',
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'integer', description: '要替换的块索引（doc_get_outline 获得）' },
      tag: { type: 'string', enum: ['h1', 'h2', 'h3', 'h4', 'p', 'blockquote'], description: '可选：替换后的块标签，默认沿用原块标签' },
      text: { type: 'string', description: '替换后的纯文本（推荐）' },
      html: { type: 'string', description: '替换后的 HTML（可选，优先级高于 text）' },
      matchText: { type: 'string', description: '全文字符串查找替换：要匹配的原文（任一位置首次命中）' },
      replaceText: { type: 'string', description: '与 matchText 配对的替换文本' },
      replaceAll: { type: 'boolean', description: 'matchText 命中全部（默认 false 仅首个）' },
    },
  },
  execute: (args: any) => {
    const doc = requireCurrent()
    if ('ok' in doc && doc.ok === false) return doc
    const dd = doc as { id: string; title: string; html: string }
    // 模式 A：文本查找替换
    if (typeof args?.matchText === 'string' && typeof args?.replaceText === 'string') {
      const found = dd.html.includes(args.matchText)
      if (!found) return err(`未找到匹配文本: ${args.matchText.slice(0, 60)}`)
      let count = 0
      let next: string
      if (args.replaceAll) {
        next = dd.html.split(args.matchText).join(args.replaceText)
        count = next.split(args.replaceText).length - 1
      } else {
        next = dd.html.replace(args.matchText, () => { count = 1; return args.replaceText })
      }
      return commit(next, `已替换 ${count} 处文本`)
    }
    // 模式 B：按索引替换块
    const blocks = parseBlocks(dd.html)
    const idx = Math.floor(Number(args?.index))
    if (!Number.isInteger(idx) || idx < 0 || idx >= blocks.length) {
      return err(`无效的块索引 ${args?.index}（文档共 ${blocks.length} 个块，见 doc_get_outline）`)
    }
    const tag: BlockTag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote'].includes(args?.tag) ? args.tag : blocks[idx].tag) as BlockTag
    let newHtml: string
    if (typeof args?.html === 'string' && args.html.trim()) {
      const h = args.html.trim()
      newHtml = /^<(h[1-6]|p|blockquote|ul|ol|table|pre)\b/.test(h) ? h : textToBlock(tag === 'h5' || tag === 'h6' ? 'p' : tag, args.html)
    } else if (typeof args?.text === 'string') {
      newHtml = textToBlock(tag, args.text)
    } else {
      return err('缺少 text 或 html 参数')
    }
    // 用占位符安全替换（目标块可能包含特殊字符）
    const placeholder = `__WE_BLOCK_${idx}__`
    const withPlaceholder = dd.html.replace(blocks[idx].html, placeholder)
    const next = withPlaceholder.replace(placeholder, () => newHtml)
    return commit(next, `已替换块 ${idx}（${blocks[idx].tag}）`)
  },
}

// ============ 写入：插入块 ============

const insertBlockTool: ToolDef = {
  name: 'doc_insert_block',
  title: '插入文档块',
  description: '在指定索引块之后插入新块。afterIndex=-1 表示插入到文档最前。tag 指定类型（h1-h6/p/blockquote/ul/ol），text 为内容（列表用换行分隔多项）。',
  parameters: {
    type: 'object',
    properties: {
      afterIndex: { type: 'integer', description: '插入到该索引块之后；-1 插入文档最前' },
      tag: { type: 'string', enum: ['h1', 'h2', 'h3', 'h4', 'p', 'blockquote', 'ul', 'ol'], description: '块类型' },
      text: { type: 'string', description: '内容（ul/ol 每行一项）' },
    },
    required: ['afterIndex', 'tag', 'text'],
  },
  execute: (args: any) => {
    const doc = requireCurrent()
    if ('ok' in doc && doc.ok === false) return doc
    const dd = doc as { id: string; title: string; html: string }
    const blocks = parseBlocks(dd.html)
    if (!['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'ul', 'ol'].includes(args?.tag)) {
      return err(`无效的块类型: ${args?.tag}`)
    }
    if (typeof args?.text !== 'string' || !args.text.trim()) return err('缺少 text')
    const after = Math.floor(Number(args?.afterIndex))
    let anchorHtml: string | null = null
    if (after === -1) anchorHtml = null
    else if (after >= 0 && after < blocks.length) anchorHtml = blocks[after].html
    else return err(`无效的块索引 ${after}（文档共 ${blocks.length} 个块）`)
    const newHtml = textToBlock(args.tag as BlockTag, args.text)
    const next = anchorHtml === null ? newHtml + dd.html : dd.html.replace(anchorHtml, anchorHtml + newHtml)
    return commit(next, `已在块 ${after} 后插入 ${args.tag}`)
  },
}

// ============ 写入：删除块 ============

const deleteBlockTool: ToolDef = {
  name: 'doc_delete_block',
  title: '删除文档块',
  description: '按索引删除一个文档块。',
  parameters: {
    type: 'object',
    properties: {
      index: { type: 'integer', description: '要删除的块索引' },
    },
    required: ['index'],
  },
  execute: (args: any) => {
    const doc = requireCurrent()
    if ('ok' in doc && doc.ok === false) return doc
    const dd = doc as { id: string; title: string; html: string }
    const blocks = parseBlocks(dd.html)
    const idx = Math.floor(Number(args?.index))
    if (!Number.isInteger(idx) || idx < 0 || idx >= blocks.length) {
      return err(`无效的块索引 ${args?.index}（文档共 ${blocks.length} 个块）`)
    }
    const placeholder = `__WE_BLOCK_DEL__`
    const next = dd.html.replace(blocks[idx].html, placeholder).replace(placeholder, '')
    return commit(next, `已删除块 ${idx}（${blocks[idx].tag}：${blocks[idx].text.slice(0, 40)}）`)
  },
}

// ============ 写入：样式 ============

const applyStyleTool: ToolDef = {
  name: 'doc_apply_style',
  title: '应用排版样式',
  description: '对文档应用排版指令。一次一个操作（align/color/bold 全局性或按索引）。align 作用于全部段落与标题；color 仅对标题（level 指定级别数组时）或全部段落；bold_index/underline_index 对单块内全部文字生效。扁平好用，避免让 LLM 输出大段样式 HTML。',
  parameters: {
    type: 'object',
    properties: {
      align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: '全部段落与标题的对齐方式' },
      color: { type: 'string', description: '标题颜色（CSS 颜色值，如 #2b579a / darkblue）。配合 levels 指定生效的标题级别，默认全部标题' },
      levels: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 6 }, description: '标题级别过滤数组（如 [1,2] 仅 h1/h2）' },
      boldIndex: { type: 'integer', description: '对该索引块整体加粗' },
      underlineIndex: { type: 'integer', description: '对该索引块整体加下划线' },
    },
  },
  execute: (args: any) => {
    const doc = requireCurrent()
    if ('ok' in doc && doc.ok === false) return doc
    const dd = doc as { id: string; title: string; html: string }
    const hasOp = args?.align || args?.color || Number.isInteger(args?.boldIndex) || Number.isInteger(args?.underlineIndex)
    if (!hasOp) return err('缺少样式参数（align/color/levels/boldIndex/underlineIndex）')
    let next = dd.html

    if (typeof args.align === 'string') {
      next = next.replace(/<(h[1-6]|p|blockquote)\b([^>]*)>/g, (_s, tag: string, attrs: string) => {
        let base: string
        if (attrs.includes('style=') && /style\s*=\s*"/.test(attrs)) {
          base = attrs.replace(/(style\s*=\s*")([^"]*)(")/, (_x, pre: string, old: string, post: string) => `${pre}${old.replace(/text-align:[^;]*/g, '').trim()}text-align: ${args.align}${post}`)
        } else {
          base = `${attrs} style="text-align: ${args.align}"`
        }
        return `<${tag}${base}>`
      })
    }

    if (typeof args.color === 'string' && /^[#a-zA-Z0-9(),. ]+$/.test(args.color)) {
      const levels: number[] = Array.isArray(args.levels) && args.levels.length > 0
        ? args.levels.map((n: any) => Math.floor(Number(n))).filter((n: number) => n >= 1 && n <= 6)
        : [1, 2, 3, 4, 5, 6]
      for (const lv of levels) {
        const re = new RegExp(`(<h${lv}\\b[^>]*?)(>)`, 'g')
        next = next.replace(re, (_s, pre: string) => `${pre} color: ${args.color}>`)
      }
    }

    if (Number.isInteger(args.boldIndex)) {
      const blocks = parseBlocks(next)
      const idx = Math.floor(Number(args.boldIndex))
      if (idx >= 0 && idx < blocks.length) {
        const inner = innerOf(blocks[idx].html)
        const wrapped = `<${blocks[idx].tag}${styleAttrOf(blocks[idx].html)}><strong>${inner}</strong></${blocks[idx].tag}>`
        const ph = '__WE_BOLD__'
        next = next.replace(blocks[idx].html, ph).replace(ph, wrapped)
      }
    }

    if (Number.isInteger(args.underlineIndex)) {
      const blocks = parseBlocks(next)
      const idx = Math.floor(Number(args.underlineIndex))
      if (idx >= 0 && idx < blocks.length) {
        const inner = innerOf(blocks[idx].html)
        const wrapped = `<${blocks[idx].tag}${styleAttrOf(blocks[idx].html)}><u>${inner}</u></${blocks[idx].tag}>`
        const ph = '__WE_ULINE__'
        next = next.replace(blocks[idx].html, ph).replace(ph, wrapped)
      }
    }

    const parts: string[] = []
    if (args.align) parts.push(`对齐=${args.align}`)
    if (args.color) parts.push(`标题颜色=${args.color}${args.levels ? `（H${(args.levels as number[]).join(',H')}）` : ''}`)
    if (Number.isInteger(args.boldIndex)) parts.push(`块 ${args.boldIndex} 加粗`)
    if (Number.isInteger(args.underlineIndex)) parts.push(`块 ${args.underlineIndex} 下划线`)
    return commit(next, `已应用样式: ${parts.join('；')}`)
  },
}

function requireCurrent(): { id: string; title: string; html: string } | ToolResult<never> {
  if (!currentDoc) return err('当前无打开的文档（请先在编辑器中打开一个文档）')
  return currentDoc
}

function innerOf(blockHtml: string): string {
  return blockHtml.replace(/^<[a-z0-9]+[^>]*>/i, '').replace(/<\/[a-z0-9]+>$/i, '')
}

function styleAttrOf(blockHtml: string): string {
  const m = blockHtml.match(/^<[a-z0-9]+([^>]*)>/i)
  const attrs = m ? m[1] : ''
  const style = attrs.match(/style="([^"]*)"/)
  return style ? ` style="${style[1]}"` : ''
}

export const DOC_TOOLS: ToolDef[] = [
  getOutlineTool,
  getBlockTool,
  replaceBlockTool,
  insertBlockTool,
  deleteBlockTool,
  applyStyleTool,
]

export function getToolByName(name: string): ToolDef | undefined {
  return DOC_TOOLS.find((t) => t.name === name)
}
