// @vitest-environment node
/**
 * M3 真链路：单会话导出带 `jobId` 时，进度必须**真的推出来**、取消必须**真的停得下来**。
 *
 * 为什么写成用例而不是靠人点一次：`chats-export.tsx` 从 M3 起就在传 `jobId`，而网关侧
 * `exportSessionMessages` 的入参里根本没有这个字段 —— 参数被静默丢掉，界面表现是
 * 「进度条一直 0、点中止说没有这个任务」，但**源码级守卫全是绿的**（客户端确实传了）。
 * 只有把真实的 `WechatDataGateway` + 真实的查询层跑起来，才看得见这一环断在哪里。
 *
 * 取消这一条刻意不靠时序抢跑：`onEvent` 钩子在第 3 个进度事件上按 jobId 取消 ——
 * 进度回调是同步调的 ⇒ 取消一定落在同一个收集循环内，结果可重现。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { GW_DIR, gatewayClassSource, gatewaySource } from '../../tests/gateway-source.ts'
import { WechatDataGateway } from '../src/gateway.ts'

const USER = 'wxid_m3job'
const TOTAL = 2000
/** 收集阶段每页 100 条 ⇒ 全量导出应有 TOTAL/100 次上报。 */
const PAGES = TOTAL / 100

let root = ''
let decrypted = ''
let disposers: Array<() => void> = []
let events: Array<Record<string, unknown>> = []
let onEvent: ((p: Record<string, unknown>) => void) | null = null

/** 造一份「网关读得到」的解密根：SessionTable + 该会话的消息分片。 */
function makeFixture(dir: string): void {
  mkdirSync(join(dir, 'session'), { recursive: true })
  mkdirSync(join(dir, 'message'), { recursive: true })
  const sdb = new DatabaseSync(join(dir, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare("INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, '')")
    .run(USER, 'M3 进度夹具', 1700000000 + TOTAL, 1700000000 + TOTAL)
  sdb.close()

  const mdb = new DatabaseSync(join(dir, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  mdb.exec('BEGIN')
  for (let i = 1; i <= TOTAL; i += 1) ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `第 ${i} 条消息`, i, '')
  mdb.exec('COMMIT')
  mdb.close()
}

/** 网关构造期只用 reflect/effect/emit；emit 这里充当「渲染层收到的那串事件」。 */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: (_name: string, payload: unknown) => {
      const p = payload as Record<string, unknown>
      events.push(p)
      onEvent?.(p)
    },
  } as unknown as Context
}

beforeEach(async () => {
  events = []
  onEvent = null
  root = await mkdtemp(join(tmpdir(), 'dsh-wechat-m3job-'))
  decrypted = join(root, 'decrypted')
  makeFixture(decrypted)
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
})

afterEach(async () => {
  for (const d of disposers) d()
  disposers = []
  onEvent = null
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('M3：单会话导出的进度与取消', () => {
  it('带 jobId 的导出按该 jobId 推出递增进度，并留下可读的终态', async () => {
    const gw = new WechatDataGateway(fakeCtx())
    const r = await gw.exportSessionMessages({ username: USER, format: 'txt', count: 0, jobId: 'job-ok' })
    expect(r.count).toBe(TOTAL)

    const mine = events.filter((e) => e.jobId === 'job-ok')
    expect(mine.length, '一个进度事件都没推 —— jobId 又断了').toBeGreaterThanOrEqual(PAGES)
    const dones = mine.map((e) => Number(e.done))
    expect(dones[0], '第一次上报就该是已收集的一页，而不是 0').toBeGreaterThan(0)
    for (let i = 1; i < dones.length; i += 1) expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1])
    expect(dones[dones.length - 1]).toBe(TOTAL)
    expect(mine.every((e) => typeof e.phase === 'string' && e.phase !== ''), '每次上报都要带阶段名').toBe(true)

    const p = gw.getExportProgress({ jobId: 'job-ok' })
    expect(p).toMatchObject({ found: true, finished: true, done: TOTAL })
    expect(p.error, '成功不该留下错误').toBeUndefined()
    // 终态槽位留着（迟到的轮询要读得到），但取消要说「已结束」，不能假装还能停
    expect(gw.cancelExportJob({ jobId: 'job-ok' })).toEqual({ ok: false, error: '该导出任务已结束' })
  })

  it('不带 jobId：不注册任务、一个事件都不推', async () => {
    const gw = new WechatDataGateway(fakeCtx())
    const r = await gw.exportSessionMessages({ username: USER, format: 'txt', count: 0 })
    expect(r.count).toBe(TOTAL)
    expect(events).toEqual([])
    expect(gw.getExportProgress({ jobId: 'never-registered' })).toMatchObject({ found: false, finished: true })
  })

  it('导出中途按 jobId 取消：立刻停、按「取消」记账而不是失败', async () => {
    const gw = new WechatDataGateway(fakeCtx())
    let cancelCalls = 0
    onEvent = (p): void => {
      if (p.jobId !== 'job-cancel' || cancelCalls > 0) return
      if (events.filter((e) => e.jobId === 'job-cancel').length < 3) return
      cancelCalls += 1
      expect(gw.cancelExportJob({ jobId: 'job-cancel' })).toEqual({ ok: true })
    }
    await expect(gw.exportSessionMessages({ username: USER, format: 'txt', count: 0, jobId: 'job-cancel' }))
      .rejects.toThrow(/取消|cancel|abort/i)
    expect(cancelCalls, '进度事件少于 3 个 ⇒ 取消从未触发（用例前提不成立）').toBe(1)

    const seen = events.filter((e) => e.jobId === 'job-cancel')
    expect(seen.length, '取消后还在继续上报 ⇒ 没真的停').toBeLessThan(PAGES)
    const p = gw.getExportProgress({ jobId: 'job-cancel' })
    expect(p).toMatchObject({ found: true, finished: true })
    expect(p.error).toMatch(/取消|cancel|abort/i)

    const hist = gw.getExportHistory({ limit: 10 })
    // 落库有一条**已测过的规则**：`path` 为空就不记（「没有路径的历史没有可操作性」），
    // 而取消发生在收集阶段 ⇒ 根本没有产出路径 ⇒ 导出历史里没有这一条。
    // 这里如实钉住它：审计走操作日志（下一行），界面提示走「已取消导出」（面板的 catch 分支）。
    expect(hist.items.some((x) => x.kind === 'session'), 'path 为空的历史不该落库').toBe(false)
    const log = gw.getOperationLog({ categories: ['export'], q: 'export_session_messages', limit: 10 })
    expect(log.items.length, '取消没进操作日志 ⇒ 事后完全查不到这次导出').toBeGreaterThan(0)
    expect(log.items[0]!.status).toBe('fail')
  })

  it('客户端传 jobId 的每个接口，服务端签名与实现都必须吃到它（不许静默丢参数）', () => {
    // 口径：从客户端源码**现算**要检查哪些方法 —— 写死清单会随接口漂移，那正是这次的漏法。
    const client = readFileSync(join(GW_DIR, '..', '..', '..', '..', 'src', 'client', 'ui-wechat',
      'src', 'client', 'pages', 'wechat-data', 'api-export-ops.ts'), 'utf8')
    const senders = new Set<string>()
    for (const block of client.split(/(?=export async function )/)) {
      if (!/\bjobId\?\s*:\s*string/.test(block)) continue
      for (const m of block.matchAll(/remote\(\)\.([A-Za-z0-9_]+)\(/g)) senders.add(m[1])
    }
    expect([...senders].sort(), '客户端一个 jobId 接口都没抓到 ⇒ 抓取口径失效').toEqual(
      ['createEncryptedBackup', 'exportAllSessions', 'exportMoments', 'exportSessionMessages'])

    const remoteFiles = readdirSync(join(GW_DIR, 'remotes')).filter((f) => f.endsWith('.ts'))
    const shell = gatewayClassSource()
    for (const m of senders) {
      // ① `@Remote` 壳的**签名**里有 jobId：没有的话 RPC 边界就把它咽了（本次的 bug 本体）
      const at = shell.indexOf(`@Remote('${m}')`)
      expect(at, `网关类里没有 @Remote('${m}')`).toBeGreaterThan(-1)
      const nextAt = shell.indexOf("@Remote('", at + 10)
      const member = shell.slice(at, nextAt > at ? nextAt : shell.length)
      const sig = member.slice(member.indexOf(`${m}(`))
      const bodyAt = sig.indexOf('return ')
      const beforeBody = bodyAt > 0 ? sig.slice(0, bodyAt) : sig
      expect(beforeBody, `@Remote('${m}') 的入参类型没声明 jobId —— 客户端传了也会被丢掉`).toMatch(/jobId\?\s*:\s*string/)

      // ② 实现体真的用它（normalizeJobId / streamControl），而不是接着不用
      const file = remoteFiles.find((f) => new RegExp(`\\n {4}(?:async )?${m}\\(`).test(
        readFileSync(join(GW_DIR, 'remotes', f), 'utf8')))
      expect(file, `remotes/ 里找不到 ${m} 的实现`).toBeTruthy()
      const text = readFileSync(join(GW_DIR, 'remotes', file!), 'utf8')
      const start = text.search(new RegExp(`\\n {4}(?:async )?${m}\\(`))
      const after = text.slice(start + 1)
      const nextDef = after.search(/\n {4}(?:async )?[A-Za-z0-9_]+\(/)
      const body = nextDef > 0 ? after.slice(0, nextDef) : after
      expect(body, `${m} 的实现没消费 jobId（既没归一也没接进度/取消）`).toMatch(/normalizeJobId|streamControl/)
    }
    expect(gatewaySource()).toMatch(/EXPORT_PROGRESS_EVENT/)
  })
})
