import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyDocOp } from '../../../word-editor/src/renderer/doc-ops'
import type { DocQueryModule } from '../../../word-editor/src/renderer/wordcanvas-loader'

/**
 * AI 文档操作执行器单测。
 *
 * 变更计算走 wordcanvas 自带的 headless 引擎（vendor query.js），这里直接从磁盘加载
 * 真实引擎模块，因此断言的是编辑器的真实文档语义（revision、样式烘焙、结构校验等）。
 */

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../word-editor/vendor/wordcanvas')

let mod: DocQueryModule

beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(VENDOR, 'query.js')).href)) as DocQueryModule
})

const RUN_STYLE = { fontFamily: 'Georgia, serif', fontSizePx: 16, bold: false, color: '#202124' }
const PARA_STYLE = { align: 'left', lineHeight: 1.5, spaceAfterPx: 12 }

function makeDoc() {
  return {
    section: { pageWidthPx: 794, pageHeightPx: 1123, marginPx: { top: 96, right: 120, bottom: 96, left: 120 } },
    blocks: [
      { kind: 'paragraph', id: 'p1', revision: 1, runs: [{ text: '季度总结报告', style: { ...RUN_STYLE, bold: true } }], style: { ...PARA_STYLE } },
      { kind: 'paragraph', id: 'p2', revision: 1, runs: [{ text: '本季度完成了三件事：', style: { ...RUN_STYLE } }], style: { ...PARA_STYLE } },
      { kind: 'paragraph', id: 'p3', revision: 1, runs: [{ text: '收入增长百分之十。', style: { ...RUN_STYLE } }], style: { ...PARA_STYLE } },
    ],
  }
}

function run(doc: unknown, op: string, args: Record<string, unknown> = {}) {
  return applyDocOp(mod, JSON.stringify(doc), op, args)
}

function parse(data?: string) {
  return JSON.parse(data ?? '{}') as { blocks: Array<{ id: string; runs?: Array<{ text: string; style?: Record<string, unknown> }>; style?: Record<string, unknown> }> }
}

describe('doc_outline', () => {
  it('列出顶层块、字数与可用样式名', () => {
    const res = run(makeDoc(), 'doc_outline')
    expect(res.error).toBeUndefined()
    expect(res.output).toContain('[p1] 段落')
    expect(res.output).toContain('季度总结报告')
    expect(res.output).toContain('顶层块 3 个')
    expect(res.output).toContain('Heading 1')
  })

  it('空文档给出可操作提示', () => {
    const res = run({ section: {}, blocks: [] }, 'doc_outline')
    expect(res.output).toContain('文档为空')
  })
})

describe('doc_read', () => {
  it('默认返回全部块（带序号与块 id）', () => {
    const res = run(makeDoc(), 'doc_read')
    expect(res.output).toContain('0. [p1] 季度总结报告')
    expect(res.output).toContain('2. [p3] 收入增长百分之十。')
  })

  it('支持按范围与按块 id 读取', () => {
    expect(run(makeDoc(), 'doc_read', { startIndex: 1, endIndex: 1 }).output).toContain('1. [p2]')
    const byId = run(makeDoc(), 'doc_read', { blockIds: ['p3'] })
    expect(byId.output).toContain('[p3]')
    expect(byId.output).not.toContain('[p1]')
  })
})

describe('doc_find', () => {
  it('返回匹配块与偏移', () => {
    const res = run(makeDoc(), 'doc_find', { query: '季度' })
    expect(res.output).toContain('[p1]')
    expect(res.output).toContain('[p2]')
  })

  it('未命中时明确说明', () => {
    expect(run(makeDoc(), 'doc_find', { query: '不存在的内容' }).output).toContain('未找到')
  })
})

describe('doc_set_paragraph_text', () => {
  it('整段替换并保留原字符样式', () => {
    const res = run(makeDoc(), 'doc_set_paragraph_text', { blockId: 'p2', text: '本季度完成三件重点工作：' })
    expect(res.error).toBeUndefined()
    const blocks = parse(res.data).blocks
    expect(blocks[1].runs?.[0].text).toBe('本季度完成三件重点工作：')
    expect(blocks[1].runs?.[0].style).toMatchObject(RUN_STYLE)
    expect(blocks[1].id).toBe('p2')
  })

  it('块 id 不存在时给出可操作错误', () => {
    const res = run(makeDoc(), 'doc_set_paragraph_text', { blockId: 'nope', text: 'x' })
    expect(res.error).toContain('未找到段落')
    expect(res.data).toBeUndefined()
  })
})

describe('doc_replace', () => {
  it('默认替换全部匹配并统计处数', () => {
    const doc = makeDoc()
    doc.blocks.push({ kind: 'paragraph', id: 'p4', revision: 1, runs: [{ text: '季度目标已达成。', style: { ...RUN_STYLE } }], style: { ...PARA_STYLE } })
    const res = run(doc, 'doc_replace', { search: '季度', replace: '本季' })
    expect(res.output).toContain('已替换 3 处')
    const blocks = parse(res.data).blocks
    expect(blocks[0].runs?.[0].text).toBe('本季总结报告')
  })

  it('all=false 只替换第一处', () => {
    const res = run(makeDoc(), 'doc_replace', { search: '季度', replace: '本季', all: false })
    expect(res.output).toContain('已替换 1 处')
    const blocks = parse(res.data).blocks
    expect(blocks[0].runs?.[0].text).toBe('本季总结报告')
    expect(blocks[1].runs?.[0].text).toBe('本季度完成了三件事：')
  })

  it('未命中时不改文档', () => {
    const res = run(makeDoc(), 'doc_replace', { search: '无此文本', replace: 'x' })
    expect(res.data).toBeUndefined()
    expect(res.output).toContain('未找到')
  })

  it('空替换串等价于删除', () => {
    const res = run(makeDoc(), 'doc_replace', { search: '报告', replace: '' })
    expect(parse(res.data).blocks[0].runs?.[0].text).toBe('季度总结')
  })
})

describe('doc_insert_paragraph', () => {
  it('在参照块之后插入并沿用段落样式', () => {
    const res = run(makeDoc(), 'doc_insert_paragraph', { text: '一、业务进展', referenceBlockId: 'p1' })
    const blocks = parse(res.data).blocks
    expect(blocks.length).toBe(4)
    expect(blocks[1].runs?.[0].text).toBe('一、业务进展')
    expect(blocks[1].style).toMatchObject({ align: 'left' })
  })

  it('不指定参照块时追加到文末', () => {
    const res = run(makeDoc(), 'doc_insert_paragraph', { text: '附：数据来源' })
    const blocks = parse(res.data).blocks
    expect(blocks[3].runs?.[0].text).toBe('附：数据来源')
  })

  it('空文档也能写入首个段落', () => {
    const res = run({ section: {}, blocks: [] }, 'doc_insert_paragraph', { text: '第一段' })
    expect(res.error).toBeUndefined()
    const blocks = parse(res.data).blocks
    expect(blocks.length).toBe(1)
    expect(blocks[0].runs?.[0].text).toBe('第一段')
  })

  it('参照块不在顶层时报错', () => {
    const res = run(makeDoc(), 'doc_insert_paragraph', { text: 'x', referenceBlockId: 'missing' })
    expect(res.error).toContain('不在文档顶层')
  })
})

describe('doc_delete_blocks / doc_move_block', () => {
  it('删除顶层块并忽略不存在的 id', () => {
    const res = run(makeDoc(), 'doc_delete_blocks', { blockIds: ['p2', 'ghost'] })
    expect(res.output).toContain('已删除 1 个顶层块')
    expect(res.output).toContain('ghost')
    expect(parse(res.data).blocks.map((b) => b.id)).toEqual(['p1', 'p3'])
  })

  it('全部 id 都不存在时不产生改动', () => {
    const res = run(makeDoc(), 'doc_delete_blocks', { blockIds: ['ghost'] })
    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
  })

  it('调整块顺序', () => {
    const res = run(makeDoc(), 'doc_move_block', { blockId: 'p3', toIndex: 0 })
    expect(parse(res.data).blocks.map((b) => b.id)).toEqual(['p3', 'p1', 'p2'])
  })
})

describe('doc_apply_style', () => {
  it('文档无样式表时自动补齐并套用命名样式', () => {
    const res = run(makeDoc(), 'doc_apply_style', { blockId: 'p1', styleName: 'Heading 1' })
    expect(res.error).toBeUndefined()
    const doc = JSON.parse(res.data ?? '{}')
    expect(doc.stylesheet.styles.some((s: { name: string }) => s.name === 'Heading 1')).toBe(true)
    expect(doc.blocks[0].style.namedStyle).toBe('Heading1')
  })

  it('样式名不存在时给出可用样式列表', () => {
    const res = run(makeDoc(), 'doc_apply_style', { blockId: 'p1', styleName: 'H1' })
    expect(res.error).toContain('文档中没有样式')
    expect(res.error).toContain('Heading 1')
  })

  it('目标块不存在时报错', () => {
    const res = run(makeDoc(), 'doc_apply_style', { blockId: 'ghost', styleName: 'Heading 1' })
    expect(res.error).toContain('未找到段落')
  })
})

describe('参数与数据校验', () => {
  it('未知操作返回错误', () => {
    expect(run(makeDoc(), 'doc_unknown').error).toContain('未知文档操作')
  })

  it('非法文档数据返回错误', () => {
    expect(applyDocOp(mod, 'not-json', 'doc_outline', {}).error).toBeTruthy()
    expect(applyDocOp(mod, JSON.stringify({ section: {} }), 'doc_outline', {}).error).toBeTruthy()
  })
})
