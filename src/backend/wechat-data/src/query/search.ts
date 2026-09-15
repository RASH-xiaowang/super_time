/**
 * WeChat full-text message search index (FTS5), rewritten from st_control
 * chat_search_index.rs. The index DB lives next to the decrypted dir
 * (data/wechat/wechat_search.db); search prefers the index and falls back
 * to a bounded full-table scan over the message shards.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { decompress } from 'fzstd'
import type { SearchHit } from '../types.ts'
import { contactMeta, shardCatalog } from './meta.ts'

/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** 索引 schema 版本：结构变化时自动重建（存在 meta 表里）。 */
const INDEX_SCHEMA_VERSION = '3'

/**
 * 把文本切成「unicode61 能正确检索」的形态。
 *
 * 为什么必须这么做：FTS5 靠 tokenizer 切词，而 node:sqlite 只带 `unicode61` ——
 * 它把一整串汉字当成**一个** token，于是 `微信转账收到转账` 里查 `转账` 永远匹配不到，
 * 中文全文检索直接失效（这也是旧代码退回 `LIKE` 的原因，而 LIKE 没有任何相关度排序）。
 *
 * 解法是经典的中文 bigram 索引：**写入时**把每个汉字串拆成相邻 2 字窗口并用空格分隔，
 * 检索时用同样的规则拆查询词，`unicode61` 便能把它们当作独立 token 建 BM25 索引。
 *   微信转账收到转账 → "微信 信转 转账 账收 收到 到转 转账"
 * 查 `转账` → 命中 token `转账`；查 `聊天记录` → 短语 "聊天 天记 记录"（要求连续，精度高）。
 * 拉丁/数字串按整词小写处理；标点丢弃。
 * @param text - 原始文本。
 * @returns 空格分隔的 token 串。
 */
export function bigramTokens(text: string): string {
  const out: string[] = []
  for (const run of String(text || '').match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g) || []) {
    if (/^[A-Za-z0-9_]+$/.test(run)) {
      out.push(run.toLowerCase())
      continue
    }
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out.join(' ')
}

/** 把一个检索词编成 FTS5 短语：bigram 之间要求连续出现（精度优先）。 */
function ftsPhrase(term: string): string {
  const toks = bigramTokens(term).split(' ').filter(Boolean)
  if (toks.length === 0) return ''
  if (toks.length === 1) return '"' + toks[0].replace(/"/g, '') + '"'
  return '"' + toks.join(' ') + '"'
}

/** 索引是否可用（存在且版本匹配）。 */
function indexReady(decryptedDir: string): boolean {
  const p = searchIndexPath(decryptedDir)
  if (!existsSync(p)) return false
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM message_meta').get() as { c: number }).c
    const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined
    db.close()
    return rows > 0 && ver?.value === INDEX_SCHEMA_VERSION
  } catch {
    return false
  }
}

/**
 * 某个词在索引里的文档频率（df）。
 *
 * 用途：判断一个词是「有区分度的内容词」还是「到处都是的水词/跨词切分噪音」。
 * BM25 自身会在排序时用到 df，但**过滤**词项需要提前知道它 ——
 * 例如兜底 bigram `次转`/`账给`（来自「最近一次转账」的相邻字切分）df 极低，
 * 却是合法的 token 命中，不过滤就会把真正的「转账」通知挤出前列（实测）。
 * @param decryptedDir - decrypted data root.
 * @param term - 检索词。
 * @returns 命中文档数（索引不可用时返回 -1）。
 */
export function countIndexMatches(decryptedDir: string, term: string): number {
  if (!indexReady(decryptedDir)) return -1
  const phrase = ftsPhrase(term)
  if (!phrase) return 0
  try {
    const db = new DatabaseSync(searchIndexPath(decryptedDir), { readOnly: true })
    const row = db.prepare('SELECT COUNT(*) AS c FROM message_fts WHERE message_fts MATCH ?').get(phrase) as { c: number }
    db.close()
    return Number(row?.c ?? 0)
  } catch {
    return -1
  }
}

/**
 * 一次 MATCH 检索全部词项（BM25 排序的全库召回）。
 *
 * 相比旧的「每个词各查一次 LIKE、各取前 20 条、按行号倒序」，这里：
 *   ① BM25 真的按相关度排序，而不是按插入顺序取前 N；
 *   ② 命中数不再被 per-term cap 截断成任意样本
 *      （实测 `合同` 全库 4062 条，旧路径只看得到 20 条 = 0.49% 召回率）；
 *   ③ bm25() 直接给出真实的词 IDF 与词频加权，不再需要 1/(1+hits) 这种近似；
 *   ④ 会话名/发送者名单独存一列（who），「问某人」能命中与他的会话，而不只是正文里出现名字。
 * @param decryptedDir - decrypted data root.
 * @param terms - 检索词（中文按 bigram 短语处理）。
 * @param limit - 最多返回多少条候选。
 * @param opts - 可选的会话范围与人物线索。
 * @returns 按 BM25 排序的命中（含 score，越大越相关）。
 */
export function searchIndexBatch(
  decryptedDir: string,
  terms: string[],
  limit = 400,
  opts?: { username?: string; person?: string },
): { hits: SearchHit[]; ranked: boolean } {
  if (!indexReady(decryptedDir)) return { hits: [], ranked: false }
  const parts = terms.map(ftsPhrase).filter(Boolean)
  if (opts?.person) {
    const who = ftsPhrase(opts.person)
    if (who) parts.push('who:' + who)
  }
  if (parts.length === 0) return { hits: [], ranked: false }
  const match = parts.join(' OR ')
  try {
    const db = new DatabaseSync(searchIndexPath(decryptedDir), { readOnly: true })
    const sql = 'SELECT m.text, m.username, m.create_time, m.local_id, bm25(message_fts) AS score'
      + ' FROM message_fts JOIN message_meta m ON m.rowid = message_fts.rowid'
      + ' WHERE message_fts MATCH ?'
      + (opts?.username ? ' AND m.username = ?' : '')
      + ' ORDER BY rank LIMIT ?'
    const args: Array<string | number> = opts?.username ? [match, opts.username, limit] : [match, limit]
    const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>
    db.close()
    const names = loadDisplayNames(decryptedDir)
    const hits = rows.map((r) => {
      const text = decodeCell(r['text'])
      const username = decodeCell(r['username'])
      const createTime = Number(r['create_time'] ?? 0)
      const { sender, body: display } = splitGroupPrefix(text, username)
      return {
        text,
        username,
        create_time: createTime,
        local_id: Number(r['local_id'] ?? 0),
        name: names.get(username) ?? username,
        time: formatFullTime(createTime),
        snippet: display.slice(0, 120),
        sender: senderLabel(sender, names),
        // bm25() 越小越相关，取负号变成「越大越相关」
        score: -Number(r['score'] ?? 0),
      }
    })
    return { hits, ranked: true }
  } catch {
    return { hits: [], ranked: false }
  }
}

/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data: Buffer): Buffer | null {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(data)) } catch { return null }
  }
  return null
}

/**
 * Index DB path: sibling of the decrypted dir.
 * @param decryptedDir - decrypted data root.
 * @returns the absolute path of the search index DB.
 */
export function searchIndexPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_search.db')
}

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** Decode a BLOB or TEXT cell to UTF-8 text (zstd + GBK aware). */
function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = tryDecompress(raw)
  const bytes = decompressed ?? raw
  // UTF-8 first; GBK fallback for legacy-encoded fields.
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(bytes)
  }
}

/** Message shard DB files under <decrypted>/message (catalog-backed, sorted). */
function messageShardFiles(decryptedDir: string): string[] {
  return shardCatalog(decryptedDir).map(s => s.file)
}

/** Session usernames from session.db (SessionTable or Session). */
function loadSessionUsernames(decryptedDir: string): string[] {
  const dbPath = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(dbPath)) return []
  const out: string[] = []
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
    const table = tables.includes('SessionTable') ? 'SessionTable' : tables.includes('Session') ? 'Session' : ''
    if (table) {
      const rows = db.prepare('SELECT username FROM "' + table + '"').all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const u = decodeCell(r['username']).trim()
        if (u) out.push(u)
      }
    }
    db.close()
  } catch {
    // session.db unavailable
  }
  return out
}

/** Display names: contact remark/nick then session titles. */
function loadDisplayNames(decryptedDir: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const [u, n] of contactMeta(decryptedDir).names) names.set(u, n)
  const sessionDb = join(decryptedDir, 'session', 'session.db')
  if (existsSync(sessionDb)) {
    try {
      const db = new DatabaseSync(sessionDb, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionNoContactInfoTable'").get() !== undefined
      if (has) {
        const rows = db.prepare('SELECT username, session_title FROM SessionNoContactInfoTable').all() as Array<Record<string, unknown>>
        for (const r of rows) {
          const u = decodeCell(r['username'])
          const t = decodeCell(r['session_title']).trim()
          if (u && t && !names.has(u)) names.set(u, t)
        }
      }
      db.close()
    } catch {
      // session.db unavailable
    }
  }
  return names
}

/**
 * Search index status.
 * @param decryptedDir - decrypted data root.
 * @returns whether the index exists plus row count and built_at timestamp.
 */
export function getSearchIndexStatus(decryptedDir: string): { exists: boolean; rows: number; built_at: string | null; ready: boolean } {
  const p = searchIndexPath(decryptedDir)
  if (!existsSync(p)) return { exists: false, rows: 0, built_at: null, ready: false }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM message_meta').get() as { c: number }).c
    const built = db.prepare("SELECT value FROM meta WHERE key='built_at'").get() as { value?: string } | undefined
    const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined
    db.close()
    return { exists: true, rows, built_at: built?.value ?? null, ready: rows > 0 && ver?.value === INDEX_SCHEMA_VERSION }
  } catch {
    return { exists: true, rows: 0, built_at: null, ready: false }
  }
}

/**
 * 让出节奏（行数上界）：限制「行数多、每行却很短」的场景。
 *
 * 2000 行的固定开销（逐行解码/判空 + 批量写入）大约几十毫秒，既能把单次阻塞压到远低于
 * 「秒级」，又不会因为过于频繁的 await 明显拖慢构建。
 */
const YIELD_EVERY_ROWS = 2000

/**
 * 让出节奏（字符上界）：限制「每行很长」的场景。
 *
 * bigram 切分与 FTS 写入的成本 ∝ 文本长度，所以只按行数设阈值时单块耗时随平均行长线性
 * 增长。取值按**实测**成本定：中文每字符约 0.33µs（bigram 下每个汉字都是独立 token，同
 * 字符数比拉丁文本贵 4–10 倍），131072 字符 ≈ 中文 30–70ms、拉丁 6–10ms。
 * 早期版本取 1<<20（约 105 万字符），实测中文单块已达 237–533ms、属「秒级临界」，故收紧。
 */
const YIELD_EVERY_CHARS = 1 << 17

/**
 * 单次批量写入（flush）的字符上界。
 *
 * flush 的代价随批量内容长度线性增长，而它必然落在某个「让出块」里：500 行 × 64KB/行时
 * 单次 flush 实测 3.5s、1MB/行时 60.2s。只给循环设上界、不给批量设上界，单块耗时就没有
 * 上界。65536 字符 ≈ 中文 20ms 量级。
 */
const FLUSH_EVERY_CHARS = 1 << 16

/**
 * 构建单飞闸（按**索引文件路径**键控）。
 *
 * 转 async 带来的副作用：写事务现在会**跨 macrotask** 保持开启，于是同一进程里
 * 第二次并发调用会直接撞 `database is locked`（改前同步执行不可能交错）。
 * 而 gateway 的问答路径与状态查询都会按需触发自动建索引，很容易撞上。
 * 这里让并发调用复用同一个 in-flight 构建。
 *
 * 键取 `searchIndexPath()` 而不是调用方传入的 `decryptedDir` 字符串：被争用的是**那个 DB
 * 文件**，而 `…\decrypted` 与 `…/decrypted`、带不带结尾分隔符都会解析到同一个文件。按调用
 * 方字符串键控时这些写法会各占一个槽、并发写同一个文件 —— 实测互相撞锁且事件循环停摆
 * 7.5s（`busy_timeout` 只会把「立刻失败」变成「同步忙等后仍失败」）。
 *
 * force 语义：非 force 调用可以加入任何在飞构建；force 调用若撞上在飞的非 force 构建，
 * 不能把对方的「索引已存在」当答复，而要排队在其之后再真正重建一次。
 */
const inflightIndexBuilds = new Map<string, { promise: Promise<BuildResult>; force: boolean }>()

/** 构建结果。 */
export interface BuildResult {
  status: string
  rows?: number
  built_at?: string
  elapsed_ms?: number
  message?: string
}

/**
 * 构建全文检索索引（FTS5）。
 *
 * @param decryptedDir - 已解密数据根。
 * @param force - 为 true 时即使已有同版本索引也重建。
 * @returns 构建结果（status/rows/built_at/elapsed_ms 或 message）。
 */
export function buildSearchIndex(decryptedDir: string, force?: boolean): Promise<BuildResult> {
  const key = searchIndexPath(decryptedDir)
  const slot = inflightIndexBuilds.get(key)
  if (slot && (slot.force || !force)) return slot.promise
  // 走到这里：没有在飞构建，或本次要求 force 而在飞的是非 force 构建（后者要排队重建）。
  const base: Promise<unknown> = slot ? slot.promise.catch(() => undefined) : Promise.resolve()
  const promise = base.then(() => runBuildSearchIndex(decryptedDir, force))
  const entry = { promise, force: Boolean(force) }
  inflightIndexBuilds.set(key, entry)
  // 用双参 then 而非 finally：派生的 promise 恒为 fulfilled，不会产生未处理的拒绝。
  const release = (): void => {
    if (inflightIndexBuilds.get(key) === entry) inflightIndexBuilds.delete(key)
  }
  promise.then(release, release)
  return promise
}

/**
 * 索引库写闸（同步、不排队）。
 *
 * 索引库有**两个写者**：`buildSearchIndex` 与 `query/members.ts` 的 `contact_fts` 构建。
 * 构建在飞时写事务跨 macrotask 持有写锁，第二个写者只会拿到 `database is locked`；
 * 而 `searchMembers` 是**同步**契约（`@Remote`，改 async 会动客户端契约与 `/api.ts`），
 * 没法 await 排队等闸。
 *
 * 所以这里的语义不是「等锁」，而是「拿不到就**明确**告诉调用方」，由调用方显式降级 ——
 * 而不是先去撞写锁、被拒后再把错误吞掉（实测 40k 行构建在飞时，155/155 次成员搜索走的
 * 就是那条「尝试写→被拒→静默退化为 LIKE」的路）。
 *
 * 键与构建闸一致（`searchIndexPath()`）：被争用的是同一个 DB 文件。
 * @param decryptedDir - 已解密数据根。
 * @param fn - 临界区。必须是同步的：闸不排队，临界区里出现 await 就等于没上锁。
 * @returns 拿到闸时 `{ok:true, value: fn()}`；有构建在飞时 `{ok:false}`。
 */
export function withIndexWrite<T>(decryptedDir: string, fn: () => T): { ok: true; value: T } | { ok: false } {
  if (inflightIndexBuilds.has(searchIndexPath(decryptedDir))) return { ok: false }
  return { ok: true, value: fn() }
}

async function runBuildSearchIndex(
  decryptedDir: string,
  force?: boolean,
): Promise<BuildResult> {
  const p = searchIndexPath(decryptedDir)
  const db = new DatabaseSync(p)
  // WAL：让**读者**在重建窗口内不被写事务挡住。delete/journal 模式下写事务一旦溢出页缓存
  // 就持 EXCLUSIVE 到 COMMIT，整段窗口读者被拒（实测溢出点约 1.75MB）；WAL 下 74–155 次
  // 探测 0 次被拒。
  // synchronous = NORMAL：索引是可重建的派生数据，不值得为每次 COMMIT 付一次 fsync ——
  // 收尾的 COMMIT 正是 20 万行 438ms 的主导项。WAL + NORMAL 断电最坏丢最近几次提交，
  // 但不会损坏库。
  // 不设 busy_timeout：进程内争用交给上面的单飞闸；跨进程时快速失败（实测 16ms）比冻结
  // 整个 worker 好。注意早前把「事件循环停摆 7.5s」归因于 busy_timeout **是错的**：
  // 实测那是旧布局「DDL 在事务外各自 autocommit」的产物。DDL 进事务后写锁冲突走
  // 「延迟事务的读写升级」路径，压根不会调用 busy 处理器（三形态探针：BEGIN;写 3341ms /
  // autocommit 写 3328ms / BEGIN;读;写 1ms）。
  try { db.exec('PRAGMA journal_mode = WAL') } catch { /* 网络盘等不支持 WAL：退回 delete，仅损失读侧并发 */ }
  try { db.exec('PRAGMA synchronous = NORMAL') } catch { /* 个别构建不支持该 PRAGMA，忽略 */ }
  const init = (): void => {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    // tokens 列存 bigram 切分后的文本、who 列存「会话名 + 群内发送者」，两列都进 BM25 索引；
    // 原文存在 message_meta 里（不重复索引），rowid 一一对应。
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(tokens, who, tokenize='unicode61')")
    db.exec('CREATE TABLE IF NOT EXISTS message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL, username TEXT NOT NULL, create_time INTEGER NOT NULL DEFAULT 0, sort_seq INTEGER NOT NULL DEFAULT 0, local_id INTEGER NOT NULL DEFAULT 0)')
  }
  try {
    // 事务外的 init() 只为「查 existing / schema_version」而建表：首次构建时落地空表，
    // 已有索引时是 no-op。
    init()
    const existing = (db.prepare('SELECT COUNT(*) AS c FROM message_meta').get() as { c: number }).c
    const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined
    if (!force && existing > 0 && ver?.value === INDEX_SCHEMA_VERSION) {
      return { status: 'exists', rows: existing, message: '索引已存在，使用 force=true 可重建' }
    }
    const started = Date.now()
    const names = loadDisplayNames(decryptedDir)
    const usernames = loadSessionUsernames(decryptedDir)
    const shards = messageShardFiles(decryptedDir)
    // 分片清单为空、但已经存在一份索引 —— 这几乎只可能是 message 目录读不到（临时不可读、
    // 盘掉线、路径变了），而不是「用户真的删光了消息」。此时照常 DROP 会把一份完好的索引
    // 换成空索引，且对外报 status:'ok'（实测：rows 200 → 0、无 message、ready=false）。
    // 宁可直接失败，让调用方看到原因。
    if (shards.length === 0 && existing > 0) {
      throw new Error(`消息分片清单为空（message 目录不可读？），已中止重建以免清空现有 ${existing} 行索引`)
    }
    db.exec('BEGIN')
    // DDL 与 DELETE 必须在事务内：放在事务外时它们各自 autocommit，读者会在整个重建窗口
    // 里看到「表被删/被清空」的半成品状态 —— getSearchIndexStatus 报 ready:false、
    // searchIndexBatch 静默返回空、searchIndexMessages 退化成 LIKE 全表扫描；而且重建中途
    // 失败会把已有索引留成空表。挪进事务后配合 WAL，读者整段窗口都读到旧索引。
    db.exec('DROP TABLE IF EXISTS message_fts')
    db.exec('DROP TABLE IF EXISTS message_meta')
    init()
    db.exec("DELETE FROM meta WHERE key='built_at'")
    let total = 0
    // 距上次让出的事件循环用量（行数与字符数，任一超限即让出）。
    let rowsSinceYield = 0
    let charsSinceYield = 0
    let batch: Array<[string, string, string, string, number, number, number]> = []
    let batchChars = 0
    // 被跳过的分片（读取侧错误）。这不是「忽略」：既写进结果 message，也打 stderr，
    // 否则一个缺行的索引对外与完整索引无法区分（读侧见 ready:true → 永不重建）。
    let skippedCount = 0
    const skipped: string[] = []
    const recordSkip = (shard: string, e: unknown): void => {
      skippedCount += 1
      const detail = basename(shard) + ': ' + (e as Error).message
      if (skipped.length < 5) skipped.push(detail)
      console.warn('[search] 跳过不可读分片 ' + detail)
    }
    const flush = (): void => {
      if (batch.length === 0) return
      const insMeta = db.prepare('INSERT INTO message_meta(text, username, create_time, sort_seq, local_id) VALUES(?, ?, ?, ?, ?)')
      const insFts = db.prepare('INSERT INTO message_fts(rowid, tokens, who) VALUES(?, ?, ?)')
      for (const [text, tokens, who, username, createTime, sortSeq, localId] of batch) {
        const r = insMeta.run(text, username, createTime, sortSeq, localId)
        insFts.run(Number(r.lastInsertRowid), tokens, who)
      }
      batch = []
      batchChars = 0
    }
    for (const username of usernames) {
      const table = msgTableName(username)
      // 会话名进 who 列：问「李四」时，与李四的会话本身就该命中，
      // 而不是只匹配到正文里恰好写了「李四」的消息（实测旧路径找的全是合同表单里的字段值）。
      const sessionWho = bigramTokens(names.get(username) ?? username)
      for (const shard of shards) {
        let sdb: DatabaseSync | null = null
        try { sdb = new DatabaseSync(shard, { readOnly: true }) } catch (e) { recordSkip(shard, e); continue }
        let rows: Iterator<Record<string, unknown>>
        try {
          const has = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
          if (!has) { sdb.close(); continue }
          // 不再只取 local_type=1：转账/链接/文件/引用等 appmsg 与系统提示
          // 都带可读文本，且往往正是用户问题的答案。文本统一走 readableMessageText 抽取。
          const sql = 'SELECT local_id, create_time, sort_seq, message_content, compress_content FROM "' + table + '"'
          // 用 iterate() 而不是 all()：全量物化会让峰值与「单会话消息数」同阶
          // （百万级库上就是数百 MB）。边读边写 FTS，读完即释放。
          rows = (sdb.prepare(sql).iterate() as Iterable<Record<string, unknown>>)[Symbol.iterator]()
        } catch (e) {
          // 建语句 / prepare 失败：跳过该分片（记录，不静默）
          recordSkip(shard, e)
          sdb.close()
          continue
        }
        try {
          // 只有**读取**被包进可跳过的 catch：分片损坏时跳过它是有意的容错。
          // 索引写入（flush）必须留在外面 —— 写失败要向上抛并 ROLLBACK，否则会 COMMIT 出
          // 一个缺行的索引却仍报 status:'ok'（读侧见 ready:true，于是永不重建）。
          for (;;) {
            let step: IteratorResult<Record<string, unknown>>
            try { step = rows.next() } catch (e) { recordSkip(shard, e); break }
            if (step.done) break
            const r = step.value
            // 计量必须在任何 continue **之前**：被跳过的行同样付了 zstd 解压与解码成本。
            // 图片/系统消息这类「无可读文本」的行在真实账号里占比很高且会连续成片，
            // 实测 30 万条这种行若不计次，单块能连续跑 1.1s 且一次都不让出。
            rowsSinceYield += 1
            const localId = Number(r['local_id'] ?? 0)
            const createTime = Number(r['create_time'] ?? 0)
            const sortSeq = Number(r['sort_seq'] ?? localId)
            const raw = decodeCell(r['message_content']) || decodeCell(r['compress_content'])
            charsSinceYield += raw.length
            const { sender, body } = splitGroupPrefix(raw, username)
            const text = readableMessageText(body)
            if (text) {
              const who = sender
                ? sessionWho + ' ' + bigramTokens(names.get(sender) ?? sender)
                : sessionWho
              batch.push([text, bigramTokens(text), who, username, createTime, sortSeq, localId])
              batchChars += text.length
            }
            // 批量写入也纳入预算：行长很大时单次 flush 自己就能跑几十秒（见 FLUSH_EVERY_CHARS）。
            if (batch.length >= 500 || batchChars >= FLUSH_EVERY_CHARS) flush()
            // 周期性让出事件循环：同步 sqlite + bigram 切分是纯 CPU，不让出就会
            // 让整个 worker（承载全部 130+ 个查询方法）停摆数秒。
            if (rowsSinceYield >= YIELD_EVERY_ROWS || charsSinceYield >= YIELD_EVERY_CHARS) {
              rowsSinceYield = 0
              charsSinceYield = 0
              await yieldToLoop()
            }
          }
        } finally {
          sdb.close()
        }
      }
      if (batch.length >= 500) flush()
    }
    flush()
    // 统计与 meta 写放在 COMMIT **之前**：这样「新索引 + built_at + schema_version」是同一次
    // 原子提交。留在 COMMIT 之后时，meta 写失败会留下「索引已换新但 meta 没写成功」的中间态
    // （实测：旧索引被换成新索引、built_at 丢失）。
    total = (db.prepare('SELECT COUNT(*) AS c FROM message_meta').get() as { c: number }).c
    const builtAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(builtAt)
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(INDEX_SCHEMA_VERSION)
    db.exec('COMMIT')
    // WAL 里可能还压着整代新数据（有并发读者时 close 不会 checkpoint）。主动截断一次让主库
    // 尽快自包含 —— 否则「只拷 wechat_search.db、不拷 -wal」的拷贝路径会静默拿到上一代索引
    // （dirs.ts 的 bootstrap 正是拷主库、跳过 -wal/-shm）。
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* 有并发读者时 checkpoint 失败，忽略 */ }
    const result: BuildResult = { status: 'ok', rows: total, built_at: builtAt, elapsed_ms: Date.now() - started }
    if (skippedCount > 0) result.message = `已跳过 ${skippedCount} 个不可读分片：${skipped.join('; ')}`
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* no active tx */ }
    throw new Error('构建搜索索引失败: ' + (e as Error).message)
  } finally {
    db.close()
  }
}

/**
 * 让出事件循环。
 *
 * node:sqlite 全是同步 API，所以「跑很久」= 「把承载全部查询的 worker 钉住」。
 * 只能靠 await 把控制权交回：`setImmediate` 让 I/O 与其它请求的微/宏任务插进来。
 * 索引构建按「行数 ∨ 字符数」周期性调用它 —— 否则百万行会一次性阻塞数秒。
 *
 * 导出给其它「周期性让出」的构建路径复用（如 `retrieval/embedding.ts` 的向量建库），
 * 免得各自内联一份、各自踩坑。
 */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

/** Split the group-message sender prefix (`wxid_xxx:\n`) into sender id + body. */
function splitGroupPrefix(text: string, username: string): { sender: string; body: string } {
  if (!username.endsWith('@chatroom')) return { sender: '', body: text }
  const m = text.match(/^[A-Za-z0-9_@.\-]{3,64}:\n/)
  return m ? { sender: m[0].slice(0, -2), body: text.slice(m[0].length) } : { sender: '', body: text }
}

/** Strip the group-message sender prefix (wxid_xxx:\n) from display text. */
function stripGroupPrefix(text: string, username: string): string {
  return splitGroupPrefix(text, username).body
}

/** 群内发送者的显示名（联系人表里有就用名字，否则退回 wxid）。 */
function senderLabel(sender: string, names: Map<string, string>): string {
  if (!sender) return ''
  return names.get(sender) ?? sender
}

/**
 * 从 appmsg / 系统消息的 XML 里抽出可读文本。
 *
 * 微信把「转账、链接、文件、引用、系统提示」这类消息存成
 * `<msg><appmsg><title><![CDATA[微信转账]]></title><des>收到转账1500.00元…</des>…`
 * —— **不是**纯文本。旧索引只收 `local_type=1`，于是「微信转账收到转账1500元」
 * 这类消息完全不在索引里，而它恰恰是「最近一次转账给我的是谁」的唯一答案（实测）。
 * 这里按字段名抽取（title/des/content…），并剥掉标签与 CDATA。
 * @param raw - 原始消息内容（可能是 XML 也可能是纯文本）。
 * @returns 可读文本（无可读内容时返回空串）。
 */
function readableMessageText(raw: string): string {
  const t = String(raw || '').trim()
  if (!t) return ''
  if (!t.startsWith('<')) return t
  const parts: string[] = []
  for (const tag of ['title', 'des', 'content', 'nickname', 'username']) {
    let from = 0
    while (parts.length < 8) {
      const si = t.indexOf('<' + tag, from)
      if (si < 0) break
      const gt = t.indexOf('>', si)
      if (gt < 0) break
      const ei = t.indexOf('</' + tag, gt)
      if (ei < 0) break
      let v = t.slice(gt + 1, ei).trim()
      const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
      if (cdata) v = cdata[1]
      v = v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      if (v) parts.push(v)
      from = ei + 1
    }
    if (parts.length >= 8) break
  }
  return parts.join('  ').trim()
}

/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function formatFullTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 一条会话窗口内的消息（用于 chunk 级上下文：单条微信消息几乎不构成检索单元）。 */
export interface WindowMessage {
  local_id: number
  sort_seq: number
  create_time: number
  text: string
  sender: string
}

/** (分片|表名) → 该表是否存在。窗口展开会按会话反复查同一张表，缓存掉这个探测。 */
const windowTableCache = new Map<string, boolean>()

/**
 * 取某个会话在 centerMs 前后 spanMs 内的连续消息（对话窗口）。
 *
 * 为什么便宜：Msg_* 表上带 `(local_type, sort_seq)` 复合索引，窗口查询走
 * `SEARCH ... USING INDEX _TYPE_SEQ`，实测 0ms。这是 chunk 级检索可行的前提 ——
 * 单条消息「我没答应」本身无法回答「谁答应过什么」，必须带上前后的对话。
 *
 * @param decryptedDir - decrypted data root.
 * @param username - 会话 username。
 * @param centerMs - 窗口中心（毫秒时间戳）。
 * @param spanMs - 前后各取多少毫秒。
 * @param limit - 窗口内最多几条。
 * @returns 按时间升序的消息；会话不可读时返回空数组（调用方退化为单条引用）。
 */
export function loadMessageWindow(
  decryptedDir: string,
  username: string,
  centerMs: number,
  spanMs: number,
  limit = 14,
): WindowMessage[] {
  if (!username || !Number.isFinite(centerMs) || centerMs <= 0) return []
  const table = msgTableName(username)
  const lo = Math.max(0, Math.floor(centerMs - spanMs))
  const hi = Math.floor(centerMs + spanMs)
  const out: WindowMessage[] = []
  for (const shard of messageShardFiles(decryptedDir)) {
    const key = shard + '|' + table
    let has = windowTableCache.get(key)
    if (has === undefined) {
      let probe: DatabaseSync | null = null
      try {
        probe = new DatabaseSync(shard, { readOnly: true })
        has = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      } catch {
        has = false
      } finally {
        try { probe?.close() } catch { /* ignore */ }
      }
      windowTableCache.set(key, has)
    }
    if (!has) continue
    let sdb: DatabaseSync | null = null
    try {
      sdb = new DatabaseSync(shard, { readOnly: true })
      const rows = sdb.prepare(
        'SELECT local_id, sort_seq, create_time, message_content FROM "' + table + '"'
        + ' WHERE local_type=1 AND sort_seq BETWEEN ? AND ? ORDER BY sort_seq LIMIT ?',
      ).all(lo, hi, limit) as Array<Record<string, unknown>>
      for (const r of rows) {
        const raw = decodeCell(r['message_content']).trim()
        if (!raw || raw.startsWith('<')) continue
        const { sender, body } = splitGroupPrefix(raw, username)
        const text = body.replace(/\s+/g, ' ').trim()
        if (!text) continue
        out.push({
          local_id: Number(r['local_id'] ?? 0),
          sort_seq: Number(r['sort_seq'] ?? 0),
          create_time: Number(r['create_time'] ?? 0),
          text,
          sender,
        })
      }
      // 同一会话的窗口只落在一个分片里；命中即停，避免把全部分片扫一遍
      if (out.length > 0) break
    } catch {
      /* 分片不可读：跳过 */
    } finally {
      try { sdb?.close() } catch { /* ignore */ }
    }
  }
  return out
}

/**
 * Search WeChat's own message_fts.db (message_fts_v4_* + ImgFts*) which
 * covers text AND image messages, mapping session_id back through name2id.
 * @returns hits (empty when the built-in index is absent/empty).
 */
function searchWechatFts(
  decryptedDir: string,
  q: string,
  cap: number,
  names: Map<string, string>,
  scopeUsername?: string,
): { hits: SearchHit[] } {
  const p = join(decryptedDir, 'message', 'message_fts.db')
  if (!existsSync(p)) return { hits: [] }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const sessions = new Map<number, string>()
    try {
      const rows = db.prepare('SELECT rowid AS id, username AS u FROM name2id').all() as Array<{ id: number; u: unknown }>
      for (const r of rows) sessions.set(r.id, decodeCell(r.u))
    } catch { /* no name2id */ }
    const out: SearchHit[] = []
    const like = '%' + q.replace(/[%_]/g, ' ') + '%'
    for (const [content, aux] of [
      ['message_fts_v4_0_content', 'message_fts_v4_aux_0'],
      ['message_fts_v4_1_content', 'message_fts_v4_aux_1'],
      ['message_fts_v4_2_content', 'message_fts_v4_aux_2'],
      ['message_fts_v4_3_content', 'message_fts_v4_aux_3'],
    ] as const) {
      try {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(content) !== undefined
        if (!exists) continue
        const sql = 'SELECT c.c0 AS c, a.message_local_id AS lid, a.sort_seq AS ss, a.session_id AS sid FROM "' + content + '" c LEFT JOIN "' + aux + '" a ON a.rowid = c.id WHERE c.c0 LIKE ? ORDER BY c.id DESC LIMIT ?'
        const rows = db.prepare(sql).all(like, cap) as Array<Record<string, unknown>>
        for (const r of rows) {
          const username = sessions.get(Number(r['sid'])) ?? ''
          // 会话范围必须真的过滤（此前兜底路径忽略 scope，选了会话仍混入其他会话）
          if (scopeUsername && username !== scopeUsername) continue
          const text = decodeCell(r['c'])
          const { sender, body: display } = splitGroupPrefix(text, username)
          // sort_seq 是毫秒时间戳：恢复 create_time，时间筛选与显示才可用（此前恒为 0，时间范围会把命中全部滤掉）
          const ssMs = Number(r['ss'] ?? 0)
          const createTime = ssMs > 1e12 ? Math.floor(ssMs / 1e3) : ssMs > 1e9 ? Math.floor(ssMs) : 0
          out.push({
            text,
            username,
            create_time: createTime,
            local_id: Number(r['lid'] ?? 0),
            name: names.get(username) ?? username,
            time: createTime ? formatFullTime(createTime) : '',
            snippet: display.slice(0, 120),
            sender: senderLabel(sender, names),
          })
          if (out.length >= cap) break
        }
      } catch { /* shard unavailable */ }
      if (out.length >= cap) break
    }
    db.close()
    return { hits: out }
  } catch {
    return { hits: [] }
  }
}

/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @returns hits plus whether the index was used.
 */
export function searchIndexMessages(
  decryptedDir: string,
  query: string,
  limit?: number,
  username?: string,
): { hits: SearchHit[]; total: number; indexed: boolean } {
  const q = (query || '').trim()
  if (!q) return { hits: [], total: 0, indexed: false }
  const cap = Math.min(limit ?? 100, 300)
  const names = loadDisplayNames(decryptedDir)
  // ---- 自建 BM25 索引优先（bigram 切分 + 真实 IDF + 相关度排序）----
  const indexed = searchIndexBatch(decryptedDir, [q], cap, username ? { username } : undefined)
  if (indexed.ranked && indexed.hits.length > 0) {
    return { hits: indexed.hits, total: indexed.hits.length, indexed: true }
  }
  // ---- WeChat built-in content tables (LIKE, tokenizer-independent) ----
  const builtin = searchWechatFts(decryptedDir, q, cap, names, username)
  if (builtin.hits.length > 0) return { hits: builtin.hits, total: builtin.hits.length, indexed: false }

  // ---- Full-table scan fallback ----
  const hits: SearchHit[] = []
  const qLower = q.toLowerCase()
  let budget = 800_000
  const shards = messageShardFiles(decryptedDir)
  const scopeUsernames = username ? [username] : loadSessionUsernames(decryptedDir).slice(0, 800)
  for (const username of scopeUsernames) {
    if (hits.length >= cap || budget <= 0) break
    const table = msgTableName(username)
    for (const shard of shards) {
      if (hits.length >= cap || budget <= 0) break
      let sdb: DatabaseSync | null = null
      try { sdb = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
      const has = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) { sdb.close(); continue }
      try {
        const sql = 'SELECT local_id, create_time, message_content FROM "' + table + '" WHERE local_type=1'
        // 用 iterate() 而不是 all()：all() 会把整张 Msg_ 表先物化成一个数组，
        // 单会话几十万条时峰值直接与消息数同阶；而下面本来就是逐条判断后即丢。
        for (const r of sdb.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
          budget -= 1
          if (hits.length >= cap || budget <= 0) break
          const localId = Number(r['local_id'] ?? 0)
          const ts = Number(r['create_time'] ?? 0)
          const text = decodeCell(r['message_content']).replace(/\n/g, ' ').trim()
          if (!text || !text.toLowerCase().includes(qLower)) continue
          const { sender, body: display } = splitGroupPrefix(text, username)
          const dIdx = display.toLowerCase().indexOf(qLower)
          const dStart = Math.max(0, dIdx < 0 ? 0 : dIdx - 20)
          const snippet = (dStart > 0 ? '…' : '') + display.slice(dStart, dStart + 100)
          hits.push({
            text,
            username,
            create_time: ts,
            local_id: localId,
            name: names.get(username) ?? username,
            time: formatFullTime(ts),
            snippet,
            sender: senderLabel(sender, names),
          })
        }
      } catch {
        // skip unreadable shard
      } finally {
        sdb.close()
      }
    }
  }
  return { hits, total: hits.length, indexed: false }
}
