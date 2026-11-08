/**
 * 全局搜索的异步取消闭环。
 *
 * 判据分两层：
 *  - query 层：预取消不碰任何库；扫描中取消返回 `cancelled` 且不继续跑后续域；
 *  - gateway 层：`searchUnified(jobId)` 必须复用 `searchSignal` / `cancelSearch` 槽，
 *    不允许退回同步 `searchUnified`。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gatewaySource } from '../../tests/gateway-source.ts'
import { closeAllTrackedDbs, openTrackedDb, removeDirWithRetry } from '../../tests/helpers/temp-db.ts'
import { buildSearchIndex, searchIndexMessages, searchIndexMessagesCancellable } from '../src/query/search.ts'
import { querySessionsCancellable } from '../src/query/sessions.ts'
import { searchUnified, searchUnifiedCancellable } from '../src/query/unified-search.ts'

const scratch: string[] = []
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

afterEach(async () => {
  closeAllTrackedDbs()
  const dirs = scratch.splice(0)
  for (const dir of dirs) await removeDirWithRetry(dir)
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-unified-cancel-'))
  scratch.push(dir)
  return dir
}

function makeContactFixture(root: string): void {
  mkdirSync(join(root, 'contact'), { recursive: true })
  const db = openTrackedDb(join(root, 'contact', 'contact.db'))
  db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, alias TEXT, quan_pin TEXT)')
  db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?, ?)').run('wxid_cancel', '取消测试联系人', '', '', '')
}

function makeLargeMessageFixture(root: string): void {
  mkdirSync(join(root, 'session'), { recursive: true })
  mkdirSync(join(root, 'message'), { recursive: true })
  const username = 'wxid_scan'
  const session = openTrackedDb(join(root, 'session', 'session.db'))
  session.exec('CREATE TABLE SessionTable (username TEXT)')
  session.prepare('INSERT INTO SessionTable VALUES (?)').run(username)

  const shard = openTrackedDb(join(root, 'message', 'message_0.db'))
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  shard.exec(`CREATE TABLE "${table}" (local_id INTEGER, local_type INTEGER, create_time INTEGER, message_content TEXT)`)
  const insert = shard.prepare(`INSERT INTO "${table}" VALUES (?, 1, ?, ?)`)
  const pad = 'x'.repeat(300)
  shard.exec('BEGIN')
  for (let i = 1; i <= 40_000; i += 1) {
    insert.run(i, 1_700_000_000 + i, `普通消息 ${String(i)} ${pad}`)
  }
  // 命中放在表尾：如果取消没有生效，就会一路扫到最后并返回它。
  insert.run(40_001, 1_700_040_001, `needle 表尾命中 ${pad}`)
  shard.exec('COMMIT')
}

async function makeIndexedMessageFixture(root: string): Promise<string> {
  // 索引库落在 decrypted 的同级；必须再套一层，避免所有临时夹具共用系统临时目录的 wechat_search.db。
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const username = 'wxid_index_cancel'
  const session = openTrackedDb(join(decrypted, 'session', 'session.db'))
  session.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  session.prepare('INSERT INTO SessionTable VALUES (?, ?, 1700000000, 1700000000, 0, 1, \'\')').run(username, username)
  session.close()

  const shard = openTrackedDb(join(decrypted, 'message', 'message_0.db'))
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  shard.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const insert = shard.prepare(`INSERT INTO "${table}" VALUES (?, ?, 1, ?, ?, 1, ?, ?, '')`)
  shard.exec('BEGIN')
  for (let i = 1; i <= 24; i += 1) {
    const body = i <= 3 ? `needle indexed hit ${String(i)}` : `ordinary indexed row ${String(i)}`
    insert.run(i, i, i % 2, 1_700_000_000 + i, body, `srv${String(i)}`)
  }
  shard.exec('COMMIT')
  shard.close()
  await buildSearchIndex(decrypted, true)
  return decrypted
}

describe('searchUnifiedCancellable', () => {
  it('预取消直接返回空的部分快照，不伪装成“没有结果”', async () => {
    const root = tempRoot()
    const ctrl = new AbortController()
    ctrl.abort()
    const snap = await searchUnifiedCancellable(root, 'needle', 8, {}, { signal: ctrl.signal })
    expect(snap).toMatchObject({
      cancelled: true,
      query: 'needle',
      messages: [],
      contacts: [],
      moments: [],
      favorites: [],
      files: [],
      records: [],
    })
    expect(snap.readError).toBeUndefined()
  })

  it('未取消时与同步入口返回同一组域结果', async () => {
    const root = tempRoot()
    makeContactFixture(root)
    const sync = searchUnified(root, '取消测试', 8)
    const asyncSnap = await searchUnifiedCancellable(root, '取消测试', 8)
    expect(asyncSnap.cancelled).toBeUndefined()
    expect(asyncSnap.contacts).toEqual(sync.contacts)
    expect(asyncSnap.messages).toEqual(sync.messages)
  })

  it('扫描中取消：停止消息扫描，并且不再进入联系人等后续域', async () => {
    const root = tempRoot()
    makeContactFixture(root)
    makeLargeMessageFixture(root)
    const ctrl = new AbortController()
    const pending = searchUnifiedCancellable(root, 'needle', 8, {}, { signal: ctrl.signal })
    // 异步入口在第一处 await 前只启动消息扫描；这里同步取消，下一处逐行检查会立即收尾。
    ctrl.abort()
    const snap = await pending
    expect(snap.cancelled).toBe(true)
    expect(snap.messages, '取消在表尾命中之前发生，不应返回结尾命中').toEqual([])
    expect(snap.contacts, '取消后继续打开 contact.db ⇒ 后续域没有被闸住').toEqual([])
  })

  it('域边界取消：消息域已收尾后、联系人域开始前停止', async () => {
    const root = tempRoot()
    makeContactFixture(root)
    const ctrl = new AbortController()
    const pending = searchUnifiedCancellable(root, '取消测试', 8, {}, { signal: ctrl.signal })
    // 搜索入口在每个域之间 setImmediate；这个回调先于下一域前的让出执行，
    // 正好覆盖「消息域已结束、尚未进入联系人域」的边界。
    setImmediate(() => { ctrl.abort() })
    const snap = await pending
    expect(snap.cancelled).toBe(true)
    expect(snap.messages).toEqual([])
    expect(snap.contacts, '边界取消后仍进入联系人域 = 后续扫描没有及时停止').toEqual([])
  })
})

describe('searchIndexMessagesCancellable 索引快路径', () => {
  it('真实 FTS 索引命中时，预取消仍必须返回 cancelled，且不返回未标记的命中', async () => {
    const root = tempRoot()
    const decrypted = await makeIndexedMessageFixture(root)

    const baseline = searchIndexMessages(decrypted, 'needle', 8)
    expect(baseline, '夹具没有真正命中 FTS 索引，后面的取消断言不成立').toMatchObject({
      indexed: true,
      total: 3,
    })
    expect(baseline.hits).toHaveLength(3)

    const ctrl = new AbortController()
    ctrl.abort()
    const result = await searchIndexMessagesCancellable(decrypted, 'needle', 8, undefined, { signal: ctrl.signal })
    expect(result).toEqual({
      hits: [],
      total: 0,
      indexed: false,
      cancelled: true,
    })
  })

  it('索引探针返回命中后再取消：命中可以保留，但必须带 cancelled 标记', async () => {
    const root = tempRoot()
    const decrypted = await makeIndexedMessageFixture(root)
    let checks = 0
    // 真实 AbortSignal 不能在同步探针内部被另一个线程中止；用仅控制 aborted 读数的信号
    // 精确覆盖「入口检查通过、探针已命中、返回前复检失败」这一竞态窗口。
    const signal = {
      get aborted() {
        checks += 1
        return checks > 1
      },
    } as AbortSignal

    const result = await searchIndexMessagesCancellable(decrypted, 'needle', 8, undefined, { signal })
    expect(checks, '没有执行探针后的第二次取消检查').toBeGreaterThanOrEqual(2)
    expect(result).toMatchObject({
      total: 3,
      indexed: true,
      cancelled: true,
    })
    expect(result.hits).toHaveLength(3)
  })
})

describe('querySessionsCancellable', () => {
  it('预取消在打开 session.db 前返回，不伪装成空会话列表', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const snapshot = await querySessionsCancellable(
      'Z:\\path-that-must-not-be-opened',
      'needle',
      8,
      0,
      ctrl.signal,
    )
    expect(snapshot).toEqual({ sessions: [], total: 0, cancelled: true })
  })
})

describe('searchUnified gateway 接线', () => {
  it('复用 searchSignal / cancelSearch 槽，不允许退回同步实现', () => {
    const source = gatewaySource()
    const at = source.indexOf("@Remote('searchUnified')")
    expect(at, 'gateway 里找不到 searchUnified').toBeGreaterThan(0)
    const body = source.slice(at, at + 700)
    expect(body).toContain('this.searchSignal(options?.jobId)')
    expect(body).toContain('searchUnifiedCancellable(')
    expect(body).toContain('{ signal: job.signal }')
    expect(body).toContain('job?.done()')
    expect(body, '不允许退回不可取消的同步入口').not.toContain('return searchUnified(')
  })

  it('会话关键词搜索复用同一搜索取消槽，不阻塞全局搜索的取消闭环', () => {
    const source = gatewaySource()
    const at = source.indexOf("@Remote('getSessions')")
    expect(at, 'gateway 里找不到 getSessions').toBeGreaterThan(0)
    const body = source.slice(at, at + 700)
    expect(body).toContain('this.searchSignal(options?.jobId)')
    expect(body).toContain('querySessionsCancellable(')
    expect(body).toContain('job?.signal')
    expect(body).toContain('job?.done()')
  })
})
