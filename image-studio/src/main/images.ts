/**
 * 作品库：本地文件落盘 + 缩略图 + SQLite 历史。
 * 图片保存在插件数据目录（plugin-data/image-studio/images），与插件安装目录解耦。
 */
import { app, clipboard, ClipboardItem, dialog, nativeImage, shell } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { PluginContext, PluginDatabase } from '@workavatar/plugin-sdk'
import type { GeneratedImage } from '../shared/types'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
}

let db: PluginDatabase | null = null
let dataDir = ''
let imagesDir = ''
let thumbsDir = ''

export function initImageStore(ctx: PluginContext): void {
  dataDir = ctx.paths.data
  imagesDir = path.join(dataDir, 'images')
  thumbsDir = path.join(dataDir, 'thumbnails')
  fs.mkdirSync(imagesDir, { recursive: true })
  fs.mkdirSync(thumbsDir, { recursive: true })
  db = ctx.storage.openSqlite('index')
  db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      negative_prompt TEXT NOT NULL DEFAULT '',
      width INTEGER NOT NULL DEFAULT 0,
      height INTEGER NOT NULL DEFAULT 0,
      file_path TEXT NOT NULL,
      thumb_path TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      seed INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      params_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'free'
    );
    CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite);
  `)
  // 旧版分库补列（v1.0 无 purpose）
  try {
    const columns = db.prepare('PRAGMA table_info(images)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'purpose')) {
      db.exec("ALTER TABLE images ADD COLUMN purpose TEXT NOT NULL DEFAULT 'free'")
    }
  } catch { /* 查询失败时按新库结构继续 */ }
}

function getDb(): PluginDatabase {
  if (!db) throw new Error('image store not initialized')
  return db
}

function monthDir(base: string, date: Date): string {
  const dir = path.join(base, `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function extFromMime(mime?: string, fallback = 'png'): string {
  if (!mime) return fallback
  return MIME_EXT[mime.toLowerCase().split(';')[0].trim()] || fallback
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return EXT_MIME[ext] || 'image/png'
}

function mapRow(row: Record<string, any>): GeneratedImage {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    provider: row.provider,
    model: row.model,
    prompt: row.prompt ?? '',
    negativePrompt: row.negative_prompt ?? '',
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    filePath: row.file_path,
    thumbPath: row.thumb_path,
    favorite: Number(row.favorite) === 1,
    seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
    durationMs: Number(row.duration_ms) || 0,
    createdAt: Number(row.created_at),
    paramsJson: row.params_json ?? '{}',
    purpose: row.purpose || 'free',
  }
}

export function listImages(limit = 500): GeneratedImage[] {
  const rows = getDb()
    .prepare('SELECT * FROM images ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(2000, Math.max(1, limit))) as Record<string, any>[]
  return rows.map(mapRow)
}

export function getImage(id: string): GeneratedImage | null {
  const row = getDb().prepare('SELECT * FROM images WHERE id = ?').get(id) as Record<string, any> | undefined
  return row ? mapRow(row) : null
}

export function imageCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number }
  return Number(row?.c) || 0
}

export function setFavorite(id: string, favorite: boolean): GeneratedImage | null {
  getDb().prepare('UPDATE images SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id)
  return getImage(id)
}

export interface SaveBufferResult {
  filePath: string
  thumbPath: string
  width: number
  height: number
}

/** 保存原图并按需生成缩略图（Electron nativeImage 不支持解码时缩略图回退原图） */
export function saveImageBuffer(buffer: Buffer, mime: string | undefined, fallbackExt = 'png'): SaveBufferResult {
  const now = new Date()
  const ext = extFromMime(mime, fallbackExt)
  const fileName = `img_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}_${crypto.randomBytes(3).toString('hex')}.${ext}`
  const filePath = path.join(monthDir(imagesDir, now), fileName)
  fs.writeFileSync(filePath, buffer)

  let width = 0
  let height = 0
  let thumbPath = filePath
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (!image.isEmpty()) {
      const size = image.getSize()
      width = size.width
      height = size.height
      const resized = width > 720 ? image.resize({ width: 720, quality: 'good' }) : image
      const thumbName = `${path.basename(fileName, `.${ext}`)}.jpg`
      const target = path.join(monthDir(thumbsDir, now), thumbName)
      fs.writeFileSync(target, resized.toJPEG(82))
      thumbPath = target
    }
  } catch { /* 解码失败时保留原图作为缩略图 */ }

  return { filePath, thumbPath, width, height }
}

export function insertImage(record: GeneratedImage): void {
  getDb()
    .prepare(
      `INSERT INTO images
        (id, job_id, provider, model, prompt, negative_prompt, width, height, file_path, thumb_path,
         favorite, seed, duration_ms, params_json, created_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.jobId,
      record.provider,
      record.model,
      record.prompt,
      record.negativePrompt,
      record.width,
      record.height,
      record.filePath,
      record.thumbPath,
      record.favorite ? 1 : 0,
      record.seed,
      record.durationMs,
      record.paramsJson,
      record.createdAt,
      record.purpose || 'free'
    )
}

export async function deleteImage(id: string): Promise<boolean> {
  const image = getImage(id)
  if (!image) return false
  getDb().prepare('DELETE FROM images WHERE id = ?').run(id)
  for (const target of new Set([image.filePath, image.thumbPath])) {
    if (!target || !fs.existsSync(target)) continue
    try {
      await shell.trashItem(target)
    } catch {
      try { fs.unlinkSync(target) } catch { /* 忽略单文件删除失败 */ }
    }
  }
  return true
}

export function newImageId(): string {
  return `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

export function readImageData(id: string, options?: { full?: boolean }): string | null {
  const image = getImage(id)
  if (!image || !fs.existsSync(image.filePath)) return null
  if (!options?.full) {
    try {
      const native = nativeImage.createFromPath(image.filePath)
      if (!native.isEmpty()) {
        const size = native.getSize()
        const longest = Math.max(size.width, size.height)
        // 参考图上传无需原始 4K 体积：超过 2048 时降采样，减少 IPC 与请求体开销
        if (longest > 2048) {
          const scale = 2048 / longest
          const resized = native.resize({
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
            quality: 'good',
          })
          return `data:image/jpeg;base64,${resized.toJPEG(90).toString('base64')}`
        }
      }
    } catch {
      // 解码失败时回退原始字节
    }
  }
  const buffer = fs.readFileSync(image.filePath)
  return `data:${mimeFromExt(image.filePath)};base64,${buffer.toString('base64')}`
}

/** 标题排版等衍生图：保存为独立作品，沿用原图的服务商/参数元信息 */
export function importDerivedImage(
  buffer: Buffer,
  sourceId: string,
  promptSuffix: string,
  paramsPatch: Record<string, unknown>
): GeneratedImage | null {
  const source = getImage(sourceId)
  if (!source) return null
  const saved = saveImageBuffer(buffer, 'image/png', 'png')
  let sourceParams: Record<string, unknown> = {}
  try {
    sourceParams = JSON.parse(source.paramsJson || '{}')
  } catch {
    sourceParams = {}
  }
  const record: GeneratedImage = {
    id: newImageId(),
    jobId: `overlay_${Date.now()}`,
    provider: source.provider,
    model: source.model,
    prompt: promptSuffix ? `${source.prompt}（${promptSuffix}）` : source.prompt,
    negativePrompt: source.negativePrompt,
    width: saved.width,
    height: saved.height,
    filePath: saved.filePath,
    thumbPath: saved.thumbPath,
    favorite: false,
    seed: null,
    durationMs: 0,
    createdAt: Date.now(),
    purpose: source.purpose,
    paramsJson: JSON.stringify({ ...sourceParams, ...paramsPatch, derivedFrom: source.id }),
  }
  insertImage(record)
  return record
}

export async function copyImageToClipboard(id: string): Promise<boolean> {
  const image = getImage(id)
  if (!image || !fs.existsSync(image.filePath)) return false
  const native = nativeImage.createFromPath(image.filePath)
  if (native.isEmpty()) return false
  const png = native.toPNG()
  const bytes = new Uint8Array(png.byteLength)
  bytes.set(png)
  const blob = new Blob([bytes], { type: 'image/png' })
  await clipboard.write([new ClipboardItem({ 'image/png': blob })])
  return true
}

// 与 data-model 一致：Electron 43 起对话框不再记忆上次目录，插件自行记忆
let lastDialogDir: string | undefined

function suggestedName(image: GeneratedImage): string {
  const stamp = new Date(image.createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const ext = path.extname(image.filePath) || '.png'
  return `image_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}${ext}`
}

export async function saveImageAs(id: string): Promise<string> {
  const image = getImage(id)
  if (!image || !fs.existsSync(image.filePath)) return ''
  const ext = path.extname(image.filePath).slice(1) || 'png'
  const defaultPath = lastDialogDir
    ? path.join(lastDialogDir, suggestedName(image))
    : path.join(app.getPath('pictures'), suggestedName(image))
  const res = await dialog.showSaveDialog({
    title: 'Save image',
    defaultPath,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  })
  if (res.canceled || !res.filePath) return ''
  fs.copyFileSync(image.filePath, res.filePath)
  lastDialogDir = path.dirname(res.filePath)
  return res.filePath
}

/** 直接下载到设置中的目录（未设置时落到系统图片目录/WorkAvatar） */
export async function downloadImage(id: string, targetDir: string): Promise<string> {
  const image = getImage(id)
  if (!image || !fs.existsSync(image.filePath)) return ''
  const dir = targetDir?.trim() || path.join(app.getPath('pictures'), 'WorkAvatar')
  fs.mkdirSync(dir, { recursive: true })
  const base = suggestedName(image)
  let target = path.join(dir, base)
  if (fs.existsSync(target)) {
    const stem = path.basename(base, path.extname(base))
    target = path.join(dir, `${stem}_${Date.now()}${path.extname(base)}`)
  }
  fs.copyFileSync(image.filePath, target)
  return target
}

export function showImageInFolder(id: string): boolean {
  const image = getImage(id)
  if (!image || !fs.existsSync(image.filePath)) return false
  shell.showItemInFolder(image.filePath)
  return true
}

export function getDataDir(): string {
  return dataDir
}

export async function openDataDir(): Promise<void> {
  await shell.openPath(dataDir)
}

export async function browseDirectory(current?: string): Promise<string> {
  const res = await dialog.showOpenDialog({
    title: 'Choose folder',
    defaultPath: current || lastDialogDir || app.getPath('pictures'),
    properties: ['openDirectory', 'createDirectory'],
  })
  const picked = res.canceled ? undefined : res.filePaths[0]
  if (picked) lastDialogDir = picked
  return picked || ''
}

export function storageUsageBytes(): number {
  let total = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try { total += fs.statSync(full).size } catch { /* 忽略统计失败 */ }
      }
    }
  }
  walk(imagesDir)
  walk(thumbsDir)
  return total
}
