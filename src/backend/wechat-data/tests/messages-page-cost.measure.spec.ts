/**
 * W2-3.5 观测基线 · 消息分页的排序成本：`(sort_seq, local_id)` 覆盖索引有没有（合成数据）。**不是回归用例**，靠 `MEASURE_MSG_PAGE=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 3.5 原文是「类型/关键词过滤下推 SQL，先量内存过滤占比」。先要确认「内存过滤」存不存在：
 * 量法是**把页大小扫一遍**，看 µs/条 是恒定（每行都要解码+组装）还是随页变大而下降
 * （说明存在一笔与 limit 无关的固定开销）。
 *
 * ⚠️ 这一份**直接发 SQL**，不走 `queryMessages`：读路径（W2-3.5 加的 `ensureSortIndexIfMissing`）
 * 会自动把索引补上，走它的话「无索引」那一组在第二次调用前就变成有索引，对照立刻失效（踩过一次）。
 * 直接发 SQL 才能把「有没有索引」这一个变量单独拿出来。
 *
 * 运行：
 *   MEASURE_MSG_PAGE=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/messages-page-cost.measure.spec.ts
 *   总条数用 MP_ROWS 覆盖（默认 50000），分片数用 MP_SHARDS 覆盖（默认 4）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const TALKER = 'wxid_friend0001'
const TABLE = 'Msg_' + createHash('md5').update(TALKER, 'utf8').digest('hex')

/** 建一个合成数据根：`message/message_0.db`，里面一张该会话的 `Msg_*` 表。 */
function makeRoot(shards: number, rows: number): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-mp-'))
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const per = Math.ceil(rows / shards)
  for (let s = 0; s < shards; s += 1) {
    const db = new DatabaseSync(join(decrypted, 'message', `message_${String(s)}.db`))
    db.exec(`CREATE TABLE "${TABLE}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = db.prepare(`INSERT INTO "${TABLE}" VALUES (?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let i = 0; i < per; i += 1) {
      const id = s * per + i + 1
      // 正文接近真实聊天长度（80 字），否则解码/读取成本会被严重低估。
      ins.run(id, id, 1, i % 2, 1700000000 + id * 30, 1, '第 ' + String(id) + ' 条：' + '内容'.repeat(20), 'srv' + String(id), '')
    }
    db.exec('COMMIT')
    db.close()
  }
  return decrypted
}

/** 一个分片的分页耗时（预热一次，跑 5 次取平均）。 */
function benchShard(dir: string, limit: number): number {
  const db = new DatabaseSync(join(dir, 'message', 'message_0.db'), { readOnly: true })
  const sql = `SELECT local_id, sort_seq, local_type, create_time, message_content FROM "${TABLE}" ORDER BY sort_seq DESC, local_id DESC LIMIT ?`
  try {
    const st = db.prepare(sql)
    st.all(limit)
    const t = Number(process.hrtime.bigint()) / 1e6
    for (let k = 0; k < 5; k += 1) st.all(limit)
    return (Number(process.hrtime.bigint()) / 1e6 - t) / 5
  } finally {
    db.close()
  }
}

function addSortIndex(dir: string): void {
  const db = new DatabaseSync(join(dir, 'message', 'message_0.db'))
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS dsh_sort_x ON "${TABLE}" (sort_seq, local_id)`)
  } finally {
    db.close()
  }
}

describe.skipIf(process.env.MEASURE_MSG_PAGE !== '1')('W2：消息分页 排序索引有没有', () => {
  it('同一份分片，加/不加 (sort_seq, local_id) 覆盖索引各扫一遍', { timeout: 300_000 }, () => {
    const ROWS = Math.max(100, Number(process.env.MP_ROWS ?? '50000'))
    const SHARDS = Math.max(1, Number(process.env.MP_SHARDS ?? '4'))
    // 两组用**两份独立分片**：同一份上「先量无索引、再建索引」，量第二次时 SQLite 的
    // 页缓存已经热了，比的就不再是索引而是缓存（踩过一次）。
    // 声明必须在 try 之外：块里的 const 在 finally 里是看不见的。
    const plainRoot = makeRoot(SHARDS, ROWS)
    const indexRoot = makeRoot(SHARDS, ROWS)
    try {
      addSortIndex(indexRoot)
      const rows: string[] = []
      for (const limit of [20, 100, 500, 1000]) {
        const noIdx = benchShard(plainRoot, limit)
        const withIdx = benchShard(indexRoot, limit)
        expect(withIdx, '加了索引反而更慢 ⇒ 这不是索引在起作用').toBeLessThan(noIdx)
        rows.push(`  单分片 limit ${String(limit).padStart(4)}  无索引 ${noIdx.toFixed(2).padStart(7)}ms  有索引 ${withIdx.toFixed(2).padStart(6)}ms  ⇒ ${(noIdx / Math.max(withIdx, 0.001)).toFixed(1)}×`)
      }
      console.log([
        '',
        `[MSG-PAGE] ${String(SHARDS)} 分片 / 共 ${String(ROWS)} 条 / 一个分片的分页成本`,
        ...rows,
        '',
        '  判读：无索引那组的耗时与页大小**几乎无关**（整表排序扫描），有索引那组与 limit 成正比。',
        '  这就是 W2-3.5 真正的落点 —— 不是「过滤下推」，而是「排序下推到索引」。',
        '',
      ].join('\n'))
    } finally {
      rmSync(plainRoot + '/..', { recursive: true, force: true })
      rmSync(indexRoot + '/..', { recursive: true, force: true })
    }
  })
})
