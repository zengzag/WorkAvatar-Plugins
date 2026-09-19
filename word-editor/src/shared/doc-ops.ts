// AI 文档操作名（主进程工具定义与渲染端执行器共用，避免两侧字符串漂移）

export const DOC_OPS = {
  outline: 'doc_outline',
  read: 'doc_read',
  find: 'doc_find',
  setParagraphText: 'doc_set_paragraph_text',
  replace: 'doc_replace',
  insertParagraph: 'doc_insert_paragraph',
  deleteBlocks: 'doc_delete_blocks',
  moveBlock: 'doc_move_block',
  applyStyle: 'doc_apply_style',
} as const

export type DocOpName = (typeof DOC_OPS)[keyof typeof DOC_OPS]

/** 会改动文档内容的操作（首个改动前需自动快照，便于用户回退） */
export const MUTATING_DOC_OPS: ReadonlySet<string> = new Set<string>([
  DOC_OPS.setParagraphText,
  DOC_OPS.replace,
  DOC_OPS.insertParagraph,
  DOC_OPS.deleteBlocks,
  DOC_OPS.moveBlock,
  DOC_OPS.applyStyle,
])
