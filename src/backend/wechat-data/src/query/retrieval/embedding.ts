/**
 * 稠密检索通道（目标 1 的「稀疏+稠密混合」）。
 *
 * 设计取舍（关键）：
 *
 * 1) **语料来源**：向量库直接读 `wechat_search.db` 的 `message_meta`（稀疏索引已建好的
 *    同一份文本），而不是重新扫消息分片。好处是稀疏与稠密两条通道**看到完全相同的文档集**
 *    与 docKey，融合阶段不会出现「同一消息两个 id」的重复。首次提问会先建稀疏索引、
 *    再基于它建向量索引，天然串行复用。
 *
 * 2) **隐私边界**：稠密需要把文本发给 embedding 接口 —— 这是**在原有基础上新增的出网点**，
 *    因此调用方（gateway）必须让它与 chat 出站一样过隐私闸门。本模块自身不做网络决策，
 *    只接收注入的 `EmbedFn`，是否允许出网由上层配置决定。
 *
 * 3) **向量库位置**：`<数据根>/wechat_rag_vectors.db`，与稀疏索引同级，随数据目录一起迁移/删除。
 *
 * 4) **检索提速**：全量精确余弦对 13 万条太慢，因此每个向量存一个 **SimHash 签名**
 *    （64 位），查询时先按汉明距离粗筛出 candidatePool 条，再对幸存者做精确余弦。
 *    SimHash 由固定种子随机超平面生成，索引与查询两侧一致，无需额外依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RetrievedDoc } from './types.ts'
import { retrievalRoot } from './config.ts'
import { searchIndexPath } from '../search.ts'

/** 向量库 schema 版本；结构或哈希算法变化时自动重建。 */
const VECTOR_SCHEMA_VERSION = '1'

/** 一次 embedding 请求的函数签名（由 gateway 注入，内部走 ctx.llm.embed）。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

/** 向量库状态。 */
export interface VectorIndexStatus {
  exists: boolean
  rows: number
  dim: number
  model: string
  built_at: string | null
  ready: boolean
}

/** 稠密召回选项。 */
export interface DenseSearchOptions {
  topK: number
  /** 低于该余弦相似度直接丢弃。 */
  minSimilarity: number
  /** SimHash 粗筛保留多少条参与精确计算。 */
  candidatePool: number
  username?: string
}

/** 向量库文件路径。 */
export function vectorDbPath(decryptedDir: string): string {
  return join(retrievalRoot(decryptedDir), 'wechat_rag_vectors.db')
}

/** 读取 meta 表的一个键。 */
function readMeta(db: DatabaseSync, key: string): string {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined
    return row?.value ?? ''
  } catch {
    return ''
  }
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(key, value)
}

/** 打开（并初始化）向量库。 */
function openVectorDb(decryptedDir: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(vectorDbPath(decryptedDir), readOnly ? { readOnly: true } : {})
  if (!readOnly) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS vectors ('
      + 'fts_rowid INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, username TEXT NOT NULL, '
      + 'local_id INTEGER NOT NULL, create_time INTEGER NOT NULL, dim INTEGER NOT NULL, '
      + 'vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_vectors_doc ON vectors(doc_key)')
  }
  return db
}

/** 向量库状态（不存在/损坏/版本不符时 ready=false）。 */
export function vectorIndexStatus(decryptedDir: string): VectorIndexStatus {
  const p = vectorDbPath(decryptedDir)
  if (!existsSync(p)) return { exists: false, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
    const dim = Number(readMeta(db, 'dim') || 0)
    const model = readMeta(db, 'model')
    const built = readMeta(db, 'built_at') || null
    const ver = readMeta(db, 'schema_version')
    db.close()
    return { exists: true, rows, dim, model, built_at: built, ready: rows > 0 && dim > 0 && ver === VECTOR_SCHEMA_VERSION }
  } catch {
    return { exists: true, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  }
}

// ── SimHash 随机超平面（按维度缓存；同一维度内进程生命周期内复用）──
const PLANES_CACHE = new Map<number, Int8Array[]>()
const SIMHASH_BITS = 64

/** xorshift32 PRNG（确定性，保证索引/查询两侧同一维度的超平面一致）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s >>> 0
  }
}

/** 生成 SIMHASH_BITS 个随机超平面（每个长度 = dim）。 */
function getPlanes(dim: number): Int8Array[] {
  const cached = PLANES_CACHE.get(dim)
  if (cached) return cached
  const rng = makeRng(dim * 2654435761)
  const planes: Int8Array[] = []
  for (let b = 0; b < SIMHASH_BITS; b += 1) {
    const p = new Int8Array(dim)
    // 用 ±1 而非高斯：乘加更快，SimHash 性质足够（随机超平面的符号投影）。
    for (let i = 0; i < dim; i += 1) p[i] = (rng() & 1) ? 1 : -1
    planes.push(p)
  }
  PLANES_CACHE.set(dim, planes)
  return planes
}

/** 计算向量的 64 位 SimHash（返回两个 32 位无符号整数表示的高/低位）。 */
function simhash(vec: Float32Array, planes: Int8Array[]): { lo: number; hi: number } {
  let lo = 0
  let hi = 0
  const dim = vec.length
  for (let b = 0; b < planes.length; b += 1) {
    const p = planes[b]
    let dot = 0
    for (let i = 0; i < dim; i += 1) dot += p[i] * vec[i]
    if (dot >= 0) {
      if (b < 32) lo |= (1 << b)
      else hi |= (1 << (b - 32))
    }
  }
  return { lo: lo >>> 0, hi: hi >>> 0 }
}

/** popcount（32 位）。 */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}

/** L2 归一化（余弦相似度 → 点积）。 */
function l2normalize(v: number[]): Float32Array {
  const f = Float32Array.from(v)
  let n = 0
  for (let i = 0; i < f.length; i += 1) n += f[i] * f[i]
  n = Math.sqrt(n)
  if (n > 1e-9) for (let i = 0; i < f.length; i += 1) f[i] /= n
  return f
}

/** Float32Array → BLOB 字节。 */
function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

/** BLOB 字节 → Float32Array（复制，避免引用底层 buffer 被复用）。 */
function blobToVec(b: Uint8Array, dim: number): Float32Array {
  const copy = new Uint8Array(dim * 4)
  copy.set(b.subarray(0, dim * 4))
  return new Float32Array(copy.buffer)
}

/** docKey = `username:local_id`（与稀疏通道一致的去重键）。 */
function docKeyOf(username: string, localId: number): string {
  return username + ':' + localId
}

/** 从 message_meta 行构造统一文档。 */
function docFromRow(r: Record<string, unknown>): RetrievedDoc {
  const text = String(r['text'] ?? '')
  const username = String(r['username'] ?? '')
  return {
    docKey: docKeyOf(username, Number(r['local_id'] ?? 0)),
    username,
    name: String(r['name'] ?? username),
    local_id: Number(r['local_id'] ?? 0),
    create_time: Number(r['create_time'] ?? 0),
    text,
    snippet: text.slice(0, 120),
  }
}

/**
 * 构建/增量更新向量索引。
 *
 * 增量策略：以 message_meta.rowid 为游标，只给尚未入库的行算向量。
 * 这样日常「新消息进来」只多算增量，不重算全库（全量 13.5 万条 ≈ 上万次 embedding，
 * 一次性做完会很久；增量后单次通常只有几十条）。
 * @param decryptedDir - 解密数据根。
 * @param embed - embedding 函数（上层注入，已含隐私判断）。
 * @param opts - 模型名 / 批量 / 单次上限等。
 * @returns 构建结果。
 */
export async function buildVectorIndex(
  decryptedDir: string,
  embed: EmbedFn,
  opts: { model: string; batchSize: number; maxCharsPerDoc: number; maxDocsPerBuild: number; onProgress?: (done: number, total: number) => void; force?: boolean },
): Promise<{ status: string; rows: number; embedded: number; elapsed_ms: number; message?: string }> {
  const started = Date.now()
  const src = searchIndexPath(decryptedDir)
  if (!existsSync(src)) {
    return { status: 'no-source', rows: 0, embedded: 0, elapsed_ms: 0, message: '稀疏索引不存在，请先建索引' }
  }
  const db = openVectorDb(decryptedDir, false)
  try {
    const prevModel = readMeta(db, 'model')
    const prevVer = readMeta(db, 'schema_version')
    if (opts.force || (prevVer && prevVer !== VECTOR_SCHEMA_VERSION)) {
      db.exec('DELETE FROM vectors')
    }
    if (opts.force || (prevModel && prevModel !== opts.model)) {
      // 换模型 → 旧向量维度/语义都不兼容，整体重建。
      db.exec('DELETE FROM vectors')
    }
    const done = new Set<number>()
    for (const row of db.prepare('SELECT fts_rowid FROM vectors').all() as Array<{ fts_rowid: number }>) {
      done.add(Number(row.fts_rowid))
    }

    const sdb = new DatabaseSync(src, { readOnly: true })
    const rows = sdb.prepare(
      'SELECT m.rowid AS rid, m.text AS text, m.username AS username, m.local_id AS local_id, m.create_time AS create_time '
      + 'FROM message_meta m ORDER BY m.rowid',
    ).all() as Array<Record<string, unknown>>
    sdb.close()

    const pending = rows.filter(r => !done.has(Number(r['rid']))).slice(0, opts.maxDocsPerBuild)
    if (pending.length === 0) {
      writeMeta(db, 'schema_version', VECTOR_SCHEMA_VERSION)
      writeMeta(db, 'built_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
      return { status: 'up-to-date', rows: done.size, embedded: 0, elapsed_ms: Date.now() - started }
    }

    const ins = db.prepare('INSERT OR REPLACE INTO vectors(fts_rowid, doc_key, username, local_id, create_time, dim, vec, hash_lo, hash_hi) VALUES(?,?,?,?,?,?,?,?,?)')
    let embedded = 0
    let dim = 0
    db.exec('BEGIN')
    try {
      for (let i = 0; i < pending.length; i += opts.batchSize) {
        const slice = pending.slice(i, i + opts.batchSize)
        const texts = slice.map(r => String(r['text'] ?? '').slice(0, opts.maxCharsPerDoc))
        const vecs = await embed(texts)
        for (let j = 0; j < slice.length; j += 1) {
          const raw = vecs[j]
          if (!raw || raw.length === 0) continue
          const v = l2normalize(raw)
          dim = v.length
          const h = simhash(v, getPlanes(dim))
          const r = slice[j]
          const username = String(r['username'] ?? '')
          const localId = Number(r['local_id'] ?? 0)
          ins.run(
            Number(r['rid']), docKeyOf(username, localId), username, localId,
            Number(r['create_time'] ?? 0), dim, vecToBlob(v), h.lo, h.hi,
          )
          embedded += 1
        }
        opts.onProgress?.(Math.min(i + opts.batchSize, pending.length), pending.length)
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* no tx */ }
      throw e
    }
    const total = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
    writeMeta(db, 'schema_version', VECTOR_SCHEMA_VERSION)
    writeMeta(db, 'model', opts.model)
    if (dim > 0) writeMeta(db, 'dim', String(dim))
    writeMeta(db, 'built_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
    return { status: 'ok', rows: total, embedded, elapsed_ms: Date.now() - started }
  } finally {
    db.close()
  }
}

// ── 内存粗筛表缓存：(dbPath, mtime) → {rowid, lo, hi}[] ──
interface HashRow { rowid: number; lo: number; hi: number; username: string }
const HASH_CACHE = new Map<string, { sig: string; rows: HashRow[] }>()

/** 汉明距离的上界：两个 32 位 popcount 相加，最大 64。 */
const MAX_HAMMING = 64

/**
 * 按汉明距离取前 `pool` 个候选（稠密通道的粗筛）。
 *
 * 为什么不用 `map(...).sort(...).slice(...)`：粗筛表通常是**十几万行**（本地实测 13.5 万；
 * 另一处 `.all()` 的实测是 20 万行），而每个查询都要为每一行分配一个 `{r, d}` 对象、
 * 再做一次 O(N log N) 的**比较排序** —— 可是我们要的只是**前 pool 名**（pool 是几十到几百）。
 * 这里换成计数选择（计数排序的特例）：
 *   ① 一遍算距离，存进 `Uint8Array`（距离恒在 [0,64]，一字节够）并累加 65 格直方图；
 *   ② 用直方图找出「累计条数 ≥ pool」的那个距离 `limit`；
 *   ③ 再做一遍计数排序，把 `d <= limit` 的行按 **(距离升序, 原顺序)** 落位。
 *
 * 选出来的序列与「全量按距离升序排序后取前 pool」**逐项相同**（含同距离内的先后，
 * 因为计数排序是稳定的）—— 差别只在代价：零逐行分配、无比较排序、两次线性扫描。
 * `pool >= N` 时退化为整表，与原来一致。
 * @param rows - 粗筛表（`loadHashRows` 的结果）。
 * @param qh - 查询向量的 simhash。
 * @param pool - 要取多少个候选。
 * @returns 候选行（距离升序；同距离保持原表顺序）。
 */
function selectByHamming(rows: readonly HashRow[], qh: { lo: number; hi: number }, pool: number): HashRow[] {
  const n = rows.length
  // pool 来自配置（`rag-config.json` 可手改，`deepMerge` 不做数值校验）：非有限值/小数/负数
  // 都要归一到安全整数。旧实现靠 `slice` 天然容忍（`slice(0, 2000.5)` 截断成 2000、
  // `slice(0, NaN)` 得空数组），而 `new Array(take)` 遇非整数会直接抛 RangeError。
  // `Infinity` 要保留「取整表」的含义（`Math.floor(Infinity)` 仍是 Infinity，再被 min 夹到 n）——
  // 别把它和 NaN 一起归零，那会与旧行为分叉。**唯一有意的分歧**：负数的 pool 旧实现是
  // `slice(0, -k)`（返回「全部去掉后 k 条」，显然是笔误产物），新实现按 0 处理（返回空）。
  const want = Number.isNaN(pool) ? 0 : Math.floor(pool)
  const take = Math.min(Math.max(want, 0), n)
  if (take <= 0) return []
  const dist = new Uint8Array(n)
  const hist = new Uint32Array(MAX_HAMMING + 1)
  for (let i = 0; i < n; i += 1) {
    const r = rows[i]
    const d = popcount32((r.lo ^ qh.lo) >>> 0) + popcount32((r.hi ^ qh.hi) >>> 0)
    dist[i] = d
    hist[d] += 1
  }
  let limit = MAX_HAMMING
  let cum = 0
  for (let d = 0; d <= MAX_HAMMING; d += 1) {
    cum += hist[d]
    if (cum >= take) { limit = d; break }
  }
  // 计数排序（只排到 limit 组）：先算每组起始偏移，再按原顺序落位 —— 稳定。
  const cursor = new Uint32Array(limit + 2)
  let acc = 0
  for (let d = 0; d <= limit; d += 1) { cursor[d] = acc; acc += hist[d] }
  const order = new Uint32Array(acc)
  const next = cursor.slice()
  for (let i = 0; i < n; i += 1) {
    const d = dist[i]
    if (d <= limit) order[next[d]++] = i
  }
  const out: HashRow[] = new Array(take)
  for (let k = 0; k < take; k += 1) out[k] = rows[order[k]]
  return out
}

function loadHashRows(decryptedDir: string): HashRow[] {
  const p = vectorDbPath(decryptedDir)
  const sig = String(statSig(p))
  const hit = HASH_CACHE.get(p)
  if (hit && hit.sig === sig) return hit.rows
  const db = new DatabaseSync(p, { readOnly: true })
  const rows = (db.prepare('SELECT fts_rowid, hash_lo, hash_hi, username FROM vectors').all() as Array<Record<string, unknown>>)
    .map(r => ({
      rowid: Number(r['fts_rowid']),
      lo: Number(r['hash_lo']) >>> 0,
      hi: Number(r['hash_hi']) >>> 0,
      username: String(r['username'] ?? ''),
    }))
  db.close()
  HASH_CACHE.set(p, { sig, rows })
  return rows
}

/** 文件 mtime+size 指纹（粗筛表缓存的失效依据）。 */
function statSig(p: string): string {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 稠密召回：SimHash 粗筛 → 精确余弦 → topK。
 * @param decryptedDir - 解密数据根。
 * @param queryText - 查询文本（原句）。
 * @param embed - embedding 函数。
 * @param opts - topK / 相似度下限 / 粗筛池大小 / 会话范围。
 * @returns 命中文档（按余弦降序）+ 说明。
 */
export async function searchDense(
  decryptedDir: string,
  queryText: string,
  embed: EmbedFn,
  opts: DenseSearchOptions,
): Promise<{ docs: RetrievedDoc[]; scores: number[]; note?: string }> {
  const status = vectorIndexStatus(decryptedDir)
  if (!status.ready) return { docs: [], scores: [], note: '向量索引未就绪' }
  let qvecs: number[][]
  try {
    qvecs = await embed([queryText.slice(0, 400)])
  } catch (e) {
    return { docs: [], scores: [], note: 'embedding 失败: ' + (e as Error).message }
  }
  const raw = qvecs[0]
  if (!raw || raw.length === 0) return { docs: [], scores: [], note: 'embedding 返回空' }
  const qv = l2normalize(raw)
  const dim = qv.length
  const qh = simhash(qv, getPlanes(dim))

  const all = loadHashRows(decryptedDir)
  if (all.length === 0) return { docs: [], scores: [], note: '向量库为空' }
  // 粗筛：按汉明距离升序取前 candidatePool（见 selectByHamming 的说明 —— 不是全量排序）
  const scored = selectByHamming(all, qh, Math.max(opts.candidatePool, opts.topK))
  const filtered = opts.username ? scored.filter(r => r.username === opts.username) : scored
  if (filtered.length === 0) return { docs: [], scores: [], note: '粗筛后无候选' }

  // 精确余弦 + 回读文本。
  const db = openVectorDb(decryptedDir, true)
  const src = searchIndexPath(decryptedDir)
  const sdb = new DatabaseSync(src, { readOnly: true })
  const out: Array<{ doc: RetrievedDoc; score: number }> = []
  try {
    const getVec = db.prepare('SELECT vec, dim FROM vectors WHERE fts_rowid=?')
    const getMeta = sdb.prepare('SELECT text, username, local_id, create_time FROM message_meta WHERE rowid=?')
    for (const r of filtered) {
      const vr = getVec.get(r.rowid) as { vec?: Uint8Array; dim?: number } | undefined
      if (!vr?.vec) continue
      const v = blobToVec(vr.vec, Number(vr.dim ?? dim))
      let dot = 0
      const n = Math.min(v.length, qv.length)
      for (let i = 0; i < n; i += 1) dot += v[i] * qv[i]
      if (dot < opts.minSimilarity) continue
      const mr = getMeta.get(r.rowid) as Record<string, unknown> | undefined
      if (!mr) continue
      out.push({ doc: docFromRow(mr), score: dot })
    }
  } finally {
    db.close()
    sdb.close()
  }
  out.sort((a, b) => b.score - a.score)
  const top = out.slice(0, opts.topK)
  return { docs: top.map(x => x.doc), scores: top.map(x => x.score) }
}

/** 计算一条查询文本的向量（供测试与消融实验复用）。 */
export async function embedOne(text: string, embed: EmbedFn): Promise<Float32Array> {
  const v = await embed([text])
  return l2normalize(v[0] ?? [])
}

/** 向量库摘要（前端「数据健康」用）。 */
export function vectorIndexSummary(decryptedDir: string): { rows: number; dim: number; model: string } {
  const s = vectorIndexStatus(decryptedDir)
  return { rows: s.rows, dim: s.dim, model: s.model }
}

/** 便于测试：导出内部哈希工具。 */
export const __internals = { simhash, popcount32, getPlanes, l2normalize, docKeyOf, selectByHamming, MAX_HAMMING }
