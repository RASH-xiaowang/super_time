/**
 * 远程调用的**并发闸**判据。
 *
 * ## 为什么这条闸值得单独立用例
 *
 * 后端 worker 是单线程的，手机与桌面**共用它**。本机已经踩过一次独占事故：
 * 同步 whisper 转写把毫秒级的 `getSessions` 顶到 2202ms，用户报「消息很慢、会话列表更慢」，
 * 真凶是排队排在重活后面。远程访问把这件事放大 —— 手机上一个 10 分钟档的长任务
 * 就能让桌面端整体卡死，而桌面端用户看不出是谁干的。
 *
 * 这道闸失效的方式也是静默的：上限写错、`active` 计数漏减（一个任务抛错就永久占位）、
 * 队列无上限（请求无声堆积，手机上表现为「一直转圈」）。所以三条都要钉。
 *
 * @vitest-environment node
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const queueMod = require(join(ROOT, 'src', 'backend', 'http-queue.js')) as {
  REMOTE_CALL_CONCURRENCY: number
  REMOTE_QUEUE_MAX: number
  HEAVY_QUEUE_MAX: number
  createCallQueue: (opts?: { concurrency?: number, maxQueued?: number, maxQueuedHeavy?: number, waitTimeoutMs?: number, now?: () => number }) => {
    run: (task: () => unknown, meta?: { channel?: string, method?: string, priority?: number }) => Promise<unknown>
    drain: (reason?: string, channel?: string) => number
    stats: () => {
      active: number
      queued: number
      rejected: number
      concurrency: number
      maxQueued: number
      maxQueuedHeavy?: number
      queuedHeavy?: number
      completed: number
      failed: number
      channels: Record<string, { rejected: number, completed: number, failed: number, active: number, queued: number }>
      activeCalls: Array<{ channel: string, method: string, waitMs: number, elapsedMs: number }>
      queuedCalls: Array<{ channel: string, method: string, waitMs: number }>
      waitTimeoutMs?: number
      waitTimedOut?: number
      activeHeavy?: number
      heavyLimit?: number
      wait: { count: number, totalMs: number, maxMs: number, p50Ms: number, p95Ms: number }
      execution: { count: number, totalMs: number, maxMs: number, p50Ms: number, p95Ms: number }
    }
  }
}

/** 一个可控的延迟任务：手动放行，用来观察并发数。 */
function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('并发闸：上限、计数归还、排队与拒绝', () => {
  it('缺省上限是 2（1 等于串行、4 以上开始与桌面端抢 worker）', () => {
    expect(queueMod.REMOTE_CALL_CONCURRENCY).toBe(2)
    const q = queueMod.createCallQueue()
    expect(q.stats().concurrency).toBe(2)
    expect(q.stats().maxQueued).toBe(queueMod.REMOTE_QUEUE_MAX)
  })

  it('同时在跑的任务数不会超过上限，其余排队', async () => {
    const q = queueMod.createCallQueue({ concurrency: 2 })
    // 逐个建而不是建数组再索引：`noUncheckedIndexedAccess` 下 `gates[0]` 会是 possibly-undefined
    const g0 = deferred()
    const g1 = deferred()
    const g2 = deferred()
    const g3 = deferred()
    const gates = [g0, g1, g2, g3]
    const started: number[] = []
    const runs = gates.map((g, i) => q.run(async () => { started.push(i); await g.promise; return i }))
    // 让微任务跑一轮：前两个应该已经启动，后两个还在排队
    await Promise.resolve()
    await Promise.resolve()
    expect(started, '前两个任务应当立刻启动').toEqual([0, 1])
    expect(q.stats()).toMatchObject({ active: 2, queued: 2 })

    g0.resolve()
    await runs[0]
    await Promise.resolve()
    await Promise.resolve()
    expect(started, '一个跑完就该放下一个进来（否则上限会变成「一次性配额」）').toEqual([0, 1, 2])
    expect(q.stats().active).toBe(2)

    for (const g of gates) g.resolve()
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3])
    expect(q.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('任务**抛错**也要归还名额（否则一次异常就永久占掉一个位子，队列慢慢卡死）', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    await expect(q.run(() => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(q.stats().active, '抛错后名额没归还').toBe(0)
    // 后续任务仍然能跑
    await expect(q.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('任务是**同步抛错**时同样归还名额', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    await expect(q.run(() => { throw new Error('sync boom') })).rejects.toThrow('sync boom')
    expect(q.stats().active).toBe(0)
    await expect(q.run(async () => 1)).resolves.toBe(1)
  })

  it('队列满时立刻拒（带 REMOTE_BUSY），而不是让请求无声堆积', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1, maxQueued: 2 })
    const gate = deferred()
    const running = q.run(() => gate.promise)
    const queued1 = q.run(async () => 'q1')
    const queued2 = q.run(async () => 'q2')
    await Promise.resolve()
    // 第 4 个：1 个在跑 + 2 个在排队 = 已满
    // 用 holder 而不是裸变量：裸 `let err = null` 会被 TS 的控制流分析钉死成 null
    // （回调里的赋值它不跟），随后 `expect(err).not.toBeNull()` 把它收窄成 never。
    const holder: { err?: Error & { code?: string } } = {}
    await q.run(async () => 'overflow').catch((e: Error & { code?: string }) => { holder.err = e })
    expect(holder.err?.code, '队列满了却还在收（应当立刻拒并带 REMOTE_BUSY）').toBe('REMOTE_BUSY')
    expect(holder.err?.message, '错误信息要能让人看懂是「太密集」而不是「坏了」').toContain('远程调用太密集')
    expect(q.stats().rejected).toBe(1)

    gate.resolve()
    await running
    expect(await Promise.all([queued1, queued2])).toEqual(['q1', 'q2'])
  })

  it('排队等待超时后明确拒（QUEUE_WAIT_TIMEOUT），不让请求无限转圈', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1, waitTimeoutMs: 20 })
    const gate = deferred()
    const running = q.run(() => gate.promise, { channel: 'remote', method: 'long' })
    const holder: { err?: Error & { code?: string } } = {}
    const queued = q.run(async () => 'never', { channel: 'remote', method: 'queued' })
      .catch((e: Error & { code?: string }) => { holder.err = e })
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 45))
    expect(holder.err?.code).toBe('QUEUE_WAIT_TIMEOUT')
    expect(holder.err?.message).toContain('排队等待超时')
    expect(q.stats().waitTimedOut).toBe(1)
    expect(q.stats().queued).toBe(0)
    gate.resolve()
    await running
    await queued
  })

  it('等待超时 timer 会在正常出队时撤销（不会迟到再拒一次）', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1, waitTimeoutMs: 20 })
    let release!: () => void
    const running = q.run(() => new Promise<void>((resolve) => { release = resolve }), { method: 'long' })
    const result = q.run(async () => 'ok', { method: 'queued' })
    await Promise.resolve()
    await Promise.resolve()
    release()
    await running
    await expect(result).resolves.toBe('ok')
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect(q.stats().waitTimedOut).toBe(0)
  })

  it('队列满时交互请求可以挤出低优先级排队项，取消动作不会被低优先级任务堵死', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1, maxQueued: 2 })
    const gate = deferred()
    const order: string[] = []
    const running = q.run(async () => { await gate.promise; order.push('running') })
    const low1 = q.run(async () => { order.push('low1') }, { method: 'exportAllSessions' })
    const low2 = q.run(async () => { order.push('low2') }, { method: 'exportAllSessions' })
    await Promise.resolve()
    await Promise.resolve()

    const control = q.run(async () => { order.push('control') }, { method: 'getSessions', priority: 0 })
    await Promise.resolve()
    await Promise.resolve()

    const holder: { err?: Error & { code?: string } } = {}
    await low2.catch((e: Error & { code?: string }) => { holder.err = e })
    expect(holder.err?.code, '被挤出的低优先级任务必须明确拿到 REMOTE_BUSY').toBe('REMOTE_BUSY')
    expect(q.stats().queued).toBe(2)
    expect(q.stats().queuedCalls.map((item) => item.method)).toEqual(['getSessions', 'exportAllSessions'])

    gate.resolve()
    await running
    await Promise.all([control, low1])
    expect(order, '交互请求应先于仍在队列里的低优先级任务执行').toEqual(['running', 'control', 'low1'])
  })

  it('drain 清掉排队中的请求并给出原因，已在跑的不动', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    const gate = deferred()
    const running = q.run(() => gate.promise)
    const queued = q.run(async () => 'never')
    await Promise.resolve()
    const drained = q.drain('服务要停了')
    expect(drained, '应当只清掉排队中的那一个').toBe(1)
    const holder: { err?: Error & { code?: string } } = {}
    await queued.catch((e: Error & { code?: string }) => { holder.err = e })
    expect(holder.err?.code).toBe('REMOTE_GONE')
    expect(holder.err?.message).toBe('服务要停了')
    expect(q.stats().queued).toBe(0)
    gate.resolve()
    await expect(running, '已在跑的任务不该被 drain 打断').resolves.toBeUndefined()
  })

  it('FIFO：先排队的先跑（不是 LIFO —— 那会让第一个请求等到最后）', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    const gate = deferred()
    const order: string[] = []
    const running = q.run(async () => { await gate.promise; order.push('first') })
    const rest = ['a', 'b', 'c', 'd'].map((k) => q.run(async () => { order.push(k) }))
    await Promise.resolve()
    gate.resolve()
    await running
    await Promise.all(rest)
    expect(order).toEqual(['first', 'a', 'b', 'c', 'd'])
  })

  it('重活最多只占一个并发名额，另一个名额留给普通/交互调用', async () => {
    const q = queueMod.createCallQueue({ concurrency: 2 })
    const heavyA = deferred()
    const heavyB = deferred()
    const fast = deferred()
    const started: string[] = []
    const runs = [
      q.run(async () => { started.push('heavy-a'); await heavyA.promise }, { method: 'exportAllSessions', priority: 2 }),
      q.run(async () => { started.push('heavy-b'); await heavyB.promise }, { method: 'fetchOriginalImagesBatch', priority: 2 }),
      q.run(async () => { started.push('fast'); await fast.promise }, { method: 'getSessions', priority: 0 }),
    ]
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['heavy-a', 'fast'])
    expect(q.stats()).toMatchObject({ active: 2, activeHeavy: 1, queued: 1, heavyLimit: 1 })
    expect(q.stats().queuedCalls[0]?.method).toBe('fetchOriginalImagesBatch')

    heavyA.resolve()
    fast.resolve()
    await Promise.all([runs[0], runs[2]])
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['heavy-a', 'fast', 'heavy-b'])
    heavyB.resolve()
    await runs[1]
    expect(q.stats().activeHeavy).toBe(0)
  })

  it('重活排队有独立上界：不能把整条队列都用 10 分钟任务填满', async () => {
    expect(queueMod.HEAVY_QUEUE_MAX).toBe(4)
    const q = queueMod.createCallQueue({ concurrency: 1, maxQueued: 32, maxQueuedHeavy: 2 })
    const gate = deferred()
    const running = q.run(() => gate.promise, { method: 'exportAllSessions' })
    const queuedHeavy = [
      q.run(async () => 'heavy-1', { method: 'askWechat' }),
      q.run(async () => 'heavy-2', { method: 'getAnnual' }),
    ]
    await Promise.resolve()
    await Promise.resolve()
    const holder: { err?: Error & { code?: string } } = {}
    await q.run(async () => 'overflow', { method: 'generateDailySummary' })
      .catch((e: Error & { code?: string }) => { holder.err = e })
    expect(holder.err?.code).toBe('REMOTE_BUSY')
    expect(q.stats().queuedHeavy).toBe(2)
    expect(q.stats().maxQueuedHeavy).toBe(2)
    gate.resolve()
    await running
    expect(await Promise.all(queuedHeavy)).toEqual(['heavy-1', 'heavy-2'])
  })

  it('同优先级仍保持 FIFO（优先级只重排不同档，不改写同档先后）', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    const gate = deferred()
    const order: string[] = []
    const running = q.run(async () => { await gate.promise; order.push('first') }, { method: 'getSessions', priority: 0 })
    const rest = ['a', 'b'].map((k) => q.run(async () => { order.push(k) }, { method: 'getContacts', priority: 0 }))
    await Promise.resolve()
    gate.resolve()
    await running
    await Promise.all(rest)
    expect(order).toEqual(['first', 'a', 'b'])
  })

  it('非法的 concurrency / maxQueued 退回缺省值（配置错了不该变成 0 并发或直接不收）', () => {
    expect(queueMod.createCallQueue({ concurrency: 0 }).stats().concurrency).toBe(queueMod.REMOTE_CALL_CONCURRENCY)
    expect(queueMod.createCallQueue({ concurrency: -3 }).stats().concurrency).toBe(queueMod.REMOTE_CALL_CONCURRENCY)
    expect(queueMod.createCallQueue({ concurrency: Number.NaN }).stats().concurrency).toBe(queueMod.REMOTE_CALL_CONCURRENCY)
    expect(queueMod.createCallQueue({ maxQueued: -1 }).stats().maxQueued).toBe(queueMod.REMOTE_QUEUE_MAX)
    // maxQueued = 0 是合法的（一个都不排）
    expect(queueMod.createCallQueue({ maxQueued: 0 }).stats().maxQueued).toBe(0)
  })
})

describe('共享通道：桌面与远程同闸，停掉远程服务不能误伤桌面排队项', () => {
  it('meta 进入当前/排队快照，drain 只清指定通道', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    const gate = deferred()
    const remoteRunning = q.run(() => gate.promise, { channel: 'remote', method: 'getSessions' })
    const remoteQueued = q.run(async () => 'remote-next', { channel: 'remote', method: 'getMessages' })
    const desktopQueued = q.run(async () => 'desktop-next', { channel: 'desktop', method: 'getOverview' })
    await Promise.resolve()
    await Promise.resolve()

    expect(q.stats().activeCalls[0]).toMatchObject({ channel: 'remote', method: 'getSessions' })
    expect(q.stats().queuedCalls).toEqual([
      expect.objectContaining({ channel: 'remote', method: 'getMessages' }),
      expect.objectContaining({ channel: 'desktop', method: 'getOverview' }),
    ])
    expect(q.stats().channels.remote).toMatchObject({ active: 1, queued: 1 })
    expect(q.stats().channels.desktop).toMatchObject({ active: 0, queued: 1 })

    expect(q.drain('远程服务关闭', 'remote')).toBe(1)
    expect(q.stats().channels.remote?.queued).toBe(0)
    expect(q.stats().channels.desktop?.queued).toBe(1)

    const holder: { err?: Error & { code?: string } } = {}
    await remoteQueued.catch((e: Error & { code?: string }) => { holder.err = e })
    expect(holder.err?.code).toBe('REMOTE_GONE')
    gate.resolve()
    await remoteRunning
    expect(await desktopQueued).toBe('desktop-next')
  })

  it('用注入时钟记录排队与执行时延，而不是把统计绑在墙上时钟上', async () => {
    let clock = 0
    const q = queueMod.createCallQueue({ concurrency: 1, now: () => clock })
    const gate = deferred()
    const first = q.run(() => gate.promise, { channel: 'remote', method: 'slow' })
    const second = q.run(async () => 'fast', { channel: 'desktop', method: 'fast' })
    await Promise.resolve()
    await Promise.resolve()

    clock += 120
    expect(q.stats().queuedCalls[0]?.waitMs).toBe(120)
    gate.resolve()
    await first
    await second

    const stats = q.stats()
    expect(stats.completed).toBe(2)
    expect(stats.wait.count).toBe(2)
    expect(stats.wait.maxMs).toBe(120)
    expect(stats.wait.p95Ms).toBe(120)
    expect(stats.channels.desktop).toMatchObject({ completed: 1, failed: 0 })
  })

  it('失败按通道记账，供诊断端点区分桌面与手机的问题来源', async () => {
    const q = queueMod.createCallQueue({ concurrency: 1 })
    await expect(q.run(() => { throw new Error('boom') }, { channel: 'remote', method: 'bad' }))
      .rejects.toThrow('boom')
    expect(q.stats().failed).toBe(1)
    expect(q.stats().channels.remote).toMatchObject({ failed: 1, completed: 0 })
  })
})
