// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { trimMediaCache } from './media-cache.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'media-cache.ts'), 'utf8')

interface FakeEntry {
  key: string
  at: number
  size: number
}

/**
 * 只实现缓存写回/读取要用的 IndexedDB 面。
 *
 * 重点是可观察：`open` 的版本号、`clear` 是否发生、缩略图写入前后的记录值。
 */
function fakeIndexedDb(): {
  factory: IDBFactory
  data: Map<string, unknown>
  versions: number[]
  cleared: () => boolean
} {
  const data = new Map<string, unknown>()
  const versions: number[] = []
  let clearCount = 0

  const makeTx = (): Record<string, any> => {
    const tx: Record<string, any> = {}
    const finish = (): void => { queueMicrotask(() => tx.oncomplete?.()) }
    const store: Record<string, any> = {
      get(key: string) {
        const req: Record<string, any> = { result: undefined }
        queueMicrotask(() => {
          req.result = data.get(key)
          req.onsuccess?.()
          finish()
        })
        return req
      },
      put(value: unknown, key: string) {
        data.set(key, value)
        finish()
      },
      clear() {
        clearCount += 1
        data.clear()
        finish()
      },
      index() {
        return {
          openCursor() {
            const req: Record<string, any> = { result: null }
            queueMicrotask(() => {
              req.onsuccess?.()
              finish()
            })
            return req
          },
        }
      },
    }
    tx.objectStore = () => store
    return tx
  }

  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore: () => ({ createIndex: () => ({}) }),
    transaction: () => makeTx(),
  }
  const factory = {
    open(_name: string, version: number) {
      versions.push(version)
      const req: Record<string, any> = { result: db }
      queueMicrotask(() => {
        req.onupgradeneeded?.({ oldVersion: 0 })
        req.onsuccess?.()
      })
      return req
    },
  }
  return {
    factory: factory as unknown as IDBFactory,
    data,
    versions,
    cleared: () => clearCount > 0,
  }
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

describe('IndexedDB 媒体缓存版本与缩略图写回', () => {
  it('库版本与条目语义版本都升到 3，跨版本升级清库', () => {
    expect(SOURCE).toMatch(/const MEDIA_DB_VERSION = 3/)
    expect(SOURCE).toMatch(/const MEDIA_ENTRY_V = 3/)
    expect(SOURCE).toMatch(/ev\.oldVersion > 0 && ev\.oldVersion < MEDIA_DB_VERSION/)
    expect(SOURCE).toMatch(/store\.clear\(\)/)
  })

  it('迟到的缩略图不会覆盖已落盘的 v3 原图', async () => {
    vi.resetModules()
    const fake = fakeIndexedDb()
    vi.stubGlobal('indexedDB', fake.factory)
    try {
      const mod = await import('./media-cache.ts')
      await mod.snsMediaCacheSet('same-key', 'data:original', false)
      await mod.snsMediaCacheSet('same-key', 'data:thumb', true)

      expect(fake.versions).toEqual([3])
      expect(fake.cleared(), '首次建库不该清空').toBe(false)
      await expect(mod.snsMediaCacheGet('same-key', true)).resolves.toBe('data:original')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
