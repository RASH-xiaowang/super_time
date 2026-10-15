/**
 * Operation-log store: append-only metadata records + filtered reads + clear.
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearOperationLog, listOperations, recordOperation, SLOW_OPERATION_MS } from '../src/query/operation-log.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch { /* best-effort Windows cleanup */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-oplog-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** A decrypted path whose parent is a regular file: any store open must fail. */
function brokenRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-oplog-'))
  scratch.push(base)
  const blocker = join(base, 'blocker')
  writeFileSync(blocker, '')
  return join(blocker, 'decrypted')
}

describe('operation log store', () => {
  it('records rows (auto + explicit ts) and reads them newest-first', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'save_wechat_config', target: '', status: 'ok', detail: 'config' })
    recordOperation(dir, { category: 'export', action: 'export_session_messages', target: '张三', status: 'ok', detail: '3 条', ts: 111 })
    recordOperation(dir, { category: 'error', action: 'decrypt_failed', target: '', status: 'fail', detail: 'bad key' })

    const snap = listOperations(dir)
    expect(snap.total).toBe(3)
    // newest first: error(3), export(2), settings(1)
    expect(snap.items[0]?.category).toBe('error')
    expect(snap.items[1]?.ts).toBe(111)
    expect(snap.items[1]?.target).toBe('张三')
  })

  it('filters by range, status and validated categories', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'save_wechat_config', target: '', status: 'ok', detail: 'a', ts: 100 })
    recordOperation(dir, { category: 'export', action: 'export_csv', target: '', status: 'ok', detail: 'b', ts: 200 })
    recordOperation(dir, { category: 'delete', action: 'delete_backup', target: 'b1', status: 'fail', detail: 'c', ts: 300 })

    expect(listOperations(dir, { from: 150, to: 250 }).items).toHaveLength(1)
    expect(listOperations(dir, { status: 'fail' }).items).toHaveLength(1)
    // invalid category 'bogus' is dropped; valid ones apply.
    const cats = listOperations(dir, { categories: ['export', 'bogus', 'delete'] })
    expect(cats.total).toBe(2)
    // empty category list -> no category filter.
    expect(listOperations(dir, { categories: [] }).total).toBe(3)
  })

  it('clamps the page limit between 1 and the max', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'a', target: '', status: 'ok', detail: '', ts: 1 })
    recordOperation(dir, { category: 'settings', action: 'b', target: '', status: 'ok', detail: '', ts: 2 })
    // negative -> 1
    expect(listOperations(dir, { limit: -5 }).items).toHaveLength(1)
    // zero -> 1
    expect(listOperations(dir, { limit: 0 }).items).toHaveLength(1)
    // huge -> clamped to max (still returns all 2 here)
    expect(listOperations(dir, { limit: 999999 }).items).toHaveLength(2)
  })

  it('coerces malformed DB rows to safe defaults', () => {
    const dir = root()
    // creates the schema first
    recordOperation(dir, { category: 'settings', action: 'seed', target: '', status: 'ok', detail: '', ts: 5 })
    const db = new DatabaseSync(join(dirname(dir), 'wechat_privacy.db'))
    db.exec("INSERT INTO operation_log(ts, category, action, target, status, detail) VALUES (1, 'bogus', NULL, NULL, 'bogus', NULL)")
    db.close()

    const snap = listOperations(dir)
    const row = snap.items[0]!
    expect(row.category).toBe('error')
    expect(row.status).toBe('fail')
    expect(row.action).toBe('')
    expect(row.target).toBe('')
  })

  it('clears the log and reports the removed count', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'a', target: '', status: 'ok', detail: '', ts: 1 })
    recordOperation(dir, { category: 'export', action: 'b', target: '', status: 'ok', detail: '', ts: 2 })
    const cleared = clearOperationLog(dir)
    expect(cleared.ok).toBe(true)
    expect(cleared.removed).toBe(2)
    expect(listOperations(dir).total).toBe(0)
  })

  it('stays best-effort when the store cannot be opened', () => {
    const bad = brokenRoot()
    expect(() =>{  recordOperation(bad, { category: 'settings', action: 'a', target: '', status: 'ok', detail: '' }) }).not.toThrow()
    // W3-11.4：库打不开时除了「不抛、给空列表」，还必须带上 readError ——
    // 否则界面把「看不到操作记录」显示成「没有操作记录」（read-failure-contract.spec.ts 的同族契约）。
    const snap = listOperations(bad)
    expect(snap.items).toEqual([])
    expect(snap.total).toBe(0)
    expect(typeof snap.readError, '库读不动却不出声 ⇒ 用户看到的是假空态').toBe('string')
    expect(clearOperationLog(bad)).toEqual({ ok: false, removed: 0 })
  })
})

/**
 * H2（2026-09-28 性能修复）：`duration_ms` 观测列。
 *
 * 这一组用例的重点**不是**「能写能读」—— 那是最容易写对也最没价值的一半。
 * 真正会出事的是**迁移**：用户本机那个 `wechat_privacy.db` 里已经躺着
 * 隐私体检与导出历史的历史数据，而 `recordOperation` 是 best-effort 的。
 * 如果忘了 `ALTER TABLE`，症状是 `INSERT … duration_ms` 抛
 * `no such column` → 被 catch 吞掉 → **审计日志从此静默少记**，界面上看不出异常。
 * 所以下面第一条用例必须先造「老库」，再走新代码。
 */
describe('operation log 耗时观测（H2）', () => {
  /** 造一个「老版本」的库：表结构与 H2 之前逐字节一致（没有 duration_ms 列）。 */
  function legacyRoot(): string {
    const dir = root()
    const db = new DatabaseSync(join(dirname(dir), 'wechat_privacy.db'))
    db.exec('CREATE TABLE operation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL, action TEXT, target TEXT, status TEXT NOT NULL, detail TEXT)')
    db.prepare('INSERT INTO operation_log(ts, category, action, target, status, detail) VALUES (?,?,?,?,?,?)')
      .run(100, 'export', 'old_export', '张三', 'ok', '迁移前写的')
    db.close()
    return dir
  }

  it('老库（无 duration_ms 列）能被迁移：历史行还在，且新写入不再静默丢失', () => {
    const dir = legacyRoot()

    // 走新代码写一行**带耗时**的。少了 ALTER TABLE 这一步，这句会被 catch 吞掉。
    recordOperation(dir, { category: 'error', action: 'slow_call', target: 'getRemoteImages', status: 'ok', detail: '慢', durationMs: 5200 })

    const snap = listOperations(dir)
    expect(snap.total, '老库那行必须还在（ALTER TABLE ADD COLUMN 不重写既有行）').toBe(2)
    const slow = snap.items.find(i => i.action === 'slow_call')
    expect(slow, '新写入被静默吞掉了 ⇒ 迁移没生效').toBeDefined()
    expect(slow?.durationMs).toBe(5200)
    // 历史行读出来是 `undefined`（= 未记录），**不是 0**：0 会被读成「跑得飞快」。
    const old = snap.items.find(i => i.action === 'old_export')
    expect(old?.durationMs, '老行没有耗时 ⇒ 必须是 undefined 而不是 0').toBeUndefined()
  })

  it('未达阈值的耗时留空：快操作不许把审计表撑成流水（判据是 NULL，不是 0）', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'fast', target: '', status: 'ok', detail: '', durationMs: 5 })
    recordOperation(dir, { category: 'settings', action: 'edge', target: '', status: 'ok', detail: '', durationMs: SLOW_OPERATION_MS - 1 })
    recordOperation(dir, { category: 'settings', action: 'slow', target: '', status: 'ok', detail: '', durationMs: SLOW_OPERATION_MS })
    const byAction = new Map(listOperations(dir).items.map(i => [i.action, i]))
    expect(byAction.get('fast')?.durationMs, '5ms 也记 ⇒ 表会被撑爆').toBeUndefined()
    expect(byAction.get('edge')?.durationMs, `比阈值小 1ms 也记 ⇒ 边界判定错（应为 >= ${String(SLOW_OPERATION_MS)}）`).toBeUndefined()
    // 恰好等于阈值要记（与宿主 `cost > 1000` 的口径差 1ms，这里取「含」：1000ms 已经是慢）。
    expect(byAction.get('slow')?.durationMs).toBe(SLOW_OPERATION_MS)
  })

  it('minDurationMs 只筛出够慢的，且不把「没耗时」的行当成 0ms 放进来', () => {
    const dir = root()
    recordOperation(dir, { category: 'settings', action: 'unknown', target: '', status: 'ok', detail: '' })
    recordOperation(dir, { category: 'error', action: 'a', target: '', status: 'ok', detail: '', durationMs: 1500 })
    recordOperation(dir, { category: 'error', action: 'b', target: '', status: 'ok', detail: '', durationMs: 9000 })

    expect(listOperations(dir, { minDurationMs: 2000 }).items.map(i => i.action), '「不到 1 秒」被当成「够慢」放进来了').toEqual(['b'])
    expect(listOperations(dir, { minDurationMs: 1000 }).items.map(i => i.action).sort()).toEqual(['a', 'b'])
    // 没耗时的行在任何阈值下都不该出现（含 minDurationMs: 0）。
    expect(listOperations(dir, { minDurationMs: 0 }).items.some(i => i.action === 'unknown'), '未知耗时被当成 0ms 收进来了').toBe(false)
  })

  it('迁移是幂等的：同一个库连开多次不会重复 ALTER 报错', () => {
    const dir = legacyRoot()
    expect(() => {
      recordOperation(dir, { category: 'settings', action: 'x', target: '', status: 'ok', detail: '', durationMs: 2000 })
      for (let i = 0; i < 3; i += 1) listOperations(dir)
      recordOperation(dir, { category: 'settings', action: 'y', target: '', status: 'ok', detail: '', durationMs: 3000 })
    }).not.toThrow()
    expect(listOperations(dir).items.filter(i => i.durationMs !== undefined)).toHaveLength(2)
  })
})
