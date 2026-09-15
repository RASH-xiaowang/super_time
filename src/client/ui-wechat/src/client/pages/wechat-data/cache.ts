/**
 * 客户端缓存层：快照缓存 / 渲染缓存 / localStorage TTL 缓存 / fetch-through
 *
 * 四种缓存的共同点是「都住在渲染进程、都可随时丢弃」：快照缓存做 stale-while-revalidate，
 * 渲染缓存让面板二次打开瞬时出图，TTL 缓存给重查询兜底，fetch-through 把三者串起来。
 *
 * M21：从 api.ts 拆出（纯搬移，逐字未改），api.ts 继续转发这些导出，
 * 因此 40 多个面板的 import 路径都不用动。拆分是否等值由
 * `api-module-split.spec.ts` 的搬移一致性断言守住。
 */
/**
 * In-memory snapshot cache with a short TTL. The WeChat panels unmount when
 * the user switches tabs; a shared cache makes returning to a tab show the
 * last snapshot instantly, then refresh in the background (stale-while-revalidate).
 * Invalidated wholesale when the host reports new decrypted data
 * (see the 'dsh-wechat-data-updated' DOM event).
 */
const SNAPSHOT_TTL_MS = 30_000
const _snapshotCache = new Map<string, { value: unknown; ts: number }>()
const _snapshotListeners = new Map<string, Set<() => void>>()

/** Read a fresh-enough cached snapshot, or undefined when absent/stale. */
export function snapshotHit(key: string): unknown {
  const hit = _snapshotCache.get(key)
  if (hit === undefined) return undefined
  if (Date.now() - hit.ts < SNAPSHOT_TTL_MS) return hit.value
  // 过期即释放：否则整份快照会被这个模块级 Map 一直持有到渲染进程结束。
  _snapshotCache.delete(key)
  return undefined
}

/**
 * 快照缓存条目上限。面板卸载后快照仍留在模块级 Map 中，而键包含
 * talker / limit / 筛选条件等易变参数，因此必须设上限，
 * 否则长时间浏览（每敲一次搜索、每翻一页）都会留下一条永不回收的条目。
 */
const SNAPSHOT_CACHE_MAX = 60

/** 写入快照缓存；超出上限时按插入顺序淘汰最旧的键。 */
export function snapshotSet(key: string, value: unknown): void {
  _snapshotCache.delete(key)
  while (_snapshotCache.size >= SNAPSHOT_CACHE_MAX) {
    const oldest = _snapshotCache.keys().next()
    if (oldest.done) break
    _snapshotCache.delete(oldest.value)
  }
  _snapshotCache.set(key, { value, ts: Date.now() })
}

/** Fetch-through cache: returns the cached value immediately when fresh, else fetches and caches. */
export function cachedGet<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = snapshotHit(key)
  if (hit !== undefined) return Promise.resolve(hit as T)
  return fetcher().then((value) => {
    snapshotSet(key, value)
    for (const fn of _snapshotListeners.get(key) ?? []) { try { fn() } catch { /* ignore */ } }
    return value
  })
}

/** Subscribe to cache writes for one key (drives re-render after a background refresh). */
export function subscribeSnapshot(key: string, fn: () => void): () => void {
  const set = _snapshotListeners.get(key) ?? new Set<() => void>()
  set.add(fn)
  _snapshotListeners.set(key, set)
  return () => {
    set.delete(fn)
    // 退订后**必须连键一起删**：键里带着 talker / limit / 筛选条件等易变参数
    // （与 SNAPSHOT_CACHE_MAX 同一个理由），只删成员会让这个模块级 Map 每浏览一次
    // 就永久多一条空集合。`get(key) === set` 是防「同键的新一轮订阅」被旧退订删掉。
    if (set.size === 0 && _snapshotListeners.get(key) === set) _snapshotListeners.delete(key)
  }
}

/** Invalidate the whole snapshot cache (realtime update / manual refresh). */
export function invalidateSnapshotCache(): void {
  _snapshotCache.clear()
  for (const set of _snapshotListeners.values()) for (const fn of set) { try { fn() } catch { /* ignore */ } }
}

if (typeof window !== 'undefined') {
  // The ui-wechat plugin relays the host realtime sync signal as this DOM event;
  // new decrypted data means every cached snapshot is stale, so drop them all.
  window.addEventListener('dsh-wechat-data-updated', () => { invalidateSnapshotCache() })
}

const RENDER_CACHE_PREFIX = 'wxdata-render-cache:'

/** Read the last successfully rendered snapshot for a panel (sync, instant paint). */
export function readRenderCache<T>(key: string, ..._rest: T[]): T | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(RENDER_CACHE_PREFIX + key)
    return raw ? JSON.parse(raw) as T : null
  } catch { /* 无缓存或损坏:走正常加载 */ }
  return null
}

/** Save a snapshot after a successful render (quota-safe: drops silently when full). */
export function writeRenderCache(key: string, data: unknown): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(RENDER_CACHE_PREFIX + key, JSON.stringify(data))
  } catch { /* 容量超限:放弃缓存,不影响主流程 */ }
}

// ── 本地缓存层：先渲染缓存，后台刷新后再写回，加速资源预加载 ──
const CACHE_PREFIX = 'dsh-wechat-cache-v1:'
const CACHE_TTL_DEFAULT = 60_000

interface CacheEnvelope { at: number; v: unknown }

export function cacheGet(key: string, ttlMs = CACHE_TTL_DEFAULT): unknown {
  try {
    const s = localStorage.getItem(CACHE_PREFIX + key)
    if (!s) return null
    const env = JSON.parse(s) as CacheEnvelope
    if (typeof env.at !== 'number' || !('v' in env)) return null
    if (Date.now() - env.at > ttlMs) {
      localStorage.removeItem(CACHE_PREFIX + key)
      return null
    }
    return env.v
  } catch {
    return null
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), v: value } satisfies CacheEnvelope))
  } catch {
    /* localStorage 满时忽略（媒体大图不入缓存） */
  }
}

/** Remove cache entries whose key starts with the given prefix (both layers). */
export function invalidateWechatCache(prefix: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i)
      if (!k) continue
      if (k.startsWith(CACHE_PREFIX + prefix)) localStorage.removeItem(k)
      if (k.startsWith(RENDER_CACHE_PREFIX + prefix)) localStorage.removeItem(k)
    }
  } catch { /* quota/security errors are best-effort */ }
}

/** 读快照：命中缓存时先返回缓存作早显，随后前台等待新鲜值并写回；
 *  后台刷新失败降级返回缓存。无缓存时直接请求并写回。 */
/** 记录一次 panel 数据取数的耗时（超过阈值才打印，便于观察“及时响应”与回归）。 */
export async function timedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  try {
    return await fetcher()
  } finally {
    const ms = performance.now() - t0
    if (ms > 250) console.info(`[wxdata] ${key} ${ms.toFixed(0)}ms`)
  }
}

export async function cachedFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs = CACHE_TTL_DEFAULT): Promise<T> {
  const hit = cacheGet(key, ttlMs) as T | null
  if (hit !== null && !isEmptySnapshot(hit)) {
    try {
      const fresh = await timedFetch(key, fetcher)
      cacheSet(key, fresh)
      return fresh
    } catch {
      return hit
    }
  }
  const fresh = await timedFetch(key, fetcher)
  cacheSet(key, fresh)
  return fresh
}

/**
 * 空结果不参与缓存：一个临时的空快照（例如数据根尚未就绪时写入的）会
 * 永久盖住真实数据——命中后界面渲染空列表，后台刷新只改写 localStorage
 * 而不重绘界面。列表型快照（moments/items/favorites/…）无任何条目且
 * 总数为 0 时视为空；统计类快照（无数组字段）不受影响。
 */
export function isEmptySnapshot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entries = Object.values(value as Record<string, unknown>)
  let sawList = false
  for (const entry of entries) {
    if (Array.isArray(entry)) {
      sawList = true
      if (entry.length > 0) return false
    }
  }
  if (!sawList) return false
  return !entries.some(entry => typeof entry === 'number' && entry > 0)
}
