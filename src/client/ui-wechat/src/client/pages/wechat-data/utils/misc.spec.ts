/**
 * `capRecord` 的边界（H11 第五档补的账）。
 *
 * 为什么值得单独一条：它的实现本轮被改写过（`rec[k]` 在 `noUncheckedIndexedAccess` 下是
 * `V | undefined`，改成走 `Object.entries`），而它管的是**内存上界**——单条视频 data URL 可达数 MB，
 * 淘汰逻辑一旦失效就是「播放过的视频数量线性增长」那种要在真机上才看得出来的事故。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { capRecord } from './misc.ts'

describe('capRecord：有界记录缓存', () => {
  it('未超限时原对象照返（不复制、不换身份）', () => {
    const rec = { a: 1, b: 2 }
    expect(capRecord(rec, 2)).toBe(rec)
    expect(capRecord(rec, 99)).toBe(rec)
  })

  it('超限后只留最后 max 个键，且保持原有顺序', () => {
    const rec: Record<string, number> = {}
    for (let i = 0; i < 10; i += 1) rec['k' + i] = i
    const out = capRecord(rec, 4)
    expect(Object.keys(out)).toEqual(['k6', 'k7', 'k8', 'k9'])
    expect(Object.values(out)).toEqual([6, 7, 8, 9])
  })

  it('值原样带过去，不做任何拷贝或转换（对象值同身份）', () => {
    const big = { blob: 'data:video/mp4;base64,AAAA', bytes: 4096 }
    const rec: Record<string, unknown> = { old: { blob: 'x' }, keep: big }
    const out = capRecord(rec, 1)
    expect(Object.keys(out)).toEqual(['keep'])
    expect(out.keep).toBe(big)
  })

  it('max 为 0 或负数 ⇒ 清空（与改前一致：slice(len) 得空集）', () => {
    const rec = { a: 1, b: 2, c: 3 }
    expect(capRecord(rec, 0)).toEqual({})
    expect(capRecord(rec, -2)).toEqual({})
  })

  it('空记录直接返回原对象，不会因 max=0 而变成新对象', () => {
    const rec: Record<string, number> = {}
    expect(capRecord(rec, 0)).toBe(rec)
    expect(capRecord(rec, 3)).toBe(rec)
  })

  it('数字形态的键按 JS 的规则排在前面（这不是缺陷，记下来免得被当成回归）', () => {
    // Object.keys 对「像数组下标」的键一律按数值升序排在前，插入顺序只对非数字键成立。
    // 调用方喂的是媒体 key（md5 / `username:local_id` 这类），不会踩到；这里钉住的是**行为**本身。
    const rec: Record<string, number> = { b: 1, '2': 2, a: 3, '1': 4 }
    expect(Object.keys(capRecord(rec, 2))).toEqual(['b', 'a'])
  })
})
