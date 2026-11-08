import { createBoundedCache } from './cache-budget.ts'

export interface PageHashCacheEntry {
  sig: string
  hashes: Buffer[]
}

const PAGE_HASH_CACHE_MAX_ENTRIES = 64
const PAGE_HASH_CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const PAGE_HASH_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024

/**
 * 主库页指纹缓存：`源签名 → 指纹列表`。
 *
 * 每个分片每页固定 32B，300+ 分片时原先的无界 Map 可积累数百 MB。超界后只是
 * 退化为下一轮全量重扫，不影响同步正确性。
 */
export const pageHashCache = createBoundedCache<string, PageHashCacheEntry>({
  label: 'sync-page-hashes',
  maxEntries: PAGE_HASH_CACHE_MAX_ENTRIES,
  maxTotal: PAGE_HASH_CACHE_MAX_TOTAL_BYTES,
  maxEntry: PAGE_HASH_CACHE_MAX_ENTRY_BYTES,
  sizeOf: (entry) => entry.hashes.reduce((bytes, hash) => bytes + hash.byteLength, 0),
})

/** 页指纹缓存的单测把手；不暴露内部缓存对象。 */
export function pageHashCacheHandles(): {
  stats: () => { count: number; total: number }
  clear: () => void
  putForTest: (key: string, entry: PageHashCacheEntry) => void
} {
  return {
    stats: () => ({ count: pageHashCache.size(), total: pageHashCache.total() }),
    clear: () => pageHashCache.clear(),
    putForTest: (key, entry) => pageHashCache.set(key, entry),
  }
}
