/**
 * 导出历史（`export-history.ts`）：记录、列表/搜索/筛选/排序、删除、按策略清理。
 *
 * 与操作日志（`operation-log.ts`）的分工是本模块的核心约束，用例把它钉住：
 *   操作日志 = 审计口径（脱敏元数据，便于分享）
 *   导出历史 = 可操作口径（绝对路径 + 重跑参数，便于打开/重新导出）
 *
 * 另外两条容易被写错的语义也在这里锁住：
 *   ① 删除记录**默认不删文件**（删记录与删文件风险差一个量级）；
 *   ② `prune` 传空对象时**什么都不删**（防止误调用把历史清空）。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteExportHistory,
  listExportHistory,
  pruneExportHistory,
  recordExport,
} from '../src/query/export-history.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个数据根 + decrypted 目录；返回 [decryptedDir, dataRoot]。 */
function makeRoot(): [string, string] {
  const dataRoot = join(mkdtempSync(join(tmpdir(), 'wx-exphist-')), 'wechat-data')
  const decrypted = join(dataRoot, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  scratch.push(join(dataRoot, '..'))
  return [decrypted, dataRoot]
}

/** 造一个真实落盘的小文件，返回路径。 */
function makeFile(dir: string, name: string, body = 'x'): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

describe('导出历史：记录与读取', () => {
  it('记录一次导出后能读回来（含路径/文件名/行数/状态/参数）', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.csv', 'hello')
    const id = recordExport(dec, {
      kind: 'contacts', label: '通讯录', format: 'csv', path: f, rows: 3, status: 'ok',
      params: { kind: 'contacts', category: 'friend' },
    })
    expect(id).toBeGreaterThan(0)
    const snap = listExportHistory(dec, {})
    expect(snap.total).toBe(1)
    const it0 = snap.items[0]!
    expect(it0.kind).toBe('contacts')
    expect(it0.path).toBe(f)
    expect(it0.filename).toBe('a.csv')
    expect(it0.rows).toBe(3)
    expect(it0.status).toBe('ok')
    expect(JSON.parse(it0.params)).toEqual({ kind: 'contacts', category: 'friend' })
  })

  it('size 缺省时从磁盘取真实字节数；文件不存在则为 null（不猜 0）', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.bin', 'abcdef')
    recordExport(dec, { kind: 'k', path: f, status: 'ok' })
    recordExport(dec, { kind: 'k', path: join(root, 'exports', 'gone.bin'), status: 'ok' })
    const snap = listExportHistory(dec, {})
    const byName = new Map(snap.items.map(i => [i.filename, i]))
    expect(byName.get('a.bin')!.sizeBytes).toBe(6)
    expect(byName.get('gone.bin')!.sizeBytes).toBe(null)
  })

  it('path 为空时不落库（没有路径的历史没有可操作性）', () => {
    const [dec] = makeRoot()
    expect(recordExport(dec, { kind: 'k', path: '', status: 'fail' })).toBe(null)
    expect(listExportHistory(dec, {}).total).toBe(0)
  })

  it('existsNow 按**当前**磁盘事实刷新（外部删掉文件后历史如实反映）', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.csv')
    recordExport(dec, { kind: 'k', path: f, status: 'ok' })
    expect(listExportHistory(dec, {}).items[0]!.existsNow).toBe(true)
    rmSync(f)
    const snap = listExportHistory(dec, {})
    expect(snap.items[0]!.existsNow).toBe(false)
    expect(snap.missingCount).toBe(1)
  })

  it('失败也能记一条（用户要能看到「这次没成功」）', () => {
    const [dec] = makeRoot()
    recordExport(dec, { kind: 'session', path: '', status: 'fail', error: '磁盘满' })
    // path 为空 → 不落库；但真实场景里失败记录会带上「本来想写的路径」
    recordExport(dec, { kind: 'session', path: 'C:/nope/x.csv', status: 'fail', error: '磁盘满' })
    const snap = listExportHistory(dec, {})
    expect(snap.total).toBe(1)
    expect(snap.items[0]!.status).toBe('fail')
    expect(snap.items[0]!.error).toBe('磁盘满')
  })
})

describe('导出历史：搜索 / 筛选 / 排序 / 聚合', () => {
  function seed(dec: string, root: string): void {
    const dir = join(root, 'exports')
    recordExport(dec, { kind: 'contacts', label: '通讯录', path: makeFile(dir, '通讯录-2026.csv'), rows: 10, status: 'ok', ts: 1000 })
    recordExport(dec, { kind: 'session', label: '会话 · 张三', path: makeFile(dir, '张三_2026.csv'), rows: 200, status: 'ok', ts: 2000 })
    recordExport(dec, { kind: 'session', label: '会话 · 李四', path: makeFile(dir, '李四.csv'), rows: 5, status: 'fail', error: 'boom', ts: 3000 })
  }

  it('按文本搜索文件名 / 说明', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    expect(listExportHistory(dec, { q: '张三' }).total).toBe(1)
    expect(listExportHistory(dec, { q: '通讯录' }).total).toBe(1)
    expect(listExportHistory(dec, { q: '2026' }).total).toBe(2)
  })

  it('搜索里的 % 与 _ 按字面量处理（不被当成通配符）', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    // 没有任何记录名含字面量 '%'
    expect(listExportHistory(dec, { q: '%' }).total).toBe(0)
    // 下划线若被当通配符，"李_" 会命中「李四」；按字面量则应为 0
    expect(listExportHistory(dec, { q: '李_' }).total).toBe(0)
  })

  it('按种类筛选（kinds）与状态筛选', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    expect(listExportHistory(dec, { kinds: ['session'] }).total).toBe(2)
    expect(listExportHistory(dec, { kinds: ['contacts', 'session'] }).total).toBe(3)
    expect(listExportHistory(dec, { status: 'fail' }).total).toBe(1)
  })

  it('按时间范围筛选', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    expect(listExportHistory(dec, { from: 2500 }).total).toBe(1)
    expect(listExportHistory(dec, { to: 1500 }).total).toBe(1)
    expect(listExportHistory(dec, { from: 1500, to: 2500 }).total).toBe(1)
  })

  it('排序：ts 默认倒序；size / rows / name 可指定升降序', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    expect(listExportHistory(dec, {}).items.map(i => i.rows)).toEqual([5, 200, 10])
    expect(listExportHistory(dec, { sort: 'rows', order: 'desc' }).items.map(i => i.rows)).toEqual([200, 10, 5])
    expect(listExportHistory(dec, { sort: 'rows', order: 'asc' }).items.map(i => i.rows)).toEqual([5, 10, 200])
    expect(listExportHistory(dec, { sort: 'ts', order: 'asc' }).items.map(i => i.ts)).toEqual([1000, 2000, 3000])
  })

  it('sort 传非白名单值时退回 ts（不把用户输入拼进 SQL）', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    const snap = listExportHistory(dec, { sort: 'ts; DROP TABLE export_history--' as never })
    expect(snap.total).toBe(3)
    expect(listExportHistory(dec, {}).total).toBe(3) // 表还在
  })

  it('分页：limit/offset 生效，聚合计数仍按未分页的命中集合算', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    const p1 = listExportHistory(dec, { limit: 2, offset: 0 })
    expect(p1.items.length).toBe(2)
    expect(p1.total).toBe(3)
    // 页签数字不能随翻页变化
    expect(p1.kindCounts['session']).toBe(2)
    const p2 = listExportHistory(dec, { limit: 2, offset: 2 })
    expect(p2.items.length).toBe(1)
    expect(p2.kindCounts['session']).toBe(2)
  })

  it('statusCounts / kindCounts / totalBytes 汇总正确', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    const snap = listExportHistory(dec, {})
    expect(snap.statusCounts['ok']).toBe(2)
    expect(snap.statusCounts['fail']).toBe(1)
    expect(snap.kindCounts['session']).toBe(2)
    expect(snap.kindCounts['contacts']).toBe(1)
    expect(snap.totalBytes).toBeGreaterThan(0)
  })

  it('非法 limit/offset 归一到安全值（不返回全表也不崩）', () => {
    const [dec, root] = makeRoot()
    seed(dec, root)
    for (const q of [{ limit: 0 }, { limit: -5 }, { limit: Number.NaN }, { offset: -3 }, { offset: Number.NaN }]) {
      const snap = listExportHistory(dec, q)
      expect(snap.total).toBe(3)
      expect(snap.items.length).toBeGreaterThan(0)
    }
  })
})

describe('导出历史：删除', () => {
  it('默认只删记录，**文件仍在磁盘上**', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.csv')
    const id = recordExport(dec, { kind: 'k', path: f, status: 'ok' })!
    const r = deleteExportHistory(dec, [id])
    expect(r.removed).toBe(1)
    expect(r.filesDeleted).toBe(0)
    expect(listExportHistory(dec, {}).total).toBe(0)
    expect(existsSync(f)).toBe(true)
  })

  it('deleteFiles=true 时连带删掉文件', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.csv')
    const id = recordExport(dec, { kind: 'k', path: f, status: 'ok' })!
    const r = deleteExportHistory(dec, [id], true)
    expect(r.removed).toBe(1)
    expect(r.filesDeleted).toBe(1)
    expect(existsSync(f)).toBe(false)
  })

  it('文件已不存在时删除不报错（幂等）', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.csv')
    const id = recordExport(dec, { kind: 'k', path: f, status: 'ok' })!
    rmSync(f)
    const r = deleteExportHistory(dec, [id], true)
    expect(r.removed).toBe(1)
    expect(r.fileErrors).toEqual([])
  })

  it('多条记录指向同一文件时只删一次文件', () => {
    const [dec, root] = makeRoot()
    const f = makeFile(join(root, 'exports'), 'a.csv')
    const a = recordExport(dec, { kind: 'k', path: f, status: 'ok' })!
    const b = recordExport(dec, { kind: 'k', path: f, status: 'ok' })!
    const r = deleteExportHistory(dec, [a, b], true)
    expect(r.removed).toBe(2)
    expect(r.filesDeleted).toBe(1)
  })

  it('空/非法 id 列表不做任何事', () => {
    const [dec, root] = makeRoot()
    recordExport(dec, { kind: 'k', path: makeFile(join(root, 'exports'), 'a.csv'), status: 'ok' })
    for (const ids of [[], [0], [-1], [Number.NaN]]) {
      const r = deleteExportHistory(dec, ids)
      expect(r.removed).toBe(0)
    }
    expect(listExportHistory(dec, {}).total).toBe(1)
  })

  it('删除目录型导出（备份目录）同样可用', () => {
    const [dec, root] = makeRoot()
    const dir = join(root, 'exports', 'backup-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.db'), 'z')
    const id = recordExport(dec, { kind: 'backup', path: dir, status: 'ok', format: 'dir' })!
    const r = deleteExportHistory(dec, [id], true)
    expect(r.filesDeleted).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('导出历史：按策略清理', () => {
  it('**传空对象什么都不删**（安全闸，防误调用清空历史）', () => {
    const [dec, root] = makeRoot()
    recordExport(dec, { kind: 'k', path: makeFile(join(root, 'exports'), 'a.csv'), status: 'ok', ts: 1 })
    const r = pruneExportHistory(dec, {})
    expect(r.removed).toBe(0)
    expect(listExportHistory(dec, {}).total).toBe(1)
  })

  it('olderThanDays 只删够老的记录', () => {
    const [dec, root] = makeRoot()
    const old = Date.now() - 40 * 86_400_000
    recordExport(dec, { kind: 'k', path: makeFile(join(root, 'exports'), 'old.csv'), status: 'ok', ts: old })
    recordExport(dec, { kind: 'k', path: makeFile(join(root, 'exports'), 'new.csv'), status: 'ok', ts: Date.now() })
    const r = pruneExportHistory(dec, { olderThanDays: 30 })
    expect(r.removed).toBe(1)
    const left = listExportHistory(dec, {})
    expect(left.total).toBe(1)
    expect(left.items[0]!.filename).toBe('new.csv')
  })

  it('keepLatest 保留最近 N 条', () => {
    const [dec, root] = makeRoot()
    const dir = join(root, 'exports')
    for (let i = 0; i < 5; i++) {
      recordExport(dec, { kind: 'k', path: makeFile(dir, `f${i}.csv`), status: 'ok', ts: 1000 + i })
    }
    const r = pruneExportHistory(dec, { keepLatest: 2 })
    expect(r.removed).toBe(3)
    const left = listExportHistory(dec, { sort: 'ts', order: 'asc' })
    expect(left.total).toBe(2)
    expect(left.items.map(i => i.filename)).toEqual(['f3.csv', 'f4.csv'])
  })

  it('onlyMissing 只清失效记录（文件已被外部删除）', () => {
    const [dec, root] = makeRoot()
    const dir = join(root, 'exports')
    const gone = makeFile(dir, 'gone.csv')
    recordExport(dec, { kind: 'k', path: gone, status: 'ok' })
    recordExport(dec, { kind: 'k', path: makeFile(dir, 'here.csv'), status: 'ok' })
    rmSync(gone)
    const r = pruneExportHistory(dec, { onlyMissing: true })
    expect(r.removed).toBe(1)
    const left = listExportHistory(dec, {})
    expect(left.items.map(i => i.filename)).toEqual(['here.csv'])
  })

  it('onlyMissing 连带删文件是空操作（本来就没有文件）', () => {
    const [dec, root] = makeRoot()
    const gone = makeFile(join(root, 'exports'), 'gone.csv')
    recordExport(dec, { kind: 'k', path: gone, status: 'ok' })
    rmSync(gone)
    const r = pruneExportHistory(dec, { onlyMissing: true, deleteFiles: true })
    expect(r.removed).toBe(1)
    expect(r.filesDeleted).toBe(0)
  })

  it('天数与保留数同时给出时，两个条件都要满足才删', () => {
    const [dec, root] = makeRoot()
    const dir = join(root, 'exports')
    const day = 86_400_000
    recordExport(dec, { kind: 'k', path: makeFile(dir, 'very-old.csv'), status: 'ok', ts: Date.now() - 90 * day })
    recordExport(dec, { kind: 'k', path: makeFile(dir, 'old.csv'), status: 'ok', ts: Date.now() - 40 * day })
    recordExport(dec, { kind: 'k', path: makeFile(dir, 'new.csv'), status: 'ok', ts: Date.now() })
    // 既早于 30 天、又不属于最近 1 条 → 前两条都删
    const r = pruneExportHistory(dec, { olderThanDays: 30, keepLatest: 1 })
    expect(r.removed).toBe(2)
    expect(listExportHistory(dec, {}).items.map(i => i.filename)).toEqual(['new.csv'])
  })

  it('清理不误伤：没有任何候选时返回 0', () => {
    const [dec, root] = makeRoot()
    recordExport(dec, { kind: 'k', path: makeFile(join(root, 'exports'), 'a.csv'), status: 'ok', ts: Date.now() })
    const r = pruneExportHistory(dec, { olderThanDays: 30 })
    expect(r.removed).toBe(0)
    expect(listExportHistory(dec, {}).total).toBe(1)
  })
})

describe('导出历史：与操作日志各司其职', () => {
  it('历史不与 operation_log 混表（两张表各自存在）', () => {
    const [dec, root] = makeRoot()
    recordExport(dec, { kind: 'k', path: makeFile(join(root, 'exports'), 'a.csv'), status: 'ok' })
    const db = new DatabaseSync(join(root, 'wechat_privacy.db'))
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
    db.close()
    expect(tables).toContain('export_history')
    // operation_log 由另一模块按需创建；这里只确认历史表没有把它的数据吃进来
    expect(listExportHistory(dec, {}).total).toBe(1)
  })

  it('坏掉的 params JSON 不影响读取其它字段（重新导出按钮据此置灰）', () => {
    const [dec, root] = makeRoot()
    const db = new DatabaseSync(join(root, 'wechat_privacy.db'))
    db.exec(`CREATE TABLE IF NOT EXISTS export_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT, format TEXT, path TEXT NOT NULL, filename TEXT, size_bytes INTEGER, rows INTEGER, status TEXT NOT NULL, error TEXT, params TEXT)`)
    db.prepare('INSERT INTO export_history(ts,kind,path,filename,status,params) VALUES (?,?,?,?,?,?)')
      .run(1, 'k', join(root, 'exports', 'a.csv'), 'a.csv', 'ok', '{not json')
    db.close()
    const snap = listExportHistory(dec, {})
    expect(snap.total).toBe(1)
    expect(snap.items[0]!.filename).toBe('a.csv')
    expect(snap.items[0]!.params).toBe('{not json')
  })
})
