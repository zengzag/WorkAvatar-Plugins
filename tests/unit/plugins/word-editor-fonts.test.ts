import { describe, it, expect } from 'vitest'
import { extractNames } from '../../../word-editor/src/main/system-fonts'

/**
 * word-editor 系统字体枚举单测：
 * name 表记录（platform/encoding/language/nameId/length/offset）→ 英文与中文族名。
 * 英文优先 Windows en-US 的 Preferred Family(16)，中文取简体 (0x0804)。
 */

interface NameEntry {
  platform: number
  encoding: number
  language: number
  nameId: number
  text: string
  latin1?: boolean
}

function buildNameTable(entries: NameEntry[]): Buffer {
  const strings: Buffer[] = []
  const recs: Buffer[] = []
  let cursor = 0
  for (const e of entries) {
    const bytes = e.latin1 ? Buffer.from(e.text, 'latin1') : Buffer.from(e.text, 'utf16le').swap16()
    strings.push(bytes)
    const rec = Buffer.alloc(12)
    rec.writeUInt16BE(e.platform, 0)
    rec.writeUInt16BE(e.encoding, 2)
    rec.writeUInt16BE(e.language, 4)
    rec.writeUInt16BE(e.nameId, 6)
    rec.writeUInt16BE(bytes.length, 8)
    rec.writeUInt16BE(cursor, 10)
    cursor += bytes.length
    recs.push(rec)
  }
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0) // format
  head.writeUInt16BE(entries.length, 2)
  head.writeUInt16BE(6 + entries.length * 12, 4) // stringOffset
  return Buffer.concat([head, ...recs, ...strings])
}

describe('extractNames', () => {
  it('Windows 双语记录：英文取 Preferred Family(16)，中文取 0x0804', () => {
    const table = buildNameTable([
      { platform: 3, encoding: 1, language: 0x804, nameId: 1, text: '微软雅黑' },
      { platform: 3, encoding: 1, language: 0x409, nameId: 1, text: 'Microsoft YaHei' },
      { platform: 3, encoding: 1, language: 0x409, nameId: 16, text: 'Microsoft YaHei' },
      { platform: 3, encoding: 1, language: 0x804, nameId: 16, text: '微软雅黑' },
    ])
    expect(extractNames(table)).toEqual({ en: 'Microsoft YaHei', zh: '微软雅黑' })
  })

  it('仅有 Mac Roman 记录时按 latin1 兜底解析，无中文返回 null', () => {
    const table = buildNameTable([
      { platform: 1, encoding: 0, language: 0, nameId: 1, text: 'STKaiti', latin1: true },
    ])
    expect(extractNames(table)).toEqual({ en: 'STKaiti', zh: null })
  })

  it('中英文同名时 zh 归一为 null', () => {
    const table = buildNameTable([
      { platform: 3, encoding: 1, language: 0x409, nameId: 1, text: 'SimSun' },
      { platform: 3, encoding: 1, language: 0x804, nameId: 1, text: 'SimSun' },
    ])
    expect(extractNames(table)).toEqual({ en: 'SimSun', zh: null })
  })

  it('纯中文名的 UTF-16BE 字节恰落在可打印 ASCII 区间时仍按 UTF-16 解码（楷体）', () => {
    // 楷体 = U+6977 U+4F53 → 字节 69 77 4F 53，全部落在可打印 ASCII 区间
    const table = buildNameTable([
      { platform: 3, encoding: 1, language: 0x409, nameId: 1, text: 'KaiTi' },
      { platform: 3, encoding: 1, language: 0x804, nameId: 1, text: '楷体' },
    ])
    expect(extractNames(table)).toEqual({ en: 'KaiTi', zh: '楷体' })
  })

  it('单字节 ASCII 被误存为 UTF-16 的损坏记录（解出罕见符号）被丢弃', () => {
    // ASCII "uc,x" 按单字节存储 → 按 UTF-16BE 解出含 U+2000-U+2BFF 区段符号的乱码
    const garbage = Buffer.from([0x75, 0x63, 0x2c, 0x20, 0x78]) // "uc, x"
    const strOffset = 6 + 12
    const rec = Buffer.alloc(12)
    rec.writeUInt16BE(3, 0)
    rec.writeUInt16BE(1, 2)
    rec.writeUInt16BE(0x409, 4)
    rec.writeUInt16BE(1, 6)
    rec.writeUInt16BE(garbage.length, 8)
    rec.writeUInt16BE(0, 10)
    const head = Buffer.alloc(6)
    head.writeUInt16BE(0, 0)
    head.writeUInt16BE(1, 2)
    head.writeUInt16BE(strOffset, 4)
    const table = Buffer.concat([head, rec, garbage])
    expect(extractNames(table)).toEqual({ en: null, zh: null })
  })

  it('损坏的表（长度不足 / 字符串越界）返回空结果而不抛错', () => {
    expect(extractNames(Buffer.alloc(3))).toEqual({ en: null, zh: null })
    // count 声明 2 条记录但只有 1 条的空间 → 截断处理
    const table = buildNameTable([
      { platform: 3, encoding: 1, language: 0x409, nameId: 1, text: 'Fake' },
    ])
    table.writeUInt16BE(2, 2)
    expect(extractNames(table).en).toBe('Fake')
    // 字符串偏移越界被丢弃
    const bad = buildNameTable([
      { platform: 3, encoding: 1, language: 0x409, nameId: 1, text: 'Fake' },
    ])
    bad.writeUInt16BE(0xff00, 4)
    expect(extractNames(bad)).toEqual({ en: null, zh: null })
  })
})
