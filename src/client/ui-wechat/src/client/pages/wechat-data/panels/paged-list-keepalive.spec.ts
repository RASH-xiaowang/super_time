// @vitest-environment jsdom
/**
 * usePagedList × keep-alive：隐藏态不取数、不写状态；恢复时只补刷一次。
 */
import { act } from 'react'
import { createElement, useEffect, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePagedList } from './hooks.tsx'
import { KeepAliveActiveProvider } from './keep-alive.tsx'

const EVENT = 'test-paged-list-keepalive'

type FetchPage = (offset: number, limit: number) => Promise<{ items: readonly string[]; total: number }>

function Probe({ fetchPage }: { fetchPage: FetchPage }): ReactElement {
  const pager = usePagedList<string>({
    pageSize: 20,
    fetchPage,
    refreshDebounceMs: 20,
    refreshMinIntervalMs: 0,
  })
  useEffect(() => { pager.reset() }, [pager.reset])
  return createElement('div', {
    'data-items': pager.items.length,
    'data-first': pager.items[0] ?? '',
    'data-total': pager.total,
    'data-loading': String(pager.loading),
    'data-error': pager.error ?? '',
  })
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

function render(fetchPage: FetchPage, active: boolean): void {
  act(() => {
    root.render(createElement(
      KeepAliveActiveProvider,
      { active },
      createElement(Probe, { fetchPage }),
    ))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function state(): { items: string | null; first: string; loading: string } {
  return {
    items: host.firstElementChild?.getAttribute('data-items') ?? null,
    first: host.firstElementChild?.getAttribute('data-first') ?? '',
    loading: host.firstElementChild?.getAttribute('data-loading') ?? '',
  }
}

describe('usePagedList × keep-alive', () => {
  it('隐藏时数据事件不取数，恢复后只补刷一次且保留已加载内容', async () => {
    const fetchPage = vi.fn(async (_offset: number, _limit: number) => ({
      items: ['a', 'b'],
      total: 100,
    }))

    render(fetchPage, true)
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ items: '2', first: 'a' })

    render(fetchPage, false)
    await flush()
    act(() => { window.dispatchEvent(new Event(EVENT)) })
    act(() => { vi.advanceTimersByTime(100) })
    await flush()
    expect(fetchPage, '隐藏分段收到 WAL 事件后仍在后台取数').toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ items: '2', first: 'a' })

    render(fetchPage, true)
    await flush()
    expect(fetchPage, '恢复时不是恰好一次尾部补刷').toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({ items: '2', first: 'a' })
  })

  it('隐藏前发出的请求晚到时被丢弃，恢复后取到的新数据才可写状态', async () => {
    let resolveFirst: ((value: { items: readonly string[]; total: number }) => void) | null = null
    const fetchPage = vi.fn(async (_offset: number, _limit: number): Promise<{ items: readonly string[]; total: number }> => {
      throw new Error('unreachable')
    })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ items: ['fresh'], total: 1 })

    render(fetchPage, true)
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(state()).toMatchObject({ items: '0', loading: 'true' })

    render(fetchPage, false)
    await flush()
    await act(async () => {
      resolveFirst?.({ items: ['stale'], total: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(state(), '隐藏期间旧响应写了状态').toMatchObject({ items: '0', first: '', loading: 'true' })

    render(fetchPage, true)
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(state()).toMatchObject({ items: '1', first: 'fresh', loading: 'false' })
  })
})
