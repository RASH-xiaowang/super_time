// @vitest-environment jsdom
/**
 * 消息列表自动无感刷新的行为守卫。
 *
 * 验证三件事：定时回查不翻 loading；静默失败保留旧内容；页面隐藏时停表、
 * 可见时立即补一次，卸载后不再发请求。
 */
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
}))

vi.mock('../api.ts', () => mocks)

import {
  MESSAGE_LIST_POLL_MS,
  useMessageListData,
} from './use-message-list-data.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'

function record(status: MessageListRecord['status'], updatedAt: number): MessageListRecord {
  return {
    id: 1,
    replyId: 'reply-1',
    chatName: '客户群',
    targetName: '文件传输助手',
    text: '你好',
    images: [],
    triggeredAt: updatedAt,
    source: 'manual',
    status,
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: 'http://127.0.0.1/reply',
    error: '',
    attempts: status === 'pending' ? 0 : 1,
    createdAt: updatedAt,
    updatedAt,
  }
}

let host: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useMessageListData> | null = null
let mounted = false

function Probe(): React.JSX.Element {
  const data = useMessageListData(true)
  latest = data
  return createElement('div', {
    'data-loading': String(data.loadingRecords),
    'data-total': String(data.recordTotal),
    'data-status': data.records[0]?.status ?? '',
    'data-error': data.readError,
  })
}

const attr = (name: string): string => host.querySelector('div')?.getAttribute(name) ?? ''

async function flush(): Promise<void> {
  await act(async () => {
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

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  setVisibility('visible')
  latest = null
  mocks.apiGetImageDataUrlsBatch.mockReset().mockResolvedValue([])
  mocks.apiListMessageListRules.mockReset().mockResolvedValue({ items: [], total: 0 })
  mocks.apiQueryMessageListWebhookJob.mockReset()
  mocks.apiGetMessageListWebhookInfo.mockReset().mockResolvedValue({
    enabled: true,
    url: 'http://127.0.0.1/api/message-webhook/token',
    getExample: '',
    postExample: '',
    version: '1.0',
  })
  mocks.apiListMessageListRecords.mockReset().mockResolvedValue({
    items: [record('pending', 100)],
    total: 1,
  })
})

afterEach(() => {
  if (mounted) act(() => { root.unmount() })
  host.remove()
  latest = null
  mounted = false
  vi.useRealTimers()
})

describe('消息列表自动无感刷新', () => {
  it('事件回源在飞时手动刷新复用同一首屏请求，不重复全页读取', async () => {
    await mount()
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(1)

    let finish: ((snapshot: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(2)

    let manualRefresh: Promise<void> | null = null
    await act(async () => {
      manualRefresh = latest?.refreshRecords() ?? null
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords, '手动刷新必须附着在途首屏请求').toHaveBeenCalledTimes(2)

    await act(async () => {
      finish?.({ items: [record('success', 300)], total: 1 })
      await manualRefresh
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords, '不能为首屏刷新再并发打一次库').toHaveBeenCalledTimes(2)
    expect(attr('data-status')).toBe('success')
    expect(attr('data-loading')).toBe('false')
  })

  it('请求在飞时连续到达的更新事件合并成一次尾部补刷，不丢失最后一拍', async () => {
    await mount()
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(1)

    let finish: ((snapshot: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockResolvedValue({
      items: [record('success', 200)],
      total: 1,
    })
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      window.dispatchEvent(new Event(MESSAGE_LIST_UPDATED_EVENT))
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords, '在飞期间不能并发叠请求').toHaveBeenCalledTimes(2)

    await act(async () => {
      finish?.({ items: [record('pending', 100)], total: 1 })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords, '最后一个事件必须触发尾部补刷').toHaveBeenCalledTimes(3)
    expect(attr('data-status')).toBe('success')
  })

  it('到点静默回查并原位更新，请求期间不翻 loading', async () => {
    await mount()
    expect(attr('data-status')).toBe('pending')
    expect(attr('data-loading')).toBe('false')

    let finish: ((snapshot: MessageListSnapshot) => void) | null = null
    mocks.apiListMessageListRecords.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    }))

    await act(async () => {
      vi.advanceTimersByTime(MESSAGE_LIST_POLL_MS)
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(2)
    expect(mocks.apiListMessageListRules, '兜底回源也必须覆盖规则，事件丢失时不能长期显示旧规则').toHaveBeenCalledTimes(2)
    expect(attr('data-loading'), '自动回查期间旧列表必须保持可见').toBe('false')
    expect(attr('data-status')).toBe('pending')

    await act(async () => {
      finish?.({ items: [record('success', 200)], total: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(attr('data-status')).toBe('success')
    expect(attr('data-loading')).toBe('false')
  })

  it('queued/running 记录带 jobId 时自动查询任务，终态后回源更新台账', async () => {
    const queued = record('queued', 100)
    queued.jobId = 'job-auto-1'
    mocks.apiListMessageListRecords
      .mockResolvedValueOnce({ items: [queued], total: 1 })
      .mockResolvedValueOnce({ items: [record('success', 200)], total: 1 })
    mocks.apiQueryMessageListWebhookJob.mockResolvedValue({
      ok: true,
      state: 'succeeded',
      endpoint: 'http://127.0.0.1/webhook/***',
    })

    await mount()
    expect(attr('data-status')).toBe('queued')
    await act(async () => {
      vi.advanceTimersByTime(1_500)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.apiQueryMessageListWebhookJob).toHaveBeenCalledWith({ recordId: 1 })
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(2)
    expect(attr('data-status')).toBe('success')
  })

  it('静默刷新失败时保留旧列表和错误状态，不把用户切到错误页', async () => {
    await mount()
    mocks.apiListMessageListRecords.mockRejectedValueOnce(new Error('后端暂时不可用'))

    await act(async () => {
      vi.advanceTimersByTime(MESSAGE_LIST_POLL_MS)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(attr('data-status')).toBe('pending')
    expect(attr('data-total')).toBe('1')
    expect(attr('data-error')).toBe('')
    expect(attr('data-loading')).toBe('false')
  })

  it('页面隐藏时不轮询，恢复可见时立即补一次；卸载后不再请求', async () => {
    setVisibility('hidden')
    await mount()
    expect(mocks.apiListMessageListRecords).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(MESSAGE_LIST_POLL_MS * 3)
    })
    expect(mocks.apiListMessageListRecords, '隐藏页不应继续打数据库').toHaveBeenCalledTimes(1)

    setVisibility('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(mocks.apiListMessageListRecords, '回到前台应立即补一次').toHaveBeenCalledTimes(2)
    expect(mocks.apiListMessageListRules, '回到前台时规则也要补刷').toHaveBeenCalledTimes(2)

    act(() => { root.unmount() })
    mounted = false
    await act(async () => {
      vi.advanceTimersByTime(MESSAGE_LIST_POLL_MS * 2)
    })
    expect(mocks.apiListMessageListRecords, '卸载后定时器必须清掉').toHaveBeenCalledTimes(2)
  })
})
