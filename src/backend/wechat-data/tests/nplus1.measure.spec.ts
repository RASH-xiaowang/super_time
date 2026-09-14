/**
 * M11（N+1 查询）的真实数据基线测量。**不是回归用例**，靠 `MEASURE_M11=1` 门控。
 *
 * 只读打开真实的解密数据根（默认 `%APPDATA%/super-time-electron/wechat-data/decrypted`）。
 *
 * 量三条链路的**每次调用代价**与**调用次数**：
 *   A. 图片路径：`resolveImageFilePath`（每张图都要读一次 hardlink.db 的**整张 dir2id**）
 *      + `resolveImageResourceHint`（每张图开一次分片库、可能再开一次 message_resource.db）；
 *   B. 消息定位：`queryMessageByServerId`（每个分片 × 每张 Msg 表一次 `WHERE server_id=?`，
 *      纯数字未命中还要**再整轮**用 `CAST(server_id AS TEXT)` 扫一遍）；
 *   C. `server_id=?` 到底走不走索引（决定数字优先那条路径是否真有收益）。
 *
 * 运行：
 *   MEASURE_M11=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/nplus1.measure.spec.ts
 * @vitest-environment node
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveImageFilePath, resolveImageResourceHint } from '../src/query/media-image.ts'
import { queryMessageByServerId } from '../src/query/messages.ts'
import { shardCatalog } from '../src/query/meta.ts'

const DATA = process.env.M11_DATA_DIR
  || join(process.env.APPDATA ?? '', 'super-time-electron', 'wechat-data', 'decrypted')

function ms(fn: () => unknown, runs: number): { median: number; all: number[] } {
  const all: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = Number(process.hrtime.bigint()) / 1e6
    fn()
    all.push(Number(process.hrtime.bigint()) / 1e6 - t0)
  }
  all.sort((a, b) => a - b)
  return { median: all[Math.floor(all.length / 2)], all }
}

describe.skipIf(process.env.MEASURE_M11 !== '1')('M11 N+1 基线（真实数据）', () => {
  it('量一条真实链路的每次调用代价', () => {
    if (!existsSync(DATA)) { console.log('M11：找不到数据根 ' + DATA + '，用 M11_DATA_DIR 指定'); return }
    const N = Number(process.env.M11_N ?? '30')

    // ── A. hardlink.db / dir2id ──
    const hdb = join(DATA, 'hardlink', 'hardlink.db')
    let md5s: string[] = []
    let dir2idRows = -1
    let infoRows = -1
    if (existsSync(hdb)) {
      const db = new DatabaseSync(hdb, { readOnly: true })
      dir2idRows = (db.prepare('SELECT COUNT(*) AS c FROM dir2id').get() as { c: number }).c
      infoRows = (db.prepare('SELECT COUNT(*) AS c FROM image_hardlink_info_v4').get() as { c: number }).c
      md5s = (db.prepare('SELECT lower(md5) AS m FROM image_hardlink_info_v4 WHERE length(md5) = 32 LIMIT ?').all(N) as Array<{ m: unknown }>)
        .map((r) => String(r.m))
      console.log(`\ndir2id 行数 = ${dir2idRows}；image_hardlink_info_v4 行数 = ${infoRows}`)
      const d2 = ms(() => db.prepare('SELECT rowid, username FROM dir2id').all(), 10)
      console.log(`  读整张 dir2id：中位 ${d2.median.toFixed(2)}ms（每张图一次 ⇒ ${N} 张图 ≈ ${(d2.median * N).toFixed(0)}ms）`)
      db.close()
    }

    // ── B. 每张图的解析 ──
    const t0 = Number(process.hrtime.bigint()) / 1e6
    let hits = 0
    for (const m of md5s) {
      if (resolveImageFilePath(DATA, DATA, m, '')) hits += 1
    }
    const perImage = (Number(process.hrtime.bigint()) / 1e6 - t0) / Math.max(md5s.length, 1)
    console.log(`  resolveImageFilePath × ${md5s.length}：命中 ${hits}，平均 ${perImage.toFixed(2)}ms/张（含每次新建连接）`)

    const cat = shardCatalog(DATA)
    let shardFiles = 0
    let msgTables = 0
    for (const sh of cat) { shardFiles += 1; msgTables += sh.tables.size }
    console.log(`  分片 ${shardFiles} 个，Msg_ 表共 ${msgTables} 张 ⇒ queryMessageByServerId 最坏每次 ${shardFiles * msgTables} 次查询（×2 轮 = ${shardFiles * msgTables * 2}）`)

    // ── C. server_id 走不走索引 ──
    if (cat.length > 0) {
      const first = cat.find((s) => s.tables.size > 0)
      if (first) {
        const table = [...first.tables.keys()][0]
        const db = new DatabaseSync(first.file, { readOnly: true, readBigInts: true })
        const plan = (sql: string): string => {
          try {
            return (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as Array<{ detail?: unknown }>)
              .map((r) => String(r.detail ?? '')).join(' ; ')
          } catch (e) { return 'ERR ' + (e as Error).message }
        }
        console.log(`\n  索引计划（${table}）：`)
        console.log('    整型等值  : ' + plan(`SELECT 1 FROM "${table}" WHERE server_id = 1`))
        console.log('    CAST 文本 : ' + plan(`SELECT 1 FROM "${table}" WHERE CAST(server_id AS TEXT) = '1'`))
        console.log('    或式合并  : ' + plan(`SELECT 1 FROM "${table}" WHERE server_id = 1 OR CAST(server_id AS TEXT) = '1'`))
        const real = db.prepare(`SELECT CAST(server_id AS TEXT) AS s FROM "${table}" WHERE server_id > 0 LIMIT 1`).get() as { s?: string } | undefined
        db.close()
        if (real?.s) {
          // 未命中路径每次换**新** id，否则第二个开始就命中 M11 的签名缓存（量不到真实扫描）
          const cold: number[] = []
          for (let k = 0; k < 3; k += 1) {
            const t = Number(process.hrtime.bigint()) / 1e6
            queryMessageByServerId(DATA, '9999999999' + String(k))
            cold.push(Number(process.hrtime.bigint()) / 1e6 - t)
          }
          cold.sort((a, b) => a - b)
          const middle = (xs: number[]): number => xs[Math.floor(xs.length / 2)]
          console.log(`  未命中（每次换新 id，无缓存可利用）：中位 ${middle(cold).toFixed(1)}ms —— 两轮扫描，改动前的量级`)
          const hitId = String(real.s)
          const missId = '8888888888'
          const timeOne = (id: string): number => {
            const t = Number(process.hrtime.bigint()) / 1e6
            queryMessageByServerId(DATA, id)
            return Number(process.hrtime.bigint()) / 1e6 - t
          }
          const hitFirst = timeOne(hitId)
          const hitRep = ms(() => queryMessageByServerId(DATA, hitId), 20)
          const missFirst = timeOne(missId)
          const missRep = ms(() => queryMessageByServerId(DATA, missId), 20)
          console.log(`  命中   id：首次 ${hitFirst.toFixed(2)}ms → 缓存后重复中位 ${hitRep.median.toFixed(2)}ms`)
          console.log(`  未命中 id：首次 ${missFirst.toFixed(1)}ms → 缓存后重复中位 ${missRep.median.toFixed(2)}ms`)
        }
      }
    }

    // ── D. 图片资源提示（会开分片库 + 可能开 message_resource.db） ──
    const t1 = Number(process.hrtime.bigint()) / 1e6
    for (let i = 0; i < 10; i += 1) resolveImageResourceHint(DATA, 'wxid_does_not_exist', i + 1)
    const hint = (Number(process.hrtime.bigint()) / 1e6 - t1) / 10
    console.log(`  resolveImageResourceHint（不存在的会话，走满全部分片扫描）：${hint.toFixed(2)}ms/次`)
    expect(N).toBeGreaterThan(0)
  }, 600_000)
})
