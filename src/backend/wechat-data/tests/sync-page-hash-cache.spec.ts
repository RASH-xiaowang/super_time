import { beforeEach, describe, expect, it } from 'vitest'
import { cacheBudgetSnapshot } from '../src/query/cache-budget.ts'
import { pageHashCacheHandles } from '../src/query/sync-page-hash-cache.ts'

describe('sync-page-hashes：页指纹缓存有界', () => {
  const handles = pageHashCacheHandles()

  beforeEach(() => {
    handles.clear()
  })

  it('超过分片条数上限后淘汰最旧条目', () => {
    for (let i = 0; i < 65; i += 1) {
      handles.putForTest('message_' + String(i) + '.db', {
        sig: 'sig-' + String(i),
        hashes: [Buffer.alloc(32)],
      })
    }

    expect(handles.stats()).toEqual({ count: 64, total: 64 * 32 })
  })

  it('运行时内存快照能看到页指纹缓存的字节预算', () => {
    const row = cacheBudgetSnapshot().find((entry) => entry.label === 'sync-page-hashes')
    expect(row).toMatchObject({
      entries: 0,
      bytes: 0,
      maxEntries: 64,
      maxTotal: 32 * 1024 * 1024,
      maxEntry: 8 * 1024 * 1024,
    })
  })
})
