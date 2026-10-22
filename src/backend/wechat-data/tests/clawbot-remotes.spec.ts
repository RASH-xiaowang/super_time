/**
 * ClawBot `remotes/clawbot.ts` 工厂守卫（iLink 接入后版本，2026-10-12）。
 *
 * 守的是处理器层的五件事：
 *  ① 六个对外方法的行为（取码真失败要抛、状态轮询的四态与在途去重）；
 *  ② **凭证纪律**：确认后的凭证只进库、只给通道，不进快照/事件；
 *  ③ **审计**：绑定/解绑/通道终态错误各写一行 `category='clawbot'`（不逐条记消息）；
 *  ④ **事件**：`clawbot/message` 的载荷**只带 lastId/delta/slot、不带正文**（slot 是多实例的判别位）；
 *  ⑤ **通道生命周期**：确认即启动、解绑即停止、启动钩子只在「已绑定 + 有凭证」时动手。
 *
 * 全部 iLink 依赖注入假实现 —— 这套用例一个字节都不出网。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClawbotRemotes, CLAWBOT_INLINE_MAX_BYTES, insertClawbotMessages, type ClawbotEmitEvent } from '../src/remotes/clawbot.ts'
import { readBindingInternal, saveSendContextToken } from '../src/query/clawbot/clawbot-binding.ts'
import { clawbotDbExists, clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import { createClawbotInstance } from '../src/query/clawbot/clawbot-instance.ts'
import type { ClawbotMediaOutcome } from '../src/query/clawbot/clawbot-media.ts'
import { insertClawbotMessage, suppressClawbotMessageIds } from '../src/query/clawbot/clawbot-message.ts'
import { enqueueOrMergeReplyRun, listRecoverableReplyRuns, readReplyRun, saveReplyParts } from '../src/query/clawbot/clawbot-reply-store.ts'
import type { IlinkCredentials, IlinkOutgoingText, IlinkPollResult, IlinkSendResult, IlinkUpdates, WeixinMessage } from '../src/query/clawbot/clawbot-ilink.ts'
import { withDb, withWritableDb } from '../src/query/db-open.ts'
import type { OperationCategory, OperationStatus } from '../src/types.ts'

const capturedAutoReplyRunners = vi.hoisted(() => [] as Array<{ pending: () => number }>)
vi.mock('../src/query/clawbot/clawbot-auto-reply.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/query/clawbot/clawbot-auto-reply.ts')>()
  return {
    ...actual,
    createAutoReplyRunner: (deps: Parameters<typeof actual.createAutoReplyRunner>[0]) => {
      const runner = actual.createAutoReplyRunner(deps)
      capturedAutoReplyRunners.push(runner)
      return runner
    },
  }
})

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
  capturedAutoReplyRunners.length = 0
  vi.useRealTimers()
})

interface OpRecord { category: OperationCategory, action: string, status: OperationStatus, target: string, detail: string }

/** 假 iLink 的可编程切面（全部同步可控，不碰网络）。 */
interface FakeIlink {
  /** 取码：每次返回不同的 token/payload（重生成场景要能看出换了一轮）。 */
  requestBindQrCalls: number
  requestBindQrImpl: (() => Promise<{ token: string, payload: string }>) | null
  /** 状态轮询的结果队列（空了 ⇒ 抛错提示测试没安排好）。 */
  pollQueue: IlinkPollResult[]
  /** 状态轮询的完全接管（在途去重场景要拿住 promise 不放）。 */
  pollImpl: ((token: string) => Promise<IlinkPollResult>) | null
  pollCalls: string[]
  /** 消息长轮询实现（缺省返回一个永不落定的 promise —— 循环挂起、不空转）。 */
  updatesImpl: (buf: string) => Promise<IlinkUpdates>
  /** 发送：按队列消费（空了 = 成功空响应）；项可以是 Error 模拟网络抛错。 */
  sendQueue: Array<IlinkSendResult | Error>
  sendImpl: ((credentials: IlinkCredentials, out: IlinkOutgoingText) => Promise<IlinkSendResult>) | null
  sendCalls: Array<{ toUserId: string, text: string, contextToken: string, clientId: string }>
  /** 媒体取数：记录 id，按注入实现作答（缺省给「测试未安排」）。 */
  mediaCalls: number[]
  mediaImpl: ((dir: string, id: number) => Promise<ClawbotMediaOutcome>) | null
  /** 启动补扫清点：按测试安排返回待取行 id。 */
  mediaPending: number[]
}

function makeHarness(options: { createInstance?: boolean } = {}): {
  rc: Parameters<typeof createClawbotRemotes>[0],
  ops: OpRecord[],
  events: ClawbotEmitEvent[],
  dir: string,
  ilink: FakeIlink,
} {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-rmt-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  // 生产流程先有实例再取码；需要验证 fresh DB 时由用例显式关闭。
  if (options.createInstance !== false) createClawbotInstance(dir)
  const ops: OpRecord[] = []
  const events: ClawbotEmitEvent[] = []
  const ilink: FakeIlink = {
    requestBindQrCalls: 0,
    requestBindQrImpl: null,
    pollQueue: [],
    pollImpl: null,
    pollCalls: [],
    updatesImpl: () => new Promise<IlinkUpdates>(() => { /* 挂起：等测试手动推进或直接不解 */ }),
    sendQueue: [],
    sendImpl: null,
    sendCalls: [],
    mediaCalls: [],
    mediaImpl: null,
    mediaPending: [],
  }
  const rc: Parameters<typeof createClawbotRemotes>[0] = {
    dirs: () => ({ decrypted: dir }),
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => {
      ops.push({ category, action, status, target: target ?? '', detail: detail ?? '' })
    },
    emit: (event: ClawbotEmitEvent) => { events.push(event) },
    ilink: {
      requestBindQr: async () => {
        ilink.requestBindQrCalls += 1
        if (ilink.requestBindQrImpl !== null) return ilink.requestBindQrImpl()
        const token = `qr-tok-${ilink.requestBindQrCalls}`
        return { token, payload: `https://liteapp.weixin.qq.com/q/x?qrcode=${token}` }
      },
      pollBindStatus: async (token: string) => {
        ilink.pollCalls.push(token)
        if (ilink.pollImpl !== null) return ilink.pollImpl(token)
        const next = ilink.pollQueue.shift()
        if (next === undefined) throw new Error('测试没安排下一轮 pollBindStatus 结果')
        return next
      },
      getUpdates: (_credentials: IlinkCredentials, buf: string) => ilink.updatesImpl(buf),
      sendTextMessage: async (_credentials: IlinkCredentials, out: IlinkOutgoingText): Promise<IlinkSendResult> => {
        ilink.sendCalls.push({ toUserId: out.toUserId, text: out.text, contextToken: out.contextToken, clientId: out.clientId ?? '' })
        if (ilink.sendImpl !== null) return ilink.sendImpl(_credentials, out)
        const next = ilink.sendQueue.shift()
        if (next instanceof Error) throw next
        return next ?? { ret: 0, errMsg: '' }
      },
      // 退避不真等，但要**让出宏任务**：纯微任务的即时 sleep 会让「意外失败循环」
      // 把事件循环饿死（不再有任何超时/断言机会）—— 这种挂死比失败难查得多。
      sleep: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
    },
    media: {
      ensure: async (dir: string, id: number): Promise<ClawbotMediaOutcome> => {
        ilink.mediaCalls.push(id)
        if (ilink.mediaImpl !== null) return ilink.mediaImpl(dir, id)
        return { ok: false, error: '测试未安排媒体结果' }
      },
      listPending: (limit: number): number[] => ilink.mediaPending.slice(0, limit),
    },
  }
  return { rc, ops, events, dir, ilink }
}

/** 一批「用户文本消息」。 */
function textBatch(id: number, text: string, buf: string): IlinkUpdates {
  const msg: WeixinMessage = { message_id: id, message_type: 1, item_list: [{ type: 1, text_item: { text } }] }
  return { ret: 0, errCode: 0, errMsg: '', messages: [msg], buf, longPollingTimeoutMs: 0 }
}

const CONFIRMED: IlinkPollResult = {
  status: 'confirmed',
  credentials: { botToken: 'bt-1', ilinkBotId: 'bot-1', ilinkUserId: 'user-1', baseUrl: '' },
}

/** 等一拍：让通道循环里的 microtask 链跑完（不用真定时器参数）。 */
const flush = async (): Promise<void> => { await new Promise((resolve) => { setImmediate(resolve) }) }

/** 用真实 reply-store 预置一条 run 和两段 outbox。 */
function seedReplyState(dir: string, slot: number): { runId: number, clientIds: string[] } {
  const now = Date.now()
  const run = enqueueOrMergeReplyRun(dir, {
    slot,
    targetMessageId: 900 + slot,
    question: '生命周期清理测试',
    debounceMs: 0,
    now,
  })
  const parts = saveReplyParts(dir, run.id, ['第一段', '第二段'], now + 1)
  return { runId: run.id, clientIds: parts.map(part => part.clientId) }
}

/** 直接数表，确认 run 与 outbox 都没留下孤儿行。 */
function replyStateCounts(dir: string, slot: number): { runs: number, parts: number } {
  return withDb(clawbotDbPath(dir), (db) => {
    const runs = db.prepare('SELECT COUNT(*) AS n FROM clawbot_reply_run WHERE slot = ?').get(slot) as { n?: number } | undefined
    const parts = db.prepare('SELECT COUNT(*) AS n FROM clawbot_reply_outbox WHERE slot = ?').get(slot) as { n?: number } | undefined
    return { runs: Number(runs?.n ?? 0), parts: Number(parts?.n ?? 0) }
  })
}

function bindingCount(dir: string, slot: number): number {
  return withDb(clawbotDbPath(dir), (db) => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding WHERE slot = ?').get(slot) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  })
}

/** 两个 slot 各排一条 durable run；slot 1 开自动回复，slot 2 关闭。 */
function makeDiscardScenario(): {
  r: ReturnType<typeof createClawbotRemotes>
  dir: string
  slot1: number
  slot2: number
  run1: ReturnType<typeof enqueueOrMergeReplyRun>
  run2: ReturnType<typeof enqueueOrMergeReplyRun>
  asks: number[]
  runner: { pending: () => number }
} {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { rc, dir } = makeHarness()
  const asks: number[] = []
  const r = createClawbotRemotes({
    ...rc,
    ask: async (slot) => {
      asks.push(slot)
      return { ok: true, answer: '不应落库' }
    },
  })
  const slot1 = r.createClawbotInstance().slot
  const slot2 = r.createClawbotInstance().slot
  r.setClawbotInstanceConfig({ slot: slot1, autoReply: true, kbEnabled: true, kbId: 1, splitReply: false })
  r.setClawbotInstanceConfig({ slot: slot2, autoReply: false, splitReply: false })
  const now = Date.now()
  const run1 = enqueueOrMergeReplyRun(dir, {
    slot: slot1,
    targetMessageId: 1_101,
    question: 'slot1 排队',
    debounceMs: 0,
    now,
  })
  const run2 = enqueueOrMergeReplyRun(dir, {
    slot: slot2,
    targetMessageId: 1_102,
    question: 'slot2 排队',
    debounceMs: 0,
    now,
  })
  r.ensureClawbotChannel()
  const runner = capturedAutoReplyRunners.at(-1)
  expect(runner).toBeDefined()
  expect(runner?.pending()).toBe(2)
  return { r, dir, slot1, slot2, run1, run2, asks, runner: runner as { pending: () => number } }
}

describe('clawbot remotes（iLink 已接入）', () => {
  it('getClawbotBinding：初始快照是未绑定 + 计数 0 + 通道未运行', () => {
    const { rc } = makeHarness()
    const snap = createClawbotRemotes(rc).getClawbotBinding()
    expect(snap.binding.status).toBe('unbound')
    expect(snap.todayMessages).toBe(0)
    expect(snap.totalMessages).toBe(0)
    expect(snap.channel).toEqual({ running: false, error: null })
    expect(snap.readError).toBeUndefined()
  })

  it('createClawbotBindQr：取码成功 ⇒ 落 binding 态 + 审计 + 事件；取码失败 ⇒ 原样抛且不写审计', async () => {
    const { rc, ops, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const qr = await r.createClawbotBindQr()
    expect(qr.token).toBe('qr-tok-1')
    expect(qr.payload).toContain('qrcode=qr-tok-1')
    expect(qr.state).toBe('wait')
    expect(qr.expiresAt).toBeGreaterThan(Date.now())
    expect(readBindingInternal(dir).binding).toMatchObject({ status: 'binding', qrToken: 'qr-tok-1' })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ category: 'clawbot', action: 'clawbot_bind_qr', status: 'ok' })
    expect(events[0]).toEqual({ name: 'clawbot/binding-changed', args: { from: 'unbound', to: 'binding', wxid: null } })

    // 取码失败（网络/服务端错）：抛给界面，绑定行与审计都不许动。
    const failing = makeHarness()
    const rf = createClawbotRemotes({
      ...failing.rc,
      ilink: { ...failing.rc.ilink, requestBindQr: async () => { throw new Error('取码超时') } },
    })
    await expect(rf.createClawbotBindQr()).rejects.toThrow('取码超时')
    expect(failing.ops).toEqual([])
    expect(readBindingInternal(failing.dir).binding.status).toBe('unbound')
  })

  it('getClawbotBindState：无会话 ⇒ idle；四态随轮询推进；终态不再打上游', async () => {
    const { rc, ilink, events } = makeHarness()
    const r = createClawbotRemotes(rc)
    expect((await r.getClawbotBindState()).state).toBe('idle')

    await r.createClawbotBindQr()
    ilink.pollQueue.push({ status: 'scaned' })
    const scanned = await r.getClawbotBindState()
    expect(scanned.state).toBe('scaned')
    expect(scanned.binding.binding.status).toBe('binding')

    // unknown / error（长轮询超时是常态）保留原状态、不抛。
    ilink.pollQueue.push({ status: 'unknown' })
    expect((await r.getClawbotBindState()).state).toBe('scaned')
    ilink.pollQueue.push({ status: 'error', error: 'HTTP 502' })
    expect((await r.getClawbotBindState()).state).toBe('scaned')

    ilink.pollQueue.push({ status: 'expired' })
    const expired = await r.getClawbotBindState()
    expect(expired.state).toBe('expired')
    // 终态：再调不再打上游（也不该抛「没安排结果」）。
    const callsBefore = ilink.pollCalls.length
    expect((await r.getClawbotBindState()).state).toBe('expired')
    expect(ilink.pollCalls.length).toBe(callsBefore)
    expect(events.filter(e => e.name === 'clawbot/binding-changed')).toHaveLength(1)
  })

  it('confirmed：落身份+凭证、拉起通道、写审计与事件；凭证不进快照/事件', async () => {
    const { rc, ilink, ops, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr()
    ilink.pollQueue.push(CONFIRMED)
    const done = await r.getClawbotBindState()
    expect(done.state).toBe('confirmed')
    expect(done.binding.binding.status).toBe('bound')
    expect(done.binding.binding.wxid).toBe('user-1')
    expect(done.binding.channel.running).toBe(true)

    const internal = readBindingInternal(dir)
    expect(internal.credentials).toEqual({ botToken: 'bt-1', ilinkBotId: 'bot-1', ilinkUserId: 'user-1', baseUrl: '' })
    expect(internal.binding.qrToken).toBeNull()

    const bindOp = ops.find(o => o.action === 'clawbot_bind')
    expect(bindOp).toMatchObject({ category: 'clawbot', status: 'ok', target: 'user-1' })
    expect(events.at(-1)).toEqual({ name: 'clawbot/binding-changed', args: { from: 'binding', to: 'bound', wxid: 'user-1' } })
    // 凭证不许出现在快照与事件里（它们是要跨 IPC 给渲染层的）。
    const wire = JSON.stringify([done, events])
    expect(wire).not.toContain('bt-1')
    expect(wire).not.toContain('bot-1')
  })

  it('在途去重：并发的两次状态调用只打一次上游（共用同一个在途 promise）', async () => {
    const { rc, ilink } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr()
    // 把上游轮询拿住不放：两次调用都该挂在这一条 promise 上。
    let release: (v: IlinkPollResult) => void = () => { /* 占位 */ }
    ilink.pollImpl = () => new Promise<IlinkPollResult>((resolve) => { release = resolve })
    const first = r.getClawbotBindState()
    const second = r.getClawbotBindState()
    release({ status: 'scaned' })
    const [a, b] = await Promise.all([first, second])
    expect(a.state).toBe('scaned')
    expect(b.state).toBe('scaned')
    expect(ilink.pollCalls).toHaveLength(1)
  })

  it('旧扫码轮询晚到：会话已被解绑删除 ⇒ 不再回写凭证或启动通道', async () => {
    const { rc, ilink, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })
    let release: (v: IlinkPollResult) => void = () => { /* 占位 */ }
    ilink.pollImpl = () => new Promise<IlinkPollResult>((resolve) => { release = resolve })

    const pending = r.getClawbotBindState({ slot: 1 })
    r.unbindClawbot({ slot: 1 })
    release(CONFIRMED)
    const late = await pending

    expect(late.state).toBe('idle')
    expect(late.binding.binding.status).toBe('unbound-by-user')
    expect(readBindingInternal(dir, 1).credentials).toBeNull()
    expect(late.binding.channel.running).toBe(false)
  })

  it('取码请求 in-flight 时删除实例：晚到响应不写回、不复活实例', async () => {
    const { rc, ilink, events, ops, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const slot = r.createClawbotInstance().slot
    let releaseQr: (qr: { token: string, payload: string }) => void = () => { /* 占位 */ }
    ilink.requestBindQrImpl = () => new Promise((resolve) => { releaseQr = resolve })

    const pending = r.createClawbotBindQr({ slot })
    await flush()
    expect(ilink.requestBindQrCalls).toBe(1)
    r.deleteClawbotInstance({ slot })
    releaseQr({ token: 'qr-late-delete', payload: 'https://example.invalid/qr-late-delete' })

    await expect(pending).rejects.toThrow('实例已删除或绑定状态已变化')
    expect(bindingCount(dir, slot), '删除后不得被晚到的取码响应复活').toBe(0)
    expect(events.filter(event => event.name === 'clawbot/binding-changed')).toEqual([])
    expect(ops.some(op => op.action === 'clawbot_bind_qr')).toBe(false)
    expect((await r.getClawbotBindState({ slot })).state).toBe('idle')
  })

  it('重生成：新会话替换旧会话，之后轮询的是新 token', async () => {
    const { rc, ilink } = makeHarness()
    const r = createClawbotRemotes(rc)
    const first = await r.createClawbotBindQr()
    const second = await r.createClawbotBindQr()
    expect(second.token).not.toBe(first.token)
    ilink.pollQueue.push({ status: 'wait' })
    await r.getClawbotBindState()
    expect(ilink.pollCalls.at(-1)).toBe(second.token)
  })

  it('并发两次取码：最后发起者胜，先发起者的晚到响应不得覆盖新二维码', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const releases: Array<(qr: { token: string, payload: string }) => void> = []
    ilink.requestBindQrImpl = () => new Promise((resolve) => { releases.push(resolve) })

    const first = r.createClawbotBindQr({ slot: 1 })
    await flush()
    const second = r.createClawbotBindQr({ slot: 1 })
    await flush()
    expect(releases).toHaveLength(2)

    releases[1]?.({ token: 'qr-new', payload: 'https://example.invalid/qr-new' })
    await expect(second).resolves.toMatchObject({ token: 'qr-new' })
    releases[0]?.({ token: 'qr-old', payload: 'https://example.invalid/qr-old' })
    await expect(first).rejects.toThrow('实例已删除或绑定状态已变化')

    expect(readBindingInternal(dir, 1).binding.qrToken).toBe('qr-new')
    expect(events.filter(event => event.name === 'clawbot/binding-changed')).toHaveLength(1)
    ilink.pollQueue.push({ status: 'wait' })
    await r.getClawbotBindState({ slot: 1 })
    expect(ilink.pollCalls.at(-1)).toBe('qr-new')
  })

  it('fresh DB 默认 slot 首次取码可建库；删除实例后同 slot 再取码必须拒绝', async () => {
    const { rc, dir } = makeHarness({ createInstance: false })
    expect(clawbotDbExists(dir)).toBe(false)
    const r = createClawbotRemotes(rc)

    await expect(r.createClawbotBindQr()).resolves.toMatchObject({ token: 'qr-tok-1', state: 'wait' })
    expect(clawbotDbExists(dir)).toBe(true)
    expect(readBindingInternal(dir, 1).binding.qrToken).toBe('qr-tok-1')

    r.deleteClawbotInstance({ slot: 1 })
    await expect(r.createClawbotBindQr({ slot: 1 })).rejects.toThrow('实例已删除或绑定状态已变化')
  })

  it('消息流：通道把一批消息落库并发 {lastId,delta} 事件（不带正文）；解绑保留会话', async () => {
    const { rc, ilink, events, ops } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr()
    // **先装好长轮询的 deferred**（确认后通道立刻拉起并进入第一轮 getUpdates）。
    let release: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { release = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState()
    await flush()

    // 推进一轮长轮询（两条消息一批；带会话令牌与一条带附件的图片 —— 发送与自动取回都要用）。
    release({
      ret: 0, errCode: 0, errMsg: '', buf: 'cursor-1', longPollingTimeoutMs: 0,
      messages: [
        { message_id: 11, message_type: 1, context_token: 'ctx-9', item_list: [{ type: 1, text_item: { text: '机密正文不该进事件' } }] },
        { message_id: 12, message_type: 1, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p-12', aes_key: 'k-12' }, mid_size: 7 } }] },
      ],
    })
    await flush()
    const list = r.listClawbotMessages()
    expect(list.total).toBe(2)
    const msgEvent = events.find(e => e.name === 'clawbot/message')
    expect(msgEvent?.args).toEqual({ lastId: 2, delta: 2, slot: 1 })
    expect(JSON.stringify(events)).not.toContain('机密正文')
    // 游标已持久化（下一轮从 cursor-1 续）；会话令牌也落到绑定行。
    expect(readBindingInternal(rc.dirs().decrypted).syncBuf).toBe('cursor-1')
    expect(readBindingInternal(rc.dirs().decrypted).sendContextToken).toBe('ctx-9')
    // 带附件的消息**自动入队取回**（不需要人点；测试假实现按「未安排」失败，会重试）。
    await flush()
    expect(ilink.mediaCalls, '附件消息落库后要自动排队取回').toContain(2)

    // 解绑：停通道、清凭证、会话保留（D-4）。
    const snap = r.unbindClawbot()
    expect(snap.binding.status).toBe('unbound-by-user')
    expect(snap.channel.running).toBe(false)
    expect(readBindingInternal(rc.dirs().decrypted).credentials).toBeNull()
    expect(r.listClawbotMessages().total).toBe(2)
    expect(events.at(-1)).toEqual({ name: 'clawbot/binding-changed', args: { from: 'bound', to: 'unbound-by-user', wxid: 'user-1' } })
    // 解绑必须留一行审计（绑定/解绑作对可查；M456 的判据）。
    const unbindOp = ops.find(o => o.action === 'clawbot_unbind')
    expect(unbindOp, '解绑必须留一行审计').toMatchObject({ category: 'clawbot', status: 'ok', target: 'user-1' })
  })

  it('重放消息全被墓碑拦截时不覆盖当前发送令牌；只有新增入站消息才刷新令牌', () => {
    const { rc, dir } = makeHarness()
    createClawbotRemotes(rc)
    saveSendContextToken(dir, 'ctx-current', 1)
    suppressClawbotMessageIds(dir, 1, [501], 100)

    const replayed = insertClawbotMessages(dir, 1, [{
      message_id: 501,
      message_type: 1,
      context_token: 'ctx-stale',
      item_list: [{ type: 1, text_item: { text: '被墓碑拦下的旧消息' } }],
    }])
    expect(replayed).toBeNull()
    expect(readBindingInternal(dir, 1).sendContextToken, '旧帧不能覆盖当前上下文').toBe('ctx-current')

    const mixed = insertClawbotMessages(dir, 1, [
      {
        message_id: 501,
        message_type: 1,
        context_token: 'ctx-stale-again',
        item_list: [{ type: 1, text_item: { text: '旧消息' } }],
      },
      {
        message_id: 502,
        message_type: 1,
        context_token: 'ctx-new',
        item_list: [{ type: 1, text_item: { text: '新消息' } }],
      },
    ])
    expect(mixed?.delta).toBe(1)
    expect(readBindingInternal(dir, 1).sendContextToken, '只取真正新增入站消息的令牌').toBe('ctx-new')
  })

  it('清空并重启通道后：墓碑和裁剪后的水位都阻止旧消息复活、也不覆盖当前令牌', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const first = createClawbotRemotes(rc)
    await first.createClawbotBindQr({ slot: 1 })

    const pending: Array<{ buf: string, resolve: (u: IlinkUpdates) => void }> = []
    ilink.updatesImpl = (buf) => new Promise<IlinkUpdates>((resolve) => { pending.push({ buf, resolve }) })
    ilink.pollQueue.push(CONFIRMED)
    await first.getClawbotBindState({ slot: 1 })
    await flush()
    expect(pending).toHaveLength(1)

    const initial = textBatch(7301, '清空前的旧消息', 'cursor-before-clear')
    initial.messages[0]!.context_token = 'ctx-before-clear'
    pending[0]?.resolve(initial)
    await flush()
    expect(first.listClawbotMessages({ slot: 1 }).total).toBe(1)
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(1)

    first.clearClawbotMessages({ slot: 1 })
    saveSendContextToken(dir, 'ctx-current', 1)
    expect(readBindingInternal(dir, 1).clearWatermark).toBe(7301)

    const second = createClawbotRemotes(rc)
    second.ensureClawbotChannel()
    await flush()
    expect(pending, '重启后的通道应拿到新的 getUpdates 槽位').toHaveLength(3)

    const tombstoneReplay = textBatch(7301, '清空前的旧消息', '')
    tombstoneReplay.messages[0]!.context_token = 'ctx-stale-tombstone'
    pending[2]?.resolve(tombstoneReplay)
    await flush()
    expect(second.listClawbotMessages({ slot: 1 }).total, '墓碑必须拦截旧消息').toBe(0)
    expect(readBindingInternal(dir, 1).sendContextToken, '旧帧不得覆盖当前令牌').toBe('ctx-current')

    const { sessionEpoch } = readBindingInternal(dir, 1)
    withWritableDb(clawbotDbPath(dir), (db) => {
      db.prepare('DELETE FROM clawbot_message_tombstone WHERE slot = ? AND session_epoch = ? AND msg_id = ?')
        .run(1, sessionEpoch, 7301)
    })
    expect(pending, '第一次重放后循环应继续等待下一批').toHaveLength(4)

    const watermarkReplay = textBatch(7301, '墓碑裁剪后的旧消息重放', '')
    watermarkReplay.messages[0]!.context_token = 'ctx-stale-watermark'
    pending[3]?.resolve(watermarkReplay)
    await flush()

    expect(second.listClawbotMessages({ slot: 1 }).total, '墓碑裁剪后仍要由水位拦截').toBe(0)
    expect(readBindingInternal(dir, 1).sendContextToken, '仅水位拦截时也不能覆盖令牌').toBe('ctx-current')
    expect(events.filter(event => event.name === 'clawbot/message'), '两次重放都不得发消息事件').toHaveLength(1)
  })

  it('清空与在途 getUpdates 竞态：同一响应 [旧,新] 只落新、只 consider 新并发一次事件', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    r.setClawbotInstanceConfig({ slot: 1, autoReply: true, kbEnabled: true, kbId: 1, splitReply: false })
    await r.createClawbotBindQr({ slot: 1 })

    const pending: Array<{ buf: string, resolve: (u: IlinkUpdates) => void }> = []
    ilink.updatesImpl = (buf) => new Promise<IlinkUpdates>((resolve) => { pending.push({ buf, resolve }) })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    expect(pending).toHaveLength(1)

    insertClawbotMessage(dir, {
      slot: 1,
      ts: Date.now(),
      direction: 'in',
      content: '清空前的旧消息',
      msgId: 7001,
    })
    r.clearClawbotMessages({ slot: 1 })
    const mixed = textBatch(7001, '清空前的旧消息', 'cursor-stale-clear')
    mixed.messages.push({
      message_id: 7002,
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: '清空后的新消息' } }],
    })
    pending[0]?.resolve(mixed)
    await flush()

    expect(r.listClawbotMessages({ slot: 1 }).items.map(message => message.content)).toEqual(['清空后的新消息'])
    expect(listRecoverableReplyRuns(dir, Date.now() + 2_000, 20), '只允许 clear 后的新消息触发自动回复').toHaveLength(1)
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(1)
    expect(readBindingInternal(dir, 1).syncBuf, '成功处理混合批次后推进游标').toBe('cursor-stale-clear')
    expect(r.getClawbotBinding({ slot: 1 }).channel.running).toBe(true)

    expect(pending).toHaveLength(2)
    pending[1]?.resolve(textBatch(7003, '后续新消息', 'cursor-after-clear'))
    await flush()

    expect(r.listClawbotMessages({ slot: 1 }).items.map(message => message.content)).toEqual(['后续新消息', '清空后的新消息'])
    expect(readBindingInternal(dir, 1).syncBuf).toBe('cursor-after-clear')
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(2)
  })

  it('解绑与在途 getUpdates 竞态：旧批次不污染会话；重新绑定后的新批次正常落库', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })

    const pending: Array<{ buf: string, resolve: (u: IlinkUpdates) => void }> = []
    ilink.updatesImpl = (buf) => new Promise<IlinkUpdates>((resolve) => { pending.push({ buf, resolve }) })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    expect(pending).toHaveLength(1)

    r.unbindClawbot({ slot: 1 })
    pending[0]?.resolve(textBatch(7101, '解绑前的旧消息', 'cursor-stale-unbind'))
    await flush()

    expect(r.listClawbotMessages({ slot: 1 }).total).toBe(0)
    expect(events.filter(event => event.name === 'clawbot/message')).toEqual([])
    expect(readBindingInternal(dir, 1).syncBuf, '解绑后旧游标不得写回').toBe('')
    expect(r.getClawbotBinding({ slot: 1 }).channel.running).toBe(false)

    await r.createClawbotBindQr({ slot: 1 })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    expect(pending).toHaveLength(2)

    pending[1]?.resolve(textBatch(7102, '重新绑定后的新消息', 'cursor-after-rebind'))
    await flush()

    expect(r.listClawbotMessages({ slot: 1 }).items.map(message => message.content)).toEqual(['重新绑定后的新消息'])
    expect(readBindingInternal(dir, 1).syncBuf).toBe('cursor-after-rebind')
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(1)
  })

  it('删除实例与在途 getUpdates 竞态：晚到旧批次不复活实例、不落库、不发事件', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })

    let release: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { release = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()

    r.deleteClawbotInstance({ slot: 1 })
    release(textBatch(7201, '删除前的旧消息', 'cursor-stale-delete'))
    await flush()

    expect(bindingCount(dir, 1), '晚到响应不得复活实例').toBe(0)
    expect(r.listClawbotMessages({ slot: 1 }).total).toBe(0)
    expect(events.filter(event => event.name === 'clawbot/message')).toEqual([])
  })

  it('可发可收：发送成功才落 out 行 + 事件；令牌来自最近入站消息', async () => {
    const { rc, ilink, events } = makeHarness()
    const r = createClawbotRemotes(rc)
    // 未绑定 ⇒ 拦在前头，不打上游。
    expect((await r.sendClawbotMessage({ text: '在吗' })).error).toContain('尚未绑定')
    expect(ilink.sendCalls).toHaveLength(0)

    await r.createClawbotBindQr()
    // **先装好**长轮询 deferred（确认后通道立刻拉起并进入第一轮 getUpdates）。
    let release: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { release = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState()
    await flush()

    // 已绑定但还没收到过消息 ⇒ 没有会话令牌，同样不打上游（错误文案要给出下一步）。
    const noCtx = await r.sendClawbotMessage({ text: '在吗' })
    expect(noCtx.ok).toBe(false)
    expect(noCtx.error, '没令牌时要指向「先在微信里发一条」而不是含糊报错').toContain('先在微信里给它发一条消息')
    expect(ilink.sendCalls).toHaveLength(0)

    // 收到一条带令牌的消息（通道刷新令牌）。
    release({ ret: 0, errCode: 0, errMsg: '', buf: 'c1', longPollingTimeoutMs: 0, messages: [{ message_id: 21, message_type: 1, context_token: 'ctx-21', item_list: [{ type: 1, text_item: { text: '帮我看下' } }] }] })
    await flush()

    // 发送成功：上游拿到的 to=微信用户、正文原文、令牌 ctx-21；行落 out、事件带 id。
    const ok = await r.sendClawbotMessage({ text: '好的，收到' })
    expect(ok).toEqual({ ok: true, id: 2 })
    expect(ilink.sendCalls).toHaveLength(1)
    expect(ilink.sendCalls[0]).toMatchObject({ toUserId: 'user-1', text: '好的，收到', contextToken: 'ctx-21' })
    expect(ilink.sendCalls[0]?.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const rows = r.listClawbotMessages().items
    expect(rows[0]).toMatchObject({ direction: 'out', content: '好的，收到', msgType: 'text' })
    expect(events.at(-1)).toEqual({ name: 'clawbot/message', args: { lastId: 2, delta: 1, slot: 1 } })

    // 服务端拒绝（ret!=0）：不落库、不发事件。
    ilink.sendQueue.push({ ret: 5, errMsg: 'too fast' })
    const rejected = await r.sendClawbotMessage({ text: '这条会被拒' })
    expect(rejected.ok).toBe(false)
    expect(rejected.error, '拒绝文案要带 ret 与 errmsg').toMatch(/ret=5.*too fast/)
    expect(r.listClawbotMessages().total).toBe(2)

    // 网络抛错：同样不落库；空白文本在更前面就被拦下。
    ilink.sendQueue.push(new Error('ECONNRESET'))
    const failed = await r.sendClawbotMessage({ text: '网络断了' })
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('发送失败：')
    expect(r.listClawbotMessages().total).toBe(2)
    expect((await r.sendClawbotMessage({ text: '   ' })).error).toBe('消息内容为空')
  })

  it('发送 in-flight 时清空会话：上游成功但不回填 out 行、不发 message 事件', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })
    let releaseUpdates: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { releaseUpdates = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    releaseUpdates({
      ret: 0,
      errCode: 0,
      errMsg: '',
      buf: 'cursor-clear-inflight',
      longPollingTimeoutMs: 0,
      messages: [{
        message_id: 601,
        message_type: 1,
        context_token: 'ctx-clear-inflight',
        item_list: [{ type: 1, text_item: { text: '先建立会话' } }],
      }],
    })
    await flush()

    let releaseSend: (result: IlinkSendResult) => void = () => { /* 占位 */ }
    ilink.sendImpl = () => new Promise<IlinkSendResult>((resolve) => { releaseSend = resolve })
    const sending = r.sendClawbotMessage({ text: '清空前的发送', slot: 1 })
    await flush()
    expect(ilink.sendCalls).toHaveLength(1)
    const eventsBeforeClear = events.filter(event => event.name === 'clawbot/message').length

    r.clearClawbotMessages({ slot: 1 })
    releaseSend({ ret: 0, errMsg: '' })
    const result = await sending

    expect(result).toMatchObject({
      ok: false,
      error: '上游已接收，但本地会话已清理/实例已变化，未回填',
    })
    expect(bindingCount(dir, 1)).toBe(1)
    expect(r.listClawbotMessages({ slot: 1 }).total).toBe(0)
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(eventsBeforeClear)
    expect(ilink.sendCalls).toHaveLength(1)
  })

  it('发送 in-flight 时重新取码：扫码代次不影响回填，仍只落一条 out 且只发一次事件', async () => {
    const { rc, ilink, events } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })
    let releaseUpdates: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { releaseUpdates = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    releaseUpdates({
      ret: 0,
      errCode: 0,
      errMsg: '',
      buf: 'cursor-regenerate-inflight',
      longPollingTimeoutMs: 0,
      messages: [{
        message_id: 603,
        message_type: 1,
        context_token: 'ctx-regenerate-inflight',
        item_list: [{ type: 1, text_item: { text: '先建立会话' } }],
      }],
    })
    await flush()

    const messageEventsBefore = events.filter(event => event.name === 'clawbot/message').length
    let releaseSend: (result: IlinkSendResult) => void = () => { /* 占位 */ }
    ilink.sendImpl = () => new Promise<IlinkSendResult>((resolve) => { releaseSend = resolve })
    const sending = r.sendClawbotMessage({ text: '取码期间发送', slot: 1 })
    await flush()
    expect(ilink.sendCalls).toHaveLength(1)

    await expect(r.createClawbotBindQr({ slot: 1 })).resolves.toMatchObject({ token: 'qr-tok-2' })
    releaseSend({ ret: 0, errMsg: '' })
    const result = await sending

    expect(result.ok).toBe(true)
    expect(r.listClawbotMessages({ slot: 1 }).items.filter(message => message.direction === 'out')).toHaveLength(1)
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(messageEventsBefore + 1)
    expect(ilink.sendCalls).toHaveLength(1)
  })

  it('发送 in-flight 时完成同 slot 重绑：旧会话结果不得写进新绑定', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })
    let releaseUpdates: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { releaseUpdates = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    releaseUpdates({
      ret: 0,
      errCode: 0,
      errMsg: '',
      buf: 'cursor-before-rebind',
      longPollingTimeoutMs: 0,
      messages: [{
        message_id: 604,
        message_type: 1,
        context_token: 'ctx-before-rebind',
        item_list: [{ type: 1, text_item: { text: '先建立会话' } }],
      }],
    })
    await flush()

    const eventsBefore = events.filter(event => event.name === 'clawbot/message').length
    let releaseSend: (result: IlinkSendResult) => void = () => { /* 占位 */ }
    ilink.sendImpl = () => new Promise<IlinkSendResult>((resolve) => { releaseSend = resolve })
    const sending = r.sendClawbotMessage({ text: '旧绑定发送', slot: 1 })
    await flush()
    expect(ilink.sendCalls).toHaveLength(1)

    await r.createClawbotBindQr({ slot: 1 })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    releaseSend({ ret: 0, errMsg: '' })
    const result = await sending

    expect(result.ok).toBe(false)
    expect(r.listClawbotMessages({ slot: 1 }).items.filter(message => message.direction === 'out')).toEqual([])
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(eventsBefore)
    expect(readBindingInternal(dir, 1).sessionEpoch).toBe(2)
  })

  it('上游成功后本地回填失败：返回可读错误、不向 RPC 抛异常、不重复出网', async () => {
    const { rc, ilink, events, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr({ slot: 1 })
    let releaseUpdates: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { releaseUpdates = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot: 1 })
    await flush()
    releaseUpdates({
      ret: 0,
      errCode: 0,
      errMsg: '',
      buf: 'cursor-backfill-fail',
      longPollingTimeoutMs: 0,
      messages: [{
        message_id: 602,
        message_type: 1,
        context_token: 'ctx-backfill-fail',
        item_list: [{ type: 1, text_item: { text: '先建立会话' } }],
      }],
    })
    await flush()
    const eventsBeforeSend = events.filter(event => event.name === 'clawbot/message').length
    withWritableDb(clawbotDbPath(dir), (db) => {
      db.exec(`CREATE TRIGGER fail_outbound_backfill BEFORE INSERT ON clawbot_message
        WHEN NEW.direction = 'out'
        BEGIN SELECT RAISE(FAIL, 'simulated backfill failure'); END`)
    })

    const result = await r.sendClawbotMessage({ text: '会回填失败', slot: 1 })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('上游已接收、本地状态未知/回填失败')
    expect(result.error).toContain('simulated backfill failure')
    expect(ilink.sendCalls, '回填失败不得触发第二次上游发送').toHaveLength(1)
    expect(r.listClawbotMessages({ slot: 1 }).items.filter(message => message.direction === 'out')).toEqual([])
    expect(events.filter(event => event.name === 'clawbot/message')).toHaveLength(eventsBeforeSend)
  })

  it('取媒体：图片给内联 dataUrl、其余给本机路径；超大图不给 dataUrl；错误原样透传', async () => {
    const { rc, ilink, dir } = makeHarness()
    const r = createClawbotRemotes(rc)

    // 非法 id：在依赖之前拦下（不打上游、不打库）。
    const bad = await r.getClawbotMedia({ id: 0 })
    expect(bad).toEqual({ ok: false, error: '无效的消息 id' })
    expect(ilink.mediaCalls).toHaveLength(0)

    // 图片（未超内联上限）：dataUrl 用缓存文件字节按魔数标 MIME；path 也给（可外部打开）。
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('img')])
    const pngPath = join(dir, 'x.png')
    writeFileSync(pngPath, png)
    ilink.mediaImpl = async () => ({ ok: true, path: pngPath, kind: 'image', name: null, bytes: png.byteLength })
    const img = await r.getClawbotMedia({ id: 7 })
    expect(img.ok).toBe(true)
    expect(img.dataUrl).toBe('data:image/png;base64,' + png.toString('base64'))
    expect(ilink.mediaCalls).toEqual([7])

    // 文件：只给路径（界面走 openPath），不给 dataUrl。
    ilink.mediaImpl = async () => ({ ok: true, path: join(dir, 'x.xlsx'), kind: 'file', name: '报表.xlsx', bytes: 10 })
    const file = await r.getClawbotMedia({ id: 8 })
    expect(file.path?.endsWith('x.xlsx')).toBe(true)
    expect(file.dataUrl).toBeUndefined()

    // 图片但超过内联上限：只给路径（防大 base64 过 IPC）。
    ilink.mediaImpl = async () => ({ ok: true, path: pngPath, kind: 'image', name: null, bytes: CLAWBOT_INLINE_MAX_BYTES + 1 })
    const big = await r.getClawbotMedia({ id: 9 })
    expect(big.dataUrl).toBeUndefined()
    expect(big.path).toBe(pngPath)

    // 失败原因原样透传（主机白名单 / 超限 / 解密等由媒体层给可读中文）。
    ilink.mediaImpl = async () => ({ ok: false, error: '附件地址的主机不在白名单内（evil.example.com），拒绝下载' })
    const denied = await r.getClawbotMedia({ id: 10 })
    expect(denied).toEqual({ ok: false, error: '附件地址的主机不在白名单内（evil.example.com），拒绝下载' })
  })

  it('会话过期（errcode -14、游标已空）：停通道、写终态审计、环境自检显示错误', async () => {
    const { rc, ilink, ops } = makeHarness()
    const r = createClawbotRemotes(rc)
    await r.createClawbotBindQr()
    // **先装好**「会话过期」的长轮询（确认后通道第一轮就会拿到它；游标为空 ⇒ 终态）。
    ilink.updatesImpl = async () => ({ ret: 0, errCode: -14, errMsg: 'session expired', messages: [], buf: '', longPollingTimeoutMs: 0 })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState()
    await flush()
    await flush()

    const env = r.checkClawbotEnv().items
    expect(env[1]?.key).toBe('channel')
    expect(env[1]?.state).toBe('error')
    expect(env[1]?.detail).toContain('重新扫码绑定')
    const errOp = ops.find(o => o.action === 'clawbot_channel_error')
    expect(errOp).toMatchObject({ category: 'clawbot', status: 'fail' })
    // 通道停了：快照如实。
    expect(r.getClawbotBinding().channel.running).toBe(false)
  })

  it('checkClawbotEnv：三项；未绑定 = 通道 ok；绑定后随运行态变色', async () => {
    const { rc, ilink } = makeHarness()
    const r = createClawbotRemotes(rc)
    const before = r.checkClawbotEnv().items
    expect(before.map(i => i.key)).toEqual(['app', 'channel', 'binding'])
    expect(before[0]?.state).toBe('ok')
    expect(before[1]?.state).toBe('ok')
    expect(before[1]?.detail).toContain('未绑定')
    expect(before[2]?.state).toBe('warn')

    await r.createClawbotBindQr()
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState()
    const after = r.checkClawbotEnv().items
    expect(after[1]?.state).toBe('ok')
    expect(after[1]?.detail).toContain('接收中')
    expect(after[2]?.state).toBe('ok')
    expect(after[2]?.detail).toBe('已绑定')
  })

  it('ensureClawbotChannel（启动钩子）：未绑定/无凭证不动手；已绑定 + 凭证 ⇒ 拉起并补扫附件', async () => {
    const unbound = makeHarness()
    const r1 = createClawbotRemotes(unbound.rc)
    r1.ensureClawbotChannel()
    expect(r1.getClawbotBinding().channel.running).toBe(false)

    const { rc, ilink } = makeHarness()
    const r2 = createClawbotRemotes(rc)
    await r2.createClawbotBindQr()
    ilink.pollQueue.push(CONFIRMED)
    await r2.getClawbotBindState()
    // 模拟「进程重启」：新工厂、同一个数据根（凭证在库里），并安排一条待补扫的附件行。
    ilink.mediaPending = [41]
    const r3 = createClawbotRemotes(rc)
    expect(r3.getClawbotBinding().channel.running).toBe(false)
    r3.ensureClawbotChannel()
    expect(r3.getClawbotBinding().channel.running).toBe(true)
    // 启动补扫把待取附件入队（上次运行没取完的在这里补齐）。
    await flush()
    expect(ilink.mediaCalls, '启动补扫要把待取附件拉起来').toContain(41)
  })

  it('事件出口抛错不影响业务（emit 尽力而为）', async () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes({ ...rc, emit: () => { throw new Error('no window') } })
    const snap = r.bindClawbotWechat({ wxid: 'wxid_a' })
    expect(snap.binding.status).toBe('bound')
    expect(readBindingInternal(dir).binding.status).toBe('bound')
  })

  it('解绑调用 autoReply.discard：目标 slot 的排队 run 不再执行，其他 slot 不受影响', async () => {
    const { r, dir, slot1, slot2, run1, run2, asks, runner } = makeDiscardScenario()

    r.unbindClawbot({ slot: slot1 })

    expect(runner.pending(), '只清理目标 slot 的排队任务').toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    await flush()
    expect(asks).not.toContain(slot1)
    expect(asks).not.toContain(slot2)
    expect(readReplyRun(dir, run1.id)).toBeNull()
    expect(readReplyRun(dir, run2.id)?.run.status).toBe('skipped')
  })

  it('清空会话调用 autoReply.discard：目标 slot 的排队 run 不再执行，其他 slot 不受影响', async () => {
    const { r, dir, slot1, slot2, run1, run2, asks, runner } = makeDiscardScenario()

    r.clearClawbotMessages({ slot: slot1 })

    expect(runner.pending(), '只清理目标 slot 的排队任务').toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    await flush()
    expect(asks).not.toContain(slot1)
    expect(asks).not.toContain(slot2)
    expect(readReplyRun(dir, run1.id)).toBeNull()
    expect(readReplyRun(dir, run2.id)?.run.status).toBe('skipped')
  })

  it('删除实例调用 autoReply.discard：目标 slot 的排队 run 不再执行，其他 slot 不受影响', async () => {
    const { r, dir, slot1, slot2, run1, run2, asks, runner } = makeDiscardScenario()

    r.deleteClawbotInstance({ slot: slot1 })

    expect(runner.pending(), '只清理目标 slot 的排队任务').toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    await flush()
    expect(asks).not.toContain(slot1)
    expect(asks).not.toContain(slot2)
    expect(readReplyRun(dir, run1.id)).toBeNull()
    expect(readReplyRun(dir, run2.id)?.run.status).toBe('skipped')
  })

  it('生命周期清理：解绑删除该实例的 reply run/outbox，保留接入会话', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const slot = 1
    const seeded = seedReplyState(dir, slot)
    expect(seeded.clientIds.every(Boolean)).toBe(true)
    expect(replyStateCounts(dir, slot)).toEqual({ runs: 1, parts: 2 })

    r.unbindClawbot({ slot })

    expect(replyStateCounts(dir, slot), '解绑后 run 与 outbox 都必须是空的').toEqual({ runs: 0, parts: 0 })
  })

  it('生命周期清理：清空会话删除该实例的 reply run/outbox', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const slot = 1
    seedReplyState(dir, slot)

    r.clearClawbotMessages({ slot })

    expect(replyStateCounts(dir, slot), '清空会话后 run 与 outbox 都必须是空的').toEqual({ runs: 0, parts: 0 })
  })

  it('生命周期清理：删除实例删除该实例的 reply run/outbox', () => {
    const { rc, dir } = makeHarness()
    const r = createClawbotRemotes(rc)
    const slot = r.createClawbotInstance().slot
    seedReplyState(dir, slot)
    expect(replyStateCounts(dir, slot)).toEqual({ runs: 1, parts: 2 })

    r.deleteClawbotInstance({ slot })

    expect(replyStateCounts(dir, slot), '删除实例后 run 与 outbox 都必须是空的').toEqual({ runs: 0, parts: 0 })
  })

  it('历史矛盾配置（autoReply=true 但无有效知识库）不再创建 durable run', async () => {
    const { rc, ilink, dir } = makeHarness()
    const slot = 1
    let asks = 0
    const r = createClawbotRemotes({
      ...rc,
      ask: async () => {
        asks += 1
        return { ok: true, answer: '不应生成' }
      },
    })
    // 模拟升级前遗留的矛盾行：旧版本只校验 autoReply，本次保存不会把它留到运行期。
    const now = Date.now()
    withWritableDb(clawbotDbPath(dir), (db) => {
      db.prepare(`INSERT INTO clawbot_instance_config(
        slot, auto_reply, kb_enabled, kb_id, system_prompt, split_reply, created_at, updated_at
      ) VALUES (?, 1, 0, NULL, '', 1, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET auto_reply = 1, kb_enabled = 0, kb_id = NULL,
        updated_at = excluded.updated_at`).run(slot, now, now)
    })

    await r.createClawbotBindQr({ slot })
    let release: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { release = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot })
    await flush()

    release(textBatch(5801, '无库不该排队', 'cursor-no-kb'))
    await flush()

    expect(r.listClawbotMessages({ slot }).items.map(message => message.content)).toEqual(['无库不该排队'])
    expect(replyStateCounts(dir, slot), '无有效知识库时不应留下一个永远不处理的 reply run')
      .toEqual({ runs: 0, parts: 0 })
    expect(asks, '无有效知识库时必须在进入模型前停下').toBe(0)
  })

  it('自动回复端到端：入站文本走 durable run/outbox，分段发送复用 outbox clientId，最终 run done', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { rc, ilink, dir } = makeHarness()
    const slot = 1
    const asks: Array<{ slot: number, text: string, kbId: number | null }> = []
    const r = createClawbotRemotes({
      ...rc,
      ask: async (askedSlot, text, kbId) => {
        asks.push({ slot: askedSlot, text, kbId })
        return {
          ok: true,
          answer: '第一段：明早九点出发去机场。\n\n第二段：到了之后我把车牌发给你。',
        }
      },
    })

    r.setClawbotInstanceConfig({ slot, autoReply: true, kbEnabled: true, kbId: 7, splitReply: true })
    await r.createClawbotBindQr({ slot })
    let release: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { release = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot })
    await flush()

    release({
      ret: 0,
      errCode: 0,
      errMsg: '',
      buf: 'cursor-auto-reply',
      longPollingTimeoutMs: 0,
      messages: [{
        message_id: 501,
        message_type: 1,
        context_token: 'ctx-auto-reply',
        item_list: [{ type: 1, text_item: { text: '明天几点走？' } }],
      }],
    })
    await flush()

    const pending = listRecoverableReplyRuns(dir, Date.now())
    expect(pending, '入站文本应先落一条 durable run').toHaveLength(1)
    const runId = pending[0]?.id ?? 0
    expect(readReplyRun(dir, runId)?.parts, '模型生成前还没有 outbox').toEqual([])

    await vi.advanceTimersByTimeAsync(1_100)
    await flush()

    expect(asks).toEqual([{ slot, text: '明天几点走？', kbId: 7 }])
    expect(ilink.sendCalls.map(call => call.text)).toEqual([
      '第一段：明早九点出发去机场。',
      '第二段：到了之后我把车牌发给你。',
    ])
    expect(ilink.sendCalls.every(call => call.clientId.trim() !== '')).toBe(true)

    const finished = readReplyRun(dir, runId)
    expect(finished?.run.status).toBe('done')
    expect(finished?.parts.map(part => part.status)).toEqual(['sent', 'sent'])
    expect(ilink.sendCalls.map(call => call.clientId)).toEqual(finished?.parts.map(part => part.clientId))
    const details = r.listClawbotMessages({ slot }).items
    const inbound = details.find(message => message.direction === 'in')
    const outbound = details.filter(message => message.direction === 'out')
    expect(inbound?.run).toMatchObject({ runId, status: 'done' })
    expect(outbound).toHaveLength(2)
    expect(outbound.every(message => message.run?.runId === runId), '同一 run 的出站分段都要带上摘要').toBe(true)
    expect(outbound.every(message => message.run?.sendDecision?.send === true)).toBe(true)
    expect(r.checkClawbotEnv({ slot }).autoReplyStats).toMatchObject({
      pending: 0,
      inFlight: false,
      stage: 'idle',
      generationSucceeded: 1,
      generationFailed: 0,
      sendSucceeded: 2,
      sendFailedPermanently: 0,
      lastError: null,
    })
  })

  it('durable 重试：本地已有同 clientId 消息 ⇒ 不再请求 iLink，只补记 outbox sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { rc, ilink, dir } = makeHarness()
    const slot = 1
    const r = createClawbotRemotes(rc)
    r.setClawbotInstanceConfig({ slot, autoReply: true, kbEnabled: true, kbId: 1, splitReply: false })
    await r.createClawbotBindQr({ slot })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot })
    await flush()

    const now = Date.now()
    const run = enqueueOrMergeReplyRun(dir, {
      slot,
      targetMessageId: 801,
      question: '本地已回填',
      debounceMs: 0,
      now,
    })
    const [part] = saveReplyParts(dir, run.id, ['只应补记，不应重发'], now)
    const localId = insertClawbotMessage(dir, {
      slot,
      ts: now,
      direction: 'out',
      msgType: 'text',
      content: part?.text ?? '',
      clientId: part?.clientId ?? '',
    })
    expect(localId).not.toBeNull()

    r.ensureClawbotChannel()
    await vi.advanceTimersByTimeAsync(1)
    await flush()

    const finished = readReplyRun(dir, run.id)
    expect(finished?.run.status).toBe('done')
    expect(finished?.parts[0]).toMatchObject({ status: 'sent', sentMessageId: localId })
    expect(ilink.sendCalls, '本地已证明发送成功时不得再出网').toHaveLength(0)
  })

  it('生成失败时详情随目标消息返回，保留工具/证据与拒绝发送原因', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { rc, ilink } = makeHarness()
    const slot = 1
    const r = createClawbotRemotes({
      ...rc,
      ask: async () => ({
        ok: false,
        answer: '',
        error: '上游超时',
        errorCode: 'timeout',
        status: 'failed',
        toolCalls: [{
          index: 0, round: 1, callId: 'call-1', name: 'search_kb',
          argumentsSummary: 'query=报价', ok: false, deduplicated: false,
          attempts: 1, retries: 0, elapsedMs: 20, errorClass: 'timeout',
          errorCode: 'timeout', hits: 0, facts: 0,
        }],
        sendDecision: { send: false, error: '自动回复未发送：上游超时', errorCode: 'timeout' },
      }),
    })
    r.setClawbotInstanceConfig({ slot, autoReply: true, kbEnabled: true, kbId: 7, splitReply: false })
    await r.createClawbotBindQr({ slot })
    let release: (u: IlinkUpdates) => void = () => { /* 占位 */ }
    ilink.updatesImpl = () => new Promise<IlinkUpdates>((resolve) => { release = resolve })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot })
    await flush()

    release(textBatch(601, '帮我查报价', 'cursor-failed-detail'))
    await flush()
    // 默认最多 3 次生成尝试、退避 3s/6s；分段推进并让出事件循环，
    // 否则重试定时器会在全局 drain 未退出时触发，被单飞闸吞掉。
    await vi.advanceTimersByTimeAsync(1_100)
    await flush()
    await vi.advanceTimersByTimeAsync(3_100)
    await flush()
    await vi.advanceTimersByTimeAsync(6_100)
    await flush()

    const inbound = r.listClawbotMessages({ slot }).items.find(message => message.direction === 'in')
    expect(inbound?.run).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
      error: '上游超时',
      answerStatus: 'failed',
      sendDecision: { send: false, errorCode: 'timeout' },
    })
    expect(inbound?.run?.toolCalls).toHaveLength(1)
    expect(ilink.sendCalls, '生成失败不得出网').toHaveLength(0)
  })

  it('配置在 outbox 生成后被关闭：run 落 skipped，仍保留不可发送原因与已生成摘要', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { rc, ilink, dir } = makeHarness()
    const slot = 1
    const r = createClawbotRemotes({
      ...rc,
      ask: async () => ({ ok: true, answer: '预生成回复', status: 'ok' }),
    })
    r.setClawbotInstanceConfig({ slot, autoReply: true, kbEnabled: true, kbId: 7, splitReply: false })
    await r.createClawbotBindQr({ slot })
    ilink.pollQueue.push(CONFIRMED)
    await r.getClawbotBindState({ slot })
    await flush()

    const now = Date.now()
    const run = enqueueOrMergeReplyRun(dir, {
      slot,
      targetMessageId: 701,
      question: '关闭后不要发',
      debounceMs: 0,
      now,
    })
    saveReplyParts(dir, run.id, ['已生成待发送'], now)
    r.setClawbotInstanceConfig({ slot, autoReply: false })
    r.ensureClawbotChannel()
    await vi.advanceTimersByTimeAsync(10)
    await flush()

    const finished = readReplyRun(dir, run.id)
    expect(finished?.run.status).toBe('skipped')
    expect(finished?.parts[0]?.status, '配置关闭不得把已生成内容发出去').toBe('pending')
    expect(finished?.run.lastError).toContain('未开启自动回复')
    expect(ilink.sendCalls).toHaveLength(0)
  })
})
