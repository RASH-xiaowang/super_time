// @vitest-environment node
/**
 * N27 验收：host 侧 `submitAskFeedback` 的重复提交必须只产生一次副作用。
 *
 * 为什么判据是**反馈条数**而不是「代码里有没有闸」：副作用（多一条反馈记录、按重复特征
 * 重算一次权重、多一条审计）全是可观测的落盘结果，条数是最直接的信号。前端闸门（N17）
 * 只管同一个面板的连点，两个面板同时提交 / 旧版客户端重试 / 直接 RPC 调用都落到 host。
 *
 * 注意这里的「并发」是**同一轮被提交两次**：`submitAskFeedback` 是同步 RPC，函数体一口气
 * 跑完，两个调用不会交错（所以在飞 Promise 表那种写法在这里永远为空 —— 实现里写明了为什么
 * 没用它）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { listOperations } from '../src/query/operation-log.ts'

let root = ''
let decrypted = ''
let decoded = ''
let disposers: Array<() => void> = []

/** Minimal Cordis Context surface the gateway touches at construction/test time. */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

/** 建一个指向临时数据根的网关（每次重新解析 env）。 */
function gateway(): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  return new WechatDataGateway(fakeCtx())
}

/** 同一轮反馈的两次提交（retrievalId/评分/引用/答案全同）。 */
const SUBMIT = {
  retrievalId: 'r-turn-1',
  rating: 'up' as const,
  useful: [1],
  useless: [] as number[],
  question: '上周和谁聊过装修',
  answer: '根据本机记录……',
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-wechat-n27-'))
  decrypted = join(root, 'decrypted')
  decoded = join(root, 'decoded_images')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
})

afterEach(() => {
  for (const d of disposers) d()
  disposers = []
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('N27：host 侧反馈去重', () => {
  it('同一轮提交两次 → 只落一条反馈，第二次是可读的「已在处理」', () => {
    const gw = gateway()
    const first = gw.submitAskFeedback({ ...SUBMIT })
    expect(first.ok).toBe(true)
    expect(first.adaptedWeights).toBeTruthy()

    const second = gw.submitAskFeedback({ ...SUBMIT })
    expect(second.ok).toBe(false)
    expect(second.message ?? '').toContain('已在处理')

    // 副作用只发生一次：反馈库一条、权重适配一次（第二次没进到这里）。
    const snap = gw.listRetrievalFeedback()
    expect(snap.items.length).toBe(1)
    expect(snap.stats.total).toBe(1)
    // 审计留痕也要能看出「这次被挡了」，否则事后查不出重复提交发生过。
    const ops = listOperations(decrypted).items.filter(o => o.action === 'ask_feedback')
    expect(ops.length).toBe(2)
    expect(ops.filter(o => o.detail?.includes('重复提交')).length).toBe(1)
  })

  it('换评分 / 换标注集合是**另一次**反馈（闸不能变成「永久只收一条」）', () => {
    const gw = gateway()
    expect(gw.submitAskFeedback({ ...SUBMIT }).ok).toBe(true)
    // 同轮改成「没用」：键含 rating，必须放行
    expect(gw.submitAskFeedback({ ...SUBMIT, rating: 'down' }).ok).toBe(true)
    // 同轮同评分但标注集合变了：键含引用序号，也必须放行
    expect(gw.submitAskFeedback({ ...SUBMIT, useless: [2] }).ok).toBe(true)
    expect(gw.listRetrievalFeedback().items.length).toBe(3)
  })

  it('窗口过后同一轮可以重新提交（闸是「窗口」不是「一次性」）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const gw = gateway()
    expect(gw.submitAskFeedback({ ...SUBMIT }).ok).toBe(true)
    expect(gw.submitAskFeedback({ ...SUBMIT }).ok).toBe(false)
    vi.advanceTimersByTime(11_000)
    expect(gw.submitAskFeedback({ ...SUBMIT }).ok).toBe(true)
    expect(gw.listRetrievalFeedback().items.length).toBe(2)
  })

  it('没有 retrievalId 的不同轮次不会被同一条键误挡（键里带答案片段）', () => {
    const gw = gateway()
    const a = { rating: 'up' as const, useful: [1], useless: [] as number[], question: '第一轮', answer: '回答甲' }
    const b = { rating: 'up' as const, useful: [1], useless: [] as number[], question: '第二轮', answer: '回答乙' }
    expect(gw.submitAskFeedback(a).ok).toBe(true)
    expect(gw.submitAskFeedback(b).ok).toBe(true)
    expect(gw.listRetrievalFeedback().items.length).toBe(2)
  })
})
