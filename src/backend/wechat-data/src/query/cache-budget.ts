/**
 * 进程内缓存的通用容量工具：同时限制条数、总大小与单条大小。
 *
 * 这里只管计数与淘汰，不关心“大小”是字符数还是字节数，也不碰文件/网络。
 */
export interface BoundedCacheOptions<V> {
  /** 注册表里的名字；给了才会出现在 `cacheBudgetSnapshot()`（运行时内存观测）里。 */
  label?: string
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

/** 一条受控缓存的运行时占用（给内存哨兵/诊断日志用）。 */
export interface CacheBudgetUsage {
  label: string
  entries: number
  bytes: number
  maxEntries: number
  maxTotal: number
  maxEntry?: number
}

/**
 * 带 label 的有界缓存注册表。
 *
 * 为什么需要：这些缓存此前只有**单测里**能观察（各模块自己的 `*Handles()`），
 * 线上只能看到 worker 的总 RSS —— 分不清「RSS 高」是缓存、sqlite 页缓存还是一次性大对象。
 * 有了注册表，worker 的 `[mem]` 采样可以把每个缓存的**当前/上限**一起打出来，
 * 让「有界缓存真的在界内」从单测事实变成运行时事实（并给出后续基线的第一份读数）。
 */
const labeledCaches: Array<{ label: string; cache: BoundedCache<unknown, unknown> }> = []

/** 当前进程内所有带 label 的有界缓存占用快照（顺序 = 注册顺序）。 */
export function cacheBudgetSnapshot(): CacheBudgetUsage[] {
  return labeledCaches.map(({ label, cache }) => {
    const opts = registryOptions.get(label)
    return {
      label,
      entries: cache.size(),
      bytes: cache.total(),
      maxEntries: opts?.maxEntries ?? 0,
      maxTotal: opts?.maxTotal ?? 0,
      ...(opts?.maxEntry !== undefined ? { maxEntry: opts.maxEntry } : {}),
    }
  })
}

/** label → 创建参数（给快照带上上限；label 重复时后注册的覆盖前者）。 */
const registryOptions = new Map<string, BoundedCacheOptions<unknown>>()

/** 把一个带 label 的缓存登记进注册表（重复 label 覆盖旧实例，不重复出行）。 */
function registerLabeledCache(label: string, cache: BoundedCache<unknown, unknown>, opts: BoundedCacheOptions<unknown>): void {
  if (label === '') return
  const index = labeledCaches.findIndex((e) => e.label === label)
  const entry = { label, cache }
  if (index >= 0) labeledCaches[index] = entry
  else labeledCaches.push(entry)
  registryOptions.set(label, opts)
}

/** 清空注册表（仅测试：避免用例之间互相看见对方的缓存）。 */
export function resetCacheBudgetRegistryForTest(): void {
  labeledCaches.length = 0
  registryOptions.clear()
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

  const cache: BoundedCache<K, V> = {
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
  if (opts.label !== undefined) {
    registerLabeledCache(
      opts.label,
      cache as unknown as BoundedCache<unknown, unknown>,
      opts as unknown as BoundedCacheOptions<unknown>,
    )
  }
  return cache
}
