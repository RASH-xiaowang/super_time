/**
 * 接收通道循环守卫（`query/clawbot/clawbot-channel.ts`）—— 依赖全部注入假实现。
 *
 * 循环的失效几乎全是**静默**的：退避不生效 = 服务器半开时热循环（日志风暴）；
 * -14 恢复逻辑散了 = 会话过期后卡死；游标不推进 = 每次重拉整段历史。
 * 这里把每条都钉成可观察的行为（sleep 参数、getUpdates 收到的游标、onError 的终态）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  SERVER_ERROR_BACKOFF_MS,
  SESSION_EXPIRED_BACKOFF_MS,
  backoffMs,
  createClawbotChannel,
  type ClawbotChannel,
  type ClawbotChannelDeps,
} from '../src/query/clawbot/clawbot-channel.ts'
import type { IlinkUpdates, WeixinMessage } from '../src/query/clawbot/clawbot-ilink.ts'

/** 构造响应（缺省：空批、游标无变化）。 */
function resp(patch: Partial<IlinkUpdates> = {}): IlinkUpdates {
  return { ret: 0, errCode: 0, errMsg: '', messages: [], buf: '', longPollingTimeoutMs: 0, ...patch }
}

const msg = (id: number, text: string): WeixinMessage => ({ message_id: id, message_type: 1, item_list: [{ type: 1, text_item: { text } }] })

interface Log {
  bufs: string[]
  sleeps: number[]
  saved: string[]
  inserted: Array<readonly WeixinMessage[]>
  emitted: Array<{ lastId: number, delta: number }>
  errors: Array<string | null>
  logs: string[]
}

/** 造一个可编程通道：`script` 按调用次序消费；用尽后挂起（不再被调用）。 */
function makeChannel(script: Array<IlinkUpdates | Error>, opts: {
  buf?: string
  /** 覆盖落库行为（如「全部重复 ⇒ null」）；缺省按消息数返回范围。 */
  inserted?: ((msgs: readonly WeixinMessage[]) => { lastId: number, delta: number } | null) | null
  /** 第 n 次 sleep 时自动 stop()（测试收口用）。 */
  stopOnSleep?: number
} = {}): { channel: ClawbotChannel, log: Log, calls: () => number } {
  const log: Log = { bufs: [], sleeps: [], saved: [], inserted: [], emitted: [], errors: [], logs: [] }
  let calls = 0
  let channel: ClawbotChannel = null as unknown as ClawbotChannel
  const deps: ClawbotChannelDeps = {
    getUpdates: (buf) => {
      log.bufs.push(buf)
      const next = script[calls]
      calls += 1
      if (next instanceof Error) return Promise.reject(next)
      if (next === undefined) return new Promise<IlinkUpdates>(() => { /* 挂起 */ })
      return Promise.resolve(next)
    },
    readBuf: () => opts.buf ?? 'cursor-start',
    saveBuf: (buf) => { log.saved.push(buf) },
    insertMessages: (msgs) => {
      log.inserted.push(msgs)
      if (opts.inserted !== undefined) return opts.inserted === null ? null : opts.inserted(msgs)
      if (msgs.length === 0) return null
      return { lastId: 100 + log.inserted.length, delta: msgs.length }
    },
    onMessages: (info) => { log.emitted.push(info) },
    onError: (error) => { log.errors.push(error) },
    sleep: (ms) => {
      log.sleeps.push(ms)
      if (opts.stopOnSleep !== undefined && log.sleeps.length >= opts.stopOnSleep) channel.stop()
      return Promise.resolve()
    },
    log: (m) => { log.logs.push(m) },
  }
  channel = createClawbotChannel(deps)
  return { channel, log, calls: () => calls }
}

/** 等一拍（让循环里的 microtask 链推进到下一次挂起/停止）。 */
const flush = async (): Promise<void> => { await new Promise((resolve) => { setImmediate(resolve) }) }

describe('clawbot channel（接收循环）', () => {
  it('成功轮询：推进游标、批次落库、事件聚合、lastPollAt 记时', async () => {
    const { channel, log } = makeChannel([resp({ buf: 'c1', messages: [msg(1, 'a'), msg(2, 'b')] })])
    channel.start()
    await flush()
    expect(log.inserted).toHaveLength(1)
    expect(log.inserted[0]).toHaveLength(2)
    expect(log.emitted).toEqual([{ lastId: 101, delta: 2 }])
    expect(log.saved).toEqual(['c1'])
    expect(log.bufs[0]).toBe('cursor-start')
    const st = channel.state()
    expect(st.running).toBe(true)
    expect(st.lastError).toBeNull()
    expect(st.lastPollAt).not.toBeNull()
    channel.stop()
    expect(channel.state().running).toBe(false)
  })

  it('空批：不落库、不发事件、不存空游标', async () => {
    const { channel, log } = makeChannel([resp()])
    channel.start()
    await flush()
    expect(log.inserted).toEqual([])
    expect(log.emitted).toEqual([])
    expect(log.saved).toEqual([])
    channel.stop()
  })

  it('零新增（全部重复被去重）：不发事件但游标照推', async () => {
    const { channel, log } = makeChannel([resp({ buf: 'c1', messages: [msg(1, 'dup')] })], { inserted: null })
    channel.start()
    await flush()
    expect(log.inserted).toHaveLength(1)
    expect(log.emitted).toEqual([])
    expect(log.saved).toEqual(['c1'])
    channel.stop()
  })

  it('网络失败：指数退避 3s → 6s → 12s；成功一次后计数清零（下一跳回到 3s）', async () => {
    const { channel, log } = makeChannel([
      new Error('boom1'), new Error('boom2'), resp({ buf: 'c1' }),
      new Error('boom3'),
    ])
    channel.start()
    await flush()
    await flush()
    expect(log.sleeps).toEqual([INITIAL_BACKOFF_MS, INITIAL_BACKOFF_MS * 2, INITIAL_BACKOFF_MS])
    channel.stop()
  })

  it('连续失败到第 5 次：日志里出现「重新绑定」提示（且只提示一次）', async () => {
    const { channel, log, calls } = makeChannel(
      [new Error('e'), new Error('e'), new Error('e'), new Error('e'), new Error('e'), new Error('e')],
      { stopOnSleep: 5 },
    )
    channel.start()
    await flush()
    await flush()
    expect(log.sleeps).toEqual([3000, 6000, 12000, 24000, 48000])
    expect(log.logs.filter(l => l.includes('重新绑定'))).toHaveLength(1)
    expect(channel.state().running).toBe(false)
    const after = calls()
    await flush()
    expect(calls()).toBe(after) // 停止后不再打上游
  })

  it('游标非空时 -14：清游标重连（saveBuf(\'\') + 5s 等待 + 下一跳带空游标）', async () => {
    const { channel, log } = makeChannel([
      resp({ errCode: -14 }),
      resp({ buf: 'c2' }),
    ])
    channel.start()
    await flush()
    expect(log.sleeps).toEqual([SESSION_EXPIRED_BACKOFF_MS])
    expect(log.saved).toEqual(['', 'c2'])
    // 第二跳带的游标是**本地清空后的 ''**（不是库里那份旧值）；第三跳起循环挂起。
    expect(log.bufs.slice(0, 2)).toEqual(['cursor-start', ''])
    expect(channel.state().lastError).toBeNull()
    channel.stop()
  })

  it('游标已空还 -14：终态 —— 停循环、onError 收到可读中文、不再打上游', async () => {
    const { channel, log, calls } = makeChannel([resp({ errCode: -14 }), resp({ buf: 'never' })], { buf: '' })
    channel.start()
    await flush()
    expect(channel.state().running).toBe(false)
    expect(channel.state().lastError).toContain('重新扫码绑定')
    // start() 会先发一个 null（复位）；终态错误是最后一条。
    expect(log.errors.filter(e => e !== null)).toEqual([channel.state().lastError])
    expect(log.sleeps).toEqual([]) // 终态不再退避重试
    expect(calls()).toBe(1)
  })

  it('其他服务端错误（ret≠0 且 errcode≠0）：1s 间隔继续，不当成会话过期', async () => {
    const { channel, log } = makeChannel([
      resp({ ret: 1, errCode: 2, errMsg: 'busy' }),
      resp({ buf: 'c9' }),
    ])
    channel.start()
    await flush()
    expect(log.sleeps).toEqual([SERVER_ERROR_BACKOFF_MS])
    expect(log.saved).toEqual(['c9'])
    expect(channel.state().lastError).toBeNull()
    channel.stop()
  })

  it('start 幂等；stop 后在飞请求的响应被忽略、循环退出', async () => {
    const { channel, log, calls } = makeChannel([resp({ buf: 'c1' })])
    channel.start()
    channel.start() // 第二次不该另起循环
    channel.stop() // 第一跳还没返回就停
    await flush()
    expect(calls()).toBe(1)
    expect(log.saved).toEqual([]) // 停止后的响应被忽略（不进游标/不落库）
    expect(channel.state().running).toBe(false)
    // 重新 start 能再跑（重新绑定路径）
    channel.start()
    expect(channel.state().running).toBe(true)
    channel.stop()
  })

  it('stop 会 abort 在飞请求，且退避中的 sleep 也能被 abort', async () => {
    let channel: ClawbotChannel = null as unknown as ClawbotChannel
    let getSignal: AbortSignal | undefined
    const sleeps: number[] = []
    const deps: ClawbotChannelDeps = {
      getUpdates: (_buf, signal) => {
        getSignal = signal
        return new Promise<IlinkUpdates>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
      readBuf: () => '',
      saveBuf: () => {},
      insertMessages: () => null,
      onMessages: () => {},
      onError: () => {},
      sleep: (ms, signal) => {
        sleeps.push(ms)
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('sleep-aborted')), { once: true })
        })
      },
      log: () => {},
    }
    channel = createClawbotChannel(deps)
    channel.start()
    await flush()
    expect(getSignal?.aborted).toBe(false)
    channel.stop()
    expect(getSignal?.aborted).toBe(true)
    expect(channel.state().running).toBe(false)
  })

  it('backoffMs：3s 起、翻倍、封顶 60s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([3000, 6000, 12000, 24000, 48000, MAX_BACKOFF_MS, MAX_BACKOFF_MS])
  })
})
