// docx 导入：mammoth 解包 word/document.xml 直接读 XML（subpackage）
// 兼容 doc 庭复杂场景，输入 docx → 内部 HTML（TipTap setContent 直接消费）

import fs from 'fs'
import path from 'path'
import mammoth from 'mammoth'

export interface ImportResult {
  html: string
  title: string
  sourcePath: string
}

/**
 * 导入 .docx：
 * - mammoth 转 HTML（默认图片转 base64 data URI，渲染端可直接展示）
 * - 原文件复制到插件 files 目录留档（sourcePath 供溯源/再次导入）
 */
export async function importDocx(ctx: { paths: { data: string } }, absPath: string, filesDir: string): Promise<ImportResult> {
  const buf = fs.readFileSync(absPath)
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: buf })
  if (messages && messages.some((m: any) => m.type === 'error')) {
    const first = messages.find((m: any) => m.type === 'error')
    throw new Error(first?.message || 'docx parse error')
  }
  // 原文件留档
  const safeName = `${Date.now().toString(36)}_${path.basename(absPath).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`
  const dest = path.join(filesDir, safeName)
  fs.writeFileSync(dest, buf)
  return {
    html: html || '',
    title: path.basename(absPath).replace(/\.docx$/i, ''),
    sourcePath: dest,
  }
}

/** 未传路径时主进程弹选择框 */
export async function pickAndImportDocx(ctx: {
  paths: { data: string }
  services: { i18n: { t(key: string, params?: any): string } }
}, filesDir: string): Promise<ImportResult | null> {
  const { dialog } = require('electron')
  const res = await dialog.showOpenDialog({
    title: ctx.services.i18n.t('dialog.importDocx'),
    properties: ['openFile'],
    filters: [
      { name: ctx.services.i18n.t('dialog.docxFilter'), extensions: ['docx'] },
      { name: 'All', extensions: ['*'] },
    ],
  })
  if (res.canceled || !res.filePaths[0]) return null
  return importDocx(ctx, res.filePaths[0], filesDir)
}
