// HTML 块解析：把文档 HTML 拆成顶层块（带索引），支持文本提取与块文本生成。
// AI 工具与 docx 导出共用的中间层。文档 HTML 由 TipTap/mammoth 产生（结构规整）。

export interface DocBlock {
  /** 全文顺序索引（从 0 开始） */
  index: number
  /** 块标签：h1-h6/p/blockquote/pre/ul/ol/table 等 */
  tag: string
  /** 纯文本内容 */
  text: string
  /** 原始 HTML（含标签） */
  html: string
  /** 行内 style 属性 */
  style: string
}

const BLOCK_RE = /<(h[1-6]|p|blockquote|pre|ul|ol|table)\b([^>]*)>([\s\S]*?)<\/\1>/

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 从块 HTML 提取纯文本 */
export function stripTags(html: string): string {
  return decodeEntities(
    html.replace(/<(br|\/p|\/h[1-6]|\/li|\/blockquote|\/pre)>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
  )
}

/** 解析文档为顶层块列表 */
export function parseBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = []
  const re = new RegExp(BLOCK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const styleM = m[2].match(/style="([^"]*)"/)
    blocks.push({
      index: blocks.length,
      tag: m[1],
      html: m[0],
      text: stripTags(m[3]),
      style: styleM ? styleM[1] : '',
    })
  }
  return blocks
}

/** 用纯文本生成块 HTML（ul/ol 每行一项；多行文本块内换行 → br） */
export function textToBlock(tag: BlockTag, text: string): string {
  const encoded = escapeHtml(text).replace(/\n/g, '<br>')
  if (tag === 'ul' || tag === 'ol') {
    const items = text.split(/\n/).map((t) => t.trim()).filter(Boolean).map((t) => `<li>${escapeHtml(t)}</li>`)
    return `<${tag}>${items.join('')}</${tag}>`
  }
  return `<${tag}>${encoded}</${tag}>`
}

export type BlockTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'blockquote' | 'ul' | 'ol' | 'table' | 'pre'
