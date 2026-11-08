// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { trimMediaCache } from './media-cache.ts'

interface FakeEntry {
  key: string
  at: number
  size: number
}

/**
 * 只实现 `trimMediaCache` 用到的 IndexedDB 面。
 * 游标逐条回调，`getAll` 若被调用会记进 calls，防止实现退回一次性物化整个桶。
 */
function fakeDb(initial: FakeEntry[]): { db: IDBDatabase; entries: FakeEntry[]; calls: string[] } {
  const entries = [...initial].sort((a, b) => a.at - b.at)
  const calls: string[] = []
  const makeCursor = (tx: Record<string, unknown>, done: () => void) => {
    let index = 0
    const request: Record<string, unknown> = { result: null }
    const advance = (): void => {
      queueMicrotask(() => {
        const entry = entries[index]
        if (!entry) {
          request.result = null
          done()
          return
        }
        let continued = false
        const cursor = {
          value: { url: '', at: entry.at, size: entry.size },
          continue: () => {
            continued = true
            const next = entries.findIndex((item) => item.at > entry.at)
            index = next < 0 ? entries.length : next
            advance()
          },
          delete: () => {
            calls.push(`delete:${entry.key}`)
            const at = entries.findIndex((item) => item.key === entry.key)
            if (at >= 0) entries.splice(at, 1)
          },
        }
        request.result = cursor
        ;(request.onsuccess as (() => void) | undefined)?.()
        queueMicrotask(() => { if (!continued) done() })
      })
    }
    advance()
    return request
  }
  const db = {
    transaction(_name: string, _mode: IDBTransactionMode) {
      const tx: Record<string, unknown> = {}
      const store = {
        index(name: string) {
          calls.push(`index:${name}`)
          return {
            openCursor() {
              calls.push('openCursor')
              return makeCursor(tx, () => {
                ;(tx.oncomplete as (() => void) | undefined)?.()
              })
            },
          }
        },
        getAll() {
          calls.push('getAll')
          throw new Error('trimMediaCache must not materialize the whole store')
        },
        getAllKeys() {
          calls.push('getAllKeys')
          throw new Error('trimMediaCache must not materialize all keys')
        },
      }
      tx.objectStore = () => store
      return tx
    },
  }
  return { db: db as unknown as IDBDatabase, entries, calls }
}

describe('IndexedDB 媒体缓存裁剪', () => {
  it('超过预算时按 by_at 游标逐条删除最旧记录，不调用 getAll', async () => {
    const mb = 1024 * 1024
    const fixture = fakeDb([
      { key: 'oldest', at: 1, size: 200 * mb },
      { key: 'middle', at: 2, size: 200 * mb },
      { key: 'newest', at: 3, size: 200 * mb },
    ])

    await trimMediaCache(fixture.db)

    expect(fixture.calls).not.toContain('getAll')
    expect(fixture.calls).not.toContain('getAllKeys')
    expect(fixture.entries.map((entry) => entry.key)).toEqual(['middle', 'newest'])
  })
})
