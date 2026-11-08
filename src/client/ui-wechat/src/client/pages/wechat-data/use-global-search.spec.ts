// @vitest-environment jsdom
/**
 * 全局搜索请求状态机的竞态回归。
 *
 * 这里不测样式，只钉住两个用户可见事实：
 *  - 快速换词时旧 job 被取消；
 *  - 旧请求即使最后才返回，也不能覆盖新请求已经写入的结果。
 */
import { act, createElement, useEffect, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedSearchSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { useGlobalSearchState } from './use-global-search.ts'

const mocks = vi.hoisted(() => ({
  apiCancelSearch: vi.fn(),
  apiGetSessions: vi.fn(),
  apiSearchUnified: vi.fn(),
}))

vi.mock('./api.ts', () => ({
  apiCancelSearch: mocks.apiCancelSearch,
  apiGetSessions: mocks.apiGetSessions,
  apiSearchUnified: mocks.apiSearchUnified,
}))

type SearchState = ReturnType<typeof useGlobalSearchState>

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function snapshot(query: string, marker: string): UnifiedSearchSnapshot {
  return {
    query,
    messages: [{ marker } as never],
    contacts: [],
    moments: [],
    favorites: [],
    files: [],
    records: [],
  }
}

let host: HTMLDivElement
let root: Root
let latest: SearchState

function Harness(): null {
  const state = useGlobalSearchState(false, (() => undefined) as Dispatch<SetStateAction<boolean>>)
  useEffect(() => { latest = state })
  return null
}

const flush = async (times = 5): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

const runDebounce = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(300)
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  mocks.apiCancelSearch.mockReset().mockResolvedValue({ ok: true })
  mocks.apiGetSessions.mockReset().mockResolvedValue({ sessions: [], total: 0 })
  mocks.apiSearchUnified.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

describe('全局搜索竞态', () => {
  it('新搜索取消旧 job；旧结果晚到也不覆盖新结果', async () => {
    const oldSearch = deferred<UnifiedSearchSnapshot>()
    const newSearch = deferred<UnifiedSearchSnapshot>()
    mocks.apiSearchUnified.mockImplementation(({ query }: { query: string }) =>
      query === '旧词' ? oldSearch.promise : newSearch.promise)

    act(() => { latest.setSearchQuery('旧词') })
    await runDebounce()
    const oldJobId = mocks.apiSearchUnified.mock.calls[0]?.[0]?.jobId as string
    expect(oldJobId).toContain('global-search-')

    act(() => { latest.setSearchQuery('新词') })
    await runDebounce()
    const newJobId = mocks.apiSearchUnified.mock.calls[1]?.[0]?.jobId as string
    const sessionJobId = mocks.apiGetSessions.mock.calls[0]?.[0]?.jobId as string
    expect(newJobId).not.toBe(oldJobId)
    expect(sessionJobId).toBe(oldJobId + '-sessions')
    expect(mocks.apiCancelSearch).toHaveBeenCalledTimes(2)
    expect(mocks.apiCancelSearch.mock.calls.map(([options]) => options.jobId).sort())
      .toEqual([oldJobId, sessionJobId].sort())

    newSearch.resolve(snapshot('新词', '新结果'))
    await flush()
    expect((latest.searchResults.hits[0] as unknown as { marker: string }).marker).toBe('新结果')

    oldSearch.resolve(snapshot('旧词', '旧结果'))
    await flush()
    expect((latest.searchResults.hits[0] as unknown as { marker: string }).marker).toBe('新结果')
  })

  it('在飞请求卸载时只取消一次', async () => {
    const pending = deferred<UnifiedSearchSnapshot>()
    mocks.apiSearchUnified.mockReturnValue(pending.promise)
    act(() => { latest.setSearchQuery('卸载') })
    await runDebounce()
    const jobId = mocks.apiSearchUnified.mock.calls[0]?.[0]?.jobId as string
    const sessionJobId = mocks.apiGetSessions.mock.calls[0]?.[0]?.jobId as string

    act(() => { root.unmount() })
    await flush(1)
    expect(mocks.apiCancelSearch).toHaveBeenCalledTimes(2)
    expect(mocks.apiCancelSearch.mock.calls.map(([options]) => options.jobId).sort())
      .toEqual([jobId, sessionJobId].sort())
    pending.resolve(snapshot('卸载', '晚到'))
    await flush(1)
  })
})
