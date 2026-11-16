// @vitest-environment jsdom
/**
 * 图片预取必须把「未触发的空闲任务」和「在途去重占位」一起收掉。
 *
 * 旧实现只清防抖计时器：取消发生在防抖之后时，目标已经进了 inflight，但空闲回调
 * 永远不执行，于是同一张图此后都被误判为“正在预取”。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { KeepAliveActiveProvider } from './keep-alive.tsx'
import { PREFETCH_DEBOUNCE_MS, useImagePreload } from './use-image-preload.ts'

const mocks = vi.hoisted(() => ({
  apiGetImageDataUrlsBatch: vi.fn(),
  recallImage: vi.fn(),
  rememberImage: vi.fn(),
}))

vi.mock('../api.ts', () => ({ apiGetImageDataUrlsBatch: mocks.apiGetImageDataUrlsBatch }))
vi.mock('../image-cache.ts', () => ({
  recallImage: mocks.recallImage,
  rememberImage: mocks.rememberImage,
}))

let host: HTMLDivElement
let root: Root

const virtualizer = { getVirtualItems: () => [{ index: 0 }] }
const items = [{ kind: 'msg', m: { localId: 1, type: 3 } }] as MessageRenderItem[]

interface ProbeVirtualizer {
  getVirtualItems(): ReadonlyArray<{ index: number }>
  scrollElement?: Element | null
}

function Probe({ rows, virt = virtualizer }: { rows: MessageRenderItem[]; virt?: ProbeVirtualizer }): React.JSX.Element {
  useImagePreload({ talker: 'wxid_test', items: rows, virtualizer: virt })
  return createElement('div', { 'data-probe': '' })
}

function render(rows: MessageRenderItem[]): void {
  act(() => {
    root.render(createElement(
      KeepAliveActiveProvider,
      { active: true },
      createElement(Probe, { rows }),
    ))
  })
}

function unmountForTest(): void {
  act(() => { root.unmount() })
  host.remove()
  host = document.createElement('div')
  root = createRoot(host)
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: undefined })
  Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: undefined })
  vi.useFakeTimers()
  mocks.apiGetImageDataUrlsBatch.mockReset()
  mocks.recallImage.mockReset().mockReturnValue(undefined)
  mocks.rememberImage.mockReset()
  mocks.apiGetImageDataUrlsBatch.mockResolvedValue([{ username: 'wxid_test', localId: 1, url: 'data:img' }])
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

describe('useImagePreload 的取消路径', () => {
  it('卸载会取消尚未触发的空闲回退计时器', () => {
    render(items)
    act(() => { vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS) })
    expect(vi.getTimerCount(), '预取没有进入空闲等待').toBe(1)

    unmountForTest()
    expect(vi.getTimerCount(), '卸载后仍留着空闲回退计时器').toBe(0)
  })

  it('滚动停止后按新的可见区间重新预取（滚动不会重建 effect，必须自己订阅）', async () => {
    const scrollEl = document.createElement('div')
    let index = 0
    const scrolling: ProbeVirtualizer = {
      getVirtualItems: () => [{ index }],
      scrollElement: scrollEl,
    }
    // 两张图片隔着 4 条文本：可见窗口 ±2 行只会覆盖其中一张，便于断言「滚到哪取哪」。
    const text = (localId: number): MessageRenderItem => ({ kind: 'msg', m: { localId, type: 1 } } as MessageRenderItem)
    const rows = [
      { kind: 'msg', m: { localId: 1, type: 3 } },
      text(2), text(3), text(4), text(5),
      { kind: 'msg', m: { localId: 6, type: 3 } },
    ] as MessageRenderItem[]
    mocks.apiGetImageDataUrlsBatch.mockResolvedValue([{ username: 'wxid_test', localId: 1, url: 'data:img' }])
    act(() => {
      root.render(createElement(
        KeepAliveActiveProvider,
        { active: true },
        createElement(Probe, { rows, virt: scrolling }),
      ))
    })
    act(() => { vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS) })
    act(() => { vi.advanceTimersByTime(600) })
    await flush()
    expect(mocks.apiGetImageDataUrlsBatch).toHaveBeenCalledWith([{ username: 'wxid_test', localId: 1 }])

    mocks.apiGetImageDataUrlsBatch.mockClear()
    mocks.apiGetImageDataUrlsBatch.mockResolvedValue([{ username: 'wxid_test', localId: 6, url: 'data:img2' }])
    index = 5
    act(() => { scrollEl.dispatchEvent(new Event('scroll')) })
    act(() => { vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS) })
    act(() => { vi.advanceTimersByTime(600) })
    await flush()

    expect(mocks.apiGetImageDataUrlsBatch, '滚动后可见区间变了，却没有重新预取').toHaveBeenCalledWith([
      { username: 'wxid_test', localId: 6 },
    ])
  })

  it('防抖后、空闲前取消，再滚回来仍能重新预取', async () => {
    const first = [{ kind: 'msg', m: { localId: 1, type: 3 } }] as MessageRenderItem[]
    const retry = [{ kind: 'msg', m: { localId: 1, type: 3 } }] as MessageRenderItem[]
    render(first)
    act(() => { vi.advanceTimersByTime(PREFETCH_DEBOUNCE_MS) })

    render(retry)
    act(() => { vi.advanceTimersByTime(600) })
    await flush()

    expect(mocks.apiGetImageDataUrlsBatch, '取消轮次留下的 inflight 把后续预取永久挡住了').toHaveBeenCalledTimes(1)
    expect(mocks.apiGetImageDataUrlsBatch).toHaveBeenCalledWith([{ username: 'wxid_test', localId: 1 }])
    expect(mocks.rememberImage).toHaveBeenCalledWith('wxid_test', 1, { url: 'data:img', thumb: false })
  })
})
