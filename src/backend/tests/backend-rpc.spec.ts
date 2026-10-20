/**
 * 后端 RPC 通道的超时与死亡收敛，以及长任务名单与 gateway 的一致性。
 *
 * 这些分支原先只能靠手工 taskkill 观察（逻辑住在 Electron 主进程里），
 * 抽到 src/backend/backend-rpc.js 后用假 child 就能确定性覆盖。
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { gatewayClassSource } from './gateway-source.ts'// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { callTimeoutFor, createWorkerChannel, LONG_CALL_METHODS } from '../backend-rpc.js'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { HEAVY_CALL_LEDGER } from '../remote-policy.js'

/** 最小的 utilityProcess 替身：能收能发能被杀。 */
class FakeChild extends EventEmitter {
  posted: Array<{ id: number; type: string; payload: unknown }> = []
  killed = false
  throwOnPost = false

  postMessage(msg: { id: number; type: string; payload: unknown }): void {
    if (this.throwOnPost) throw new Error('post failed: 进程已退出')
    this.posted.push(msg)
  }

  kill(): void { this.killed = true }

  /** 回包（value 形式）。 */
  reply(id: number, value: unknown): void { this.emit('message', { id, value }) }
  /** 回包（error 形式）。 */
  replyError(id: number, message: string): void { this.emit('message', { id, error: { message } }) }
  /** 取消回执（type:'canceled'）。 */
  cancelAck(id: number, value: unknown): void { this.emit('message', { id, type: 'canceled', value }) }
  /** 进程退出。 */
  exit(code = 1): void { this.emit('exit', code) }
}

const silentLogger = { warn: () => {}, error: () => {}, log: () => {} }

function makeChannel(timeoutMs = 30, extra: Record<string, unknown> = {}) {
  const child = new FakeChild()
  const channel = createWorkerChannel(child, {
    callTimeoutMs: timeoutMs,
    longTimeoutMs: timeoutMs * 10,
    logger: silentLogger,
    ...extra,
  })
  return { child, channel }
}

/** 跑完 dispose 握手（含回包/超时）的辅助等待。 */
const settle = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

const heavyLedger = HEAVY_CALL_LEDGER as ReadonlyArray<{ why: string; methods: readonly string[] }>

describe('LONG_CALL_METHODS 与 gateway 的一致性', () => {
  // 直接从源码抽 @Remote 名单。写错方法名不会报任何错、只会让该方法静默退回 60s 窗口，
  // 而 60s 对导出/解密/LLM 这类任务明显不够 —— 必须由测试挡住。
  const gatewaySrc = gatewayClassSource()
  const remoteNames = new Set(
    [...gatewaySrc.matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1] as string),
  )

  it('gateway 里能抽到 @Remote 名单（防止正则失效后测试变成空转）', () => {
    expect(remoteNames.size).toBeGreaterThan(100)
  })

  it('长任务名单里每个名字都是真实存在的 @Remote 方法', () => {
    const bogus = [...LONG_CALL_METHODS].filter((m) => !remoteNames.has(m))
    expect(bogus).toEqual([])
  })

  it('【反向】台账必须与 LONG_CALL_METHODS 完全相等 —— 漏登记一个重方法不会有任何其它报错', () => {
    const ledger = heavyLedger.flatMap((g) => [...g.methods])
    // 下限只是「防止台账被清空后这条断言变成空转」；真正的判据是下面两个差集。
    expect(ledger.length, '台账被清空了？').toBeGreaterThanOrEqual(45)
    expect(new Set(ledger).size, '台账里有重复条目').toBe(ledger.length)

    const missing = ledger.filter((m) => !LONG_CALL_METHODS.has(m)).sort()
    expect(missing, '这些重方法会静默退回 60s 窗口，线上被 RPC 误杀成「调用超时」').toEqual([])

    const unclassified = [...LONG_CALL_METHODS].filter((m) => !ledger.includes(m)).sort()
    expect(unclassified, '新增的长任务没有写进台账分类（说明它为什么算重活）').toEqual([])
  })

  it('【反向】台账点名的方法都必须是真实存在的 @Remote（防点名打错字变成空转）', () => {
    const ledger = heavyLedger.flatMap((g) => [...g.methods])
    expect(ledger.filter((m) => !remoteNames.has(m))).toEqual([])
  })

  it('LLM 长任务拿到宽窗口，普通查询拿到默认窗口', () => {
    // 仓库自身 LLM 超时默认 120s（wechat-host.js），RPC 窗口必须宽于它。
    expect(callTimeoutFor('askWechat', { callTimeoutMs: 60_000, longTimeoutMs: 600_000 })).toBe(600_000)
    expect(callTimeoutFor('runSummaryTask', { callTimeoutMs: 60_000, longTimeoutMs: 600_000 })).toBe(600_000)
    expect(callTimeoutFor('getSessions', { callTimeoutMs: 60_000, longTimeoutMs: 600_000 })).toBe(60_000)
  })
})

describe('createWorkerChannel · 正常路径', () => {
  it('回包后 resolve，并携带同一个 id', async () => {
    const { child, channel } = makeChannel()
    const p = channel.call('getSessions', [])
    expect(child.posted).toHaveLength(1)
    expect(child.posted[0]?.type).toBe('call')
    child.reply(child.posted[0]!.id, { items: [1, 2] })
    await expect(p).resolves.toEqual({ items: [1, 2] })
    expect(channel.pendingCount).toBe(0)
  })

  it('error 形式回包转成 reject', async () => {
    const { child, channel } = makeChannel()
    const p = channel.call('boom', [])
    child.replyError(child.posted[0]!.id, '数据库打不开')
    await expect(p).rejects.toThrow('数据库打不开')
    expect(channel.pendingCount).toBe(0)
  })

  it('事件消息转给 onEvent，且 onEvent 抛异常不影响后续回包', async () => {
    const seen: Array<[string, unknown]> = []
    const { child, channel } = makeChannel(30, {
      onEvent: (name: string, args: unknown) => {
        seen.push([name, args])
        throw new Error('订阅方炸了')
      },
    })
    child.emit('message', { type: 'event', name: 'wechat-data/updated', args: [1] })
    expect(seen).toEqual([['wechat-data/updated', [1]]])
    const p = channel.call('getSessions', [])
    child.reply(child.posted[0]!.id, 'ok')
    await expect(p).resolves.toBe('ok')
  })
})

describe('createWorkerChannel · 超时', () => {
  it('永不回包时按窗口 reject，信息含「调用超时」与方法名', async () => {
    const { channel } = makeChannel(30)
    const err = await channel.call('getSnsImageDataUrl', []).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('调用超时')
    expect(err!.message).toContain('getSnsImageDataUrl')
  })

  it('超时后在途数回落为 0（不会一直占着 id）', async () => {
    const { channel } = makeChannel(20)
    const p = channel.call('slow', []).catch(() => undefined)
    expect(channel.pendingCount).toBe(1)
    await p
    expect(channel.pendingCount).toBe(0)
  })

  it('迟到的回包被丢弃：只 settle 一次，也不产生二次 reject', async () => {
    const { child, channel } = makeChannel(20)
    const settled: string[] = []
    const p = channel.call('slow', []).then(
      () => { settled.push('resolved') },
      () => { settled.push('rejected') },
    )
    await p
    // 超时之后再回包：必须被静默丢弃
    child.reply(child.posted[0]!.id, 'too-late')
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toEqual(['rejected'])
    expect(channel.pendingCount).toBe(0)
    expect(channel.stats().orphanCompletions).toBe(1)
  })

  it('超时后把原 method/args 交给 worker 的 cancel 消息（尽力中止带 jobId 的活）', async () => {
    const { child, channel } = makeChannel(20)
    const args = [{ jobId: 'job-7', other: 1 }]
    await channel.call('exportAllSessions', args).catch(() => undefined)
    const cancel = child.posted.find((m) => m.type === 'cancel')
    expect(cancel).toBeTruthy()
    expect(cancel).toMatchObject({
      type: 'cancel',
      payload: { method: 'exportAllSessions', args },
    })
    expect(channel.stats().cancelsSent).toBe(1)
    expect(channel.stats().timedOut).toBe(1)
  })

  it('取消回执 ok 才算收敛，迟到回包不再计幽灵完成', async () => {
    const { child, channel } = makeChannel(20)
    await channel.call('searchMessages', [{ jobId: 'search-1' }]).catch(() => undefined)
    child.cancelAck(child.posted[0]!.id, { ok: true, method: 'cancelSearch', jobId: 'search-1' })
    child.reply(child.posted[0]!.id, { cancelled: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(channel.stats().cancelsAcknowledged).toBe(1)
    expect(channel.stats().orphanCompletions).toBe(0)
    expect(channel.stats().orphanedCalls).toEqual([])
  })

  it('取消回执 ok:false 仍保留幽灵账，等迟到回包记成孤儿完成', async () => {
    const { child, channel } = makeChannel(20)
    await channel.call('getSessions', []).catch(() => undefined)
    child.cancelAck(child.posted[0]!.id, { ok: false, reason: 'no-job-id' })
    child.reply(child.posted[0]!.id, 'too-late')
    await new Promise((r) => setTimeout(r, 10))
    expect(channel.stats().cancelsAcknowledged).toBe(0)
    expect(channel.stats().orphanCompletions).toBe(1)
    expect(channel.stats().orphanedCalls).toEqual([])
  })

  it('worker 在超时后已退出时，取消发送失败也不影响超时收敛', async () => {
    const { child, channel } = makeChannel(20)
    const p = channel.call('slow', []).catch((e: Error) => e)
    child.throwOnPost = true
    const err = await p
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('调用超时')
    expect(channel.pendingCount).toBe(0)
    expect(channel.stats().cancelsSent).toBe(0)
  })

  it('长任务方法用更宽的窗口（callTimeoutFor）', () => {
    expect(callTimeoutFor('exportAllSessions', { callTimeoutMs: 1000, longTimeoutMs: 9000 })).toBe(9000)
    expect(callTimeoutFor('getSessions', { callTimeoutMs: 1000, longTimeoutMs: 9000 })).toBe(1000)
  })

  it('毫秒级窗口的提示写成毫秒而非「0 秒」', async () => {
    const { channel } = makeChannel(1)
    const err = await channel.call('tiny', []).then(() => null, (e: Error) => e)
    expect(err!.message).toContain('1 毫秒')
  })
})

describe('createWorkerChannel · 进程死亡', () => {
  it('在途请求以退出原因 reject，且 onExit 被调用一次', async () => {
    const onExit = vi.fn()
    const { child, channel } = makeChannel(5000, { onExit })
    const p = channel.call('getSessions', [])
    child.exit(7)
    await expect(p).rejects.toThrow('已退出')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit.mock.calls[0]?.[0]).toBe(7)
    expect(channel.pendingCount).toBe(0)
    expect(channel.isDead).toBe(true)
  })

  it('重复的 exit 事件只处理一次', async () => {
    const onExit = vi.fn()
    const { child, channel } = makeChannel(5000, { onExit })
    channel.call('x', []).catch(() => undefined)
    child.exit(1)
    child.exit(1)
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('死亡后的新调用立刻 reject，不进入 pending', async () => {
    const { child, channel } = makeChannel(5000)
    child.exit(0)
    await expect(channel.call('anything', [])).rejects.toThrow('已退出')
    expect(channel.pendingCount).toBe(0)
  })

  it('postMessage 抛错（进程刚死）时立即 reject 且不留 pending', async () => {
    const { child, channel } = makeChannel(5000)
    child.throwOnPost = true
    await expect(channel.call('getSessions', [])).rejects.toThrow('post failed')
    expect(channel.pendingCount).toBe(0)
  })

  it('dispose 先等 worker 回包再 kill（收尾不能被信号截断）', async () => {
    const { child, channel } = makeChannel(5000)
    let disposed = false
    channel.dispose(() => { disposed = true })
    // 发出去了，但还没回包：此时绝不能 kill
    expect(child.posted.some((m) => m.type === 'dispose')).toBe(true)
    expect(child.killed).toBe(false)
    expect(disposed).toBe(false)
    expect(channel.pendingCount).toBe(1)
    // worker 做完收尾回包，才允许 kill + 通知调用方
    child.reply(child.posted[0]!.id, { ok: true })
    await new Promise((r) => setTimeout(r, 10))
    expect(child.killed).toBe(true)
    expect(disposed).toBe(true)
    expect(channel.pendingCount).toBe(0)
  })

  it('dispose 回包晚到/不到时按超时上限兜底 kill（退出路径不能挂住）', async () => {
    const { child, channel } = makeChannel(5000, { disposeTimeoutMs: 30 })
    let disposed = false
    channel.dispose(() => { disposed = true })
    expect(child.killed).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(child.killed).toBe(true)
    expect(disposed).toBe(true)
    expect(channel.pendingCount).toBe(0)
  })

  it('dispose 时 worker 已死（postMessage 抛错）也立刻收摊', () => {
    const { child, channel } = makeChannel(5000)
    child.throwOnPost = true
    let disposed = false
    channel.dispose(() => { disposed = true })
    expect(child.killed).toBe(true)
    expect(disposed).toBe(true)
    expect(channel.pendingCount).toBe(0)
  })

  it('dispose 需要回调：漏传直接抛错（防止静默退回「发完就 kill」）', () => {
    const { channel } = makeChannel(5000)
    // backend-rpc.js 是 CommonJS 无类型声明，这里直接验证运行期参数契约。
    expect(() => channel.dispose()).toThrow(TypeError)
  })

  it('dispose 在 worker 回包前就 exit，也不会二次 kill 或漏通知', async () => {
    const { child, channel } = makeChannel(5000)
    let disposed = 0
    channel.dispose(() => { disposed += 1 })
    child.exit(0)
    await new Promise((r) => setTimeout(r, 10))
    // 死亡路径 failAll 已 reject 掉在途请求（含 dispose），回调仍然只跑一次
    expect(disposed).toBe(1)
    expect(channel.pendingCount).toBe(0)
  })
})
