/**
 * W2-8.5：bootstrap 的**撕裂窗口**（Tearing）—— 源端有活的 `-wal` 时改走 `VACUUM INTO`。
 *
 * ## N11 留下的洞
 *
 * N11 已经修掉「只拷主库会静默落后一代」，办法是把 `-wal` 一起带过去。但那是**两次独立的
 * 文件读**，中间源端还在跑：checkpoint 期间 SQLite 是**直接把页写进主库文件**的，
 * 于是拷到的主库可能停在「回填了一半」的那一代，而 `-wal` 里又留着已经回填过的帧 ——
 * 两半拼起来不是任何一代。撕裂窗口不需要任何 bug，只需要源端还在写。
 *
 * `VACUUM INTO` 是 SQLite 官方的「一致性单文件快照」入口：读事务里把库整份重写到一个
 * **新**文件，写出来的必然自洽、天然没有 `-wal`。窗口不是被缩小，是从根上不存在。
 *
 * ## 怎么把「撕裂」做成可复现的
 *
 * 真实磁盘上没有与权限/平台无关的办法在拷贝中途插一个 checkpoint，所以 mock 掉 `cpSync`，
 * 让它对 SQLite 库文件只写一半（`truncateSync`）—— 这正是撕裂写的样子。
 * mock 只替 `cpSync`，其余透传；`node:sqlite` 不动，所以源库仍是真库、读取仍是真读。
 *
 * 这份 spec 同时钉住「那个 mock 不是空转」：无 `-wal` 的库照旧走 `cpSync`，于是它**会**被撕。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** `cpSync` 替身的状态：开哪条路、撕了几个文件。 */
const torn = vi.hoisted(() => ({ on: false, copies: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    cpSync: (src: Parameters<typeof actual.cpSync>[0], dest: Parameters<typeof actual.cpSync>[1], opts?: Parameters<typeof actual.cpSync>[2]) => {
      const isFileCopy = opts?.recursive !== true
      const isSqliteArtifact = /\.(db)$|-wal$/.test(String(src))
      if (!torn.on || !isFileCopy || !isSqliteArtifact) return actual.cpSync(src, dest, opts)
      torn.copies += 1
      actual.cpSync(src, dest, { recursive: false })
      // 只写一半：真实世界里这就是「拷到一半源端被改 / 磁盘写了一半」。
      actual.truncateSync(dest, Math.max(1, Math.floor(actual.statSync(dest as string).size / 2)))
    },
  }
})

const { bootstrapWechatData, DATA_DIR_ENV, SOURCE_DIR_ENV } = await import('../src/dirs.ts')

/** 第一代（已 checkpoint 进主库）的行数。 */
const STALE_ROWS = 3000
const LIVE_ROWS = 6000
const STALE_BUILT_AT = '2026-01-01 00:00:00'
const LIVE_BUILT_AT = '2026-02-02 00:00:00'

const scratch: string[] = []
const openDbs: DatabaseSync[] = []
const heldCursors: Array<{ next: () => unknown }> = []

beforeEach(() => { torn.on = false; torn.copies = 0 })
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

/** 造一个用完即清的临时目录。 */
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** 读一个索引库的 (行数, built_at)，读的是**当前**内容（有 `-wal` 时会一并回放）。 */
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
 * @param path - 索引库路径。
 */
function makeLiveWalIndex(path: string): void {
  const w = new DatabaseSync(path)
  w.exec('PRAGMA journal_mode = WAL')
  w.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  w.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL)')
  w.exec('BEGIN')
  for (let i = 1; i <= STALE_ROWS; i += 1) w.prepare('INSERT INTO message_meta(text) VALUES(?)').run('gen1 ' + i)
  w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(STALE_BUILT_AT)
  w.exec('COMMIT')
  w.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  w.close()

  const reader = new DatabaseSync(path, { readOnly: true })
  openDbs.push(reader)
  pinReadSnapshot(reader, 'SELECT rowid FROM message_meta')

  const w2 = new DatabaseSync(path)
  w2.exec('BEGIN')
  for (let i = STALE_ROWS + 1; i <= LIVE_ROWS; i += 1) w2.prepare('INSERT INTO message_meta(text) VALUES(?)').run('gen2 ' + i)
  w2.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(LIVE_BUILT_AT)
  w2.exec('COMMIT')
  w2.close()
}

/** 造一个「已经 checkpoint 干净、没有 `-wal`」的索引库。 */
function makeCheckpointedIndex(path: string): void {
  const w = new DatabaseSync(path)
  w.exec('PRAGMA journal_mode = WAL')
  w.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  w.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL)')
  w.exec('BEGIN')
  for (let i = 1; i <= STALE_ROWS; i += 1) w.prepare('INSERT INTO message_meta(text) VALUES(?)').run('gen1 ' + i)
  w.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(STALE_BUILT_AT)
  w.exec('COMMIT')
  w.close()
  expect(existsSync(path + '-wal'), '前提：这个夹具不该留下活的 -wal').toBe(false)
}

describe('W2-8.5 bootstrap 的撕裂窗口', () => {
  it('源端有活 -wal：即便文件级拷贝被撕成半截，拷出来的仍是自洽快照', () => {
    const source = tmp('wx-tear-src-')
    const index = join(source, 'wechat_search.db')
    makeLiveWalIndex(index)
    expect(statSync(index + '-wal').size, '前提：最新一代确实只在 -wal 里').toBeGreaterThan(0)
    const truth = readIndexSummary(index)
    expect(truth).toEqual({ rows: LIVE_ROWS, builtAt: LIVE_BUILT_AT })

    const root = tmp('wx-tear-root-')
    torn.on = true
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    const dest = join(root, 'wechat_search.db')

    // 自洽快照：内容与源库一致，且**目标端不携带 -wal**（撕裂窗口正是这两次读造成的）。
    expect(readIndexSummary(dest), '拷出来的不是源库那一代').toEqual(truth)
    expect(existsSync(dest + '-wal'), '走了自洽快照却还留着 -wal ⇒ 撕裂窗口没消掉').toBe(false)
    expect(result.vacuumed, '没留痕：下一个看日志的人无法判断这次拷的是不是最新一代').toContain(dest)
    expect(result.walCarried).toEqual([])
    // 前提自证：这条路径确实**一次文件拷贝都没发生**，否则撕裂 mock 是空转的。
    expect(torn.copies, '仍然走了文件级拷贝 ⇒ 撕裂窗口还在，这条用例是假绿').toBe(0)
  })

  it('源端没有活 -wal：照旧走文件拷贝（证明上一个用例的撕裂 mock 是活的）', () => {
    const source = tmp('wx-tear-src-')
    const index = join(source, 'wechat_search.db')
    makeCheckpointedIndex(index)

    const root = tmp('wx-tear-root-')
    torn.on = true
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    const dest = join(root, 'wechat_search.db')

    expect(torn.copies, '无 -wal 的库没有被文件拷贝 ⇒ 撕裂 mock 根本没生效，上面那条就是假绿').toBeGreaterThan(0)
    expect(result.vacuumed).toEqual([])
    // 拷到的是半截文件：SQLite 直接报 `database disk image is malformed`。
    // 这正是旧路径在真实世界里会交出来的东西 —— 也是为什么「两次独立读」不能接受。
    expect(() => readIndexSummary(dest), '半截的库居然读得出来 ⇒ 撕裂 mock 没撕中，上面那条就是假绿').toThrowError(/malformed|corrupt/i)
  })

  it('VACUUM INTO 失败 ⇒ 退回「主库 + -wal」，bootstrap 不能因此失败', () => {
    // 文件头是 SQLite（isSqliteDatabase 只看 16 字节头）但内容是垃圾：
    // SQLite 打不开 ⇒ VACUUM INTO 抛错 ⇒ 必须退回 N11 那条路。
    const source = tmp('wx-tear-src-')
    const broken = join(source, 'wechat_search.db')
    writeFileSync(broken, Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(8192, 0x41)]))
    writeFileSync(broken + '-wal', Buffer.alloc(64, 0x42))

    const root = tmp('wx-tear-root-')
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    const dest = join(root, 'wechat_search.db')
    expect(existsSync(dest), '退路也没跑 ⇒ bootstrap 直接失败了，这比撕裂更糟').toBe(true)
    // ⚠ 两条都要断言：`walCarried` 只是**留痕**，真正要看的是文件在不在。
    //   只断言留痕的话，把那句 cpSync 删掉用例照样全绿 —— 第一版就漏在这里。
    expect(existsSync(dest + '-wal'), '退路没把 -wal 真的拷过去（N11 的判据，不能因为本条丢掉）').toBe(true)
    expect(result.walCarried, '退路必须给「这次带了 -wal」留痕').toContain(dest + '-wal')
    expect(result.vacuumed).toEqual([])
  })

  it('非 SQLite 文件旁边的 -wal 仍按运行时产物跳过（既有规则不变）', () => {
    const source = tmp('wx-tear-src-')
    const session = join(source, 'decrypted', 'session')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, 'session.db'), 'sqlite-session')
    writeFileSync(join(session, 'session.db-wal'), 'wal')

    const root = tmp('wx-tear-root-')
    const result = bootstrapWechatData({ [SOURCE_DIR_ENV]: source, [DATA_DIR_ENV]: root })
    expect(result.walCarried).toEqual([])
    expect(result.vacuumed, '非 SQLite 文件不该走 VACUUM INTO').toEqual([])
    expect(existsSync(join(root, 'decrypted', 'session', 'session.db-wal'))).toBe(false)
    expect(existsSync(join(root, 'decrypted', 'session', 'session.db-shm'))).toBe(false)
  })
})