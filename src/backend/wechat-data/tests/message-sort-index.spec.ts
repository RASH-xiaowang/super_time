import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureSortIndexIfMissing, ensureSortIndexes, missingSortIndexTables } from '../src/query/message-sort-index.ts'
import { queryMessages } from '../src/query/messages.ts'

/**
 * W2-3.5：消息分片的 `(sort_seq, local_id)` 覆盖索引。
 *
 * 3.5 原文是「类型/关键词过滤下推 SQL」。先量过之后发现那条路**不存在**：
 * 页面路径上每行都要解码+组装（µs/条随 limit 收敛到常数），没有「取回来再整体丢掉」的一步。
 * 量出来的真问题是另一件事 —— 分页的 `ORDER BY sort_seq DESC, local_id DESC` **没有索引可走**，
 * 于是每页都要整表排序。这一条钉的是那个。
 */

const TALKER = 'wxid_friend0001'
const TABLE = 'Msg_' + createHash('md5').update(TALKER, 'utf8').digest('hex')
const scratch: string[] = []

afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeShard(opts: { rows?: number; withSortSeq?: boolean; withIndex?: boolean; name?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-msi-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const file = join(decrypted, 'message', opts.name ?? 'message_0.db')
  const db = new DatabaseSync(file)
  const seqCol = opts.withSortSeq === false ? '' : 'sort_seq INTEGER, '
  db.exec(`CREATE TABLE "${TABLE}" (local_id INTEGER, ${seqCol}local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const cols = opts.withSortSeq === false ? 8 : 9
  const ins = db.prepare(`INSERT INTO "${TABLE}" VALUES (${new Array(cols).fill('?').join(',')})`)
  db.exec('BEGIN')
  for (let i = 1; i <= (opts.rows ?? 100); i += 1) {
    if (opts.withSortSeq === false) {
      ins.run(i, 1, i % 2, 1700000000 + i, 1, '第 ' + String(i) + ' 条', 'srv' + String(i), '')
    } else {
      ins.run(i, i, 1, i % 2, 1700000000 + i, 1, '第 ' + String(i) + ' 条', 'srv' + String(i), '')
    }
  }
  db.exec('COMMIT')
  if (opts.withIndex === true) db.exec(`CREATE INDEX dsh_sort_x ON "${TABLE}" (sort_seq, local_id)`)
  db.close()
  return decrypted
}

function indexNames(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => String(r.name))
  } finally {
    db.close()
  }
}

describe('W2-3.5 排序覆盖索引', () => {
  it('缺索引时被认出来，补完后不再被认出来（幂等）', () => {
    const decrypted = makeShard()
    const file = join(decrypted, 'message', 'message_0.db')
    expect(missingSortIndexTables(file), '新分片当然缺索引').toEqual([TABLE])
    const r1 = ensureSortIndexIfMissing(file)
    expect(r1.created).toBe(1)
    expect(r1.tables).toBe(1)
    expect(r1.skipped).toEqual([])
    expect(missingSortIndexTables(file), '补完就不该再被认成缺').toEqual([])
    // 幂等：再补一次不建任何东西
    const r2 = ensureSortIndexIfMissing(file)
    expect(r2.created).toBe(0)
    expect(indexNames(file).filter((n) => n.startsWith('dsh_sort_')).length).toBe(1)
  })

  it('已经有的索引不会被重建（探测走的是真索引名，不是「有没有任何索引」）', () => {
    const decrypted = makeShard({ withIndex: true })
    const file = join(decrypted, 'message', 'message_0.db')
    const r = ensureSortIndexIfMissing(file)
    expect(r.created, '别人建的那个索引不算 —— 名字对不上就要重建，否则排序仍走不到它').toBe(1)
  })

  it('缺 sort_seq 的老分片跳过并说清原因（不是静默当成「已就绪」）', () => {
    const decrypted = makeShard({ withSortSeq: false })
    const file = join(decrypted, 'message', 'message_0.db')
    const r = ensureSortIndexes(file)
    expect(r.created).toBe(0)
    expect(r.skipped.length, '跳过了却没有说明 ⇒ 这个分片会永远没索引且没人知道').toBe(1)
    expect(r.skipped[0]?.reason).toContain('sort_seq')
  })

  it('库读不动时不抛错（缓存/索引都只是优化）', () => {
    const decrypted = makeShard()
    const file = join(decrypted, 'message', 'nope.db')
    expect(missingSortIndexTables(file)).toEqual([])
    const r = ensureSortIndexes(file)
    expect(r.created).toBe(0)
    expect(r.skipped.length).toBeGreaterThan(0)
  })

  it('读路径自动补：queryMessages 第一次就把索引建上', () => {
    const decrypted = makeShard({ rows: 60 })
    const file = join(decrypted, 'message', 'message_0.db')
    expect(missingSortIndexTables(file)).toEqual([TABLE])
    const snap = queryMessages(decrypted, TALKER, 10)
    expect(snap.messages.length).toBe(10)
    expect(missingSortIndexTables(file), 'getMessages 走过一遍就该把索引补上').toEqual([])
  })

  it('补索引不改变分页结果（同样 100 条、同样的顺序）', () => {
    const a = makeShard({ rows: 300, name: 'message_0.db' })
    const before = queryMessages(a, TALKER, 50).messages.map((m) => m.localId)
    const b = makeShard({ rows: 300, name: 'message_1.db' })
    ensureSortIndexIfMissing(join(b, 'message', 'message_1.db'))
    const after = queryMessages(b, TALKER, 50).messages.map((m) => m.localId)
    expect(after).toEqual(before)
  })
})