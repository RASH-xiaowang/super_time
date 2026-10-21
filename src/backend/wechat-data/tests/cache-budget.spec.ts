import { describe, expect, it } from 'vitest'
import { cacheBudgetSnapshot, createBoundedCache, resetCacheBudgetRegistryForTest } from '../src/query/cache-budget.ts'

describe('createBoundedCache：容量与 LRU', () => {
  it('get 命中后把键移到队尾，后续按队头淘汰', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 2,
      maxTotal: 100,
      sizeOf: (value) => value,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)

    expect(cache.get('b')).toBeUndefined()
    expect([...cache.keys()]).toEqual(['a', 'c'])
  })

  it('超过条数上限时逐出队头', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 2,
      maxTotal: 100,
      sizeOf: (value) => value,
    })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    expect(cache.size()).toBe(2)
    expect([...cache.keys()]).toEqual(['b', 'c'])
  })

  it('超过总大小上限时逐出队头，直到总额达标', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 10,
      maxTotal: 10,
      sizeOf: (value) => value,
    })
    cache.set('a', 4)
    cache.set('b', 6)
    cache.set('c', 3)

    expect(cache.total()).toBe(9)
    expect([...cache.keys()]).toEqual(['b', 'c'])
  })

  it('单条超过 maxEntry 时静默跳过，不增加条数或总额', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 10,
      maxTotal: 100,
      maxEntry: 5,
      sizeOf: (value) => value,
    })
    cache.set('big', 6)

    expect(cache.size()).toBe(0)
    expect(cache.total()).toBe(0)
    expect(cache.get('big')).toBeUndefined()
  })

  it('同键覆盖先扣旧值，再按新值计费并移到队尾', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 2,
      maxTotal: 10,
      sizeOf: (value) => value,
    })
    cache.set('a', 3)
    cache.set('b', 4)
    cache.set('a', 5)

    expect(cache.total()).toBe(9)
    expect([...cache.keys()]).toEqual(['b', 'a'])
  })

  it('delete 同时减少条数与总额', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 3,
      maxTotal: 20,
      sizeOf: (value) => value,
    })
    cache.set('a', 4)
    cache.set('b', 6)

    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)
    expect(cache.size()).toBe(1)
    expect(cache.total()).toBe(6)
  })

  it('clear 清零条数与总额', () => {
    const cache = createBoundedCache<string, number>({
      maxEntries: 3,
      maxTotal: 20,
      sizeOf: (value) => value,
    })
    cache.set('a', 4)
    cache.set('b', 6)
    cache.clear()

    expect(cache.size()).toBe(0)
    expect(cache.total()).toBe(0)
    expect([...cache.keys()]).toEqual([])
  })
})

/**
 * 运行时占用注册表（2026-10-21 内存基线）。
 *
 * 判据：带 label 的缓存要能在运行时被看见（当前条数/字节 + 上限）。
 * 否则「有界缓存真的在界内」只能停留在单测断言里 —— 线上 RSS 高时无法判断来源，
 * 也就没法回答「优化到底让运行时内存降了多少」。
 */
describe('cacheBudgetSnapshot：受控缓存的运行时占用', () => {
  it('带 label 的缓存出现在快照里，并带上上限', () => {
    resetCacheBudgetRegistryForTest()
    const cache = createBoundedCache<string, number>({ label: 'unit-cache', maxEntries: 2, maxTotal: 10, sizeOf: (v) => v })
    cache.set('a', 3)
    cache.set('b', 4)
    const row = cacheBudgetSnapshot().find((r) => r.label === 'unit-cache')
    expect(row).toMatchObject({ entries: 2, bytes: 7, maxEntries: 2, maxTotal: 10 })
    resetCacheBudgetRegistryForTest()
  })

  it('快照跟着淘汰/清空变化（不是只增不减的计数器）', () => {
    resetCacheBudgetRegistryForTest()
    const cache = createBoundedCache<string, number>({ label: 'unit-evict', maxEntries: 2, maxTotal: 100, sizeOf: (v) => v })
    cache.set('a', 5)
    cache.set('b', 6)
    cache.set('c', 7)
    expect(cacheBudgetSnapshot().find((r) => r.label === 'unit-evict')).toMatchObject({ entries: 2, bytes: 13 })
    cache.clear()
    expect(cacheBudgetSnapshot().find((r) => r.label === 'unit-evict')).toMatchObject({ entries: 0, bytes: 0 })
    resetCacheBudgetRegistryForTest()
  })

  it('没给 label 的缓存不出现（不污染运行时观测）', () => {
    resetCacheBudgetRegistryForTest()
    const cache = createBoundedCache<string, number>({ maxEntries: 2, maxTotal: 10, sizeOf: (v) => v })
    cache.set('a', 1)
    expect(cacheBudgetSnapshot()).toEqual([])
    resetCacheBudgetRegistryForTest()
  })

  it('同一 label 重复创建只出一行（模块重载/测试之间不会重复累计）', () => {
    resetCacheBudgetRegistryForTest()
    const a = createBoundedCache<string, number>({ label: 'unit-dup', maxEntries: 2, maxTotal: 10, sizeOf: (v) => v })
    a.set('x', 2)
    const b = createBoundedCache<string, number>({ label: 'unit-dup', maxEntries: 5, maxTotal: 20, sizeOf: (v) => v })
    b.set('y', 3)
    const rows = cacheBudgetSnapshot().filter((r) => r.label === 'unit-dup')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entries: 1, bytes: 3, maxEntries: 5, maxTotal: 20 })
    resetCacheBudgetRegistryForTest()
  })
})
