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
/**
 * 「数据变了」的世代戳（毫秒；0 = 从未失效）。
 *
 * P2-4 / 第一批 #4：旧实现收到一次实时同步事件就把**整张表清掉** ——
 * 数据确实都旧了，这个判断没错，错在表达方式：清表 ⇒ 下一次读全部回源，
 * 而实时同步活跃期这个事件约**每 10 秒来一次**，于是「所有面板每 10 秒全体重新取数」，
 * 其中 `ledger` / `storage-stats` 这类是几百毫秒的重查询（`overview-panel` 还在每次事件里
 * 重算它们）。审查记过的那笔「世界板块自身 13ms 被排到 17,008ms」就是同一台单队列的账。
 *
 * 现在改成**标记为陈旧**：旧值仍然立刻可用（SWR 的 stale），读它的人顺带触发一次后台刷新，
 * 刷新成功才写回 + 通知。为了不靠这个机制无限供旧数，超过 {@link STALE_SERVE_CEILING_MS}
 * 的条目直接丢掉 —— 宁可变冷启动也不画一小时前的数据。
 */
let staleBeforeMs = 0
/** 陈旧值最多还肯画多久（超过就真的丢掉）。 */
const STALE_SERVE_CEILING_MS = 5 * 60_000

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

/**
 * Fetch-through cache，带**陈旧可读**（P2-4）：
 *   · 新鲜命中 ⇒ 直接回；
 *   · 有值但过期或被数据变更作废 ⇒ 先回旧值（界面立刻有东西画），同时后台复验、写回并通知；
 *   · 什么都没有 ⇒ 回源并写入。
 * 后台复验失败时保留旧值（与 `cachedFetch` 同一降级口径），但陈旧太久的值在读的时候就已经被丢掉了。
 * 去重集合与 `cachedFetch` 共用同一个 `_revalidating`：两层的键不相交，共用只会更少打请求。
 */
export function cachedGet<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = _snapshotCache.get(key)
  if (hit !== undefined) {
    const ageMs = Date.now() - hit.ts
    if (ageMs > STALE_SERVE_CEILING_MS) {
      // 旧到不该再画的值：当作没有（下一次读会真的回源），顺带把它从内存里丢掉
      _snapshotCache.delete(key)
    } else if (ageMs < SNAPSHOT_TTL_MS && hit.ts > staleBeforeMs) {
      return Promise.resolve(hit.value as T)
    } else {
      revalidateSnapshot(key, fetcher)
      return Promise.resolve(hit.value as T)
    }
  }
  return fetcher().then((value) => {
    snapshotSet(key, value)
    notifySnapshotRefreshed(key)
    return value
  })
}

/** 后台复验一个已缓存的键：成功才写回并通知；同键并发只跑一次。 */
function revalidateSnapshot<T>(key: string, fetcher: () => Promise<T>): void {
  if (_revalidating.has(key)) return
  _revalidating.add(key)
  void Promise.resolve().then(fetcher).then(
    (value) => { snapshotSet(key, value); notifySnapshotRefreshed(key) },
    () => { /* 复验失败：留着旧值，下一次读再试（面板自己也订阅着数据事件） */ },
  ).finally(() => { _revalidating.delete(key) })
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

/**
 * 「数据变了」：把全部快照**标记为陈旧**（不是清掉），并通知订阅者。
 *
 * 与旧写法的差别只在「旧值还在不在」：旧值仍然能在下一次读时立刻画出来，
 * 真正的取数改到后台做 —— 于是每 10 秒一次的同步事件不再等于「全体面板同时回源」。
 * 超过 `STALE_SERVE_CEILING_MS` 的条目在读的时候会被丢掉，不会一直画旧数。
 */
export function invalidateSnapshotCache(): void {
  staleBeforeMs = Date.now()
  const now = Date.now()
  for (const [k, v] of [..._snapshotCache.entries()]) {
    if (now - v.ts > STALE_SERVE_CEILING_MS) _snapshotCache.delete(k)
  }
  for (const set of _snapshotListeners.values()) for (const fn of set) { try { fn() } catch { /* ignore */ } }
}

/**
 * Drop one snapshot entry, and notify its subscribers (who then refetch).
 *
 * 为什么需要「按键」而不只是「清全部」：知识库**表**的变化（新建 / 改名 / 删除）
 * 只让库列表那一条失效，与聊天、朋友圈等面板的快照无关。用 `invalidateSnapshotCache()`
 * 会把所有面板的缓存一起丢掉，下次切页时全体重新取数 —— 一个改名动作不该有这种代价。
 * @param key - 快照键（与 `cachedGet` / `snapshotSet` 用同一个）。
 */
export function snapshotDelete(key: string): void {
  _snapshotCache.delete(key)
  for (const fn of _snapshotListeners.get(key) ?? []) { try { fn() } catch { /* ignore */ } }
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

/**
 * 后台刷新完成后广播的 DOM 事件前缀。
 *
 * 真 SWR 的另一半：命中缓存时界面先画旧快照，随后后台拿到新值 —— 新值只写进缓存的话，
 * 界面会一直停在旧数据上（用户看到的永远是「上一次打开时的那份」）。所以刷新完成要广播一条
 * **按接口族**的事件，让在用这个接口的面板自己重读一次。
 * 分族（`messages` / `sessions` / `moments`…）而不是复用宿主的 `dsh-wechat-data-updated`：
 * 后者会让所有面板一起重拉（P2-4 记着的那场风暴）。
 */
export const SNAPSHOT_REFRESHED_EVENT = 'dsh-snapshot-refreshed'

/** 同一键的后台刷新去重（否则一次事件风暴会把同一个接口打若干遍）。 */
const _revalidating = new Set<string>()

/** 通知这个键的订阅者 + 广播该接口族（两者都是 best-effort）。 */
function notifySnapshotRefreshed(key: string): void {
  for (const fn of _snapshotListeners.get(key) ?? []) { try { fn() } catch { /* 一个订阅者不许挡住别人 */ } }
  if (typeof window === 'undefined') return
  const family = key.split(':')[0] ?? key
  try {
    window.dispatchEvent(new CustomEvent(`${SNAPSHOT_REFRESHED_EVENT}:${family}`, { detail: { key } }))
  } catch { /* 没有 CustomEvent 的环境里事件广播只是优化，不是正确性 */ }
}

/**
 * 写回缓存，**仅当值真的变了**；返回是否写了。
 *
 * 为什么不能无条件写 + 广播：订阅者被通知后会重读一次同一个接口 ⇒ 又是一次后台刷新
 * ⇒ 又是一条广播 —— 数据一个字没变也能自转成环。按「变了才播」收敛，
 * 这跟 P2-4 抱怨的「每约 10 秒把整棵缓存清掉」是同一类问题的两面。
 * 比较用序列化结果（本就要 `JSON.stringify` 一次），不引入额外的模块级状态。
 */
function cacheSetIfChanged(key: string, value: unknown): boolean {
  const vJson = JSON.stringify(value)
  try {
    const prev = localStorage.getItem(CACHE_PREFIX + key)
    if (prev !== null) {
      const env = JSON.parse(prev) as CacheEnvelope
      if (JSON.stringify(env.v) === vJson) return false
    }
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), v: value } satisfies CacheEnvelope))
    return true
  } catch {
    /* localStorage 满 / 序列化失败：退回无条件写一次 */
    try { cacheSet(key, value) } catch { /* 放弃缓存 */ }
    return true
  }
}

export async function cachedFetch<T>(key: string, fetcher: () => Promise<T>, ttlMs = CACHE_TTL_DEFAULT): Promise<T> {
  const hit = cacheGet(key, ttlMs) as T | null
  if (hit !== null && !isEmptySnapshot(hit)) {
    // 真 SWR（P0-3）：**命中就立刻回**，后台再刷新并广播。
    // 之前的写法是「命中也 await 完整请求，只有失败才用缓存」—— 那叫 fetch-through 带兜底，
    // 不叫 stale-while-revalidate，而注释一直写着后者（实现与注释不符）。代价是可看见的：
    // `sessions`(30s) / `messages`(5s) / `moments` / `records` / `privacy` / `group` / `pay` /
    // `daily` / `kb-model` 九个接口二次打开都要等完整后端 —— 就是「切回面板还在转圈」。
    if (!_revalidating.has(key)) {
      _revalidating.add(key)
      void timedFetch(key, fetcher).then(
        (fresh) => { if (cacheSetIfChanged(key, fresh)) notifySnapshotRefreshed(key) },
        () => { /* 后台刷新失败：留着旧快照，下次再试（与旧写法同样的降级） */ },
      ).finally(() => { _revalidating.delete(key) })
    }
    return hit
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
