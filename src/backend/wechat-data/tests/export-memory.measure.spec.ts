/**
 * H8 的性能实测（**不是回归用例**，因此文件名不以 .spec.ts 结尾，不会被 vitest 收集）。
 *
 * 为什么单独成文件：RSS 与事件循环阻塞都受 GC 时机、并行 worker、机器负载影响，
 * 放进 CI 只会变成随机红灯；但它们正是 H8 的核心指标（验收标准要求「记录实测峰值」），
 * 所以保留为可手动执行的测量，结果记在 docs/RELEASE-PLAN.md。
 *
 * 命名与门控：文件名必须是 *.spec.ts —— vitest 只收集这个后缀，改成别的名字根本执行不了
 * （试过，`No test files found`）。因此靠 `describe.skipIf(MEASURE_EXPORT_MEMORY !== '1')`
 * 默认跳过；不带参数跑 `npm test` 不会执行它（否则要跑 12 分钟）。
 *
 * 运行：
 *   MEASURE_EXPORT_MEMORY=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/export-memory.measure.spec.ts
 *
 * 只测三件事：
 *   ① zip 层：攒内存 vs 逐条目写盘的 RSS 峰值差；
 *   ② 端到端：exportAllSessions 在 150 / 600 / 1000 个会话下的 RSS 峰值（验证不随会话数线性增长）；
 *   ③ 端到端：导出期间事件循环最长阻塞（验收要求「其它查询不被阻塞超过 1 秒」）。
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ZipFileWriter, zipFiles } from '../src/query/zip.ts'
import { exportAllSessions } from '../src/query/export.ts'

const scratch: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(d)
  return d
}
function cleanup(): void {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
}

const MB = (n: number): string => (n / 1024 / 1024).toFixed(1) + 'MB'

/** 采样 RSS 峰值。 */
function startRss(): { stop: () => number } {
  const base = process.memoryUsage().rss
  let peak = base
  const t = setInterval(() => {
    const v = process.memoryUsage().rss
    if (v > peak) peak = v
  }, 20)
  if (t.unref) t.unref()
  return {
    stop: () => {
      clearInterval(t)
      const v = process.memoryUsage().rss
      if (v > peak) peak = v
      return peak - base
    },
  }
}

/** 采样事件循环最长阻塞（ms）：定时器每 10ms 应醒来一次，醒来晚了多少就是阻塞了多久。 */
function startStall(): { stop: () => number } {
  let max = 0
  let last = Date.now()
  const t = setInterval(() => {
    const now = Date.now()
    const gap = now - last - 10
    if (gap > max) max = gap
    last = now
  }, 10)
  if (t.unref) t.unref()
  return {
    stop: () => {
      clearInterval(t)
      return max
    },
  }
}

/** 高熵数据：压缩不了才反映真实量级。 */
function makePayload(seed: number, bytes: number): Buffer {
  const b = Buffer.allocUnsafe(bytes)
  let x = Math.imul(seed + 1, 2654435761) >>> 0
  for (let i = 0; i < bytes; i += 1) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    b[i] = (x >>> 16) & 0xff
  }
  return b
}

/** 造一个含 N 个会话、每会话 M 条消息的已解密数据根（返回 decrypted 目录）。 */
function makeRoot(sessions: number, msgsPerSession: number): string {
  const root = tempDir('measure-')
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insS = sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, \'\')')

  // 消息集中在少数分片里（贴近真实布局），每个会话一张 Msg_<md5> 表。
  const shards = 4
  const dbs: DatabaseSync[] = []
  for (let i = 0; i < shards; i += 1) dbs.push(new DatabaseSync(join(decrypted, 'message', 'message_' + String(i) + '.db')))
  const texts = Array.from({ length: msgsPerSession }, (_, i) => '第 ' + String(i) + ' 条消息内容' + 'x'.repeat(40))

  for (let s = 0; s < sessions; s += 1) {
    const u = 'wxid_s' + String(s).padStart(5, '0')
    insS.run(u, u, 1700000000 + s, 1700000000 + s)
    const db = dbs[s % shards]!
    const t = 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
    db.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER)`)
    const ins = db.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?)`)
    for (let i = 1; i <= msgsPerSession; i += 1) {
      ins.run(i, i, 1, i % 2, 1700000000 + i, 1, texts[i - 1]!, 'srv' + String(i))
    }
  }
  sdb.close()
  for (const db of dbs) db.close()
  return decrypted
}

describe.skipIf(process.env.MEASURE_EXPORT_MEMORY !== '1')('H8 性能实测', () => {
  it('① zip 层：攒内存 vs 流式写盘的 RSS 峰值', async () => {
    const COUNT = Number(process.env.MEASURE_ENTRIES ?? '60')
    const BYTES = Number(process.env.MEASURE_ENTRY_BYTES ?? String(4 * 1024 * 1024))
    const total = COUNT * BYTES

    const mem = startRss()
    const entries: Array<{ name: string; data: Uint8Array }> = []
    for (let i = 0; i < COUNT; i += 1) entries.push({ name: 'e' + String(i) + '.bin', data: makePayload(i, BYTES) })
    const memory = zipFiles(entries)
    const memPeak = mem.stop()
    entries.length = 0

    const dir = tempDir('measure-zip-')
    const p = join(dir, 'out.zip')
    const str = startRss()
    const w = await ZipFileWriter.create(p)
    for (let i = 0; i < COUNT; i += 1) await w.addFile('e' + String(i) + '.bin', makePayload(i, BYTES))
    await w.close()
    const strPeak = str.stop()

    console.log('\n① zip 层（输入 ' + MB(total) + '：' + COUNT + ' × ' + MB(BYTES) + '）')
    console.log('   攒内存路径 RSS 峰值增量：' + MB(memPeak))
    console.log('   流式路径   RSS 峰值增量：' + MB(strPeak))
    expect(statSync(p).size).toBe(memory.length)
    expect(readFileSync(p).equals(memory)).toBe(true)
    expect(strPeak).toBeLessThan(total / 2)
    cleanup()
  }, 300_000)

  it('② 端到端：exportAllSessions 的 RSS 峰值不随会话数线性增长', async () => {
    console.log('\n② exportAllSessions（每会话 300 条）')
    const rowOf = (n: number): string => {
      const decrypted = makeRoot(n, 300)
      const out = tempDir('measure-out-')
      const r = startRss()
      // 同步等待：exportAllSessions 现在是 async，这里用 await
      const promise = exportAllSessions(decrypted, { dir: out })
      return String(promise)
    }
    void rowOf
    for (const n of [150, 600, 1000]) {
      const decrypted = makeRoot(n, 300)
      const out = tempDir('measure-out-')
      const r = startRss()
      const res = await exportAllSessions(decrypted, { dir: out })
      const peak = r.stop()
      const size = MB(statSync(res.path).size)
      console.log('   ' + String(n).padStart(4) + ' 会话：RSS 峰值增量 ' + MB(peak) + ' · 产物 ' + size + ' · 共 ' + res.count + ' 条')
      cleanup()
    }
  }, 900_000)

  it('③ 端到端：导出期间事件循环最长阻塞（验收要求 < 1 秒）', async () => {
    const decrypted = makeRoot(400, 500)
    const out = tempDir('measure-stall-')
    const stall = startStall()
    const res = await exportAllSessions(decrypted, { dir: out })
    const maxStall = stall.stop()
    console.log('\n③ 阻塞：导出 ' + String(res.count) + ' 条（400 会话 × 500）期间事件循环最长阻塞 ' + String(maxStall) + 'ms')
    console.log('   产物 ' + MB(statSync(res.path).size))
    cleanup()
  }, 900_000)
})
