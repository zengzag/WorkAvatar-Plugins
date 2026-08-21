import { describe, it, expect } from 'vitest'
import { alignPositions, distributePositions, type PositionedItem } from '../../../data-model/src/renderer/canvas/arrange'

function items(...pts: Array<[number, number]>): PositionedItem[] {
  return pts.map(([x, y], i) => ({ id: `n${i}`, x, y }))
}

describe('data-model 画布对齐/分布', () => {
  it('左对齐：所有节点 x 取最小值', () => {
    const result = alignPositions(items([100, 50], [200, 80], [150, 20]), 'left')
    expect(result.every((i) => i.x === 100)).toBe(true)
    expect(result.map((i) => i.y)).toEqual([50, 80, 20])
  })

  it('右对齐：所有节点 x 取最大值', () => {
    const result = alignPositions(items([100, 50], [200, 80], [150, 20]), 'right')
    expect(result.every((i) => i.x === 200)).toBe(true)
  })

  it('水平居中：所有节点 x 取包围盒中点', () => {
    const result = alignPositions(items([100, 50], [200, 80]), 'centerH')
    expect(result.every((i) => i.x === 150)).toBe(true)
  })

  it('顶对齐：所有节点 y 取最小值', () => {
    const result = alignPositions(items([100, 50], [200, 80], [150, 20]), 'top')
    expect(result.every((i) => i.y === 20)).toBe(true)
  })

  it('底对齐：所有节点 y 取最大值', () => {
    const result = alignPositions(items([100, 50], [200, 80], [150, 20]), 'bottom')
    expect(result.every((i) => i.y === 80)).toBe(true)
  })

  it('垂直居中：所有节点 y 取包围盒中点', () => {
    const result = alignPositions(items([100, 50], [200, 80]), 'centerV')
    expect(result.every((i) => i.y === 65)).toBe(true)
  })

  it('少于 2 个节点不执行对齐', () => {
    const single = items([100, 50])
    expect(alignPositions(single, 'left')).toEqual(single)
  })

  it('水平分布：保持首尾不动，中间等距', () => {
    const result = distributePositions(items([0, 0], [100, 0], [300, 0]), 'horizontal')
    expect(result.find((i) => i.x === 0)!.x).toBe(0)
    expect(result.find((i) => i.x === 300)!.x).toBe(300)
    const xs = result.map((i) => i.x).sort((a, b) => a - b)
    expect(xs[1]).toBe(150)
  })

  it('垂直分布：按 y 排序等距', () => {
    const result = distributePositions(items([0, 0], [0, 100], [0, 400]), 'vertical')
    const ys = result.map((i) => i.y).sort((a, b) => a - b)
    expect(ys[0]).toBe(0)
    expect(ys[2]).toBe(400)
    expect(ys[1]).toBe(200)
  })

  it('少于 3 个节点不执行分布', () => {
    const two = items([0, 0], [100, 0])
    expect(distributePositions(two, 'horizontal')).toEqual(two)
  })
})