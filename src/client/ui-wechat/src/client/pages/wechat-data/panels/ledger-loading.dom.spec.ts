/**
 * 「资金账本」首次统计的加载态守卫（**确定性**验证，不赌后端快慢）。
 *
 * 背景：这一页原来在首次统计时只渲染一行字「正在统计资金账本…」——
 * 实测在 802px 的内容区里留下 608px 连续空白（占比 84%），而且没有任何进度信息：
 * 后端是同步 SQLite，本页查询会排在「总览」的全量统计（扫 21 万条消息）后面，
 * 排队时用户完全无法区分"在跑"还是"卡死"。
 *
 * 为什么不用真机探针来验这一条：本机后端通常在 400–550ms 就返回，抢不到那个慢窗口
 * （试过把 window.electronAPI.wechat.call 换成延迟实现，但应用在启动时已经取过桥面引用，
 * 换不掉）。所以这里用 jsdom 直接把 apiGetLedger 挂成**永不 resolve**，
 * 让面板稳定停在"首次统计"这一帧，再断言它渲染的是不是完整的加载态。
 * @vitest-environment jsdom
 */
import React, { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'

// 永不 resolve：面板会一直停在"首次统计、无缓存"这一帧
vi.mock('../api.ts', () => ({
  apiGetLedger: vi.fn(() => new Promise(() => { /* 永远挂起 */ })),
  readRenderCache: vi.fn(() => null),
  writeRenderCache: vi.fn(() => { /* 不写 */ }),
}))

const { LedgerPanel } = await import('./Ledger.tsx')

async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => { setTimeout(r, 0) })
}

const cleanups: Array<() => void> = []
afterEach(() => { for (const fn of cleanups.splice(0)) fn() })

async function renderPanel(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  cleanups.push(() => { root.unmount(); host.remove() })
  root.render(h(LedgerPanel))
  await flush()
  return host
}

describe('资金账本：首次统计的加载态是有结构的，不是一行字', () => {
  it('给出走秒 + 骨架 + 为什么可能偏慢，而不是干等', async () => {
    const host = await renderPanel()
    const text = host.textContent ?? ''

    // ① 明确的加载文案 + 已用时间
    expect(text, '缺少加载文案').toContain('正在统计资金账本')
    expect(text, '加载文案里没有走秒').toMatch(/已用\s*\d+s/)
    // ② 解释为什么可能偏慢（后端同步、会排在总览统计后面）
    expect(text, '没有解释耗时原因').toContain('首次统计要解析本机全部消息')
    // ③ 与真实布局同形的骨架（ListSkeleton 用的是 .nm-skel 占位条）
    expect(host.querySelectorAll('.nm-skel').length, '没有骨架占位').toBeGreaterThan(6)
    // ④ 加载条这一结构本身存在（用属性子串匹配哈希后的类名）
    expect(host.querySelector('[class*="loadingBar"]'), '缺少加载条容器').toBeTruthy()
  })

  it('加载期间不渲染任何金额（避免把 0 当成真实数据）', async () => {
    const host = await renderPanel()
    const text = host.textContent ?? ''
    expect(text).not.toContain('总收入')
    expect(text).not.toContain('¥')
  })

  it('本页没有缓存、但总览已缓存过账本快照时，直接先渲染出来（不再干等一次全量统计）', async () => {
    // 总览把「全部月份」的账本快照写在这个键下（字段与本页同构）
    localStorage.setItem('dsh-wechat-overview-ledger-v1', JSON.stringify({
      month: null,
      summary: {
        transfers: 13, transferIn: 3, transferOut: 10,
        transferAmountIn: 1800, transferAmountOut: 2400,
        redpacketsSent: 2, redpacketsReceived: 5,
        redpacketAmountSent: 100, redpacketAmountReceived: 320,
        totalAmountIn: 2120, totalAmountOut: 2500,
      },
      byContact: [{ username: 'wxid_x', name: '李四', direction: 'out', count: 2, amount: 300 }],
      redpacket: { sentCount: 2, receivedCount: 5, sentAmount: 100, receivedAmount: 320, bestAmount: 88, avgAmount: 64 },
      warnings: [],
    }))
    const host = await renderPanel()
    const text = host.textContent ?? ''
    cleanups.push(() => { localStorage.removeItem('dsh-wechat-overview-ledger-v1') })
    // 即使 apiGetLedger 永远挂着，也应该立刻看到总览那份数据
    expect(text, '没有用上总览的缓存').toContain('总收入')
    expect(text).toContain('2,120.00')
    expect(text, '仍在显示加载态').not.toContain('正在统计资金账本')
  })
})
