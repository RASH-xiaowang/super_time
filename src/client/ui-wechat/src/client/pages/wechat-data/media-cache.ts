/**
 * 解密媒体持久化缓存（IndexedDB）
 *
 * localStorage 装不下 base64 大图，所以朋友圈已解密的图片/视频封面存 IndexedDB，
 * 跨会话复用；容量超限时按写入时间淘汰。
 *
 * M21：从 api.ts 拆出（纯搬移，逐字未改），api.ts 继续转发这些导出，
 * 因此 40 多个面板的 import 路径都不用动。拆分是否等值由
 * `api-module-split.spec.ts` 的搬移一致性断言守住。
 */

// ── 解密媒体持久化缓存（IndexedDB）：已解密的朋友圈图片/视频封面跨会话复用，
//    避免下次进入朋友圈再次并发解密。localStorage 容量不足以存 base64 大图。 ──
const MEDIA_DB_NAME = 'dsh-wechat-media'
const MEDIA_STORE = 'sns-images'
/**
 * 库版本。**改动条目语义时必须 +1**，升级时旧条目会被整体清掉。
 *
 * 2026-10-08 从 1 升到 2：v1 的条目里，**92% 是「EOI 距末尾 24 字节」的图**
 * （真机清点：1186 条里 1093 条如此，合计 331 MB）—— 那是后端**修好结尾判据之前**
 * 存进去的字节。更麻烦的是它们**没有 `thumb` 字段**，与「原图」无法区分，
 * 于是 `wantOriginal` 拦不住它们：一格一旦从 v1 缓存里恢复出这样一张图，
 * `<img>` 解不开 ⇒ 永远显示「图片加载失败」，而错误文案还会指向「本地缓存没找到」。
 * 这类条目没法靠字段补救，只能整体作废让后端重取。
 */
const MEDIA_DB_VERSION = 2
/** 条目自身的语义版本：读的时候要求 `v >= MEDIA_DB_VERSION`，否则当没有。 */
const MEDIA_ENTRY_V = 2
/**
 * 容量上限（字节），默认 512 MB。
 *
 * 2026-10-08 从「条数」改成「字节」：原先按 4000 条淘汰，但朋友圈原图普遍 200–800 KB、
 * base64 之后还要再胀 4/3 ⇒ 4000 条就是几个 GB，而 IndexedDB 的配额远没那么富裕 ——
 * 配额一到，写入会**静默失败**（`tx.onerror` 里就 `resolve()` 了），于是「缓存」形同虚设，
 * 症状是每次进入都在重解。按字节算才与真实占用对上。
 */
const MEDIA_MAX_BYTES = 512 * 1024 * 1024
let mediaDb: Promise<IDBDatabase> | null = null

export function openMediaDb(): Promise<IDBDatabase> {
  if (mediaDb) return mediaDb
  mediaDb = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB unavailable')); return }
    const req = indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      const tx = req.transaction
      // 类型上 createObjectStore 的返回值是 IDBObjectStore，取已有 store 时是联合类型 ——
      // 这里显式收窄，因为只有 objectStore 才有 clear()
      const store: IDBObjectStore = db.objectStoreNames.contains(MEDIA_STORE)
        ? (tx!.objectStore(MEDIA_STORE) as IDBObjectStore)
        : (db.createObjectStore(MEDIA_STORE).createIndex('by_at', 'at') as unknown as IDBObjectStore)
      // 跨版本升级 ⇒ 旧条目一律作废。它们的字段含义已经变了（没有 v/thumb/size），
      // 留着只能靠猜，猜错就是把一张渲染不了的图永久缓存下来。
      if (ev.oldVersion > 0 && ev.oldVersion < MEDIA_DB_VERSION) store.clear()
    }
    req.onsuccess = () => { resolve(req.result); void trimMediaCache(req.result) }
    req.onerror = () => { mediaDb = null; reject(req.error ?? new Error('open media db failed')) }
  })
  return mediaDb
}

/** 一条缓存记录。`thumb` 记的是「这不是原图」，用来让原图能覆盖它（见 {@link snsMediaCacheGet}）。 */
interface MediaEntry {
  url: string
  at: number
  /** 语义版本；旧条目（v1）没有这个字段 ⇒ 读的时候当作过期。 */
  v?: number
  /** 取这条时后端给的 `thumb`；缺省/false 视为原图。 */
  thumb?: boolean
  /** 该条的字节占用（base64 串长度 ≈ 内存字节数）。旧记录没有这个字段 ⇒ 退化为按 url 长度估算。 */
  size?: number
}

/** 这条记录是不是当前语义下的（能当原图用）。v1 的条目一律不算 —— 见 {@link MEDIA_ENTRY_V}。 */
function isCurrent(e: MediaEntry | undefined): boolean {
  return typeof e?.v === 'number' && e.v >= MEDIA_ENTRY_V
}

/** 记录占用的字节数。旧记录没有 `size`，按 url 长度估算（base64 字符串的字符数就是它的大小）。 */
function entrySize(e: MediaEntry | undefined): number {
  if (!e) return 0
  return typeof e.size === 'number' && e.size > 0 ? e.size : e.url.length
}

/**
 * 删除超出容量上限的**最旧**条目（按写入时间 `at` 升序），直到总量落到预算内。
 *
 * 为什么按字节而不是条数：见 {@link MEDIA_MAX_BYTES}。按条数会让大图把配额吃光而写入
 * 静默失败，按字节才能保证「攒下来的东西真的还在」。
 */
export async function trimMediaCache(db: IDBDatabase): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly')
      const store = tx.objectStore(MEDIA_STORE)
      const keysReq = store.getAllKeys()
      const valsReq = store.getAll()
      let keys: IDBValidKey[] = []
      let vals: MediaEntry[] = []
      keysReq.onsuccess = () => { keys = keysReq.result }
      valsReq.onsuccess = () => { vals = valsReq.result as MediaEntry[] }
      tx.oncomplete = () => {
        const rows = keys.map((key, i) => ({ key, at: vals[i]?.at ?? 0, size: entrySize(vals[i]) }))
        let total = rows.reduce((n, r) => n + r.size, 0)
        if (total <= MEDIA_MAX_BYTES || rows.length === 0) { resolve(); return }
        rows.sort((a, b) => a.at - b.at)
        const dtx = db.transaction(MEDIA_STORE, 'readwrite')
        for (const r of rows) {
          if (total <= MEDIA_MAX_BYTES) break
          dtx.objectStore(MEDIA_STORE).delete(r.key)
          total -= r.size
        }
        dtx.oncomplete = () => { resolve() }
        dtx.onerror = () => { resolve() }
      }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

/**
 * Read one cached decrypted media data URL by key, or null.
 *
 * @param key - 媒体键。
 * @param wantOriginal - 传 `true` 时，**缩略图条目当作未命中**。
 *   这是「每次进入自动用高清原图覆盖缩略图」在前端这一半的落点：老版本存下来的条目
 *   只有 `{url, at}`，里面可能就是缩略图，而且会**永久遮住**后来才取到的高清图。
 *   当成未命中 ⇒ 这一轮重新去后端要原图，取到后覆盖写回去。
 */
export async function snsMediaCacheGet(key: string, wantOriginal = false): Promise<string | null> {
  try {
    const db = await openMediaDb()
    return await new Promise<string | null>((resolve) => {
      const req = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(key)
      req.onsuccess = () => {
        const r = req.result as MediaEntry | undefined
        if (typeof r?.url !== 'string') { resolve(null); return }
        if (wantOriginal && (r.thumb === true || !isCurrent(r))) { resolve(null); return }
        resolve(r.url)
      }
      req.onerror = () => { resolve(null) }
    })
  } catch { return null }
}

/**
 * Batch-read cached media data URLs for the given keys.
 *
 * @param keys - 媒体键列表。
 * @param wantOriginal - 同 {@link snsMediaCacheGet}：为真时跳过缩略图条目。
 */
export async function snsMediaCacheGetMany(keys: readonly string[], wantOriginal = false): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (keys.length === 0) return out
  try {
    const db = await openMediaDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly')
      const store = tx.objectStore(MEDIA_STORE)
      for (const k of keys) {
        const req = store.get(k)
        req.onsuccess = () => {
          const r = req.result as MediaEntry | undefined
          if (typeof r?.url !== 'string') return
          if (wantOriginal && (r.thumb === true || !isCurrent(r))) return
          out[k] = r.url
        }
      }
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
  return out
}

/**
 * Persist one decrypted media data URL.
 *
 * @param key - 媒体键。
 * @param url - data URL。
 * @param thumb - 后端标注的「这次给的是缩略图」。落进记录里，好让下一轮要原图时跳过它。
 */
export async function snsMediaCacheSet(key: string, url: string, thumb = false): Promise<void> {
  try {
    const db = await openMediaDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readwrite')
      tx.objectStore(MEDIA_STORE).put({ url, at: Date.now(), v: MEDIA_ENTRY_V, thumb, size: url.length } satisfies MediaEntry, key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

