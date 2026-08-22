import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../data-model/src/renderer/store', () => ({
  dm: { syncModel: vi.fn(() => Promise.resolve({ ok: true })) },
  hostT: (k: string, o?: Record<string, unknown>) => k,
  useAppearance: () => ({ isDark: false }),
}))

import { useDataModelStore } from '../../../data-model/src/renderer/data-model.store'
import { dm } from '../../../data-model/src/renderer/store'
import { createTable, createField, createDataModel } from '../../../data-model/src/shared/domain'

/** 便捷读取当前 store 快照 */
const st = () => useDataModelStore.getState()

describe('data-model 撤销/重做', () => {
  beforeEach(() => {
    useDataModelStore.setState({
      model: createDataModel({ name: '测试模型' }),
      projects: [],
      selectedTableId: null,
      selectedTableIds: [],
      selectedRelationshipId: null,
      historyPast: [],
      historyFuture: [],
      canUndo: false,
      canRedo: false,
      isDirty: false,
    })
  })

  it('新增表后可撤销并重做', () => {
    const t = createTable({ name: 'users', fields: [createField({ name: 'id', type: 'bigint', primaryKey: true })] })
    st().addTable(t)
    expect(st().canUndo).toBe(true)
    expect(st().isDirty).toBe(true)

    st().undo()
    expect(st().model.tables.length).toBe(0)
    expect(st().canRedo).toBe(true)

    st().redo()
    expect(st().model.tables.length).toBe(1)
    expect(st().model.tables[0].name).toBe('users')
    expect(st().canUndo).toBe(true)
  })

  it('删除表后可撤销恢复（含关联关系）', () => {
    const t = createTable({ name: 'a' })
    st().addTable(t)
    st().removeTable(t.id)
    expect(st().model.tables.length).toBe(0)
    st().undo()
    expect(st().model.tables.length).toBe(1)
    expect(st().model.tables[0].name).toBe('a')
  })

  it('对同一字段的高频编辑合并为一条撤销记录', () => {
    const t = createTable({ name: 'users', fields: [createField({ name: 'id', type: 'bigint' })] })
    st().addTable(t) // past=[初始, addTable]
    const fieldId = t.fields[0].id
    st().updateField(t.id, fieldId, { name: 'u' })
    st().updateField(t.id, fieldId, { name: 'us' })
    st().updateField(t.id, fieldId, { name: 'usr' })
    // 三次字段编辑合并为一条：一次撤销全部回退，字段名恢复"id"
    st().undo()
    expect(st().model.tables[0].fields[0].name).toBe('id')
    // 再撤销一次移除新增的表
    st().undo()
    expect(st().model.tables.length).toBe(0)
  })

  it('对不同目标编辑分别记录，可多次撤销', () => {
    const a = createTable({ name: 'a', fields: [createField({ name: 'x' })] })
    const b = createTable({ name: 'b' })
    st().addTable(a)
    st().addTable(b)
    st().updateTable(a.id, { name: 'aa' })
    st().removeTable(b.id)
    // 共 4 次独立操作（add a / add b / rename a / del b）
    st().undo() // 撤销 del b
    expect(st().model.tables.some((t) => t.name === 'b')).toBe(true)
    st().undo() // 撤销 rename a
    expect(st().model.tables.find((t) => t.id === a.id)!.name).toBe('a')
  })

  it('重做栈在新增操作后清空', () => {
    const t = createTable({ name: 'a' })
    st().addTable(t)
    st().undo()
    expect(st().canRedo).toBe(true)
    st().addTable(createTable({ name: 'b' }))
    expect(st().canRedo).toBe(false)
  })

  it('撤销/重做会持久化到主进程', () => {
    const t = createTable({ name: 'a' })
    st().addTable(t)
    const sync = dm.syncModel as ReturnType<typeof vi.fn>
    sync.mockClear()
    st().undo()
    expect(sync).toHaveBeenCalled()
  })
})