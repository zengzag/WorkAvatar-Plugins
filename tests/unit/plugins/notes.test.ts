import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockContext } from '../../helpers/mock-plugin-context'

// mock electron（vitest node 环境无 electron）
vi.mock('electron', () => ({
  app: { getPath: () => '/mock' },
  shell: {
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => {}),
  },
}))

/**
 * notes 插件单测：验证 activate 注册行为 + IPC handler 文件操作。
 * vault 根目录为 mock 的 /mock/data/notes。
 */

async function loadPlugin() {
  vi.resetModules()
  const mod = await import('../../../notes/src/main/index')
  return mod
}

describe('notes 插件 activate', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(() => {
    mock = createMockContext('notes')
  })

  it('注册 20 个 IPC handler', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    const channels = ['list-tree', 'read', 'write', 'create-note', 'create-folder',
      'rename', 'move', 'copy', 'delete', 'search',
      'get-settings', 'set-settings', 'get-abs-path', 'open-in-explorer', 'open-vault',
      'import-external', 'save-image', 'open-diary', 'read-external', 'write-external']
    for (const c of channels) {
      expect(mock.ipc.handlers.has(c)).toBe(true)
    }
    expect(mock.ipc.handlers.size).toBe(20)
  })

  it('注册 save-to-note 消息快捷操作', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(mock.contributions.messageActions.length).toBe(1)
    expect((mock.contributions.messageActions[0] as { id: string }).id).toBe('save-to-note')
  })

  it('deactivate 不抛错', async () => {
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
    expect(() => mod.deactivate()).not.toThrow()
  })
})

describe('notes 插件 IPC handler', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('notes')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-note 创建笔记', async () => {
    const handler = mock.ipc.handlers.get('create-note')!
    const res = await handler({ parentRelPath: '', name: '测试笔记' }) as { relPath?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.relPath).toBeTruthy()
  })

  it('write + read 写入并读取笔记', async () => {
    const create = mock.ipc.handlers.get('create-note')!
    const created = await create({ parentRelPath: '', name: '内容笔记' }) as { relPath: string }
    const write = mock.ipc.handlers.get('write')!
    await write({ relPath: created.relPath, content: 'hello world' })
    const read = mock.ipc.handlers.get('read')!
    const res = await read(created.relPath) as { content?: string; error?: string }
    expect(res.content).toBe('hello world')
  })

  it('list-tree 返回笔记树', async () => {
    const create = mock.ipc.handlers.get('create-note')!
    await create({ parentRelPath: '', name: '树笔记' })
    const list = mock.ipc.handlers.get('list-tree')!
    const res = await list() as unknown[]
    expect(res.length).toBeGreaterThan(0)
  })

  it('get-settings 返回默认设置', async () => {
    const handler = mock.ipc.handlers.get('get-settings')!
    const res = await handler() as { editor_mode?: string }
    expect(res.editor_mode).toBe('edit')
  })

  it('set-settings 更新设置', async () => {
    const set = mock.ipc.handlers.get('set-settings')!
    await set({ editor_mode: 'preview' })
    const get = mock.ipc.handlers.get('get-settings')!
    const res = await get() as { editor_mode?: string }
    expect(res.editor_mode).toBe('preview')
  })

  it('delete 删除笔记', async () => {
    const create = mock.ipc.handlers.get('create-note')!
    const created = await create({ parentRelPath: '', name: '待删笔记' }) as { relPath: string }
    const del = mock.ipc.handlers.get('delete')!
    const res = await del(created.relPath) as { success?: boolean; error?: string }
    expect(res.error).toBeUndefined()
  })
})

describe('notes 插件 IPC 边界 case', () => {
  let mock: ReturnType<typeof createMockContext>

  beforeEach(async () => {
    mock = createMockContext('notes')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('create-note 缺 name 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-note')!
    const res = await handler({ parentRelPath: '' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('read 缺 relPath 拒绝', async () => {
    const handler = mock.ipc.handlers.get('read')!
    const res = await handler('') as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('read 不存在的笔记抛错', async () => {
    const handler = mock.ipc.handlers.get('read')!
    expect(() => handler('nonexistent.md')).toThrow()
  })

  it('write 缺 relPath 拒绝', async () => {
    const handler = mock.ipc.handlers.get('write')!
    const res = await handler({ content: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('write 缺 content 拒绝', async () => {
    const handler = mock.ipc.handlers.get('write')!
    const res = await handler({ relPath: 'a.md' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('rename 缺 relPath 拒绝', async () => {
    const handler = mock.ipc.handlers.get('rename')!
    const res = await handler({ newName: 'x' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('rename 缺 newName 拒绝', async () => {
    const handler = mock.ipc.handlers.get('rename')!
    const res = await handler({ relPath: 'a.md' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('rename 重命名笔记', async () => {
    const create = mock.ipc.handlers.get('create-note')!
    const created = await create({ parentRelPath: '', name: '原名' }) as { relPath: string }
    const rename = mock.ipc.handlers.get('rename')!
    const newName = `新名${Date.now()}`
    const res = await rename({ relPath: created.relPath, newName }) as { relPath?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.relPath).toContain(newName)
  })

  it('move 缺 srcRelPath 拒绝', async () => {
    const handler = mock.ipc.handlers.get('move')!
    const res = await handler({ destParentRelPath: '' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('search 缺 query 返回空数组', async () => {
    const handler = mock.ipc.handlers.get('search')!
    const res = await handler({}) as unknown[]
    expect(res).toEqual([])
  })

  it('search 返回匹配结果', async () => {
    const create = mock.ipc.handlers.get('create-note')!
    const created = await create({ parentRelPath: '', name: '搜索测试' }) as { relPath: string }
    const write = mock.ipc.handlers.get('write')!
    await write({ relPath: created.relPath, content: '包含关键词的内容' })
    const search = mock.ipc.handlers.get('search')!
    const res = await search({ query: '关键词' }) as Array<{ relPath: string }>
    expect(res.length).toBeGreaterThan(0)
  })

  it('get-abs-path 缺 relPath 拒绝', async () => {
    const handler = mock.ipc.handlers.get('get-abs-path')!
    const res = await handler('') as { error?: string }
    expect(res.error).toBeTruthy()
  })

  it('create-folder 创建文件夹', async () => {
    const handler = mock.ipc.handlers.get('create-folder')!
    const res = await handler({ parentRelPath: '', name: '新文件夹' }) as { relPath?: string; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.relPath).toBeTruthy()
  })

  it('create-folder 缺 name 拒绝', async () => {
    const handler = mock.ipc.handlers.get('create-folder')!
    const res = await handler({ parentRelPath: '' }) as { error?: string }
    expect(res.error).toBeTruthy()
  })
})

describe('notes 插件 rename/move 路径映射（文件夹 Tab 迁移）', () => {
  let mock: ReturnType<typeof createMockContext>
  // vault 为共享临时目录，名称加时间戳避免历史残留干扰
  const uniq = () => `${Date.now()}_${Math.floor(Math.random() * 1e6)}`

  beforeEach(async () => {
    mock = createMockContext('notes')
    const mod = await loadPlugin()
    mod.activate(mock.ctx)
  })

  it('rename 文件返回 moved 映射（from=旧路径, to=新路径）', async () => {
    const create = mock.ipc.handlers.get('create-note')!
    const created = await create({ parentRelPath: '', name: `映射笔记${uniq()}` }) as { relPath: string }
    const rename = mock.ipc.handlers.get('rename')!
    const res = await rename({ relPath: created.relPath, newName: `映射改名${uniq()}` }) as { relPath?: string; moved?: { from: string; to: string }; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.moved).toBeTruthy()
    expect(res.moved!.from).toBe(created.relPath)
    expect(res.moved!.to).toBe(res.relPath)
    // 新路径可读
    const read = mock.ipc.handlers.get('read')!
    const content = await read(res.relPath) as { error?: string }
    expect(content.error).toBeUndefined()
  })

  it('rename 文件夹后子文件路径整体迁移，旧路径失效', async () => {
    const createFolder = mock.ipc.handlers.get('create-folder')!
    const folder = await createFolder({ parentRelPath: '', name: `映射目录${uniq()}` }) as { relPath: string }
    const createNote = mock.ipc.handlers.get('create-note')!
    const child = await createNote({ parentRelPath: folder.relPath, name: `子笔记${uniq()}` }) as { relPath: string }
    const childName = child.relPath.slice(child.relPath.lastIndexOf('/') + 1)

    const rename = mock.ipc.handlers.get('rename')!
    const res = await rename({ relPath: folder.relPath, newName: `映射目录改名${uniq()}` }) as { relPath?: string; moved?: { from: string; to: string }; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.moved!.from).toBe(folder.relPath)
    expect(res.moved!.to).toBe(res.relPath)

    // 渲染端按前缀迁移后的路径应真实存在
    const newChildRel = `${res.relPath}/${childName}`
    const read = mock.ipc.handlers.get('read')!
    const content = await read(newChildRel) as { error?: string }
    expect(content.error).toBeUndefined()
    // 旧路径已不存在
    expect(() => read(child.relPath)).toThrow()
  })

  it('move 文件夹返回前缀映射', async () => {
    const createFolder = mock.ipc.handlers.get('create-folder')!
    const src = await createFolder({ parentRelPath: '', name: `移动源目录${uniq()}` }) as { relPath: string }
    const dest = await createFolder({ parentRelPath: '', name: `移动目标目录${uniq()}` }) as { relPath: string }
    const createNote = mock.ipc.handlers.get('create-note')!
    const child = await createNote({ parentRelPath: src.relPath, name: `移动子笔记${uniq()}` }) as { relPath: string }
    const childName = child.relPath.slice(child.relPath.lastIndexOf('/') + 1)

    const move = mock.ipc.handlers.get('move')!
    const res = await move({ srcRelPath: src.relPath, destParentRelPath: dest.relPath }) as { relPath?: string; moved?: { from: string; to: string }; error?: string }
    expect(res.error).toBeUndefined()
    expect(res.moved!.from).toBe(src.relPath)
    expect(res.moved!.to).toBe(res.relPath)

    const read = mock.ipc.handlers.get('read')!
    const content = await read(`${res.relPath}/${childName}`) as { error?: string }
    expect(content.error).toBeUndefined()
  })
})

describe('notes 渲染端 migrateNoteRelPath（前缀迁移纯函数）', () => {
  it('精确匹配 → 新路径', async () => {
    const { migrateNoteRelPath } = await import('../../../notes/src/renderer/types')
    expect(migrateNoteRelPath('foo', 'foo', 'bar')).toBe('bar')
  })

  it('子路径前缀 → 新前缀 + 剩余路径', async () => {
    const { migrateNoteRelPath } = await import('../../../notes/src/renderer/types')
    expect(migrateNoteRelPath('foo/a/b.md', 'foo', 'bar')).toBe('bar/a/b.md')
  })

  it("'foo' 前缀不会误命中 'foobar/...'", async () => {
    const { migrateNoteRelPath } = await import('../../../notes/src/renderer/types')
    expect(migrateNoteRelPath('foobar/x.md', 'foo', 'bar')).toBe('foobar/x.md')
  })

  it('不匹配 / 空值 / from==to 时原样返回', async () => {
    const { migrateNoteRelPath } = await import('../../../notes/src/renderer/types')
    expect(migrateNoteRelPath('other.md', 'foo', 'bar')).toBe('other.md')
    expect(migrateNoteRelPath(null, 'foo', 'bar')).toBeNull()
    expect(migrateNoteRelPath('foo/x.md', 'foo', 'foo')).toBe('foo/x.md')
  })
})
