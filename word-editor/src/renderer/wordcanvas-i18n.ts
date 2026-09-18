// wordcanvas 内置 UI 本地化
//
// 上游编辑库不提供 i18n 能力：Ribbon、弹出面板、对话框的文案全部是英文硬编码字面量，
// 也没有可注入的文案钩子。这里用「英文短语 → 中文」词典 + DOM 观察器在宿主侧完成本地化：
// - 只作用于编辑器 UI 区域白名单（Ribbon / 状态栏 / 标尺 / 弹出层 / 上下文工具条 / 加载遮罩），
//   不触碰画布、大纲条目、批注正文、文本框编辑面等用户内容，避免误译正文；
// - 切到 en-US 时按反向词典还原为英文；
// - 动态文案（页码 / 字数）用正则规则处理，未覆盖的文案保持英文原样。

export type AppLocale = 'zh-CN' | 'en-US'

/** DOM 节点类型常量（避免依赖全局 Node，便于单测） */
const NODE_ELEMENT = 1
const NODE_TEXT = 3
const NODE_FRAGMENT = 11

/** 需要本地化的编辑器 UI 区域（正向白名单，未列入的 DOM 一律不动） */
export const UI_REGION_SELECTOR = [
  '.cw-toolbar',
  '.cw-statusbar',
  '.cw-ruler-row',
  '.cw-vruler',
  '.outline-head',
  '.cw-pop',
  '.cw-dialog',
  '.cw-menu',
  '.cw-float-panel',
  '.cw-float-drawer',
  '.cw-ctxbar',
  '.cw-loading-card',
  '.cw-le',
  '.cw-te',
  '.cw-se',
  '.cw-symp',
  '.cw-eqe',
  // 对话框：插入表格 / 页面布局 / 边框底纹 / 样式管理 / 符号 / 整理页面 / 字体 / 内容控件 / 目录
  '.cw-tbl-modal',
  '.cw-pl-modal',
  '.cw-pdlg-modal',
  '.cw-sm-modal',
  '.cw-sp-modal',
  '.cw-orgpg-modal',
  '.cw-fc-modal',
  '.cw-font-modal',
  '.cw-sdt-modal',
  '.cw-toc-modal',
].join(',')

/** 白名单内的用户内容 / 预览区域：不本地化，避免误译正文与用户数据 */
export const UI_EXCLUDE_SELECTOR = [
  '.cw-app', // 画布与光标面（文档正文由 canvas 绘制）
  '.cw-outline-list', // 大纲条目（用户标题）
  '.cw-review', // 批注 / 修订正文（用户内容）
  '.cw-sdt-preview', // 内容控件预览（用户内容）
  '.cw-fc-prev', // 格式预览（用户文本）
  '.cw-sm-prevhost', // 样式预览
  '.cw-tbl-preview', // 纸张 / 虚线占位预览
  '.cw-pdlg-preview',
].join(',')

/** 需要改写文案的 DOM 属性 */
const ATTRS = ['title', 'aria-label', 'placeholder'] as const

/** 动态文案规则（英文 → 中文） */
const PATTERNS: Array<[RegExp, string]> = [
  [/^Page (\d+) of (\d+)$/, '第 $1 页，共 $2 页'],
  [/^([\d,]+) words? · ([\d,]+) characters?$/, '$1 个单词 · $2 个字符'],
  [/^Level (\d+)$/, '级别 $1'],
  // 符号/公式弹层里的「插入 X」提示（正则兜底；词典命中的长短语优先级更高）
  [/^Insert (.+)$/, '插入 $1'],
]

/** wordcanvas 内置 UI 文案：英文原文 → 中文 */
export const UI_DICT: Record<string, string> = {
  // ====== 功能选项卡 / 分组标题 ======
  File: '文件',
  Home: '开始',
  Insert: '插入',
  Layout: '布局',
  Table: '表格',
  View: '视图',
  Review: '审阅',
  References: '引用',
  Developer: '开发工具',
  Activity: '活动',
  Clipboard: '剪贴板',
  Font: '字体',
  Paragraph: '段落',
  Styles: '样式',
  Illustrations: '插图',
  Links: '链接',
  Tables: '表格',
  Text: '文本',
  Symbols: '符号',
  Fields: '域',
  Controls: '控件',
  'Content controls': '内容控件',
  Pages: '页面',
  'Rows & Columns': '行和列',
  Merge: '合并',
  'Cell Alignment': '单元格对齐方式',
  AutoFit: '自动调整',
  'AutoFit & Size': '自动调整和尺寸',
  Shape: '形状',
  Show: '显示',
  Zoom: '缩放',
  Picture: '图片',
  'Edit Text': '编辑文本',
  Image: '图片',

  // ====== 通用动作 ======
  Paste: '粘贴',
  'Paste (Ctrl+V)': '粘贴 (Ctrl+V)',
  Cut: '剪切',
  'Cut (Ctrl+X)': '剪切 (Ctrl+X)',
  Copy: '复制',
  'Copy (Ctrl+C)': '复制 (Ctrl+C)',
  'Format painter (double-click = sticky)': '格式刷（双击可锁定）',
  Undo: '撤销',
  'Undo (Ctrl+Z)': '撤销 (Ctrl+Z)',
  Redo: '重复',
  'Redo (Ctrl+Y)': '重复 (Ctrl+Y)',
  Duplicate: '创建副本',
  Delete: '删除',
  Edit: '编辑',
  Remove: '移除',
  Clear: '清除',
  Apply: '应用',
  Cancel: '取消',
  Close: '关闭',
  'Close (Esc)': '关闭 (Esc)',
  Done: '完成',
  Open: '打开',
  Reopen: '重新打开',
  Escape: '退出',
  All: '全部',
  None: '无',
  Custom: '自定义',
  Auto: '自动',
  Automatic: '自动',
  Name: '名称',
  Address: '地址',
  Unknown: '未知',
  Content: '内容',
  'Yes, No, N/A': '是、否、不适用',

  // ====== 字体 ======
  'Bold (Ctrl+B)': '加粗 (Ctrl+B)',
  'Italic (Ctrl+I)': '倾斜 (Ctrl+I)',
  'Underline (Ctrl+U)': '下划线 (Ctrl+U)',
  Underline: '下划线',
  Strikethrough: '删除线',
  'Double strikethrough': '双删除线',
  Superscript: '上标',
  Subscript: '下标',
  'All caps': '全部大写字母',
  'Small caps': '小型大写字母',
  UPPERCASE: '全部大写',
  'Change case': '更改大小写',
  'Sentence case': '句首字母大写',
  'Capitalize Each Word': '每个单词首字母大写',
  'Clear all formatting': '清除所有格式',
  'Grow font': '增大字号',
  'Shrink font': '减小字号',
  'Font family': '字体',
  'Font colour': '字体颜色',
  'Font colour — choose colour': '字体颜色 — 选择颜色',
  'Font size (pt)': '字号 (pt)',
  'Font size presets': '字号预设',
  'Font — effects, caps, underline style, spacing': '字体 — 效果、大小写、下划线样式、字符间距',
  'Text highlight colour': '文本突出显示颜色',
  'Text highlight colour — choose colour': '文本突出显示颜色 — 选择颜色',
  'Character spacing': '字符间距',
  'Character tracking': '字符间距调整',
  'Character style': '字符样式',
  'Character styles': '字符样式',
  'Emphasis mark': '着重号',
  Emboss: '阳文',
  'Engrave (imprint)': '阴文（压印）',
  'Kerning at/above': '字距调整下限',
  Family: '字体',
  Size: '大小',
  Effects: '效果',
  Effect: '效果',
  'Text color': '文字颜色',
  'Fill colour': '填充颜色',
  Highlight: '突出显示',

  // ====== 段落 ======
  'Align left': '左对齐',
  'Align Left': '左对齐',
  Center: '居中',
  'Align Center': '水平居中',
  'Align right': '右对齐',
  'Align Right': '右对齐',
  Justify: '两端对齐',
  // 注：LTR / RTL 两个按钮的面部文字已由 wordcanvas-tweaks 换成图标，故不在此翻译
  'Left-to-right paragraph': '从左到右段落',
  'Right-to-left paragraph': '从右到左段落',
  'Align Top': '靠上',
  'Align Middle': '垂直居中',
  'Align Bottom': '靠下',
  Alignment: '对齐方式',
  'Vertical alignment': '垂直对齐',
  'Bulleted list': '项目符号',
  'Bulleted list — choose style': '项目符号 — 选择样式',
  Bullet: '项目符号',
  Bullets: '项目符号',
  'Bullet character': '项目符号字符',
  'Numbered list': '编号',
  'Numbered list (Tab/Shift+Tab change level)': '编号（Tab/Shift+Tab 调整级别）',
  'Numbered list (Tab/Shift+Tab change level) — choose style': '编号（Tab/Shift+Tab 调整级别）— 选择样式',
  'Decrease indent': '减少缩进',
  'Increase indent': '增加缩进',
  'Increase List Level': '提升列表级别',
  'Decrease List Level': '降低列表级别',
  'Left indent — drag to set': '左缩进 — 拖动设置',
  'Right indent — drag to set': '右缩进 — 拖动设置',
  'First-line indent — drag to set': '首行缩进 — 拖动设置',
  'Adjust right indent': '调整右缩进',
  'Line spacing': '行距',
  'Fixed line spacing': '固定行距',
  Exactly: '固定值',
  'At least': '最小值',
  Double: '双线',
  'Contextual spacing': '上下文间距',
  'Keep lines together': '段中不分页',
  'Keep with next paragraph': '与下段同页',
  'Keep Row Together': '行不跨页',
  'Keep row together': '行不跨页',
  'Page break before': '段前分页',
  'Outline level': '大纲级别',
  'Line numbering': '行号',
  Restart: '重新开始',
  'Each page': '每页',
  'Each section': '每节',
  Single: '单线',
  Dashed: '虚线',
  Thick: '粗线',
  Narrow: '窄',
  Wide: '宽',
  Moderate: '适中',
  inches: '英寸',
  cm: '厘米',
  'Borders & shading': '边框和底纹',
  'Default shading': '默认底纹',
  'Shading (fill)': '底纹（填充）',
  'Apply borders to': '边框应用于',
  'All edges': '所有边框',
  'Individual edges': '各边单独设置',
  'No outline': '无轮廓',
  Outside: '外部',
  Inside: '内部',
  'Inside H': '内部横线',
  'Inside V': '内部竖线',
  Width: '宽度',
  Style: '样式',
  'Show/hide formatting marks (spaces, tabs, paragraph ends, line breaks)': '显示/隐藏编辑标记（空格、制表符、段落标记、换行符）',
  'Sort — not supported by the engine yet': '排序 — 引擎暂不支持',
  Sort: '排序',
  'Empty paragraph': '空段落',

  // ====== 样式库 ======
  Normal: '正文',
  Title: '标题',
  Subtitle: '副标题',
  'Heading 1': '标题 1',
  'Heading 2': '标题 2',
  'Heading 3': '标题 3',
  'Heading levels': '标题级别',
  Quote: '引用',
  Code: '代码',
  Callout: '标注',
  Body: '正文',
  'Body text': '正文文本',
  'Manage styles…': '管理样式…',
  'Show only styles in use': '仅显示正在使用的样式',
  'Show all styles': '显示所有样式',
  'Update current style to match selection': '更新当前样式以匹配所选内容',
  'Style name': '样式名称',
  'Style id': '样式 ID',
  'List style': '列表样式',
  'List styles': '列表样式',
  'Table styles': '表格样式',
  Formatting: '格式',
  'Based on': '基于',
  Format: '格式',
  Stylesheet: '样式表',

  // ====== 插入：图片 / 形状 / 表格 / 链接 / 符号 ======
  'Insert image from your device': '从本机插入图片',
  'Insert a shape': '插入形状',
  'Insert shape': '插入形状',
  'Insert table': '插入表格',
  'Insert symbol or special character': '插入符号或特殊字符',
  'Insert/remove hyperlink': '插入/删除超链接',
  'Insert footnote': '插入脚注',
  'Insert endnote': '插入尾注',
  'Insert equation (MathML)': '插入公式 (MathML)',
  'Insert field': '插入域',
  'Insert Content Control': '插入内容控件',
  Equation: '公式',
  'Edit equation': '编辑公式',
  'Delete equation': '删除公式',
  'Delete Equation': '删除公式',
  Hyperlink: '超链接',
  'Edit link': '编辑链接',
  'Remove link': '删除链接',
  'Open link in a new tab': '在新标签页中打开链接',
  'Copy link': '复制链接',
  'Copy link address': '复制链接地址',
  'Table size': '表格尺寸',
  'Insert row above': '在上方插入行',
  'Insert row below': '在下方插入行',
  'Delete row': '删除行',
  'Delete rows': '删除行',
  'Insert column left': '在左侧插入列',
  'Insert column right': '在右侧插入列',
  'Delete column': '删除列',
  'Delete columns': '删除列',
  'Delete table': '删除表格',
  'Merge cells': '合并单元格',
  'Merge cells (select across cells in one row)': '合并单元格（选中同一行内的多个单元格）',
  'Unmerge cell': '取消合并单元格',
  Row: '行',
  Column: '列',
  Columns: '分栏',
  Cell: '单元格',
  Cells: '单元格',
  'Side tables': '侧边表格',
  'Table defaults': '表格默认值',
  'Repeat as header row': '重复标题行',
  'AutoFit to Contents': '根据内容自动调整',
  'AutoFit to Window': '根据窗口自动调整',
  'AutoFit columns to contents or window, or use fixed widths': '根据内容或窗口自动调整列宽，或使用固定列宽',
  'Fixed Column Width': '固定列宽',
  'Full width': '全宽',
  'Select All': '全选',
  'Select all (Ctrl+A)': '全选 (Ctrl+A)',
  'Select a node': '选择节点',

  // ====== 形状 / 图片 ======
  Lines: '线条',
  Line: '线条',
  'Basic Shapes': '基本形状',
  'Block Arrows': '箭头总汇',
  Rectangle: '矩形',
  'Rounded rectangle': '圆角矩形',
  Ellipse: '椭圆',
  Triangle: '三角形',
  Diamond: '菱形',
  Pentagon: '五边形',
  Hexagon: '六边形',
  Parallelogram: '平行四边形',
  Trapezoid: '梯形',
  'Up arrow': '上箭头',
  'Down arrow': '下箭头',
  'Left arrow': '左箭头',
  'Right arrow': '右箭头',
  'Text Box': '文本框',
  'Editable text box': '可编辑文本框',
  'Add or edit text': '添加或编辑文本',
  'Add or edit text in shape — select a shape first': '在形状中添加或编辑文本 — 请先选中形状',
  'Add Text': '添加文本',
  Fill: '填充',
  'Apply Fill': '应用填充',
  'Apply fill': '应用填充',
  'No fill': '无填充',
  Solid: '实线',
  Dash: '虚线',
  'Dash-dot': '点划线',
  Dot: '点线',
  'Dot dash': '点划线',
  Dotted: '点线',
  'Long dash': '长虚线',
  Position: '位置',
  'Distance from text': '与文字的距离',
  'Wrap text (square)': '四周型环绕',
  'In line with text': '嵌入型',
  'In Line with Text': '嵌入型',
  'In Front of Text': '衬于文字上方',
  'Behind Text': '衬于文字下方',
  'Bring to front': '置于顶层',
  'Send to back': '置于底层',
  'Bring to Front': '置于顶层',
  'Send to Back': '置于底层',
  'Move in front of text': '置于文字上方',
  'Move behind text': '置于文字下方',
  Group: '组合',
  'Group shapes': '组合形状',
  Ungroup: '取消组合',
  'Ungroup shape': '取消组合形状',
  'Group shapes — Shift-click a second shape first': '组合形状 — 请先按住 Shift 再单击第二个形状',
  'Ungroup shape — select a group first': '取消组合形状 — 请先选中组合',
  'Delete shape': '删除形状',
  'Delete Shape': '删除形状',
  'Delete shape (Del)': '删除形状 (Del)',
  'Delete shape — select a shape first': '删除形状 — 请先选中形状',
  'Delete image (Del)': '删除图片 (Del)',
  'Delete Image': '删除图片',
  'Shape fill': '形状填充',
  'Shape fill — select a shape first': '形状填充 — 请先选中形状',
  'Shape outline (colour, width, dash)': '形状轮廓（颜色、宽度、线型）',
  'Outline (colour, width, dash)': '轮廓（颜色、宽度、线型）',
  'Align center': '居中',
  'Shape outline (colour, width, dash) — select a shape first': '形状轮廓（颜色、宽度、线型）— 请先选中形状',
  'Shape in line with text (block) — select a shape first': '形状嵌入文字（块级）— 请先选中形状',
  'Wrap text around shape (square)': '设置形状环绕方式（四周型）',
  'Wrap text around shape (square) — select a shape first': '设置形状环绕方式（四周型）— 请先选中形状',
  'Wrap text around image (square)': '设置图片环绕方式（四周型）',
  'Wrap text around image (square) — select an image first': '设置图片环绕方式（四周型）— 请先选中图片',
  'Image in line with text (block)': '图片嵌入文字（块级）',
  'Image in line with text (block) — select an image first': '图片嵌入文字（块级）— 请先选中图片',
  'Bring shape to front (among shapes) — select a shape first': '将形状置于顶层（形状之间）— 请先选中形状',
  'Send shape to back (among shapes) — select a shape first': '将形状置于底层（形状之间）— 请先选中形状',
  'Move shape in front of text — select a shape first': '将形状置于文字上方 — 请先选中形状',
  'Move shape behind text — select a shape first': '将形状置于文字下方 — 请先选中形状',
  'Reveal on canvas': '在画布中显示',
  'Angle (degrees)': '角度（度）',
  Crop: '裁剪',

  // ====== 内容控件 / 域 ======
  'Rich Text': '富文本',
  'Drop-Down List': '下拉列表',
  'Combo Box': '组合框',
  'Check Box': '复选框',
  'Date Picker': '日期选取器',
  'Content control': '内容控件',
  'Content controls (SDT)': '内容控件 (SDT)',
  'Check box content control': '复选框内容控件',
  'Drop-down list content control': '下拉列表内容控件',
  'Date picker content control': '日期选取器内容控件',
  'Control id': '控件 ID',
  'List items (comma-separated):': '列表项（逗号分隔）：',
  'Date format': '日期格式',
  Checked: '已选中',
  'Choose Item': '选择项',
  'Choose an item.': '请选择一项。',
  'Click or tap here to enter text.': '单击或点击此处输入文本。',
  'Click or tap to enter a date.': '单击或点击此处输入日期。',
  "Content can't be edited": '内容无法编辑',
  "Control can't be deleted": '控件无法删除',
  'List id': '列表 ID',
  'List name': '列表名称',
  'Editing level': '编辑级别',
  'Level format': '级别格式',
  Levels: '级别',
  'Editing part': '编辑部位',
  Field: '域',
  'Field type': '域类型',
  'Field instruction': '域代码',
  'Edit field': '编辑域',
  Page: '页',
  Date: '日期',
  'Date (DATE)': '日期 (DATE)',
  'Conditional (IF)': '条件 (IF)',
  'Count by': '计数依据',
  List: '列表',
  Lists: '列表',

  // ====== 页面布局 ======
  'Page Setup': '页面设置',
  'Page layout': '页面布局',
  Orientation: '方向',
  Portrait: '纵向',
  Landscape: '横向',
  'Paper size': '纸张大小',
  Margins: '页边距',
  Top: '上',
  Bottom: '下',
  Left: '左',
  Right: '右',
  'Clear margins': '清除边距',
  'Apply to this section': '应用于本节',
  'Different first page': '首页不同',
  'Different odd & even pages': '奇偶页不同',
  'Header from top': '页眉距顶端',
  'Footer from bottom': '页脚距底端',
  'Top margin — drag to set': '上边距 — 拖动设置',
  'Bottom margin — drag to set': '下边距 — 拖动设置',
  Height: '高度',
  Inches: '英寸',
  Units: '单位',
  Preview: '预览',
  'Number of columns': '栏数',
  'Spacing between columns': '栏间距',
  'Line between columns': '栏间分隔线',
  'Equal column width': '栏宽相等',
  'Column Left': '左列',
  'Column Right': '右列',
  'Section start': '节的起始位置',
  'Section bands': '节标尺',
  'New page': '新页',
  Continuous: '连续',
  'Even page': '偶数页',
  'Odd page': '奇数页',
  'Start page number at': '起始页码',
  'Start at': '起始于',
  'Page break': '分页符',
  'Page break (Ctrl+Enter)': '分页符 (Ctrl+Enter)',
  'Section break — next page': '分节符 — 下一页',
  'Page color': '页面颜色',
  'Delete this page': '删除此页面',
  'Delete these pages': '删除这些页面',
  'Table of Contents': '目录',
  'Table of contents': '目录',
  'Multilevel list (1, 1.1, 1.1.1 — Tab / Shift+Tab change level)': '多级列表（1、1.1、1.1.1 — Tab/Shift+Tab 调整级别）',
  'Insert / update table of contents (Ctrl+click an entry jumps to it)': '插入/更新目录（Ctrl+单击条目可跳转）',
  'Update table of contents': '更新目录',
  'Size & position (exact width, height, rotation, offset) — select a shape first': '大小和位置（精确宽高、旋转、偏移）— 请先选中形状',
  'Snap to grid — anchored objects snap to grid lines while dragging': '对齐网格 — 拖动时锚定对象吸附到网格线',
  'Page layout (size, orientation, margins, columns, header/footer distance, page color & borders — applies to the caret\'s section)': '页面布局（纸张、方向、页边距、分栏、页眉/页脚距离、页面颜色与边框 — 应用于光标所在节）',
  'Organize pages — drag page thumbnails to reorder whole sections (never splits content)': '整理页面 — 拖动页面缩略图可重排整节（不会拆分内容）',
  'Rich text content control (wraps the selection or selected image)': '富文本内容控件（包裹所选内容或图片）',
  'Content control properties & content (inspect the control at the caret) — place the caret in a content control': '内容控件属性与内容（检查光标处的内容控件）— 请将光标放在内容控件中',
  'Remove the content control at the caret or around the selected image (keeps its content) — place the caret in a content control': '删除光标处或所选图片外层的内容控件（保留其内容）— 请将光标放在内容控件中',
  'Refresh entries and page numbers': '刷新条目和页码',
  'Recalculate TOC page numbers from the current layout': '按当前排版重新计算目录页码',
  'Horizontal ruler': '水平标尺',
  'Vertical ruler': '垂直标尺',
  Horizontal: '水平',
  'Horizontal (X)': '水平 (X)',
  'Grid spacing': '网格间距',
  'Grid: 1/2"': '网格：1/2"',
  'Grid: 1/4"': '网格：1/4"',
  'Grid: 1/8"': '网格：1/8"',
  'Show grid — a light mesh for aligning objects': '显示网格 — 用于对齐对象的浅色网格',

  // ====== 视图 / 缩放 ======
  Outline: '大纲',
  'Outline / navigation pane (jump to any heading)': '大纲/导航窗格（跳转到任意标题）',
  'Bookmarks — list, go to, add, rename, delete': '书签 — 列出、定位、添加、重命名、删除',
  Bookmarks: '书签',
  'Add a bookmark for the current selection': '为当前所选内容添加书签',
  'Delete bookmark': '删除书签',
  'Go to note': '转到注释',
  'Zoom in': '放大',
  'Zoom out': '缩小',
  'Zoom level': '缩放级别',
  'Collapse the ribbon (Ctrl+F1)': '折叠功能区 (Ctrl+F1)',
  'Document Inspector': '文档检查器',
  Inspect: '检查',

  // ====== 审阅 ======
  'Editing mode': '编辑模式',
  Editing: '编辑',
  Suggesting: '建议',
  Viewing: '查看',
  'Suggestions & comments — review, accept, reject': '建议和批注 — 审阅、接受、拒绝',
  Comment: '批注',
  Comments: '批注',
  'Leave a comment': '添加批注',
  'Go to this comment thread': '转到此批注会话',
  Resolve: '解决',
  'Resolve this comment': '解决此批注',
  Accept: '接受',
  'Accept this change': '接受此更改',
  Reject: '拒绝',
  'Reject this change': '拒绝此更改',
  Insertion: '插入',
  Deletion: '删除',
  History: '历史记录',
  'No edits yet.': '暂无修订。',

  // ====== 查找替换 ======
  Find: '查找',
  Replace: '替换',
  'Find & replace (Ctrl+F)': '查找和替换 (Ctrl+F)',
  'Replace (Ctrl+F)': '替换 (Ctrl+F)',
  'Match case': '区分大小写',
  'Match whole word only': '全字匹配',
  'Replace all': '全部替换',
  'Replace current': '替换当前',
  'Next (Enter)': '下一个 (Enter)',
  'Previous (Shift+Enter)': '上一个 (Shift+Enter)',
  'No nodes match the filter.': '没有符合筛选条件的节点。',

  // ====== 打开 / 导出 / 其他 ======
  'Open a Word document': '打开 Word 文档',
  Export: '导出',
  'Export to PDF': '导出为 PDF',
  'Export to .docx': '导出为 .docx',
  Share: '共享',
  'Publish & get a shareable link': '发布并获取可共享链接',
  'Copy JSON': '复制 JSON',
  'Copy Text': '复制文本',
  'Copy block id': '复制块 ID',
  'Copy label': '复制标签',
  'Copy failed': '复制失败',
  'Copy the Document JSON to the clipboard': '将文档 JSON 复制到剪贴板',
  'Copy the LayoutTree JSON to the clipboard': '将 LayoutTree JSON 复制到剪贴板',
  'Replace the document from a JSON snapshot': '从 JSON 快照替换文档',
  'Could not parse the file as a Document JSON.': '无法将文件解析为文档 JSON。',
  "Couldn't save": '无法保存',
  'Remove list formatting': '删除列表格式',
  'Promote (decrease level)': '提升（降低级别）',
  'Demote (increase level)': '降级（增加级别）',
  Recently: '最近',
  'Recently used': '最近使用',
  'Recent colours': '最近使用的颜色',
  'Theme colours': '主题颜色',

  // ====== 页面布局 / 对话框补充 ======
  'Page border': '页面边框',
  'From page edge': '距页面边缘',
  'From text': '距文字',
  'Vertical (Y)': '垂直 (Y)',
  Rotation: '旋转',
  'no rotation': '不旋转',
  Color: '颜色',
  Colours: '颜色',
  'Size & position': '大小和位置',
  'Organize Pages': '整理页面',
  'Document pages': '文档页面',
  Point: '点',
  Between: '间距',
  Baselines: '基线',
  Measure: '测量',
  Overlays: '叠加层',
  Background: '背景',
  'This document has no pages to organize.': '当前文档没有可整理的页面。',
  'Pin the current reading (stop following the pointer)': '固定当前读取（不再跟随指针）',
  'Pin the ribbon': '固定功能区',
  'Scroll the tree to the node under the caret as you edit': '编辑时自动滚动到光标所在节点',

  // ====== 加载阶段（导入 / 导出遮罩）======
  Unzipping: '解压中',
  'Reading styles': '读取样式',
  'Parsing content': '解析内容',
  'Building document': '构建文档',

  // ====== 提示 / 气泡 ======
  Dismiss: '关闭',
  'cannot share: offline (no backendUrl)': '无法共享：离线模式（未配置 backendUrl）',
  'Place the caret inside a content control first.': '请先将光标放在内容控件中。',
  'Builder code exported to template.ts.': '构建器代码已导出到 template.ts。',
  "Couldn't export builder code — see the console.": '无法导出构建器代码 — 详见控制台。',
  'select a group first': '请先选中组合',
  'select a shape first': '请先选中形状',
  'select an image first': '请先选中图片',
  'Shift-click a second shape first': '请先按住 Shift 再单击第二个形状',

  // ====== 书签 / 活动面板 ======
  'Bookmark name:': '书签名：',
  'Rename bookmark': '重命名书签',
  'Activity — who created/edited this document and when': '活动 — 谁在何时创建/编辑了本文档',
  'Created locally': '本地创建',
  Anonymous: '匿名',

  // ====== 编号格式 ======
  'A.   Upper letter': 'A.   大写字母',
  'a.   Lower letter': 'a.   小写字母',
  'I.   Upper roman': 'I.   大写罗马数字',
  'i.   Lower roman': 'i.   小写罗马数字',
  'tOGGLE cASE': '切换大小写',

  // ====== 符号选择器 / 公式编辑器弹层 ======
  // 注：字体名（Symbol / Wingdings / Webdings）与 LaTeX 模板片段保持原样，不在此翻译
  'Insert symbol': '插入符号',
  'Square root': '平方根',
  Parentheses: '括号',
  Fraction: '分数',
  Bmatrix: 'B 矩阵',
  Vmatrix: 'V 矩阵',
  'nth root': 'n 次方根',
  '2×2 matrix': '2×2 矩阵',
  'Summation with limits': '带上下限的求和',
  'Integral with limits': '带上下限的积分',
  'Display (own line)': '独占一行',
  'Inline (in text)': '嵌入文字',
  'Insert equation': '插入公式',
  'Could not parse — check the syntax.': '无法解析 — 请检查语法。',
  'Fix the MathML before inserting.': '请先修正 MathML 再插入。',
  'Type LaTeX math: \\frac{}{}, ^{}, _{}, \\sqrt{}, \\sum, \\int, \\alpha, \\left( \\right), \\begin{bmatrix}…\\end{bmatrix}. Click a template or symbol to insert.':
    '输入 LaTeX 公式：\\frac{}{}、^{}、_{}、\\sqrt{}、\\sum、\\int、\\alpha、\\left( \\right)、\\begin{bmatrix}…\\end{bmatrix}。可点击模板或符号插入。',
  'Edit Presentation MathML directly: <mi> variables, <mn> numbers, <mo> operators, <mfrac>, <msup>, <msqrt>…':
    '直接编辑 Presentation MathML：<mi> 变量、<mn> 数字、<mo> 运算符、<mfrac>、<msup>、<msqrt>…',

  'just now': '刚刚',
  Tab: '制表位',
  Endnote: '尾注',
  Endnotes: '尾注',
  Footnote: '脚注',
  Footnotes: '脚注',
  'Close Header/Footer': '关闭页眉/页脚',

  // ====== 常用颜色 ======
  'No Color': '无颜色',
  Black: '黑色',
  White: '白色',
  Red: '红色',
  Blue: '蓝色',
  Green: '绿色',
  Yellow: '黄色',
  Orange: '橙色',
  Purple: '紫色',
  Gray: '灰色',
  Grey: '灰色',
  'Bright green': '鲜绿色',
}

/** 区域上下文覆盖：同一英文短语在不同区域含义不同时按区域优先使用局部词典
    （例：Normal 在样式库=「正文」，在页边距预设=「普通」） */
const CONTEXT_DICTS: Array<{ region: string; dict: Record<string, string> }> = [
  { region: '.cw-pl-modal', dict: { Normal: '普通' } },
]

/** 反向词典：中文 → 英文（同值时保留首次出现的英文原文；上下文覆盖始终生效） */
const REVERSE_DICT: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const [en, zh] of Object.entries(UI_DICT)) {
    if (!zh || zh in out) continue
    out[zh] = en
  }
  for (const ctx of CONTEXT_DICTS) {
    for (const [en, zh] of Object.entries(ctx.dict)) out[zh] = en
  }
  return out
})()

/** 短语翻译：命中返回替换后的整串，未命中返回 null（保持原样）。
    可传入词典覆盖（上下文词典）。 */
export function translatePhrase(text: string, locale: AppLocale, dict?: Record<string, string>): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const table = dict ?? (locale === 'en-US' ? REVERSE_DICT : UI_DICT)
  const hit = table[trimmed]
  if (!hit || hit === trimmed) return null
  const start = text.indexOf(trimmed)
  return text.slice(0, start) + hit + text.slice(start + trimmed.length)
}

/** 动态文案翻译（仅中文方向；未命中返回 null） */
export function translatePattern(text: string, locale: AppLocale): string | null {
  if (locale === 'en-US') return null
  for (const [re, zh] of PATTERNS) {
    const m = text.match(re)
    if (m) return zh.replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? '')
  }
  return null
}

/** 翻译单条文本（区域上下文 → 词典 → 动态规则） */
export function translateText(text: string, locale: AppLocale, el?: Element | null): string | null {
  if (el && locale === 'zh-CN') {
    for (const ctx of CONTEXT_DICTS) {
      if (el.closest(ctx.region)) {
        const hit = translatePhrase(text, locale, ctx.dict)
        if (hit !== null) return hit
      }
    }
  }
  return translatePhrase(text, locale) ?? translatePattern(text, locale)
}

function isUiElement(el: Element): boolean {
  return el.closest(UI_REGION_SELECTOR) !== null && el.closest(UI_EXCLUDE_SELECTOR) === null
}

function applyTextNode(node: Text, locale: AppLocale): void {
  const parent = node.parentElement
  if (!parent || !isUiElement(parent)) return
  const next = translateText(node.nodeValue ?? '', locale, parent)
  if (next !== null) node.nodeValue = next
}

function applyAttrs(el: Element, locale: AppLocale): void {
  if (!isUiElement(el)) return
  for (const attr of ATTRS) {
    const raw = el.getAttribute(attr)
    if (!raw) continue
    const next = translateText(raw, locale, el)
    if (next !== null) el.setAttribute(attr, next)
  }
}

/** 遍历并本地化指定子树（含根元素自身的属性） */
export function localizeSubtree(root: Node, locale: AppLocale): void {
  if (root.nodeType === NODE_TEXT) {
    applyTextNode(root as Text, locale)
    return
  }
  if (root.nodeType === NODE_ELEMENT) applyAttrs(root as Element, locale)
  if (root.nodeType !== NODE_ELEMENT && root.nodeType !== NODE_FRAGMENT) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node: Node | null = walker.nextNode()
  while (node) {
    if (node.nodeType === NODE_TEXT) applyTextNode(node as Text, locale)
    else applyAttrs(node as Element, locale)
    node = walker.nextNode()
  }
}

/** 本地化容器内已存在的所有 UI 区域（跳过被外层区域覆盖的嵌套匹配） */
function localizeRegions(root: ParentNode, locale: AppLocale): void {
  for (const region of root.querySelectorAll(UI_REGION_SELECTOR)) {
    if (region.parentElement?.closest(UI_REGION_SELECTOR)) continue
    localizeSubtree(region, locale)
  }
}

/** 节点是否落在 UI 区域内（或自身包含 UI 区域），用于观察器快速预筛 */
function touchesUiRegion(node: Node): boolean {
  if (node.nodeType === NODE_TEXT) {
    const parent = node.parentElement
    return !!parent && isUiElement(parent)
  }
  if (node.nodeType !== NODE_ELEMENT) return false
  const el = node as Element
  if (isUiElement(el)) return true
  return el.closest(UI_EXCLUDE_SELECTOR) === null && el.querySelector(UI_REGION_SELECTOR) !== null
}

/**
 * 安装编辑器 UI 本地化：先本地化已有区域，再用 MutationObserver 处理运行时动态创建的
 * Ribbon 弹出层（下拉菜单 / 调色板 / 对话框 / 上下文工具条）与加载遮罩。
 *
 * 注意：这些弹层由上游挂在 `document.body` 上（而非编辑器容器内），因此必须观察 body；
 * 观察器用 UI 区域白名单预筛，非编辑器 UI 的 DOM（含用户正文）不会被触碰。
 *
 * @returns 卸载函数
 */
export function installWordCanvasLocalizer(container: HTMLElement, locale: AppLocale): () => void {
  localizeRegions(container, locale)
  localizeRegions(document, locale)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        applyTextNode(record.target as Text, locale)
      } else if (record.type === 'attributes') {
        applyAttrs(record.target as Element, locale)
      } else {
        record.addedNodes.forEach((node) => {
          if (touchesUiRegion(node)) localizeSubtree(node, locale)
        })
      }
    }
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  })
  return () => observer.disconnect()
}

