#!/usr/bin/env node
/**
 * 消息列表十万级游标分页基准。
 *
 * 用法：
 *   node --experimental-strip-types scripts/message-list-scale-bench.mjs
 *   MESSAGE_LIST_BENCH_ROWS=200000 node --experimental-strip-types scripts/message-list-scale-bench.mjs
 *
 * 输出 JSON，包含建库、首页、逐页 p50/p95、总页数、唯一 id 数和 RSS。
 * 这里故意让每 7 条记录共享同一 triggered_at，验证复合游标而不是时间戳单键。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { withWritableDb } from '../src/backend/wechat-data/src/query/db-open.ts'
import {
  MESSAGE_LIST_QUERY_MAX,
  ensureMessageListSchema,
  listMessageListRecords,
} from '../src/backend/wechat-data/src/query/message-list-store.ts'
import { taskDbPath } from '../src/backend/wechat-data/src/query/task-db.ts'

const ROWS = Math.max(1, Number(process.env.MESSAGE_LIST_BENCH_ROWS ?? 100_000))
const TIE_EVERY = 7
const BASE_TIME = 1_700_000_000_000
const root = mkdtempSync(join(tmpdir(), 'message-list-bench-'))
const decrypted = join(root, 'data', 'decrypted')
mkdirSync(decrypted, { recursive: true })

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? 0
}

try {
  const seedStarted = performance.now()
  withWritableDb(taskDbPath(decrypted), (db) => {
    ensureMessageListSchema(db)
    const insert = db.prepare(`INSERT INTO message_list_records (
      reply_id, chat_name, target_name, text, images, triggered_at, source, status,
      note, chat_username, target_username, webhook_url, error, attempts,
      response_summary, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '[]', ?, 'manual', 'pending', '', '', '', '', '', 0, ?, ?, ?)`)
    db.exec('BEGIN')
    try {
      for (let index = 0; index < ROWS; index += 1) {
        const triggeredAt = BASE_TIME + Math.floor(index / TIE_EVERY)
        insert.run(
          'reply-' + String(index + 1),
          '会话 ' + String(index % 100),
          '对象 ' + String(index % 37),
          '规模测试消息 ' + String(index + 1),
          triggeredAt,
          '',
          triggeredAt,
          triggeredAt,
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 保留原始写入错误。
      }
      throw error
    }
  })
  const seedMs = performance.now() - seedStarted

  const firstStarted = performance.now()
  const first = listMessageListRecords(decrypted, { limit: MESSAGE_LIST_QUERY_MAX })
  const firstPageMs = performance.now() - firstStarted
  const pageTimes = [firstPageMs]
  const seen = new Set(first.items.map((item) => item.id))
  let cursor = first.nextCursor
  let pages = 1
  let targetedIds = []

  while (cursor !== undefined) {
    const pageStarted = performance.now()
    const page = listMessageListRecords(decrypted, {
      limit: MESSAGE_LIST_QUERY_MAX,
      cursor,
    })
    pageTimes.push(performance.now() - pageStarted)
    for (const item of page.items) seen.add(item.id)
    if (pages === 100) targetedIds = page.items.slice(0, 200).map((item) => item.id)
    cursor = page.nextCursor
    pages += 1
    if (page.readError !== undefined) throw new Error(page.readError)
  }
  const targetedStarted = performance.now()
  const targeted = listMessageListRecords(decrypted, {
    ids: targetedIds,
    limit: targetedIds.length,
  })
  const targetedRefreshMs = performance.now() - targetedStarted
  if (targeted.readError !== undefined) throw new Error(targeted.readError)
  if (targeted.items.length !== targetedIds.length) {
    throw new Error('定向刷新返回数量不完整')
  }

  process.stdout.write(JSON.stringify({
    rows: ROWS,
    pageSize: MESSAGE_LIST_QUERY_MAX,
    pages,
    uniqueIds: seen.size,
    seedMs: Number(seedMs.toFixed(1)),
    firstPageMs: Number(firstPageMs.toFixed(1)),
    pageP50Ms: Number(percentile(pageTimes, 0.5).toFixed(1)),
    pageP95Ms: Number(percentile(pageTimes, 0.95).toFixed(1)),
    totalMs: Number(pageTimes.reduce((sum, value) => sum + value, 0).toFixed(1)),
    targetedCount: targetedIds.length,
    targetedRefreshMs: Number(targetedRefreshMs.toFixed(1)),
    rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  }, null, 2) + '\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
