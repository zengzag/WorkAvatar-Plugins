import { describe, it, expect } from 'vitest'
import {
  AI_WEB_SITES,
  getSiteById,
  isLayoutMode,
  createTabId,
  resolveEnabledSites,
  normalizeLayout,
  hostnameOf,
  WEBVIEW_USER_AGENT,
} from '../../../../plugins/ai-assistants/src/shared/sites'

describe('ai-assistants / sites 基础', () => {
  it('站点 id 唯一且非空，URL 均为 https', () => {
    const ids = AI_WEB_SITES.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of AI_WEB_SITES) {
      expect(s.id).toBeTruthy()
      expect(s.url).toMatch(/^https:\/\//)
    }
  })

  it('getSiteById 大小写敏感，未知/空 id 返回 undefined', () => {
    expect(getSiteById('doubao')?.name).toBe('豆包')
    expect(getSiteById('DOUBAO')).toBeUndefined()
    expect(getSiteById('')).toBeUndefined()
    expect(getSiteById(null)).toBeUndefined()
  })

  it('UA 为桌面 Chrome 形态（无 Electron 特征）', () => {
    expect(WEBVIEW_USER_AGENT).toContain('Chrome/')
    expect(WEBVIEW_USER_AGENT).not.toContain('Electron')
  })
})

describe('ai-assistants / isLayoutMode', () => {
  it('合法模式与非法值', () => {
    for (const m of ['single', 'split', 'tabs']) expect(isLayoutMode(m)).toBe(true)
    expect(isLayoutMode('grid')).toBe(false)
    expect(isLayoutMode(1)).toBe(false)
    expect(isLayoutMode(null)).toBe(false)
  })
})

describe('ai-assistants / createTabId', () => {
  it('包含站点前缀且不重复', () => {
    const a = createTabId('doubao')
    const b = createTabId('doubao')
    expect(a.startsWith('doubao-')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('ai-assistants / resolveEnabledSites', () => {
  it('保持传入顺序，未知 id 被过滤', () => {
    const out = resolveEnabledSites(['kimi', 'unknown-x', 'doubao'])
    expect(out.map(s => s.id)).toEqual(['kimi', 'doubao'])
  })

  it('空/全无效列表回退全量站点', () => {
    expect(resolveEnabledSites([])).toHaveLength(AI_WEB_SITES.length)
    expect(resolveEnabledSites(['bad1', 'bad2'])).toHaveLength(AI_WEB_SITES.length)
  })
})

describe('ai-assistants / normalizeLayout 脏数据防御', () => {
  it('非对象输入回退默认布局', () => {
    for (const bad of [null, undefined, 42, 'str', []]) {
      const layout = normalizeLayout(bad)
      expect(layout.mode).toBe('single')
      expect(layout.enabledSites.length).toBeGreaterThan(0)
    }
  })

  it('旧结构 { split: true } 兼容为 split 模式', () => {
    const layout = normalizeLayout({ split: true, panes: ['doubao', 'kimi'] })
    expect(layout.mode).toBe('split')
    expect(layout.panes).toEqual(['doubao', 'kimi'])
  })

  it('非法站点 id 的 pane 归为 null', () => {
    const layout = normalizeLayout({ mode: 'split', panes: ['bad-site', 'kimi'] })
    expect(layout.panes[0]).toBeNull()
    expect(layout.panes[1]).toBe('kimi')
  })

  it('tabs 过滤非法项；activeTabId 必须存在于 tabs，否则回落第一个', () => {
    const layout = normalizeLayout({
      mode: 'tabs',
      tabs: [
        { id: 't1', siteId: 'doubao' },
        { id: 't2', siteId: 'bad' },
        'junk',
        null,
        { id: 't3', siteId: 'kimi' },
      ],
      activeTabId: 'not-exist',
    })
    expect(layout.tabs).toEqual([
      { id: 't1', siteId: 'doubao' },
      { id: 't3', siteId: 'kimi' },
    ])
    expect(layout.activeTabId).toBe('t1')
  })

  it('activeTabId 有效时保留', () => {
    const layout = normalizeLayout({
      mode: 'tabs',
      tabs: [{ id: 't1', siteId: 'doubao' }, { id: 't2', siteId: 'kimi' }],
      activeTabId: 't2',
    })
    expect(layout.activeTabId).toBe('t2')
  })

  it('enabledSites 去重过滤；空列表回退默认', () => {
    const layout = normalizeLayout({ mode: 'single', enabledSites: ['kimi', 'kimi', 'bad', 'doubao'] })
    expect(layout.enabledSites).toEqual(['kimi', 'doubao'])
    const fallback = normalizeLayout({ mode: 'single', enabledSites: ['nope'] })
    expect(fallback.enabledSites.length).toBe(AI_WEB_SITES.length)
  })
})

describe('ai-assistants / hostnameOf', () => {
  it('提取主机名', () => {
    expect(hostnameOf('https://chat.deepseek.com/path?q=1')).toBe('chat.deepseek.com')
  })

  it('非法 URL 原样返回', () => {
    expect(hostnameOf('not a url')).toBe('not a url')
  })

  it('空值返回空串', () => {
    expect(hostnameOf('')).toBe('')
    expect(hostnameOf(null)).toBe('')
  })
})
