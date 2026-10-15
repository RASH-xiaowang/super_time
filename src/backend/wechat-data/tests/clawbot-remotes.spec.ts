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
import { afterEach, describe, expect, it } from 'vitest'
import { createClawbotRemotes, CLAWBOT_INLINE_MAX_BYTES, type ClawbotEmitEvent } from '../src/remotes/clawbot.ts'
import { readBindingInternal } from '../src/query/clawbot/clawbot-binding.ts'
import type { ClawbotMediaOutcome } from '../src/query/clawbot/clawbot-media.ts'
import type { IlinkCredentials, IlinkOutgoingText, IlinkPollResult, IlinkSendResult, IlinkUpdates, WeixinMessage } from '../src/query/clawbot/clawbot-ilink.ts'
import type { OperationCategory, OperationStatus } from '../src/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

interface OpRecord { category: OperationCategory, action: string, status: OperationStatus, target: string, detail: string }

/** 假 iLink 的可编程切面（全部同步可控，不碰网络）。 */
interface FakeIlink {
  /** 取码：每次返回不同的 token/payload（重生成场景要能看出换了一轮）。 */
  requestBindQrCalls: number
  /** 状态轮询的结果队列（空了 ⇒ 抛错提示测试没安排好）。 */
  pollQueue: IlinkPollResult[]
  /** 状态轮询的完全接管（在途去重场景要拿住 promise 不放）。 */
  pollImpl: ((token: string) => Promise<IlinkPollResult>) | null
  pollCalls: string[]
  /** 消息长轮询实现（缺省返回一个永不落定的 promise —— 循环挂起、不空转）。 */
  updatesImpl: (buf: string) => Promise<IlinkUpdates>
  /** 发送：按队列消费（空了 = 成功空响应）；项可以是 Error 模拟网络抛错。 */
  sendQueue: Array<IlinkSendResult | Error>
  sendCalls: Array<{ toUserId: string, text: string, contextToken: string }>
  /** 媒体取数：记录 id，按注入实现作答（缺省给「测试未安排」）。 */
  mediaCalls: number[]
  mediaImpl: ((dir: string, id: number) => Promise<ClawbotMediaOutcome>) | null
  /** 启动补扫清点：按测试安排返回待取行 id。 */
  mediaPending: number[]
}

function makeHarness(): {
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
  const ops: OpRecord[] = []
  const events: ClawbotEmitEvent[] = []
  const ilink: FakeIlink = {
    requestBindQrCalls: 0,
    pollQueue: [],
    pollImpl: null,
    pollCalls: [],
    updatesImpl: () => new Promise<IlinkUpdates>(() => { /* 挂起：等测试手动推进或直接不解 */ }),
    sendQueue: [],
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
        ilink.sendCalls.push({ toUserId: out.toUserId, text: out.text, contextToken: out.contextToken })
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
    expect(ilink.sendCalls).toEqual([{ toUserId: 'user-1', text: '好的，收到', contextToken: 'ctx-21' }])
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
})
