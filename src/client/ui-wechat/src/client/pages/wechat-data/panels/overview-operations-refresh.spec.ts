// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageListRecord, MessageListSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
const mocks = vi.hoisted(() => ({ desktop: true, runtime: vi.fn(), replies: vi.fn() }))
vi.mock('../api-core.ts', () => ({ runtimeCapabilities: () => ({ isDesktop: mocks.desktop }) }))
vi.mock('../api-chat-ai-reply.ts', () => ({ apiListEnabledChatAiReplyStates: mocks.runtime }))
vi.mock('../api-message-list.ts', () => ({ apiListMessageListRecords: mocks.replies }))
vi.mock('../cache.ts', () => ({ DATA_IDENTITY_CHANGED_EVENT: 'fixture-identity-change' }))
vi.mock('./overview-parts.tsx', () => ({ OvSection: ({ children, action, title, canvasId }: { children: ReactNode; action: ReactNode; title: ReactNode; canvasId: string }) => createElement('section', { id: canvasId }, createElement('h2', null, title), action, children) }))
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import { useOverviewOperations, AiPendingSection, AiReplyOutcomeSection, AiReplyRuntimeSection, OVERVIEW_MESSAGE_REFRESH_DEBOUNCE_MS } from './overview-operations-cards.tsx'

const outcome = '#ov-ai-reply-outcome'
const record = (status: MessageListRecord['status'], failureKind = '') => ({ source: 'ai_reply', status, failureKind, text: 'PRIVATE_REPLY', webhookUrl: 'PRIVATE_ENDPOINT' } as MessageListRecord)
const snapshot = (items: MessageListRecord[] = []): MessageListSnapshot => ({ items, total: items.length })
const successes = (n: number) => snapshot(Array.from({ length: n }, () => record('success')))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let host: HTMLDivElement
let root: Root
let mounted: boolean
function Harness({ refreshKey }: { refreshKey: number | null }) {
  const ops = useOverviewOperations(refreshKey)
  return createElement('div', null,
    createElement(AiPendingSection, { ops, onGo: vi.fn() }),
    createElement(AiReplyOutcomeSection, { ops, onGo: vi.fn() }),
    createElement(AiReplyRuntimeSection, { ops }))
}
async function render(refreshKey: number | null = 1) { await act(async () => { root.render(createElement(Harness, { refreshKey })) }) }
function status(card = outcome) { return host.querySelector(card + ' [role="status"]')! }
function value(label = '本地成功', card = outcome) { return Array.from(host.querySelectorAll(card + ' span')).find(el => el.textContent === label)?.parentElement?.firstElementChild }
function refreshButton() { return host.querySelector(outcome + ' button') as HTMLButtonElement }
function emit(name = MESSAGE_LIST_UPDATED_EVENT) { act(() => { window.dispatchEvent(new Event(name)) }) }
async function tick(ms = OVERVIEW_MESSAGE_REFRESH_DEBOUNCE_MS) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function unmount() { await act(async () => { root.unmount() }); mounted = false }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T09:24:00+08:00')); vi.clearAllMocks(); mocks.desktop = true
  mocks.runtime.mockResolvedValue({ ok: true, chats: [] }); mocks.replies.mockResolvedValue(snapshot())
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in overview fixtures') }))
  vi.stubGlobal('XMLHttpRequest', vi.fn(() => { throw new Error('XHR forbidden in overview fixtures') }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true
})
afterEach(async () => {
  if (mounted) await unmount()
  expect(fetch).not.toHaveBeenCalled(); expect(XMLHttpRequest).not.toHaveBeenCalled()
  host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('compact status and honest sample scope', () => {
  it('distinguishes a successful zero from unknown without adding paragraphs or changing the three grids', async () => {
    await render()
    expect(value()?.textContent).toBe('0'); expect(status().textContent).toBe('已读取')
    expect(refreshButton().textContent).toBe('刷新'); expect(refreshButton().disabled).toBe(false)
    expect(host.querySelectorAll('[role="status"]').length).toBe(3)
    expect(Array.from(host.querySelectorAll('span')).filter(el => el.textContent === '最近100条')).toHaveLength(2)
    expect(host.querySelectorAll('p').length).toBe(0)
    expect(status().getAttribute('aria-live')).toBe('polite')
    expect(status().getAttribute('aria-label')).toContain('北京时间')
    expect(host.textContent).not.toContain('PRIVATE')
  })
  it('counts nonzero record states without interpreting the sample total as full-store counts', async () => {
    mocks.replies.mockResolvedValueOnce({ ...snapshot([
      record('success'), record('failed', 'send_failed'), record('failed', 'generation_failed'),
      record('failed', 'held_draft'), record('queued'), record('sent_unconfirmed'),
    ]), total: 900, hasMore: true, nextCursor: 'fixture-cursor' })
    await render()
    for (const label of ['本地成功', '投递失败', '生成失败', '暂存草稿', '待处理 / 在途', '已发出未确认']) expect(value(label)?.textContent).toBe('1')
    expect(host.textContent).not.toContain('900')
    expect(host.querySelector('[aria-label*="非全量统计"]')).not.toBeNull()
    expect(mocks.replies).toHaveBeenCalledExactlyOnceWith({ source: 'ai_reply', limit: 100 })
  })
  it('keeps initial loading unknown until an actual successful empty snapshot arrives', async () => {
    const next = deferred<MessageListSnapshot>(); mocks.replies.mockReturnValueOnce(next.promise)
    await render()
    expect(value()?.textContent).toBe('—'); expect(status().textContent).toBe('未知'); expect(refreshButton().disabled).toBe(true)
    await act(async () => { next.resolve(snapshot()) })
    expect(value()?.textContent).toBe('0'); expect(status().textContent).toBe('已读取')
  })
  it.each(['readError', 'rejected RPC'])('shows initial %s failure and recovers via the actual retry button', async kind => {
    if (kind === 'readError') mocks.replies.mockResolvedValueOnce({ ...snapshot(), readError: 'PRIVATE_ERROR' })
    else mocks.replies.mockRejectedValueOnce(new Error('PRIVATE_ERROR'))
    await render()
    expect(status().textContent).toBe('读取失败'); expect(value()?.textContent).toBe('—')
    expect(refreshButton().textContent).toBe('重试读取'); expect(host.textContent).not.toContain('PRIVATE_ERROR')
    await act(async () => { refreshButton().click() })
    expect(status().textContent).toBe('已读取'); expect(value()?.textContent).toBe('0'); expect(refreshButton().textContent).toBe('刷新')
  })
  it.each([0, 2])('preserves a previous %i and its DOM/time on refresh failure, then clears stale on recovery', async count => {
    mocks.replies.mockResolvedValueOnce(successes(count)); await render()
    const oldNode = value(); const oldStamp = status().getAttribute('aria-label')
    vi.setSystemTime(new Date('2026-11-23T09:25:00+08:00'))
    mocks.replies.mockRejectedValueOnce(new Error('PRIVATE_ERROR')); await render(2)
    expect(value()).toBe(oldNode); expect(value()?.textContent).toBe(String(count))
    expect(status().textContent).toBe('旧值'); expect(status().getAttribute('aria-label')).toContain('刷新失败')
    expect(status().getAttribute('aria-label')).toContain(oldStamp!.split('；')[1]!)
    expect(refreshButton().textContent).toBe('重试读取')
    await act(async () => { refreshButton().click() })
    expect(value()).toBe(oldNode); expect(value()?.textContent).toBe('0'); expect(status().textContent).toBe('已读取')
    expect(status().getAttribute('aria-label')).not.toBe(oldStamp); expect(refreshButton().textContent).toBe('刷新')
  })
  it('never follows a hasMore cursor or polls to turn a 100-record sample into a full-store total', async () => {
    mocks.replies.mockResolvedValueOnce({ ...successes(100), total: 550, hasMore: true, nextCursor: 'fixture-cursor' })
    await render(); await tick(120_000)
    expect(value()?.textContent).toBe('100'); expect(mocks.replies).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('550'); expect(host.querySelectorAll('[aria-label*="非全量统计"]').length).toBe(2)
  })
})

describe('message-list event coalescing without core queries or polling', () => {
  it('debounces a burst to one message read, preserving metric nodes and leaving runtime settings alone', async () => {
    await render(); const oldNode = value()
    mocks.replies.mockResolvedValueOnce(successes(3))
    for (let i = 0; i < 100; i += 1) emit()
    await tick(OVERVIEW_MESSAGE_REFRESH_DEBOUNCE_MS - 1); expect(mocks.replies).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(mocks.replies).toHaveBeenCalledTimes(2); expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(value()).toBe(oldNode); expect(value()?.textContent).toBe('3')
    await render(); await tick(120_000)
    expect(mocks.replies).toHaveBeenCalledTimes(2); expect(mocks.runtime).toHaveBeenCalledTimes(1)
  })
  it('waits for the last event in a burst instead of starting at the first event deadline', async () => {
    await render(); emit(); await tick(200); emit(); await tick(200)
    expect(mocks.replies).toHaveBeenCalledTimes(1)
    await tick(100); expect(mocks.replies).toHaveBeenCalledTimes(2)
  })
  it('serializes in-flight events to one follow-up and rejects an already-outdated response', async () => {
    await render(); const oldNode = value()
    const old = deferred<MessageListSnapshot>(), latest = deferred<MessageListSnapshot>()
    mocks.replies.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    emit(); await tick(); expect(status().textContent).toBe('刷新中')
    for (let i = 0; i < 100; i += 1) emit()
    await tick(); expect(mocks.replies).toHaveBeenCalledTimes(2)
    await act(async () => { old.resolve(successes(4)) })
    expect(mocks.replies).toHaveBeenCalledTimes(3); expect(value()?.textContent).toBe('0')
    await act(async () => { latest.resolve(successes(7)) })
    expect(value()).toBe(oldNode); expect(value()?.textContent).toBe('7'); expect(status().textContent).toBe('已读取')
    expect(mocks.runtime).toHaveBeenCalledTimes(1); await tick(120_000); expect(mocks.replies).toHaveBeenCalledTimes(3)
  })
  it('does not drain a dirty in-flight request before the latest debounce window has elapsed', async () => {
    await render(); const old = deferred<MessageListSnapshot>(); mocks.replies.mockReturnValueOnce(old.promise)
    emit(); await tick(); emit(); await tick(100)
    await act(async () => { old.resolve(successes(4)) })
    expect(value()?.textContent).toBe('0'); expect(mocks.replies).toHaveBeenCalledTimes(2)
    await tick(199); expect(mocks.replies).toHaveBeenCalledTimes(2)
    await tick(1); expect(mocks.replies).toHaveBeenCalledTimes(3)
  })
  it('can retry a failed message source by event without needing core statistics to change', async () => {
    await render(); mocks.replies.mockResolvedValueOnce({ ...snapshot(), readError: 'PRIVATE_ERROR' })
    emit(); await tick(); expect(status().textContent).toBe('旧值'); expect(value()?.textContent).toBe('0')
    mocks.replies.mockResolvedValueOnce(successes(2)); emit(); await tick()
    expect(status().textContent).toBe('已读取'); expect(value()?.textContent).toBe('2'); expect(mocks.runtime).toHaveBeenCalledTimes(1)
  })
})

describe('refresh and lifecycle races', () => {
  it('discards a previous generation rejection and cancels its pending event timer after a core refresh', async () => {
    await render(); const old = deferred<MessageListSnapshot>(); mocks.replies.mockReturnValueOnce(old.promise)
    emit(); await tick(); emit()
    mocks.replies.mockResolvedValueOnce(successes(5)); await render(2)
    await act(async () => { old.reject(new Error('PRIVATE_OLD_ERROR')) })
    await tick(1000)
    expect(value()?.textContent).toBe('5'); expect(status().textContent).toBe('已读取'); expect(mocks.replies).toHaveBeenCalledTimes(3)
  })
  it('drops an old identity response and queued message events without restoring old counts', async () => {
    await render(); const old = deferred<MessageListSnapshot>(); mocks.replies.mockReturnValueOnce(old.promise)
    emit(); await tick(); emit()
    mocks.replies.mockResolvedValueOnce(successes(1)); emit('fixture-identity-change')
    await act(async () => { old.resolve(successes(9)) }); await tick(1000)
    expect(value()?.textContent).toBe('1'); expect(status().textContent).toBe('已读取'); expect(mocks.replies).toHaveBeenCalledTimes(3)
  })
  it('cleans timers and event listeners on unmount', async () => {
    await render(); emit(); await unmount(); emit(); await tick(1000)
    expect(mocks.replies).toHaveBeenCalledTimes(1); expect(host.textContent).toBe('')
  })
  it('does not drain an in-flight request or update after unmount', async () => {
    await render(); const old = deferred<MessageListSnapshot>(); mocks.replies.mockReturnValueOnce(old.promise)
    emit(); await tick(); emit(); await tick(); await unmount()
    await act(async () => { old.reject(new Error('PRIVATE_ERROR')) }); await tick(1000)
    expect(mocks.replies).toHaveBeenCalledTimes(2); expect(host.textContent).toBe('')
  })
  it('does not install desktop event reads in a browser environment', async () => {
    mocks.desktop = false; await render(); emit(); await tick(1000)
    expect(mocks.replies).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled()
    expect(status().textContent).toBe('不可用'); expect(value()?.textContent).toBe('—'); expect(refreshButton().disabled).toBe(true)
  })
  it('uses an independent message event even while no core refresh timestamp is available', async () => {
    await render(null); expect(mocks.replies).not.toHaveBeenCalled()
    emit(); await tick()
    expect(mocks.replies).toHaveBeenCalledTimes(1); expect(mocks.runtime).not.toHaveBeenCalled()
    expect(status().textContent).toBe('已读取')
  })
})
