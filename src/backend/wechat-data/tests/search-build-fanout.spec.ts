/**
 * N36 的 (A) 类里最该修的一处：建索引时**每个会话都把所有分片开一遍**。
 *
 * 旧布局是 `for username { for shard { new DatabaseSync(shard) } }` ⇒ 句柄开合数 = 会话数 × 分片数
 * （真实库上几百到几千次 open/close，每一次都只为了问一句「你有没有我的表」），
 * 而这件事**每个分片自己就知道** —— 增量同步 `runSyncSearchIndex` 早就是这个形状了。
 *
 * 判据为什么写成「两次运行的开合数相等」而不是「≤ 某个数」：真正要保证的性质是
 * **不随会话数增长**，任何常数上界都会在下次多开一个库时误报，而这个式子不会。
 * 计数口径同 `[算料]`：数 `DatabaseSync.prototype.close`（一次 open 恰好配一次 close，
 * 构造函数没法在原型上 spy）。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSearchIndex } from '../src/query/search.ts'

const scratch: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

const SHARDS = ['message_0.db', 'message_1.db']
const ROWS_PER_TABLE = 4

const tableOf = (username: string): string => 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')

/**
 * 造 `sessionCount` 个会话 × 2 个分片的最小库；每个会话都**横跨两个分片**，
 * 否则「按分片走」与「按会话走」两种布局读到的行数会一样，判据就没有判别力。
 * @param sessionCount - 会话数。
 * @returns 解密根目录。
 */
function makeFixture(sessionCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'search-fanout-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const users = Array.from({ length: sessionCount }, (_, i) => `wxid_${String(i)}`)
  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insSession = sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')')
  for (const u of users) insSession.run(u)
  sdb.close()

  for (const [shardIndex, shard] of SHARDS.entries()) {
    const db = new DatabaseSync(join(decrypted, 'message', shard))
    db.exec('CREATE TABLE dir2id (username TEXT)')
    // 每个会话在两个分片里都有表（内容按分片编号区分，好让「漏读某片」能被行数抓出来）。
    db.exec('BEGIN')
    for (const username of users) {
      const t = tableOf(username)
      db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
      const ins = db.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
      for (let i = 1; i <= ROWS_PER_TABLE; i += 1) {
        ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `needle 来自 ${username} 的第 ${i} 条 分片${String(shardIndex)}`, `srv${i}`, '')
      }
    }
    db.exec('COMMIT')
    db.close()
  }
  return decrypted
}

/** 一次构建期间的 sqlite 句柄开合次数。 */
async function opensWhileBuilding(decrypted: string): Promise<{ opens: number, rows: number }> {
  const spy = vi.spyOn(DatabaseSync.prototype, 'close')
  const before = spy.mock.calls.length
  const res = await buildSearchIndex(decrypted, true)
  const opens = spy.mock.calls.length - before
  expect(res.status, '构建本身就该成功').toBe('ok')
  // `rows` 在 BuildResult 上是可选的：缺失时留 -1，让下面那句行数断言响，而不是悄悄当 0。
  return { opens, rows: res.rows ?? -1 }
}

describe('建索引的分片开合数：不该是「会话数 × 分片数」', () => {
  it('开合数不随会话数增长（旧布局是会话数 × 分片数）', async () => {
    const few = await opensWhileBuilding(makeFixture(3))
    // 上面的构建结束、下面的夹具还没开始 —— 中间没有别的开合被算进来。
    const many = await opensWhileBuilding(makeFixture(9))
    console.log(`[算料] 3 会话 × 2 分片：开合 ${String(few.opens)} 次；9 会话 × 2 分片：开合 ${String(many.opens)} 次`)

    expect(many.opens, `会话从 3 涨到 9，句柄开合从 ${String(few.opens)} 涨到 ${String(many.opens)} ⇒ 又退回「每会话扫全部分片」了`)
      .toBe(few.opens)
    // 行数顺带钉住「按分片走之后仍然读全」：每个会话两片各有 4 行。
    expect(few.rows).toBe(3 * SHARDS.length * ROWS_PER_TABLE)
    expect(many.rows).toBe(9 * SHARDS.length * ROWS_PER_TABLE)
  })

  it('跨分片的同一个会话都要进索引（读一条只在后一个分片里出现的正文）', async () => {
    const decrypted = makeFixture(4)
    const { rows } = await opensWhileBuilding(decrypted)
    expect(rows, '漏读某个分片时这个数会先掉下来').toBe(4 * SHARDS.length * ROWS_PER_TABLE)
  })
})
