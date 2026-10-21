/**
 * 分析型只读连接的页缓存策略（2026-10-21 性能专项）。
 *
 * 为什么单独测：全局读缓存 256KB 是**按短读连接**定的（不让每个连接都吃几 MB）；
 * 而 `getStorageStats` 要扫 29MB 的 message_resource.db 并按 message_id 随机 JOIN
 * 回 MessageResourceInfo，256KB 会打穿页缓存。实测同一条 chats+senders 查询
 * **233ms → 64ms（3.6×）**，4MB 已回落到 74ms、8MB 后进入平台期。
 *
 * 这里用真 sqlite 临时库验证「PRAGMA 真的生效」，不依赖真实微信数据。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { raiseAnalyticsCache } from '../src/sqlite-connection.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
  delete process.env.DSH_WECHAT_ANALYTICS_CACHE_KB
})

/** 造一个空 sqlite 库并返回连接（顺带把库文件纳入清理）。 */
function openDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-analytics-'))
  scratch.push(dir)
  return new DatabaseSync(join(dir, 'x.db'))
}

/** 读回当前连接生效的 cache_size（SQLite 用负值表示 KB）。 */
function cacheKb(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA cache_size').get() as { cache_size?: number } | undefined
  return Number(row?.cache_size ?? 0)
}

describe('raiseAnalyticsCache：只抬高这一条连接的页缓存', () => {
  it('显式传值 ⇒ PRAGMA 生效（负值 = KB）', () => {
    const db = openDb()
    try {
      raiseAnalyticsCache(db, 4096)
      expect(cacheKb(db)).toBe(-4096)
    } finally {
      db.close()
    }
  })

  it('缺省 8MB（足够跨过实测平台期，又不给常驻 RSS 加负担）', () => {
    const db = openDb()
    try {
      raiseAnalyticsCache(db)
      expect(cacheKb(db)).toBe(-8 * 1024)
    } finally {
      db.close()
    }
  })

  it('环境变量可覆盖（换机器/大库时可调）', () => {
    process.env.DSH_WECHAT_ANALYTICS_CACHE_KB = '2048'
    const db = openDb()
    try {
      raiseAnalyticsCache(db)
      expect(cacheKb(db)).toBe(-2048)
    } finally {
      db.close()
    }
  })

  it('显式 0 / 负数 = 不干预（沿用连接创建时的策略）', () => {
    const db = openDb()
    try {
      const before = cacheKb(db)
      raiseAnalyticsCache(db, 0)
      expect(cacheKb(db)).toBe(before)
    } finally {
      db.close()
    }
  })

  it('非法环境变量回落默认值，而不是把拼错的值当"关闭"', () => {
    process.env.DSH_WECHAT_ANALYTICS_CACHE_KB = 'not-a-number'
    const db = openDb()
    try {
      raiseAnalyticsCache(db)
      expect(cacheKb(db)).toBe(-8 * 1024)
    } finally {
      db.close()
    }
  })
})
