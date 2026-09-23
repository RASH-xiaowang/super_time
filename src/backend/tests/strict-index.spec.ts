/**
 * `helpers/strict-index.ts` 的自检 —— 这两个访问器是别的用例的**前提守卫**，
 * 它们自己不成立的时候必须失败，否则整条链就退化成「读到一个 undefined 然后往下走」。
 * 所以这里断言的不是返回值，而是**越界/缺组时确实抛、且报的是原因**。
 */
import { describe, expect, it } from 'vitest'

import { at, grp } from './helpers/strict-index.ts'

/** @source-ref src/backend/tests/helpers/strict-index.ts:31-36 */
describe('at()', () => {
  it('范围内返回元素本身', () => {
    expect(at(['a', 'b'], 1)).toBe('b')
  })

  it('越界时报的是「前提不成立」，不是 undefined 的下游异常', () => {
    expect(() => at(['a'], 1)).toThrow(/只有 1 个元素/)
    expect(() => at(['a'], 1)).toThrow(/前提不成立/)
    expect(() => at<number>([], 0)).toThrow(/只有 0 个元素/)
    expect(() => at(['a'], -1)).toThrow(/只有 1 个元素/)
  })

  it('错误消息里带上是谁的数组（不然 20 个用例共用一句「只有 1 个」查不动）', () => {
    expect(() => at(['x'], 3, '请求')).toThrow(/请求：只有 1 个元素，取不到第 4 个/)
  })

  it('元素可以是 undefined/0/false —— 只要下标在范围内就不该抛', () => {
    // 这条是**故意**反直觉的：`xs[n] as T` 不能用「值是否为真」来判断有没有。
    expect(at([undefined], 0)).toBeUndefined()
    expect(at([0], 0)).toBe(0)
    expect(at([false], 0)).toBe(false)
  })
})

/** @source-ref src/backend/tests/helpers/strict-index.ts:46-52 */
describe('grp()', () => {
  it('取到捕获组', () => {
    const m = /a(b)c/.exec('abc')
    expect(m).not.toBeNull()
    expect(grp(m as RegExpMatchArray, 1)).toBe('b')
  })

  it('正则没有那个组时直说，而不是交出一个 undefined', () => {
    const m = /(?<x>a)/.exec('a')
    expect(m).not.toBeNull()
    expect(() => grp(m as RegExpMatchArray, 7, '导航事件清单')).toThrow(/导航事件清单 没有第 7 个捕获组/)
  })

  it('捕获组匹配到空串也算成立（空串是合法结果，不是缺组）', () => {
    const m = /().*/.exec('abc')
    expect(m).not.toBeNull()
    expect(grp(m as RegExpMatchArray, 1)).toBe('')
  })
})
