// 导出：HTML 块模型 → docx（docx 库）；PDF 经隐藏窗口 printToPDF

import * as path from 'path'
import * as fs from 'fs'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, ImageRun, ShadingType,
} from 'docx'
import { parseBlocks, type DocBlock } from './html-blocks'

const ALIGN_MAP: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  'text-align: center': AlignmentType.CENTER,
  'text-align: right': AlignmentType.RIGHT,
  'text-align: justify': AlignmentType.JUSTIFIED,
}

function alignOf(style: string): typeof AlignmentType.CENTER | undefined {
  const m = style.match(/text-align:\s*(\w+)/)
  if (!m) return undefined
  if (m[1] === 'center') return AlignmentType.CENTER
  if (m[1] === 'right') return AlignmentType.RIGHT
  if (m[1] === 'justify') return AlignmentType.JUSTIFIED
  return undefined
}

const HEADING_MAP: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6,
}

interface InlineToken { text: string; bold?: boolean; italic?: boolean; underline?: boolean }

/** 简易解析行内 HTML（strong/em/u/code），支持嵌套一轮 */
function parseInline(html: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const re = /<(strong|b|em|i|u|code)>([\s\S]*?)<\/\1>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      const inner = stripInner(m[2])
      const kind = m[1].toLowerCase()
      const isB = kind === 'strong' || kind === 'b'
      const isI = kind === 'em' || kind === 'i'
      tokens.push({ text: inner, bold: isB, italic: isI, underline: kind === 'u' })
    } else if (m[3]) {
      tokens.push({ text: decode(m[3]) })
    }
  }
  return tokens.length > 0 ? tokens : [{ text: decode(stripInner(html)) }]
}

function stripInner(s: string): string {
  return decode(s.replace(/<[^>]+>/g, ''))
}

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  return Buffer.from(m[2], 'base64')
}

function blockToDocx(block: DocBlock): (Paragraph | Table)[] {
  const { tag, html, style } = block
  const align = alignOf(style)

  if (/^h[1-6]$/.test(tag)) {
    const heading = HEADING_MAP[tag]
    return [new Paragraph({
      heading,
      alignment: align,
      children: parseInline(html.replace(/^<h\d[^>]*>|<\/h\d>$/g, '')).map((t) => new TextRun({
        text: t.text, bold: true, italics: t.italic, underline: t.underline ? {} : undefined,
      })),
    })]
  }

  if (tag === 'p' || tag === 'blockquote' || tag === 'div') {
    const inner = html.replace(/^<(p|blockquote|div)[^>]*>|<\/(p|blockquote|div)>$/g, '')
    // 图片段落
    const runs: (TextRun | ImageRun)[] = []
    const parts = inner.split(/(<img[^>]*>)/g)
    for (const part of parts) {
      if (!part) continue
      const img = part.match(/<img[^>]*src\s*=\s*"([^"]*)"[^>]*>/)
      if (img) {
        const buf = dataUrlToBuffer(img[1])
        if (buf) {
          runs.push(new ImageRun({ data: buf, transformation: { width: 400, height: 300 } }))
          continue
        }
      }
      for (const t of parseInline(part)) {
        runs.push(new TextRun({ text: t.text, bold: t.bold, italics: t.italic, underline: t.underline ? {} : undefined }))
      }
    }
    return [new Paragraph({
      alignment: align,
      indent: tag === 'blockquote' ? { left: 360 } : undefined,
      children: runs,
    })]
  }

  if (tag === 'ul' || tag === 'ol') {
    const lis = html.match(/<li[^>]*>([\s\S]*?)<\/li>/g) ?? []
    let idx = 0
    return lis.map((li) => {
      idx++
      const { value, level } = { value: idx, level: 0 }
      const inner = li.replace(/^<li[^>]*>|<\/li>$/g, '')
      return new Paragraph({
        alignment: align,
        numbering: tag === 'ol'
          ? { reference: 'we-ordered', level }
          : undefined,
        bullet: tag === 'ul' ? { level } : undefined,
        children: parseInline(inner).map((t) => new TextRun({
          text: t.text, bold: t.bold, italics: t.italic, underline: t.underline ? {} : undefined,
        })),
      })
    })
  }

  if (tag === 'table') {
    const rowsHtml = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) ?? []
    const headerRow = /<tr[^>]*>\s*(?:<th|\s*<th)/.test(html)
    const rows = rowsHtml.map((rowHtml, ri) => {
      const cellsHtml = rowHtml.match(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/g) ?? []
      return new TableRow({
        tableHeader: headerRow && ri === 0,
        children: cellsHtml.map((cellHtml) => {
          const inner = cellHtml.replace(/^<(td|th)[^>]*>|<\/(td|th)>$/g, '')
          const text = decode(inner.replace(/<[^>]+>/g, '')).trim()
          return new TableCell({
            shading: headerRow && ri === 0
              ? { type: ShadingType.CLEAR, fill: 'EFEFEF' }
              : undefined,
            children: [new Paragraph({ children: [new TextRun({ text })] })],
          })
        }),
      })
    })
    if (rows.length > 0) return [new Table({ rows })]
    return [new Paragraph({ children: [] })]
  }

  // pre / 其他 → 等宽段落
  const text = decode(html.replace(/<[^>]+>/g, ''))
  return [new Paragraph({
    children: [new TextRun({ text, font: { name: 'Consolas' } })],
  })]
}

/** HTML → docx Buffer */
export async function exportDocxBuffer(title: string, html: string): Promise<Buffer> {
  const blocks = parseBlocks(html)
  const children: (Paragraph | Table)[] = []
  for (const block of blocks) {
    children.push(...blockToDocx(block))
  }
  const doc = new Document({
    title,
    numbering: {
      config: [{
        reference: 'we-ordered',
        levels: [{
          level: 0, format: 'decimal' as never, text: '%1.', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{ children }],
  })
  return Packer.toBuffer(doc)
}

/** 导出 docx：弹保存框 → 写文件。返回 {ok,path|error}，由外层统一翻译错误文案 */
export async function saveDocxFile(title: string, html: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const { dialog } = require('electron')
  const res = await dialog.showSaveDialog({
    title: '导出 Word 文档',
    defaultPath: `${title || 'document'}.docx`,
    filters: [{ name: 'Word 文档', extensions: ['docx'] }],
  })
  if (res.canceled || !res.filePath) return { ok: false }
  try {
    const buf = await exportDocxBuffer(title, html)
    fs.writeFileSync(res.filePath, buf)
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * PDF 导出：把文档包装为打印 HTML，用隐藏 BrowserWindow 渲染后 printToPDF。
 */
export async function savePdfFile(title: string, html: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const { dialog, BrowserWindow } = require('electron')
  const res = await dialog.showSaveDialog({
    title: '导出 PDF 文件',
    defaultPath: `${title || 'document'}.pdf`,
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  })
  if (res.canceled || !res.filePath) return { ok: false }
  let win: any = null
  try {
    const printHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 12pt; line-height: 1.6; color: #000; margin: 2cm; }
          h1, h2, h3, h4, h5, h6 { line-height: 1.3; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #999; padding: 4px 8px; }
          th { background: #f0f0f0; }
          img { max-width: 100%; }
          blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 12px; color: #444; }
        </style>
      </head>
      <body>${html}</body>
      </html>`
    win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, offscreen: true },
    })
    const tmpFile = path.join(require('os').tmpdir(), `we-print-${Date.now()}.html`)
    fs.writeFileSync(tmpFile, printHtml, 'utf-8')
    await win.loadFile(tmpFile)
    const pdfBuf: Buffer = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    fs.writeFileSync(res.filePath, pdfBuf)
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (win) win.destroy()
  }
}
