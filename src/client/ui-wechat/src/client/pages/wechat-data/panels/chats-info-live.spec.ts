// @vitest-environment jsdom
/**
 * `chats-info-live.ts` 的行为守卫（2026-10-13，聊天信息抽屉的实时刷新）。
 *
 * 这一族决定「抽屉开着时，数据落地后界面会不会自己变」——几条约定一旦被顺手改掉
 * 都会**静默不报错**：
 *  · 宿主数据事件不重取 ⇒ 「群成员数 / 公告 / 设置」停在打开那一刻（本次修掉的缺陷）；
 *  · 不订阅 `dsh-snapshot-refreshed:group` ⇒ 第一次重取命中 60s TTL 内的旧缓存，
 *    后台复验落地的**新值没人画**，界面仍停在旧数上；
 *  · 落地闸（`infoRefreshApplies` + epoch）被拿掉 ⇒ 事件后切了会话，旧群的响应
 *    会盖到新群的抽屉头上（与消息流「归属不符只给骨架」同一条规矩）；
 *  · 刷新失败改成报错 ⇒ 一次抖动就把用户正看着的正确数据换成红色错误。
 *
 * 测试环境口径：`fire` 系辅助一律**串行全 await**——把事件派发、越过 300ms 合并窗、
 * 恢复真计时器分成独立 await 的阶段，不让未 await 的 act 交错（交错会让后续的
 * `act(render)` 静默不生效，实测踩过：守卫全对、断言照样红）。
 */
import { createElement, useRef, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupInfo } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  apiGetGroupInfo: vi.fn(),
  // chats-info-live.ts 从 '../api.ts' 取这个常量拼事件名；mock 整模块时必须照真值供。
  SNAPSHOT_REFRESHED_EVENT: 'dsh-snapshot-refreshed',
}))
vi.mock('../api.ts', () => mocks)

const { infoRefreshApplies, useGroupInfoLive } = await import('./chats-info-live.ts')

const G1 = { name: '群一', members: [] } as unknown as GroupInfo
const G2 = { name: '群二', members: [] } as unknown as GroupInfo

interface Bag { open: boolean; talker: string | null; epoch: number }
let bag: Bag = { open: true, talker: 'wxid_group_a', epoch: 7 }
let lastGroup: GroupInfo | null = null
let lastErr: string | null = null

function Harness(): React.JSX.Element {
  const talkerRef = useRef<string | null>(bag.talker)
  talkerRef.current = bag.talker
  const epochRef = useRef(bag.epoch)
  epochRef.current = bag.epoch
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null)
  // 初值非空：让「刷新成功后清掉上一次的错误」这件事可观察（null → null 看不出有没有做）。
  const [groupInfoErr, setGroupInfoErr] = useState<string | null>('旧错误')
  lastGroup = groupInfo
  lastErr = groupInfoErr
  useGroupInfoLive({
    open: bag.open,
    talkerRef,
    sessionAlive: (e, t) => epochRef.current === e && talkerRef.current === t,
    sessionEpochRef: epochRef,
    setGroupInfo,
    setGroupInfoErr,
  })
  return createElement('div', { 'data-group': groupInfo === null ? 'none' : 'has', 'data-err': groupInfoErr ?? '' })
}

let host: HTMLDivElement
let root: Root
const render = (): void => { act(() => { root.render(createElement(Harness)) }) }
const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve() })
}
/** 派发一条数据事件，串行越过 `useWechatDataUpdated` 的 300ms 合并窗。 */
const fire = async (event: string): Promise<void> => {
  vi.useFakeTimers()
  act(() => { window.dispatchEvent(new Event(event)) })
  await act(async () => { vi.advanceTimersByTime(320) })
  vi.useRealTimers()
  await flush()
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiGetGroupInfo.mockReset()
  mocks.apiGetGroupInfo.mockResolvedValue({ group: G1 })
  bag = { open: true, talker: 'wxid_group_a', epoch: 7 }
  lastGroup = null
  lastErr = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.useRealTimers()
})

describe('落地闸 infoRefreshApplies（两个抽屉共用的归属校验）', () => {
  it('开着且没切走才落地；关掉 / 切走 / 空 talker 都丢弃', () => {
    expect(infoRefreshApplies(true, 'a', 'a')).toBe(true)
    expect(infoRefreshApplies(false, 'a', 'a'), '抽屉被关掉也要丢弃').toBe(false)
    expect(infoRefreshApplies(true, 'a', 'b'), '会话切走要丢弃').toBe(false)
    expect(infoRefreshApplies(true, null, 'a'), '空 talker 要丢弃').toBe(false)
  })
})

describe('群信息抽屉的实时刷新', () => {
  it('开着时宿主数据事件 ⇒ 按当前会话静默重取并写回，顺带清掉上次的错误', async () => {
    render()
    mocks.apiGetGroupInfo.mockResolvedValue({ group: G2 })
    await fire('dsh-wechat-data-updated')
    expect(mocks.apiGetGroupInfo).toHaveBeenCalledTimes(1)
    expect(mocks.apiGetGroupInfo).toHaveBeenCalledWith('wxid_group_a')
    expect(lastGroup, '新快照没有写回状态').toBe(G2)
    expect(lastErr, '成功后上一次的错误必须清掉（失败抽屉自愈）').toBeNull()
  })

  it('关着时事件一律不取数（不白打后端；重开抽屉会自己重取）', async () => {
    bag.open = false
    render()
    await fire('dsh-wechat-data-updated')
    expect(mocks.apiGetGroupInfo).not.toHaveBeenCalled()
  })

  it('群信息缓存刷新广播也会重取（60s TTL 内的旧缓存靠这条广播顶新）', async () => {
    render()
    await fire('dsh-snapshot-refreshed:group')
    expect(mocks.apiGetGroupInfo).toHaveBeenCalledTimes(1)
  })

  it('响应到达前切走会话 ⇒ 旧响应丢弃（A 群的数据不许盖到 B 群头上）', async () => {
    render()
    let late: ((v: { group: GroupInfo }) => void) | null = null
    mocks.apiGetGroupInfo.mockReturnValueOnce(new Promise((res) => { late = res }))
    vi.useFakeTimers()
    act(() => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
    await act(async () => { vi.advanceTimersByTime(320) })
    vi.useRealTimers()
    await act(async () => { await Promise.resolve() })
    bag.talker = 'wxid_group_b'
    bag.epoch += 1
    render()
    await act(async () => { late?.({ group: G1 }); await Promise.resolve(); await Promise.resolve() })
    await flush()
    expect(lastGroup, '切走后旧响应仍落地了').toBeNull()
  })

  it('刷新失败保留旧值、也不报错吓人（下一次事件再试）', async () => {
    render()
    await fire('dsh-wechat-data-updated')
    expect(lastGroup).toBe(G1)
    mocks.apiGetGroupInfo.mockRejectedValueOnce(new Error('抖动'))
    await fire('dsh-wechat-data-updated')
    expect(lastGroup, '一次失败就把旧快照丢了').toBe(G1)
    expect(lastErr, '静默刷新不该动错误状态').toBeNull()
  })
})
