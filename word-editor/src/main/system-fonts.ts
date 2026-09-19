// 系统字体枚举：解析字体文件（sfnt/ttc）的 name 表得到族名（英文名 + 中文名），
// 供编辑器字体下拉展示与画布系统字体直通渲染（vendor 补丁见 scripts/patch-wordcanvas.mjs）。
// 只读名称，不向渲染端传字体二进制 —— 画布直接按族名使用系统安装字体。

import fs from 'fs'
import path from 'path'

export interface SystemFontOption {
  /** 族名（写入文档 / 导出 docx 的规范名，canvas 按此名解析系统字体） */
  value: string
  /** 显示名（优先中文本地化名） */
  label: string
}

/** wordcanvas 内置克隆/替换表已覆盖的族名 —— 下拉已有对应条目，不重复列出 */
const COVERED = new Set([
  'calibri', 'cambria', 'georgia', 'arial', 'helvetica', 'helvetica neue',
  'times new roman', 'times', 'courier new', 'courier', 'verdana', 'tahoma',
  'segoe ui', 'trebuchet ms', 'consolas', 'monaco', 'lucida console',
  'garamond', 'book antiqua', 'palatino', 'serif', 'sans-serif', 'sans',
  'monospace', 'mono', 'carlito', 'caladea', 'gelasio', 'arimo',
  'timesnewroman', 'cousine', 'stixtwomath', 'notosanssc', 'notosansarabic',
  'notosanshebrew',
])

const FONT_EXT_RE = /\.(ttf|otf|ttc)$/i

interface FamilyNames {
  /** 英文族名（name 表 langId 0x409 优先） */
  en: string | null
  /** 中文族名（langId 0x0804），可能为 null */
  zh: string | null
}

interface NameRecord {
  platform: number
  encoding: number
  language: number
  nameId: number
  text: string
}

function fontDirs(): string[] {
  const dirs = [
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
    ...(process.env.LOCALAPPDATA
      ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')]
      : []),
  ]
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory()
    } catch {
      return false
    }
  })
}

function readSlice(fd: number, position: number, length: number): Buffer | null {
  try {
    const buf = Buffer.alloc(length)
    const read = fs.readSync(fd, buf, 0, length, position)
    return read > 0 ? buf.subarray(0, read) : null
  } catch {
    return null
  }
}

function decodeUtf16be(buf: Buffer): string {
  // Node 无 UTF-16BE 解码：截取偶数字节复制后按 LE 解（个别记录长度为奇数）
  const usable = buf.length - (buf.length % 2)
  const copy = Buffer.from(buf.subarray(0, usable))
  copy.swap16()
  return copy.toString('utf16le')
}

/** 族名合法性：非空、长度合理、无控制字符与文件系统/清单类杂字符（防御损坏的 name 表） */
function isUsableFamily(text: string): boolean {
  return text.length > 0 && text.length <= 64 && !/[\u0000-\u001f\\/,<>:"|?*]/.test(text)
}

/** 解码 name 表字符串；platform 0/3 为 UTF-16BE，platform 1 为 Mac Roman(latin1 近似) */
function decodeNameString(platform: number, raw: Buffer): string | null {
  if (platform === 1) return raw.toString('latin1')
  if (platform !== 0 && platform !== 3) return null
  const decoded = raw.length >= 2 ? decodeUtf16be(raw) : null
  // 个别损坏字体把 ASCII 串按单字节存储，按 UTF-16BE 解会得到成片 CJK + 罕见符号混杂的
  // 乱码；而合法族名不会含拉丁扩展/一般标点等罕见区段 —— 命中即视为损坏记录丢弃。
  // 注意不能按「解出 CJK 且字节全为 ASCII」回退 latin1：楷体等纯中文名的 UTF-16BE
  // 字节恰好都落在可打印 ASCII 区间，会被误判。
  if (decoded && /[\u0080-\u00ff\u2000-\u2fff]/.test(decoded)) return null
  return decoded
}

/** 从 name 表字节块提取族名记录（导出以便单测） */
export function extractNames(table: Buffer): FamilyNames {
  if (table.length < 6) return { en: null, zh: null }
  const count = table.readUInt16BE(2)
  // name 表规范：stringOffset 为相对表起始的绝对偏移，记录内 offset 再相对 stringOffset
  const stringOffset = table.readUInt16BE(4)
  const records: NameRecord[] = []
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    if (rec + 12 > table.length) break
    const nameId = table.readUInt16BE(rec + 6)
    if (nameId !== 1 && nameId !== 16) continue
    const len = table.readUInt16BE(rec + 8)
    const off = stringOffset + table.readUInt16BE(rec + 10)
    if (off + len > table.length) continue
    const raw = table.subarray(off, off + len)
    const platform = table.readUInt16BE(rec)
    const text = decodeNameString(platform, raw)
    if (text && isUsableFamily(text)) {
      records.push({
        platform,
        encoding: table.readUInt16BE(rec + 2),
        language: table.readUInt16BE(rec + 4),
        nameId,
        text,
      })
    }
  }
  // 英文族名：优先 Windows en-US 的 Preferred Family(16)，逐级放宽
  const pick = (nameId: number, platform: number | null, language: number | null): string | null => {
    const hit = records.find(
      (r) => r.nameId === nameId && (platform === null || r.platform === platform) && (language === null || r.language === language)
    )
    return hit?.text ?? null
  }
  const en =
    pick(16, 3, 0x409) ?? pick(1, 3, 0x409) ?? pick(16, 3, null) ?? pick(1, 3, null) ??
    pick(16, 0, null) ?? pick(1, 0, null) ?? pick(16, 1, null) ?? pick(1, 1, null)
  // 中文族名：Windows 简体中文优先，Unicode 平台兜底（language 0x0804 常见于 platform 3）
  const zh = pick(16, 3, 0x804) ?? pick(1, 3, 0x804) ?? pick(16, 3, 0x1004) ?? pick(1, 3, 0x1004)
  return { en, zh: zh && zh !== en ? zh : null }
}

/** 解析 base 偏移处的单个 sfnt 字体；非 sfnt 或缺 name 表返回 null。
 *  注：TTC 规范中子字体的表目录偏移相对「TTC 文件起始」而非子字体头，单独 sfnt 中 base=0，
 *  两种情况 name 表都按绝对位置读取。 */
function parseSfntNames(fd: number, base: number): FamilyNames | null {
  const head = readSlice(fd, base, 12)
  if (!head || head.length < 12) return null
  const version = head.readUInt32BE(0)
  if (version !== 0x00010000 && version !== 0x4f54544f /* OTTO */ && version !== 0x74727565 /* true */) return null
  const numTables = head.readUInt16BE(4)
  if (numTables <= 0 || numTables > 512) return null
  const dir = readSlice(fd, base + 12, numTables * 16)
  if (!dir || dir.length < numTables * 16) return null
  for (let i = 0; i < numTables; i++) {
    const rec = i * 16
    if (dir.toString('latin1', rec, rec + 4) !== 'name') continue
    const nameOff = dir.readUInt32BE(rec + 8)
    const nameLen = dir.readUInt32BE(rec + 12)
    if (nameOff <= 0 || nameLen <= 6) return null
    // name 表内字符串偏移为 u16，表体上限 64KB+6
    const table = readSlice(fd, nameOff, Math.min(nameLen, 0x10006))
    return table ? extractNames(table) : null
  }
  return null
}

/** ttc 集合：逐个解析其中包含的 sfnt 字体 */
function parseTtcNames(fd: number): FamilyNames[] {
  const head = readSlice(fd, 0, 12)
  if (!head || head.length < 12 || head.toString('latin1', 0, 4) !== 'ttcf') return []
  const numFonts = head.readUInt32BE(8)
  if (numFonts <= 0 || numFonts > 16) return []
  const offs = readSlice(fd, 12, numFonts * 4)
  if (!offs || offs.length < numFonts * 4) return []
  const out: FamilyNames[] = []
  for (let i = 0; i < numFonts; i++) {
    const names = parseSfntNames(fd, offs.readUInt32BE(i * 4))
    if (names) out.push(names)
  }
  return out
}

let cache: SystemFontOption[] | null = null

/** 枚举系统字体（进程内缓存；仅 Windows，其他平台返回空列表） */
export function listSystemFonts(): SystemFontOption[] {
  if (cache) return cache
  if (process.platform !== 'win32') {
    cache = []
    return cache
  }
  const byKey = new Map<string, SystemFontOption>()
  for (const dir of fontDirs()) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isFile() || !FONT_EXT_RE.test(ent.name)) continue
      const file = path.join(dir, ent.name)
      let fd: number | null = null
      try {
        fd = fs.openSync(file, 'r')
        const families: Array<FamilyNames | null> =
          ent.name.toLowerCase().endsWith('.ttc') ? parseTtcNames(fd) : [parseSfntNames(fd, 0)]
        for (const fam of families) {
          if (!fam?.en) continue
          const en = fam.en.trim()
          if (!en) continue
          const key = en.toLowerCase()
          if (COVERED.has(key)) continue
          const label = fam.zh?.trim() || en
          const existing = byKey.get(key)
          if (!existing) byKey.set(key, { value: en, label })
          else if (existing.label === existing.value && label !== existing.value) existing.label = label
        }
      } catch {
        // 无法读取的字体文件直接跳过
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {
            // ignore
          }
        }
      }
    }
  }
  cache = [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return cache
}
