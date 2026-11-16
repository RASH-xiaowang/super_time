/**
 * P2：limit 的有限性 / 下界校验。
 *
 * 复现的旧行为：
 *   · `queryMessages(root, talker, -1)` → `Math.min(-1, 1000) = -1` → SQLite 的
 *     `LIMIT -1` 表示**不限制**，一次把整张 Msg_ 表物化；
 *   · `NaN` / `1.5` → 绑定到 `LIMIT ?` 直接抛错（或生成非法 SQL）。
 *
 * 本文件同时钉住 helper 本身与四个调用点的真实查询行为（queryMessages /
 * queryNewMessages / queryMessagesAtOrBefore / searchIndexMessages + 可取消入口）。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { clampLimit, normalizeOffset, normalizePageLimit } from '../src/query/limits.ts'
import { queryMessages, queryMessagesAtOrBefore, queryNewMessages } from '../src/query/messages.ts'
import { searchIndexMessages, searchIndexMessagesCancellable } from '../src/query/search.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0, scratch.length)) rmSync(dir, { recursive: true, force: true })
})

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

/**
 * 造一个最小可查询的消息数据根（`<base>/decrypted`，索引库会落在 `<base>` 下，
 * 避免多个用例共用 `%TEMP%\wechat_search.db`）。
 */
function makeMessageRoot(tag: string, rows: number, content: (i: number) => string): { decrypted: string; talker: string } {
  const base = mkdtempSync(join(tmpdir(), 'wx-p2-limit-' + tag + '-'))
  scratch.push(base)
  const decrypted = join(base, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const talker = 'wxid_' + tag
  const table = 'Msg_' + createHash('md5').update(talker, 'utf8').digest('hex')
  makeDb(join(decrypted, 'message', 'message_0.db'), (db) => {
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id TEXT)`)
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?)`)
    for (let i = 1; i <= rows; i += 1) {
      ins.run(i, i, 1, 0, 1700000000 + i, 1, content(i), `srv${i}`)
    }
  })
  makeDb(join(decrypted, 'session', 'session.db'), (db) => {
    db.exec('CREATE TABLE SessionTable (username TEXT)')
    db.prepare('INSERT INTO SessionTable VALUES (?)').run(talker)
  })
  return { decrypted, talker }
}

describe('clampLimit / normalizePageLimit / normalizeOffset', () => {
  it('非有限值退回默认值，负值夹到 1，小数取整，超大值夹到上限', () => {
    expect(clampLimit(undefined, 100, 1000)).toBe(100)
    expect(clampLimit(Number.NaN, 100, 1000)).toBe(100)
    expect(clampLimit(Infinity, 100, 1000)).toBe(100)
    expect(clampLimit(-Infinity, 100, 1000)).toBe(100)
    expect(clampLimit(-1, 100, 1000)).toBe(1)
    expect(clampLimit(-5, 100, 1000)).toBe(1)
    expect(clampLimit(0, 100, 1000)).toBe(1)
    expect(clampLimit(1.5, 100, 1000)).toBe(1)
    expect(clampLimit(999.9, 100, 1000)).toBe(999)
    expect(clampLimit(1000, 100, 1000)).toBe(1000)
    expect(clampLimit(1e12, 100, 1000)).toBe(1000)
  })

  it('默认值自身越界时也会被夹紧（不会把非法默认值带进 SQL）', () => {
    expect(clampLimit(undefined, Number.NaN, 100)).toBe(100)
    expect(clampLimit(undefined, -3, 100)).toBe(1)
    expect(clampLimit(undefined, 5000, 100)).toBe(100)
  })

  it('normalizePageLimit 保留「不限制」语义，其它非法值折叠成空页', () => {
    expect(normalizePageLimit(undefined)).toBeUndefined()
    expect(normalizePageLimit(Infinity)).toBeUndefined()
    expect(normalizePageLimit(Number.NaN)).toBe(0)
    expect(normalizePageLimit(-1)).toBe(0)
    expect(normalizePageLimit(2.9)).toBe(2)
  })

  it('normalizeOffset 不会把负数/NaN 传给 SQLite', () => {
    expect(normalizeOffset(undefined)).toBe(0)
    expect(normalizeOffset(Number.NaN)).toBe(0)
    expect(normalizeOffset(-5)).toBe(0)
    expect(normalizeOffset(3.9)).toBe(3)
    expect(normalizeOffset(Infinity)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('queryMessages：非法 limit 不再触发全表/抛错', () => {
  const cases: Array<[number, number, boolean]> = [
    [-1, 1, true],
    [-5, 1, true],
    [1.5, 1, true],
    [Number.NaN, 12, false],
    [Infinity, 12, false],
    [1e12, 12, false],
  ]

  for (const [limit, expectedRows, expectedHasMore] of cases) {
    it(`limit=${String(limit)} → ${String(expectedRows)} 条（默认 100 / 硬上限 1000）`, () => {
      const { decrypted, talker } = makeMessageRoot('msgs', 12, (i) => `msg ${i}`)
      const snap = queryMessages(decrypted, talker, limit)
      expect(snap.messages.length).toBe(expectedRows)
      expect(snap.hasMore).toBe(expectedHasMore)
      expect(snap.total).toBe(12)
    })
  }

  it('queryNewMessages 与 queryMessagesAtOrBefore 的同类入口也走同一夹紧', () => {
    const { decrypted, talker } = makeMessageRoot('other', 12, (i) => `msg ${i}`)
    expect(queryNewMessages(decrypted, talker, 0, -1).messages.length).toBe(1)
    expect(queryNewMessages(decrypted, talker, 0, Number.NaN).messages.length).toBe(12)
    const at = queryMessagesAtOrBefore(decrypted, talker, 6, -1)
    expect(at.found).toBe(true)
    expect(at.messages.length).toBe(1)
    expect(at.messages[0]?.localId).toBe(6)
    // NaN 退回默认 20：目标之前的 6 条全部返回。
    expect(queryMessagesAtOrBefore(decrypted, talker, 6, Number.NaN).messages.length).toBe(6)
  })
})

describe('searchIndexMessages：候选池上限同样先夹紧', () => {
  const cases: Array<[number, number]> = [
    [-1, 1],
    [-5, 1],
    [1.5, 1],
    [Number.NaN, 5],
    [Infinity, 5],
    [1e12, 5],
  ]

  for (const [limit, expectedHits] of cases) {
    it(`limit=${String(limit)} → ${String(expectedHits)} 条命中`, () => {
      const { decrypted } = makeMessageRoot('search', 5, (i) => `needle ${i}`)
      const r = searchIndexMessages(decrypted, 'needle', limit)
      expect(r.hits.length).toBe(expectedHits)
    })
  }

  it('可取消入口（searchIndexMessagesCancellable）同样不会把负值交给 SQL', async () => {
    const { decrypted } = makeMessageRoot('search-cancel', 5, (i) => `needle ${i}`)
    const r = await searchIndexMessagesCancellable(decrypted, 'needle', -1)
    expect(r.cancelled).not.toBe(true)
    expect(r.hits.length).toBe(1)
  })
})
