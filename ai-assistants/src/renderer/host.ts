/**
 * 渲染端宿主句柄：init 阶段由宿主注入 bridge 与 i18n，供各组件按需取用。
 */
import type { PluginBridge } from '@workavatar/plugin-sdk/renderer'

let bridge: PluginBridge | null = null

let translate: (key: string, options?: Record<string, unknown>) => string = (key) => key

export function setHost(
  nextBridge: PluginBridge,
  nextTranslate: (key: string, options?: Record<string, unknown>) => string
): void {
  bridge = nextBridge
  translate = nextTranslate
}

export function getBridge(): PluginBridge | null {
  return bridge
}

/** 插件文案（宿主已按插件 id 注册 locale 命名空间） */
export function t(key: string, options?: Record<string, unknown>): string {
  return translate(key, options)
}

/**
 * antd 浮层的挂载点：收敛到插件自己的 DOM 内。
 *
 * 默认是 portal 到 `document.body`，而宿主只给 `#root` 设了 overflow:hidden ——
 * 浮层一旦探出视口，被撑大的就是文档本身，于是凭空冒出滚动条
 * （工具条最右侧的按钮最容易触发）。
 * 挂到插件根节点下，浮层就只受 `#root` 那层（= 窗口）约束，文档尺寸不会再变。
 */
export function popupContainer(): HTMLElement {
  return document.querySelector<HTMLElement>('.aiweb-root') ?? document.body
}
