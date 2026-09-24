/**
 * `query/search.ts` 的「索引的构建与同步：ensure/sync/build、让出预算、增量维护」部分（M21 拆分）。
 *
 * 从 `search.ts` 原样搬出，**行为逐字节不变**；`search.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './search.ts'` 的导入一行都不用改。
 *
 * @module search-build
 */

import { DatabaseSync } from 'node:sqlite'
import { dirname, join, basename } from 'node:path'
import type { SearchHit } from '../types.ts'
import { EnsureIndexResult, INDEX_SCHEMA_VERSION, REFRESHED_KEY, SHARD_WM_PREFIX, bigramTokens, decodeCell, ensureMetaIndexes, getSearchIndexFreshness, getSearchIndexStatus, indexReady, loadDisplayNames, loadSessionUsernames, messageShardFiles, msgTableName, readWatermarks, searchIndexBatch, searchIndexPath } from './search-scaffold.ts'
import { formatFullTime, readableMessageText, searchIndexMessages, senderLabel, splitGroupPrefix } from './search-query.ts'

/**
 * 保证索引**存在且包含最新的消息**（提问路径的唯一入口）。
 *
 * 这是把「索引过期」从**永不自愈**变成自愈的关键。旧实现只在 `!ready`（索引缺失 /
 * schema 版本不符）时构建，而 `ready` 与「分片里有没有新消息」毫无关系 ——
 * 索引一旦建成，之后微信写入的消息**永远不会**进入索引。实测生产索引
 * `built_at=2026-09-13`、库内最新消息 2026-09-11，而消息分片里已经有 2026-09-18 的
 * 对话（09-17 一天 139 条）。问「今天聊了啥」时当天数据根本不在检索空间里，
 * BM25 只能召回正文恰好写着「今天」的旧消息（同年 2/3/7 月）—— 这就是
 * 「回复内容不正确 + 消息列表里出现其他日期的消息」的根源。
 * @param decryptedDir - 已解密数据根。
 * @returns 本次动作与耗时（写进操作日志，便于解释「为什么这次提问慢」）。
 */
export async function ensureSearchIndex(decryptedDir: string): Promise<EnsureIndexResult> {
  const st = getSearchIndexStatus(decryptedDir)
  if (!st.ready) {
    const built = await buildSearchIndex(decryptedDir, false)
    return {
      action: 'build',
      elapsed_ms: built.elapsed_ms ?? 0,
      ...(built.rows !== undefined ? { rows: built.rows } : {}),
      ...(built.message ? { message: built.message } : {}),
    }
  }
  if (!getSearchIndexFreshness(decryptedDir).stale) return { action: 'none', elapsed_ms: 0 }
  const synced = await syncSearchIndex(decryptedDir)
  return {
    action: synced.status === 'ok' ? 'sync' : 'none',
    added: synced.added,
    elapsed_ms: synced.elapsed_ms,
    ...(synced.message ? { message: synced.message } : {}),
  }
}

/** 增量同步结果。 */
export interface SyncResult {
  status: 'ok' | 'skipped' | 'error'
  /** 本次新入索引的消息条数。 */
  added: number
  /** 本次实际读取的分片数。 */
  shards: number
  elapsed_ms: number
  message?: string
}

/**
 * 按索引文件路径键控的增量同步单飞闸。
 *
 * 理由与 `inflightIndexBuilds` 相同：写事务会跨 macrotask 保持开启，并发的第二次
 * 调用只会拿到 `database is locked`。并发调用直接复用同一个在飞同步。
 */
export const inflightIndexSyncs = new Map<string, Promise<SyncResult>>()

/**
 * 增量同步：只把「分片里新追加、尚未入索引」的消息补进 FTS。
 *
 * 为什么必须有它：微信是**持续写入**的，而 `buildSearchIndex` 的成本与**全量条数**
 * 同阶（实测 13.5 万条 5.4s），不可能每次提问都全量重建。水位线按**分片**记：
 * 分片是追加写的，`sort_seq > 水位线` 即「上次没读过的新行」，而 Msg_* 表上带有
 * 独立的 `_SORTSEQ` 索引，实测定位尾部 0ms（见 working/sync-feasibility.txt）。
 * 因此增量代价与**新增条数**同阶 —— 通常几十条、毫秒级。
 * @param decryptedDir - 已解密数据根。
 * @returns 同步结果（added = 新入索引的条数）。
 */
export function syncSearchIndex(decryptedDir: string): Promise<SyncResult> {
  const key = searchIndexPath(decryptedDir)
  const slot = inflightIndexSyncs.get(key)
  if (slot) return slot
  const promise = runSyncSearchIndex(decryptedDir)
  inflightIndexSyncs.set(key, promise)
  // 用双参 then 而非 finally：派生的 promise 恒为 fulfilled，不会产生未处理的拒绝。
  const release = (): void => {
    if (inflightIndexSyncs.get(key) === promise) inflightIndexSyncs.delete(key)
  }
  promise.then(release, release)
  return promise
}

/** 增量同步实现（见 syncSearchIndex 的说明）。 */
export async function runSyncSearchIndex(decryptedDir: string): Promise<SyncResult> {
  const started = Date.now()
  // 全量构建在飞时先等它：两者写同一个库，并发只会撞写锁。
  const building = inflightIndexBuilds.get(searchIndexPath(decryptedDir))
  if (building) {
    try { await building.promise } catch { /* 构建失败：下面照常尝试增量 */ }
  }
  const skip = (message: string): SyncResult => ({ status: 'skipped', added: 0, shards: 0, elapsed_ms: Date.now() - started, message })
  if (!indexReady(decryptedDir)) return skip('索引缺失或版本不符，需要全量构建')
  const shards = messageShardFiles(decryptedDir)
  if (shards.length === 0) return skip('消息分片清单为空（message 目录不可读？）')
  const usernames = loadSessionUsernames(decryptedDir)
  if (usernames.length === 0) return skip('会话清单为空')

  const names = loadDisplayNames(decryptedDir)
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(searchIndexPath(decryptedDir))
    // WAL + NORMAL：与全量构建同一套理由（读侧不被写事务挡住；派生数据不值得每次 fsync）。
    try { db.exec('PRAGMA journal_mode = WAL') } catch { /* 网络盘等不支持：退回 delete */ }
    try { db.exec('PRAGMA synchronous = NORMAL') } catch { /* 个别构建不支持，忽略 */ }
    ensureMetaIndexes(db)
    const wm = readWatermarks(db)
    const insMeta = db.prepare('INSERT INTO message_meta(text, username, create_time, sort_seq, local_id) VALUES(?, ?, ?, ?, ?)')
    const insFts = db.prepare('INSERT INTO message_fts(rowid, tokens, who) VALUES(?, ?, ?)')
    const insKv = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
    let added = 0
    let handled = 0
    let rowsSinceYield = 0
    let charsSinceYield = 0
    // 水位线的推进必须**在任何 continue 之前**：被跳过的行（图片/无可读文本）
    // 也已经读过一遍了，不推水位线就会在每次提问时重复读它们。
    const nextWm = new Map<string, number>()
    db.exec('BEGIN')
    for (const shard of shards) {
      const shardName = basename(shard)
      const since = wm.get(shardName) ?? 0
      let sdb: DatabaseSync | null = null
      try { sdb = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
      try {
        const tableSet = new Set(
          (sdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name),
        )
        let tail = since
        handled += 1
        for (const username of usernames) {
          const table = msgTableName(username)
          if (!tableSet.has(table)) continue
          let rows: Iterator<Record<string, unknown>>
          try {
            const sql = 'SELECT local_id, create_time, sort_seq, message_content, compress_content FROM "' + table + '" WHERE sort_seq > ?'
            rows = (sdb.prepare(sql).iterate(since) as Iterable<Record<string, unknown>>)[Symbol.iterator]()
          } catch { continue }
          const sessionWho = bigramTokens(names.get(username) ?? username)
          for (;;) {
            let step: IteratorResult<Record<string, unknown>>
            try { step = rows.next() } catch { break }
            if (step.done) break
            const r = step.value
            rowsSinceYield += 1
            const seq = Number(r['sort_seq'] ?? 0)
            if (seq > tail) tail = seq
            const raw = decodeCell(r['message_content']) || decodeCell(r['compress_content'])
            charsSinceYield += raw.length
            const { sender, body } = splitGroupPrefix(raw, username)
            const text = readableMessageText(body)
            if (text) {
              const who = sender
                ? sessionWho + ' ' + bigramTokens(names.get(sender) ?? sender)
                : sessionWho
              const res = insMeta.run(text, username, Number(r['create_time'] ?? 0), seq, Number(r['local_id'] ?? 0))
              insFts.run(Number(res.lastInsertRowid), bigramTokens(text), who)
              added += 1
            }
            // 周期性让出：同步是同步 sqlite + bigram 切分，纯 CPU，不让出会把
            // 承载全部 130+ 查询方法的 worker 钉住（与全量构建同一套阈值）。
            if (rowsSinceYield >= YIELD_EVERY_ROWS || charsSinceYield >= YIELD_EVERY_CHARS) {
              rowsSinceYield = 0
              charsSinceYield = 0
              await yieldToLoop()
            }
          }
        }
        if (tail > since) nextWm.set(shardName, tail)
      } finally {
        try { sdb.close() } catch { /* ignore */ }
      }
    }
    for (const [shardName, seq] of nextWm) insKv.run(SHARD_WM_PREFIX + shardName, String(seq))
    insKv.run(REFRESHED_KEY, String(Date.now()))
    db.exec('COMMIT')
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* 有并发读者时 checkpoint 失败，忽略 */ }
    return { status: 'ok', added, shards: handled, elapsed_ms: Date.now() - started }
  } catch (e) {
    try { db?.exec('ROLLBACK') } catch { /* 无活动事务 */ }
    return { status: 'error', added: 0, shards: 0, elapsed_ms: Date.now() - started, message: (e as Error).message }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * 按时间窗口直取消息（**纯时间问法**专用）。
 *
 * 为什么需要它：「今天聊了啥」这类问题**没有内容词** —— 拆出来的 bigram 全是
 * 「今天 / 天聊 / 聊了 / 了啥」，BM25 命中的是正文恰好写着「今天」的消息
 * （实测命中的是同年 2/3/7 月的旧对话），而当天真实消息一条都召不回来
 * （结构化通道按日期过滤后 0 命中 → `hintHits=0`）。纯时间问法的正解是
 * **按日期段枚举**，不做任何内容匹配。
 *
 * 只读我们自己维护的 `message_meta`（`(username, create_time)` 索引），
 * 不碰 200+ 张微信会话表。
 * @param decryptedDir - 已解密数据根。
 * @param fromSec - 起始（含，秒）。
 * @param toSec - 结束（含，秒）。
 * @param limit - 最多返回多少条（**按时间新→旧截断**，即保留窗口内最近的）。
 * @param username - 可选的会话范围。
 * @returns 命中（时间新→旧）与索引是否就绪。
 */
export function listMessagesInRange(
  decryptedDir: string,
  fromSec: number,
  toSec: number,
  limit?: number,
  username?: string,
): { hits: SearchHit[]; ready: boolean } {
  if (!indexReady(decryptedDir)) return { hits: [], ready: false }
  const lo = Math.floor(Math.min(fromSec, toSec))
  const hi = Math.ceil(Math.max(fromSec, toSec))
  if (!(lo > 0) || !(hi >= lo)) return { hits: [], ready: false }
  const cap = Math.min(Math.max(limit ?? 120, 1), 600)
  try {
    const db = new DatabaseSync(searchIndexPath(decryptedDir), { readOnly: true })
    const sql = 'SELECT text, username, create_time, local_id FROM message_meta WHERE create_time BETWEEN ? AND ?'
      + (username ? ' AND username = ?' : '')
      + ' ORDER BY create_time DESC LIMIT ?'
    const args: Array<string | number> = username ? [lo, hi, username, cap] : [lo, hi, cap]
    const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>
    db.close()
    const names = loadDisplayNames(decryptedDir)
    const hits = rows.map((r) => {
      const text = decodeCell(r['text'])
      const uname = decodeCell(r['username'])
      const ts = Number(r['create_time'] ?? 0)
      const { sender, body } = splitGroupPrefix(text, uname)
      return {
        text,
        username: uname,
        create_time: ts,
        local_id: Number(r['local_id'] ?? 0),
        name: names.get(uname) ?? uname,
        time: formatFullTime(ts),
        snippet: body.replace(/\s+/g, ' ').slice(0, 120),
        sender: senderLabel(sender, names),
      }
    })
    return { hits, ready: true }
  } catch {
    return { hits: [], ready: false }
  }
}

/**
 * 让出节奏（行数上界）：限制「行数多、每行却很短」的场景。
 *
 * 2000 行的固定开销（逐行解码/判空 + 批量写入）大约几十毫秒，既能把单次阻塞压到远低于
 * 「秒级」，又不会因为过于频繁的 await 明显拖慢构建。
 */
export const YIELD_EVERY_ROWS = 2000

/**
 * 让出节奏（字符上界）：限制「每行很长」的场景。
 *
 * bigram 切分与 FTS 写入的成本 ∝ 文本长度，所以只按行数设阈值时单块耗时随平均行长线性
 * 增长。取值按**实测**成本定：中文每字符约 0.33µs（bigram 下每个汉字都是独立 token，同
 * 字符数比拉丁文本贵 4–10 倍），131072 字符 ≈ 中文 30–70ms、拉丁 6–10ms。
 * 早期版本取 1<<20（约 105 万字符），实测中文单块已达 237–533ms、属「秒级临界」，故收紧。
 */
export const YIELD_EVERY_CHARS = 1 << 17

/**
 * 单次批量写入（flush）的字符上界。
 *
 * flush 的代价随批量内容长度线性增长，而它必然落在某个「让出块」里：500 行 × 64KB/行时
 * 单次 flush 实测 3.5s、1MB/行时 60.2s。只给循环设上界、不给批量设上界，单块耗时就没有
 * 上界。65536 字符 ≈ 中文 20ms 量级。
 */
export const FLUSH_EVERY_CHARS = 1 << 16

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
export const inflightIndexBuilds = new Map<string, { promise: Promise<BuildResult>; force: boolean }>()

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

export async function runBuildSearchIndex(
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
    //
    // `content=''`（FTS5 的「无内容表」）：**这两列从来没人读回去** —— 取原文一律走
    // `JOIN message_meta`，高亮是应用层自己算的（`kb-search.ts` 里同样的口径写着为什么不用
    // `snippet()`）。既然不读，把 42MB 的 tokens 串再抄一份进 FTS 的内容表就是纯浪费：
    // 实测同一份夹具（700 行 × 21000 汉字）插入 2268ms → 1829ms，索引文件 372MB → 175MB。
    // 代价要说清楚，两条都是这张表的**用法约束**：① 不许 `SELECT tokens/who FROM message_fts`
    // （拿不到，只查得到 MATCH / bm25 / rowid）；② 不许对它发 `DELETE`（重建走的是事务里的
    // `DROP TABLE` + 重建，本来就不是 DELETE）。由 `search-fts-contentless.spec.ts` 钉住。
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(tokens, who, tokenize='unicode61', content='')")
    db.exec('CREATE TABLE IF NOT EXISTS message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL, username TEXT NOT NULL, create_time INTEGER NOT NULL DEFAULT 0, sort_seq INTEGER NOT NULL DEFAULT 0, local_id INTEGER NOT NULL DEFAULT 0)')
    // 时间范围索引：纯时间问法（「今天聊了啥」）要按 create_time 直取一个日期段。
    ensureMetaIndexes(db)
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
    // 分片 → 本次读到过的最大 sort_seq。构建完成后写进 meta，供增量同步当水位线。
    // 必须按**读过的全部行**推进（包括没有可读文本、被跳过的图片/系统消息），
    // 否则那些行会在每次增量同步里被反复重读。
    const shardWm = new Map<string, number>()
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
    for (const shard of shards) {
      let sdb: DatabaseSync | null = null
      try { sdb = new DatabaseSync(shard, { readOnly: true }) } catch (e) { recordSkip(shard, e); continue }
      // 一次问出「这个分片装了哪些会话表」，再按表读。旧布局是 `for username { for shard { 开这个分片 } }`，
      // 于是**开合数 = 会话数 × 分片数**（真实库上是几百到几千次 open/close，每次都为了问一句「你有没有我的表」），
      // 而这件事分片自己就知道 —— 增量同步 `runSyncSearchIndex` 早就是下面这个形状了，两边对齐。
      let tableSet: Set<string>
      try {
        tableSet = new Set((sdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name))
      } catch (e) {
        recordSkip(shard, e)
        sdb.close()
        continue
      }
      try {
        for (const username of usernames) {
          const table = msgTableName(username)
          if (!tableSet.has(table)) continue
          // 会话名进 who 列：问「李四」时，与李四的会话本身就该命中，
          // 而不是只匹配到正文里恰好写了「李四」的消息（实测旧路径找的全是合同表单里的字段值）。
          const sessionWho = bigramTokens(names.get(username) ?? username)
          let rows: Iterator<Record<string, unknown>>
          try {
            // 不再只取 local_type=1：转账/链接/文件/引用等 appmsg 与系统提示
            // 都带可读文本，且往往正是用户问题的答案。文本统一走 readableMessageText 抽取。
            const sql = 'SELECT local_id, create_time, sort_seq, message_content, compress_content FROM "' + table + '"'
            // 用 iterate() 而不是 all()：全量物化会让峰值与「单会话消息数」同阶
            // （百万级库上就是数百 MB）。边读边写 FTS，读完即释放。
            rows = (sdb.prepare(sql).iterate() as Iterable<Record<string, unknown>>)[Symbol.iterator]()
          } catch (e) {
            // 建语句 / 读表头失败：跳过这个（会话, 分片）对 —— 口径与旧布局一致（旧布局的 continue
            // 也是只跳过当前用户名在这一片上的读取），错误仍然记进 skipped。
            recordSkip(shard, e)
            continue
          }
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
              const wmPrev = shardWm.get(shard) ?? 0
              if (sortSeq > wmPrev) shardWm.set(shard, sortSeq)
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
          if (batch.length >= 500) flush()
        }
      } finally {
        sdb.close()
      }
    }
    flush()
    flush()
    // 统计与 meta 写放在 COMMIT **之前**：这样「新索引 + built_at + schema_version」是同一次
    // 原子提交。留在 COMMIT 之后时，meta 写失败会留下「索引已换新但 meta 没写成功」的中间态
    // （实测：旧索引被换成新索引、built_at 丢失）。
    total = (db.prepare('SELECT COUNT(*) AS c FROM message_meta').get() as { c: number }).c
    const builtAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(builtAt)
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(INDEX_SCHEMA_VERSION)
    // 水位线与 refreshed_ms 和索引本体同一次提交：否则「新索引 + 旧水位线」的中间态
    // 会让下一次增量把整个分片重读一遍（重复入索引）。
    const insKv = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
    for (const [shardPath, seq] of shardWm) insKv.run(SHARD_WM_PREFIX + basename(shardPath), String(seq))
    insKv.run(REFRESHED_KEY, String(Date.now()))
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
