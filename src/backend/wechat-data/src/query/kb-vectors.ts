/**
 * 知识库 chunk 向量库（**独立文件** `wechat_kb_vectors.db`）—— 稠密通道的存储层。
 *
 * ── 为什么是独立文件（设计稿 §3.2 已定，理由照抄并落地）────────────────
 *   分块文本是**解析产物**：删掉要用户重新选文件、重新解析。向量是**可重建产物**：
 *   换 embedding 模型、改维度，整个文件丢掉重建即可。两者生命周期不同，放同一个库里，
 *   「重建向量」就会连带冒「重建分块」的风险。
 *   另一半理由来自风险册 R5：复用消息域的 `wechat_rag_vectors.db` 会污染那条热路径的
 *   `rows` / `ready` 判定（改一个库的行数会改另一个域的行为），且两域 docKey 形状不同。
 *
 * ── 与设计稿 schema 的**一处有意增量**：多了 `file_id` ──────────────────
 *   设计稿给的是 `(chunk_id PK, kb_id, dim, vec, hash_lo, hash_hi)`。这里加一列
 *   `file_id`，原因是**跨库 JOIN 在 SQLite 里不可能**（两个文件是两个连接）：
 *     · 删一个文件时，要么「先查 kb_chunks 拿到块 id 列表、再过来按 IN 删」（两次往返、
 *       IN 列表可能上千项），要么冗余一个 `file_id` 后一句 `WHERE file_id=?` 删完；
 *     · 关掉文件级 RAG 开关时要清该文件向量，同理。
 *   冗余的代价是「两处可能不一致」，而它不可能不一致：`file_id` 只在构建时从
 *   `kb_chunks` 一并对齐写入，之后没有任何 UPDATE 会单独改它（改归属走
 *   `reassignKbVectors`，两个值一起改）。**读路径不信任它**：作用域与 RAG 开关
 *   一律回到 `kb_files.db` 上 JOIN 判定（见 `searchKbDense` 第 3 步），
 *   所以就算这一列陈旧，也不会让不该出现的块冒出来。
 *
 * ── 语料来源：`kb_chunks` ⋈ `kb_files WHERE include_in_rag = 1` ────────
 *   与 `searchKb(onlyRag:true)` 完全同源。**不解释、不兜底**：用户明确表态过
 *   「这份文件不许送进模型」，就不该有任何一条它的正文被送进 embedding 接口 ——
 *   所以这个条件写在**取语料的 SQL 里**，而不是拿到结果后再过滤。
 *
 * ── 复用而非重写 ──────────────────────────────────────────────────────
 *   SimHash 粗筛、精确余弦、两阶段建库、单飞闸这套东西与消息域**完全同构**，
 *   差别只在表名、语料 SQL 与作用域键。纯数学部分已抽到 `query/vector-math.ts`
 *   （只有一份实现，两侧共享同一组单测），本文件只写「知识库特有的那一层」。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import type { KbHit } from '../types.ts'
// 路径真源在 `kb-paths.ts`：由它提供 `kbFilesDbPath`（读语料）与本模块自己的库路径，
// 这样 `kb-files.ts → kb-vectors.ts`（删除级联）与 `kb-vectors.ts → kb-files.ts`（读语料）
// 之间**不会形成环** —— 依赖单向：两边都只指向 kb-paths。
import { kbFilesDbPath, kbVectorsDbPath } from './kb-paths.ts'
export { KB_VECTORS_DB, kbVectorsDbPath } from './kb-paths.ts'
import { yieldToLoop } from './search.ts'
import {
  blobToVec,
  getPlanes,
  l2normalize,
  selectByHamming,
  simhash,
  statSig,
  vecToBlob,
  type EmbedFn,
  type HashRow,
} from './vector-math.ts'

/** 向量表名（C4 的删除级联与守卫用例都要按名字断言，所以导出而不是散落字面量）。 */
export const KB_VECTORS_TABLE = 'kb_vectors'

/**
 * 向量库 schema 版本；**结构或哈希算法变化时自动重建**。
 *
 * 与消息域各自一个版本号：两边的表结构本来就不同，共用一个号只会让
 * 「消息域升版本导致知识库白重建」这种无意义的重活发生。
 */
export const KB_VECTOR_SCHEMA_VERSION = '1'

/**
 * 「这个库的向量为什么不能用」—— 界面与降级说明要说的是这一句，而不是笼统的「未就绪」。
 *
 * 三种 mismatch 的**处置代价完全不同**，混成一句话用户就没法判断该不该重建：
 *   · `no-index` 从没建过 ⇒ 想用语义检索就建；
 *   · `model-mismatch` 换过嵌入模型 ⇒ 旧向量在新空间里没有意义，必须重建；
 *   · `schema-mismatch` 表结构升过版 ⇒ 全表都要重建（不只是本库）；
 *   · `no-model` 调用方没给出「当前用哪个模型」⇒ **无法背书溯源**，按不可用处理。
 *     这条存在的原因：以前记账名是写死的 `'default'`，等于没有溯源，
 *     于是「换模型」这件事在库里根本不留痕迹（见 `docs/KB-MODEL-CONFIG.md` §7 F1）。
 */
export type KbVectorStaleReason = '' | 'no-index' | 'model-mismatch' | 'schema-mismatch' | 'no-dim' | 'no-model'

/** 向量库状态（**按库**：`rows` 是「这个库里有多少块已入库」）。 */
export interface KbVectorIndexStatus {
  exists: boolean
  rows: number
  dim: number
  /** meta 里记的「最近一次构建用的模型名」—— 诊断用；判定看 `models` 与 `current`。 */
  model: string
  /** 本库向量行里**实际**出现过的模型名（去重 + 排序）。空表 ⇒ 空数组。 */
  models: string[]
  /** 判定时传入的「当前嵌入模型名」（与发送方同一个解析，见 gateway 的 `embedModelName`）。 */
  current: string
  /** 未就绪的原因；`''` 表示就绪。 */
  staleReason: KbVectorStaleReason
  built_at: string | null
  ready: boolean
}

/** 稠密召回选项。 */
export interface KbDenseSearchOptions {
  topK: number
  /** 低于该余弦相似度直接丢弃。 */
  minSimilarity: number
  /** SimHash 粗筛保留多少条参与精确计算。 */
  candidatePool: number
  /**
   * 查询向量是哪个模型算出来的。
   *
   * 必须传：不传就没法判「库里那批向量是不是同一个模型的产物」，而维度相同、
   * 语义空间不同的两个模型（`bge-m3` 与 `bge-large-zh` 都是 1024 维）恰恰是
   * **唯一一种维度检查抓不到**的错配 —— 硬算余弦会得到一个看起来正常、
   * 实际没有意义的排序。
   */
  model: string
}

/** 建库结果（形状与消息域 `VectorBuildResult` 对齐，便于两处日志口径一致）。 */
export interface KbVectorBuildResult {
  status: string
  rows: number
  embedded: number
  embed_calls: number
  elapsed_ms: number
  message?: string
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

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

/**
 * 打开（并初始化）向量库。
 *
 * `CREATE TABLE IF NOT EXISTS` 每次开库都跑一遍。本库虽然新增不久，但**已经发出去的版本**
 * 里没有 `model` 这一列（行级模型溯源是 `docs/KB-MODEL-CONFIG.md` 的 P0 才加的），
 * 所以要写「查 `PRAGMA table_info` → 缺才 `ALTER`」的加列分支：SQLite 没有
 * `ADD COLUMN IF NOT EXISTS`，重跑 `ALTER` 直接抛 duplicate column。
 */
function openVectorsDb(decryptedDir: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(kbVectorsDbPath(decryptedDir), readOnly ? { readOnly: true } : {})
  if (!readOnly) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS ' + KB_VECTORS_TABLE + ' ('
      + 'chunk_id INTEGER PRIMARY KEY, kb_id INTEGER NOT NULL, file_id INTEGER NOT NULL, '
      + 'dim INTEGER NOT NULL, vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL, '
      + "model TEXT NOT NULL DEFAULT '')")
    // 按库过滤是每次检索的必经之路（`WHERE kb_id = ?`）⇒ 这个索引是热路径的一部分。
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_vectors_kb ON ' + KB_VECTORS_TABLE + '(kb_id)')
    // 删除级联按 file_id 删（见头注：跨库 JOIN 不可能，所以冗余这一列）。
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_vectors_file ON ' + KB_VECTORS_TABLE + '(file_id)')
    // 「哪个模型算出来的」是**行级**属性（见头注下方的模型溯源一节），老库没有这一列 ⇒ 补。
    // SQLite 没有 `ADD COLUMN IF NOT EXISTS`，必须先 `PRAGMA table_info` 查在不在，
    // 否则第二次打开就抛 duplicate column（同一纪律见 `kb-files.ts` 的 `migrate`）。
    const cols = new Set((db.prepare('PRAGMA table_info(' + KB_VECTORS_TABLE + ')').all() as Array<Record<string, unknown>>)
      .map(r => String(r['name'] ?? '')))
    if (!cols.has('model')) {
      db.exec("ALTER TABLE " + KB_VECTORS_TABLE + " ADD COLUMN model TEXT NOT NULL DEFAULT ''")
    }
  }
  return db
}

/** 表是否存在（只读连接上用；表缺失时按「空库」处理而不是抛错）。 */
function hasTable(db: DatabaseSync): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(KB_VECTORS_TABLE))
  } catch {
    return false
  }
}

/**
 * 状态缓存：`(库文件路径, kbId)` + 指纹 → 状态。
 *
 * 与消息域 N14 同款，但**没必要**做那边那么细的连接数优化：知识库的规模是
 * 「几千个文件 × 若干块」，与 13.5 万条消息不是一个量级，而这里的 `rows` 必须是
 * **按库**的数（不能读全局 meta 里的那个总数）。所以缓存只承担「一次提问里
 * pipeline / gateway / searchKbDense 各问一遍」的重复，冷路径老老实实开一次连接 + 一次 COUNT。
 */
const STATUS_CACHE = new Map<string, { sig: string; status: KbVectorIndexStatus }>()

/** 让某个库的状态缓存失效（本进程内构建提交后调用；指纹本来也会变，这里是显式兜底）。 */
function invalidateKbStatusCache(decryptedDir: string, kbId: number): void {
  STATUS_CACHE.delete(kbVectorsDbPath(decryptedDir) + '#' + kbId)
}

/** 就绪判定的六个条件（顺序即优先级：先说结构、再说有没有、最后说模型对不对）。 */
function staleReasonOf(rows: number, dim: number, ver: string, models: string[], current: string): KbVectorStaleReason {
  if (ver !== KB_VECTOR_SCHEMA_VERSION) return 'schema-mismatch'
  if (rows === 0) return 'no-index'
  if (dim <= 0) return 'no-dim'
  if (current === '') return 'no-model'
  // 必须**恰好一个**模型且等于当前：两个说明库里混过批次（半重建），
  // 不等于当前说明换过模型 —— 两者都不能拿去算余弦。
  if (models.length !== 1 || models[0] !== current) return 'model-mismatch'
  return ''
}

/**
 * 读一次向量库状态（冷路径：一次连接 + 一次 meta 读 + 一次按库 COUNT + 一次按库 DISTINCT model）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库（`rows` 与 `ready` 都是**这个库**的口径）。
 * @param current - 当前嵌入模型名；空串表示调用方无法给出 ⇒ 判 `no-model`（不背书）。
 * @returns 状态快照。
 */
function readKbVectorStatus(decryptedDir: string, kbId: number, current: string): KbVectorIndexStatus {
  const p = kbVectorsDbPath(decryptedDir)
  const none: KbVectorIndexStatus = {
    exists: false, rows: 0, dim: 0, model: '', models: [], current, staleReason: 'no-index', built_at: null, ready: false,
  }
  if (!existsSync(p)) return { ...none, staleReason: 'no-index' }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    try {
      if (!hasTable(db)) return { ...none, exists: true }
      const meta = new Map<string, string>()
      try {
        for (const r of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
          meta.set(String(r.key), String(r.value ?? ''))
        }
      } catch { /* meta 表缺失/损坏：按「什么都没写过」处理 ⇒ 版本不符 ⇒ 未就绪 */ }
      const dim = Number(meta.get('dim') || 0)
      const model = meta.get('model') ?? ''
      const built = meta.get('built_at') || null
      const ver = meta.get('schema_version') ?? ''
      // 按库 COUNT（走 idx_kb_vectors_kb）。**不用** meta 里的全局 rows：
      // 那是「整张表的行数」，拿它判「这个库就绪了」会让一个从未建过向量的库显示成就绪。
      const rows = (db.prepare('SELECT COUNT(*) AS c FROM ' + KB_VECTORS_TABLE + ' WHERE kb_id = ?').get(kbId) as { c: number }).c
      /**
       * 本库行级出现过的模型名。**读不到这一列就当没有溯源**（老库）⇒ 判未就绪、逼一次重建，
       * 而不是退回 meta 里那个可能写着 `'default'` 的全局值 —— 后者正是 F1 的成因。
       */
      let models: string[] = []
      try {
        models = (db.prepare('SELECT DISTINCT model FROM ' + KB_VECTORS_TABLE + ' WHERE kb_id = ?').all(kbId) as Array<{ model: unknown }>)
          .map(r => String(r.model ?? '')).sort()
      } catch { models = [] }
      const reason = staleReasonOf(rows, dim, ver, models, current)
      return {
        exists: true, rows, dim, model, models, current, staleReason: reason, built_at: built, ready: reason === '',
      }
    } finally {
      db.close()
    }
  } catch {
    // 打不开/损坏：**宁可报未就绪**（同 H9 对派生状态的一贯取舍）—— 报就绪会让稠密通道
    // 每次提问都在同一处抛错，而且没有任何自愈路径（只有未就绪才会触发重建）。
    return { ...none, exists: true, staleReason: 'no-index' }
  }
}

/**
 * 向量索引状态（按库）。返回**副本**：调用方都只读，但缓存共享同一个对象时
 * 迟早有人就地改写它（消息域 vector-status.spec.ts 有专门一条用例钉这件事）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param current - 当前嵌入模型名（与发送方同一个解析）。缓存键带着它，
 *   所以「同一个库、换了一个模型」两次查询不会互相污染。
 * @returns 状态快照。
 */
export function kbVectorIndexStatus(decryptedDir: string, kbId: number, current = ''): KbVectorIndexStatus {
  const kb = Number.isFinite(kbId) && kbId > 0 ? Math.trunc(kbId) : 0
  const p = kbVectorsDbPath(decryptedDir)
  const cur = String(current ?? '')
  const sig = statSig(p)
  const key = p + '#' + kb + '#' + cur
  const hit = STATUS_CACHE.get(key)
  if (hit && hit.sig === sig) return { ...hit.status, models: [...hit.status.models] }
  const status = readKbVectorStatus(decryptedDir, kb, cur)
  STATUS_CACHE.set(key, { sig, status })
  return { ...status, models: [...status.models] }
}

// ── 粗筛表缓存：(向量库路径, kbId) + 指纹 → HashRow[] ──
const KB_HASH_CACHE = new Map<string, { sig: string; rows: HashRow[] }>()

/**
 * 载入某个库的粗筛表（`(chunk_id, hash_lo, hash_hi)`）。
 *
 * 与消息域同款：粗筛要做「按 (距离, 原顺序) 的计数选择」，需要随机访问全部行，
 * 不是「边读边丢」的扫描，所以**有意**一次取回；代价由指纹缓存兜住
 * （只在进程内首次 / 重建后各付一次）。
 *
 * ⚠ 这里返回的 `rows` 是**共享数组**（缓存里那一份），调用方只读。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @returns 粗筛表。
 */
function loadKbHashRows(decryptedDir: string, kbId: number): HashRow[] {
  const p = kbVectorsDbPath(decryptedDir)
  const sig = String(statSig(p))
  const key = p + '#' + kbId
  const hit = KB_HASH_CACHE.get(key)
  if (hit && hit.sig === sig) return hit.rows
  const db = new DatabaseSync(p, { readOnly: true })
  let rows: HashRow[] = []
  try {
    rows = (db.prepare('SELECT chunk_id, hash_lo, hash_hi FROM ' + KB_VECTORS_TABLE + ' WHERE kb_id = ?').all(kbId) as Array<Record<string, unknown>>)
      .map(r => ({
        rowid: Number(r['chunk_id']),
        lo: Number(r['hash_lo']) >>> 0,
        hi: Number(r['hash_hi']) >>> 0,
        // 分区键在知识库域是**库**，而库过滤已经在 SQL 里做掉了（`WHERE kb_id = ?`），
        // 所以这里留空串。留着这个字段是因为 `selectByHamming` 只认这一种行形状（共用实现）。
        username: '',
      }))
  } finally {
    db.close()
  }
  KB_HASH_CACHE.set(key, { sig, rows })
  return rows
}

/** 建库单飞闸：同 `(向量库文件, 库)` 的并发调用合并到同一轮。 */
const inflightKbBuilds = new Map<string, { promise: Promise<KbVectorBuildResult>; force: boolean }>()

/**
 * 跨库写入的串行队列（按**向量库文件路径**键控）。
 *
 * 与消息域的单飞闸不同：那边一个文件只服务一个域（消息），所以「同文件的并发构建」
 * 天然是「同一件事」，合并即可。这里一个文件服务**所有知识库**，而构建是**按库**做的
 * （见 `buildKbVectorIndex` 的隐私说明），于是「甲库构建」与「乙库构建」是两件不同的
 * 事、却共用同一个文件 —— 直接并发会在写事务上撞 `database is locked`。
 * 所以：同库的在飞构建**合并**（单飞），不同库的构建**排队**（串行）。
 */
const writeChains = new Map<string, Promise<unknown>>()

/** 把一段写入串到该向量库文件的队列尾部；前一个无论成败都不阻塞后一个。 */
function enqueueWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next: Promise<T> = prev.then(fn, fn)
  writeChains.set(key, next.then(() => undefined, () => undefined))
  return next
}

/** 清洗整数配置（`rag-config.json` 可手改且不做数值校验）。 */
function clampInt(raw: unknown, def: number, lo: number, hi: number): number {
  const n = Number(raw)
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : def, lo), hi)
}

/**
 * 构建 / 增量更新**某个库**的 chunk 向量。
 *
 * ── 为什么按库而不是一次全库 ────────────────────────────────────────────
 *   出网范围必须与用户此刻的意图一致：用户在这个库里提问，就该只把这个库的内容
 *   送去 embedding。一次全库构建会把**别的库**的正文也发出去 —— 那是一次没人授权的
 *   范围扩张，而 `include_in_rag` 只表达「文件级」意愿、表达不了「库级」。
 *
 * ── 换模型的正确处置（C4 / WeKnora `06-models` 的硬要求）────────────────
 *   模型名是**行级**属性（`kb_vectors.model`），所以「换模型」只作废**本库里由别的模型
 *   算出来的那些行**：同模型的行仍然有效，删了就是白出网一次；别的库的行更是与本次无关。
 *   唯一仍会清全表的情形是 **schema 版本变更**（列结构/哈希口径变了，每一行都不再合规）。
 *   旧实现是「换模型 = 清全表」，那时的前提是「全库共用一个嵌入模型」；
 *   按库绑定让那个前提失效，处置跟着改（理由见 `docs/KB-MODEL-CONFIG.md` C5）。
 *
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param embed - embedding 函数（上层注入，已含隐私判断）。
 * @param opts - 模型 / 批量 / 上限 / 并发 / 进度 / 强制重建。
 * @returns 构建结果。
 */
export function buildKbVectorIndex(
  decryptedDir: string,
  kbId: number,
  embed: EmbedFn,
  opts: { model: string; batchSize: number; maxCharsPerDoc: number; maxDocsPerBuild: number; concurrency?: number; onProgress?: (done: number, total: number) => void; force?: boolean },
): Promise<KbVectorBuildResult> {
  const kb = Math.trunc(Number(kbId))
  if (!Number.isFinite(kb) || kb <= 0) {
    return Promise.resolve({ status: 'bad-kb', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0, message: '没有指定知识库' })
  }
  const dbKey = kbVectorsDbPath(decryptedDir)
  const slotKey = dbKey + '#' + kb
  const slot = inflightKbBuilds.get(slotKey)
  // 同库在飞：非 force 直接加入；force 撞上非 force 则排队重做（与消息域语义一致）。
  if (slot && (slot.force || !opts.force)) return slot.promise
  const queueAfter: Promise<unknown> = slot ? slot.promise.catch(() => undefined) : Promise.resolve()
  const promise = enqueueWrite(dbKey, () => queueAfter.then(() => runBuildKbVectorIndex(decryptedDir, kb, embed, opts)))
  const entry = { promise, force: Boolean(opts.force) }
  inflightKbBuilds.set(slotKey, entry)
  const release = (): void => {
    if (inflightKbBuilds.get(slotKey) === entry) inflightKbBuilds.delete(slotKey)
    invalidateKbStatusCache(decryptedDir, kb)
  }
  promise.then(release, release)
  return promise
}

/** 待入库的一行（只留标量：文本只作为 `groups` 的键存在一份）。 */
type PendingChunk = { chunkId: number; fileId: number }

/**
 * 真正的构建过程（**两阶段**：先算、后写）。
 *
 * 阶段一只拿网络（不开写事务），阶段二一次事务写完（**不含 await**）——
 * 理由与消息域 N10 完全一样：写事务的持有时长只与插入耗时相关，与网络往返无关。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param embed - embedding 函数。
 * @param opts - 同 {@link buildKbVectorIndex}。
 * @returns 构建结果。
 */
async function runBuildKbVectorIndex(
  decryptedDir: string,
  kbId: number,
  embed: EmbedFn,
  opts: { model: string; batchSize: number; maxCharsPerDoc: number; maxDocsPerBuild: number; concurrency?: number; onProgress?: (done: number, total: number) => void; force?: boolean },
): Promise<KbVectorBuildResult> {
  const started = Date.now()
  const src = kbFilesDbPath(decryptedDir)
  if (!existsSync(src)) {
    return { status: 'no-source', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0, message: '知识库还没有任何文件' }
  }
  const db = openVectorsDb(decryptedDir, false)
  try {
    const prevVer = readMeta(db, 'schema_version')
    /**
     * 本库行级出现过的模型名（判定「换没换模型」用的是**行**，不是 meta 里那个全局值 ——
     * 后者在按库绑定之后只是「最近一次构建」的诊断信息，见 §7 F1）。
     */
    const kbModels = new Set<string>()
    let kbRows = 0
    try {
      for (const r of db.prepare('SELECT model, COUNT(*) AS c FROM ' + KB_VECTORS_TABLE
        + ' WHERE kb_id = ? GROUP BY model').iterate(kbId) as Iterable<{ model: unknown; c: number }>) {
        kbModels.add(String(r.model ?? ''))
        kbRows += Number(r.c ?? 0)
      }
    } catch { /* 老库还没有 model 列：按「无溯源」处理 ⇒ 本库全部行都算外来行，重建时一并清掉 */ }
    // 三种作废范围，从小到大。**都不再是「整张表」**（除结构升版）：
    //   · schema-mismatch ⇒ 整张表。每一行都不再符合新的列/哈希口径，与谁算的无关。
    //   · force           ⇒ 本库全部行。用户点名「重建」，不该给他留一半旧的。
    //   · 换模型          ⇒ 只删本库里**不是当前模型**的行。同模型的行仍然有效，
    //                        删了就等于把一批本不必发的 embedding 请求再发一遍（白花 token、
    //                        白花一次出网）。
    // 旧实现清的是整张表，那时的前提是「全库共用一个模型」—— 一个模型变了就是全都变了。
    // 按库绑定之后这个前提没了：甲库换模型不该让乙库白重建一次（见 docs/KB-MODEL-CONFIG.md C5）。
    const wipeTable = prevVer !== '' && prevVer !== KB_VECTOR_SCHEMA_VERSION
    const wipeKbAll = !wipeTable && opts.force === true
    const wipeKbForeign = !wipeTable && opts.force !== true
      && kbRows > 0 && (kbModels.size !== 1 || !kbModels.has(opts.model))
    const done = new Set<number>()
    if (!wipeTable && !wipeKbAll) {
      /**
       * 增量游标：这个库里**已经由当前模型算过**的块。
       * 必须带 `model = ?`：不带的话，旧模型的那些行会被当成「已完成」跳过，
       * 于是库里永远混着两个模型的向量、而状态永远判它「模型不符」——白建。
       * 用 iterate 而不是 `.all()`（元数据可能几万行）。
       */
      for (const row of db.prepare('SELECT chunk_id FROM ' + KB_VECTORS_TABLE + ' WHERE kb_id = ? AND model = ?')
        .iterate(kbId, opts.model) as Iterable<{ chunk_id: number }>) {
        done.add(Number(row.chunk_id))
      }
    }

    const cap = clampInt(opts.maxDocsPerBuild, 0, 0, Number.MAX_SAFE_INTEGER)
    const groups = new Map<string, PendingChunk[]>()
    let pendingCount = 0
    const sdb = new DatabaseSync(src, { readOnly: true })
    try {
      /**
       * 语料：**只取参与 RAG 的文件**（`include_in_rag = 1`），并且只取本库。
       *
       * 这两条都写在 SQL 里、不下放到 JS：`unrecognized` 的文件连一次 embedding
       * 都不该有机会被算到，而「先捞出来再过滤」正好会把它们算进去。
       */
      const sql = 'SELECT c.id AS chunk_id, c.file_id AS file_id, c.text AS text '
        + 'FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id '
        + 'WHERE c.kb_id = ? AND f.include_in_rag = 1 ORDER BY c.id'
      for (const r of sdb.prepare(sql).iterate(kbId) as Iterable<Record<string, unknown>>) {
        if (pendingCount >= cap) break
        const chunkId = Number(r['chunk_id'] ?? 0)
        if (chunkId <= 0 || done.has(chunkId)) continue
        const text = String(r['text'] ?? '').slice(0, opts.maxCharsPerDoc)
        const tuple: PendingChunk = { chunkId, fileId: Number(r['file_id'] ?? 0) }
        const g = groups.get(text)
        if (g) g.push(tuple)
        else groups.set(text, [tuple])
        pendingCount += 1
      }
    } finally {
      sdb.close()
    }

    if (pendingCount === 0) {
      // 一行 meta 也进事务：省得「版本写了、时间没写」各占一半（派生数据也值得原子落地）
      db.exec('BEGIN')
      try {
        writeMeta(db, 'schema_version', KB_VECTOR_SCHEMA_VERSION)
        writeMeta(db, 'built_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
        writeMeta(db, 'rows', String((db.prepare('SELECT COUNT(*) AS c FROM ' + KB_VECTORS_TABLE).get() as { c: number }).c))
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* no tx */ }
        throw e
      }
      return { status: 'up-to-date', rows: done.size, embedded: 0, embed_calls: 0, elapsed_ms: Date.now() - started }
    }

    const ins = db.prepare('INSERT OR REPLACE INTO ' + KB_VECTORS_TABLE
      + '(chunk_id, kb_id, file_id, dim, vec, hash_lo, hash_hi, model) VALUES(?,?,?,?,?,?,?,?)')
    let embedCalls = 0
    let dim = 0
    let processedRows = 0

    // ① 按「截断后的文本」分组：同一文本只 embed 一次，向量扇出到该组所有块。
    //    表格类文件里「每块重复表头」会让重复率比消息域更高，这一步省得更多。
    const texts = [...groups.keys()]
    const batchSize = clampInt(opts.batchSize, 1, 1, 256)
    const concurrency = clampInt(opts.concurrency, 1, 1, 16)
    let next = 0
    let failure: unknown = null
    /**
     * 阶段一算出来的向量：**截断文本 → 向量字节与 SimHash**。
     * 先攒起来、阶段二再一次性写（写事务里不含 await，见 N10）。
     */
    const vectors = new Map<string, { blob: Uint8Array; lo: number; hi: number }>()
    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure) return
        const start = next
        next += batchSize
        if (start >= texts.length) return
        const batch = texts.slice(start, start + batchSize)
        let vecs: number[][]
        // 计数在**发起之前**：`embed_calls` 的语义是「发出了多少次请求」，放在 await 之后
        // 会让失败那次漏报（错误路径的口径就错了）。
        embedCalls += 1
        try {
          vecs = await embed(batch)
        } catch (e) {
          failure = failure ?? e
          return
        }
        if (failure) return
        for (let j = 0; j < batch.length; j += 1) {
          const groupRows = groups.get(batch[j])
          if (!groupRows) continue
          const raw = vecs[j]
          if (raw && raw.length > 0) {
            const v = l2normalize(raw)
            dim = v.length
            const h = simhash(v, getPlanes(dim))
            vectors.set(batch[j], { blob: vecToBlob(v), lo: h.lo, hi: h.hi })
          }
          processedRows += groupRows.length
        }
        opts.onProgress?.(Math.min(processedRows, pendingCount), pendingCount)
        // 让出事件循环：构建期间后端仍要能响应其它查询。
        await yieldToLoop()
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    // 阶段一失败：一行都没写（事务还没开），旧索引原样保留
    if (failure) throw failure

    await yieldToLoop()

    /**
     * 阶段二：**一次事务写完，不含任何 await**。
     * 三种作废（整表 / 本库全部 / 本库外来模型行）的 `DELETE` 也在这里：
     * 失败即 ROLLBACK，已有索引不会被留成空表。
     */
    let embedded = 0
    db.exec('BEGIN')
    try {
      if (wipeTable) {
        db.exec('DELETE FROM ' + KB_VECTORS_TABLE)
      } else if (wipeKbAll) {
        db.prepare('DELETE FROM ' + KB_VECTORS_TABLE + ' WHERE kb_id = ?').run(kbId)
      } else if (wipeKbForeign) {
        db.prepare('DELETE FROM ' + KB_VECTORS_TABLE + ' WHERE kb_id = ? AND model <> ?').run(kbId, opts.model)
      }
      for (const [text, v] of vectors) {
        for (const c of groups.get(text) ?? []) {
          ins.run(c.chunkId, kbId, c.fileId, dim, v.blob, v.lo, v.hi, opts.model)
          embedded += 1
        }
      }
      // 统计与 meta 一并进事务：COMMIT 即「新索引 + 版本 + 时间」原子落地
      const total = (db.prepare('SELECT COUNT(*) AS c FROM ' + KB_VECTORS_TABLE).get() as { c: number }).c
      writeMeta(db, 'rows', String(total))
      writeMeta(db, 'schema_version', KB_VECTOR_SCHEMA_VERSION)
      writeMeta(db, 'model', opts.model)
      if (dim > 0) writeMeta(db, 'dim', String(dim))
      writeMeta(db, 'built_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
      db.exec('COMMIT')
      return { status: 'ok', rows: total, embedded, embed_calls: embedCalls, elapsed_ms: Date.now() - started }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* no tx */ }
      throw e
    }
  } finally {
    db.close()
  }
}

/** 块正文摘要（稠密命中没有检索词，所以取块首一段；与稀疏的 `buildSnippet` 不同源）。 */
function excerpt(text: string, max = 160): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

/**
 * 稠密召回：SimHash 粗筛 → 精确余弦 → topK。
 *
 * 三个「必须拒绝」的情形都**返回空 + 说明**，不抛错：
 *   ① 索引未就绪（没建过 / 损坏 / 版本不符）；
 *   ② **查询向量维度与库里不一致**（换过模型但没重建）—— 此时若硬算余弦，
 *      点积会退化成「前 min(n) 维的巧合」，排序看起来正常但没有意义。宁可拒答。
 *   ③ embedding 失败 / 返回空。
 *
 * ⚠ 第 3 步的回读**必须**回到 `kb_files.db` 做 JOIN 再判 `include_in_rag`：
 *   向量库里的行是派生数据，可能在「用户关掉 RAG 开关」与「清向量」之间短暂残留。
 *   读路径不信任派生数据，是本项目的一贯取舍（同 H9）。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 目标库。
 * @param queryText - 查询文本（原句）。
 * @param embed - embedding 函数。
 * @param opts - topK / 相似度下限 / 粗筛池大小。
 * @returns 命中（按余弦降序）+ 说明。
 */
export async function searchKbDense(
  decryptedDir: string,
  kbId: number,
  queryText: string,
  embed: EmbedFn,
  opts: KbDenseSearchOptions,
): Promise<{ hits: KbHit[]; note?: string }> {
  const kb = Math.trunc(Number(kbId))
  if (!Number.isFinite(kb) || kb <= 0) return { hits: [], note: '没有指定知识库' }
  const status = kbVectorIndexStatus(decryptedDir, kb, opts.model)
  if (!status.ready) {
    // 说得出**为什么**不能用，而不是统一一句「未就绪」：`model-mismatch` 的出路是重建，
    // `no-index` 的出路也是重建但代价不同（一个要重算全部、一个只算外来那批），
    // `no-model` 则意味着调用方漏传了模型名 —— 那是接线缺陷，不该让用户去重建。
    const why: Record<KbVectorStaleReason, string> = {
      '': '',
      'no-index': '本库还没有向量索引',
      'schema-mismatch': '向量库结构已升级，需要重建',
      'no-dim': '向量库缺少维度记录，需要重建',
      'no-model': '调用方未提供当前向量模型名，无法判定索引是否可用',
      'model-mismatch': '本库索引由 ' + (status.models.join('/') || '未知') + ' 生成、本次用的是 '
        + (opts.model || '（未指定）') + '，两者不可比，请重建',
    }
    return { hits: [], note: '向量索引不可用：' + why[status.staleReason] }
  }

  let qvecs: number[][]
  try {
    qvecs = await embed([queryText.slice(0, 400)])
  } catch (e) {
    return { hits: [], note: 'embedding 失败: ' + errorText(e) }
  }
  const raw = qvecs[0]
  if (!raw || raw.length === 0) return { hits: [], note: 'embedding 返回空' }
  const qv = l2normalize(raw)
  // ② 维度不符：拒答（见头注）。只在两侧都拿到正数时才判，避免把「库里没记维度」误判成不符。
  if (status.dim > 0 && qv.length !== status.dim) {
    return { hits: [], note: '向量维度不符（索引 ' + status.dim + ' 维、本次 ' + qv.length + ' 维），可能换过模型，请重建知识库向量索引' }
  }

  const all = loadKbHashRows(decryptedDir, kb)
  if (all.length === 0) return { hits: [], note: '向量库为空' }
  const scored = selectByHamming(all, simhash(qv, getPlanes(qv.length)), Math.max(opts.candidatePool, opts.topK))
  if (scored.length === 0) return { hits: [], note: '粗筛后无候选' }

  const ids = scored.map((r) => r.rowid)
  const vdb = openVectorsDb(decryptedDir, true)
  const fdb = new DatabaseSync(kbFilesDbPath(decryptedDir), { readOnly: true })
  const out: Array<{ hit: KbHit; score: number }> = []
  try {
    const getVec = vdb.prepare('SELECT vec, dim FROM ' + KB_VECTORS_TABLE + ' WHERE chunk_id=?')
    const marks = ids.map(() => '?').join(',')
    /**
     * 第 3 步：回读块与文件。**四处约束缺一不可**：
     *   `c.id IN (...)` 限制在粗筛幸存者上（不然就是全表扫）；
     *   `c.kb_id = ?` 作用域（同一个 chunk id 只属于一个库，这里是纵深防御）；
     *   `f.include_in_rag = 1` 文件级开关（用户明确表态「这份不出网」）；
     *   `f.id = c.file_id` 拿文件名/扩展名给界面。
     */
    const rows = fdb.prepare(
      'SELECT c.id AS chunk_id, c.file_id AS file_id, c.ordinal AS ordinal, c.page AS page, '
      + 'c.heading AS heading, c.text AS text, f.name AS file_name, f.ext AS file_ext '
      + 'FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id '
      + 'WHERE c.id IN (' + marks + ') AND c.kb_id = ? AND f.include_in_rag = 1',
    ).all(...ids, kb) as Array<Record<string, unknown>>
    const byId = new Map<number, Record<string, unknown>>()
    for (const r of rows) byId.set(Number(r['chunk_id'] ?? 0), r)

    for (const r of scored) {
      const vr = getVec.get(r.rowid) as { vec?: Uint8Array; dim?: number } | undefined
      if (!vr?.vec) continue
      const v = blobToVec(vr.vec, Number(vr.dim ?? qv.length))
      let dot = 0
      const n = Math.min(v.length, qv.length)
      for (let i = 0; i < n; i += 1) dot += v[i] * qv[i]
      if (dot < opts.minSimilarity) continue
      const mr = byId.get(r.rowid)
      if (!mr) continue
      const text = String(mr['text'] ?? '')
      out.push({
        score: dot,
        hit: {
          fileId: Number(mr['file_id'] ?? 0),
          fileName: String(mr['file_name'] ?? ''),
          fileExt: String(mr['file_ext'] ?? ''),
          chunkId: Number(mr['chunk_id'] ?? 0),
          ordinal: Number(mr['ordinal'] ?? 0),
          page: Number(mr['page'] ?? 0),
          heading: String(mr['heading'] ?? ''),
          snippet: excerpt(text),
          text,
          // 稠密召回没有「命中词」，高亮区间只能是空的 —— 界面据此不画任何高亮，
          // 而不是画一个空的高亮（那会让用户以为「命中了但没标出来」）。
          marks: [],
          score: dot,
          ranks: { dense: 0 },
        },
      })
    }
  } finally {
    vdb.close()
    fdb.close()
  }
  out.sort((a, b) => b.score - a.score)
  const top = out.slice(0, Math.max(1, Math.trunc(opts.topK)))
  return { hits: top.map((x, i) => ({ ...x.hit, ranks: { dense: i + 1 } })) }
}

/**
 * 删掉某个文件在向量库里的全部行（**跨库**：向量在另一个文件里）。
 *
 * best-effort：没有跨库事务，且**向量库不存在时直接返回 0**（不新建一个空库 ——
 * 删文件这个动作不该在磁盘上留下一个刚建的空向量库）。失败只留痕不抛：
 * 调用方是删除级联，登记行该删还是要删（残留的向量行读路径也不会采信，见 `searchKbDense`）。
 * @param decryptedDir - 解密数据根。
 * @param fileId - 目标文件 id。
 * @returns 删掉的行数；0 表示「没有东西要删，或删不掉」。
 */
export function deleteKbVectorsForFile(decryptedDir: string, fileId: number): number {
  const id = Math.trunc(Number(fileId))
  if (!Number.isFinite(id) || id <= 0) return 0
  const p = kbVectorsDbPath(decryptedDir)
  if (!existsSync(p)) return 0
  try {
    const db = new DatabaseSync(p)
    try {
      if (!hasTable(db)) return 0
      const res = db.prepare('DELETE FROM ' + KB_VECTORS_TABLE + ' WHERE file_id = ?').run(id)
      return Number(res.changes ?? 0)
    } finally {
      db.close()
    }
  } catch (e) {
    console.warn('[kb-vectors] 删除文件向量失败（登记行照常删除）：' + p + ': ' + errorText(e))
    return 0
  }
}

/**
 * 把一个文件的向量改归属到目标库（删库时的 `reassign` 分支）。
 *
 * 不做这一步的后果是**静默**的：向量行还在，但 `kb_id` 指向那个即将消失的库 ⇒
 * 目标库检索不到（被 `WHERE kb_id=?` 挡掉）、源库也没了 ⇒ 这些块在稠密通道里
 * 「凭空消失」，而稀疏通道照样搜得到 —— 表现为「关键词能搜到、换个说法就搜不到」。
 * @param decryptedDir - 解密数据根。
 * @param fileId - 目标文件 id。
 * @param targetKbId - 新归属。
 * @returns 改动的行数。
 */
export function reassignKbVectors(decryptedDir: string, fileId: number, targetKbId: number): number {
  const id = Math.trunc(Number(fileId))
  const kb = Math.trunc(Number(targetKbId))
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(kb) || kb <= 0) return 0
  const p = kbVectorsDbPath(decryptedDir)
  if (!existsSync(p)) return 0
  try {
    const db = new DatabaseSync(p)
    try {
      if (!hasTable(db)) return 0
      const res = db.prepare('UPDATE ' + KB_VECTORS_TABLE + ' SET kb_id = ? WHERE file_id = ?').run(kb, id)
      return Number(res.changes ?? 0)
    } finally {
      db.close()
    }
  } catch (e) {
    console.warn('[kb-vectors] 迁移文件向量失败（下次建库会自己收敛）：' + p + ': ' + errorText(e))
    return 0
  }
}

/** 向量库摘要（「数据健康」用）。 */
export function kbVectorIndexSummary(decryptedDir: string, kbId: number): { rows: number; dim: number; model: string } {
  const s = kbVectorIndexStatus(decryptedDir, kbId)
  return { rows: s.rows, dim: s.dim, model: s.model }
}

/** 便于测试：导出内部工具与缓存（缓存对象只读，别在用例里改它们）。 */
export const __internals = {
  loadKbHashRows,
  hasTable,
  openVectorsDb,
  hashCache: KB_HASH_CACHE,
  statusCache: STATUS_CACHE,
  inflightKbBuilds,
  writeChains,
  excerpt,
}
