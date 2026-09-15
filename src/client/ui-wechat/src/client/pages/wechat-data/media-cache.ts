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
const MEDIA_MAX_ENTRIES = 4000
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

/** 删除超出容量上限的最旧条目（按写入时间 at 升序）。 */
export async function trimMediaCache(db: IDBDatabase): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly')
      const store = tx.objectStore(MEDIA_STORE)
      const keysReq = store.getAllKeys()
      const valsReq = store.getAll()
      let keys: IDBValidKey[] = []
      let vals: Array<{ url: string; at: number }> = []
      keysReq.onsuccess = () => { keys = keysReq.result }
      valsReq.onsuccess = () => { vals = valsReq.result as Array<{ url: string; at: number }> }
      tx.oncomplete = () => {
        if (keys.length <= MEDIA_MAX_ENTRIES) { resolve(); return }
        const rows = keys.map((key, i) => ({ key, at: vals[i]?.at ?? 0 })).sort((a, b) => a.at - b.at)
        const drop = rows.slice(0, keys.length - MEDIA_MAX_ENTRIES)
        if (drop.length === 0) { resolve(); return }
        const dtx = db.transaction(MEDIA_STORE, 'readwrite')
        for (const d of drop) dtx.objectStore(MEDIA_STORE).delete(d.key)
        dtx.oncomplete = () => { resolve() }
        dtx.onerror = () => { resolve() }
      }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

/** Read one cached decrypted media data URL by key, or null. */
export async function snsMediaCacheGet(key: string): Promise<string | null> {
  try {
    const db = await openMediaDb()
    return await new Promise<string | null>((resolve) => {
      const req = db.transaction(MEDIA_STORE, 'readonly').objectStore(MEDIA_STORE).get(key)
      req.onsuccess = () => {
        const r = req.result as { url?: string } | undefined
        resolve(typeof r?.url === 'string' ? r.url : null)
      }
      req.onerror = () => { resolve(null) }
    })
  } catch { return null }
}

/** Batch-read cached media data URLs for the given keys. */
export async function snsMediaCacheGetMany(keys: readonly string[]): Promise<Record<string, string>> {
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
          const r = req.result as { url?: string } | undefined
          if (typeof r?.url === 'string') out[k] = r.url
        }
      }
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
  return out
}

/** Persist one decrypted media data URL. */
export async function snsMediaCacheSet(key: string, url: string): Promise<void> {
  try {
    const db = await openMediaDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readwrite')
      tx.objectStore(MEDIA_STORE).put({ url, at: Date.now() }, key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { resolve() }
    })
  } catch { /* best-effort */ }
}

