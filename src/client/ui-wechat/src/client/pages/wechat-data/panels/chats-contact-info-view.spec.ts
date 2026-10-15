// @vitest-environment jsdom
/**
 * 单聊「聊天信息」抽屉的行为守卫（2026-10-13 实时刷新；骨架部分同 chats-group-info-view.spec.ts）。
 *
 * 本次只钉「实时刷新」这一族（抽屉是自包含组件：取数、落地闸、订阅都在组件内）：
 *  · 开着时宿主数据事件 ⇒ **静默**重取 360 统计并重绘 —— 不订阅的话，
 *    「消息总数 / 最近联系」停在打开那一刻（与群聊抽屉同族缺陷）；
 *  · 关着时事件一律不取数；
 *  · 事件后的响应到达时已切到别的会话 ⇒ 旧响应丢弃（A 的统计不许盖到 B 的抽屉里）。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact360Snapshot, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { ChatsContactInfoView } from './chats-contact-info-view.tsx'

const mocks = vi.hoisted(() => ({
  apiGetContact360: vi.fn(),
  // 抽屉里的 Avatar 会经它取头像；mock 掉避免真 remote（'wechat-data remote not installed'）。
  apiGetAvatarBatched: vi.fn(),
}))
vi.mock('../api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api.ts')>()
  return { ...mod, apiGetContact360: mocks.apiGetContact360, apiGetAvatarBatched: mocks.apiGetAvatarBatched }
})

const SESSION_A = { username: 'wxid_a', type: 'private', displayName: 'A' } as WechatSession
const SESSION_B = { username: 'wxid_b', type: 'private', displayName: 'B' } as WechatSession
const snap = (username: string, count: number): Contact360Snapshot => ({
  username,
  displayName: username === 'wxid_a' ? 'A' : 'B',
  messages: { count, firstTime: 1000, lastTime: 2000 },
  moments: { count: 1 },
  funds: { transfers: 0, redpackets: 0 },
  commonGroups: [],
  updatedAt: 0,
})

let propsBag: { open: boolean; session: WechatSession | null; onClose: () => void; onExport: () => void }
let host: HTMLDivElement
let root: Root
const render = (): void => { act(() => { root.render(createElement(ChatsContactInfoView, propsBag)) }) }
const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve() })
}
const text = (): string => host.textContent ?? ''
/** 派发宿主数据事件并越过 `useWechatDataUpdated` 的 300ms 合并窗。 */
const fireUpdated = async (): Promise<void> => {
  vi.useFakeTimers()
  act(() => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
  await act(async () => { vi.advanceTimersByTime(320) })
  vi.useRealTimers()
  await flush()
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiGetContact360.mockReset()
  mocks.apiGetAvatarBatched.mockReset()
  mocks.apiGetAvatarBatched.mockResolvedValue({ kind: 'none' })
  mocks.apiGetContact360.mockResolvedValue(snap('wxid_a', 91))
  propsBag = { open: true, session: SESSION_A, onClose: vi.fn(), onExport: vi.fn() }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

describe('单聊「聊天信息」的实时刷新', () => {
  it('打开即取一次，并画出本机统计', async () => {
    mocks.apiGetContact360.mockResolvedValue(snap('wxid_a', 91))
    render()
    await flush()
    expect(mocks.apiGetContact360).toHaveBeenCalledWith('wxid_a')
    expect(text()).toContain('91')
  })

  it('开着时宿主数据事件 ⇒ 静默重取并重绘统计', async () => {
    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_a', 91))
    render()
    await flush()
    expect(text()).toContain('91')
    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_a', 77))
    await fireUpdated()
    expect(mocks.apiGetContact360, '数据事件后必须重新取数').toHaveBeenCalledTimes(2)
    expect(text(), '新统计没有重绘（停在打开那一刻）').toContain('77')
  })

  it('抽屉关着 ⇒ 事件不取数', async () => {
    propsBag.open = false
    render()
    await flush()
    mocks.apiGetContact360.mockClear()
    await fireUpdated()
    expect(mocks.apiGetContact360).not.toHaveBeenCalled()
  })

  it('事件后的响应到达时已切到别的会话 ⇒ 旧响应丢弃', async () => {
    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_a', 91))
    render()
    await flush()
    expect(text()).toContain('91')
    let late: ((v: Contact360Snapshot) => void) | null = null
    mocks.apiGetContact360.mockReturnValueOnce(new Promise((res) => { late = res }))
    vi.useFakeTimers()
    act(() => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
    await act(async () => { vi.advanceTimersByTime(320) })
    vi.useRealTimers()
    await act(async () => { await Promise.resolve() })
    expect(mocks.apiGetContact360).toHaveBeenCalledTimes(2)
    // 事件已触发、响应未到：切到 B（打开即重取 B，抽屉此时显示 B 的数据）
    propsBag.session = SESSION_B
    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_b', 42))
    render()
    await flush()
    expect(text()).toContain('42')
    await act(async () => { late?.(snap('wxid_a', 66)); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(text(), 'A 的旧响应盖到了 B 的抽屉上').toContain('42')
    expect(text(), 'A 的旧响应盖到了 B 的抽屉上').not.toContain('66')
  })

  it('静默刷新失败保留旧值、不把错误端给用户', async () => {
    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_a', 91))
    render()
    await flush()
    mocks.apiGetContact360.mockRejectedValueOnce(new Error('抖动'))
    await fireUpdated()
    expect(text(), '一次失败就把旧统计丢了').toContain('91')
    expect(host.querySelector('[role="alert"]'), '静默刷新失败不该弹错误').toBeNull()
  })
})
