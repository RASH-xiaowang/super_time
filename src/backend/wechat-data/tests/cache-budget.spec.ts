import { describe, expect, it } from 'vitest'
import { createBoundedCache } from '../src/query/cache-budget.ts'

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
