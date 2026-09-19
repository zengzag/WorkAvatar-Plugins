// 默认命名样式表
//
// 插件新建的空白文档只有 section + blocks（无 stylesheet），编辑器按内置默认值渲染。
// 当 AI 需要套用命名样式（标题/正文等）而文档尚无样式表时，用它补齐，
// 使「套用标题样式」这类排版诉求在任何文档上都可用。
// 取值与 wordcanvas 内置默认样式表一致（Georgia 正文 / Arial 标题）。

export interface DocStyleDef {
  id: string
  name: string
  basedOn?: string
  char?: Record<string, unknown>
  para?: Record<string, unknown>
}

export interface DocStylesheetDef {
  defaultStyleId: string
  styles: DocStyleDef[]
}

const NORMAL_CHAR = { fontFamily: 'Georgia, serif', fontSizePx: 16, bold: false, italic: false, color: '#202124' }
const NORMAL_PARA = { lineHeight: 1.5, spaceBeforePx: 0, spaceAfterPx: 12, align: 'left', indentFirstLinePx: 0 }
const HEADING_FONT = 'Arial, sans-serif'

export const DEFAULT_STYLESHEET: DocStylesheetDef = {
  defaultStyleId: 'Normal',
  styles: [
    { id: 'Normal', name: 'Normal', char: { ...NORMAL_CHAR }, para: { ...NORMAL_PARA } },
    {
      id: 'Title', name: 'Title', basedOn: 'Normal',
      char: { fontFamily: HEADING_FONT, fontSizePx: 32, bold: true, color: '#1a1a2e' },
      para: { align: 'center', spaceAfterPx: 4 },
    },
    {
      id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal',
      char: { italic: true, color: '#5f6368' },
      para: { align: 'center', spaceAfterPx: 28 },
    },
    {
      id: 'Heading1', name: 'Heading 1', basedOn: 'Normal',
      char: { fontFamily: HEADING_FONT, fontSizePx: 24, bold: true, color: '#1a1a2e' },
      para: { spaceBeforePx: 18, spaceAfterPx: 8, keepWithNext: true },
    },
    {
      id: 'Heading2', name: 'Heading 2', basedOn: 'Heading1',
      char: { fontSizePx: 19 },
      para: { spaceBeforePx: 14, spaceAfterPx: 6 },
    },
    {
      id: 'Quote', name: 'Quote', basedOn: 'Normal',
      char: { italic: true, color: '#5f6368' },
      para: { indentLeftPx: 36, spaceBeforePx: 8, spaceAfterPx: 8 },
    },
    {
      id: 'Code', name: 'Code', basedOn: 'Normal',
      char: { fontFamily: 'Consolas, monospace', fontSizePx: 14, color: '#0b57d0' },
      para: { lineHeight: 1.35 },
    },
  ],
}

/** 默认可用样式名（文档无样式表时供 AI 参考） */
export const DEFAULT_STYLE_NAMES: string[] = DEFAULT_STYLESHEET.styles.map((s) => s.name)
