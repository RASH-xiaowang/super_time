/**
 * P2-5：`readRenderCache` 的保质期、大小上限与**可见的**写失败。
 *
 * 旧写法三件事都没有：无 TTL、无上限、写失败静默。后果不是抽象的「不够健壮」，
 * 而是审查记录的那个具体症状 —— 一份大对象挤爆 localStorage 配额（5–10 MB）之后，
 * **某些面板的首屏加速莫名消失**，界面上没有任何地方说得出原因。
 *
 * 这一层的定位是「可随时丢弃的秒出图缓存」，不是离线数据：
 * 所以过保、过大、配额满三种情况一律「丢掉 + 说一次」，宁可慢一次也不画旧东西。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRenderCache, writeRenderCache } from './cache.ts'

const PREFIX = 'wxdata-render-cache:'
const DAY_MS = 24 * 60 * 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('保质期与格式', () => {
  it('写进去读得回来，且存的是带时间的信封（没有时间的条目无法判旧不旧）', () => {
    writeRenderCache('chats', { items: [1, 2] })
    expect(readRenderCache('chats')).toEqual({ items: [1, 2] })
    const env = JSON.parse(String(localStorage.getItem(PREFIX + 'chats'))) as { at: number; v: unknown }
    expect(typeof env.at).toBe('number')
    expect(env.v).toEqual({ items: [1, 2] })
  })

  it('超过 24 小时 ⇒ 判过期，并且**顺手删掉**（不许一直占配额）', () => {
    writeRenderCache('moments', { items: ['昨天'] })
    vi.advanceTimersByTime(DAY_MS + 1)
    expect(readRenderCache('moments')).toBeNull()
    expect(localStorage.getItem(PREFIX + 'moments'), '过期条目留在 localStorage 里 = 白占配额').toBeNull()
  })

  it('旧版裸值（没有时间戳）当过期丢掉，不猜它的年龄', () => {
    localStorage.setItem(PREFIX + 'legacy', JSON.stringify({ items: ['不知道哪年的'] }))
    expect(readRenderCache('legacy')).toBeNull()
    expect(localStorage.getItem(PREFIX + 'legacy')).toBeNull()
  })

  it('损坏的 JSON 与「没有这一条」同样是未命中（不许抛出去）', () => {
    localStorage.setItem(PREFIX + 'broken', '{not json')
    expect(readRenderCache('broken')).toBeNull()
  })
})

describe('上限与写失败可见', () => {
  it('单条过大 ⇒ 不写，并且说明首屏加速对它关闭（只播一次）', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const big = { text: 'x'.repeat(2_000_000) }
    writeRenderCache('overview', big)
    expect(localStorage.getItem(PREFIX + 'overview')).toBeNull()
    expect(info.mock.calls.map(c => String(c[0])).join('\n')).toContain('单条过大')
    writeRenderCache('overview2', big)
    writeRenderCache('overview3', big)
    expect(info.mock.calls.filter(c => String(c[0]).includes('单条过大')).length, '每次都刷屏 = 噪声，会被人关掉').toBe(1)
  })

  it('配额写满 ⇒ 清掉本层全部条目并说一次原因（症状「首屏加速莫名消失」必须变成有原因）', () => {
    writeRenderCache('a', { ok: 1 })
    writeRenderCache('b', { ok: 2 })
    expect(readRenderCache('a')).toEqual({ ok: 1 })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const boom = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    writeRenderCache('c', { ok: 3 })
    boom.mockRestore()
    expect(info.mock.calls.map(c => String(c[0])).join('\n')).toContain('配额')
    // 丢掉之后读不到，但键也真的不在了（下一次写能成功）
    expect(localStorage.getItem(PREFIX + 'a')).toBeNull()
    expect(localStorage.getItem(PREFIX + 'b')).toBeNull()
    writeRenderCache('d', { ok: 4 })
    expect(readRenderCache('d')).toEqual({ ok: 4 })
    expect(info.mock.calls.filter(c => String(c[0]).includes('配额')).length).toBe(1)
  })

  it('正常路径一条都不许多说（防「告警变噪声」）', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    writeRenderCache('normal', { ok: 1 })
    expect(readRenderCache('normal')).toEqual({ ok: 1 })
    expect(info).not.toHaveBeenCalled()
  })
})
