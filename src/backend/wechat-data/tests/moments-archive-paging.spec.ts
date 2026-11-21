// @vitest-environment node
/**
 * 朋友圈归档**分页查询**的性能契约（2026-11-19）。
 *
 * ## 为什么值得单独守
 *
 * 归档表只增不减（防撤回语义：线上删掉也要留着），所以任何「每页全表扫描」的写法
 * 都会随时间恶化。这里钉两件在代码里看不出来、但影响很大的事：
 *
 * 1. **排序必须走索引**。曾经是 `ORDER BY CAST(tid AS INTEGER) DESC`，
 *    执行计划退化成 `SCAN + USE TEMP B-TREE FOR ORDER BY` —— 每页全表扫描 + 全表排序。
 *    真机实测（3,395 行）：31ms/页，深分页 57ms；改 `ts DESC, tid DESC` 后
 *    走 `idx_moments_archive_ts`，降到 5.7ms / 17.7ms。
 * 2. **分页必须稳定**：同一秒发两条时，翻页不能重复或漏行（靠 `tid` 作第二排序键）。
 *
 * 断言刻意选「执行计划」而不是「耗时」：耗时受机器影响会抖，执行计划是确定性的。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readArchivedMoments } from '../src/query/moments-archive.ts'

let root = ''

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'moments-page-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 建一个与生产同构的最小归档库；返回 decrypted 目录（`moments-archive.db` 在它上一级）。 */
function makeArchive(rows: ReadonlyArray<{ tid: string; ts: number; username?: string }>): string {
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  const db = new DatabaseSync(join(root, 'moments-archive.db'))
  try {
    db.exec(`CREATE TABLE moments_archive (
      tid TEXT PRIMARY KEY, username TEXT NOT NULL, author TEXT NOT NULL,
      ts INTEGER NOT NULL, month TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT NOT NULL, payload TEXT NOT NULL,
      archived_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    )`)
    db.exec('CREATE INDEX idx_moments_archive_ts ON moments_archive(ts DESC)')
    db.exec('CREATE INDEX idx_moments_archive_user ON moments_archive(username)')
    const ins = db.prepare('INSERT INTO moments_archive VALUES (?,?,?,?,?,?,?,?,?,?)')
    for (const r of rows) {
      ins.run(r.tid, r.username ?? 'wxid_a', '作者', r.ts, '2026-11', '', 'h', JSON.stringify({ tid: r.tid }), 1, 1)
    }
  } finally { db.close() }
  return decrypted
}

/** 取某条 SQL 在归档库上的执行计划明细。 */
function plan(decrypted: string, sql: string): string[] {
  const db = new DatabaseSync(join(dirname(decrypted), 'moments-archive.db'), { readOnly: true })
  try {
    return (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as Array<{ detail: string }>).map(r => r.detail)
  } finally { db.close() }
}

describe('归档分页：排序必须走索引', () => {
  it('生产 SQL 不允许出现 `ORDER BY CAST(tid`（那会让索引失效、每页全表排序）', () => {
    /*
     * 直接读源码：这条 SQL 拼在模板字符串里，一旦有人改回 `CAST(tid AS INTEGER)`，
     * 执行计划会退化但功能测试全绿 —— 正是最难发现的那类回归。
     */
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'query', 'moments-archive.ts'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code, 'ORDER BY 里又出现了 CAST(tid) —— 分页会退化成全表扫描 + 全表排序')
      .not.toMatch(/ORDER\s+BY\s+CAST\(\s*tid/i)
  })

  it('分页排序走 `idx_moments_archive_ts`，而不是整表扫描', () => {
    const decrypted = makeArchive([
      { tid: '1', ts: 1000 }, { tid: '2', ts: 2000 }, { tid: '3', ts: 3000 },
    ])
    const joined = plan(decrypted, 'SELECT * FROM moments_archive ORDER BY ts DESC, tid DESC LIMIT 500 OFFSET 0').join(' | ')
    expect(joined, '排序没有用上 ts 索引').toContain('idx_moments_archive_ts')
    expect(joined, '退化成整表扫描').not.toMatch(/\bSCAN moments_archive\b(?! USING)/)
  })
})

describe('归档分页：稳定且不重不漏', () => {
  it('按 ts 倒序：新的在前', () => {
    const decrypted = makeArchive([
      { tid: '1', ts: 1000 }, { tid: '2', ts: 3000 }, { tid: '3', ts: 2000 },
    ])
    const page = readArchivedMoments(decrypted, { offset: 0, limit: 10 })
    expect(page?.rows.map(r => r.tid)).toEqual(['2', '3', '1'])
    expect(page?.total).toBe(3)
  })

  it('同一秒的多条：翻页不重复、不漏行（tid 作稳定的第二排序键）', () => {
    const rows = [
      { tid: '10', ts: 5000 }, { tid: '11', ts: 5000 }, { tid: '12', ts: 5000 },
      { tid: '13', ts: 5000 }, { tid: '14', ts: 5000 },
      { tid: '1', ts: 4000 }, { tid: '2', ts: 3000 },
    ]
    const decrypted = makeArchive(rows)
    const seen: string[] = []
    for (let off = 0; off < rows.length; off += 2) {
      const page = readArchivedMoments(decrypted, { offset: off, limit: 2 })
      if (page === null) break
      seen.push(...page.rows.map(r => r.tid))
    }
    expect(seen).toHaveLength(rows.length)
    expect(new Set(seen).size, '翻页出现重复行').toBe(rows.length)
  })

  it('负数 tid（真机上大量存在）也按时间排，不按字典序', () => {
    // 真机 tid 是**有符号 64 位**：`-6…` 比 `-3…` 更旧，字典序会把它错排到前面。
    const decrypted = makeArchive([
      { tid: '-6000000000000000000', ts: 1000 },
      { tid: '-3000000000000000000', ts: 3000 },
      { tid: '0', ts: 2000 },
    ])
    const page = readArchivedMoments(decrypted, { offset: 0, limit: 10 })
    expect(page?.rows.map(r => Number(r.ts))).toEqual([3000, 2000, 1000])
  })

  it('按作者过滤时仍然分页正确', () => {
    const decrypted = makeArchive([
      { tid: '1', ts: 1000, username: 'wxid_a' },
      { tid: '2', ts: 2000, username: 'wxid_b' },
      { tid: '3', ts: 3000, username: 'wxid_a' },
    ])
    const page = readArchivedMoments(decrypted, { offset: 0, limit: 10, authorUsername: 'wxid_a' })
    expect(page?.rows.map(r => r.tid)).toEqual(['3', '1'])
    expect(page?.total).toBe(2)
  })
})
