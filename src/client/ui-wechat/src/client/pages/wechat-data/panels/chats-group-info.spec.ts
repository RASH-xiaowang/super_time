// @vitest-environment jsdom
/**
 * 群成员浮层的 150ms 延迟关闭计时器必须随面板卸载一起清掉。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatsGroupInfo } from './chats-group-info.tsx'

vi.mock('./chats-info-live.ts', () => ({
  groupInfoRequestGateFor: () => ({ current: 0 }),
  useGroupInfoLive: () => undefined,
}))

type GroupInfoApi = ReturnType<typeof useChatsGroupInfo>

let host: HTMLDivElement
let root: Root
let latest: GroupInfoApi | null = null

function Probe(): React.JSX.Element {
  latest = useChatsGroupInfo({
    talkerRef: { current: null },
    sessionAlive: () => true,
    sessionEpochRef: { current: 0 },
  })
  return createElement('div', { 'data-probe': '' })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  latest = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('useChatsGroupInfo 卸载清理', () => {
  it('成员浮层的延迟关闭计时器不会越过卸载点', () => {
    act(() => { root.render(createElement(Probe)) })
    act(() => { latest?.hideMemberProfile() })
    expect(vi.getTimerCount()).toBe(1)

    act(() => { root.unmount() })
    expect(vi.getTimerCount(), '卸载后仍留着成员浮层关闭计时器').toBe(0)

    root = createRoot(host)
  })
})
