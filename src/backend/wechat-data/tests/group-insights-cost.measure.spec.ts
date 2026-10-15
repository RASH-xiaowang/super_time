/**
 * W2-4.4 观测基线 · 群聊洞察查询：扫一遍要多久、重复打开省多少（合成数据）。**不是回归用例**，靠 `MEASURE_GROUP_INSIGHTS=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 4.4 说「insights 查询按世代签名 SWR」。先要数清楚两件事：
 *   ① `queryGroupInsights` **一次**要多久 —— 它逐个打开 `message/message_*.db`、
 *      对每个分片跑一条 `SELECT create_time, message_content FROM Msg_<群>` 全表游标；
 *   ② 面板是**打开即查一次**（`useFreshData` 不轮询），所以省下来的只有「重复打开」那一档。
 *      真实场景是用户在群列表与几个群之间来回切 —— 那正是重复打开。
 *
 * 合成夹具刻意让**群消息散落在所有分片里**（每片一部分），而不是全挤在一片：
 * 那样每个分片都要被打开、被 `sqlite_master` 问一次表在不在，正是真实布局的开销。
 *
 * 运行：
 *   MEASURE_GROUP_INSIGHTS=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/group-insights-cost.measure.spec.ts
 *   分片数用 GI_SHARDS 覆盖（默认 8），每片消息数用 GI_ROWS 覆盖（默认 20000）。
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
import { queryGroupInsights } from '../src/query/group-insights.ts'
import { cachedBySig, fileSigOf, shardCatalogSig } from '../src/query/meta.ts'

const ROOM = '@@room_abcdef0123456789'

/** 建一个合成数据根：`message/message_N.db` × shards，每片都有一张该群的 Msg_* 表。 */
function makeRoot(shards: number, rowsPerShard: number): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-gi-'))
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const table = 'Msg_' + createHash('md5').update(ROOM, 'utf8').digest('hex')
  for (let s = 0; s < shards; s += 1) {
    const db = new DatabaseSync(join(decrypted, 'message', `message_${String(s)}.db`))
    db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let i = 0; i < rowsPerShard; i += 1) {
      const id = s * rowsPerShard + i + 1
      // 正文带 `wxid_x:\n` 前缀（群消息真实形状，`senderFromPrefix` 认它），其余走 zstd 压缩形态。
      ins.run(id, id, 1, i % 2, 1700000000 + id * 60, 1, 'wxid_member' + String(i % 50) + ':\n第 ' + String(i) + ' 条群消息', 'srv' + String(id), '')
    }
    db.exec('COMMIT')
    db.close()
  }
  return decrypted
}

describe.skipIf(process.env.MEASURE_GROUP_INSIGHTS !== '1')('W2：群聊洞察 冷算 vs 签名命中', () => {
  it('冷算一次要多久，签名命中省多少', { timeout: 300_000 }, () => {
    const SHARDS = Math.max(1, Number(process.env.GI_SHARDS ?? '8'))
    const ROWS = Math.max(1, Number(process.env.GI_ROWS ?? '20000'))
    const decrypted = makeRoot(SHARDS, ROWS)
    try {
      const t0 = Number(process.hrtime.bigint()) / 1e6
      const first = queryGroupInsights(decrypted, ROOM)
      const coldMs = Number(process.hrtime.bigint()) / 1e6 - t0
      expect(first.total, `夹具一条都没扫到（应为 ${String(SHARDS * ROWS)}）`).toBe(SHARDS * ROWS)
      expect(first.topMembers.length, '成员榜是空的 ⇒ 正则没认出群消息前缀，这个数没意义').toBeGreaterThan(0)

      // 同一签名下再算三次（模拟用户在同一批分片未变时反复打开）。
      const sig = [
        fileSigOf(join(decrypted, 'contact', 'contact.db')),
        shardCatalogSig(decrypted, ['message']),
      ].join('|')
      const repeats: number[] = []
      for (let i = 0; i < 3; i += 1) {
        const t = Number(process.hrtime.bigint()) / 1e6
        cachedBySig('gi:' + decrypted + ':' + ROOM, sig, () => queryGroupInsights(decrypted, ROOM), 60_000)
        repeats.push(Number(process.hrtime.bigint()) / 1e6 - t)
      }
      // 冷路径（签名变了）一次。
      const tCold = Number(process.hrtime.bigint()) / 1e6
      cachedBySig('gi2:' + decrypted, sig + '#x', () => queryGroupInsights(decrypted, ROOM), 60_000)
      const coldPathMs = Number(process.hrtime.bigint()) / 1e6 - tCold

      console.log([
        '',
        `[GROUP-INSIGHTS] ${String(SHARDS)} 分片 × ${String(ROWS)} 行 = ${String(SHARDS * ROWS)} 条群消息`,
        `  冷算（每次都要扫全部分片）  ${coldMs.toFixed(1)}ms`,
        `  经缓存壳的冷路径            ${coldPathMs.toFixed(1)}ms`,
        `  第一次（冷）                  ${(repeats[0] ?? 0).toFixed(1)}ms`,
        `  签名命中                  ${(repeats[1] ?? 0).toFixed(3)} / ${(repeats[2] ?? 0).toFixed(3)} ms`,
        `  单次省下                    ${(coldMs - (repeats[1] ?? 0)).toFixed(1)}ms`,
        '',
      ].join('\n'))
    } finally {
      rmSync(decrypted + '/..', { recursive: true, force: true })
    }
  })
})