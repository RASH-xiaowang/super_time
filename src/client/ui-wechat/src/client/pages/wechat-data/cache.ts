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
import { forgetAllImages } from './image-cache.ts'
/**
 * In-memory snapshot cache with a short TTL. The WeChat panels unmount when
 * the user switches tabs; a shared cache makes returning to a tab show the
 * last snapshot instantly, then refresh in the background (stale-while-revalidate).
 * Invalidated wholesale when the host reports new decrypted data
 * (see the 'dsh-wechat-data-updated' DOM event).
 */
const SNAPSHOT_TTL_MS = 30_000
const _snapshotCache = new Map<string, { value: unknown; ts: number; generation: number }>()
const _snapshotListeners = new Map<string, Set<() => void>>()
/**
 * 「数据变了」的世代编号。0 = 从未失效；每次全局失效加一。
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
 *
 * 用单调递增的整数而不是墙钟做世代：`Date.now()` 在同一毫秒里连续写入会得到相同的值，
 * 于是「失效后立刻写入的新快照」会被严格大于判断误当成旧快照。整数世代没有这个歧义。
 */
let snapshotGeneration = 0
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
  _snapshotCache.set(key, { value, ts: Date.now(), generation: snapshotGeneration })
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
    } else if (ageMs < SNAPSHOT_TTL_MS && hit.generation === snapshotGeneration) {
      // H3：命中路径也过 timedFetch —— 这条**刻意**量的是「取快照」而不是「取数」：
      // 它应当接近 0ms，一旦打印出来就说明主线程被别的东西占着（同步 SQLite / 长任务），
      // 正是 PERF-AUDIT 里「命中也要等」那类现象的判据。少了这一条，命中路径的耗时无从观察。
      return timedFetch(key + ':hit', () => Promise.resolve(hit.value as T))
    } else {
      revalidateSnapshot(key, fetcher)
      return timedFetch(key + ':hit', () => Promise.resolve(hit.value as T))
    }
  }
  // 回源：走的是真实后端往返，这是最该被量到的一条。
  return timedFetch(key, () => fetcher().then((value) => {
    snapshotSet(key, value)
    notifySnapshotRefreshed(key)
    return value
  }))
}

/** 后台复验一个已缓存的键：成功才写回并通知；同键并发只跑一次。 */
function revalidateSnapshot<T>(key: string, fetcher: () => Promise<T>): void {
  if (_revalidating.has(key)) return
  _revalidating.add(key)
  // 后台复验同样计时（键带 `:bg` 与前台回源区分开）：这是「切回面板先看到旧值、
  // 过一会儿数据变了」那条路径的真实耗时，旧写法完全看不见它。
  void timedFetch(key + ':bg', fetcher).then(
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
  snapshotGeneration += 1
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

/**
 * 硬清空全部快照（换账号 / 换数据目录专用）。
 *
 * `invalidateSnapshotCache()` 的口径是「标记陈旧，旧值仍可先画一帧再后台复验」——
 * 这对实时同步是对的，对换数据源不对：旧值属于上一个账号，先画就是串号。
 * 这里直接丢掉并通知订阅者回源，不走陈旧可读。
 */
export function clearSnapshotCache(): void {
  _snapshotCache.clear()
  snapshotGeneration += 1
  for (const set of _snapshotListeners.values()) for (const fn of set) { try { fn() } catch { /* ignore */ } }
}

// ── 数据目录身份：换账号 / 换数据目录时隔离并失效缓存 ─────────────────────────
//
// 为什么需要：扫描型面板的首屏会同步读渲染缓存，而缓存键只带 talker / 查询参数，
// 换账号后同一个键仍然命中 → 用户会先看到**上一个账号**的会话/消息一帧，再被真实数据覆盖。
// 这里把「当前数据目录」变成一个可订阅的身份：渲染缓存键带上目录指纹，保活面板按身份
// 重新挂载；保存配置时若目录或密钥变了，统一作废快照与两层持久缓存。
//
// 指纹只用于缓存命名（FNV-1a 32 位），不是安全哈希，也不会把目录明文写进 localStorage 键。

/** 参与数据身份判定的字段（密钥只参与「变没变」的比较，不落进缓存键）。 */
export interface DataIdentityFields {
  db_dir?: string
  db_enc_key?: string
  image_aes_key?: string
  image_xor_key?: string | number
}

/** 归一化目录：统一分隔符、去掉尾部斜杠、大小写不敏感（Windows 路径）。 */
export function normalizeDataDir(dbDir: string | undefined): string {
  return String(dbDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 目录指纹（FNV-1a 32 位，8 位十六进制）；空目录也有稳定值。 */
export function dataDirFingerprint(dbDir: string | undefined): string {
  const value = normalizeDataDir(dbDir)
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

let currentDataDir = ''
let lastKnownDataIdentity: DataIdentityFields | null = null
let dataIdentityRevision = 0
let dataIdentitySnapshot = `${dataDirFingerprint('')}:0`
const _dataIdentityListeners = new Set<() => void>()

function publishDataIdentity(): void {
  dataIdentitySnapshot = `${dataDirFingerprint(currentDataDir)}:${String(dataIdentityRevision)}`
  for (const fn of [..._dataIdentityListeners]) { try { fn() } catch { /* ignore */ } }
}

/** 供 `useSyncExternalStore`：快照在身份变化时才变（目录指纹 + 失效代数）。 */
export function getDataIdentitySnapshot(): string {
  return dataIdentitySnapshot
}

/** 订阅数据身份变化（keep-alive 用它决定何时丢弃旧面板）。 */
export function subscribeDataIdentity(fn: () => void): () => void {
  _dataIdentityListeners.add(fn)
  return () => { _dataIdentityListeners.delete(fn) }
}

/** 只更新目录指纹（启动时从轻量配置读取，密钥未知不影响缓存命名）。 */
export function setDataDirIdentity(dbDir: string | undefined): void {
  const next = normalizeDataDir(dbDir)
  if (next === currentDataDir) return
  currentDataDir = next
  publishDataIdentity()
}

/** 记住一份完整配置的目录与密钥，作为下一次保存时的比较基线。 */
export function rememberDataIdentity(config: DataIdentityFields): void {
  setDataDirIdentity(config.db_dir)
  lastKnownDataIdentity = {
    db_dir: config.db_dir,
    db_enc_key: config.db_enc_key ?? '',
    image_aes_key: config.image_aes_key ?? '',
    image_xor_key: config.image_xor_key ?? '',
  }
}

function sameDataIdentity(a: DataIdentityFields, b: DataIdentityFields): boolean {
  return normalizeDataDir(a.db_dir) === normalizeDataDir(b.db_dir)
    && (a.db_enc_key ?? '') === (b.db_enc_key ?? '')
    && (a.image_aes_key ?? '') === (b.image_aes_key ?? '')
    && String(a.image_xor_key ?? '') === String(b.image_xor_key ?? '')
}

/** 这次保存是否真的动了数据来源（目录或密钥）。纯函数，便于单测。 */
export function dataIdentityChanged(after: DataIdentityFields, before: DataIdentityFields | null): boolean {
  if (before === null) {
    return normalizeDataDir(after.db_dir) !== ''
      || (after.db_enc_key ?? '') !== ''
      || (after.image_aes_key ?? '') !== ''
  }
  return !sameDataIdentity(before, after)
}

/** 身份变化时要做的三件事（注入是为了单测能断言「保存后确实调了失效」）。 */
export interface DataIdentityCacheOps {
  invalidateAll: () => void
  forgetImages: () => void
  notifyAvatar: () => void
}

/** 头像缓存重置信号：WechatDataPanel 的 BrandAvatar 监听后丢弃模块级缓存。 */
export const DATA_IDENTITY_CHANGED_EVENT = 'dsh-wechat-data-identity-changed'

const DEFAULT_DATA_IDENTITY_OPS: DataIdentityCacheOps = {
  // 换账号不能走「陈旧可读」：旧快照属于上一个账号，先画一帧就是串号。
  invalidateAll: () => { invalidateWechatCache(''); clearSnapshotCache() },
  forgetImages: () => { forgetAllImages() },
  notifyAvatar: () => {
    if (typeof window === 'undefined') return
    try { window.dispatchEvent(new CustomEvent(DATA_IDENTITY_CHANGED_EVENT)) } catch { /* 没有 CustomEvent 时只是少一次头像刷新 */ }
  },
}

/**
 * 保存成功后调用：目录 / 密钥真的变了才失效缓存并推进身份代数。
 *
 * 「统一失效」是**硬清**：两层 localStorage（消息 / 会话 / 知识库 / 总览 / 渲染缓存）
 * 按命名空间清掉，内存快照直接丢弃并通知订阅者回源（不做陈旧可读，避免先画旧账号）；
 * 图片内存 LRU 一并清空，头像缓存通过事件通知顶栏丢弃。返回是否发生了失效。
 * @param after - 刚保存的配置字段。
 * @param ops - 可注入的副作用（生产用默认实现）。
 * @returns 是否发生了身份变化。
 */
export function applyDataIdentityAfterSave(
  after: DataIdentityFields,
  ops: DataIdentityCacheOps = DEFAULT_DATA_IDENTITY_OPS,
): boolean {
  if (!dataIdentityChanged(after, lastKnownDataIdentity)) return false
  ops.invalidateAll()
  ops.forgetImages()
  ops.notifyAvatar()
  currentDataDir = normalizeDataDir(after.db_dir)
  dataIdentityRevision += 1
  lastKnownDataIdentity = {
    db_dir: after.db_dir,
    db_enc_key: after.db_enc_key ?? '',
    image_aes_key: after.image_aes_key ?? '',
    image_xor_key: after.image_xor_key ?? '',
  }
  publishDataIdentity()
  return true
}


if (typeof window !== 'undefined') {
  // The ui-wechat plugin relays the host realtime sync signal as this DOM event;
  // new decrypted data means every in-memory snapshot is stale. The persistent
  // `cachedFetch` entries need to be invalidated as well: otherwise the refresh
  // triggered by this same event hits the 30s sessions cache and paints the old
  // list again while a background revalidation writes the new value for the
  // *next* event. Only the WeChat-data families are touched; unrelated caches
  // (knowledge base, task center, user preferences) stay warm.
  window.addEventListener('dsh-wechat-data-updated', (event) => {
    invalidateWechatCache('sessions:')
    // Older hosts (and synthetic resume events) do not carry detail. Treat that
    // as "unknown" and invalidate messages too; only skip when the structured
    // revision explicitly says no message shard changed.
    const detail = (event as CustomEvent<{ messageChanged?: unknown }>).detail
    if (detail?.messageChanged !== false) invalidateWechatCache('messages:')
    invalidateSnapshotCache()
  })
}

const RENDER_CACHE_PREFIX = 'wxdata-render-cache:'
/**
 * 渲染缓存键的「账号/数据目录」命名空间。
 *
 * **所有**渲染缓存都按当前目录指纹命名，而不只是聊天消息：会话列表、群洞察、
 * 监控、朋友圈、知识库等键要么含 username，要么含库 id，换账号后完全可能同名。
 * 旧实现只给 `chat-msgs:` 加前缀，其余仍会在第一次读到新后端数据前闪一帧旧账号内容。
 *
 * 键形如 `acct-1a2b3c4d:chat-msgs:v3:wxid_x`。指纹只用于命名，不写目录明文。
 * 升级前写入的无前缀键无法判断属于哪个账号，`readRenderCache` 会顺手删掉它们。
 */
const DATA_SCOPE_KEY_PREFIX = 'acct-'
/**
 * 给渲染缓存键加目录命名空间。
 * @param key - 逻辑键（调用方原本使用的键）。
 * @returns 实际落盘的键（不含 `wxdata-render-cache:` 前缀）。
 */
export function scopedRenderCacheKey(key: string): string {
  return DATA_SCOPE_KEY_PREFIX + dataDirFingerprint(currentDataDir) + ':' + key
}

/** 把磁盘上的（可能带目录命名空间的）键还原成逻辑键，供前缀失效使用。 */
function logicalRenderCacheKey(stored: string): string {
  if (!stored.startsWith(DATA_SCOPE_KEY_PREFIX)) return stored
  const colon = stored.indexOf(':')
  return colon < 0 ? stored : stored.slice(colon + 1)
}

/**
 * 渲染缓存的保质期（P2-5）。这一层是给「二次打开秒出图」用的，
 * 不是给「离线可用」用的 —— 超过一天就宁可重新取一次，也不画昨天的会话列表。
 */
const RENDER_CACHE_TTL_MS = 24 * 60 * 60_000
/** 单条上限：超过就不写（全量消息/朋友圈的快照动辄几 MB，而配额只有 5–10 MB）。 */
const RENDER_CACHE_MAX_BYTES = 1_500_000
/** 两种失败各播报一次（**分开**记：合成一条会把另一种也消音，测试就抓不到「配额满」那句）。 */
let renderCacheOversizeNoted = false
let renderCacheQuotaNoted = false

/** 渲染缓存的信封：`at` 用于 TTL；旧版是裸值（没有信封）⇒ 判为过期，见下。 */
interface RenderEnvelope { at: number; v: unknown }

/**
 * Read the last successfully rendered snapshot for a panel (sync, instant paint).
 *
 * P2-5 之前这里没有 TTL、也没有大小上限，而写失败是**静默**的：
 * 一份大对象挤爆配额之后，症状是「某些面板的首屏加速莫名消失」，谁也查不到原因。
 * 现在：过保质期就删掉当没有；旧版裸值（无法知道多旧）同样判过期；单条过大不写；
 * 写失败时清掉本层的全部条目并 `console.info` 一次（本层的定位就是「可随时丢弃」，
 * 与其零散留下半套旧数据，不如一次丢干净并说清楚）。
 */
export function readRenderCache<T>(key: string, ..._rest: T[]): T | null {
  if (typeof localStorage === 'undefined') return null
  const storedKey = RENDER_CACHE_PREFIX + scopedRenderCacheKey(key)
  const legacyKey = RENDER_CACHE_PREFIX + key
  try {
    // 升级前的无前缀条目：不知道属于哪个账号，不能猜 —— 顺手删掉并当未命中。
    if (storedKey !== legacyKey && localStorage.getItem(storedKey) === null) {
      localStorage.removeItem(legacyKey)
      return null
    }
    const raw = localStorage.getItem(storedKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    const env = parsed as RenderEnvelope
    if (env === null || typeof env !== 'object' || typeof env.at !== 'number' || !('v' in env)) {
      // 旧格式（裸值）：没有写时间，无法判旧不旧 ⇒ 当过期丢掉，下一次写就是新格式
      localStorage.removeItem(storedKey)
      return null
    }
    if (Date.now() - env.at > RENDER_CACHE_TTL_MS) {
      localStorage.removeItem(storedKey)
      return null
    }
    return env.v as T
  } catch { /* 无缓存或损坏:走正常加载 */ }
  return null
}

/** Save a snapshot after a successful render (quota-safe, with the failure made visible). */
export function writeRenderCache(key: string, data: unknown): void {
  if (typeof localStorage === 'undefined') return
  const storedKey = RENDER_CACHE_PREFIX + scopedRenderCacheKey(key)
  const legacyKey = RENDER_CACHE_PREFIX + key
  try {
    // 旧版无前缀键读不到（readRenderCache 会忽略），但没必要继续占配额。
    if (storedKey !== legacyKey) localStorage.removeItem(legacyKey)
  } catch { /* best-effort */ }
  let payload = ''
  try {
    payload = JSON.stringify({ at: Date.now(), v: data } satisfies RenderEnvelope)
  } catch {
    return /* 循环引用/BigInt 之类：这份数据本来就没法画第二次 */
  }
  if (payload.length > RENDER_CACHE_MAX_BYTES) {
    if (!renderCacheOversizeNoted) {
      renderCacheOversizeNoted = true
      console.info(`[wxdata] 渲染缓存单条过大（${String(Math.round(payload.length / 1024))}KB > 上界），首屏加速对它关闭`)
    }
    return
  }
  try {
    localStorage.setItem(storedKey, payload)
  } catch {
    // 配额满：把这一层整个丢干净（它随时可丢），并说一次为什么首屏变慢了。
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(RENDER_CACHE_PREFIX)) localStorage.removeItem(k)
      }
    } catch { /* 丢不掉也不能影响主流程 */ }
    if (!renderCacheQuotaNoted) {
      renderCacheQuotaNoted = true
      console.info('[wxdata] localStorage 配额已满，已清空渲染缓存：面板首屏会慢一次')
    }
  }
}

// ── 本地缓存层：先渲染缓存，后台刷新后再写回，加速资源预加载 ──
const CACHE_PREFIX = 'dsh-wechat-cache-v1:'
/** 总览面板沿用裸 localStorage 的旧键族，也归同一个失效契约管。 */
export const OVERVIEW_CACHE_PREFIX = 'dsh-wechat-overview-'
const CACHE_TTL_DEFAULT = 60_000

/**
 * 微信实体身份判定的缓存代际。
 *
 * 32 位 `Msg_<md5>` 后缀曾被误当成会话 username 写进会话/消息渲染缓存。
 * 后端修复后，如果升级后的首帧仍先读旧 localStorage，用户会短暂看到哈希标题，
 * 甚至继续用哈希打开一个空会话。这个标记做一次性、命名空间内的清理：
 * 只丢弃可再生的微信数据缓存，不动主题、布局等用户偏好。
 *
 * v4（2026-11）：聊天消息渲染缓存改成自描述信封（`chat-msgs:v3:`），旧格式
 * （`chat-msgs:v2:` 的裸列表）没有可核对的归属证据 —— 单聊行此前根本不带
 * `sender`，历史上被写进别人的会话也无从识别。升代把旧条目一次性清掉，
 * 避免它们被当成「没有缓存」以外的形态继续存在。
 */
const WECHAT_CACHE_SCHEMA_KEY = 'dsh-wechat-cache-schema'
const WECHAT_CACHE_SCHEMA = 'message-identity-v4'
const WECHAT_CACHE_NAMESPACES = [
  'dsh-wechat-cache:',
  CACHE_PREFIX,
  RENDER_CACHE_PREFIX,
  OVERVIEW_CACHE_PREFIX,
  'chat-msgs:',
] as const

/**
 * 确保本地缓存属于当前身份 schema；首次升级时丢弃旧快照。
 * @returns 执行清理后为 true；存储不可用或写入标记失败时为 false。
 */
export function ensureWechatCacheSchema(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    if (localStorage.getItem(WECHAT_CACHE_SCHEMA_KEY) === WECHAT_CACHE_SCHEMA) return true
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i)
      if (!key || key === WECHAT_CACHE_SCHEMA_KEY) continue
      if (WECHAT_CACHE_NAMESPACES.some(prefix => key.startsWith(prefix))) {
        localStorage.removeItem(key)
      }
    }
    localStorage.setItem(WECHAT_CACHE_SCHEMA_KEY, WECHAT_CACHE_SCHEMA)
    return true
  } catch {
    // 隐私模式 / 配额异常：缓存本来就是可丢弃的，读取路径仍会做身份兜底。
    return false
  }
}

// 模块加载即迁移。升级后的第一帧不能用旧哈希快照抢在真实数据之前显示。
ensureWechatCacheSchema()

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
      if (k.startsWith(OVERVIEW_CACHE_PREFIX + prefix)) localStorage.removeItem(k)
      if (k.startsWith(RENDER_CACHE_PREFIX)) {
        // 渲染缓存可能带 `acct-<目录指纹>:` 命名空间：按逻辑键判断前缀，
        // 否则 `invalidateAndNotify('chat-msgs:')` 清不到换账号后的条目。
        const logical = logicalRenderCacheKey(k.slice(RENDER_CACHE_PREFIX.length))
        if (logical.startsWith(prefix)) localStorage.removeItem(k)
      }
    }
  } catch { /* quota/security errors are best-effort */ }
}

/** 键是否落在这些前缀之内（'' 表示全部）。 */
function inScope(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => p === '' || key.startsWith(p))
}

/**
 * **统一的失效契约**（P2-4 ③ / 第三批 #23）：写入侧只调这一个函数。
 *
 * 为什么要收成一个：缓存有**两层**，而它们的通知能力不一样 ——
 *  · `localStorage`（`cacheGet/cacheSet`，`cachedFetch` 用它）：`invalidateWechatCache(前缀)` 会清，
 *    但**不通知任何人**；
 *  · 内存快照（`_snapshotCache` + `_snapshotListeners`，`cachedGet` 用它）：
 *    `invalidateSnapshotCache()`/`snapshotDelete()` 会**连着订阅者一起通知**。
 * 于是「我清过缓存了」这句话有两种含义：清了持久层、但正在看这一页的面板手里还留着旧快照，
 * 要等到 TTL 自然过期或宿主那条全局数据事件才更新。实测这样的写入点有 **11 处、跨 7 个改数据的接口**
 * （改消息 / 重置改回原文 / 清草稿 ×2 / 删收藏 / 改隐私开关 / 恢复备份），
 * 其中 `apiRestoreBackup` 最典型：整库被换掉了，界面上还是恢复前的样子。
 *
 * 参数用**键前缀**，因为两层的键本来就是同一套词汇（`sessions:` / `messages:` / `favorites:` …
 * —— 见 `api-read.ts` 里那些 `cachedFetch('sessions:' + …)`）；传 '' 表示全量。
 * @param prefix - 一个或几个键前缀；'' = 整个缓存。
 */
export function invalidateAndNotify(prefix: string | readonly string[]): void {
  const prefixes = typeof prefix === 'string' ? [prefix] : [...prefix]
  // ① 持久层：两种 localStorage 缓存（值 + 渲染）都按前缀清。
  for (const p of prefixes) invalidateWechatCache(p)
  if (prefixes.includes('')) {
    // 全量走既有的「标记陈旧 + 通知所有人」：旧值还能立刻画、复验进后台，
    // 不至于把八个面板同时打回冷启动（P2-4 记着的那场风暴）。
    invalidateSnapshotCache()
    return
  }
  // ② 内存快照层：命中前缀的条目丢掉（下次读回源）。
  for (const k of [..._snapshotCache.keys()]) {
    if (inScope(k, prefixes)) _snapshotCache.delete(k)
  }
  // ③ 通知：订阅者按**键**注册，所以要看的是监听表而不是快照表 ——
  //    有的键只存在于持久层（`cachedFetch` 那一族），面板照样订阅着它。
  for (const [k, set] of [..._snapshotListeners.entries()]) {
    if (!inScope(k, prefixes)) continue
    for (const fn of set) { try { fn() } catch { /* ignore */ } }
  }
}

/**
 * 记录一次 panel 数据取数的耗时（超过阈值才打印，便于观察"及时响应"与回归）。
 *
 * ## H3（2026-09-28）：从「只覆盖 cachedFetch 那一路」扩到「所有取数」
 *
 * 改前这函数只在 `cachedFetch` 的两处分支里被调用，而 `cachedGet` 那条**热门快照通道**
 * 一次都没经过它 —— 于是「前端侧耗时」这件事只看得见一部分接口，而看不见的那部分
 * 恰恰包含 `ledger` / `storage` 这类重查询（面板切回来时走的正是 `cachedGet` 快照命中）。
 * 现在四类读取路径全部经过这里：
 *
 * | 路径 | 量到的是什么 |
 * |---|---|
 * | `cachedFetch` 冷（回源） | 真实后端往返 |
 * | `cachedFetch` 热（SWR 后台复验） | 后台刷新的真实耗时 |
 * | `cachedGet` 冷（回源） | 真实后端往返 |
 * | `cachedGet` 热（快照命中 / 陈旧回源） | **命中耗时**（应当 ≈0；不是 0 就是卡在主线程） |
 *
 * 最后一行是这次扩面的主要收获：旧写法下「切回面板卡了一下」无法区分
 * 「后端慢」与「快照命中却也慢」，量到命中路径才分得开。
 *
 * @param key - 缓存键（会原样出现在日志里，形如 `ledger:wxid_x:50`）。
 * @param fetcher - 真正取数的那段。
 * @returns fetcher 的结果（本函数只观测，不改语义、不吞异常）。
 */
export async function timedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  try {
    return await fetcher()
  } finally {
    const ms = performance.now() - t0
    if (ms > TIMED_FETCH_THRESHOLD_MS) console.info(`[wxdata] ${key} ${ms.toFixed(0)}ms`)
  }
}

/**
 * 埋点阈值（毫秒）。250ms 是「用户还能觉得是瞬时的」上界 —— 超过它就该有记录。
 *
 * 为什么导出：阈值是**判据的一部分**，测试要能按它构造边界用例而不抄一个数字。
 * 抄数字的后果是改阈值时守卫照旧绿（判据与实现脱钩，典型的假守卫）。
 */
export const TIMED_FETCH_THRESHOLD_MS = 250

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
