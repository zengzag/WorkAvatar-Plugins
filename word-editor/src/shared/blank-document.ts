// 空白文档的最小 wordcanvas Document 模型（主进程建文档 / 渲染端无文档时预置，共用同一份定义）

export const BLANK_DOCUMENT = {
  section: {
    pageWidthPx: 794,
    pageHeightPx: 1123,
    marginPx: { top: 96, right: 120, bottom: 96, left: 120 },
  },
  blocks: [],
}

export const BLANK_DOCUMENT_JSON = JSON.stringify(BLANK_DOCUMENT)
