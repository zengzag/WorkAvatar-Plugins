import { describe, it, expect, vi } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'
import type { PluginMainModule } from '@workavatar/plugin-sdk'
import {
  setCurrentDoc, getToolByName, getCurrentDoc,
} from '../../../word-editor/src/shared/doc-tools'
import { parseBlocks } from '../../../word-editor/src/main/html-blocks'

/**
 * word-editor 插件单测：
 * - 激活注册行为（agent 工具清单）
 * - 文档 CRUD IPC
 * - doc-tools 工具协议纯函数（大纲/块读写/样式）
 */

async function setup(): Promise<{ mod: PluginMainModule; mock: ReturnType<typeof createMockContext> }> {
  vi.resetModules()
  const mod = await import('../../../word-editor/src/main/index') as PluginMainModule
  const mock = createMockContext('test-word-editor')
  for (const m of mod.migrations ?? []) {
    m.run({ storage: mock.ctx.storage, logger: mock.ctx.services.logger })
  }
  mod.activate(mock.ctx)
  return { mod, mock }
}

function handler(mock: ReturnType<typeof createMockContext>, channel: string): (payload?: unknown, signal?: AbortSignal) => Promise<unknown> | unknown {
  return mock.ipc.handlers.get(channel)! as (payload?: unknown, signal?: AbortSignal) => Promise<unknown> | unknown
}

describe('激活注册行为', () => {
  it('注册 6 个 agent 工具（doc_*）', async () => {
    const { mock } = await setup()
    const ids = mock.contributions.agentTools.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining([
      'doc_get_outline', 'doc_get_block', 'doc_replace_block',
      'doc_insert_block', 'doc_delete_block', 'doc_apply_style'
    ]))
    expect(ids.length).toBe(6)
  })

  it('manifest.ipc 白名单内全部通道都有 handler', async () => {
    const { mock } = await setup()
    const channels = [
      'doc-list', 'doc-create', 'doc-open', 'doc-delete', 'doc-rename', 'doc-save', 'doc-get',
      'doc-import-file', 'export-docx', 'export-pdf',
      'snapshot-list', 'snapshot-create', 'snapshot-restore', 'snapshot-delete',
      'providers-list', 'settings-get', 'settings-set',
      'chat-send', 'chat-cancel', 'chat-history', 'chats-list', 'chat-delete', 'inline-edit',
    ]
    const registered = new Set(mock.ipc.handlers.keys())
    for (const c of channels) expect(registered.has(c)).toBe(true)
  })
})

describe('文档 CRUD IPC', () => {
  it('doc-create 创建并设为当前文档；doc-list 返回清单', async () => {
    const { mock } = await setup()
    const res = await handler(mock, 'doc-create')({ title: '测试文档' }) as { doc: { id: string; title: string } }
    expect(res.doc.title).toBe('测试文档')
    const list = await handler(mock, 'doc-list')() as Array<{ title: string }>
    expect(list.some((d) => d.title === '测试文档')).toBe(true)
  })

  it('doc-open / doc-rename / doc-delete 全链路', async () => {
    const { mock } = await setup()
    const { doc } = await handler(mock, 'doc-create')({ title: 'A' }) as any
    const openRes = await handler(mock, 'doc-open')({ id: doc.id }) as any
    expect(openRes.doc.title).toBe('A')
    await handler(mock, 'doc-rename')({ id: doc.id, title: ' B ' })
    expect((await handler(mock, 'doc-get')({ id: doc.id }) as any).doc.title).toBe('B')
    await handler(mock, 'doc-delete')({ id: doc.id })
    expect((await handler(mock, 'doc-open')({ id: doc.id }) as any).error).toBeTruthy()
  })

  it('doc-save 保存正文后 doc-get 读回一致', async () => {
    const { mock } = await setup()
    const { doc } = await handler(mock, 'doc-create')({}) as any
    await handler(mock, 'doc-save')({ id: doc.id, html: '<p>hello</p>' })
    const got = await handler(mock, 'doc-get')({ id: doc.id }) as any
    expect(got.doc.html).toBe('<p>hello</p>')
  })
})

describe('doc 工具协议（纯函数）', () => {
  const HTML = '<h1>标题</h1><p>第一段</p><ul><li>条目A</li><li>条目B</li></ul>'

  function run(name: string, args: Record<string, unknown>): { ok: boolean; data?: any; message?: string; error?: string } {
    return getToolByName(name)!.execute(args) as never
  }

  it('doc_get_outline 返回块清单', () => {
    setCurrentDoc({ id: 'd1', title: 'T', html: HTML })
    const r = run('doc_get_outline', {})
    expect(r.ok).toBe(true)
    expect(r.data!.blocks.map((b: any) => b.tag)).toEqual(['h1', 'p', 'ul'])
  })

  it('doc_replace_block 按索引替换', () => {
    setCurrentDoc({ id: 'd1', title: 'T', html: HTML })
    const r = run('doc_replace_block', { index: 1, text: '修改后的第一段' })
    expect(r.ok).toBe(true)
    expect(getCurrentDoc()!.html).toContain('修改后的第一段')
  })

  it('doc_replace_block matchText 全文替换', () => {
    setCurrentDoc({ id: 'd1', title: 'T', html: HTML })
    const r = run('doc_replace_block', { matchText: '条目A', replaceText: '新条目' })
    expect(r.ok).toBe(true)
    expect(getCurrentDoc()!.html).toContain('新条目')
  })

  it('doc_insert_block / doc_delete_block', () => {
    setCurrentDoc({ id: 'd1', title: 'T', html: HTML })
    run('doc_insert_block', { afterIndex: -1, tag: 'p', text: '开头加一段' })
    expect(getCurrentDoc()!.html.startsWith('<p>开头加一段</p>')).toBe(true)
    const blocks = parseBlocks(getCurrentDoc()!.html)
    run('doc_delete_block', { index: 0 })
    expect(getCurrentDoc()!.html).not.toContain('开头加一段</p><h1'.slice(0, 20))
    void blocks
  })

  it('doc_apply_style 对齐/颜色', () => {
    setCurrentDoc({ id: 'd1', title: 'T', html: '<p>正文</p><h1>标题</h1>' })
    const r = run('doc_apply_style', { align: 'center', color: '#2b579a', levels: [1] })
    expect(r.ok).toBe(true)
    const html = getCurrentDoc()!.html
    expect(html).toContain('text-align: center')
    expect(html).toContain('color: #2b579a')
  })

  it('无当前文档时工具返回错误', () => {
    setCurrentDoc(null)
    const r = run('doc_get_outline', {})
    expect(r.ok).toBe(false)
  })
})

describe('parseBlocks 解析顶层块', () => {
  it('tag/text 提取', () => {
    const blocks = parseBlocks('<h1>标题</h1><p>第一段</p><ul><li>条目A</li><li>条目B</li></ul>')
    expect(blocks.map((b) => b.tag)).toEqual(['h1', 'p', 'ul'])
    expect(blocks[1].text).toBe('第一段')
    expect(blocks[2].text).toContain('条目A')
  })
})
