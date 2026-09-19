import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  removeInsertMenuBar,
  applyDirectionIcons,
  clampTop,
  clampFloatingLayers,
  installFloatingLayerClamp,
  stackStyleGroupButtons,
  pinnedGroupIds,
  nextCollapsibleGroup,
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

// ====== Ribbon 宽度自适应：收纳策略 ======

describe('pinnedGroupIds', () => {
  it('按选项卡给出带前缀的受保护分组 id（home 保护剪贴板/字体/段落）', () => {
    const pinned = pinnedGroupIds('home')
    expect(pinned.has('home.clipboard')).toBe(true)
    expect(pinned.has('home.font')).toBe(true)
    expect(pinned.has('home.paragraph')).toBe(true)
    expect(pinned.has('home.styles')).toBe(false)
  })

  it('未配置的选项卡（如动态的 table）返回空集合，由「保护第一个分组」兜底', () => {
    expect(pinnedGroupIds('table').size).toBe(0)
  })
})

describe('nextCollapsibleGroup', () => {
  const pinned = pinnedGroupIds('home')

  it('从右往左找第一个未受保护的分组（先收纳「编辑」再收纳「样式」）', () => {
    const groups = ['home.clipboard', 'home.font', 'home.paragraph', 'home.styles', 'home.editing']
    expect(nextCollapsibleGroup(groups, pinned)).toBe(4)
    expect(nextCollapsibleGroup(groups.slice(0, 4), pinned)).toBe(3)
  })

  it('第一个分组始终保留（其它全是受保护分组时返回 -1）', () => {
    expect(nextCollapsibleGroup(['home.clipboard', 'home.font', 'home.paragraph'], pinned)).toBe(-1)
    expect(nextCollapsibleGroup(['home.clipboard'], pinned)).toBe(-1)
  })

  it('受保护的中间分组被跳过，不影响更右侧未保护分组的收纳', () => {
    const groups = ['a.first', 'a.pinned', 'a.mid', 'a.pinned2', 'a.last']
    const set = new Set(['a.pinned', 'a.pinned2'])
    expect(nextCollapsibleGroup(groups, set)).toBe(4)
    expect(nextCollapsibleGroup(groups.slice(0, 4), set)).toBe(2)
  })

  it('空面板返回 -1', () => {
    expect(nextCollapsibleGroup([], new Set())).toBe(-1)
  })
})

// ====== 样式分组按钮竖排 ======

interface FakeNode {
  tagName: string
  className: string
  classList: { contains(cls: string): boolean }
  nextElementSibling: FakeNode | null
  parentElement: FakeControls | null
}

interface FakeControls {
  children: FakeNode[]
  insertBefore(el: FakeNode, before: FakeNode | null): void
}

function fakeRibbonBtn(): FakeNode {
  return {
    tagName: 'BUTTON',
    className: 'rib-btn',
    classList: { contains: (cls) => cls === 'rib-btn' },
    nextElementSibling: null,
    parentElement: null,
  }
}

function fakeGallery(): FakeNode {
  return {
    tagName: 'DIV',
    className: 'rib-gallery',
    classList: { contains: (cls) => cls === 'rib-gallery' },
    nextElementSibling: null,
    parentElement: null,
  }
}

/** 构造 rib-controls（gallery + 若干子节点）并维护 nextElementSibling 链 */
function fakeControls(children: FakeNode[]): FakeControls {
  const controls: FakeControls = {
    children,
    insertBefore(el, before) {
      const idx = before ? children.indexOf(before) : children.length
      children.splice(idx < 0 ? children.length : idx, 0, el)
      // 模拟 DOM 链维护：重排兄弟指针
      for (let i = 0; i < children.length; i++) {
        children[i].nextElementSibling = children[i + 1] ?? null
        children[i].parentElement = controls
      }
    },
  }
  for (let i = 0; i < children.length; i++) {
    children[i].nextElementSibling = children[i + 1] ?? null
    children[i].parentElement = controls
  }
  return controls
}

function fakeGalleryRoot(galleries: FakeNode[]): ParentNode {
  return { querySelectorAll: () => galleries } as unknown as ParentNode
}

describe('stackStyleGroupButtons', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubCreateElement(): FakeNode[] {
    const created: FakeNode[] = []
    vi.stubGlobal('document', {
      createElement: () => {
        const col: FakeNode & { style: { cssText: string }; children: FakeNode[]; appendChild(el: FakeNode): void } = {
          tagName: 'DIV',
          className: '',
          classList: { contains: (cls) => cls === 'we-style-actions' },
          nextElementSibling: null,
          parentElement: null,
          style: { cssText: '' },
          children: [],
          appendChild(el) { col.children.push(el) },
        }
        created.push(col)
        return col
      },
    })
    return created
  }

  it('样式库之后的连续 rib-btn 被包进纵向容器，容器紧跟样式库', () => {
    const created = stubCreateElement()
    const gallery = fakeGallery()
    const b1 = fakeRibbonBtn()
    const b2 = fakeRibbonBtn()
    const b3 = fakeRibbonBtn()
    const controls = fakeControls([gallery, b1, b2, b3])
    void controls

    const moved = stackStyleGroupButtons(fakeGalleryRoot([gallery]))
    expect(moved).toBe(3)
    expect(created).toHaveLength(1)
    expect(created[0].className).toBe('we-style-actions')
    expect(created[0].children).toEqual([b1, b2, b3])
    // 容器插到 gallery 之后
    expect(controls.children[0]).toBe(gallery)
    expect(controls.children[1]).toBe(created[0])
  })

  it('非按钮的兄弟节点截断收集，不足 2 个按钮时不处理', () => {
    const created = stubCreateElement()
    const gallery = fakeGallery()
    const b1 = fakeRibbonBtn()
    const sep = { tagName: 'DIV', className: 'sep', classList: { contains: () => false }, nextElementSibling: null, parentElement: null } as FakeNode
    const controls = fakeControls([gallery, b1, sep])
    void controls

    expect(stackStyleGroupButtons(fakeGalleryRoot([gallery]))).toBe(0)
    expect(created).toHaveLength(0)
    expect(controls.children).toEqual([gallery, b1, sep])
  })

  it('样式库后已是纵向容器时不再处理（幂等）', () => {
    const created = stubCreateElement()
    const gallery = fakeGallery()
    const column = {
      tagName: 'DIV',
      className: 'we-style-actions',
      classList: { contains: (cls: string) => cls === 'we-style-actions' },
      nextElementSibling: null,
      parentElement: null,
    } as FakeNode
    const controls = fakeControls([gallery, column])
    void controls

    expect(stackStyleGroupButtons(fakeGalleryRoot([gallery]))).toBe(0)
    expect(created).toHaveLength(0)
  })
})
