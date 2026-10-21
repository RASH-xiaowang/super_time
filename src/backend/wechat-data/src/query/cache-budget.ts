/**
 * 进程内缓存的通用容量工具：同时限制条数、总大小与单条大小。
 *
 * 这里只管计数与淘汰，不关心“大小”是字符数还是字节数，也不碰文件/网络。
 */
export interface BoundedCacheOptions<V> {
  maxEntries: number
  maxTotal: number
  sizeOf: (value: V) => number
  maxEntry?: number
}

export interface BoundedCache<K, V> {
  get: (key: K) => V | undefined
  set: (key: K, value: V) => void
  delete: (key: K) => boolean
  clear: () => void
  size: () => number
  total: () => number
  keys: () => IterableIterator<K>
}

interface CacheEntry<V> {
  value: V
  size: number
}

export function createBoundedCache<K, V>(opts: BoundedCacheOptions<V>): BoundedCache<K, V> {
  const entries = new Map<K, CacheEntry<V>>()
  let totalSize = 0

  function evictOldest(): void {
    const oldest = entries.keys().next()
    if (oldest.done === true) return
    const entry = entries.get(oldest.value)
    entries.delete(oldest.value)
    if (entry !== undefined) totalSize -= entry.size
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      // Map 的插入序就是 LRU 顺序：命中后删了再写回，代表刚刚用过。
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      const size = opts.sizeOf(value)
      if (opts.maxEntry !== undefined && size > opts.maxEntry) return
      const previous = entries.get(key)
      if (previous !== undefined) {
        entries.delete(key)
        totalSize -= previous.size
      }
      entries.set(key, { value, size })
      totalSize += size
      while (entries.size > opts.maxEntries || totalSize > opts.maxTotal) {
        const before = entries.size
        evictOldest()
        if (entries.size === before) break
      }
    },
    delete(key) {
      const entry = entries.get(key)
      if (entry === undefined) return false
      entries.delete(key)
      totalSize -= entry.size
      return true
    },
    clear() {
      entries.clear()
      totalSize = 0
    },
    size() {
      return entries.size
    },
    total() {
      return totalSize
    },
    keys() {
      return entries.keys()
    },
  }
}
