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
