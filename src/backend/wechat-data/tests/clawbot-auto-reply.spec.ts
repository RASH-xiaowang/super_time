/**
 * AI 自动回复守卫（M3，2026-10-13）。
 *
 * 守的是三组命题：
 *  ① **决策**：开关关着就一定不回；开了就回；知识库「开了但没选库」⇒ 回但不检索
 *     （**不是**「所有库」—— 那会把别的库内容端上来）；
 *  ② **候选筛选**：只回用户发来的文本（自己的回显、图片/语音/文件都不回）；
 *     一批多条**只回最后一条**（服务端不给消息时间，「刚绑定拉回历史」只能靠这条压上界）；
 *  ③ **执行器的失败纪律**：ask 抛错 / 空答案 / 发送失败 —— 一律**记账返回、不抛**、
 *     不写「已回复」的假记录；开关现读（关掉之后不再入队）。
 *
 * 全程注入假 ask 与假 send —— 这套用例一个字节都不出网。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PENDING,
  MAX_REPLY_CHARS,
  createAutoReplyRunner,
  decideAutoReply,
  isReplyable,
  pickReplyTarget,
  truncateReply,
  type AutoReplyRunnerDeps,
  type ClawbotAskContext,
  type ReplyableMessage,
} from '../src/query/clawbot/clawbot-auto-reply.ts'
import { listRecoverableReplyRuns, readReplyRun } from '../src/query/clawbot/clawbot-reply-store.ts'
import type { ClawbotInstanceConfig, ClawbotSendResult, OperationCategory, OperationStatus } from '../src/types.ts'

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await new Promise((r) => { setImmediate(r) }) }
const runners: Array<ReturnType<typeof createAutoReplyRunner>> = []
const scratch: string[] = []

function cfg(patch: Partial<ClawbotInstanceConfig> = {}): ClawbotInstanceConfig {
  return { slot: 1, autoReply: false, kbEnabled: false, kbId: null, systemPrompt: '', splitReply: false, ...patch }
}

function msg(patch: Partial<ReplyableMessage> = {}): ReplyableMessage {
  return { direction: 'in', msgType: 'text', content: '在吗', ...patch }
}

interface OpRecord { category: OperationCategory, action: string, status: OperationStatus, target: string, detail: string }

interface HarnessOverrides {
  /** `null` = 明确「未注入 ask」（装配缺失场景）；缺省 = 注入一个成功实现。 */
  ask?: AutoReplyRunnerDeps['ask'] | null
  send?: AutoReplyRunnerDeps['send']
  config?: ClawbotInstanceConfig
  debounceMs?: number
  durable?: AutoReplyRunnerDeps['durable']
}

function makeRunner(over: HarnessOverrides = {}): {
  runner: ReturnType<typeof createAutoReplyRunner>,
  ops: OpRecord[],
  asks: Array<{ slot: number, text: string, kbId: number | null }>,
  sends: Array<{ slot: number, text: string }>,
  replied: Array<{ slot: number, id: number }>,
  setConfig: (c: ClawbotInstanceConfig) => void,
} {
  const ops: OpRecord[] = []
  const asks: Array<{ slot: number, text: string, kbId: number | null }> = []
  const sends: Array<{ slot: number, text: string }> = []
  const replied: Array<{ slot: number, id: number }> = []
  let current = over.config ?? cfg()
  const defaultAsk: NonNullable<AutoReplyRunnerDeps['ask']> = async (slot, text, kbId) => {
    asks.push({ slot, text, kbId })
    return { ok: true, answer: '收到' }
  }
  const deps: AutoReplyRunnerDeps = {
    readConfig: () => current,
    send: over.send ?? (async (slot: number, text: string): Promise<ClawbotSendResult> => {
      sends.push({ slot, text })
      return { ok: true, id: 99 }
    }),
    op: (category, action, status, target, detail) => { ops.push({ category, action, status, target: target ?? '', detail: detail ?? '' }) },
    onReplied: (info) => { replied.push(info) },
    ...(over.ask === null ? {} : { ask: over.ask ?? defaultAsk }),
    ...(over.debounceMs === undefined ? {} : { debounceMs: over.debounceMs }),
    ...(over.durable === undefined ? {} : { durable: over.durable }),
  }
  const runner = createAutoReplyRunner(deps)
  runners.push(runner)
  return {
    runner,
    ops, asks, sends, replied,
    setConfig: (c: ClawbotInstanceConfig) => { current = c },
  }
}

afterEach(() => {
  for (const runner of runners) runner.dispose()
  runners.length = 0
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function durableRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-auto-reply-lease-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 只跑 0ms 定时器与 Promise 链；不推进假时钟，确保心跳 interval 没机会触发。 */
async function flushWithoutLeaseAdvance(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0)
    await flush()
  }
}

describe('① 决策：只认开关，不看消息内容', () => {
  it('开关关着 ⇒ 不回（默认值，也是「无人值守出网」的第一道防线）', () => {
    expect(decideAutoReply(cfg())).toMatchObject({ should: false, kbId: null })
  })

  it('开了就回；知识库「开了但没选库」⇒ 回但不检索', () => {
    expect(decideAutoReply(cfg({ autoReply: true }))).toMatchObject({ should: true, kbId: null })
    expect(decideAutoReply(cfg({ autoReply: true, kbEnabled: true })), '没选库时不许把「所有库」当成作用域').toMatchObject({ should: true, kbId: null })
    expect(decideAutoReply(cfg({ autoReply: true, kbEnabled: true, kbId: 7 }))).toMatchObject({ should: true, kbId: 7 })
  })

  it('知识库开关关着时，即便配了库 id 也不检索（开关优先于残留配置）', () => {
    expect(decideAutoReply(cfg({ autoReply: true, kbEnabled: false, kbId: 7 }))).toMatchObject({ should: true, kbId: null })
  })
})

describe('② 候选筛选：只回「用户发来的文本」，一批只回一条', () => {
  it('只认入站文本', () => {
    expect(isReplyable(msg())).toBe(true)
    expect(isReplyable(msg({ direction: 'out' })), '回自己的消息 = 自己跟自己说话').toBe(false)
    expect(isReplyable(msg({ msgType: 'image' })), '图片/语音/文件不做自动回复').toBe(false)
    expect(isReplyable(msg({ msgType: null }))).toBe(false)
    expect(isReplyable(msg({ content: '   ' }))).toBe(false)
  })

  it('一批多条只取最后一条，并报出跳过了几条', () => {
    const batch = [msg({ content: '一' }), msg({ content: '二' }), msg({ msgType: 'image' }), msg({ content: '三' })]
    const { target, dropped } = pickReplyTarget(batch)
    expect(target?.content).toBe('三')
    expect(dropped, '跳过的条数要如实报出（审计里说清这一批被压掉了多少）').toBe(2)
    expect(pickReplyTarget([]).target).toBeNull()
    expect(pickReplyTarget([msg({ direction: 'out' })]).target).toBeNull()
  })

  it('超长回复截断并注明', () => {
    const long = '啊'.repeat(MAX_REPLY_CHARS + 50)
    const t = truncateReply(long)
    expect(t.length).toBeLessThan(long.length)
    expect(t).toContain('已截断')
    expect(truncateReply('  短  ')).toBe('短')
  })
})

describe('③ 执行器：一问一答、失败不抛、开关现读', () => {
  it('开关开着：ask 一次（带实例 slot 与 kbId）→ 发送一次 → 审计 ok → 事件一条', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true, kbEnabled: true, kbId: 9 }) })
    h.runner.consider(1, [msg({ content: '今天有什么安排' })])
    await flush()
    expect(h.asks).toEqual([{ slot: 1, text: '今天有什么安排', kbId: 9 }])
    expect(h.sends).toEqual([{ slot: 1, text: '收到' }])
    expect(h.replied).toEqual([{ slot: 1, id: 99 }])
    const ok = h.ops.filter(o => o.action === 'clawbot_auto_reply' && o.status === 'ok')
    expect(ok).toHaveLength(1)
    expect(ok[0]?.detail).toContain('知识库 9')
  })

  it('debounce=0 立即处理（默认行为保持不变）', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }), debounceMs: 0 })
    h.runner.consider(1, [msg({ content: '立即回复' })])
    expect(h.asks.map(a => a.text), 'debounce=0 时不该等定时器').toEqual(['立即回复'])
    await flush()
    expect(h.sends).toEqual([{ slot: 1, text: '收到' }])
  })

  it('debounce 窗口内同一 slot 连续 consider 合并，只回最后一条可回复文本', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = makeRunner({ config: cfg({ autoReply: true }), debounceMs: 20 })
    h.runner.consider(1, [msg({ content: '第一条' })])
    h.runner.consider(1, [msg({ content: '第二条' })])
    expect(h.runner.pending(), '等待中的 debounce 目标也要计入待回复').toBe(1)
    expect(h.asks, '窗口未结束前不许提前调用模型').toEqual([])
    await vi.advanceTimersByTimeAsync(19)
    await flush()
    expect(h.asks, '窗口被第二次 consider 重置了').toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(h.asks.map(a => a.text)).toEqual(['第二条'])
    expect(h.sends).toEqual([{ slot: 1, text: '收到' }])
  })

  it('开关关着：一个字节都不出去（连 ask 都不调、也不记账 —— 无声是常态）', async () => {
    const h = makeRunner()
    h.runner.consider(1, [msg()])
    await flush()
    expect(h.asks).toEqual([])
    expect(h.sends).toEqual([])
    expect(h.ops).toEqual([])
  })

  it('ask 抛错 / 返回失败 / 空答案 ⇒ 不发送、记 fail、**不抛出**（调用方是长轮询循环）', async () => {
    const boom = makeRunner({ ask: async () => { throw new Error('未配置默认模型') }, config: cfg({ autoReply: true }) })
    boom.runner.consider(1, [msg()])
    await flush()
    expect(boom.sends).toEqual([])
    expect(boom.ops.at(-1)).toMatchObject({ action: 'clawbot_auto_reply', status: 'fail' })
    expect(boom.ops.at(-1)?.detail).toContain('未配置默认模型')

    const bad = makeRunner({ ask: async () => ({ ok: false, answer: '', error: '上游 500' }), config: cfg({ autoReply: true }) })
    bad.runner.consider(1, [msg()])
    await flush()
    expect(bad.sends).toEqual([])
    expect(bad.ops.at(-1)?.detail).toContain('上游 500')

    const empty = makeRunner({ ask: async () => ({ ok: true, answer: '   ' }), config: cfg({ autoReply: true }) })
    empty.runner.consider(1, [msg()])
    await flush()
    expect(empty.sends).toEqual([])
    expect(empty.ops.at(-1)?.detail).toContain('空答案')
  })

  it('发送失败 ⇒ 不许发事件、不许写「已回复」的 ok 记录', async () => {
    const h = makeRunner({
      send: async (): Promise<ClawbotSendResult> => ({ ok: false, id: null, error: '还没有可用会话' }),
      config: cfg({ autoReply: true }),
    })
    h.runner.consider(1, [msg()])
    await flush()
    expect(h.replied).toEqual([])
    expect(h.ops.filter(o => o.status === 'ok')).toEqual([])
    expect(h.ops.at(-1)?.detail).toContain('还没有可用会话')
  })

  it('未注入 ask（测试态 / 装配缺失）⇒ 记一行 fail，不发送（不许静默）', async () => {
    const h = makeRunner({ ask: null, config: cfg({ autoReply: true }) })
    h.runner.consider(1, [msg()])
    await flush()
    expect(h.sends).toEqual([])
    expect(h.ops.at(-1)?.detail).toContain('ask 能力未注入')
  })

  it('开关现读：关着时进的消息不入队；打开之后才走（两侧都钉）', async () => {
    const h = makeRunner()
    h.runner.consider(1, [msg({ content: '关着的时候' })])
    await flush()
    expect(h.asks, '关着的时候一个 ask 都不该发生').toEqual([])
    h.setConfig(cfg({ autoReply: true }))
    h.runner.consider(1, [msg({ content: '打开之后' })])
    await flush()
    expect(h.asks.map(a => a.text)).toEqual(['打开之后'])
  })

  it('积压超过上限 ⇒ 丢弃并记账（不许无界排队）', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    for (let i = 0; i < MAX_PENDING + 3; i += 1) h.runner.consider(1, [msg({ content: `第${String(i)}条` })])
    await flush()
    expect(h.ops.some(o => (o.detail ?? '').includes('积压'))).toBe(true)
  })

  it('一批多条只回最后一条，并留一行「跳过 N 条」', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    h.runner.consider(1, [msg({ content: '一' }), msg({ content: '二' }), msg({ content: '三' })])
    await flush()
    expect(h.asks.map(a => a.text)).toEqual(['三'])
    expect(h.ops.some(o => (o.detail ?? '').includes('只回最后一条'))).toBe(true)
  })

  it('多实例互不影响：两个 slot 各回各的（消息与回复都不串）', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    h.runner.consider(2, [msg({ content: '二号的消息' })])
    h.runner.consider(3, [msg({ content: '三号的消息' })])
    await flush()
    expect(h.asks.map(a => ({ slot: a.slot, text: a.text }))).toEqual([
      { slot: 2, text: '二号的消息' },
      { slot: 3, text: '三号的消息' },
    ])
    expect(h.sends.map(s => s.slot)).toEqual([2, 3])
  })

  it('多个 slot 都有积压时公平轮转，不按 Map 插入顺序饿死后面的 slot', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: number[] = []
    let first = true
    const h = makeRunner({
      config: cfg({ autoReply: true }),
      ask: async (slot) => {
        order.push(slot)
        if (first) {
          first = false
          await gate
        }
        return { ok: true, answer: '收到' }
      },
    })
    h.runner.consider(1, [msg({ content: '一号第一条' })])
    h.runner.consider(1, [msg({ content: '一号第二条' })])
    h.runner.consider(2, [msg({ content: '二号第一条' })])
    h.runner.consider(1, [msg({ content: '一号第三条' })])
    h.runner.consider(2, [msg({ content: '二号第二条' })])
    expect(order, '第一条先占住全局单飞槽').toEqual([1])
    release()
    await flush()
    expect(order, 'slot 2 不能等 slot 1 清空后才开始').toEqual([1, 2, 1, 2, 1])
  })

  /*
   * 2026-10-18 用户截图「不能关联上下文和识别图中内容」：
   * 目标消息之前的最近对话与图片必须交给 ask 管道；读上下文/图片失败也要照常回复，
   * 不许因为「历史读不出来」就整条不发。
   */
  it('最近对话与图片随 ask 一起送出（图片含 MIME，供模型读图）', async () => {
    const calls: Array<{ text: string, ctx: ClawbotAskContext | undefined }> = []
    const deps: AutoReplyRunnerDeps = {
      readConfig: () => cfg({ autoReply: true }),
      ask: async (_slot, text, _kbId, _sp, context) => {
        calls.push({ text, ctx: context })
        return { ok: true, answer: '看到了，右边那辆是……' }
      },
      send: async () => ({ ok: true, id: 1 }),
      op: () => {},
      onReplied: () => {},
      history: () => [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀，有事吗' },
        { role: 'user', content: '[图片]' },
      ],
      images: async () => [{ data: 'aGVsbG8=', mediaType: 'image/jpeg', name: 'wx-image-7' }],
    }
    createAutoReplyRunner(deps).consider(1, [msg({ id: 9, content: '分析一下图中右边那辆车是什么车？' })])
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ctx?.history?.map(m => m.content)).toEqual(['你好', '你好呀，有事吗', '[图片]'])
    expect(calls[0]?.ctx?.images).toEqual([{ data: 'aGVsbG8=', mediaType: 'image/jpeg', name: 'wx-image-7' }])
  })

  it('上下文/图片读取抛错 ⇒ 按空处理，照样回复（不阻断）', async () => {
    const calls: Array<{ text: string, ctx: ClawbotAskContext | undefined }> = []
    const sends: string[] = []
    const deps: AutoReplyRunnerDeps = {
      readConfig: () => cfg({ autoReply: true }),
      ask: async (_slot, text, _kbId, _sp, context) => {
        calls.push({ text, ctx: context })
        return { ok: true, answer: '收到' }
      },
      send: async (_slot, text) => { sends.push(text); return { ok: true, id: 2 } },
      op: () => {},
      onReplied: () => {},
      history: () => { throw new Error('history db down') },
      images: async () => { throw new Error('media cache down') },
    }
    createAutoReplyRunner(deps).consider(1, [msg({ id: 9 })])
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.ctx).toEqual({})
    expect(sends).toEqual(['收到'])
  })
})

describe('④ runner 可观测性、周期恢复入口与 dispose', () => {
  it('stats 返回稳定快照，并记录成功生成、发送与完成时间', async () => {
    const h = makeRunner({ config: cfg({ autoReply: true }) })
    h.runner.consider(1, [msg({ id: 41, content: '统计一次成功' })])

    expect(h.runner.stats()).toMatchObject({
      pending: 0,
      inFlight: true,
      stage: 'generating',
      inFlightSlot: 1,
      inFlightRunId: null,
    })

    await flush()
    expect(h.runner.stats()).toEqual({
      pending: 0,
      inFlight: false,
      stage: 'idle',
      inFlightSlot: null,
      inFlightRunId: null,
      recovered: 0,
      recoveryContinuations: 0,
      leaseLost: 0,
      coalesced: 0,
      generationSucceeded: 1,
      generationFailed: 0,
      sendSucceeded: 1,
      sendRetried: 0,
      sendFailedPermanently: 0,
      dropped: 0,
      backpressure: 0,
      lastError: null,
      lastCompletedAt: expect.any(Number),
    })
  })

  it('send await 期间 stage=sending，结束后回到 idle', async () => {
    let releaseSend!: (result: ClawbotSendResult) => void
    const h = makeRunner({
      config: cfg({ autoReply: true }),
      send: () => new Promise((resolve) => { releaseSend = resolve }),
    })

    h.runner.consider(1, [msg({ id: 42 })])
    await flush()
    expect(h.runner.stats()).toMatchObject({ inFlight: true, stage: 'sending', inFlightSlot: 1 })

    releaseSend({ ok: true, id: 420 })
    await flush()
    expect(h.runner.stats()).toMatchObject({ inFlight: false, stage: 'idle', sendSucceeded: 1 })
  })

  it('生成失败与发送永久失败分别计数，并更新 lastError', async () => {
    const askFailed = makeRunner({
      config: cfg({ autoReply: true }),
      ask: async () => { throw new Error('ask boom') },
    })
    askFailed.runner.consider(1, [msg({ id: 43 })])
    await flush()
    expect(askFailed.runner.stats()).toMatchObject({
      generationFailed: 1,
      generationSucceeded: 0,
      sendFailedPermanently: 0,
      lastError: 'ask boom',
      lastCompletedAt: null,
    })

    const sendFailed = makeRunner({
      config: cfg({ autoReply: true }),
      send: async () => ({ ok: false, id: null, error: 'send boom' }),
    })
    sendFailed.runner.consider(1, [msg({ id: 44 })])
    await flush()
    expect(sendFailed.runner.stats()).toMatchObject({
      generationSucceeded: 1,
      sendSucceeded: 0,
      sendFailedPermanently: 1,
      lastError: 'send boom',
      lastCompletedAt: null,
    })
  })

  it('coalesced、dropped 与 backpressure 使用固定计数口径', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const debounced = makeRunner({ config: cfg({ autoReply: true }), debounceMs: 50 })
    debounced.runner.consider(1, [msg({ id: 45, content: '第一条' })])
    debounced.runner.consider(1, [msg({ id: 46, content: '第二条' })])
    debounced.runner.consider(1, [msg({ id: 47 }), msg({ id: 48 }), msg({ id: 49, content: '最后一条' })])
    expect(debounced.runner.stats()).toMatchObject({
      pending: 1,
      coalesced: 2,
      dropped: 2,
      backpressure: 0,
    })
    debounced.runner.dispose()
    expect(debounced.runner.stats()).toMatchObject({ pending: 0, inFlight: false, stage: 'idle' })

    let releaseAsk!: () => void
    const gate = new Promise<void>((resolve) => { releaseAsk = resolve })
    const pressured = makeRunner({
      config: cfg({ autoReply: true }),
      ask: async () => {
        await gate
        return { ok: true, answer: '收到' }
      },
    })
    pressured.runner.consider(1, [msg({ id: 50 })])
    for (let index = 0; index < MAX_PENDING + 3; index += 1) {
      pressured.runner.consider(1, [msg({ id: 51 + index })])
    }
    expect(pressured.runner.stats()).toMatchObject({
      pending: MAX_PENDING,
      backpressure: 3,
      lastError: expect.stringContaining('积压'),
    })
    releaseAsk()
    await flush()
  })

  it('dispose 清空 pending，并阻止晚到 ask 与后续调度', async () => {
    let releaseAsk!: (result: { ok: boolean, answer: string }) => void
    let askCalls = 0
    const h = makeRunner({
      config: cfg({ autoReply: true }),
      ask: () => {
        askCalls += 1
        return new Promise((resolve) => { releaseAsk = resolve })
      },
    })

    h.runner.consider(1, [msg({ id: 60 })])
    await flush()
    expect(h.runner.stats()).toMatchObject({ inFlight: true, stage: 'generating' })

    h.runner.dispose()
    expect(h.runner.stats()).toMatchObject({ pending: 0, inFlight: false, stage: 'idle' })
    releaseAsk({ ok: true, answer: '晚到答案' })
    await flush()

    h.runner.consider(1, [msg({ id: 61 })])
    h.runner.recover()
    expect(h.runner.pending()).toBe(0)
    expect(h.runner.stats()).toMatchObject({ generationSucceeded: 0, sendSucceeded: 0 })
    expect(askCalls).toBe(1)
    expect(h.sends).toEqual([])
    expect(h.replied).toEqual([])
  })
})

describe('⑤ 结果写回门禁：心跳 timer 未触发也必须拒绝过期租约', () => {
  it('ask 晚到且本机租约已过期：不写 outbox，leaseLost 只记一次', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    const started = Date.UTC(2026, 0, 1)
    vi.setSystemTime(started)
    const dir = durableRoot()
    const answer = deferred<{ ok: boolean, answer: string, error?: string }>()
    let askCalls = 0
    const h = makeRunner({
      config: cfg({ autoReply: true }),
      durable: {
        dir: () => dir,
        debounceMs: 0,
        generationLeaseMs: 1_000,
        askTimeoutMs: 10_000,
        retryBaseMs: 0,
      },
      ask: () => {
        askCalls += 1
        return answer.promise
      },
    })

    h.runner.consider(1, [msg({ id: 70, content: '生成租约门禁' })])
    await flushWithoutLeaseAdvance()
    expect(askCalls).toBe(1)
    const run = listRecoverableReplyRuns(dir, started + 10_000, 20)[0]
    expect(run).toBeDefined()

    // 恰好到 leaseUntil 即失效；只改假时钟，不跑心跳 interval。
    vi.setSystemTime(started + 1_000)
    answer.resolve({ ok: true, answer: '不应落库的晚到答案' })
    await flushWithoutLeaseAdvance()

    expect(h.runner.stats()).toMatchObject({
      leaseLost: 1,
      generationSucceeded: 0,
      sendSucceeded: 0,
    })
    expect(readReplyRun(dir, run?.id ?? 0)).toMatchObject({
      run: { status: 'generating' },
      parts: [],
    })
    expect(h.ops.filter(op =>
      op.status === 'fail' && op.detail.includes('结果返回时本机租约已过期'),
    )).toHaveLength(1)

    await flushWithoutLeaseAdvance()
    expect(h.runner.stats()).toMatchObject({ leaseLost: 1 })
    expect(h.ops.filter(op =>
      op.status === 'fail' && op.detail.includes('结果返回时本机租约已过期'),
    )).toHaveLength(1)
  })

  it('send 晚到且本机租约已过期：不写 sent/retry/failed，leaseLost 只记一次', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    const started = Date.UTC(2026, 0, 2)
    vi.setSystemTime(started)
    const dir = durableRoot()
    const sentResult = deferred<ClawbotSendResult>()
    let sendCalls = 0
    const h = makeRunner({
      config: cfg({ autoReply: true }),
      durable: {
        dir: () => dir,
        debounceMs: 0,
        generationLeaseMs: 5_000,
        sendLeaseMs: 1_000,
        sendTimeoutMs: 10_000,
        retryBaseMs: 0,
      },
      ask: async () => ({ ok: true, answer: '只发送一次' }),
      send: () => {
        sendCalls += 1
        return sentResult.promise
      },
    })

    h.runner.consider(1, [msg({ id: 71, content: '发送租约门禁' })])
    await flushWithoutLeaseAdvance()
    expect(sendCalls).toBe(1)
    const run = listRecoverableReplyRuns(dir, started + 10_000, 20)[0]
    expect(run).toBeDefined()

    vi.setSystemTime(started + 1_000)
    sentResult.resolve({ ok: true, id: 9_999 })
    await flushWithoutLeaseAdvance()

    expect(h.runner.stats()).toMatchObject({
      leaseLost: 1,
      sendSucceeded: 0,
      sendRetried: 0,
      sendFailedPermanently: 0,
    })
    expect(h.replied).toEqual([])
    expect(readReplyRun(dir, run?.id ?? 0)).toMatchObject({
      run: { status: 'sending' },
      parts: [{ status: 'sending', sentMessageId: null }],
    })
    expect(h.ops.filter(op =>
      op.status === 'fail' && op.detail.includes('结果返回时本机租约已过期'),
    )).toHaveLength(1)

    await flushWithoutLeaseAdvance()
    expect(h.runner.stats()).toMatchObject({ leaseLost: 1 })
    expect(h.ops.filter(op =>
      op.status === 'fail' && op.detail.includes('结果返回时本机租约已过期'),
    )).toHaveLength(1)
  })
})
