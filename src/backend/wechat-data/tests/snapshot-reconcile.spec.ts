/**
 * reconcileSnapshotWal: 启动时对快照目录里的 `-wal` 做 quick_check + checkpoint / 隔离。
 *
 * 全部用**真** `node:sqlite` 夹具（参考 `sync-wal.spec.ts` 的 WAL 构造）：
 * 不 mock SQLite 行为，因为这里要证明的正是「SQLite 自己能不能把这些帧合回主文件」。
 * @vitest-environment node
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileSnapshotWal } from '../src/query/snapshot-reconcile.ts'

const PAGE_SZ = 4096
const WAL_HEADER_SZ = 32

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** 建一个临时快照根目录。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-reconcile-'))
  scratch.push(root)
  return root
}

/**
 * 造一对**有效**的「主文件 + 有帧 WAL」。
 *
 * 做法：先在 `live-src.db` 里建表并写入基线；切到 WAL 后先 TRUNCATE checkpoint，
 * 让主文件带上 WAL 模式头、WAL 归零；再关掉自动 checkpoint 做一次事务。
 * 事务提交后**连接还开着**时把主文件与 `-wal` 拷到目标位置 —— 主文件此时停在
 * checkpoint 那一刻，WAL 里是后续提交的帧，正是「进程被杀、WAL 尚未合回」的现场。
 * @param dir - 快照根目录。
 * @param baseName - 目标主文件名。
 * @returns 目标主文件与 WAL 的路径。
 */
function makeValidWalPair(dir: string, baseName = 'message_0.db'): { dbPath: string; walPath: string } {
  const live = join(dir, 'live-src.db')
  const db = new DatabaseSync(live)
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    db.exec('BEGIN')
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 500; i += 1) ins.run('x'.repeat(200))
    db.exec('COMMIT')

    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.exec('BEGIN')
    for (let i = 0; i < 120; i += 1) ins.run('y'.repeat(200))
    db.exec('COMMIT')

    const dbPath = join(dir, baseName)
    const walPath = dbPath + '-wal'
    copyFileSync(live, dbPath)
    copyFileSync(live + '-wal', walPath)
    return { dbPath, walPath }
  } finally {
    db.close()
  }
}

/** 只读跑一次 `PRAGMA quick_check`，返回逐行判词。 */
function quickCheckOf(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('PRAGMA quick_check').all().map((row) => String(Object.values(row)[0]))
  } finally {
    db.close()
  }
}

/** 只读统计表行数（用于确认 WAL 里的提交真的合回了主文件）。 */
function rowCountOf(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT count(*) AS n FROM t').get()
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

describe('reconcileSnapshotWal', () => {
  it('有效 WAL：quick_check 通过后 checkpoint 进主库并清理 -wal/-shm', async () => {
    const root = makeRoot()
    const { dbPath, walPath } = makeValidWalPair(root)
    expect(statSync(walPath).size).toBeGreaterThan(WAL_HEADER_SZ)

    const result = await reconcileSnapshotWal(root)

    expect(result).toEqual({ checked: 1, checkpointed: 1, quarantined: 0 })
    // 旁文件断言必须先做：后面任何一次只读连接都会为 WAL 模式的库重建 -shm。
    expect(existsSync(dbPath + '-shm')).toBe(false)
    expect(!existsSync(walPath) || statSync(walPath).size <= WAL_HEADER_SZ).toBe(true)
    expect(quickCheckOf(dbPath)).toEqual(['ok'])
    // WAL 里那 120 行必须已经落进主文件（不是被简单丢掉）。
    expect(rowCountOf(dbPath)).toBe(620)
  })

  it('垃圾 WAL：主库保留、WAL 改名隔离，不抛错', async () => {
    const root = makeRoot()
    const dbPath = join(root, 'message_0.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE t (a INTEGER)')
    db.close()
    writeFileSync(dbPath + '-wal', Buffer.alloc(PAGE_SZ, 7))

    const result = await reconcileSnapshotWal(root)

    expect(result).toEqual({ checked: 1, checkpointed: 0, quarantined: 1 })
    expect(existsSync(dbPath)).toBe(true)
    expect(quickCheckOf(dbPath)).toEqual(['ok'])
    expect(existsSync(dbPath + '-wal')).toBe(false)
    const quarantined = readdirSync(root)
      .filter((name) => /^message_0\.db\.quarantine-\d+-wal$/.test(name))
    expect(quarantined).toHaveLength(1)
  })

  it('只有 -wal 没有主库：不处理、不抛错', async () => {
    const root = makeRoot()
    const orphan = join(root, 'orphan.db-wal')
    writeFileSync(orphan, Buffer.alloc(PAGE_SZ, 5))

    const result = await reconcileSnapshotWal(root)

    expect(result).toEqual({ checked: 0, checkpointed: 0, quarantined: 0 })
    expect(existsSync(orphan)).toBe(true)
  })

  it('checkpoint 被占用（busy）：保留 WAL、不隔离、不计数', async () => {
    const root = makeRoot()
    const dbPath = join(root, 'message_0.db')
    const walPath = dbPath + '-wal'
    const writer = new DatabaseSync(dbPath)
    let reader: DatabaseSync | null = null
    try {
      writer.exec('CREATE TABLE t (a INTEGER)')
      writer.exec('PRAGMA journal_mode=WAL')
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      writer.exec('PRAGMA wal_autocheckpoint=0')
      // 读连接先把读标记停在 0 行；之后写入的帧无法被 TRUNCATE checkpoint 清掉。
      reader = new DatabaseSync(dbPath)
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM t').get()
      writer.exec('INSERT INTO t VALUES (1)')
      writer.exec('INSERT INTO t VALUES (2)')
      expect(statSync(walPath).size).toBeGreaterThan(WAL_HEADER_SZ)

      const result = await reconcileSnapshotWal(root)

      // busy 是临时状态，不是损坏证据：WAL 必须原样保留，不能隔离。
      expect(result).toEqual({ checked: 1, checkpointed: 0, quarantined: 0 })
      expect(existsSync(walPath)).toBe(true)
      expect(readdirSync(root).filter((name) => name.includes('.quarantine-'))).toHaveLength(0)
    } finally {
      try { reader?.exec('COMMIT') } catch { /* 事务可能已被清理 */ }
      reader?.close()
      writer.close()
    }
  })

  it('幂等：第二次对账不再 checkpoint / 隔离', async () => {
    const root = makeRoot()
    makeValidWalPair(root)

    const first = await reconcileSnapshotWal(root)
    expect(first).toEqual({ checked: 1, checkpointed: 1, quarantined: 0 })

    const second = await reconcileSnapshotWal(root)
    expect(second).toEqual({ checked: 0, checkpointed: 0, quarantined: 0 })
    expect(quickCheckOf(join(root, 'message_0.db'))).toEqual(['ok'])
  })

  it('.superseded-wal 残留：改名隔离留档，原文件不存在', async () => {
    const root = makeRoot()
    const leftover = join(root, 'message_0.db.superseded-wal')
    writeFileSync(leftover, Buffer.alloc(PAGE_SZ, 9))

    const result = await reconcileSnapshotWal(root)
    expect(result).toEqual({ checked: 0, checkpointed: 0, quarantined: 0 })
    expect(existsSync(leftover)).toBe(false)

    const renamed = readdirSync(root)
      .filter((name) => /^message_0\.db\.quarantine-\d+-superseded-wal$/.test(name))
    expect(renamed).toHaveLength(1)
    expect(statSync(join(root, renamed[0] as string)).size).toBe(PAGE_SZ)

    // 幂等：隔离位自己不会再被当成 `.superseded-wal` 二次改名。
    await reconcileSnapshotWal(root)
    expect(readdirSync(root).filter((name) => name.endsWith('-superseded-wal'))).toHaveLength(1)
  })
})
