/**
 * 附件自动取回队列守卫（`query/clawbot/clawbot-media-queue.ts`）。
 *
 * 队列的失效全是**静默**的：顺序乱（日志读不懂）、失败无限重试（断网时刷爆日志）、
 * 永久失败反复下载（一次 32MB 白流量 × 每次启动）、重复入队把同一张图取两遍。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  CLAWBOT_MEDIA_SWEEP_LIMIT,
  MAX_MEDIA_ATTEMPTS,
  createClawbotMediaQueue,
} from '../src/query/clawbot/clawbot-media-queue.ts'
import type { ClawbotMediaOutcome } from '../src/query/clawbot/clawbot-media.ts'

const OK: ClawbotMediaOutcome = { ok: true, path: 'C:/cache/1-image.png', kind: 'image', name: null, bytes: 3 }

describe('clawbot-media-queue', () => {
  it('顺序逐条取回、成功计数、重复入队去重', async () => {
    const order: number[] = []
    const q = createClawbotMediaQueue({
      listPending: () => [],
      ensure: async (id) => { order.push(id); await Promise.resolve(); return OK },
    })
    q.enqueue([3, 1, 2, 1])
    await q.idle()
    expect(order).toEqual([3, 1, 2])
    expect(q.state()).toMatchObject({ done: 3, failed: 0, running: false, queued: 0 })
  })

  it('可重试错误：同一次运行最多试 MAX 次，用尽后计 failed、留日志、不再入队', async () => {
    // 上限是**产品决定**（3 次）：钉成字面量，防止「把常数一起改大」把用例骗绿。
    expect(MAX_MEDIA_ATTEMPTS, '重试上限是产品决定，改它要连用例一起改').toBe(3)
    let calls = 0
    const logs: string[] = []
    const q = createClawbotMediaQueue({
      listPending: () => [],
      log: (m) => logs.push(m),
      ensure: async () => { calls += 1; return { ok: false, error: '网络断了' } },
    })
    q.enqueue([7])
    await q.idle()
    expect(calls).toBe(3)
    expect(q.state()).toMatchObject({ failed: 1, lastError: '网络断了' })
    expect(logs.some((l) => l.includes(`连续 ${String(MAX_MEDIA_ATTEMPTS)} 次`) && l.includes('#7'))).toBe(true)
    // 用尽后再入队被跳过（不然下一批消息会把它又拖起来打）。
    q.enqueue([7])
    await q.idle()
    expect(calls).toBe(3)
  })

  it('permanent 错误一次即计失败、不再重试（超限/解密坏/白名单拒）', async () => {
    let calls = 0
    const logs: string[] = []
    const q = createClawbotMediaQueue({
      listPending: () => [],
      log: (m) => logs.push(m),
      ensure: async () => { calls += 1; return { ok: false, error: '附件体积超过上限', permanent: true } },
    })
    q.enqueue([9])
    await q.idle()
    expect(calls).toBe(1)
    expect(q.state().failed).toBe(1)
    expect(logs.some((l) => l.includes('不重试'))).toBe(true)
    q.enqueue([9])
    await q.idle()
    expect(calls).toBe(1)
  })

  it('sweep 按上限清点并入队；idle 在空队列时立即返回', async () => {
    const asked: number[] = []
    const taken: number[] = []
    const q = createClawbotMediaQueue({
      listPending: (limit) => { asked.push(limit); return [41, 42] },
      ensure: async (id) => { taken.push(id); return OK },
    })
    await q.idle() // 空队列：立即
    q.sweep()
    await q.idle()
    expect(asked).toEqual([CLAWBOT_MEDIA_SWEEP_LIMIT])
    expect(taken).toEqual([41, 42])
  })

  it('ensure 抛出的异常按可重试错误处理（注入实现的不慎不该让队列死了）', async () => {
    let calls = 0
    const q = createClawbotMediaQueue({
      listPending: () => [],
      ensure: async () => { calls += 1; throw new Error('boom') },
    })
    q.enqueue([5])
    await q.idle()
    expect(calls).toBe(MAX_MEDIA_ATTEMPTS)
    expect(q.state().lastError).toBe('boom')
  })
})
