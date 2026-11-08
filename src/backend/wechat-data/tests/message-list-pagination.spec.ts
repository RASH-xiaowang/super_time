// @vitest-environment node
/**
 * 消息列表十万级分页规模守卫。
 *
 * 这里直接造 100k 行，重点钉住三件事：
 *  1. 单页最多 500，超限必须显式 `truncated`，不能静默只给前 500；
 *  2. `(triggeredAt, id)` 复合游标可完整走完全表，时间戳重复不跳/不重；
 *  3. 全量翻页过程中结果保持严格倒序，避免 offset 分页在写入时错位。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withWritableDb } from '../src/query/db-open.ts'
import {
  MESSAGE_LIST_QUERY_MAX,
  decodeMessageListCursor,
  encodeMessageListCursor,
  ensureMessageListSchema,
  listMessageListRecords,
} from '../src/query/message-list-store.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import type { MessageListRecord } from '../src/types.ts'

const TOTAL = 100_000
const BASE_TIME = 1_700_000_000_000
const TIE_EVERY = 7

let root = ''
let decrypted = ''

function seedRecords(count: number): void {
  withWritableDb(taskDbPath(decrypted), (db) => {
    ensureMessageListSchema(db)
    const insert = db.prepare(`INSERT INTO message_list_records (
      reply_id, chat_name, target_name, text, images, triggered_at, source, status,
      note, chat_username, target_username, webhook_url, error, attempts,
      response_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', ?, 'manual', 'pending', '', '', '', '', '', 0, ?, ?, ?)`)
    db.exec('BEGIN')
    try {
      for (let i = 0; i < count; i += 1) {
        const triggeredAt = BASE_TIME + Math.floor(i / TIE_EVERY)
        insert.run(
          'reply-' + String(i + 1),
          '会话 ' + String(i % 100),
          '对象 ' + String(i % 37),
          '规模测试消息 ' + String(i + 1),
          triggeredAt,
          '',
          triggeredAt,
          triggeredAt,
        )
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Keep the original insert error.
      }
      throw e
    }
  })
}

function assertDescending(previous: MessageListRecord | undefined, next: MessageListRecord): void {
  if (previous === undefined) return
  expect(
    previous.triggeredAt > next.triggeredAt
      || (previous.triggeredAt === next.triggeredAt && previous.id > next.id),
  ).toBe(true)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'message-list-page-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('消息列表十万级游标分页', () => {
  it('100k 行可稳定走完，重复时间戳不重复不遗漏且顺序严格', () => {
    seedRecords(TOTAL)
    const startedAt = performance.now()
    const seen = new Set<number>()
    let cursor: string | undefined
    let previous: MessageListRecord | undefined
    let pages = 0
    let total = 0

    do {
      const page = listMessageListRecords(decrypted, {
        limit: MESSAGE_LIST_QUERY_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(page.readError).toBeUndefined()
      expect(page.items.length).toBeLessThanOrEqual(MESSAGE_LIST_QUERY_MAX)
      expect(page.hasMore).toBe(page.nextCursor !== undefined)
      total = page.total
      for (const record of page.items) {
        expect(seen.has(record.id), '同一个 id 被两页返回').toBe(false)
        seen.add(record.id)
        assertDescending(previous, record)
        previous = record
      }
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== undefined)

    const elapsedMs = performance.now() - startedAt
    console.log(
      '[MESSAGE_LIST_SCALE] rows=' + String(TOTAL)
        + ' pages=' + String(pages)
        + ' pageSize=' + String(MESSAGE_LIST_QUERY_MAX)
        + ' elapsedMs=' + elapsedMs.toFixed(1),
    )
    expect(total).toBe(TOTAL)
    expect(pages).toBe(Math.ceil(TOTAL / MESSAGE_LIST_QUERY_MAX))
    expect(seen.size).toBe(TOTAL)
  })

  it('请求超过 500 时返回明确 truncated / hasMore / nextCursor', () => {
    seedRecords(1_200)
    const page = listMessageListRecords(decrypted, { limit: 5_000 })
    expect(page.items).toHaveLength(MESSAGE_LIST_QUERY_MAX)
    expect(page.total).toBe(1_200)
    expect(page.truncated).toBe(true)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBeTypeOf('string')
    expect(decodeMessageListCursor(page.nextCursor)).toMatchObject({
      triggeredAt: page.items.at(-1)?.triggeredAt,
      id: page.items.at(-1)?.id,
    })
  })

  it('非法游标明确报错，不静默退回第一页', () => {
    seedRecords(3)
    const page = listMessageListRecords(decrypted, { cursor: 'not-a-cursor' })
    expect(page).toMatchObject({
      items: [],
      total: 0,
      hasMore: false,
      truncated: false,
    })
    expect(page.readError).toContain('分页游标无效')
  })

  it('按 id 刷新深页记录时继续应用当前筛选，缺失项表示删除或已不匹配', () => {
    seedRecords(10)
    const firstPage = listMessageListRecords(decrypted, { limit: 10 })
    const selected = firstPage.items.slice(0, 3)
    const ids = selected.map((record) => record.id)
    withWritableDb(taskDbPath(decrypted), (db) => {
      ensureMessageListSchema(db)
      db.prepare("UPDATE message_list_records SET status = 'success' WHERE id = ?")
        .run(ids[0]!)
    })

    const pending = listMessageListRecords(decrypted, { ids, status: 'pending' })
    expect(pending.readError).toBeUndefined()
    expect(pending.items.map((record) => record.id)).toEqual(ids.slice(1))
    expect(pending.total).toBe(9)
    expect(pending.hasMore).toBe(false)
    expect(pending.nextCursor).toBeUndefined()

    const unfiltered = listMessageListRecords(decrypted, { ids: [...ids].reverse() })
    expect(unfiltered.items.map((record) => record.id)).toEqual(ids)
    expect(unfiltered.items[0]?.status).toBe('success')
  })

  it('按 id 刷新拒绝非法、重复超限与游标混用', () => {
    seedRecords(3)
    expect(listMessageListRecords(decrypted, { ids: [0] }).readError).toContain('正整数')
    expect(listMessageListRecords(decrypted, {
      ids: Array.from({ length: MESSAGE_LIST_QUERY_MAX + 1 }, (_value, index) => index + 1),
    }).readError).toContain('最多刷新')
    expect(listMessageListRecords(decrypted, {
      ids: [1],
      cursor: encodeMessageListCursor({ triggeredAt: BASE_TIME, id: 1 }),
    }).readError).toContain('不支持分页游标')
  })

  it('复合游标使用顺序索引范围查找，不回退为全表 SCAN', () => {
    seedRecords(1_000)
    const cursor = decodeMessageListCursor(encodeMessageListCursor({
      triggeredAt: BASE_TIME + 100,
      id: 500,
    }))
    expect(cursor).toBeDefined()
    withWritableDb(taskDbPath(decrypted), (db) => {
      ensureMessageListSchema(db)
      const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT * FROM message_list_records
        WHERE (triggered_at, id) < (?, ?)
        ORDER BY triggered_at DESC, id DESC LIMIT ?`)
        .all(cursor?.triggeredAt ?? 0, cursor?.id ?? 0, 200) as Array<{ detail?: unknown }>
      const detail = plan.map((row) => String(row.detail ?? '')).join('\n')
      expect(detail).toContain('SEARCH')
      expect(detail).not.toContain('SCAN')
    })
  })
})
