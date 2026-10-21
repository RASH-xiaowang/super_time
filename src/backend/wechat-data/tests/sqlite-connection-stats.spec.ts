/**
 * sqlite 连接统计（2026-10-21 性能专项 · 内存归因）。
 *
 * 为什么测：第五轮 heap 快照显示 worker 空闲时 `external` 53MB 而 `arrayBuffers=0`，
 * 怀疑是 node:sqlite 的堆外内存；一个直接可疑来源是**同时打开的连接数**（每连接至少
 * 一份页缓存）。`[mem]` 行现在带 `sqlite=open/peak`，这条用例钉住计数本身：
 * 打开 +1、关闭 −1、峰值只增、重复 close 不把计数扣成负数。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync, sqliteConnectionStats } from '../src/sqlite-connection.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 开一个临时库连接（路径纳入清理）。 */
function openDb(): InstanceType<typeof NativeDatabaseSync> {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-stats-'))
  scratch.push(dir)
  return new (DatabaseSync as unknown as new (p: string) => InstanceType<typeof NativeDatabaseSync>)(join(dir, 'x.db'))
}

describe('sqliteConnectionStats：连接数可观测', () => {
  it('打开 +1、关闭 −1，峰值只增不减', () => {
    const base = sqliteConnectionStats()
    const a = openDb()
    const b = openDb()
    const c = openDb()
    expect(sqliteConnectionStats().open - base.open).toBe(3)
    expect(sqliteConnectionStats().peak).toBeGreaterThanOrEqual(base.peak + 3)

    b.close()
    expect(sqliteConnectionStats().open - base.open).toBe(2)
    a.close()
    c.close()
    expect(sqliteConnectionStats().open).toBe(base.open)
    // 峰值保留历史最高，不随关闭回落
    expect(sqliteConnectionStats().peak).toBeGreaterThanOrEqual(base.peak + 3)
  })

  it('重复 close 不会把计数扣成负数（异常路径也不能污染读数）', () => {
    const base = sqliteConnectionStats()
    const db = openDb()
    db.close()
    try { db.close() } catch { /* 二次 close 可能抛错，统计必须仍然正确 */ }
    expect(sqliteConnectionStats().open).toBeGreaterThanOrEqual(0)
    expect(sqliteConnectionStats().open).toBe(base.open)
  })

  it('包装不改变实例类型（instanceof 原生 DatabaseSync 仍成立）', () => {
    const db = openDb()
    try {
      expect(db instanceof NativeDatabaseSync).toBe(true)
    } finally {
      db.close()
    }
  })
})
