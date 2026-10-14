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
  createCallQueue: (opts?: { concurrency?: number, maxQueued?: number }) => {
    run: (task: () => unknown) => Promise<unknown>
    drain: (reason?: string) => number
    stats: () => { active: number, queued: number, rejected: number, concurrency: number, maxQueued: number }
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

  it('非法的 concurrency / maxQueued 退回缺省值（配置错了不该变成 0 并发或直接不收）', () => {
    expect(queueMod.createCallQueue({ concurrency: 0 }).stats().concurrency).toBe(queueMod.REMOTE_CALL_CONCURRENCY)
    expect(queueMod.createCallQueue({ concurrency: -3 }).stats().concurrency).toBe(queueMod.REMOTE_CALL_CONCURRENCY)
    expect(queueMod.createCallQueue({ concurrency: Number.NaN }).stats().concurrency).toBe(queueMod.REMOTE_CALL_CONCURRENCY)
    expect(queueMod.createCallQueue({ maxQueued: -1 }).stats().maxQueued).toBe(queueMod.REMOTE_QUEUE_MAX)
    // maxQueued = 0 是合法的（一个都不排）
    expect(queueMod.createCallQueue({ maxQueued: 0 }).stats().maxQueued).toBe(0)
  })
})
