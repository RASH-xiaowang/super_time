/**
 * ClawBot durable 自动回复的跨重启 / 发送幂等集成守卫。
 *
 * 这些用例直接使用真实 `clawbot.db` 与 reply-store，只把模型与发送替换成内存实现；
 * 重点验证 outbox 的 clientId 在失败重试和「runner A 死亡、runner B recover」后不变。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RECOVERY_CONTINUATION_MS,
  createAutoReplyRunner,
  type AutoReplyRunnerDeps,
  type AutoReplySendContext,
  type ReplyableMessage,
} from '../src/query/clawbot/clawbot-auto-reply.ts'
import {
  enqueueOrMergeReplyRun,
  listRecoverableReplyRuns,
  readReplyRun,
  saveReplyParts,
} from '../src/query/clawbot/clawbot-reply-store.ts'
import { insertClawbotMessagesBatch } from '../src/query/clawbot/clawbot-message.ts'
import { clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import type { ClawbotInstanceConfig, ClawbotSendResult, OperationCategory, OperationStatus } from '../src/types.ts'

const scratch: string[] = []
const runners: Array<ReturnType<typeof createAutoReplyRunner>> = []
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

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-durable-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

function cfg(patch: Partial<ClawbotInstanceConfig> = {}): ClawbotInstanceConfig {
  return {
    slot: 1,
    autoReply: true,
    kbEnabled: true,
    kbId: 1,
    systemPrompt: '',
    splitReply: false,
    ...patch,
  }
}

function msg(id: number, content: string): ReplyableMessage {
  return { id, direction: 'in', msgType: 'text', content }
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

interface SendRecord {
  slot: number
  text: string
  context: AutoReplySendContext | undefined
}

interface Harness {
  runner: ReturnType<typeof createAutoReplyRunner>
  asks: Array<{ slot: number, text: string }>
  sends: SendRecord[]
  replies: Array<{ slot: number, id: number }>
}

interface HarnessOptions {
  dir: string
  config?: ClawbotInstanceConfig
  ask?: AutoReplyRunnerDeps['ask']
  send: AutoReplyRunnerDeps['send']
  readConfig?: AutoReplyRunnerDeps['readConfig']
  images?: AutoReplyRunnerDeps['images']
  durable?: boolean
  debounceMs?: number
  recoverIntervalMs?: number
  retryBaseMs?: number
  maxPartAttempts?: number
  generationLeaseMs?: number
  sendLeaseMs?: number
  askTimeoutMs?: number
  sendTimeoutMs?: number
  recoveryPageSize?: number
  recoveryMaxScanPerRound?: number
  recoveryMaxSchedulesPerRound?: number
  opThrows?: boolean
}

function makeRunner(options: HarnessOptions): Harness {
  const asks: Array<{ slot: number, text: string }> = []
  const sends: SendRecord[] = []
  const replies: Array<{ slot: number, id: number }> = []
  const config = options.config ?? cfg()
  const askImpl = options.ask ?? (async () => ({ ok: true, answer: '收到' }))
  const ask: AutoReplyRunnerDeps['ask'] = async (slot, text, kbId, systemPrompt, context) => {
    asks.push({ slot, text })
    return askImpl(slot, text, kbId, systemPrompt, context)
  }
  const send: AutoReplyRunnerDeps['send'] = async (slot, text, context) => {
    sends.push({ slot, text, context })
    return options.send(slot, text, context)
  }
  const deps: AutoReplyRunnerDeps = {
    readConfig: options.readConfig ?? ((slot) => ({ ...config, slot })),
    ask,
    send,
    op: (
      _category: OperationCategory,
      _action: string,
      _status: OperationStatus,
      _target?: string,
      _detail?: string,
    ) => {
      if (options.opThrows === true) throw new Error('audit sink unavailable')
    },
    onReplied: (info) => { replies.push(info) },
    images: options.images,
    debounceMs: options.debounceMs,
    recoverIntervalMs: options.recoverIntervalMs,
    durable: options.durable === false
      ? undefined
      : {
          dir: () => options.dir,
          debounceMs: 0,
          retryBaseMs: options.retryBaseMs ?? 0,
          maxPartAttempts: options.maxPartAttempts ?? 5,
          generationLeaseMs: options.generationLeaseMs,
          sendLeaseMs: options.sendLeaseMs,
          askTimeoutMs: options.askTimeoutMs,
          sendTimeoutMs: options.sendTimeoutMs,
          recoveryPageSize: options.recoveryPageSize,
          recoveryMaxScanPerRound: options.recoveryMaxScanPerRound,
          recoveryMaxSchedulesPerRound: options.recoveryMaxSchedulesPerRound,
        },
  }
  const runner = createAutoReplyRunner(deps)
  runners.push(runner)
  return { runner, asks, sends, replies }
}

/** 同时推进 fake timer 与 Promise 链（runner 的 drain 是异步的）。 */
async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

/** 只让异步恢复分页继续，不推进任何 setTimeout。 */
async function flushEventLoop(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve) })
  }
}

function onlyRun(dir: string): NonNullable<ReturnType<typeof readReplyRun>> {
  const runs = listRecoverableReplyRuns(dir, Date.now(), 20)
  expect(runs).toHaveLength(1)
  const snapshot = readReplyRun(dir, runs[0]?.id ?? 0)
  if (snapshot === null) throw new Error('run 应存在')
  return snapshot
}

describe('clawbot durable reply：跨分段与跨 restart 的 clientId', () => {
  it('splitReply 多分段各自 clientId 不同；同一个失败分段重试复用原 clientId', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    let nextSentId = 100
    const h = makeRunner({
      dir,
      config: cfg({ splitReply: true }),
      retryBaseMs: 5,
      ask: async () => ({ ok: true, answer: '第一段内容足够长，用于验证分段行为保持独立。\n\n第二段内容也足够长，用于验证重试复用稳定标识。' }),
      send: async (): Promise<ClawbotSendResult> => {
        if (h.sends.length === 1) throw new Error('socket timeout')
        nextSentId += 1
        return { ok: true, id: nextSentId }
      },
    })

    h.runner.consider(1, [msg(101, '请分两段回复')])
    await tick()

    const afterFailure = onlyRun(dir)
    expect(afterFailure.parts).toHaveLength(2)
    expect(afterFailure.run.status).toBe('ready')
    expect(afterFailure.parts.map(part => part.status)).toEqual(['pending', 'pending'])
    const [firstClient, secondClient] = afterFailure.parts.map(part => part.clientId)
    expect(new Set([firstClient, secondClient]).size).toBe(2)
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.context?.clientId).toBe(firstClient)
    expect(h.runner.stats()).toMatchObject({
      generationSucceeded: 1,
      sendSucceeded: 0,
      sendRetried: 1,
      sendFailedPermanently: 0,
      lastError: 'socket timeout',
      lastCompletedAt: null,
    })

    await tick(5)
    const final = readReplyRun(dir, afterFailure.run.id)
    expect(final?.run.status).toBe('done')
    expect(final?.parts.map(part => part.status)).toEqual(['sent', 'sent'])
    expect(h.sends.map(call => call.context?.clientId)).toEqual([firstClient, firstClient, secondClient])
    expect(h.runner.stats()).toMatchObject({
      sendSucceeded: 2,
      sendRetried: 1,
      sendFailedPermanently: 0,
      lastCompletedAt: expect.any(Number),
    })
  })

  it('runner A 生成 outbox 后死亡；runner B recover 后继续同一 run 并复用 clientId', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const runnerA = makeRunner({
      dir,
      config: cfg(),
      retryBaseMs: 5,
      ask: async () => ({ ok: true, answer: '持久化回复' }),
      send: async () => { throw new Error('process died after send attempt') },
    })

    runnerA.runner.consider(1, [msg(201, '重启后继续')])
    await tick()
    const crashed = onlyRun(dir)
    expect(crashed.parts).toHaveLength(1)
    expect(crashed.run.status).toBe('ready')
    const persistedClientId = crashed.parts[0]?.clientId
    expect(runnerA.sends[0]?.context?.clientId).toBe(persistedClientId)

    // 模拟进程 A 消失：它的 retry timer 不得再执行。
    vi.clearAllTimers()
    const runnerB = makeRunner({
      dir,
      config: cfg(),
      retryBaseMs: 0,
      ask: async () => { throw new Error('已有 outbox 时不应重新生成') },
      send: async () => ({ ok: true, id: 777 }),
    })
    runnerB.runner.recover()
    await tick(5)

    const recovered = readReplyRun(dir, crashed.run.id)
    expect(recovered?.run.status).toBe('done')
    expect(recovered?.parts[0]).toMatchObject({ status: 'sent', sentMessageId: 777 })
    expect(runnerB.asks).toEqual([])
    expect(runnerB.sends).toHaveLength(1)
    expect(runnerB.sends[0]?.context?.clientId).toBe(persistedClientId)
  })

  it('send 抛错后下一次成功仍复用原 clientId，最终 run=done、part=sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const dir = root()
    const h = makeRunner({
      dir,
      config: cfg(),
      retryBaseMs: 5,
      ask: async () => ({ ok: true, answer: '单段回复' }),
      send: async (): Promise<ClawbotSendResult> => {
        if (h.sends.length === 1) throw new Error('upstream result unknown')
        return { ok: true, id: 888 }
      },
    })

    h.runner.consider(1, [msg(301, '结果不确定')])
    await tick()
    const retryPending = onlyRun(dir)
    const retryClientId = retryPending.parts[0]?.clientId
    expect(retryPending.run.status).toBe('ready')
    expect(h.sends[0]?.context?.clientId).toBe(retryClientId)

    await tick(5)
    const final = readReplyRun(dir, retryPending.run.id)
    expect(final?.run.status).toBe('done')
    expect(final?.parts[0]).toMatchObject({ status: 'sent', sentMessageId: 888 })
    expect(h.sends.map(call => call.context?.clientId)).toEqual([retryClientId, retryClientId])
  })
})

describe('clawbot durable reply：恢复策略与公平调度', () => {
  it('自动回复关闭时，恢复出的 pending run 被标记 skipped，不调用 ask/send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 401,
      question: '应当跳过',
      debounceMs: 0,
      now: Date.now(),
    })
    saveReplyParts(dir, run.id, ['不应发送'], Date.now())

    const h = makeRunner({
      dir,
      config: cfg({ autoReply: false }),
      ask: async () => ({ ok: true, answer: '不应生成' }),
      send: async () => ({ ok: true, id: 1 }),
    })
    h.runner.recover()
    await tick()

    const snapshot = readReplyRun(dir, run.id)
    expect(snapshot?.run.status).toBe('skipped')
    expect(snapshot?.parts[0]?.status).toBe('pending')
    expect(h.asks).toEqual([])
    expect(h.sends).toEqual([])
  })

  it('无有效知识库导致跳过时写清缺失原因，不误报「已关闭自动回复」', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 403,
      question: '没有知识库不应发送',
      debounceMs: 0,
      now: Date.now(),
    })
    saveReplyParts(dir, run.id, ['不应发送'], Date.now())

    const h = makeRunner({
      dir,
      config: cfg({ autoReply: true, kbEnabled: false, kbId: null }),
      ask: async () => ({ ok: true, answer: '不应生成' }),
      send: async () => ({ ok: true, id: 1 }),
    })
    h.runner.recover()
    await tick()

    const snapshot = readReplyRun(dir, run.id)
    expect(snapshot?.run.status).toBe('skipped')
    expect(snapshot?.run.lastError, '跳过原因必须能让用户知道是缺知识库，而不是误以为用户关了自动回复')
      .toContain('自动回复需要选择知识库')
    expect(snapshot?.run.lastError).not.toContain('实例已关闭自动回复')
    expect(h.asks).toEqual([])
    expect(h.sends).toEqual([])
  })

  it('配置临时读失败不等于关闭：run 保留并退避重试，恢复后可正常发送', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 402,
      question: '配置恢复后发送',
      debounceMs: 0,
      now: Date.now(),
    })
    saveReplyParts(dir, run.id, ['保留这条'], Date.now())

    let reads = 0
    const h = makeRunner({
      dir,
      config: cfg(),
      readConfig: (slot) => {
        reads += 1
        if (reads === 1) throw new Error('database busy')
        return { ...cfg(), slot }
      },
      ask: async () => ({ ok: true, answer: '不应重新生成' }),
      send: async () => ({ ok: true, id: 902 }),
    })
    h.runner.recover()
    await tick()

    const afterFailure = readReplyRun(dir, run.id)
    expect(afterFailure?.run.status).toBe('ready')
    expect(reads).toBe(1)

    await tick(5_000)
    const finished = readReplyRun(dir, run.id)
    expect(finished?.run.status).toBe('done')
    expect(finished?.parts[0]?.status).toBe('sent')
    expect(h.sends).toHaveLength(1)
  })

  it('不同 slot 的 run 按 slot 公平轮转，不按 run id 连续清空', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const now = Date.now()
    const seeded = [
      { slot: 1, target: 501, text: 'slot1-a' },
      { slot: 2, target: 502, text: 'slot2-a' },
      { slot: 1, target: 503, text: 'slot1-b' },
      { slot: 2, target: 504, text: 'slot2-b' },
    ]
    for (const item of seeded) {
      const run = enqueueOrMergeReplyRun(dir, {
        slot: item.slot,
        targetMessageId: item.target,
        question: item.text,
        debounceMs: 0,
        now,
      })
      saveReplyParts(dir, run.id, [item.text], now)
    }

    const order: number[] = []
    let id = 600
    const h = makeRunner({
      dir,
      config: cfg(),
      ask: async () => { throw new Error('已有 outbox 时不应生成') },
      send: async (slot) => {
        order.push(slot)
        id += 1
        return { ok: true, id }
      },
    })
    h.runner.recover()
    await tick()

    expect(order).toEqual([1, 2, 1, 2])
    expect(listRecoverableReplyRuns(dir, Date.now(), 20)).toEqual([])
  })

  it('恢复预算跨轮保留游标，后续高 id run 不会被永久饿死', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const now = Date.now()
    const total = 7
    for (let index = 0; index < total; index += 1) {
      enqueueOrMergeReplyRun(dir, {
        slot: index + 1,
        targetMessageId: 10_000 + index,
        question: `游标 ${String(index)}`,
        debounceMs: 60_000,
        now,
      })
    }
    const h = makeRunner({
      dir,
      config: cfg(),
      recoveryPageSize: 2,
      recoveryMaxScanPerRound: 2,
      recoveryMaxSchedulesPerRound: 2,
      ask: async () => { throw new Error('远期 run 不应立即生成') },
      send: async () => { throw new Error('远期 run 不应立即发送') },
    })

    for (let round = 1; round <= 4; round += 1) {
      h.runner.recover()
      await flushEventLoop()
      expect(h.runner.pending(), `第 ${String(round)} 轮应继续从游标吸收`).toBe(
        Math.min(round * 2, total),
      )
    }
    expect(h.runner.stats().recovered).toBe(total)
    expect(h.asks).toEqual([])
    expect(h.sends).toEqual([])
  })

  it('恢复预算耗尽后自动短间隔续跑，不再干等完整恢复周期', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const now = Date.now()
    const total = 7
    for (let index = 0; index < total; index += 1) {
      enqueueOrMergeReplyRun(dir, {
        slot: index + 1,
        targetMessageId: 40_000 + index,
        question: `续跑 ${String(index)}`,
        debounceMs: 60_000,
        now,
      })
    }
    const h = makeRunner({
      dir,
      config: cfg(),
      recoverIntervalMs: 0,
      recoveryPageSize: 2,
      recoveryMaxScanPerRound: 2,
      recoveryMaxSchedulesPerRound: 2,
      ask: async () => { throw new Error('远期 run 不应立即生成') },
      send: async () => { throw new Error('远期 run 不应立即发送') },
    })

    h.runner.recover()
    await flushEventLoop()
    expect(h.runner.pending()).toBe(2)

    for (let round = 2; round <= 4; round += 1) {
      await tick(DEFAULT_RECOVERY_CONTINUATION_MS)
      expect(h.runner.pending(), `续跑第 ${String(round)} 轮`).toBe(Math.min(round * 2, total))
    }
    expect(h.runner.stats()).toMatchObject({
      recovered: total,
      recoveryContinuations: 3,
      leaseLost: 0,
    })
  })

  it('恢复预算命中是正常续跑，不污染 lastError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const now = Date.now()
    for (let index = 0; index < 5; index += 1) {
      enqueueOrMergeReplyRun(dir, {
        slot: index + 1,
        targetMessageId: 45_000 + index,
        question: `预算 ${String(index)}`,
        debounceMs: 60_000,
        now,
      })
    }
    const h = makeRunner({
      dir,
      config: cfg(),
      recoverIntervalMs: 0,
      recoveryPageSize: 2,
      recoveryMaxScanPerRound: 2,
      recoveryMaxSchedulesPerRound: 2,
      ask: async () => { throw new Error('远期 run 不应立即生成') },
      send: async () => { throw new Error('远期 run 不应立即发送') },
    })

    h.runner.recover()
    await flushEventLoop()
    expect(h.runner.stats()).toMatchObject({
      recovered: 2,
      recoveryContinuations: 1,
      lastError: null,
    })
  })

  it('恢复页大小超过存储硬上限时不回卷游标，全部高 id 都能调度', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const now = Date.now()
    const total = 1_005
    for (let index = 0; index < total; index += 1) {
      enqueueOrMergeReplyRun(dir, {
        slot: index % 2 + 1,
        targetMessageId: 46_000 + index,
        question: `超限分页 ${String(index)}`,
        debounceMs: 0,
        now,
      })
    }
    const h = makeRunner({
      dir,
      config: cfg(),
      recoverIntervalMs: 0,
      recoveryPageSize: 5_000,
      recoveryMaxScanPerRound: 2_000,
      recoveryMaxSchedulesPerRound: 2_000,
      ask: async () => { throw new Error('远期 run 不应立即生成') },
      send: async () => { throw new Error('远期 run 不应立即发送') },
    })

    h.runner.recover()
    await flushEventLoop(32)
    expect(h.runner.stats()).toMatchObject({
      recovered: total,
      lastError: null,
    })
    expect(h.runner.pending()).toBe(total)
  })

  it('发送心跳发现租约被接管：立即释放等待，晚到的成功结果不回填', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = root()
    const sent = deferred<ClawbotSendResult>()
    const h = makeRunner({
      dir,
      config: cfg(),
      generationLeaseMs: 5_000,
      sendLeaseMs: 300,
      sendTimeoutMs: 10_000,
      ask: async () => ({ ok: true, answer: '只发送一次' }),
      send: () => sent.promise,
    })

    h.runner.consider(1, [msg(50_001, '发送租约丢失')])
    await tick()
    expect(h.sends).toHaveLength(1)
    const runs = listRecoverableReplyRuns(dir, Date.now() + 10_000, 20)
    const runId = runs[0]?.id ?? 0
    expect(runId).toBeGreaterThan(0)

    withWritableDb(clawbotDbPath(dir), (db) => {
      db.prepare(`UPDATE clawbot_reply_run
        SET lease_owner = 'worker-b', lease_fence = lease_fence + 1
        WHERE id = ?`).run(runId)
      db.prepare(`UPDATE clawbot_reply_outbox
        SET lease_owner = 'worker-b', lease_fence = lease_fence + 1
        WHERE run_id = ?`).run(runId)
    })
    await tick(500)
    expect(h.runner.stats()).toMatchObject({ leaseLost: 1, sendSucceeded: 0 })
    expect(h.replies).toEqual([])

    sent.resolve({ ok: true, id: 9_999 })
    await tick()
    expect(h.runner.stats()).toMatchObject({ leaseLost: 1, sendSucceeded: 0 })
    expect(h.replies).toEqual([])
    expect(readReplyRun(dir, runId)).toMatchObject({
      run: { status: 'sending' },
      parts: [{ status: 'sending', sentMessageId: null }],
    })
  })

  it('生成心跳发现租约被接管：晚到答案不写 outbox', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = root()
    const answer = deferred<{ ok: boolean, answer: string, error?: string }>()
    const h = makeRunner({
      dir,
      config: cfg(),
      generationLeaseMs: 300,
      askTimeoutMs: 10_000,
      ask: () => answer.promise,
      send: async () => ({ ok: true, id: 10_001 }),
    })

    h.runner.consider(1, [msg(50_002, '生成租约丢失')])
    await tick()
    expect(h.asks).toHaveLength(1)
    const runs = listRecoverableReplyRuns(dir, Date.now() + 10_000, 20)
    const runId = runs[0]?.id ?? 0
    withWritableDb(clawbotDbPath(dir), (db) => {
      db.prepare(`UPDATE clawbot_reply_run
        SET lease_owner = 'worker-b', lease_fence = lease_fence + 1
        WHERE id = ?`).run(runId)
    })
    await tick(500)
    expect(h.runner.stats()).toMatchObject({ leaseLost: 1, generationSucceeded: 0 })

    answer.resolve({ ok: true, answer: '晚到答案' })
    await tick()
    expect(h.sends).toEqual([])
    expect(readReplyRun(dir, runId)).toMatchObject({ run: { status: 'generating' }, parts: [] })
  })

  it('in-flight run 重复 recover 不会重复登记或虚增 recovered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    let resolveAsk: ((value: { ok: boolean, answer: string, error?: string }) => void) | undefined
    const h = makeRunner({
      dir,
      config: cfg(),
      ask: () => new Promise((resolve) => { resolveAsk = resolve }),
      send: async () => ({ ok: true, id: 1_501 }),
    })

    h.runner.consider(1, [msg(9_001, '恢复期间仍在生成')])
    await tick()
    expect(h.asks).toHaveLength(1)

    for (let round = 0; round < 3; round += 1) {
      h.runner.recover()
      await tick()
    }
    expect(h.asks).toHaveLength(1)
    expect(h.runner.stats()).toMatchObject({
      recovered: 0,
      inFlight: true,
      stage: 'generating',
    })

    resolveAsk?.({ ok: true, answer: '只发送一次' })
    await tick()
    expect(h.sends).toHaveLength(1)
    expect(h.replies).toEqual([{ slot: 1, id: 1_501 }])
  })

  it('审计回调抛错不会中断错误恢复与周期恢复链', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 9_101,
      question: '审计故障恢复',
      debounceMs: 0,
      now: Date.now(),
    })
    saveReplyParts(dir, run.id, ['审计失败仍要发送'], Date.now())

    let reads = 0
    const h = makeRunner({
      dir,
      config: cfg(),
      opThrows: true,
      recoverIntervalMs: 20,
      readConfig: (slot) => {
        reads += 1
        if (reads === 1) throw new Error('config read failed')
        return { ...cfg(), slot }
      },
      ask: async () => ({ ok: true, answer: '不应重新生成' }),
      send: async () => ({ ok: true, id: 1_502 }),
    })

    await tick(20)
    expect(h.sends).toEqual([])
    await tick(5_000)

    expect(h.sends).toHaveLength(1)
    expect(h.replies).toEqual([{ slot: 1, id: 1_502 }])
    expect(readReplyRun(dir, run.id)?.run.status).toBe('done')
  })

  it('ask 超时后释放单飞并按退避重试，不永久卡住其他消息', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const dir = root()
    let asks = 0
    const h = makeRunner({
      dir,
      config: cfg(),
      askTimeoutMs: 50,
      ask: async () => {
        asks += 1
        if (asks === 1) return new Promise<never>(() => { /* 模拟永不返回的模型调用 */ })
        return { ok: true, answer: '超时后恢复' }
      },
      send: async () => ({ ok: true, id: 1_601 }),
    })

    h.runner.consider(1, [msg(9_201, '模型悬挂')])
    await tick()
    expect(h.asks).toHaveLength(1)

    await tick(50)
    await tick(1)
    await tick()
    expect(h.asks).toHaveLength(2)
    expect(h.sends).toHaveLength(1)
    expect(h.replies).toEqual([{ slot: 1, id: 1_601 }])
    expect(h.runner.stats()).toMatchObject({
      generationFailed: 1,
      generationSucceeded: 1,
      sendSucceeded: 1,
    })
  })

  it('send 超时后释放单飞并复用 clientId 重试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const dir = root()
    let sends = 0
    const h = makeRunner({
      dir,
      config: cfg(),
      sendTimeoutMs: 50,
      ask: async () => ({ ok: true, answer: '发送悬挂后重试' }),
      send: async () => {
        sends += 1
        if (sends === 1) return new Promise<never>(() => { /* 模拟永不返回的发送 */ })
        return { ok: true, id: 1_602 }
      },
    })

    h.runner.consider(1, [msg(9_202, '发送悬挂')])
    await tick()
    expect(h.sends).toHaveLength(1)

    await tick(50)
    await tick(1)
    await tick()
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]?.context?.clientId).toBe(h.sends[0]?.context?.clientId)
    expect(h.replies).toEqual([{ slot: 1, id: 1_602 }])
    expect(h.runner.stats()).toMatchObject({ sendRetried: 1, sendSucceeded: 1 })
  })
})

describe('clawbot durable reply：多 runner claim 与心跳', () => {
  it('两个 runner 共用库：生成 lease 阻止重复 ask，长任务心跳避免被提前接管', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = root()
    let resolveAsk: ((value: { ok: boolean, answer: string, error?: string }) => void) | undefined
    const a = makeRunner({
      dir,
      generationLeaseMs: 1_000,
      ask: () => new Promise((resolve) => { resolveAsk = resolve }),
      send: async () => ({ ok: true, id: 8_801 }),
    })
    const b = makeRunner({
      dir,
      generationLeaseMs: 1_000,
      ask: async () => ({ ok: true, answer: 'B 不应生成' }),
      send: async () => ({ ok: true, id: 8_802 }),
    })

    a.runner.consider(1, [msg(2_001, '长任务只生成一次')])
    await tick()
    expect(a.asks).toHaveLength(1)

    // 超过初始 1s 租约后仍持续续租；B 不能接管正在生成的长任务。
    await tick(1_500)
    b.runner.recover()
    await tick()
    expect(b.asks).toEqual([])

    resolveAsk?.({ ok: true, answer: 'A 的答案' })
    await tick()
    expect(a.sends).toHaveLength(1)
    expect(b.sends).toEqual([])
    expect(a.replies).toEqual([{ slot: 1, id: 8_801 }])
  })

  it('两个 runner 共用库：发送 lease 阻止重复出网，长发送期间持续续租', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 2_101,
      question: '只发送一次',
      debounceMs: 0,
      now: Date.now(),
    })
    saveReplyParts(dir, run.id, ['唯一分段'], Date.now())

    let resolveSend: ((value: ClawbotSendResult) => void) | undefined
    const a = makeRunner({
      dir,
      sendLeaseMs: 1_000,
      ask: async () => ({ ok: true, answer: '不应重新生成' }),
      send: () => new Promise((resolve) => { resolveSend = resolve }),
    })
    const b = makeRunner({
      dir,
      sendLeaseMs: 1_000,
      ask: async () => ({ ok: true, answer: '不应重新生成' }),
      send: async () => ({ ok: true, id: 8_902 }),
    })

    a.runner.recover()
    await tick()
    expect(a.sends).toHaveLength(1)

    await tick(1_500)
    b.runner.recover()
    await tick()
    expect(b.sends).toEqual([])

    resolveSend?.({ ok: true, id: 8_901 })
    await tick()
    expect(a.sends).toHaveLength(1)
    expect(a.replies).toEqual([{ slot: 1, id: 8_901 }])
    expect(readReplyRun(dir, run.id)?.run.status).toBe('done')
  })
})

describe('clawbot durable reply：摄入事务', () => {
  it('消息与 run 同事务落库；未调用 consider 时重启 recover 仍能回复', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const ids = insertClawbotMessagesBatch(dir, [{
      slot: 1,
      ts: Date.now(),
      direction: 'in',
      msgType: 'text',
      content: '事务内建任务',
      msgId: 3_001,
    }], {
      replyIntake: { debounceMs: 0, maxPending: 5 },
    })
    expect(ids[0]).toBeGreaterThan(0)
    expect(listRecoverableReplyRuns(dir, Date.now(), 10)).toHaveLength(1)

    // 模拟进程在 insert 之后、consider 之前退出：只靠库里的 run 恢复。
    const h = makeRunner({
      dir,
      ask: async () => ({ ok: true, answer: '事务内恢复' }),
      send: async () => ({ ok: true, id: 9_100 }),
    })
    h.runner.recover()
    await tick()

    expect(h.asks).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
    expect(h.replies).toEqual([{ slot: 1, id: 9_100 }])
  })
})

describe('clawbot durable reply：生命周期取消与恢复吞吐', () => {
  it('discard 取消该 slot 的 durable pending timer，其他 slot 继续', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const h = makeRunner({
      dir,
      config: cfg(),
      ask: async () => ({ ok: true, answer: '继续回复' }),
      send: async () => ({ ok: true, id: 701 }),
    })

    h.runner.consider(1, [msg(1001, '随后取消')])
    expect(h.runner.pending()).toBe(1)
    h.runner.discard(1)
    expect(h.runner.pending()).toBe(0)

    h.runner.consider(2, [msg(1002, '另一个实例')])
    await tick()

    expect(h.sends.map(call => call.slot)).toEqual([2])
    expect(h.replies).toEqual([{ slot: 2, id: 701 }])
  })

  it('discard 取消该 slot 的内存 debounce timer，其他 slot 继续', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const h = makeRunner({
      dir,
      durable: false,
      debounceMs: 1_000,
      ask: async () => ({ ok: true, answer: '内存回复' }),
      send: async () => ({ ok: true, id: 702 }),
    })

    h.runner.consider(1, [msg(1011, '窗口内取消')])
    expect(h.runner.pending()).toBe(1)
    h.runner.discard(1)
    expect(h.runner.pending()).toBe(0)

    h.runner.consider(2, [msg(1012, '另一个实例继续')])
    await tick(1_000)

    expect(h.sends.map(call => call.slot)).toEqual([2])
    expect(h.replies).toEqual([{ slot: 2, id: 702 }])
  })

  it('in-flight ask 在 discard 后晚到，不再保存 outbox', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    let resolveAsk: ((value: { ok: boolean, answer: string, error?: string }) => void) | undefined
    const h = makeRunner({
      dir,
      config: cfg(),
      ask: () => new Promise((resolve) => { resolveAsk = resolve }),
      send: async () => ({ ok: true, id: 703 }),
    })

    h.runner.consider(1, [msg(1021, 'ask 期间取消')])
    await tick()
    expect(h.asks).toHaveLength(1)
    const pending = onlyRun(dir)

    h.runner.discard(1)
    resolveAsk?.({ ok: true, answer: '晚到的答案' })
    await tick()

    const late = readReplyRun(dir, pending.run.id)
    expect(late?.run.status).toBe('generating')
    expect(late?.parts).toEqual([])
    expect(h.sends).toEqual([])
    expect(h.runner.pending()).toBe(0)
  })

  it('in-flight send 在 discard 后晚到，不标记 sent 也不触发 onReplied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    let resolveSend: ((value: ClawbotSendResult) => void) | undefined
    const h = makeRunner({
      dir,
      config: cfg(),
      ask: async () => ({ ok: true, answer: '发送期间取消' }),
      send: () => new Promise((resolve) => { resolveSend = resolve }),
    })

    h.runner.consider(1, [msg(1031, 'send 期间取消')])
    await tick()
    expect(h.sends).toHaveLength(1)
    const pending = onlyRun(dir)
    expect(pending.parts[0]?.status).toBe('sending')

    h.runner.discard(1)
    resolveSend?.({ ok: true, id: 704 })
    await tick()

    const late = readReplyRun(dir, pending.run.id)
    expect(late?.run.status).toBe('sending')
    expect(late?.parts[0]).toMatchObject({ status: 'sending', sentMessageId: null })
    expect(h.replies).toEqual([])
    expect(h.runner.pending()).toBe(0)
  })

  it('images 同步抛错按空上下文降级，不阻断 ask/send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const h = makeRunner({
      dir,
      config: cfg(),
      images: () => { throw new Error('media cache unavailable') },
      ask: async () => ({ ok: true, answer: '无图也能回复' }),
      send: async () => ({ ok: true, id: 705 }),
    })

    h.runner.consider(1, [msg(1041, '读图失败')])
    await tick()

    expect(h.asks).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
    expect(h.replies).toEqual([{ slot: 1, id: 705 }])
  })

  it('超过单页上限的恢复 run 全部被调度', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    const now = Date.now()
    const total = 1_005
    for (let index = 0; index < total; index += 1) {
      enqueueOrMergeReplyRun(dir, {
        slot: index % 2 + 1,
        targetMessageId: 20_000 + index,
        question: `积压 ${String(index)}`,
        debounceMs: 0,
        now,
      })
    }

    const h = makeRunner({
      dir,
      config: cfg(),
      ask: async () => { throw new Error('未来到期的 run 不应立即生成') },
      send: async () => { throw new Error('未来到期的 run 不应立即发送') },
    })
    h.runner.recover()
    await flushEventLoop()

    expect(h.runner.pending()).toBe(total)
    expect(h.asks).toEqual([])
    expect(h.sends).toEqual([])
  })

  it('recoverIntervalMs 周期恢复新积压，dispose 后停止下一轮', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 30_001,
      question: '周期恢复',
      debounceMs: 0,
      now: Date.now(),
    })
    const h = makeRunner({
      dir,
      config: cfg(),
      recoverIntervalMs: 20,
      ask: async () => ({ ok: true, answer: '周期回复' }),
      send: async () => ({ ok: true, id: 801 }),
    })

    await tick(19)
    expect(h.sends).toEqual([])
    expect(h.runner.stats().recovered).toBe(0)

    await tick(1)
    // 恢复扫描先登记 0ms durable timer，再推进一次让到期 timer 真正入队。
    await tick(1)
    await tick()
    expect(h.sends).toHaveLength(1)
    expect(h.runner.stats()).toMatchObject({
      recovered: 1,
      generationSucceeded: 1,
      sendSucceeded: 1,
      lastCompletedAt: expect.any(Number),
    })

    h.runner.dispose()
    const sentBeforeDispose = h.sends.length
    await tick(100)
    expect(h.sends).toHaveLength(sentBeforeDispose)
    expect(h.runner.stats()).toMatchObject({ pending: 0, inFlight: false, stage: 'idle' })
  })

  it('recoverIntervalMs <= 0 禁用周期恢复', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const dir = root()
    enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 30_002,
      question: '禁用周期恢复',
      debounceMs: 0,
      now: Date.now(),
    })
    const h = makeRunner({
      dir,
      config: cfg(),
      recoverIntervalMs: 0,
      ask: async () => ({ ok: true, answer: '不应发送' }),
      send: async () => ({ ok: true, id: 802 }),
    })

    await tick(120_000)
    expect(h.sends).toEqual([])
    expect(h.runner.stats()).toMatchObject({ recovered: 0, pending: 0, stage: 'idle' })
  })
})
