import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * word-editor 暗色主题覆盖 + Ribbon 宽度适配的回归测试。
 *
 * 为什么要测 CSS：编辑器外壳（Ribbon、各类功能展开页：段落/样式/符号/公式…）的样式由上游
 * wordcanvas 在运行时注入，颜色是硬编码浅色，插件只能在自己的样式表里逐项覆盖。这类缺陷
 * 静态读代码看不出来，上游升级后又容易漏（新增面板 / 改色都不会报错）。
 * 因此这里直接从 vendor 产物里抽取「声明了浅色底 / 深色文字 / 浅色描边」的规则，
 * 逐个 cw-* 类核对插件深色段是否覆盖；未覆盖的必须显式登记豁免理由。
 */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(DIR, '../../../word-editor')
const VENDOR_DIR = path.join(PLUGIN_DIR, 'vendor', 'wordcanvas')
const CSS_PATH = path.join(PLUGIN_DIR, 'src', 'renderer', 'styles.css')

/** 声明体形态：`属性: 值`（上游部分 CSS 里 `{` 后带换行缩进，故允许前导空白） */
const RULE_BODY_RE = /^\s*[a-z-]+\s*:/
/** 选择器里的 cw-* 类名 */
const CLASS_RE = /\.(cw-[a-z0-9-]+)/g

/**
 * 抽取文本里所有「选择器{声明}」形态的 CSS 规则（上游把 CSS 内联在 JS 产物里，
 * 故这里手工扫描而不对整份产物跑回溯正则，避免慢且不稳的匹配）。
 */
function extractRules(text: string): string[] {
  const out: string[] = []
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = text.indexOf('}', i)
    if (end === -1) break
    const body = text.slice(i + 1, end)
    if (!RULE_BODY_RE.test(body)) continue
    let start = i
    while (start > 0 && i - start < 300 && !'{`}'.includes(text[start - 1])) start--
    const rule = text.slice(start, end + 1).replace(/\s+/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim()
    if (rule.includes('cw-')) out.push(rule)
  }
  return out
}

/** 抽取 vendor 产物中所有含 cw-* 的 CSS 规则（结果缓存，避免重复扫描 18MB 产物） */
let rulesCache: string[] | null = null
function upstreamRules(): string[] {
  if (rulesCache) return rulesCache
  const rules = new Set<string>()
  for (const file of fs.readdirSync(VENDOR_DIR)) {
    if (!file.endsWith('.js')) continue
    const code = fs.readFileSync(path.join(VENDOR_DIR, file), 'utf-8')
    if (!code.includes('cw-')) continue
    for (const rule of extractRules(code)) rules.add(rule)
  }
  rulesCache = [...rules]
  return rulesCache
}

/** 规则正文是否声明了浅色底 / 深色文字 / 浅色描边（深色主题下会不可读的那类） */
function declaresLight(rule: string): boolean {
  const body = rule.slice(rule.indexOf('{'))
  return (
    /(^|[;:{])\s*(background|background-color)\s*:\s*(#(fff|f[0-9a-f]{2}|e[0-9a-f]{2}|d[0-9a-f]{2})|white)/i.test(body) ||
    /(^|[;:{])\s*color\s*:\s*#([0-5][0-9a-f]{5}|[0-9a-f]{3})\b/i.test(body) ||
    /border(-[a-z]+)?(-color)?\s*:\s*[^;]*#(e[0-9a-f]{2}|d[0-9a-f]{2}|c[0-9a-f]{2}|8[0-9a-f]{2})/i.test(body)
  )
}

/** 去掉 CSS 注释（注释里会提到类名，不能算覆盖） */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

const css = fs.readFileSync(CSS_PATH, 'utf-8')
const DARK_MARKER = '/* ====== 深色主题'
const darkCss = stripComments(css.slice(css.indexOf(DARK_MARKER)))
const darkClasses = new Set([...darkCss.matchAll(CLASS_RE)].map((m) => m[1]))

/** 取指定选择器的声明块（选择器在本文件里逐字出现） */
function cssRule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `样式表缺少规则: ${selector}`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

/** 未纳入深色覆盖、但已确认无问题的类：必须逐条写明理由 */
const DARK_EXEMPT: Record<string, string> = {
  // 上游自带 :root[data-theme='dark'] 分支，深色下已是深色
  'cw-ctxbar': '上游已提供深色分支（上下文工具条）',
  'cw-fmtbar': '上游已提供深色分支（选区浮动工具条）',
  'cw-linkbar': '上游已提供深色分支（链接浮动工具条）',
  'cw-fmtbar-color': '上游已提供深色分支；红色下划线是内容色',
  'cw-dev-x': '开发工具弹窗本身即深色主题',
  // 由「面板内后代规则」统一覆盖（input / select / textarea / label）
  'cw-eqe-ta': '公式输入框（textarea），由面板内输入控件规则覆盖',
  'cw-font-body': '字体对话框表单区，其中 input/select 由输入控件规则覆盖',
  'cw-toc-body': '目录对话框表单区，其中 input 由输入控件规则覆盖',
  'cw-pdlg-row': '边框和底纹行，其中 label/select 由面板 label 与输入控件规则覆盖',
  'cw-pdlg-edges': '各边单独设置，其中 label 由面板 label 规则覆盖',
  'cw-tbl-row': '插入表格行，其中 label 由面板 label 规则覆盖',
  'cw-tbl-spec': '表格规格行，其中 select 由面板输入控件规则覆盖',
  // 颜色本身就是内容 / 有意保持浅色
  'cw-pdlg-swatch': '取色块（input[type=color]），background 即当前选中颜色',
  'cw-tbl-swatch': '取色块（input[type=color]），background 即当前选中颜色',
  'cw-orgpg-badge': '整理页面分组徽标，紫底白字状态色',
  'cw-rcaret': '批注锚点标记，color 为协作者标识色',
  // 画布与强调色块：底/前景由上游主题或品牌色决定
  'cw-app': '画布工作区底色由上游 darkCanvasTheme 处理（页面纸张保持白色）',
  'cw-avatar': '批注头像，底为协作者标识色 + 白字',
  'cw-mention-av': '提及头像，同上',
  'cw-mention': '提及标签为品牌色块（浅蓝底蓝字），深色下仍清晰可读',
}

describe('word-editor 深色主题覆盖', () => {
  it('上游声明浅色的每个 cw-* 类都有深色覆盖（或已登记豁免）', () => {
    const uncovered = new Set<string>()
    for (const rule of upstreamRules()) {
      if (!declaresLight(rule)) continue
      const selector = rule.slice(0, rule.indexOf('{'))
      if (selector.includes('data-theme')) continue // 上游自己的深色分支
      for (const m of selector.matchAll(CLASS_RE)) {
        const cls = m[1]
        if (!darkClasses.has(cls) && !(cls in DARK_EXEMPT)) uncovered.add(cls)
      }
    }
    expect([...uncovered].sort()).toEqual([])
  })

  it('豁免表无失效条目（上游已删除的类要从豁免表移除）', () => {
    const lightClasses = new Set<string>()
    for (const rule of upstreamRules()) {
      if (!declaresLight(rule)) continue
      for (const m of rule.slice(0, rule.indexOf('{')).matchAll(CLASS_RE)) lightClasses.add(m[1])
    }
    expect(Object.keys(DARK_EXEMPT).filter((cls) => !lightClasses.has(cls))).toEqual([])
  })

  it('深色段引用的 --wc-* 变量都有定义（防拼写错误静默失效）', () => {
    const defined = new Set([...css.matchAll(/(--wc-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const used = new Set([...darkCss.matchAll(/var\((--wc-[a-z0-9-]+)/g)].map((m) => m[1]))
    expect([...used].filter((v) => !defined.has(v))).toEqual([])
  })

  it('面板深色覆盖不限定 .we-host（弹层挂载在 body 上，不在插件容器内）', () => {
    expect(darkCss.length).toBeGreaterThan(0)
    for (const panel of ['.cw-symp', '.cw-eqe', '.cw-tbl-modal', '.cw-sm-modal', '.cw-menu']) {
      expect(darkCss).toContain(panel)
    }
    // 深色段的弹层规则不得带容器作用域（.we-host 只用于 Ribbon 等宿主内元素）
    expect(darkCss.match(/\.we-host/g) ?? []).toEqual([])
  })
})

describe('word-editor Ribbon 宽度自适应', () => {
  it('面板溢出隐藏（收纳逻辑见 installResponsiveRibbon，正常宽度下不出现滚动条）', () => {
    const rule = cssRule('.we-host .cw-toolbar .rib-panel.active')
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toContain('flex-wrap: nowrap')
    // 曾试过「分组折行成多行」：按钮位置下移、Ribbon 变高，实测观感更差，已回退 —— 不再允许折行
    expect(rule).not.toContain('flex-wrap: wrap')
    expect(rule).not.toMatch(/max-height/)
  })

  it('分组不收缩（保持自然宽度，防按钮压扁文字重叠，也保证 scrollWidth 量测准确）', () => {
    const rule = cssRule('.we-host .cw-toolbar .rib-panel.active > .rib-group')
    expect(rule).toMatch(/flex:\s*0\s+0\s+auto/)
  })

  it('面板高度随内容自适应（上游写死 94px 会让插入等单行选项卡出现大片垂直留白）', () => {
    const rule = cssRule('.we-host .cw-toolbar .rib-panel.active')
    expect(rule).toMatch(/min-height:\s*56px/)
  })

  it('收纳配套类存在：压缩样式库（tight）与极窄兜底滚动（scroll）', () => {
    const tight = cssRule('.we-host .cw-toolbar .rib-panel.active.we-ribbon-tight .rib-gallery')
    expect(tight).toMatch(/max-width/)
    const scroll = cssRule('.we-host .cw-toolbar .rib-panel.active.we-ribbon-scroll')
    expect(scroll).toMatch(/overflow-x:\s*auto/)
  })

  it('面板内文字不换行（中文逐字换行会把按钮压成单字宽并溢出重叠）', () => {
    expect(css).toMatch(/\.we-host \.cw-toolbar button,[\s\S]{0,200}white-space: nowrap/)
  })

  it('上游规则抽取有效（防止抽取逻辑失效导致覆盖检查形同虚设）', () => {
    expect(upstreamRules().length).toBeGreaterThan(300)
  })
})
