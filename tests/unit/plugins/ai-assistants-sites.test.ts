import { describe, it, expect } from 'vitest'
import {
  AI_WEB_SITES,
  MAX_CUSTOM_SITES,
  createCustomSiteId,
  customSiteColor,
  getSiteById,
  isLayoutMode,
  createTabId,
  normalizeCustomSites,
  normalizeLayout,
  parseCustomSiteUrl,
  resolveEnabledSites,
  siteUrlKey,
  hostnameOf,
  WEBVIEW_USER_AGENT,
} from '../../../../plugins/ai-assistants/src/shared/sites'
import { activate } from '../../../../plugins/ai-assistants/src/main/index'
import { createMockContext } from '../../helpers/mock-plugin-context'

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

describe('ai-assistants / 自定义网页网址', () => {
  it('缺省协议补 https，并规范化主机名', () => {
    const result = parseCustomSiteUrl('Example.com/chat?a=1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url).toBe('https://example.com/chat?a=1')
      expect(result.hostname).toBe('example.com')
    }
  })

  it('空值 / 非 https / 非法网址给出对应原因', () => {
    expect(parseCustomSiteUrl('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(parseCustomSiteUrl('http://example.com')).toEqual({ ok: false, reason: 'protocol' })
    expect(parseCustomSiteUrl('https://')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('siteUrlKey 忽略末尾斜杠与主机名大小写', () => {
    expect(siteUrlKey('https://Example.com/chat/')).toBe(siteUrlKey('https://example.com/chat'))
    expect(siteUrlKey('https://example.com/a')).not.toBe(siteUrlKey('https://example.com/b'))
  })
})

describe('ai-assistants / normalizeCustomSites', () => {
  const valid = { id: 'custom-a', name: '示例', url: 'https://example.com/', color: '#123456' }

  it('过滤非 custom- 前缀、重复 id、非法 URL 与重复网址', () => {
    const out = normalizeCustomSites([
      valid,
      { ...valid, id: 'doubao' },
      { ...valid },
      { ...valid, id: 'custom-b', url: 'http://example.com/' },
      { ...valid, id: 'custom-c', url: 'https://example.com' },
      'junk',
      null,
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'custom-a', name: '示例', custom: true })
  })

  it('缺省名称回退域名，非法颜色回退派生色', () => {
    const [site] = normalizeCustomSites([{ id: 'custom-x', url: 'https://a.example.com/' }])
    expect(site.name).toBe('a.example.com')
    expect(site.color).toBe(customSiteColor('a.example.com'))
  })

  it('数量上限', () => {
    const many = Array.from({ length: MAX_CUSTOM_SITES + 5 }, (_, i) => ({
      id: `custom-${i}`,
      url: `https://site${i}.example.com/`,
    }))
    expect(normalizeCustomSites(many)).toHaveLength(MAX_CUSTOM_SITES)
  })

  it('createCustomSiteId 唯一且带 custom- 前缀', () => {
    const a = createCustomSiteId()
    const b = createCustomSiteId()
    expect(a.startsWith('custom-')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('ai-assistants / 自定义网页参与布局', () => {
  const custom = { id: 'custom-a', name: 'My Chat', url: 'https://chat.example.com/', color: '#123456' }

  it('getSiteById / resolveEnabledSites 认得自定义站点', () => {
    expect(getSiteById('custom-a', [custom])?.name).toBe('My Chat')
    expect(resolveEnabledSites(['custom-a', 'bad'], [custom]).map(s => s.id)).toEqual(['custom-a'])
  })

  it('customSites 脏数据被归一化，pane/tab/enabled 可引用自定义站点', () => {
    const layout = normalizeLayout({
      mode: 'tabs',
      customSites: [custom, { id: 'bad', url: 'https://bad.example.com/' }],
      panes: ['custom-a', 'doubao'],
      tabs: [{ id: 't1', siteId: 'custom-a' }],
      activeTabId: 't1',
      enabledSites: ['custom-a', 'doubao'],
    })
    expect(layout.customSites).toHaveLength(1)
    expect(layout.panes).toEqual(['custom-a', 'doubao'])
    expect(layout.tabs).toEqual([{ id: 't1', siteId: 'custom-a' }])
    expect(layout.enabledSites).toEqual(['custom-a', 'doubao'])
  })

  it('enabledSites 为空时回退为内置 + 自定义全量站点', () => {
    const layout = normalizeLayout({ mode: 'single', customSites: [custom] })
    expect(layout.enabledSites).toContain('custom-a')
    expect(layout.enabledSites).toHaveLength(AI_WEB_SITES.length + 1)
  })
})

describe('ai-assistants / 主进程域名同步', () => {
  it('激活与保存布局时把自定义网页域名交给宿主', async () => {
    const { ctx, ipc, webview } = createMockContext('ai-assistants')
    await activate(ctx)

    const handler = ipc.handlers.get('layout-set')
    expect(handler).toBeTypeOf('function')
    await handler?.({
      mode: 'single',
      panes: ['custom-a', null],
      customSites: [
        { id: 'custom-a', name: 'Chat', url: 'https://chat.example.com/', color: '#123456' },
        { id: 'custom-b', name: 'Other', url: 'https://other.example.org/path', color: '#654321' },
        { id: 'custom-c', name: 'Bad', url: 'http://insecure.example.net/', color: '#000000' },
      ],
    })

    expect(webview.allowOrigins).toHaveBeenLastCalledWith([
      'chat.example.com',
      'other.example.org',
    ])
  })
})
