/**
 * embedding 落盘缓存（W3-6.2）。
 *
 * **它存在的原因**：同一段文本会被反复送去算向量 ——
 *   ① `searchDense` 每次提问都要算查询词的向量（问相似的问题就是重复付费）；
 *   ② 知识库抽取与链接建议的正文、标题重复率很高；
 *   ③ 「重建向量索引」会把同一批唯一文本（实测 15.2 万行里 56.5% 重复，约 6.6 万条）
 *      原封不动再发一遍。
 *
 * **位置为什么在隐私闸之后**（这一条是红线，不是风格问题）：
 * 缓存里存的是「**已经脱敏过**的文本对应的向量」。如果改成缓存脱敏**前**的向量，
 * 那么用户在「关掉脱敏」时建出来的向量会在「打开脱敏」之后被原样取用，
 * 而审计表会如实记着「已脱敏」—— 脱敏口径与出网审计当场分叉。
 * 所以键里带命名空间：`r` = 脱敏开，`p` = 脱敏关，两个命名空间的条目物理上不互通。
 * 工厂侧读这个口径的位置见 `gateway-llm-factory.ts` 的 `LlmFactoryDeps.redactMode`。
 *
 * **命中为什么不过闸、也不写审计**：命中意味着这一次**没有任何字节离开本机**。
 * 写一条出网审计就是把没发生过的事记成发生过 ——「出网审计口径不变」正是这个意思。
 *
 * **句柄为什么每次开关**：本仓有一条 Windows 硬纪律（`query-db-lifetime.spec.ts`：
 * 没关的 SQLite 句柄会让整个数据根再也换不掉）。缓存库就落在数据根里，留一个常驻句柄
 * 等于把那条纪律破掉，而这里又是最容易被漏掉的地方（平时只在 batch 级别被摸到）。
 * 代价是每次开库几毫秒，而 batch 之间本来就隔着几秒的网络。
 *
 * **上限**：缓存是派生数据，必须有上界。默认 64 MiB（`DSH_WECHAT_EMBED_CACHE_MB` 可覆盖），
 * 超了按最久未用淘汰。一条 1024 维向量约 4KB，64MiB 装一万五千条 ——
 * 覆盖「重复提问 + 知识库 + 增量重建」；全量重建覆盖不满（那本来也是一天一次的动作）。
 */
import { DatabaseSync } from './db-open.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { retrievalRoot } from './retrieval/config.ts'

/** 缓存库 schema 版本：键的算法或向量存法变了就整库作废（宁可重算，不要错配）。 */
const CACHE_SCHEMA_VERSION = '1'

/** 默认体积上限（MiB）。 */
const DEFAULT_MAX_MB = 64

/**
 * 缓存库体积上限（字节）。
 *
 * env `DSH_WECHAT_EMBED_CACHE_MB` 覆盖，夹在 [1, 1024] MiB；非数值/≤0 回落默认。
 * 注意**没有「0 = 关闭」这一档**：想要真关掉，把上限设成 1 MiB 即可（缓存会持续被淘汰，
 * 等于没有），不必为它单开一条语义。
 * @returns 字节上限。
 */
export function embedCacheMaxBytes(): number {
  const raw = Number(process.env.DSH_WECHAT_EMBED_CACHE_MB ?? '')
  const mb = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_MB
  return Math.min(mb, 1024) * 1024 * 1024
}

/** 缓存库文件路径（与 `wechat_search.db` / `wechat_rag_vectors.db` 同级）。 */
export function embedCachePath(decryptedDir: string): string {
  return join(retrievalRoot(decryptedDir), 'wechat_embed_cache.db')
}

/**
 * 缓存键：`sha256(命名空间 ␀ 模型 ␀ 文本)`。
 *
 * 三段都必要：命名空间切分脱敏口径（见文件头），模型名切分模型（换模型后旧向量的
 * 维度与语义都不兼容），文本本身才是被缓存的东西。段间用 `\u0000` 分隔，
 * 免得 `ns='a'`+`model='bc'` 与 `ns='ab'`+`model='c'` 拼成同一串。
 * @param ns - 命名空间：`r` = 脱敏开，`p` = 脱敏关。
 * @param model - 向量模型名（空串表示由桥按默认发）。
 * @param text - 送出去的那份文本（脱敏开时已经是副本）。
 * @returns 十六进制键。
 */
export function embedCacheKey(ns: string, model: string, text: string): string {
  return createHash('sha256').update(ns).update('\u0000').update(model).update('\u0000').update(text).digest('hex')
}

/**
 * 一次缓存库操作（开 → 干活 → 关），**读路径用只读连接**。
 * @param p - 缓存库路径。
 * @param ro - 是否只读（只读时文件不存在直接放弃，不会凭空造一个空库出来）。
 * @param fn - 拿到句柄干活。
 * @returns `fn` 的返回值；库打不开时 undefined。
 */
function withCache<T>(p: string, ro: boolean, fn: (db: DatabaseSync) => T): T | undefined {
  if (embedCacheMaxBytes() <= 0) return undefined
  if (ro && !existsSync(p)) return undefined
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(p, ro ? { readOnly: true } : {})
    return fn(db)
  } catch {
    // 缓存是纯优化：库打不开（只读目录 / 磁盘满 / 文件损坏 / 并发占用）就当没有缓存，
    // 不能让 embedding 这条主路因此失败。
    return undefined
  } finally {
    if (db) { try { db.close() } catch { /* 已关 */ } }
  }
}

/** 首次使用（或 schema 版本变化）时建表；已存在则什么都不做。 */
function ensureSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL, used_at INTEGER NOT NULL)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_used ON cache(used_at)')
  const ver = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as { value?: string } | undefined
  if ((ver?.value ?? '') !== CACHE_SCHEMA_VERSION) {
    // 版本不符（键算法或存法变了）：整库作废后重建。派生数据，重算的代价只是几次请求。
    db.exec('DELETE FROM cache')
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('schema_version', CACHE_SCHEMA_VERSION)
  }
}

/**
 * 查一批键，返回**全部命中**的向量。
 *
 * 只在整批都命中时给结果（`null` 表示「有未命中」）：批内文本本来就由调用方去重过，
 * 命中与否都要再走一次闸门写审计，做「一半命中一半出网」的分支只会让审计的
 * `messages` 数与实际出网量对不上 —— 宁可整批重来。
 * @param decryptedDir - 解密数据根。
 * @param keys - 与 `texts` 同序的键。
 * @returns 与 `keys` 同序的向量；有任何一条缺失、维度不齐或字节对不上就返回 null。
 */
export function lookupEmbedCache(decryptedDir: string, keys: string[]): number[][] | null {
  if (keys.length === 0) return []
  const p = embedCachePath(decryptedDir)
  const now = Date.now()
  return withCache(p, true, (db) => {
    const stmt = db.prepare('SELECT vec, dim FROM cache WHERE key=?')
    const out: number[][] = []
    let dim0 = 0
    for (const k of keys) {
      const row = stmt.get(k) as { vec?: Uint8Array; dim?: number } | undefined
      if (!row?.vec) return null
      const dim = Number(row.dim ?? 0)
      // 字节数对不上说明文件被截断/手工改过：这一条不可信，整批当未命中。
      if (dim <= 0 || row.vec.byteLength !== dim * 4) return null
      if (dim0 === 0) dim0 = dim
      else if (dim0 !== dim) return null
      out.push(blobToVec(row.vec, dim))
    }
    touchUsed(db, keys, now)
    return out
  }) ?? null
}

/**
 * 写回一批向量（best-effort，失败只影响下次的命中率）。
 *
 * 只在**维度齐一**时写：同一批里混进两种维度说明上游返回了不一致的结果，那种情况下
 * 宁可一条都不缓存 —— 下次还会重算，而错配的维度会一路写进向量库。
 * @param decryptedDir - 解密数据根。
 * @param keys - 与 `vectors` 同序的键。
 * @param vectors - 与 `keys` 同序的向量。
 */
export function storeEmbedCache(decryptedDir: string, keys: string[], vectors: number[][]): void {
  if (keys.length === 0 || keys.length !== vectors.length) return
  let dim = 0
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0) return
    if (dim === 0) dim = v.length
    else if (dim !== v.length) return
  }
  const p = embedCachePath(decryptedDir)
  withCache(p, false, (db) => {
    mkdirSync(dirname(p), { recursive: true })
    ensureSchema(db)
    const now = Date.now()
    const ins = db.prepare('INSERT OR REPLACE INTO cache(key, dim, vec, used_at) VALUES(?,?,?,?)')
    db.exec('BEGIN')
    try {
      for (let i = 0; i < keys.length; i += 1) {
        const v = vectors[i]
        if (!v) continue
        ins.run(keys[i] as string, dim, vecToBlob(v), now)
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 无事务 */ }
      throw e
    }
    pruneCache(db, p)
  })
}

/** 删掉整个缓存库文件（「清除缓存」与用户手动清理用）。 */
export function dropEmbedCache(decryptedDir: string): void {
  try { rmSync(embedCachePath(decryptedDir), { force: true }) } catch { /* 没有就算了 */ }
}

/** 命中即「最近用过」：只更新时钟，不重写向量。 */
function touchUsed(db: DatabaseSync, keys: string[], now: number): void {
  try {
    const up = db.prepare('UPDATE cache SET used_at=? WHERE key=?')
    db.exec('BEGIN')
    for (const k of keys) up.run(now, k)
    db.exec('COMMIT')
  } catch {
    // 只读连接下更新会失败；时钟更新失败不影响读出来的结果。
  }
}

/**
 * 体积超限时按最久未用淘汰。
 *
 * 用条目总字节而不是行数做判据：向量大小随维度走（1024 维 4KB、3072 维 12KB），
 * 行数上限在换模型前后含义完全不同。删完不 `VACUUM` —— 那要重写整个文件，
 * 而缓存本来就是「丢了就重算」的东西，把文件还给操作系统不值得一次全表重写。
 * @param db - 缓存库句柄（读写连接）。
 * @param p - 缓存库路径（估体积用）。
 */
function pruneCache(db: DatabaseSync, p: string): void {
  const maxBytes = embedCacheMaxBytes()
  try {
    const avg = Number((db.prepare('SELECT AVG(LENGTH(vec)) AS a FROM cache').get() as { a?: number } | undefined)?.a ?? 0)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM cache').get() as { c: number }).c
    if (!Number.isFinite(avg) || avg <= 0 || count === 0) return
    if (count * avg <= maxBytes && fileBytes(p) <= maxBytes) return
    const drop = Math.max(1, Math.ceil((count * avg - maxBytes) / avg))
    db.prepare('DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY used_at ASC, key ASC LIMIT ?)').run(drop)
  } catch {
    // 淘汰失败只是让文件偏大，不会让功能出错。
  }
}

function fileBytes(p: string): number {
  try { return existsSync(p) ? statSync(p).size : 0 } catch { return 0 }
}

/** float32 → 小端字节序。 */
function vecToBlob(v: number[]): Uint8Array {
  const out = new Uint8Array(v.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < v.length; i += 1) view.setFloat32(i * 4, v[i] as number, true)
  return out
}

/** 小端字节序 → float 数组。 */
function blobToVec(b: Uint8Array, dim: number): number[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: number[] = new Array(dim)
  for (let i = 0; i < dim; i += 1) out[i] = view.getFloat32(i * 4, true)
  return out
}

/** 测试接缝：只放「真实入口拿不到」的纯函数。 */
export const __internals = { vecToBlob, blobToVec }