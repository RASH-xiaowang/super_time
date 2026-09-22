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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RetrievedDoc } from './types.ts'
import { retrievalRoot } from './config.ts'
import { searchIndexPath, yieldToLoop } from '../search.ts'
// 共用向量数学（与知识库向量库 `query/kb-vectors.ts` 同一份实现，见 `query/vector-math.ts`）：
// 粗筛/哈希/归一化必须逐位一致，所以只留一处实现。`EmbedFn` 也从这里转出，
// 保持 `gateway.ts` / `pipeline.ts` 既有的 `from './retrieval/embedding.ts'` 导入点不变。
import {
  MAX_HAMMING,
  blobToVec,
  getPlanes,
  dotProduct,
  l2normalize,
  popcount32,
  selectByHamming,
  simhash,
  statSig,
  vecToBlob,
  type EmbedFn,
  type HashRow,
} from '../vector-math.ts'
export type { EmbedFn, HashRow } from '../vector-math.ts'

/** 向量库 schema 版本；结构或哈希算法变化时自动重建。 */
const VECTOR_SCHEMA_VERSION = '1'

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

/**
 * 向量库状态缓存（N14）。
 *
 * 为什么需要：`vectorIndexStatus` 是**每次提问至少命中两次**的热路径
 * （`searchDense` 内一次 + `pipeline.ts:140` 一次，另有 gateway 的建库前置判断），
 * 而改前每次都要「新开一个连接 + `SELECT COUNT(*) FROM vectors` + 4 次 meta 读」。
 * 实测（合成 13.5 万行）`COUNT(*)` **1.25ms**、走 `idx_vectors_doc` 覆盖索引 1.07ms —— 一次提问付两遍。
 *
 * 两个前提让它安全：
 *   ① **状态只在索引重建时变**，而重建是 `runBuildVectorIndex` 里一次事务的产物
 *      （本轮连行数也写进 meta、与 `built_at` 同事务落地），所以「文件指纹没变」⇒ 六个字段逐个相同。
 *      指纹沿用粗筛表缓存（`HASH_CACHE`）同一套 `statSig`；本进程内的重建还会显式失效
 *      （见 `buildVectorIndex` 的 release）。跨进程重建由指纹兜住 —— HASH_CACHE 早就把
 *      **检索结果**托付给同一个指纹了，这里多托付一个「行数」并不新增风险类别。
 *   ② 行数不再现算：读侧一次 `SELECT key, value FROM meta` 就拿到全部 meta
 *      （改前是 4 次 per-key 读，各自定位一遍 B 树）。
 *
 * 老库（本改动之前建的）meta 里没有 `rows` 键，此时**退回一次** `COUNT(*)`：
 * 只付一次，结果按指纹缓存，而下一次构建就会把该键补上（见 `runBuildVectorIndex` 的
 * up-to-date 分支），所以老库只是「暂时不快」，不会永远慢、也不会误报 rows=0 把索引判成未就绪。
 */
const STATUS_CACHE = new Map<string, { sig: string; status: VectorIndexStatus }>()

/** 让某条路径的状态缓存失效（构建提交后调用；指纹本来也会变，这里是显式兜底）。 */
function invalidateVectorStatusCache(p: string): void {
  STATUS_CACHE.delete(p)
}

/**
 * 读一次向量库状态（**冷路径**：只在缓存未命中时走）。
 *
 * 冷路径 = 1 次连接 + 1 次 meta 查询（+ 仅老库才有的一次 COUNT），
 * 热路径（缓存命中）= 0 次连接、0 条 SQL。
 * @param p - 向量库文件路径。
 * @returns 状态快照。
 */
function readVectorIndexStatus(p: string): VectorIndexStatus {
  if (!existsSync(p)) return { exists: false, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    try {
      // meta 是 ≤6 行的小表：一次读全，省掉 4 次 prepare+定位
      const meta = new Map<string, string>()
      try {
        for (const r of db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) {
          meta.set(String(r.key), String(r.value ?? ''))
        }
      } catch { /* meta 表缺失/损坏：按「什么都没写过」处理（与改前 readMeta 的逐键兜底等价） */ }
      const dim = Number(meta.get('dim') || 0)
      const model = meta.get('model') ?? ''
      const built = meta.get('built_at') || null
      const ver = meta.get('schema_version') ?? ''
      // rows 优先读 meta；缺键（老库）/ 空值 / 非数值（meta 可被手改）时才现算 —— 与改前的 COUNT 结果一致
      const rowsCell = (meta.get('rows') ?? '').trim()
      const rowsMeta = rowsCell === '' ? Number.NaN : Number(rowsCell)
      const rows = Number.isFinite(rowsMeta) && hasVectorsTable(db)
        ? rowsMeta
        : (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
      return { exists: true, rows, dim, model, built_at: built, ready: rows > 0 && dim > 0 && ver === VECTOR_SCHEMA_VERSION }
    } finally {
      db.close()
    }
  } catch {
    return { exists: true, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  }
}

/**
 * vectors 表是否还在。
 *
 * 为什么 meta 里有 `rows` 还要判这一次：库文件被截断/手工删表时 meta 可能仍然完好，
 * 那时若照 meta 报「N 行、就绪」，稠密通道**每次提问**都会在 `FROM vectors` 上抛错，而且
 * `gateway` 只在 `!ready` 时才建库 ⇒ 永远不会自愈。改前实现是 COUNT 抛错 ⇒ 未就绪 ⇒
 * 下次提问自动重建，方向更安全（同 H9 对派生状态的一贯取舍：宁可未就绪）。
 * 代价只有一条 prepare，且只发生在冷路径（缓存命中时不查）。
 * @param db - 只读连接。
 * @returns 表存在为 true。
 */
function hasVectorsTable(db: DatabaseSync): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vectors'").get())
  } catch {
    return false
  }
}

/**
 * 向量库状态（不存在/损坏/版本不符时 ready=false）。
 *
 * 返回的是**副本**：调用方（gateway / pipeline / searchDense）都只读，但缓存共享同一个对象时
 * 迟早会有人就地改写它，而复制一个 6 字段字面量的代价远低于这类 bug。
 * @param decryptedDir - 解密数据根。
 * @returns 状态快照。
 */
export function vectorIndexStatus(decryptedDir: string): VectorIndexStatus {
  const p = vectorDbPath(decryptedDir)
  const sig = statSig(p)
  const hit = STATUS_CACHE.get(p)
  if (hit && hit.sig === sig) return { ...hit.status }
  const status = readVectorIndexStatus(p)
  STATUS_CACHE.set(p, { sig, status })
  return { ...status }
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

/** 构建结果。 */
export interface VectorBuildResult {
  status: string
  rows: number
  embedded: number
  embed_calls: number
  elapsed_ms: number
  message?: string
}

/**
 * 向量构建的单飞闸（按**向量库文件路径**键控）。
 *
 * N10：改前写事务从 `BEGIN` 一直开到所有 embedding 请求回来（跨网络，秒级到分钟级），
 * 同一进程里第二次并发调用直接撞 `database is locked`（实测 1555ms 内一个成功、另一个报错）。
 * 它有两个触发器：问答自动建库（gateway 的 ask 路径）与设置面板的「重建向量索引」按钮。
 * 键取 `vectorDbPath(decryptedDir)` 而不是调用方字符串：被争用的是**那个 DB 文件**，
 * `…\retrieval` 与 `…/retrieval`、带不带结尾分隔符都会落到同一个文件（同 H9 的教训）。
 *
 * force 语义与 `search.ts` 的索引闸一致：非 force 可加入任何在飞构建；
 * force 撞上在飞的非 force 构建时要排队重做，否则「点重建」会拿到对方「已是最新」的答复。
 */
const inflightVectorBuilds = new Map<string, { promise: Promise<VectorBuildResult>; force: boolean }>()

/**
 * 构建/增量更新向量索引。
 *
 * 增量策略：以 message_meta.rowid 为游标，只给尚未入库的行算向量。
 * 这样日常「新消息进来」只多算增量，不重算全库（全量 13.5 万条 ≈ 上万次 embedding，
 * 一次性做完会很久；增量后单次通常只有几十条）。
 *
 * 并发调用会被单飞闸合并到同一轮构建（见 `inflightVectorBuilds` 的说明）：
 * 两个调用方都能拿到成功结果，不会各写一遍、也不会互相撞锁。
 * @param decryptedDir - 解密数据根。
 * @param embed - embedding 函数（上层注入，已含隐私判断）。
 * @param opts - 模型名 / 批量 / 单次上限等。
 * @returns 构建结果。
 */
export function buildVectorIndex(
  decryptedDir: string,
  embed: EmbedFn,
  opts: { model: string; batchSize: number; maxCharsPerDoc: number; maxDocsPerBuild: number; concurrency?: number; onProgress?: (done: number, total: number) => void; force?: boolean },
): Promise<VectorBuildResult> {
  const key = vectorDbPath(decryptedDir)
  const slot = inflightVectorBuilds.get(key)
  if (slot && (slot.force || !opts.force)) return slot.promise
  // 走到这里：没有在飞构建，或本次要求 force 而在飞的是非 force 构建（后者排队重做）。
  const base: Promise<unknown> = slot ? slot.promise.catch(() => undefined) : Promise.resolve()
  const promise = base.then(() => runBuildVectorIndex(decryptedDir, embed, opts))
  const entry = { promise, force: Boolean(opts.force) }
  inflightVectorBuilds.set(key, entry)
  // 用双参 then 而非 finally：派生 promise 恒为 fulfilled，不会产生未处理的拒绝。
  const release = (): void => {
    if (inflightVectorBuilds.get(key) === entry) inflightVectorBuilds.delete(key)
    // N14：构建前后 rows/ready/built_at 都可能变，而指纹在 Windows 上只有 ~15.6ms 粒度、
    // 同尺寸的重建有可能撞出同一个指纹，所以本进程内的重建**显式**让状态缓存失效。
    invalidateVectorStatusCache(key)
  }
  promise.then(release, release)
  return promise
}

/**
 * 真正的构建过程（**两阶段**：先算、后写）。
 *
 * 阶段一只拿网络（不开写事务），阶段二一次事务写完（**不含 await**）。于是写事务的持有时间
 * 只与插入耗时相关、与网络往返无关；重建时的 `DELETE` 也挪进事务，失败整体回滚，
 * 已有索引不会被留成空表。
 * @param decryptedDir - 解密数据根。
 * @param embed - embedding 函数。
 * @param opts - 同 {@link buildVectorIndex}。
 * @returns 构建结果。
 */
async function runBuildVectorIndex(
  decryptedDir: string,
  embed: EmbedFn,
  opts: { model: string; batchSize: number; maxCharsPerDoc: number; maxDocsPerBuild: number; concurrency?: number; onProgress?: (done: number, total: number) => void; force?: boolean },
): Promise<VectorBuildResult> {
  const started = Date.now()
  const src = searchIndexPath(decryptedDir)
  if (!existsSync(src)) {
    return { status: 'no-source', rows: 0, embedded: 0, embed_calls: 0, elapsed_ms: 0, message: '稀疏索引不存在，请先建索引' }
  }
  const db = openVectorDb(decryptedDir, false)
  try {
    const prevModel = readMeta(db, 'model')
    const prevVer = readMeta(db, 'schema_version')
    /**
     * 是否整体重建：换模型（旧向量维度/语义都不兼容）或 schema 版本不符。
     *
     * 这里只**决定**、不执行 `DELETE` —— 删除要进事务（阶段二），否则中途失败会把已有索引
     * 留成空表（H9 第三轮在搜索路径上修过同一个问题，这里是同族）。
     */
    const reset = Boolean(opts.force || (prevVer && prevVer !== VECTOR_SCHEMA_VERSION) || (prevModel && prevModel !== opts.model))
    const done = new Set<number>()
    // reset 时不能把旧行当成「已有向量」：它们马上要被删掉，全库都要重算。
    if (!reset) {
      // 同样用游标：`.all()` 会先把整张 vectors 表物化成数组，而这里只是要建一个 Set
      // （20 万行时那是几十 MB 的多余副本）。注意本函数体内**不得再出现 `.all()`**，
      // 由 `vector-build-read.spec.ts` 的源码守卫钉住。
      for (const row of db.prepare('SELECT fts_rowid FROM vectors').iterate() as Iterable<{ fts_rowid: number }>) {
        done.add(Number(row.fts_rowid))
      }
    }

    /**
     * 待入库的行：**游标边读边判**（N8），并只保留轻量元组。
     *
     * 改前是 `SELECT … FROM message_meta ORDER BY rowid` 之后 `.all()` —— 整张表先物化成一个
     * 数组（实测 20 万行 / 单条 478 字符：**1876ms、RSS 峰值 +271.7MB**），而下面立刻
     * `filter(done).slice(0, maxDocsPerBuild)` 只留前几万条，物化全表纯属浪费。
     * 现在读到够数就 `break`，内存与 `maxDocsPerBuild` 同阶。
     *
     * 顺带不再让每行都持有自己的 `text` 字符串（478 字符 × 4 万行 ≈ 数十 MB）：
     * 文本只作为 `groups` 的**键**存在一份，行上只留
     * `(rid, username, localId, createTime)` 四个标量。
     */
    type PendingRow = { rid: number; username: string; localId: number; createTime: number }
    const groups = new Map<string, PendingRow[]>()
    /**
     * 单次构建的行数上限。
     *
     * 配置可手改且不做数值校验，所以这里显式归一：非有限数/≤0 一律按 0 处理（= 不构建，
     * 与改前 `slice(0, 0)` 的结果一致）。注意改前对**负数**会走 `slice(0, -n)` 的
     * 「去掉末尾 n 条」语义（笔误产物），这里按 0 收口 —— 有意分叉，与 M9 对 `pool` 的处理同例。
     */
    const cap = Number.isFinite(opts.maxDocsPerBuild) && opts.maxDocsPerBuild > 0
      ? Math.floor(opts.maxDocsPerBuild)
      : 0
    let pendingCount = 0
    const sdb = new DatabaseSync(src, { readOnly: true })
    try {
      const sql = 'SELECT m.rowid AS rid, m.text AS text, m.username AS username, m.local_id AS local_id, m.create_time AS create_time '
        + 'FROM message_meta m ORDER BY m.rowid'
      for (const r of sdb.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
        if (pendingCount >= cap) break
        const rid = Number(r['rid'] ?? 0)
        if (done.has(rid)) continue
        const text = String(r['text'] ?? '').slice(0, opts.maxCharsPerDoc)
        const tuple: PendingRow = {
          rid,
          username: String(r['username'] ?? ''),
          localId: Number(r['local_id'] ?? 0),
          createTime: Number(r['create_time'] ?? 0),
        }
        const g = groups.get(text)
        if (g) g.push(tuple)
        else groups.set(text, [tuple])
        pendingCount += 1
      }
    } finally {
      // 提前 break 时游标未读完：直接 close 是安全的（H9 第四轮已验证 iterate 的中途释放）
      sdb.close()
    }

    if (pendingCount === 0) {
      // 两行 meta 也进事务：省得「版本写了、时间没写」各占一半（派生数据也值得原子落地）
      db.exec('BEGIN')
      try {
        // N14：老库第一次走到这里时补上 `rows`，之后 `vectorIndexStatus` 就不必再 COUNT(*)
        //（缺键只可能是本改动之前建的库；新库在下面的主事务里已写好）
        const known = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
        writeMeta(db, 'rows', String(known))
        writeMeta(db, 'schema_version', VECTOR_SCHEMA_VERSION)
        writeMeta(db, 'built_at', new Date().toISOString().slice(0, 19).replace('T', ' '))
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* no tx */ }
        throw e
      }
      return { status: 'up-to-date', rows: done.size, embedded: 0, embed_calls: 0, elapsed_ms: Date.now() - started }
    }

    const ins = db.prepare('INSERT OR REPLACE INTO vectors(fts_rowid, doc_key, username, local_id, create_time, dim, vec, hash_lo, hash_hi) VALUES(?,?,?,?,?,?,?,?,?)')
    let embedCalls = 0
    let dim = 0
    /** 阶段一处理过的**行数**（用于进度；一个热门文本可能带几千行）。 */
    let processedRows = 0

    // ① **按「截断后的文本」分组**（分组表已在上面的游标循环里建好）：同一文本只 embed 一次，
    //    向量扇出到该组的所有行。真实数据实测 56.5% 的 text 是重复的（15.2 万行 → 6.6 万个
    //    不同文本），所以这一步直接省掉一半以上的请求。键用**截断后**的文本：那才是真正送进
    //    模型的输入，两个只在 200 字符之后不同的文本本来就得到同一个向量。
    const texts = [...groups.keys()]

    // 并发上限：来自配置，可能是 0/负数/小数/NaN（`rag-config.json` 可手改且不做数值校验），
    // 运行时夹到 [1, 16] —— 厂商普遍有速率限制，放开上限没有好处。
    const rawC = Number(opts.concurrency ?? 1)
    const concurrency = Math.min(Math.max(Number.isFinite(rawC) ? Math.floor(rawC) : 1, 1), 16)

    // batchSize 同样来自配置，也一起夹（手改 `"batchSize": 100000` 会发一个巨型请求）：
    // 下限 1、上限 256（厂商常见的单请求条数上限量级）。
    const rawB = Number(opts.batchSize)
    const batchSize = Math.min(Math.max(Number.isFinite(rawB) ? Math.floor(rawB) : 1, 1), 256)
    let next = 0
    let failure: unknown = null
    /**
     * 阶段一算出来的向量：**截断文本 → 向量字节与 SimHash**。
     *
     * 改前这里是「边算边写」——写发生在事务里，于是事务必须从第一批请求之前一直开到
     * 最后一批回来（N10 的病因）。现在改成先攒起来，阶段二再一次性写。内存上界 =
     * 唯一文本数 × (dim×4B + 常数)，由 `maxDocsPerBuild` 与真实重复率决定
     * （实测 15.2 万行里 6.6 万个唯一文本；默认 maxDocsPerBuild=40000 时约几万条 × 3KB）。
     */
    const vectors = new Map<string, { blob: Uint8Array; lo: number; hi: number }>()
    // ② 有界并发：worker 原子地认领下一批**唯一文本**；任一批失败就置 failure，
    //    其余 worker 立刻停手（在飞的请求回来后也**不再算**，此时一行都还没写）。
    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure) return
        const start = next
        next += batchSize
        if (start >= texts.length) return
        const batch = texts.slice(start, start + batchSize)
        let vecs: number[][]
        // 计数在**发起之前**：`embed_calls` 的语义是「发出了多少次请求」，
        // 放在 await 之后会让失败那次漏报（错误路径的口径就错了）。
        embedCalls += 1
        try {
          vecs = await embed(batch)
        } catch (e) {
          failure = failure ?? e
          return
        }
        if (failure) return
        for (let j = 0; j < batch.length; j += 1) {
          const key = batch[j]
          if (key === undefined) continue
          const groupRows = groups.get(key)
          if (!groupRows) continue
          const raw = vecs[j]
          if (raw && raw.length > 0) {
            const v = l2normalize(raw)
            dim = v.length
            const h = simhash(v, getPlanes(dim))
            vectors.set(key, { blob: vecToBlob(v), lo: h.lo, hi: h.hi })
          }
          // 进度按**行数**报（一个热门文本可能带几千行），口径与改前一致
          processedRows += groupRows.length
        }
        opts.onProgress?.(Math.min(processedRows, pendingCount), pendingCount)
        // 让出事件循环（复用 search.ts 的 yieldToLoop）：一批的 CPU（simhash 64×dim ≈ 0.037ms/篇）本身很小，但并发下几批会
        // 连在一起，这里显式让一次，保证建库期间后端仍能响应其它查询。
        await yieldToLoop()
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    // 阶段一失败：一行都没写（事务还没开），旧索引原样保留
    if (failure) throw failure

    // 阶段二是同步段，先让出一次，避免紧接在最后一批网络请求之后立刻长时间占住事件循环
    await yieldToLoop()

    /**
     * 阶段二：**一次事务写完，不含任何 await**。
     *
     * 事务持有时间 = 插入耗时（实测 1.8 万行扇出约 82ms、COMMIT 一次 fsync），
     * 与网络往返无关 —— 这正是 N10 要的「写事务持有时长远小于网络往返」。
     * `DELETE`（重建）也在这里：失败即 ROLLBACK，已有索引不会被留成空表。
     */
    let embedded = 0
    db.exec('BEGIN')
    try {
      if (reset) db.exec('DELETE FROM vectors')
      for (const [text, v] of vectors) {
        for (const r of groups.get(text) ?? []) {
          ins.run(
            r.rid, docKeyOf(r.username, r.localId), r.username, r.localId,
            r.createTime, dim, v.blob, v.lo, v.hi,
          )
          embedded += 1
        }
      }
      // 统计与 meta 一并进事务：COMMIT 即「新索引 + 版本 + 时间」原子落地
      // （H9 第四轮的做法；也消掉「索引换了但 meta 没写成功」的中间态）
      const total = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
      // N14：行数与 built_at 同事务写入，读侧一次 meta 查询即可，不必每次提问 COUNT(*)
      writeMeta(db, 'rows', String(total))
      writeMeta(db, 'schema_version', VECTOR_SCHEMA_VERSION)
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

// ── 内存粗筛表缓存：(dbPath, mtime) → {rowid, lo, hi}[] ──
const HASH_CACHE = new Map<string, { sig: string; rows: HashRow[] }>()

function loadHashRows(decryptedDir: string): HashRow[] {
  const p = vectorDbPath(decryptedDir)
  const sig = String(statSig(p))
  const hit = HASH_CACHE.get(p)
  if (hit && hit.sig === sig) return hit.rows
  const db = new DatabaseSync(p, { readOnly: true })
  /**
   * 这里**有意**一次性取回（N8 评估后的保留项）：它要的产物就是这个数组本身
   * —— 粗筛表按 (距离, 原顺序) 做计数选择，需要随机访问全部行，不是「边读边丢」的扫描。
   * 代价被两点约束住：① 按文件指纹缓存（`HASH_CACHE`，只在进程内首次/重建后付一次，
   * 实测加载 ≈250ms）；② 它只为稠密通道服务，且稠密通道本身可关闭。
   * 真要把它压下去得改成 mmap/分块，属结构性改动，不在本轮范围。
   */
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
      const dot = dotProduct(v, qv)
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
