/**
 * N9：搜索可中断（用户在扫描过程中换关键词/离开面板时，后端扫描必须尽快收尾）。
 *
 * 三条命题：
 *   ① **预取消**：令牌已经 aborted 时，连库都不开，直接返回空结果 + `cancelled`；
 *   ② **扫描中取消**：从 abort 到 Promise 落定的墙钟 ≤ 100ms（条目的验收口径），
 *      且返回的是「取消前已找到的部分」（放在表尾的命中**不该**被找到）；
 *   ③ **不留连接**：取消后能直接删掉分片文件 —— Windows 上句柄没关会 EPERM/EBUSY，
 *      所以「能删」就是「不再持有 shard 读连接」的判据。
 *
 * 夹具为什么大：要能稳定抓住「扫描进行中」这一刻（本机 12 万行 × 500B ≈ 350ms，
 * 取消发生在 ~30ms 处，离扫完还远；CI runner 慢约 24 倍只会更稳）。
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeAllTrackedDbs, openTrackedDb, removeDirWithRetry } from '../../tests/helpers/temp-db.ts'
import { searchIndexMessages, searchIndexMessagesCancellable } from '../src/query/search.ts'

vi.setConfig({ testTimeout: 420_000, hookTimeout: 420_000 })

const scratch: string[] = []
afterEach(async () => {
  closeAllTrackedDbs()
  const list = scratch.splice(0)
  for (const d of list) {
    const r = await removeDirWithRetry(d)
    if (!r.ok) console.warn(`[search-cancel] 临时目录未能删除（${r.code}，试了 ${r.attempts} 次）：${d}`)
  }
})

const USER = 'wxid_a'
const TERM = 'needle'
const TOTAL_ROWS = 120_000
const TRAILING_HITS = 5

/**
 * 造一个会话 + 12 万条消息：**命中只放在表尾**（最后 {@link TRAILING_HITS} 条），
 * 于是「提前取消」与「跑完」在结果上可区分。
 * @returns `{ decrypted, shardFile }`。
 */
function makeFixture(): { decrypted: string; shardFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'search-cancel-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const sdb = openTrackedDb(join(decrypted, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run(USER, USER)
  sdb.close()

  const shardFile = join(decrypted, 'message', 'message_0.db')
  const mdb = openTrackedDb(shardFile)
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  // 单事务插入：逐行提交在 runner 上会变成一整段无法应答 RPC 的同步阻塞（见 search-cursor 的实测记录）
  mdb.exec('BEGIN')
  const pad = 'x'.repeat(500)
  for (let i = 1; i <= TOTAL_ROWS; i += 1) {
    const isHit = i > TOTAL_ROWS - TRAILING_HITS
    const body = isHit ? `${TERM} 第 ${i} 条` : `普通消息 ${i}`
    ins.run(i, i, 1, i % 2, 1700000000 + i, 1, body + pad, `srv${i}`, '')
  }
  mdb.exec('COMMIT')
  mdb.close()
  return { decrypted, shardFile }
}

describe('N9：搜索可中断', () => {
  it('① 预取消：不开库、立即返回空结果 + cancelled', async () => {
    const { decrypted } = makeFixture()
    const ctrl = new AbortController()
    ctrl.abort()
    const t0 = Date.now()
    const r = await searchIndexMessagesCancellable(decrypted, TERM, 200, undefined, { signal: ctrl.signal })
    const elapsed = Date.now() - t0
    expect(r.cancelled).toBe(true)
    expect(r.hits).toEqual([])
    // 预取消连扫描都不该开始：这里给一个宽松但仍能抓住「其实扫了一遍」的上界
    expect(elapsed, `预取消耗时 ${elapsed}ms —— 看起来开了库又扫了一遍`).toBeLessThan(100)
  })

  it('② 扫描中取消：≤100ms 收尾、命中数 0（表尾的命中没被扫到）', async () => {
    const { decrypted } = makeFixture()
    const ctrl = new AbortController()
    const p = searchIndexMessagesCancellable(decrypted, TERM, 200, undefined, { signal: ctrl.signal })
    // 让扫描真正跑起来再取消（30ms 时必在扫，离 12 万行扫完还远）
    await new Promise((r) => { setTimeout(r, 30) })
    const tAbort = Date.now()
    ctrl.abort()
    const res = await p
    const latency = Date.now() - tAbort
    expect(res.cancelled).toBe(true)
    expect(res.hits, '取消发生在表尾命中之前，不该返回它们').toEqual([])
    expect(latency, `abort→落定 ${latency}ms，超过 100ms 的验收口径`).toBeLessThan(100)
  })

  it('③ 取消后不再持有 shard 读连接（分片文件可直接删除）', async () => {
    const { decrypted, shardFile } = makeFixture()
    const ctrl = new AbortController()
    const p = searchIndexMessagesCancellable(decrypted, TERM, 200, undefined, { signal: ctrl.signal })
    await new Promise((r) => { setTimeout(r, 30) })
    ctrl.abort()
    await p
    // Windows：句柄没关时 rmSync 会 EPERM/EBUSY —— 能删掉即「连接已释放」
    expect(() => { rmSync(shardFile) }).not.toThrow()
  })

  it('④ 对照：同一条链路不带令牌时跑完，表尾的命中能拿到（证明 ② 的 0 是提前收尾）', () => {
    const { decrypted } = makeFixture()
    const r = searchIndexMessages(decrypted, TERM, 200)
    expect(r.hits.length).toBe(TRAILING_HITS)
    expect(r.indexed).toBe(false)
  })
})

/**
 * 接线守卫（后端）：机制在上面几条命题里，但「谁把令牌交进来」在 gateway ——
 * 少了这一段，机制永远没人调用（本仓反复栽过的「模块写了但没接上」）。
 */
describe('N9：搜索可中断的后端接线', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const gatewaySrc = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts'), 'utf8')
  const searchSrc = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'search.ts'), 'utf8')

  it('searchMessages 走可取消入口，并把 jobId 换成令牌', () => {
    const at = gatewaySrc.indexOf("@Remote('searchMessages')")
    expect(at, 'gateway 里找不到 searchMessages').toBeGreaterThan(0)
    const body = gatewaySrc.slice(at, at + 900)
    expect(body, '没有调用可取消入口').toContain('searchIndexMessagesCancellable(')
    expect(body, '没有把 signal 传下去').toContain('{ signal: job.signal }')
    expect(body, 'jobId 没有换成令牌').toContain('this.searchSignal(options?.jobId)')
    expect(body, '不允许退回不可取消的同步入口').not.toContain('await searchIndexMessages(')
  })

  it('cancelSearch 真的 abort 了在跑的令牌', () => {
    const at = gatewaySrc.indexOf("@Remote('cancelSearch')")
    expect(at, 'gateway 里找不到 cancelSearch').toBeGreaterThan(0)
    const body = gatewaySrc.slice(at, at + 500)
    expect(body).toContain('this._searchJobs.get(id)')
    expect(body).toContain('ctrl.abort()')
  })

  it('协作驱动三件套仍在：取消检查 ×2 + 事件循环让出', () => {
    const at = searchSrc.indexOf('export async function searchIndexMessagesCancellable')
    expect(at, '找不到可取消入口（用例前提不成立）').toBeGreaterThan(0)
    const body = searchSrc.slice(at)
    expect((body.match(/if \(ctrl\?\.signal\?\.aborted\) \{ cancelled = true; break \}/g) ?? []).length,
      '取消检查少了 —— 至少要有「每 128 行」与「让出后」两处').toBe(2)
    expect(body, '让出没了 ⇒ 取消消息永远进不来').toContain('setImmediate')
  })
})
