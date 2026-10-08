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
    const req = indexedDB.open(MEDIA_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE).createIndex('by_at', 'at')
      }
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
  /** 取这条时后端给的 `thumb`；缺省/false 视为原图。 */
  thumb?: boolean
  /** 该条的字节占用（base64 串长度 ≈ 内存字节数）。旧记录没有这个字段 ⇒ 退化为按 url 长度估算。 */
  size?: number
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
        if (wantOriginal && r.thumb === true) { resolve(null); return }
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
          if (wantOriginal && r.thumb === true) return
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
      tx.objectStore(MEDIA_STORE).put({ url, at: Date.now(), thumb, size: url.length } satisfies MediaEntry, key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

