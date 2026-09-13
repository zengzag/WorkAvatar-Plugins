/**
 * 视图模式图标（内联 SVG）。
 *
 * 刻意不复用 antd 图标：antd 图标集中没有语义精确对应「单栏 / 双栏 / 标签页」的图形，
 * 硬套会让人误读。三个图标统一 16×16 视框、1.3 描边、圆角，视觉重量与 antd 图标接近。
 */
interface IconProps {
  size?: number
}

const BASE = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

/** 单栏：一块整区 */
export function IconSingle({ size = 14 }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size}>
      <rect x="2" y="3" width="12" height="10" rx="2.2" />
    </svg>
  )
}

/** 双栏：两块并排 */
export function IconSplit({ size = 14 }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size}>
      <rect x="1.8" y="3" width="5.4" height="10" rx="1.8" />
      <rect x="8.8" y="3" width="5.4" height="10" rx="1.8" />
    </svg>
  )
}

/** 标签页：窗口 + 顶部标签条 */
export function IconTabs({ size = 14 }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size}>
      <rect x="2" y="3" width="12" height="10" rx="2.2" />
      <path d="M2 6.4h12" />
      <path d="M7 3v3.4" />
      <path d="M10.6 3v3.4" />
    </svg>
  )
}
