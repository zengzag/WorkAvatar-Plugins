// 文档存储（插件分库 sqlite）+ 任务工作区工具
//
// 文档内容为 wordcanvas 的 Document 模型 JSON（不透明字符串，主进程不做解析）。
// 注意：SQL 列名沿用 `html`（历史列名，避免无谓的表重建迁移），语义为「文档数据」。

import path from 'path'
import fs from 'fs'
import type { PluginContext, PluginDatabase } from '@workavatar/plugin-sdk'

export interface DocRecord {
  id: string
  title: string
  /** wordcanvas Document 模型 JSON */
  data: string
  /** 导入来源文件（插件 files 目录内留档） */
  sourcePath: string | null
  updatedAt: number
}

export interface SnapshotRecord {
  id: string
  docId: string
  label: string
  data: string
  createdAt: number
}

export interface ChatRecord {
  conversationId: string
  title: string
  updatedAt: number
  workspacePath?: string | null
}

const SETTINGS_KEY = 'word-editor-settings'

class DocStore {
  private db: PluginDatabase | null = null
  private currentDocId: string | null = null

  init(ctx: PluginContext): void {
    this.db = ctx.storage.openSqlite('index')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS we_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        html TEXT NOT NULL,
        source_path TEXT,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS we_snapshots (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        label TEXT NOT NULL,
        html TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS we_chats (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        workspace_path TEXT
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS we_messages (
        conversation_id TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  }

  private requireDb(): PluginDatabase {
    if (!this.db) throw new Error('DocStore 未初始化')
    return this.db
  }

  // ====== 文档 ======

  list(): Array<Omit<DocRecord, 'data'>> {
    const rows = this.requireDb().prepare(
      'SELECT id, title, source_path, updated_at FROM we_documents ORDER BY updated_at DESC'
    ).all() as any[]
    return rows.map((r) => ({
      id: r.id, title: r.title, sourcePath: r.source_path ?? null, updatedAt: r.updated_at,
    }))
  }

  get(id: string): DocRecord | null {
    const row = this.requireDb().prepare(
      'SELECT id, title, html, source_path, updated_at FROM we_documents WHERE id = ?'
    ).get(id) as any
    if (!row) return null
    return {
      id: row.id, title: row.title, data: row.html ?? '',
      sourcePath: row.source_path ?? null, updatedAt: row.updated_at,
    }
  }

  save(id: string, title: string, data: string, sourcePath?: string | null): void {
    this.requireDb().prepare(
      'INSERT INTO we_documents (id, title, html, source_path, updated_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET title = excluded.title, html = excluded.html, ' +
      'source_path = COALESCE(excluded.source_path, source_path), updated_at = excluded.updated_at'
    ).run(id, title, data, sourcePath ?? null, Date.now())
  }

  /** 仅更新正文（AI 工具写回 / 自动保存） */
  saveData(id: string, data: string): void {
    this.requireDb().prepare('UPDATE we_documents SET html = ?, updated_at = ? WHERE id = ?')
      .run(data, Date.now(), id)
  }

  setTitle(id: string, title: string): void {
    this.requireDb().prepare('UPDATE we_documents SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id)
  }

  delete(id: string): void {
    const db = this.requireDb()
    db.prepare('DELETE FROM we_documents WHERE id = ?').run(id)
    db.prepare('DELETE FROM we_snapshots WHERE doc_id = ?').run(id)
  }

  // ====== 快照 ======

  listSnapshots(docId: string): Array<Omit<SnapshotRecord, 'data'>> {
    // 次级按 rowid 排序：同一毫秒内创建的多条快照也能保持稳定的插入顺序
    return (this.requireDb().prepare(
      'SELECT id, doc_id, label, created_at FROM we_snapshots WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100'
    ).all(docId) as any[]).map((r) => ({
      id: r.id, docId: r.doc_id, label: r.label, createdAt: r.created_at,
    }))
  }

  createSnapshot(docId: string, label: string, data: string): void {
    const id = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.requireDb().prepare('INSERT INTO we_snapshots (id, doc_id, label, html, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, docId, label, data, Date.now())
    // 每文档快照上限 50：超出淘汰最旧（rowid 保证同毫秒插入顺序确定）
    this.requireDb().prepare(
      `DELETE FROM we_snapshots WHERE doc_id = ? AND rowid NOT IN (
         SELECT rowid FROM we_snapshots WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50
       )`
    ).run(docId, docId)
  }

  getSnapshot(id: string): SnapshotRecord | null {
    const row = this.requireDb().prepare(
      'SELECT id, doc_id, label, html, created_at FROM we_snapshots WHERE id = ?'
    ).get(id) as any
    if (!row) return null
    return { id: row.id, docId: row.doc_id, label: row.label, data: row.html, createdAt: row.created_at }
  }

  deleteSnapshot(id: string): void {
    this.requireDb().prepare('DELETE FROM we_snapshots WHERE id = ?').run(id)
  }

  // ====== 当前打开的文档 ======

  getCurrentDocId(): string | null {
    return this.currentDocId
  }

  setCurrentDocId(id: string | null): void {
    this.currentDocId = id
  }

  getCurrentDoc(): DocRecord | null {
    return this.currentDocId ? this.get(this.currentDocId) : null
  }

  // ====== 插件设置 ======

  getSettings(): { defaultProviderId?: string; defaultModelId?: string } {
    const row = this.requireDb().prepare('SELECT value FROM plugin_kv WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
    if (!row) return {}
    try {
      return JSON.parse(row.value)
    } catch {
      return {}
    }
  }

  setSettings(settings: Record<string, string | undefined>): void {
    this.requireDb().prepare(
      'INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(SETTINGS_KEY, JSON.stringify(settings ?? {}))
  }

  // ====== 对话记录 ======

  saveChat(chat: ChatRecord): void {
    this.requireDb().prepare(
      'INSERT INTO we_chats (conversation_id, title, updated_at, workspace_path) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(conversation_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, workspace_path = COALESCE(excluded.workspace_path, workspace_path)'
    ).run(chat.conversationId, chat.title, Date.now(), chat.workspacePath ?? null)
  }

  listChats(): ChatRecord[] {
    const rows = this.requireDb().prepare(
      'SELECT conversation_id, title, updated_at, workspace_path FROM we_chats ORDER BY updated_at DESC'
    ).all() as any[]
    return rows.map((r) => ({
      conversationId: r.conversation_id, title: r.title, updatedAt: r.updated_at, workspacePath: r.workspace_path ?? null,
    }))
  }

  getChatWorkspacePath(conversationId: string): string | null {
    const row = this.requireDb().prepare('SELECT workspace_path FROM we_chats WHERE conversation_id = ?')
      .get(conversationId) as { workspace_path: string | null } | undefined
    return row?.workspace_path ?? null
  }

  deleteChat(conversationId: string): void {
    const db = this.requireDb()
    db.prepare('DELETE FROM we_chats WHERE conversation_id = ?').run(conversationId)
    db.prepare('DELETE FROM we_messages WHERE conversation_id = ?').run(conversationId)
  }

  saveMessages(conversationId: string, msgs: unknown[]): void {
    this.requireDb().prepare(
      'INSERT INTO we_messages (conversation_id, messages_json, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(conversation_id) DO UPDATE SET messages_json = excluded.messages_json, updated_at = excluded.updated_at'
    ).run(conversationId, JSON.stringify(msgs), Date.now())
  }

  getMessages(conversationId: string): unknown[] {
    const row = this.requireDb().prepare('SELECT messages_json FROM we_messages WHERE conversation_id = ?')
      .get(conversationId) as { messages_json: string } | undefined
    if (!row) return []
    try {
      const arr = JSON.parse(row.messages_json)
      return Array.isArray(arr) ? arr : []
    } catch {
      return []
    }
  }
}

// ====== 任务工作区目录（与 data-model 同款：<插件数据目录>/tasks/...） ======

export function taskRootDir(ctx: PluginContext): string {
  return path.join(ctx.paths.data, 'tasks')
}

export function createTaskWorkspace(ctx: PluginContext): string {
  const root = taskRootDir(ctx)
  fs.mkdirSync(root, { recursive: true })
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  let dir = path.join(root, base)
  let i = 1
  while (fs.existsSync(dir)) {
    dir = path.join(root, `${base}_${i}`)
    i++
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function isWithinTaskRoot(ctx: PluginContext, p: string): boolean {
  const root = path.resolve(taskRootDir(ctx))
  const target = path.resolve(p)
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 导入来源文件与图片的存放目录 */
export function filesDir(ctx: PluginContext): string {
  const dir = path.join(ctx.paths.data, 'files')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export const docStore = new DocStore()
