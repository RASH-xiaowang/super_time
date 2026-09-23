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
/** 当前这一条用例要多少条消息（事件循环那条要多得多，见下面的 describe）。 */
let fixtureTotal = TOTAL
let disposers: Array<() => void> = []
let events: Array<Record<string, unknown>> = []
let onEvent: ((p: Record<string, unknown>) => void) | null = null

/** 造一份「网关读得到」的解密根：SessionTable + 该会话的消息分片。 */
function makeFixture(dir: string, total: number): void {
  mkdirSync(join(dir, 'session'), { recursive: true })
  mkdirSync(join(dir, 'message'), { recursive: true })
  const sdb = new DatabaseSync(join(dir, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare("INSERT INTO SessionTable (username, display_name, last_timestamp, sort_timestamp, unread_count, last_msg_type, last_msg_sender) VALUES (?, ?, ?, ?, 0, 1, '')")
    .run(USER, 'M3 进度夹具', 1700000000 + total, 1700000000 + total)
  sdb.close()

  const mdb = new DatabaseSync(join(dir, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(USER, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,?,?,?,?,?,?,?)`)
  mdb.exec('BEGIN')
  for (let i = 1; i <= total; i += 1) ins.run(i, i, 1, i % 2, 1700000000 + i, 1, `第 ${i} 条消息`, i, '')
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
  fixtureTotal = TOTAL
  root = await mkdtemp(join(tmpdir(), 'dsh-wechat-m3job-'))
  decrypted = join(root, 'decrypted')
  makeFixture(decrypted, fixtureTotal)
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
})

afterEach(async () => {
  for (const d of disposers) d()
  disposers = []
  onEvent = null
  vi.unstubAllEnvs()
  // Windows：刚关掉的 sqlite 句柄可能还在释放中，`maxRetries` 专治这个 EBUSY。
  await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 })
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
/**
 * H8 的验收项「其他面板查询不被阻塞超过 1 秒」在**单会话导出**这条路上原先不成立：
 * 收集 4 万条要翻 400 页，而整个翻页是一个同步循环 ⇒ 后端 worker 在此期间一个请求都进不来。
 * 真机量到的是「导出中一次 getSessions 往返 2573ms，空闲时 1ms」（`scripts/export-nonblocking-e2e.mjs`），
 * 但那份脚本不在 CI 门禁里 —— 所以这里用「事件循环延迟探针」把同一条事实钉进 CI。
 *
 * 三条从失败里学来的口径（2026-09-23，这条守卫自己在 CI 上跑红以后才想明白的）：
 *  ① **只量收集段**。写出/压缩段的结尾是「整个 sheet 一次 `deflateRawSync`」，那是一段
 *     结构上就无法切成小口的同步工作（RELEASE-PLAN 的 H8「仍未做」里就记着它）。把整次导出
 *     放在一起测，这条守卫测的就不是 H8 的缺陷而是那条欠账。收集段用进度事件的 `phase` 划出来。
 *  ② **阈值要跟本机抖动比，不能跟手感数字比**。CI runner 与其它作业抢 CPU，光空闲时的
 *     调度抖动能到几百毫秒 —— 原先写死的 400ms 在慢机上红给你看（1178ms），而那既不是
 *     收集段独占、也不是产品回归。现在先量 300ms 空闲基线，允许值 = `max(400ms, 6×空闲最大间隔)`。
 *  ③ 写出段仍然加了**宏任务**让出（`xlsxSheetChunksAsync`）：`for await` 的续体是微任务，
 *     微任务永远不让定时器与其它请求插进来 —— 那是一处真缺陷，只是它不足以解释 CI 上那个数。
 *     实验记在台账里：夹具加大到 16 万行时，**带让出与不带让出都会红**，红在结尾那次整条目压缩。
 */
describe('H8：单会话导出不独占后端事件循环', () => {
  it('收集段每一段都真的让出过（停顿与本机空闲抖动同量级）', async () => {
    fixtureTotal = 40_000
    for (const d of disposers) d()
    disposers = []
    root = await mkdtemp(join(tmpdir(), 'dsh-wechat-m3loop-'))
    decrypted = join(root, 'decrypted')
    makeFixture(decrypted, fixtureTotal)
    vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
    const gw = new WechatDataGateway(fakeCtx())
    const probe = (sink: number[]): NodeJS.Timeout => {
      let last = performance.now()
      return setInterval(() => {
        const now = performance.now()
        sink.push(now - last)
        last = now
      }, 20)
    }
    // ① 空闲基线：同一支探针，什么都不干时的调度抖动
    const idle: number[] = []
    const idleTimer = probe(idle)
    await new Promise((r) => { setTimeout(r, 300) })
    clearInterval(idleTimer)
    const idleMax = idle.length ? Math.max(...idle) : 0
    // 这个上限要挡的是「一次独占整个收集段」（退回同步写法实测 2573ms），不是「这台机器今天多快」。
    // 原先是 max(400, idleMax * 6)：2026-09-23 在 CI 共享 runner 上量到 409ms 就红过，
    // 而同一个提交的另一个作业全绿 —— 那是在量快慢，不是在量让没让。
    const allowed = Math.max(1200, idleMax * 20)
    // ② 用进度事件把「收集段」的终点划出来（payload 形如 {jobId, phase, done, total}）
    let collectEndsAt = Number.POSITIVE_INFINITY
    onEvent = (p: Record<string, unknown>): void => {
      if (collectEndsAt === Number.POSITIVE_INFINITY && p.phase !== 'collect') collectEndsAt = performance.now()
    }
    const delays: number[] = []
    const t0 = performance.now()
    const timer = probe(delays)
    const r = await gw.exportSessionMessages({ username: USER, format: 'excel', count: 0, jobId: 'job-loop' })
    clearInterval(timer)
    onEvent = null
    let acc = t0
    const collectGaps: number[] = []
    for (const d of delays) {
      acc += d
      if (acc <= collectEndsAt) collectGaps.push(d)
    }
    const max = collectGaps.length ? Math.max(...collectGaps) : 0
    expect(r.count, '夹具没按预期收满').toBe(40_000)
    // 主判据是**心跳条数**：每 8 页让出一次，收集段里探针就能按 20ms 的节奏跑到；
    // 退回同步写法时那是一段独占，一颗心跳都挤不进来（实测 2573ms 独占）。
    // 条数比时长鲁棒：机器慢只会让每颗心跳迟到，不会让它们消失。
    const collectMs = Number.isFinite(collectEndsAt) ? collectEndsAt - t0 : 0
    expect(collectGaps.length, `收集段 ${Math.round(collectMs)}ms 里只抓到 ${String(collectGaps.length)} 颗心跳（每 8 页让出一次的话约有 ${Math.round(collectMs / 20)} 颗）`).toBeGreaterThanOrEqual(Math.max(4, Math.floor(collectMs / 200)))
    expect(idleMax, '空闲基线一次都没跑到（校准前提不成立）').toBeGreaterThan(0)
    // 断言本体：收集段每 8 页让出一次。退回「一口气翻 400 页」的同步写法时，
    // 收集段就是一次独占（真机 4 万条实测 2573ms），必然超过这里的允许值。
    expect(max, `收集段独占事件循环 ${Math.round(max)}ms（空闲抖动 ${Math.round(idleMax)}ms，允许 ${Math.round(allowed)}ms）⇒ 收集段必须每 8 页让出一次`).toBeLessThan(allowed)
  }, 120_000)
})
