// wordcanvas 上游 UI 补丁：对无法通过配置关闭的上游交互元素做最小化处理

/** 「＋ 插入」浮条的唯一按钮文本前缀（全角加号，与语言无关） */
const INSERT_MARK = '＋'

/**
 * 移除上游「空白段落上浮出的 ＋ 插入」上下文工具条（insert-menu）。
 *
 * 背景：光标落在空白段落时，上游会在正文上层浮出一个 `＋ Insert` 按钮（打开块类型菜单）。
 * 宿主已有 Ribbon 插入入口，该浮条无必要且会遮挡正文，而上游未提供关闭开关。
 *
 * 做法：该工具条在编辑器挂载时一次性创建（`Xg()` 里 `document.body.appendChild`），
 * 后续 `place()/hide()` 只改内联 `display`，不会重新挂载 —— 因此移除节点即可彻底去掉；
 * 库销毁时对游离节点调用 `remove()` 也无副作用。
 *
 * 识别特征用「唯一子节点是文本以全角 ＋ 开头的按钮」，避免误伤同为单按钮结构的
 * 「目录(TOC)」工具条。
 *
 * @returns 被移除的工具条数量
 */
export function removeInsertMenuBar(root: ParentNode = document): number {
  let removed = 0
  for (const bar of root.querySelectorAll('.cw-ctxbar')) {
    const only = bar.children.length === 1 ? (bar.firstElementChild as HTMLElement | null) : null
    if (!only || only.tagName !== 'BUTTON') continue
    if (!(only.textContent ?? '').trim().startsWith(INSERT_MARK)) continue
    bar.remove()
    removed++
  }
  return removed
}

/** 与上游图标同款封装：16×16、沿用 currentColor 描边 */
const strokeIcon = (body: string): string =>
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" ' +
  `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

/** 从左到右：三行左对齐文本 + 右向箭头 */
const LTR_ICON = strokeIcon('<path d="M2 3.2h9M2 6.2h6M2 9.2h9"/><path d="M8.5 13H14M11.6 11 14 13l-2.4 2"/>')

/** 从右到左：三行右对齐文本 + 左向箭头 */
const RTL_ICON = strokeIcon('<path d="M5 3.2h9M8 6.2h6M5 9.2h9"/><path d="M2 13h5.5M4.4 11 2 13l2.4 2"/>')

/**
 * 把「从左到右 / 从右到左」按钮的文字面部换成 SVG 图标。
 *
 * 背景：上游这两个按钮用 `LA("LTR"|"RTL", …)` 建的是**文字**面部按钮（同排其余按钮均用
 * `UA(svg, …)` 的图标面部），中文译名（左到右/右到左）比图标宽很多，显得突兀且与工具栏不协调。
 *
 * 做法：按面部文本 `LTR`/`RTL` 精确命中，替换按钮 innerHTML 为同风格 SVG；
 * 点击监听与选中态注册都挂在按钮元素上，替换面部不影响功能。若上游改动面部文本，
 * 本补丁不命中即回退为上游原始文字（不会报错）。
 *
 * @returns 被替换的按钮数量
 */
export function applyDirectionIcons(root: ParentNode = document): number {
  let patched = 0
  for (const btn of root.querySelectorAll<HTMLElement>('.cw-toolbar button.rib-btn')) {
    const face = (btn.textContent ?? '').trim()
    const icon = face === 'LTR' ? LTR_ICON : face === 'RTL' ? RTL_ICON : null
    if (!icon) continue
    btn.innerHTML = icon
    patched++
  }
  return patched
}

/** 上游弹层选择器：这些元素都用 `position: fixed` + 内联 top/left 定位 */
const FLOAT_SELECTOR = [
  '.cw-pop',
  '.cw-menu',
  '.cw-dialog',
  '.cw-symp',
  '.cw-eqe',
  '.cw-float-panel',
  '.cw-float-drawer',
  '[class$="-modal"]',
].join(',')

/** 只处理新增的弹层节点（避免对编辑器内部大量 DOM 变更做无谓扫描） */
const FLOAT_HINT = /cw-(pop|menu|dialog|symp|eqe|float)|modal/

/**
 * 纵向视口钳制：把 top 收进 `[margin, viewportHeight - height - margin]`；
 * 弹层比视口还高时贴顶显示（`margin`），至少能看到顶部内容。
 */
export function clampTop(top: number, height: number, viewportHeight: number, margin = 6): number {
  const max = viewportHeight - height - margin
  if (max <= margin) return margin
  return Math.min(Math.max(top, margin), max)
}

/**
 * 把已经插入的浮动弹层钳制回视口内，返回被调整的弹层数量。
 *
 * 背景：上游下拉菜单（`.cw-pop`：行距、项目符号、调色板、插入表格网格…）定位只做
 * 「下方放不下就翻到按钮上方」（`top = 按钮top - 菜单高 - 3`），**没有视口钳制**：
 * 窗口偏矮时翻上去后 top 会变成负值，菜单实际渲染在视口之外 —— 表现就是「点了没反应」。
 * 对话框（`*-modal`）与符号/公式弹层上游已自行 `Math.max(6, …)`，这里对它们是无操作的。
 *
 * 只调整显式设置了内联 `top` 的 `position: fixed` 元素；横向不动（上游已处理右侧越界）。
 */
export function clampFloatingLayers(root: ParentNode = document, margin = 6): number {
  let fixed = 0
  for (const el of root.querySelectorAll<HTMLElement>(FLOAT_SELECTOR)) {
    if (!el.style.top) continue
    if (getComputedStyle(el).position !== 'fixed') continue
    const rect = el.getBoundingClientRect()
    if (!rect.height) continue
    const next = clampTop(rect.top, rect.height, window.innerHeight, margin)
    if (Math.abs(next - rect.top) < 1) continue
    el.style.top = `${Math.round(next)}px`
    fixed++
  }
  return fixed
}

/**
 * 安装弹层视口钳制：观察 `document.body` 上新增的弹层（上游把弹层挂在 body 上），
 * 插入后立刻校正一次位置。@returns 卸载函数
 */
export function installFloatingLayerClamp(margin = 6): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue
        const el = node as Element
        if (FLOAT_HINT.test(el.className ?? '') || el.querySelector(FLOAT_SELECTOR)) {
          clampFloatingLayers(document, margin)
          return
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

// ====== 系统字体注入 ======

/** 系统字体条目（主进程解析字体文件 name 表得到） */
export interface SystemFontEntry {
  value: string
  label: string
}

declare global {
  // 供 vendor 补丁读取：见 scripts/patch-wordcanvas.mjs（En 直通渲染 / Bn 下拉列表）
  // eslint-disable-next-line no-var
  var __WE_SYSTEM_FONT_LIST__: SystemFontEntry[] | undefined
  // eslint-disable-next-line no-var
  var __WE_SYSTEM_FONTS__: Set<string> | undefined
}

/**
 * 把系统字体列表注入全局，供 vendor 补丁消费：
 * - `__WE_SYSTEM_FONT_LIST__`：字体下拉 / 浮动格式条菜单的追加条目；
 * - `__WE_SYSTEM_FONTS__`：族名直通集合（含英文与中文两个名字，画布按系统字体渲染）。
 */
export function applySystemFontGlobals(fonts: SystemFontEntry[]): void {
  globalThis.__WE_SYSTEM_FONT_LIST__ = fonts
  globalThis.__WE_SYSTEM_FONTS__ = new Set(fonts.flatMap((f) => [f.value, f.label]))
}

// ====== 样式分组按钮竖排 ======

/** 「样式」分组操作按钮的纵向容器类名（幂等标记） */
const STYLE_ACTIONS_CLASS = 'we-style-actions'

/**
 * 把「样式」分组里样式库之后的操作按钮（更新样式 / 管理样式 / 仅显示使用中样式）
 * 竖排成一列，与「编辑」分组的纵向布局一致。
 *
 * 背景：上游把这几个图标按钮直接 append 到 rib-controls 行容器里横排，与高大的
 * 样式库卡片并排显得松散；「编辑」分组则是把按钮包进 `flex-direction:column` 容器。
 * 这里在宿主侧做同样的包装：在样式库后插入纵向容器并移入其后的连续 rib-btn。
 *
 * @returns 被竖排的按钮数量
 */
export function stackStyleGroupButtons(root: ParentNode = document): number {
  let moved = 0
  for (const gallery of root.querySelectorAll<HTMLElement>('.rib-controls .rib-gallery')) {
    const controls = gallery.parentElement
    if (!controls) continue
    if (gallery.nextElementSibling?.classList.contains(STYLE_ACTIONS_CLASS)) continue
    const buttons: HTMLElement[] = []
    let next = gallery.nextElementSibling as HTMLElement | null
    while (next && next.tagName === 'BUTTON' && next.classList.contains('rib-btn')) {
      buttons.push(next)
      next = next.nextElementSibling as HTMLElement | null
    }
    if (buttons.length < 2) continue
    const column = document.createElement('div')
    column.className = STYLE_ACTIONS_CLASS
    column.style.cssText = 'display:flex;flex-direction:column;gap:1px;align-items:center;'
    controls.insertBefore(column, buttons[0])
    for (const btn of buttons) column.appendChild(btn)
    moved += buttons.length
  }
  return moved
}

// ====== 页面隐藏时的浮动层收起 ======

/** 插件页被宿主 KeepAlive 隐藏时打在 <html> 上的类（styles.css 据此收起浮动层） */
export const PAGE_HIDDEN_CLASS = 'we-page-hidden'

// ====== Ribbon 宽度自适应（WPS 式简化显示） ======

/**
 * 各选项卡收窄时尽量保留的分组（data-ribbon-group 去掉「选项卡 id.」前缀后的 slug）。
 * 上游分组 id 由英文分组标题 slug 化并带选项卡前缀（如 home.font），与界面语言无关。
 * 未列出的选项卡仅保护第一个分组（见 nextCollapsibleGroup）。
 */
const PINNED_GROUPS: Record<string, string[]> = {
  file: ['open', 'undo'],
  home: ['clipboard', 'font', 'paragraph'],
  insert: ['pages', 'tables'],
  layout: ['page-setup'],
  view: ['show', 'zoom'],
}

/** 选项卡内受保护分组的完整 id 集合 */
export function pinnedGroupIds(tabId: string): ReadonlySet<string> {
  return new Set((PINNED_GROUPS[tabId] ?? []).map((slug) => `${tabId}.${slug}`))
}

/** 从右往左找出下一个可收纳分组索引（第一个分组始终保留，保证功能区基本可用）；无则 -1 */
export function nextCollapsibleGroup(groupIds: readonly string[], pinned: ReadonlySet<string>): number {
  for (let i = groupIds.length - 1; i > 0; i--) {
    if (!pinned.has(groupIds[i])) return i
  }
  return -1
}

/** 面板末尾「更多」按钮的类名（幂等标记） */
const MORE_BTN_CLASS = 'we-ribbon-more'
/** 面板处于「压缩样式库」阶段的类 */
const TIGHT_CLASS = 'we-ribbon-tight'
/** 兜底横向滚动的类（受保护分组也放不下的极窄场景） */
const SCROLL_CLASS = 'we-ribbon-scroll'
/** 收纳弹层的类（与上游 .cw-pop 同用，继承弹层定位底色与页面隐藏收起） */
const OVERFLOW_CLASS = 'we-ribbon-overflow'

/** 「更多」按钮图标：横向省略号（与上游同风格 currentColor） */
const MORE_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">' +
  '<circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>'

/** 已收纳分组的回移记录（扩宽后按原位置还原） */
interface StowedGroup {
  el: HTMLElement
  panel: HTMLElement
  parent: Node
  next: Element | null
}

/**
 * 安装 Ribbon 宽度自适应：容器变窄时按 WPS 的方式「减少显示的工具数量」而不是滚动条 ——
 * 先压缩样式库宽度，仍放不下则把右侧分组整体收进面板末尾的「更多」弹层（原节点移入，
 * 选中态/可用态/点击监听随节点保持上游同步），任何宽度下全部工具都可达。
 *
 * - 布局时机：ResizeObserver 感知容器宽度变化；MutationObserver 感知选项卡切换与功能区
 *   折叠（只认 active/collapsed 的增减，按钮选中态等高频类变更与本补丁自身的类改动不触发）；
 * - 每次布局先全部还原再按当前宽度收纳，状态只由宽度决定（幂等）；
 * - 受保护分组仍放不下时（极窄窗口）兜底恢复横向滚动。
 *
 * @param root 编辑器容器（面板与工具栏都在其中）
 * @param moreTitle 「更多」按钮的提示文案（随宿主语言）
 * @returns 卸载函数（还原所有分组、移除弹层与观察器）
 */
export function installResponsiveRibbon(root: ParentNode, moreTitle: string): () => void {
  const toolbar = root.querySelector<HTMLElement>('.cw-toolbar')
  if (!toolbar) return () => {}

  const stowed: StowedGroup[] = []
  const pop = document.createElement('div')
  pop.className = `cw-pop ${OVERFLOW_CLASS}`
  pop.style.display = 'none'
  document.body.appendChild(pop)
  let open = false

  const closePop = (): void => {
    if (!open) return
    pop.style.display = 'none'
    open = false
  }

  const openPop = (btn: HTMLElement): void => {
    pop.style.display = 'flex'
    const rect = btn.getBoundingClientRect()
    const width = pop.offsetWidth
    const left = Math.min(Math.max(rect.right - width, 6), Math.max(6, window.innerWidth - width - 6))
    pop.style.left = `${Math.round(left)}px`
    pop.style.top = `${Math.round(clampTop(rect.bottom + 3, pop.offsetHeight, window.innerHeight))}px`
    open = true
  }

  const moreButtonFor = (panel: HTMLElement): HTMLButtonElement => {
    const existing = panel.querySelector<HTMLButtonElement>(`:scope > .${MORE_BTN_CLASS}`)
    if (existing) return existing
    const btn = document.createElement('button')
    btn.className = `rib-btn ${MORE_BTN_CLASS}`
    btn.title = moreTitle
    btn.setAttribute('aria-label', moreTitle)
    btn.innerHTML = MORE_ICON
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', () => (open ? closePop() : openPop(btn)))
    panel.appendChild(btn)
    return btn
  }

  const stowGroup = (panel: HTMLElement, group: HTMLElement): void => {
    stowed.push({ el: group, panel, parent: group.parentElement!, next: group.nextElementSibling })
    // 收纳顺序从右往左，前插使弹层内保持功能区原始顺序
    pop.insertBefore(group, pop.firstElementChild)
  }

  const restoreAll = (): void => {
    closePop()
    for (const s of stowed) s.parent.insertBefore(s.el, s.next)
    stowed.length = 0
    toolbar.querySelectorAll(`.${MORE_BTN_CLASS}`).forEach((b) => ((b as HTMLElement).style.display = 'none'))
    toolbar.querySelectorAll(`.${TIGHT_CLASS}, .${SCROLL_CLASS}`).forEach((p) => p.classList.remove(TIGHT_CLASS, SCROLL_CLASS))
  }

  const layout = (): void => {
    restoreAll()
    if (toolbar.classList.contains('collapsed')) return
    const panel = toolbar.querySelector<HTMLElement>('.rib-panel.active')
    if (!panel) return

    const fits = () => panel.scrollWidth <= panel.clientWidth
    if (fits()) return

    // 「更多」按钮先显示占位，把它的宽度一并计入
    const btn = moreButtonFor(panel)
    btn.style.display = ''

    panel.classList.add(TIGHT_CLASS)
    if (!fits()) {
      const pinned = pinnedGroupIds(panel.dataset.tab ?? '')
      for (;;) {
        const groups = [...panel.querySelectorAll<HTMLElement>(':scope > .rib-group')]
        const idx = nextCollapsibleGroup(
          groups.map((g) => g.dataset.ribbonGroup ?? ''),
          pinned,
        )
        if (idx === -1) {
          panel.classList.add(SCROLL_CLASS)
          break
        }
        stowGroup(panel, groups[idx])
        if (fits()) break
      }
    }
    btn.style.display = stowed.some((s) => s.panel === panel) ? '' : 'none'
  }

  let rafId = 0
  let disposed = false
  const schedule = (): void => {
    if (rafId || disposed) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      if (!disposed) layout()
    })
  }

  const ro = new ResizeObserver(schedule)
  ro.observe(toolbar)
  // 只响应 active / collapsed 的增减：本补丁增删的 we-ribbon-* 类、按钮选中态等
  // 高频类变更若也触发布局，会因「布局本身改类」造成无限循环
  const mo = new MutationObserver((records) => {
    for (const record of records) {
      const t = record.target as Element
      const cls = t === toolbar ? 'collapsed' : 'active'
      if (t === toolbar || t.classList.contains('rib-panel')) {
        const had = (record.oldValue ?? '').split(/\s+/).includes(cls)
        if (had !== t.classList.contains(cls)) {
          schedule()
          return
        }
      }
    }
  })
  mo.observe(toolbar, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })

  const onDocMouseDown = (e: MouseEvent): void => {
    if (!open) return
    const target = e.target as Node
    if (pop.contains(target)) return
    for (const b of toolbar.querySelectorAll(`.${MORE_BTN_CLASS}`)) {
      if (b.contains(target)) return // 交给按钮自身 click 翻转
    }
    closePop()
  }
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closePop()
  }
  document.addEventListener('mousedown', onDocMouseDown, true)
  document.addEventListener('keydown', onDocKeyDown)

  layout()

  return () => {
    disposed = true
    if (rafId) cancelAnimationFrame(rafId)
    ro.disconnect()
    mo.disconnect()
    document.removeEventListener('mousedown', onDocMouseDown, true)
    document.removeEventListener('keydown', onDocKeyDown)
    restoreAll()
    pop.remove()
  }
}
