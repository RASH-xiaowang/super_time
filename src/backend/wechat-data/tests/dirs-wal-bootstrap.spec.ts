/**
 * N11：`dirs.ts` 的 bootstrap 在源库存在**活的** `-wal` 时，也必须拷出**当前**那一代。
 *
 * 背景（条目原文的实测）：WAL 模式下新提交的数据可以整代都还压在 `-wal` 里（主库只在
 * checkpoint 时才被回填），而 `buildSearchIndex` 收尾的 `PRAGMA wal_checkpoint(TRUNCATE)`
 * 在**有并发读者（游标未读完）时拿不到锁**（实测 `{busy:1, checkpointed:0}` 且不抛错）。
 * 改前 `copyTree` 只拷主库、把 `-wal`/`-shm` 当运行时产物跳过 → 静默拷出上一代索引
 * （实测 rows 少一半、`built_at` 是旧的）。
 *
 * 验收标准（条目原文）：数据根里存在活的 `-wal` 时，bootstrap 的结果与源库一致。
 * @vitest-environment node
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapWechatData, DATA_DIR_ENV, SOURCE_DIR_ENV } from '../src/dirs.ts'
import { buildSearchIndex } from '../src/query/search.ts'

/** 会话/消息夹具里的发送者。 */
const USER = 'wxid_a'

/** 第一代（已 checkpoint 进主库）。 */
const STALE_ROWS = 3000
/** 第二代（只落在 `-wal` 里）。 */
const LIVE_ROWS = 6000
const STALE_BUILT_AT = '2026-01-01 00:00:00'
const LIVE_BUILT_AT = '2026-02-02 00:00:00'

const scratch: string[] = []
/** 需要显式关闭的连接（持读者被有意留到用例结束）。 */
const openDbs: DatabaseSync[] = []
/**
 * 持住**未读完**的游标对象。
 *
 * 必须持有引用：只 `iterate().next()` 一次就把对象丢掉的话，GC 会终结语句、读标记随之释放，
 * 「读者挡住 checkpoint」这个前提就会随 GC 时机时有时无（实测过一次：同一夹具下主库自己变成
 * 了最新一代，用例退回假绿）。
 */
const heldCursors: Array<{ next: () => unknown }> = []

afterEach(() => {
  for (const db of openDbs) { try { db.close() } catch { /* 已关闭 */ } }
  openDbs.length = 0
  heldCursors.length = 0
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** 让一条只读连接持住「读到第一行」的快照（checkpoint 从此拿不到锁）。 */
function pinReadSnapshot(db: DatabaseSync, sql: string): void {
  const cursor = db.prepare(sql).iterate()
  cursor.next()
  heldCursors.push(cursor)
}

/** 建一个用完即清的临时目录。 */
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/**
 * 读一个索引库的 (行数, built_at)。读**当前**内容 —— 有 `-wal` 时会一并回放。
 * @param path - 索引库路径。
 * @returns 行数与 built_at。
 */
function readIndexSummary(path: string): { rows: number; builtAt: string | null } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM message_meta').get() as { c: number }).c
    const built = db.prepare("SELECT value FROM meta WHERE key='built_at'").get() as { value?: string } | undefined
    return { rows, builtAt: built?.value ?? null }
  } finally {
    db.close()
  }
}

/**
 * 造一个「最新一代只在 `-wal` 里」的索引库，并让读者把 checkpoint 挡在门外。
 *
 * 前提当场断言（否则用例会变成假绿）：第一代先 checkpoint 进主库；读者持一个**未读完**的
 * 游标；第二代提交后 `wal_checkpoint(TRUNCATE)` 必须返回 `busy:1 / checkpointed:0` ——
 * 与条目里第四轮的实测一致。
 * @param path - 索引库路径。
 * @returns 主库那一代的行数与源库真实（含 `-wal`）行数。
 */
function makeLiveWalIndex(path: string): { staleRows: number; liveRows: number } {
  const w = new DatabaseSync(path)
  w.exec('PRAGMA journal_mode = WAL')
  w.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  w.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL)')
  const ins = w.prepare('INSERT INTO message_meta(text) VALUES(?)')
  w.exec('BEGIN')
  for (let i = 1; i <= STALE_ROWS; i += 1) ins.run('gen1 ' + i)
  w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(STALE_BUILT_AT)
  w.exec('COMMIT')
  w.exec('PRAGMA wal_checkpoint(TRUNCATE)') // 第一代落进主库：此后主库 = 第一代
  w.close()

  // 读者持旧快照（游标未读完）：checkpoint 从此拿不到写锁
  const reader = new DatabaseSync(path, { readOnly: true })
  openDbs.push(reader)
  pinReadSnapshot(reader, 'SELECT rowid FROM message_meta')

  const w2 = new DatabaseSync(path)
  const ins2 = w2.prepare('INSERT INTO message_meta(text) VALUES(?)')
  w2.exec('BEGIN')
  for (let i = STALE_ROWS + 1; i <= LIVE_ROWS; i += 1) ins2.run('gen2 ' + i)
  w2.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(LIVE_BUILT_AT)
  w2.exec('COMMIT')
  const cp = w2.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number; checkpointed?: number }
  expect(Number(cp.busy), '前提不成立：读者没挡住 checkpoint，本用例会变成假绿').toBe(1)
  expect(Number(cp.checkpointed)).toBe(0)
  w2.close()
  return { staleRows: STALE_ROWS, liveRows: LIVE_ROWS }
}

describe('N11：bootstrap 必须连带拷 SQLite 主库的 -wal', () => {
  it('源库有活的 -wal 时，bootstrap 结果与源库一致（不再是上一代）', () => {
    const source = tmp('wx-src-')
    const index = join(source, 'wechat_search.db')
    const { staleRows, liveRows } = makeLiveWalIndex(index)

    // 前提：新一代确实全在 -wal 里（清空该文件就等于回到上一代）
    expect(statSync(index + '-wal').size).toBeGreaterThan(0)

    // 源库的「应然」内容（经 WAL 回放读到第二代）
    const truth = readIndexSummary(index)
    expect(truth).toEqual({ rows: liveRows, builtAt: LIVE_BUILT_AT })

    // 复演旧行为：只拷主库 → 上一代（rows 少一半、built_at 是旧的）
    const staleCopy = join(tmp('wx-stale-'), 'wechat_search.db')
    copyFileSync(index, staleCopy)
    expect(readIndexSummary(staleCopy)).toEqual({ rows: staleRows, builtAt: STALE_BUILT_AT })

    const root = tmp('wx-root-')
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    const dest = join(root, 'wechat_search.db')

    // -shm 是 WAL 索引（可重建的临时结构），SQLite 要求**不可**连同库一起搬
    expect(existsSync(dest + '-shm')).toBe(false)
    // 验收：bootstrap 的结果与源库一致
    expect(readIndexSummary(dest)).toEqual(truth)
    expect(result.walCarried).toContain(dest + '-wal')
  })

  it('源库没有活的 -wal 时不凭空多拷（也不引入 -shm）', () => {
    const source = tmp('wx-src-')
    const index = join(source, 'wechat_search.db')
    const w = new DatabaseSync(index)
    w.exec('PRAGMA journal_mode = WAL')
    w.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    w.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL)')
    w.exec('BEGIN')
    for (let i = 1; i <= 500; i += 1) w.prepare('INSERT INTO message_meta(text) VALUES(?)').run('only ' + i)
    w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(STALE_BUILT_AT)
    w.exec('COMMIT')
    w.close() // 最后一条连接关闭时会 checkpoint 并清掉 -wal

    expect(existsSync(index + '-wal'), '前提：这个夹具没有活的 -wal').toBe(false)

    const root = tmp('wx-root-')
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    const dest = join(root, 'wechat_search.db')
    expect(result.walCarried).toEqual([])
    expect(existsSync(dest + '-wal')).toBe(false)
    expect(readIndexSummary(dest)).toEqual({ rows: 500, builtAt: STALE_BUILT_AT })
  })

  it('嵌套目录里的真库同样带上 -wal（不是只对顶层 write store 生效）', () => {
    const source = tmp('wx-src-')
    const nested = join(source, 'decrypted', 'message')
    mkdirSync(nested, { recursive: true })
    const shard = join(nested, 'message_0.db')
    const { liveRows } = makeLiveWalIndex(shard)

    const root = tmp('wx-root-')
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    const destShard = join(root, 'decrypted', 'message', 'message_0.db')
    expect(readIndexSummary(destShard).rows).toBe(liveRows)
    expect(result.walCarried).toContain(destShard + '-wal')
  })

  it('非 SQLite 文件旁边的 -wal 仍按运行时产物跳过（既有规则不变）', () => {
    const source = tmp('wx-src-')
    const session = join(source, 'decrypted', 'session')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, 'session.db'), 'sqlite-session')
    writeFileSync(join(session, 'session.db-wal'), 'wal')

    const root = tmp('wx-root-')
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    expect(result.walCarried).toEqual([])
    expect(existsSync(join(root, 'decrypted', 'session', 'session.db-wal'))).toBe(false)
    expect(existsSync(join(root, 'decrypted', 'session', 'session.db-shm'))).toBe(false)
  })

  it('串上真实构建（3000 行建成 → 读者持旧读标记 → force 重建 6000 行）：拷出来的是 6000 行', async () => {
    // 这一段是条目里那次实测的复现：用**真**的 buildSearchIndex 造索引，第 2 代只落在 -wal 里，
    // 然后看 bootstrap 拿到的是哪一代 —— 改前这里读回 3000 行 / 旧 built_at。
    const source = tmp('wx-src-')
    const decrypted = join(source, 'decrypted')
    mkdirSync(join(decrypted, 'session'), { recursive: true })
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
    sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
    sdb.prepare("INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, '')").run(USER, USER)
    sdb.close()

    const table = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
    const mdb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    openDbs.push(mdb)
    mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = mdb.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?)`)
    const append = (from: number, to: number): void => {
      mdb.exec('BEGIN')
      for (let i = from; i <= to; i += 1) ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `普通消息 ${i}`, `srv${i}`, '')
      mdb.exec('COMMIT')
    }
    append(1, 3000)
    expect((await buildSearchIndex(decrypted, true)).rows).toBe(3000)

    const index = join(source, 'wechat_search.db')
    // 读者持旧读标记：H9 收尾那次 checkpoint 从此拿不到锁
    const reader = new DatabaseSync(index, { readOnly: true })
    openDbs.push(reader)
    pinReadSnapshot(reader, 'SELECT rowid FROM message_meta')

    append(3001, 6000)
    expect((await buildSearchIndex(decrypted, true)).rows).toBe(6000)

    // 前提：主库仍是上一代（条目里的实测形态）
    const staleCopy = join(tmp('wx-stale-'), 'wechat_search.db')
    copyFileSync(index, staleCopy)
    expect(readIndexSummary(staleCopy).rows, '前提不成立：主库自己就是最新一代，本用例测不到东西').toBe(3000)
    // 源库的「应然」内容（经 WAL 回放）
    const truth = readIndexSummary(index)
    expect(truth.rows).toBe(6000)

    const root = tmp('wx-root-')
    bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    expect(readIndexSummary(join(root, 'wechat_search.db'))).toEqual(truth)
  })
})
