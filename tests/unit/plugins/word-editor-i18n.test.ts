import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_DICT, UI_REGION_SELECTOR, UI_EXCLUDE_SELECTOR, translateText, translatePhrase } from '../../../word-editor/src/renderer/wordcanvas-i18n'

/**
 * word-editor 本地化单测：
 * 1. 插件 locale（zh-CN / en-US）键集合一致，且与源码实际使用的 key 严格对齐
 *    （防止再次出现「文案缺失 → 界面显示 key」的回归）
 * 2. wordcanvas 编辑器 UI 词典与翻译函数行为
 * 3. 编辑器 UI 白名单不得包含用户内容区域（避免误译正文/大纲/批注）
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(DIR, '../../../word-editor')

function readLocale(lng: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'locale', `${lng}.json`), 'utf-8'))
}

/** 宿主侧使用的文案 key（hostT / t 调用），模板形式（`page.aiQuick.${k}`）收集为前缀 */
function collectUsedKeys(): { exact: Set<string>; prefixes: Set<string> } {
  const exact = new Set<string>()
  const prefixes = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      const code = fs.readFileSync(full, 'utf-8')
      for (const m of code.matchAll(/(?<![\w.$])(?:hostT|t)\(\s*'([^']+)'/g)) exact.add(m[1])
      for (const m of code.matchAll(/(?<![\w.$])hostT\(\s*`([^`$]+)\$\{/g)) prefixes.add(m[1])
    }
  }
  walk(path.join(PLUGIN_DIR, 'src'))
  return { exact, prefixes }
}

/** 仅由宿主读取、不在插件源码中出现的 key（manifest.nav.label 由宿主解析） */
const HOST_ONLY_KEYS = new Set(['navLabel'])

describe('插件文案资源', () => {
  it('zh-CN 与 en-US 键集合完全一致', () => {
    const zh = Object.keys(readLocale('zh-CN')).sort()
    const en = Object.keys(readLocale('en-US')).sort()
    expect(en).toEqual(zh)
  })

  it('源码使用的所有 key 都已定义（且无未使用的死 key）', () => {
    const { exact, prefixes } = collectUsedKeys()
    const locale = readLocale('zh-CN')
    const defined = Object.keys(locale)

    const missing = [...exact].filter((k) => !(k in locale))
    expect(missing).toEqual([])

    const prefixList = [...prefixes]
    const unused = defined.filter((k) => {
      if (HOST_ONLY_KEYS.has(k)) return false
      if (exact.has(k)) return false
      return !prefixList.some((p) => k.startsWith(p))
    })
    expect(unused).toEqual([])
  })

  it('所有文案值非空且无首尾空白', () => {
    for (const lng of ['zh-CN', 'en-US']) {
      const locale = readLocale(lng)
      for (const [key, value] of Object.entries(locale)) {
        expect(`${lng}:${key}=${value}`).toBe(`${lng}:${key}=${value.trim()}`)
        expect(value.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('wordcanvas 编辑器 UI 词典', () => {
  it('词典键值非空且无首尾空白', () => {
    const entries = Object.entries(UI_DICT)
    expect(entries.length).toBeGreaterThan(100)
    for (const [key, value] of entries) {
      expect(key).toBe(key.trim())
      expect(key.length).toBeGreaterThan(0)
      expect(value.length).toBeGreaterThan(0)
      expect(value).toBe(value.trim())
    }
  })

  it('英文原文翻译为中文', () => {
    expect(translateText('Paste (Ctrl+V)', 'zh-CN')).toBe('粘贴 (Ctrl+V)')
    expect(translateText('Home', 'zh-CN')).toBe('开始')
    expect(translateText('Borders & shading', 'zh-CN')).toBe('边框和底纹')
    // 右键上下文工具条（挂在 document.body 上）的短标签
    expect(translateText('Insert', 'zh-CN')).toBe('插入')
    expect(translateText('Equation', 'zh-CN')).toBe('公式')
    expect(translateText('Outline (colour, width, dash)', 'zh-CN')).toBe('轮廓（颜色、宽度、线型）')
    expect(translateText('Align center', 'zh-CN')).toBe('居中')
    expect(translateText('Bookmarks', 'zh-CN')).toBe('书签')
    // 页面布局对话框（.cw-pl-modal）标签
    expect(translateText('Restart', 'zh-CN')).toBe('重新开始')
    expect(translateText('Each page', 'zh-CN')).toBe('每页')
    expect(translateText('inches', 'zh-CN')).toBe('英寸')
    expect(translateText('Unzipping', 'zh-CN')).toBe('解压中')
  })

  it('同一短语按区域上下文取不同译法', () => {
    // 样式库：Normal → 正文；页边距预设（.cw-pl-modal 局部词典）→ 普通
    expect(translateText('Normal', 'zh-CN')).toBe('正文')
    expect(translatePhrase('Normal', 'zh-CN', { Normal: '普通' })).toBe('普通')
    // 切回英文时两种译法都能还原
    expect(translateText('正文', 'en-US')).toBe('Normal')
    expect(translateText('普通', 'en-US')).toBe('Normal')
  })

  it('保留原文前后空白', () => {
    expect(translatePhrase('  Home  ', 'zh-CN')).toBe('  开始  ')
  })

  it('未收录文案保持原样（返回 null）', () => {
    expect(translateText('Some Unmapped Label', 'zh-CN')).toBeNull()
    expect(translateText('', 'zh-CN')).toBeNull()
  })

  it('状态栏动态文案按规则本地化', () => {
    expect(translateText('Page 3 of 12', 'zh-CN')).toBe('第 3 页，共 12 页')
    expect(translateText('4113 words · 25427 characters', 'zh-CN')).toBe('4113 个单词 · 25427 个字符')
    // 未命中规则的动态文案不处理
    expect(translateText('Page 3', 'zh-CN')).toBeNull()
  })

  it('en-US 时按反向词典还原英文', () => {
    expect(translateText('粘贴 (Ctrl+V)', 'en-US')).toBe('Paste (Ctrl+V)')
    expect(translateText('开始', 'en-US')).toBe('Home')
    // 英文原文在 en-US 下不做处理
    expect(translateText('Paste (Ctrl+V)', 'en-US')).toBeNull()
  })

  it('UI 白名单只覆盖编辑器控件与对话框，用户内容区域列入排除表', () => {
    for (const region of ['.cw-toolbar', '.cw-statusbar', '.cw-pop', '.cw-ctxbar', '.cw-pl-modal', '.cw-tbl-modal', '.cw-font-modal']) {
      expect(UI_REGION_SELECTOR).toContain(region)
    }
    // 用户内容 / 预览不得被本地化（防误译正文、标题、批注、控件内容）
    for (const excluded of ['.cw-app', '.cw-outline-list', '.cw-review', '.cw-sdt-preview', '.cw-fc-prev']) {
      expect(UI_EXCLUDE_SELECTOR).toContain(excluded)
      expect(UI_REGION_SELECTOR).not.toContain(excluded)
    }
  })
})
