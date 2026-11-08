// @vitest-environment jsdom
/**
 * 原图收割的进度轮询必须服从组件生命周期。
 *
 * 手动收割可能持续一分钟；如果面板在请求中途关闭，旧实现的 1.5 秒 interval 仍会
 * 一直查到收割结束，并在已卸载的组件上写 status。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGetOriginalHarvestStatus: vi.fn(),
  apiOriginalHarvest: vi.fn(),
}))

vi.mock('../api.ts', () => mocks)

const { useOriginalHarvest } = await import('./use-original-harvest.ts')
type Harvest = ReturnType<typeof useOriginalHarvest>

let host: HTMLDivElement
let root: Root
let latest: Harvest | null = null
let notify: ReturnType<typeof vi.fn>

function Probe(): React.JSX.Element {
  latest = useOriginalHarvest(notify as Parameters<typeof useOriginalHarvest>[0])
  return createElement('div', { 'data-probe': '' })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  mocks.apiGetOriginalHarvestStatus.mockReset().mockResolvedValue({ running: false })
  mocks.apiOriginalHarvest.mockReset()
  notify = vi.fn()
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

describe('useOriginalHarvest 的进度轮询', () => {
  it('收割请求未返回时卸载：interval 立即清空，迟到结果不再通知', async () => {
    let finishHarvest!: (value: { harvested: number; failed: number; errors: never[] }) => void
    mocks.apiOriginalHarvest.mockReturnValue(new Promise((resolve) => { finishHarvest = resolve }))

    act(() => { root.render(createElement(Probe)) })
    await flush()
    const initialStatusCalls = mocks.apiGetOriginalHarvestStatus.mock.calls.length

    act(() => { void latest?.run('now') })
    expect(vi.getTimerCount(), '收割期间没有启动 1.5 秒进度轮询').toBe(1)

    act(() => { root.unmount() })
    expect(vi.getTimerCount(), '卸载后进度轮询仍在运行').toBe(0)

    act(() => { vi.advanceTimersByTime(5_000) })
    await flush()
    expect(mocks.apiGetOriginalHarvestStatus).toHaveBeenCalledTimes(initialStatusCalls)

    finishHarvest({ harvested: 1, failed: 0, errors: [] })
    await flush()
    expect(notify, '迟到结果仍向已卸载面板发了通知').not.toHaveBeenCalled()

    // 让 afterEach 仍有一个可安全卸载的 root。
    root = createRoot(host)
  })
})
