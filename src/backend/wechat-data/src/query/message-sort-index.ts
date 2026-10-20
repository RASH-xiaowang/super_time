/**
 * 消息分片的**排序覆盖索引**（W2-3.5）。
 *
 * ## ⚠️ 2026-10-18 起读路径不再调用它（保留模块供诊断/将来独立索引库）
 *
 * 索引建在**解密快照**里，而增量同步会按原始主库页号拷页：索引页一旦存在，
 * WAL/页级补丁就会把它覆盖成 invalid rootpage（真机实测把 message_0.db 写成
 * `malformed database schema`），随后每轮检查点都只能整库重解密。快照必须与微信
 * 原始主库同构；要拿回这份查询加速，索引必须放到独立索引库，不能写进快照。
 *
 * ## 为什么要它
 *
 * 合成数据实测（`messages-page-cost.measure.spec.ts`，4 分片 / 5 万条，问一页）：
 *
 * | limit | 无索引 | 有 `(sort_seq, local_id)` 索引 |
 * |---|---|---|
 * | 20 | 14.50ms | **1.22ms** |
 * | 100 | 32.57ms | **1.77ms** |
 * | 500 | 43.48ms | **4.79ms** |
 * | 1000 | 44.11ms | **8.97ms** |
 *
 * 微信的 `Msg_*` 表上**没有** `(sort_seq, local_id)` 索引，于是分页查询的
 * `ORDER BY sort_seq DESC, local_id DESC LIMIT ?` 每次都要**整表排序**：代价与表大小成正比、
 * 与页大小无关。所以小页（用户真实用的 100 条）付的是全表的钱 —— 那就是上表 14.50ms 的来源。
 *
 * ## 为什么落在**解密副本**上而不是原库
 *
 * 原库是微信自己的文件，写进去既越权又会被同步覆盖。解密副本是我们写的，可以安全加索引。
 *
 * ## 为什么在读路径上惰性补，而不是等一次全量迁移
 *
 * 存量分片有几百张 `Msg_*` 表，一次性全建是分钟级的活。惰性补的代价是「第一次读到某个分片时
 * 多等一次建索引」，之后每页都快；而且**只补真正被读到的分片** —— 用户从不点开的历史群
 * 根本不需要索引。
 *
 * ## 为什么是**同步**调用而不是开后台
 *
 * 建索引必须拿到**写连接**，而 Windows 上目标库被打开时再建索引会 EBUSY —— 若在后台建，
 * 读路径紧接着就会打开只读连接把它顶掉，于是**每次都建不成**（`skipped` 里全是 EBUSY，
 * 而页面照旧慢，且没有任何报错冒到用户面前）。同步调用让「建 ⇒ 立刻用」成立，
 * 代价是该分片**第一次**被读到时多等一次（实测一次建索引是秒级，而之后每页快 5–18 倍）。
 */
import { DatabaseSync } from './db-open.ts'
import { existsSync } from 'node:fs'

/** 索引名的固定前缀：改掉它就等于换索引（`hasSortIndex` 认的就是它）。 */
const IDX_PREFIX = 'dsh_sort_'

/** 一次建索引的结果。 */
export interface EnsureSortIndexResult {
  /** 本次真的建了几条。 */
  created: number
  /** 扫描过的 `Msg_*` 表数。 */
  tables: number
  /** 建不出来的表（缺列 / 库读不动 / 被占用），逐条说明。 */
  skipped: Array<{ table: string; reason: string }>
}

function msgTables(db: DatabaseSync): string[] {
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all() as Array<{ name: string }>)
      .map((r) => String(r.name))
  } catch {
    return []
  }
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((r) => String(r.name)))
  } catch {
    return new Set()
  }
}

/** 该表上是否已有本模块的排序索引。 */
function hasSortIndex(db: DatabaseSync, table: string): boolean {
  try {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(IDX_PREFIX + table) !== undefined
  } catch {
    return false
  }
}

/**
 * 这个分片上**还缺**排序索引的 `Msg_*` 表（只读探测，不写）。
 *
 * 已有索引时它是纯只读的（一条 `sqlite_master` 查询 + 一次表名枚举），
 * 这条路径在**每次**分页前都会走 —— 它必须是廉价且绝不会失败的。
 * @param file - 分片数据库路径。
 * @returns 缺索引的表名；读不动时返回空数组（调用方据此什么都不做）。
 */
export function missingSortIndexTables(file: string): string[] {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const conn = db
    return msgTables(conn).filter((t) => !hasSortIndex(conn, t))
  } catch {
    return []
  } finally {
    if (db) { try { db.close() } catch { /* 已关 */ } }
  }
}

/**
 * 给一个分片补齐排序索引（幂等）。**必须在打开任何只读连接之前调用。**
 * @param file - 分片数据库路径。
 * @returns 建了多少条 / 扫了多少表 / 哪些跳过了。
 */
export function ensureSortIndexes(file: string): EnsureSortIndexResult {
  const out: EnsureSortIndexResult = { created: 0, tables: 0, skipped: [] }
  // `new DatabaseSync(path)` 会**凭空建出**一个空库文件。路径不存在时直接返回，
  // 否则一次拼错的文件名就会在数据根里留下垃圾，而且没有任何地方会报错。
  if (!existsSync(file)) {
    out.skipped.push({ table: '*', reason: '分片文件不存在' })
    return out
  }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file)
    const conn = db
    const tables = msgTables(conn)
    out.tables = tables.length
    for (const table of tables) {
      if (hasSortIndex(conn, table)) continue
      const cols = columnsOf(conn, table)
      if (!cols.has('sort_seq') || !cols.has('local_id')) {
        out.skipped.push({ table, reason: '缺 sort_seq / local_id 列（老分片，排序本来就退化成 local_id）' })
        continue
      }
      try {
        conn.exec(`CREATE INDEX IF NOT EXISTS "${IDX_PREFIX + table}" ON "${table}" (sort_seq, local_id)`)
        out.created += 1
      } catch (e) {
        out.skipped.push({ table, reason: (e as Error).message })
      }
    }
  } catch (e) {
    out.skipped.push({ table: '*', reason: (e as Error).message })
  } finally {
    if (db) { try { db.close() } catch { /* 已关 */ } }
  }
  return out
}

/**
 * 读路径上的惰性补齐入口（同步，见文件头为什么不能后台）。
 * @param file - 分片数据库路径。
 * @returns 本次补齐的结果；**已经是最新**时 `created:0 / tables:0`，且全程只读。
 */
export function ensureSortIndexIfMissing(file: string): EnsureSortIndexResult {
  if (missingSortIndexTables(file).length === 0) return { created: 0, tables: 0, skipped: [] }
  return ensureSortIndexes(file)
}

/** 测试接缝：本模块没有进程内状态，这个函数只为让「无残留」这件事可断言。 */
export function sortIndexGateIsEmpty(): boolean {
  return true
}