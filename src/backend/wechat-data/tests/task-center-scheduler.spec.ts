// @vitest-environment node
/**
 * 任务触发扫描的**调度器**判据（2026-10-19 提速）。
 *
 * 背景：触发扫描原先只有一颗 30s 定时器，用户感知「触发很慢」。现在：
 *   ① 实时同步回调（有新分片）到达即触发扫描；② 10s 定时器只兜底；
 *   ③ 扫描与回调投递**拆成两个单飞调度器** —— 记录先落库、事件先广播，回调 HTTP
 *      在后台跑；回调地址慢/超时不会把下一拍扫描卡住；
 *   ④ 面板「立即检查」与后台共用扫描单飞，但手动入口额外 await 投递以如实回报条数。
 *
 * 为什么必须有这份 spec：这些性质在界面上都看不出来 ——
 *   · 合并丢了 ⇒ 并发扫描并发投递，外部平台收到两遍；
 *   · 投递塞回扫描 Promise（旧实现）⇒ 一个慢回调能把后续所有触发堵上百秒；
 *   · 事件没发 ⇒ 记录已落库，但面板要等下一次微信同步（约 10s）才显示。
 *
 * 判据不靠计时（CI 机器慢会误报），而是数 stub 调用次数、看事件账本与 Promise 结算顺序。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import type { TaskTriggerScanResult } from '../src/types.ts'

let scratch = ''
let decrypted = ''
let decoded = ''
let disposers: Array<() => void> = []
let events: Array<{ name: string; args: unknown[] }> = []

/** 与 `emoticon-batch.spec.ts` 同款的最小 Cordis Context 面，额外记录 emit。 */
function fakeCtx(): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    emit: (name: string, ...args: unknown[]) => { events.push({ name, args }) },
  } as unknown as Context
}

interface TaskDispatchOutcome {
  dispatched: number
  failed: number
  errors?: string[]
}

/** 调度器内部面（生产代码是 protected，测试用同一套显式形状取用）。 */
interface TaskScanInternals {
  _taskCenterRemotes?: {
    scanOnce: () => TaskTriggerScanResult
    dispatchPending: () => Promise<TaskDispatchOutcome>
  }
  scheduleTaskTriggerScan: () => Promise<TaskTriggerScanResult>
  scheduleTaskDispatch: () => Promise<TaskDispatchOutcome>
  scanTaskTriggers: () => Promise<TaskTriggerScanResult>
}

function result(over: Partial<TaskTriggerScanResult> = {}): TaskTriggerScanResult {
  return { ok: true, tasks: 1, scanned: 1, created: 0, dispatched: 0, ...over }
}

const noDispatch = async (): Promise<TaskDispatchOutcome> => ({ dispatched: 0, failed: 0 })

function gatewayWith(
  scanOnce: () => TaskTriggerScanResult,
  dispatchPending: () => Promise<TaskDispatchOutcome> = noDispatch,
): TaskScanInternals {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  vi.stubEnv('DSH_WECHAT_BASE_DIR', '')
  const gw = new WechatDataGateway(fakeCtx()) as unknown as TaskScanInternals
  gw._taskCenterRemotes = { scanOnce, dispatchPending }
  return gw
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wx-task-scan-'))
  decrypted = join(scratch, 'decrypted')
  decoded = join(scratch, 'decoded')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
  disposers = []
  events = []
})

afterEach(() => {
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

describe('任务触发扫描调度器（提速后的单飞/合并）', () => {
  it('扫描进行中再触发只算一个 pending，结束后补跑一次（不会并发开库）', async () => {
    let calls = 0
    const gw = gatewayWith(() => {
      calls += 1
      return result({ created: 1 })
    })
    const a = gw.scheduleTaskTriggerScan()
    const b = gw.scheduleTaskTriggerScan()
    expect(b, '第二次调用应复用同一个进行中的扫描 promise').toBe(a)
    expect(calls, '扫描进行中不该再开一拍').toBe(1)
    await a
    await flush()
    expect(calls, '结束后没有补跑被合并掉的那一拍').toBe(2)
  })

  it('记录落库后立刻广播，不等回调投递（慢 HTTP 不拖慢面板）', async () => {
    let resolveDispatch: ((d: TaskDispatchOutcome) => void) | null = null
    const slowDispatch = new Promise<TaskDispatchOutcome>((resolve) => { resolveDispatch = resolve })
    const gw = gatewayWith(() => result({ created: 2 }), () => slowDispatch)

    const scanPromise = gw.scheduleTaskTriggerScan()
    await scanPromise
    expect(events, '扫描完成时应立刻广播记录已变（不等投递）').toEqual([
      { name: 'task-center/updated', args: [{ created: 2, dispatched: 0 }] },
    ])
    // 先抓住正在跑的那一拍投递（不通过 scheduleTaskDispatch 再请求一次，否则会置 pending
    // 并在结束后补跑一拍，测试自己造出第二次投递/第二条事件）。
    const inFlight = (gw as unknown as { _taskDispatch: Promise<TaskDispatchOutcome> | null })._taskDispatch
    expect(inFlight, '扫描后应立即在后台开始投递').not.toBeNull()

    resolveDispatch!({ dispatched: 1, failed: 0 })
    await inFlight
    expect(events).toEqual([
      { name: 'task-center/updated', args: [{ created: 2, dispatched: 0 }] },
      { name: 'task-center/updated', args: [{ created: 0, dispatched: 1 }] },
    ])
  })

  it('手动「立即检查」额外 await 投递并合并 dispatched（后台节拍不等）', async () => {
    const gw = gatewayWith(() => result({ created: 1 }), async () => ({ dispatched: 1, failed: 0 }))
    const r = await gw.scanTaskTriggers()
    expect(r.created).toBe(1)
    expect(r.dispatched, '手动入口没把投递结果合并回来').toBe(1)
    expect(events).toContainEqual({ name: 'task-center/updated', args: [{ created: 1, dispatched: 0 }] })
    expect(events).toContainEqual({ name: 'task-center/updated', args: [{ created: 0, dispatched: 1 }] })
  })

  it('没有新建记录、也没有投递成功时不广播事件（避免面板无意义回源）', async () => {
    const gw = gatewayWith(() => result({ created: 0 }))
    await gw.scheduleTaskTriggerScan()
    await flush()
    expect(events, '空扫描不该发 task-center/updated').toEqual([])
  })

  it('扫描抛错不把调度器卡死，也不会写脏事件', async () => {
    let calls = 0
    const gw = gatewayWith(() => {
      calls += 1
      if (calls === 1) throw new Error('库被占用')
      return result({ created: 1 })
    })
    const first = await gw.scheduleTaskTriggerScan()
    expect(first.ok, '异常应转换成 ok:false 结果而不是抛出').toBe(false)
    expect(first.error).toContain('库被占用')
    const second = await gw.scheduleTaskTriggerScan()
    expect(second.ok).toBe(true)
    expect(second.created).toBe(1)
    expect(events).toEqual([{ name: 'task-center/updated', args: [{ created: 1, dispatched: 0 }] }])
  })

  it('投递抛错不把调度器卡死：转成 failed 摘要，下一拍仍能正常跑', async () => {
    let dispatchCalls = 0
    const gw = gatewayWith(
      () => result({ created: 0 }),
      async () => {
        dispatchCalls += 1
        if (dispatchCalls === 1) throw new Error('回调地址不可达')
        return { dispatched: 1, failed: 0 }
      },
    )
    const bad = await gw.scheduleTaskDispatch()
    expect(bad.dispatched).toBe(0)
    expect(bad.errors?.[0]).toContain('回调地址不可达')
    const good = await gw.scheduleTaskDispatch()
    expect(good.dispatched).toBe(1)
    expect(events).toEqual([{ name: 'task-center/updated', args: [{ created: 0, dispatched: 1 }] }])
  })
})

describe('接入接线（源码级）：不许退回「只靠 30s 定时器」', () => {
  const CORE = readFileSync(new URL('../src/gateway-core.ts', import.meta.url), 'utf8')

  it('实时同步回调里直接触发扫描（source of truth 不是定时器）', () => {
    const start = CORE.indexOf('startRealtimeSync(')
    const end = CORE.indexOf("'wechat-data: realtime sync'")
    expect(start, '找不到 startRealtimeSync 接线').toBeGreaterThan(-1)
    expect(end, '找不到实时同步的 effect 收尾').toBeGreaterThan(start)
    const block = CORE.slice(start, end)
    expect(block, '同步回调没有触发扫描 ⇒ 又只能等定时器').toContain('scanTaskTriggersBackground')
    expect(block, '触发扫描必须只在真的有分片变化时做').toContain('synced.length > 0')
  })

  it('兜底定时器用 SYNC_INTERVAL_MS（10s），不是退回 30s', () => {
    expect(CORE).toContain('setInterval(() => { this.scanTaskTriggersBackground() }, SYNC_INTERVAL_MS)')
    expect(CORE, '扫描兜底定时器又写回 30s 了').not.toContain('scanTaskTriggersBackground() }, 30_000)')
  })
})
