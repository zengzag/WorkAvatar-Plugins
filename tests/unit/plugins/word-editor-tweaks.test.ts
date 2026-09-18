import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  removeInsertMenuBar,
  applyDirectionIcons,
  clampTop,
  clampFloatingLayers,
  installFloatingLayerClamp,
} from '../../../word-editor/src/renderer/wordcanvas-tweaks'

/**
 * word-editor 上游 UI 补丁单测：
 * 移除「＋ 插入」浮动工具条时必须精确命中，且不能误伤同为「单按钮」结构的
 * 目录(TOC)工具条或其它多按钮工具条。
 */

interface FakeChild {
  tagName: string
  textContent: string
  removed: boolean
  remove(): void
}

function fakeButton(text: string): FakeChild {
  return {
    tagName: 'BUTTON',
    textContent: text,
    removed: false,
    remove() { this.removed = true },
  }
}

function fakeSep(): FakeChild {
  return { tagName: 'DIV', textContent: '', removed: false, remove() { this.removed = true } }
}

function fakeBar(children: FakeChild[]): { children: FakeChild[]; firstElementChild: FakeChild | null; removed: boolean; remove(): void } {
  return {
    children,
    firstElementChild: children[0] ?? null,
    removed: false,
    remove() { this.removed = true },
  }
}

function fakeRoot(bars: unknown[]): ParentNode {
  return { querySelectorAll: () => bars } as unknown as ParentNode
}

describe('removeInsertMenuBar', () => {
  it('只移除「＋」前缀的单按钮工具条', () => {
    const insertBar = fakeBar([fakeButton('＋ Insert')])
    const tocBar = fakeBar([fakeButton('Update table of contents')])
    const multiBar = fakeBar([fakeButton('Bold'), fakeSep(), fakeButton('Italic')])
    const removed = removeInsertMenuBar(fakeRoot([insertBar, tocBar, multiBar]))

    expect(removed).toBe(1)
    expect(insertBar.removed).toBe(true)
    // 目录工具条同为单按钮结构，必须保留
    expect(tocBar.removed).toBe(false)
    expect(multiBar.removed).toBe(false)
  })

  it('本地化后的「＋ 插入」同样命中（不依赖语言）', () => {
    const zhBar = fakeBar([fakeButton('＋ 插入')])
    expect(removeInsertMenuBar(fakeRoot([zhBar]))).toBe(1)
    expect(zhBar.removed).toBe(true)
  })

  it('多按钮工具条即使首个子节点是「＋」按钮也不移除', () => {
    const bar = fakeBar([fakeButton('＋ Insert'), fakeButton('Other')])
    expect(removeInsertMenuBar(fakeRoot([bar]))).toBe(0)
    expect(bar.removed).toBe(false)
  })

  it('无匹配工具条时返回 0', () => {
    expect(removeInsertMenuBar(fakeRoot([]))).toBe(0)
  })
})

interface FakeButton2 {
  textContent: string
  innerHTML: string
}

function fakeRibbonButton(face: string): FakeButton2 {
  return { textContent: face, innerHTML: `<span>${face}</span>` }
}

function fakeToolbar(buttons: FakeButton2[]): ParentNode {
  return { querySelectorAll: () => buttons } as unknown as ParentNode
}

describe('applyDirectionIcons', () => {
  it('LTR / RTL 文字面部替换为同风格 SVG 图标，其余按钮不动', () => {
    const ltr = fakeRibbonButton('LTR')
    const rtl = fakeRibbonButton('RTL')
    const bold = fakeRibbonButton('B')
    const indent = fakeRibbonButton('') // 已是图标按钮（无文字面部）
    const patched = applyDirectionIcons(fakeToolbar([ltr, rtl, bold, indent]))

    expect(patched).toBe(2)
    for (const btn of [ltr, rtl]) {
      expect(btn.innerHTML.startsWith('<svg')).toBe(true)
      expect(btn.innerHTML).toContain('viewBox="0 0 16 16"')
      expect(btn.innerHTML).toContain('stroke="currentColor"')
    }
    // 两个方向图标必须不同（一个指右、一个指左）
    expect(ltr.innerHTML).not.toBe(rtl.innerHTML)
    expect(bold.innerHTML).toBe('<span>B</span>')
    expect(indent.innerHTML).toBe('<span></span>')
  })

  it('重复执行是幂等的（图标面部无文字，不再命中）', () => {
    const ltr = fakeRibbonButton('LTR')
    const toolbar = fakeToolbar([ltr])
    expect(applyDirectionIcons(toolbar)).toBe(1)
    const svg = ltr.innerHTML
    ltr.textContent = '' // 替换后按钮只剩 svg，无文字面部
    expect(applyDirectionIcons(toolbar)).toBe(0)
    expect(ltr.innerHTML).toBe(svg)
  })
})

/** 弹层视口钳制的假元素：内联 top + 固定定位 + 给定矩形 */
interface FakeLayer {
  style: { top: string }
  className: string
  getBoundingClientRect(): { top: number; height: number }
}

function fakeLayer(top: number, height: number, inlineTop = `${top}px`): FakeLayer {
  return {
    style: { top: inlineTop },
    className: 'cw-pop',
    getBoundingClientRect: () => ({ top, height }),
  }
}

function fakeLayerRoot(layers: FakeLayer[]): ParentNode {
  return { querySelectorAll: () => layers } as unknown as ParentNode
}

/** 上游弹层一律 position: fixed；测试里用最小的样式表桩 */
function stubViewport(innerHeight: number, position = 'fixed'): void {
  vi.stubGlobal('window', { innerHeight })
  vi.stubGlobal('getComputedStyle', () => ({ position }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('clampTop', () => {
  it('放得下时保持原位', () => {
    expect(clampTop(100, 200, 600)).toBe(100)
  })

  it('顶部越界（上游翻到按钮上方后 top 为负）钳到上边距', () => {
    expect(clampTop(-200, 300, 600)).toBe(6)
  })

  it('底部越界时上移到视口内', () => {
    expect(clampTop(500, 300, 600)).toBe(294) // 600 - 300 - 6
  })

  it('弹层比视口还高时贴顶显示，不产生负值', () => {
    expect(clampTop(100, 800, 600)).toBe(6)
  })
})

describe('clampFloatingLayers', () => {
  it('把翻到视口外的菜单钳回视口内，并写回内联 top', () => {
    stubViewport(600)
    const menu = fakeLayer(-180, 250)
    expect(clampFloatingLayers(fakeLayerRoot([menu]))).toBe(1)
    expect(menu.style.top).toBe('6px')
  })

  it('位置正常 / 未设内联 top / 非 fixed 的弹层都不动', () => {
    stubViewport(600)
    const ok = fakeLayer(120, 200)
    const auto = fakeLayer(0, 200, '')
    const count = clampFloatingLayers(fakeLayerRoot([ok, auto]))
    expect(count).toBe(0)
    expect(ok.style.top).toBe('120px')
    expect(auto.style.top).toBe('')

    stubViewport(600, 'absolute') // 非 fixed：交由上游/文档流决定，不介入
    const absolute = fakeLayer(-180, 250)
    expect(clampFloatingLayers(fakeLayerRoot([absolute]))).toBe(0)
  })
})

describe('installFloatingLayerClamp', () => {
  it('弹层插入 body 后被立即钳制（含子树内的弹层）', () => {
    stubViewport(600)
    let callback: ((records: unknown[]) => void) | null = null
    let disconnected = false
    class FakeObserver {
      constructor(cb: (records: unknown[]) => void) { callback = cb }
      observe(): void {}
      disconnect(): void { disconnected = true }
    }
    vi.stubGlobal('MutationObserver', FakeObserver)
    const menu = fakeLayer(-180, 250)
    vi.stubGlobal('document', { body: {}, querySelectorAll: () => [menu] })

    const stop = installFloatingLayerClamp()
    // 直接挂在 body 上的弹层 + 包在 backdrop 里的弹层都要命中
    const backdrop = { nodeType: 1, className: 'cw-pdlg-backdrop', querySelector: () => menu as unknown as Element }
    const notify = callback as ((records: unknown[]) => void) | null
    notify?.([{ addedNodes: [backdrop] }])
    expect(menu.style.top).toBe('6px')

    stop()
    expect(disconnected).toBe(true)
  })
})
