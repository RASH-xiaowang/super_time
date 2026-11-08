// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageListRecord, MessageListSnapshot } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  apiGetImageDataUrlsBatch: vi.fn(),
  apiGetMessageListWebhookInfo: vi.fn(),
  apiListMessageListRecords: vi.fn(),
  apiListMessageListRules: vi.fn(),
  apiQueryMessageListWebhookJob: vi.fn(),
  runtimeCapabilities: vi.fn(() => ({ isBrowser: false, desktopEquivalent: false })),
}))

vi.mock('../api.ts', () => mocks)

const virtualMocks = vi.hoisted(() => {
  const state = {
    records: [] as Array<{ id: number }>,
    getOffsetForIndex: vi.fn((index: number) => [index * 72, 'start'] as const),
    scrollToOffset: vi.fn(),
  }
  return {
    state,
    virtualizer: {
      getVirtualItems: () => state.records
        .slice(0, 4)
        .map((_record, index) => ({
          index,
          start: index * 72,
          end: (index + 1) * 72,
          size: 72,
        })),
      getTotalSize: () => state.records.length * 72,
      measureElement: () => {},
      getOffsetForIndex: state.getOffsetForIndex,
      scrollToOffset: state.scrollToOffset,
    },
  }
})

vi.mock('./message-list-virtual.ts', () => ({
  useMessageListRowVirtualizer: (records: Array<{ id: number }>) => {
    virtualMocks.state.records = records
    return virtualMocks.virtualizer
  },
  messageListRowsForRender: (
    _virtualizer: unknown,
    records: MessageListRecord[],
  ) => ({
    rows: records.map((record, index) => ({
      record,
      index,
      start: index * 72,
      end: (index + 1) * 72,
    })),
    pads: { top: 0, bottom: 0 },
    virtualized: true,
  }),
}))

import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import { MessageListRecords } from './message-list-records.tsx'
import { useMessageListData } from './use-message-list-data.ts'

function record(id: number, triggeredAt = 1_700_000_000_000 + id): MessageListRecord {
  return {
    id,
    replyId: 'reply-' + String(id),
    chatName: '会话 ' + String(id),
    targetName: '对象 ' + String(id),
    text: '消息 ' + String(id),
    images: [],
    triggeredAt,
    source: 'manual',
    status: 'pending',
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: '',
    error: '',
    attempts: 0,
    createdAt: triggeredAt,
    updatedAt: triggeredAt,
  }
}

function page(startId: number, options: Partial<MessageListSnapshot> = {}): MessageListSnapshot {
  return {
    items: Array.from({ length: 200 }, (_value, index) => record(startId - index)),
    total: 1_000,
    ...options,
  }
}

let host: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useMessageListData> | null = null
let mounted = false

function Probe(): React.JSX.Element {
  latest = useMessageListData(true)
  return createElement('div', {
    'data-records': String(latest.records.length),
    'data-has-more': String(latest.hasMore),
    'data-loading-more': String(latest.loadingMore),
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  act(() => { root.render(createElement(Probe)) })
  await flush()
}

async function loadMorePages(count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(1_000 - index * 200, {
      hasMore: true,
      nextCursor: 'cursor-' + String(index + 1),
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })
  latest = null
  mocks.apiGetImageDataUrlsBatch.mockReset().mockResolvedValue([])
  mocks.apiListMessageListRules.mockReset().mockResolvedValue({ items: [], total: 0 })
  mocks.runtimeCapabilities.mockReturnValue({ isBrowser: false, desktopEquivalent: false })
  mocks.apiGetMessageListWebhookInfo.mockReset().mockResolvedValue({
    enabled: true,
    url: 'http://127.0.0.1/api/message-webhook/token',
    getExample: '',
    postExample: '',
    version: '1.0',
  })
  mocks.apiListMessageListRecords.mockReset().mockImplementation(async (query?: { ids?: number[] }) => {
    if (query?.ids !== undefined) {
      return {
        items: query.ids.map((id) => record(id)),
        total: 1_000,
        hasMore: false,
      }
    }
    return page(1_000, {
      hasMore: true,
      nextCursor: 'cursor-1',
    })
  })
})

afterEach(() => {
  if (mounted) act(() => { root.unmount() })
  host.remove()
  latest = null
  mounted = false
  vi.useRealTimers()
})

describe('消息列表游标分页与筛选切换', () => {
  it('首屏只取 200 条，加载更多使用同一筛选条件和游标，去重后追加', async () => {
    await mount()
    expect(latest?.records).toHaveLength(200)
    expect(latest?.hasMore).toBe(true)
    expect(mocks.apiListMessageListRecords).toHaveBeenNthCalledWith(1, expect.objectContaining({
      limit: 200,
    }))

    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(800, {
      hasMore: true,
      nextCursor: 'cursor-2',
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords).toHaveBeenLastCalledWith(expect.objectContaining({
      limit: 200,
      cursor: 'cursor-1',
    }))
    expect(latest?.records).toHaveLength(400)
    expect(latest?.records.map((item) => item.id).slice(0, 3)).toEqual([1_000, 999, 998])
    expect(latest?.records.at(-1)?.id).toBe(601)

    mocks.apiListMessageListRecords.mockResolvedValueOnce({
      items: [record(601), ...Array.from({ length: 199 }, (_value, index) => record(600 - index))],
      total: 1_000,
      hasMore: true,
      nextCursor: 'cursor-3',
    })
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(599)
    expect(new Set(latest?.records.map((item) => item.id)).size).toBe(599)
  })

  it('筛选变化会作废旧页请求，旧游标晚到也不能追加到新结果', async () => {
    await mount()
    let finishOldPage: ((value: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finishOldPage = resolve
    }))

    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
    })
    expect(latest?.loadingMore).toBe(true)

    mocks.apiListMessageListRecords.mockResolvedValue(page(500, {
      total: 300,
      hasMore: false,
    }))
    await act(async () => {
      latest?.setStatus('success')
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.recordTotal).toBe(300)
    expect(latest?.records).toHaveLength(200)

    await act(async () => {
      finishOldPage?.({
        items: Array.from({ length: 200 }, (_value, index) => record(800 - index)),
        total: 1_000,
        hasMore: true,
        nextCursor: 'old-next',
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(200)
    expect(latest?.records.some((item) => item.id === 800)).toBe(false)
    expect(latest?.hasMore).toBe(false)
  })

  it('深窗口与最新第一页完全无重叠时重置到最新页，连续刷新不会永久陈旧', async () => {
    await mount()
    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(800, {
      hasMore: true,
      nextCursor: 'cursor-2',
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(400)
    expect(latest?.records.at(-1)?.id).toBe(601)

    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(1_500, {
      total: 1_500,
      hasMore: true,
      nextCursor: 'latest-after-1-500',
    }))
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.records, '无重叠时必须退回最新一页而不是冻结旧窗口').toHaveLength(200)
    expect(latest?.records[0]?.id).toBe(1_500)
    expect(latest?.records.at(-1)?.id).toBe(1_301)
    expect(latest?.recordTotal).toBe(1_500)
    expect(latest?.hasMore).toBe(true)

    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(1_600, {
      total: 1_600,
      hasMore: true,
      nextCursor: 'latest-after-1-600',
    }))
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.records, '下一次完全无重叠仍应继续追到最新页').toHaveLength(200)
    expect(latest?.records[0]?.id).toBe(1_600)
    expect(latest?.records.at(-1)?.id).toBe(1_401)
  })

  it('后台静默刷新在 loadMore 在飞时排队，不能取消用户续页', async () => {
    await mount()
    let finishLoadMore: ((snapshot: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finishLoadMore = resolve
    }))

    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
    })
    expect(latest?.loadingMore).toBe(true)
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(2)

    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(1_100, {
      total: 1_100,
      hasMore: true,
      nextCursor: 'after-tail-refresh',
    }))
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords, 'loadMore 在飞时事件刷新只能排队').toHaveBeenCalledTimes(2)
    expect(latest?.loadingMore).toBe(true)

    await act(async () => {
      finishLoadMore?.(page(800, {
        hasMore: true,
        nextCursor: 'cursor-2',
      }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      mocks.apiListMessageListRecords.mock.calls.filter(([query]) => query?.ids === undefined),
      '续页结束后只执行一次首屏尾部补刷',
    ).toHaveLength(3)
    expect(latest?.loadingMore).toBe(false)
    expect(latest?.records, '用户加载的深页必须保留并与尾部刷新合并').toHaveLength(500)
    expect(latest?.records.some((item) => item.id === 800)).toBe(true)
    expect(latest?.records.some((item) => item.id === 1_100)).toBe(true)
  })

  it('卸载会作废在途深页批次和排队补刷', async () => {
    await mount()
    await loadMorePages(2)
    expect(latest?.records).toHaveLength(600)

    let finishBatch: ((snapshot: MessageListSnapshot) => void) | null = null
    let batchIds: number[] = []
    let idBatchCalls = 0
    mocks.apiListMessageListRecords.mockImplementation((query?: { ids?: number[] }) => {
      if (query?.ids !== undefined) {
        idBatchCalls += 1
        batchIds = query.ids
        return new Promise((resolve) => {
          finishBatch = resolve
        })
      }
      return Promise.resolve(page(1_000, {
        hasMore: true,
        nextCursor: 'cursor-1',
      }))
    })

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(idBatchCalls).toBe(1)

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })

    act(() => { root.unmount() })
    mounted = false
    const callsBeforeResolve = mocks.apiListMessageListRecords.mock.calls.length

    await act(async () => {
      finishBatch?.({
        items: batchIds.map((id) => record(id)),
        total: 1_000,
        hasMore: false,
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(idBatchCalls, '卸载后不能启动下一批 ID 刷新').toBe(1)
    expect(
      mocks.apiListMessageListRecords.mock.calls.length,
      '卸载后队列中的尾部补刷也不能落成新请求',
    ).toBe(callsBeforeResolve)
  })

  it('卸载会作废在途静默首屏刷新，响应返回后不能进入深页批次', async () => {
    await mount()
    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(800, {
      hasMore: true,
      nextCursor: 'cursor-2',
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(400)

    let finishFirstPage: ((snapshot: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirstPage = resolve
    }))
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })
    const callsBeforeUnmount = mocks.apiListMessageListRecords.mock.calls.length

    act(() => { root.unmount() })
    mounted = false
    await act(async () => {
      finishFirstPage?.(page(1_000, {
        hasMore: true,
        nextCursor: 'cursor-1',
      }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.apiListMessageListRecords.mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('卸载会作废在途 loadMore 及其排队的尾部补刷', async () => {
    await mount()
    let finishLoadMore: ((snapshot: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finishLoadMore = resolve
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
    })
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })
    const callsBeforeUnmount = mocks.apiListMessageListRecords.mock.calls.length

    act(() => { root.unmount() })
    mounted = false
    await act(async () => {
      finishLoadMore?.(page(800, {
        hasMore: true,
        nextCursor: 'cursor-2',
      }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.apiListMessageListRecords.mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('静默刷新合并第一页并保留当前深页游标', async () => {
    await mount()
    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(800, {
      hasMore: true,
      nextCursor: 'cursor-2',
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(400)

    mocks.apiListMessageListRecords.mockResolvedValueOnce({
      items: [record(1_001), ...Array.from({ length: 199 }, (_value, index) => record(1_000 - index))],
      total: 1_001,
      hasMore: true,
      nextCursor: 'new-first-page',
    })
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(401)
    expect(latest?.records[0]?.id).toBe(1_001)
    expect(latest?.hasMore).toBe(true)
  })

  it('静默事件定向刷新深页 pending 记录，不依赖重新加载全部页', async () => {
    await mount()
    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(800, {
      hasMore: true,
      nextCursor: 'cursor-2',
    }))
    await act(async () => {
      latest?.loadMore()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(400)

    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(1_000, {
      hasMore: true,
      nextCursor: 'cursor-1',
    }))
    mocks.apiListMessageListRecords.mockImplementationOnce(async (query?: { ids?: number[] }) => ({
      items: (query?.ids ?? []).map((id) => id === 800
        ? { ...record(id), status: 'success' as const, updatedAt: 1_700_000_000_900 }
        : record(id)),
      total: 1_000,
      hasMore: false,
    }))
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.apiListMessageListRecords).toHaveBeenLastCalledWith(expect.objectContaining({
      ids: expect.arrayContaining([800]),
      limit: expect.any(Number),
    }))
    expect(latest?.records).toHaveLength(400)
    expect(latest?.records.find((item) => item.id === 800)?.status).toBe('success')
    expect(latest?.hasMore).toBe(true)
  })

  it('深页超过 200 条 pending/dispatching 时按 200 条分批刷新全部记录', async () => {
    await mount()
    await loadMorePages(2)
    expect(latest?.records).toHaveLength(600)

    const batchSizes: number[] = []
    mocks.apiListMessageListRecords.mockImplementation(async (query?: { ids?: number[] }) => {
      if (query?.ids !== undefined) {
        batchSizes.push(query.ids.length)
        return {
          items: query.ids.map((id) => ({
            ...record(id),
            status: 'success' as const,
            updatedAt: 1_700_000_000_900,
          })),
          total: 1_000,
          hasMore: false,
        }
      }
      return page(1_000, {
        hasMore: true,
        nextCursor: 'cursor-1',
      })
    })

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(batchSizes).toEqual([200, 200])
    expect(latest?.records).toHaveLength(600)
    expect(
      latest?.records.slice(200).every((item) => item.status === 'success'),
      '第一页之后的 400 条都必须被定向刷新',
    ).toBe(true)
    expect(
      mocks.apiListMessageListRecords.mock.calls
        .filter(([query]) => query?.ids !== undefined)
        .every(([query]) => query.limit === query.ids.length && query.limit <= 200),
      '每批 id 请求不能超过一页',
    ).toBe(true)
  })

  it('部分批次失败不阻断后续批次，也不清空首屏或深页旧记录', async () => {
    await mount()
    await loadMorePages(3)
    expect(latest?.records).toHaveLength(800)

    let batchIndex = 0
    mocks.apiListMessageListRecords.mockImplementation(async (query?: { ids?: number[] }) => {
      if (query?.ids === undefined) {
        const refreshed = page(1_000, {
          hasMore: true,
          nextCursor: 'cursor-1',
        })
        refreshed.items = refreshed.items.map((item) => (
          item.id === 1_000
            ? { ...item, status: 'success' as const, updatedAt: 1_700_000_000_900 }
            : item
        ))
        return refreshed
      }
      batchIndex += 1
      if (batchIndex === 1) throw new Error('第一批网络失败')
      if (batchIndex === 2) {
        return {
          items: [],
          total: 1_000,
          readError: '第二批读取失败',
        }
      }
      return {
        items: query.ids.map((id) => ({
          ...record(id),
          status: 'success' as const,
          updatedAt: 1_700_000_000_900,
        })),
        total: 1_000,
        hasMore: false,
      }
    })

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(batchIndex).toBe(3)
    expect(latest?.records).toHaveLength(800)
    expect(latest?.records[0]?.id).toBe(1_000)
    expect(latest?.records[0]?.status).toBe('success')
    expect(latest?.records.find((item) => item.id === 800)?.status, '异常批次保留旧值').toBe('pending')
    expect(latest?.records.find((item) => item.id === 600)?.status, 'readError 批次保留旧值').toBe('pending')
    expect(latest?.records.find((item) => item.id === 400)?.status, '后续批次仍应完成').toBe('success')
    expect(latest?.records.at(-1)?.id).toBe(201)
  })

  it('手动刷新会使在途深页批次失效，旧响应不能覆盖新窗口', async () => {
    await mount()
    await loadMorePages(1)
    expect(latest?.records).toHaveLength(400)

    let resolveOldBatch: ((snapshot: MessageListSnapshot) => void) | null = null
    let oldBatchIds: number[] = []
    let manualRefresh = false
    mocks.apiListMessageListRecords.mockImplementation((query?: { ids?: number[] }) => {
      if (query?.ids !== undefined) {
        oldBatchIds = query.ids
        return new Promise((resolve) => {
          resolveOldBatch = resolve
        })
      }
      if (manualRefresh) {
        return Promise.resolve(page(3_000, {
          total: 1_000,
          hasMore: false,
        }))
      }
      return Promise.resolve(page(1_000, {
        hasMore: true,
        nextCursor: 'cursor-1',
      }))
    })

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveOldBatch, '静默刷新应已进入深页批次').not.toBeNull()

    manualRefresh = true
    await act(async () => {
      await latest?.refreshRecords()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(200)
    expect(latest?.records[0]?.id).toBe(3_000)

    await act(async () => {
      resolveOldBatch?.({
        items: oldBatchIds.map((id) => ({
          ...record(id),
          status: 'success' as const,
          updatedAt: 1_700_000_000_900,
        })),
        total: 1_000,
        hasMore: false,
      })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.records).toHaveLength(200)
    expect(latest?.records[0]?.id).toBe(3_000)
    expect(latest?.records.some((item) => item.id === 800)).toBe(false)
  })
})

describe('消息列表满窗静默刷新', () => {
  it('2,000 条满窗时保留已加载尾部，连续刷新不丢游标，显式刷新仍展示新记录', async () => {
    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(3_000, {
      total: 5_000,
      hasMore: true,
      nextCursor: 'cursor-0',
    }))
    await mount()
    for (let pageIndex = 0; pageIndex < 9; pageIndex += 1) {
      mocks.apiListMessageListRecords.mockResolvedValueOnce(page(2_800 - pageIndex * 200, {
        total: 5_000,
        hasMore: true,
        nextCursor: 'cursor-' + String(pageIndex + 1),
      }))
      await act(async () => {
        latest?.loadMore()
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    expect(latest?.records).toHaveLength(2_000)
    expect(latest?.records.at(-1)?.id).toBe(1_001)
    expect(latest?.windowCapped).toBe(true)

    const firstRefresh = page(3_001, {
      total: 5_001,
      hasMore: true,
      nextCursor: 'new-first-page-1',
    })
    firstRefresh.items = firstRefresh.items.map((item) => (
      item.id === 3_000 ? { ...item, status: 'success', updatedAt: item.updatedAt + 1 } : item
    ))
    mocks.apiListMessageListRecords.mockResolvedValueOnce(firstRefresh)
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.records).toHaveLength(2_000)
    expect(latest?.records[0]?.id).toBe(3_000)
    expect(latest?.records.at(-1)?.id).toBe(1_001)
    expect(latest?.records.some((item) => item.id === 3_001)).toBe(false)
    expect(latest?.records.find((item) => item.id === 3_000)?.status).toBe('success')
    expect(latest?.recordTotal).toBe(5_001)
    expect(latest?.hasMore).toBe(false)

    const secondRefresh = page(3_002, {
      total: 5_002,
      hasMore: true,
      nextCursor: 'new-first-page-2',
    })
    secondRefresh.items = secondRefresh.items.map((item) => (
      item.id === 3_000 ? { ...item, status: 'failed', updatedAt: item.updatedAt + 1 } : item
    ))
    mocks.apiListMessageListRecords.mockResolvedValueOnce(secondRefresh)
    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(latest?.records).toHaveLength(2_000)
    expect(latest?.records[0]?.id).toBe(3_000)
    expect(latest?.records.at(-1)?.id).toBe(1_001)
    expect(latest?.records.find((item) => item.id === 3_000)?.status).toBe('failed')

    mocks.apiListMessageListRecords.mockResolvedValueOnce(page(3_002, {
      total: 5_002,
      hasMore: true,
      nextCursor: 'manual-first-page',
    }))
    await act(async () => {
      await latest?.refreshRecords()
      await Promise.resolve()
    })
    expect(latest?.records).toHaveLength(200)
    expect(latest?.records[0]?.id).toBe(3_002)
    expect(latest?.records.at(-1)?.id).toBe(2_803)
    expect(latest?.windowCapped).toBe(false)
  })
})

describe('消息列表滚动锚定', () => {
  it('顶部插入后按首个可见记录 ID 和行内偏移恢复滚动位置', async () => {
    const initial = [record(100), record(99), record(98)]
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    mounted = true

    const props = (records: MessageListRecord[]): Parameters<typeof MessageListRecords>[0] => ({
      records,
      total: records.length,
      stats: { success: 0, failed: 0, pending: records.length, queued: 0, running: 0 },
      loading: false,
      readError: '',
      search: '',
      status: '',
      source: '',
      thumbs: {},
      canWrite: true,
      resendingId: null,
      batchBusy: false,
      probeBusyId: null,
      jobBusyId: null,
      onSearchChange: () => {},
      onStatusChange: () => {},
      onSourceChange: () => {},
      onRefresh: () => {},
      onResend: () => {},
      onBatchResend: async () => true,
      onBatchProbe: async () => true,
      onBatchDelete: async () => true,
      onProbe: () => {},
      onQueryJob: () => {},
      onConfigureRule: () => {},
      onConfigureRecordRule: () => {},
    })

    act(() => {
      root.render(createElement(MessageListRecords, props(initial)))
    })
    const scroller = host.querySelector<HTMLElement>('[data-message-list-scroll]')
    expect(scroller).not.toBeNull()
    if (scroller === null) return
    scroller.scrollTop = 80
    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    virtualMocks.state.getOffsetForIndex.mockClear()
    virtualMocks.state.scrollToOffset.mockClear()
    act(() => {
      root.render(createElement(MessageListRecords, props([record(101), ...initial])))
    })

    expect(virtualMocks.state.getOffsetForIndex).toHaveBeenCalledWith(2, 'start')
    expect(virtualMocks.state.scrollToOffset).toHaveBeenCalledWith(152, { align: 'start' })
  })
})
