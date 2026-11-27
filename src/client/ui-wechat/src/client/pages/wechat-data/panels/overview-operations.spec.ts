// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAiReplyEnabledChatsResult } from '@deepseek-ai/dsh-wechat-data/types'
import type { MessageListRecord, MessageListSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { beginOverviewRefresh, failOverviewRefresh, summarizeAiReplyRuntime, summarizeAiReplies } from './overview-operations.ts'
const mocks = vi.hoisted(() => ({ desktop: true, runtime: vi.fn(), replies: vi.fn() }))
vi.mock('../api-core.ts', () => ({ runtimeCapabilities: () => ({ isDesktop: mocks.desktop }) }))
vi.mock('../api-chat-ai-reply.ts', () => ({ apiListEnabledChatAiReplyStates: mocks.runtime }))
vi.mock('../api-message-list.ts', () => ({ apiListMessageListRecords: mocks.replies }))
vi.mock('../cache.ts', () => ({ DATA_IDENTITY_CHANGED_EVENT: 'fixture-identity-change' }))
vi.mock('./overview-parts.tsx', () => ({ OvSection: ({ children, action, title }: { children: React.ReactNode; action: React.ReactNode; title: React.ReactNode }) => createElement('section', null, createElement('h2', null, title), action, children) }))
import { useOverviewOperations, AiPendingSection, AiReplyOutcomeSection, AiReplyRuntimeSection, type OverviewOperations } from './overview-operations-cards.tsx'
const runtime = (): Extract<ChatAiReplyEnabledChatsResult, { ok: true }> => ({ ok: true, chats: [{ chatUsername: 'PRIVATE_NAME@chatroom', chatName: 'PRIVATE_NAME', updatedAt: 1 }] })
const record = (status: MessageListRecord['status'], failureKind = '', source: MessageListRecord['source'] = 'ai_reply') => ({ status, failureKind, source, text: 'PRIVATE_REPLY', webhookUrl: 'PRIVATE_ENDPOINT' } as MessageListRecord)
const snapshot = (items: MessageListRecord[] = []): MessageListSnapshot => ({ items, total: items.length })

describe('overview metric contracts', () => {
  it('counts enabled chats without retaining private names or duplicate identifiers', () => {
    const result = summarizeAiReplyRuntime(runtime(), 20)
    expect(result).toEqual({ enabled: 1, groups: 1, direct: 0, sampledAt: 20 })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('never counts a draft, accepted proposal, queued job or generation as sent', () => {
    const result = summarizeAiReplies(snapshot([
      record('success'), record('failed', 'held_draft'), record('failed', 'generation_failed'),
      record('failed', 'send_failed'), record('failed', 'superseded'), record('queued'),
      record('sent_unconfirmed'), record('success', '', 'manual'),
    ]), 20)
    expect(result).toMatchObject({ sampled: 7, success: 1, held: 1, sendFailed: 1, generationFailed: 1, inFlight: 1, unconfirmed: 1 })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(result).not.toHaveProperty('successRate')
  })
  it('rejects unavailable/partial snapshots instead of inventing zeros', () => {
    expect(() => summarizeAiReplies({ ...snapshot(), readError: 'private error' }, 1)).toThrow()
    expect(() => summarizeAiReplyRuntime({ ok: false, error: 'fixture' }, 1)).toThrow()
    expect(summarizeAiReplies(snapshot(), 1).sampled).toBe(0)
  })
})

let host: HTMLDivElement
let root: Root
let current: OverviewOperations
function Harness({ refreshKey = 1 }: { refreshKey?: number }) {
  current = useOverviewOperations(refreshKey)
  return createElement('div', null,
    createElement(AiPendingSection, { ops: current, onGo: vi.fn() }),
    createElement(AiReplyOutcomeSection, { ops: current, onGo: vi.fn() }),
    createElement(AiReplyRuntimeSection, { ops: current }))
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.desktop = true
  mocks.runtime.mockResolvedValue(runtime()); mocks.replies.mockResolvedValue(snapshot())
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount() }); host.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
async function render(refreshKey = 1) { await act(async () => { root.render(createElement(Harness, { refreshKey })) }) }

function metricValue(label: string): string | undefined {
  const name = Array.from(host.querySelectorAll('span')).find(el => el.textContent === label)
  return name?.parentElement?.firstElementChild?.textContent ?? undefined
}


describe('read-only overview card loading', () => {
  it('shows loading, then independent data, with just one read per source and no content rendered', async () => {
    let resolve!: (value: ChatAiReplyEnabledChatsResult) => void
    mocks.runtime.mockReturnValueOnce(new Promise(value => { resolve = value }))
    await render()
    expect(metricValue('已开启会话')).toBe('—')
    expect(metricValue('本地成功')).toBe('0')
    expect(host.textContent).not.toContain('读取中')
    expect(host.textContent).not.toContain('暂无 AI 回复记录')
    await act(async () => { resolve(runtime()) })
    expect(current.runtime.status).toBe('ready')
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(mocks.replies).toHaveBeenCalledWith({ source: 'ai_reply', limit: 100 })
    expect(metricValue('已开启会话')).toBe('1')
    expect(host.textContent).not.toContain('最近50条')
    expect(host.textContent).not.toContain('PRIVATE')
  })
  it('isolates partial failures, retaining old success and timestamp with a stale warning', async () => {
    await render()
    const oldReplies = current.replies.data
    mocks.replies.mockResolvedValueOnce({ ...snapshot(), readError: 'PRIVATE_ERROR' })
    await render(2)
    expect(current.runtime.status).toBe('ready')
    expect(current.replies).toEqual({ status: 'stale', data: oldReplies })
    expect(metricValue('本地成功')).toBe(String(oldReplies?.success ?? 0))
    expect(host.querySelectorAll('[role="status"][data-state="stale"]').length).toBeGreaterThan(0)
    expect(host.textContent).not.toContain('PRIVATE_ERROR')
    const oldRuntime = current.runtime.data
    mocks.runtime.mockRejectedValueOnce(new Error('PRIVATE_ERROR'))
    await render(3)
    expect(current.runtime.data).toBe(oldRuntime)
    expect(current.runtime.status).toBe('stale')
    expect(current.replies.status).toBe('ready')
    await act(async () => { current.retry() })
    expect(current.runtime.status).toBe('ready')
    expect(host.textContent).not.toContain('刷新失败，旧数据')
  })
  it('does not invoke desktop IPCs in a browser', async () => {
    mocks.desktop = false
    await render()
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.replies).not.toHaveBeenCalled()
    expect(metricValue('已开启会话')).toBe('—')
    expect(metricValue('本地成功')).toBe('—')
    expect(host.textContent).not.toContain('仅桌面端可用')
  })
  it('ignores stale responses after refresh or account identity change', async () => {
    let resolve!: (value: ChatAiReplyEnabledChatsResult) => void
    mocks.runtime.mockReturnValueOnce(new Promise(value => { resolve = value }))
    await render()
    await act(async () => { window.dispatchEvent(new Event('fixture-identity-change')) })
    expect(current.runtime.data?.enabled).toBe(1)
    await act(async () => { resolve({ ...runtime(), chats: [] }) })
    expect(current.runtime.data?.enabled).toBe(1)
  })
  it('keeps independent source success times and preserves old time on a stale source', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00+08:00'))
    let resolveReplies!: (value: MessageListSnapshot) => void
    mocks.replies.mockReturnValueOnce(new Promise(value => { resolveReplies = value }))
    await render()
    const runtimeTime = current.runtime.data?.sampledAt
    expect(runtimeTime).toBe(new Date('2020-01-01T00:00:00+08:00').getTime())
    expect(current.replies.data).toBeNull()
    vi.setSystemTime(new Date('2020-01-01T00:05:00+08:00'))
    await act(async () => { resolveReplies(snapshot([record('success')])) })
    const replyTime = current.replies.data?.sampledAt
    expect(replyTime).toBe(new Date('2020-01-01T00:05:00+08:00').getTime())
    expect(current.runtime.data?.sampledAt).toBe(runtimeTime)
    const oldStamp = new Date(replyTime ?? 0).toLocaleString('zh-CN')
    expect(metricValue('本地成功')).toBe('1')
    expect(metricValue('已开启会话')).toBe('1')
    expect(host.textContent).not.toContain('全库近100条·含分段')
    expect(host.textContent).not.toContain('最近50条')
    expect(host.textContent).not.toContain('本机累计')
    expect(host.querySelectorAll('[role="status"][title]').length).toBe(3)
    expect(host.textContent).not.toContain('随总览刷新')
    expect(mocks.replies.mock.calls[0]?.[0]).toEqual({ source: 'ai_reply', limit: 100 })
    expect(mocks.replies.mock.calls[0]?.[0]).not.toHaveProperty('account')
    expect(mocks.replies.mock.calls[0]?.[0]).not.toHaveProperty('accountKey')
    mocks.replies.mockResolvedValueOnce({ ...snapshot(), readError: 'PRIVATE_ERROR' })
    vi.setSystemTime(new Date('2020-01-01T00:10:00+08:00'))
    await render(2)
    expect(current.replies.status).toBe('stale')
    expect(current.replies.data?.sampledAt).toBe(replyTime)
    expect(current.runtime.data?.sampledAt).toBe(new Date('2020-01-01T00:10:00+08:00').getTime())
    expect(metricValue('本地成功')).toBe('1')
    expect(host.textContent).not.toContain(oldStamp)
    expect(host.textContent).not.toContain('刷新失败，旧数据')
    vi.useRealTimers()
  })
})

describe('quiet refresh lifecycle', () => {
  it('pure state transitions retain data and a stale warning until real success', () => {
    const data = { sampledAt: 123, count: 7 }
    expect(beginOverviewRefresh({ status: 'unavailable', data: null })).toEqual({ status: 'loading', data: null })
    const refreshing = beginOverviewRefresh({ status: 'ready', data })
    expect(refreshing.data).toBe(data)
    expect(refreshing.status).toBe('refreshing')
    const failed = failOverviewRefresh(refreshing)
    expect(failed).toEqual({ status: 'stale', data })
    expect(beginOverviewRefresh(failed)).toMatchObject({ status: 'stale', data, refreshing: true })
    expect(failOverviewRefresh({ status: 'loading', data: null })).toEqual({ status: 'unavailable', data: null })
  })
  it('retains the same metric DOM nodes during refresh and replaces values only after success', async () => {
    await render()
    const label = Array.from(host.querySelectorAll('span')).find(el => el.textContent === '已开启会话')!
    const metric = label.parentElement!
    const value = metric.firstElementChild!
    const oldRuntime = current.runtime.data
    const oldReplies = current.replies.data
    let resolveRuntime!: (value: ChatAiReplyEnabledChatsResult) => void
    let resolveReplies!: (value: MessageListSnapshot) => void
    mocks.runtime.mockReturnValueOnce(new Promise(resolve => { resolveRuntime = resolve }))
    mocks.replies.mockReturnValueOnce(new Promise(resolve => { resolveReplies = resolve }))
    await render(2)
    expect(current.runtime.status).toBe('refreshing')
    expect(current.runtime.data).toBe(oldRuntime)
    expect(current.replies.data).toBe(oldReplies)
    expect(host.contains(metric)).toBe(true)
    expect(host.contains(value)).toBe(true)
    expect(host.textContent).not.toContain('读取中')
    expect(metricValue('已开启会话')).not.toBe('—')
    expect(value.textContent).toBe('1')
    await act(async () => { resolveRuntime({ ...runtime(), chats: [] }) })
    expect(current.runtime.status).toBe('ready')
    expect(current.replies.status).toBe('refreshing')
    expect(host.contains(value)).toBe(true)
    expect(value.textContent).toBe('0')
    await act(async () => { resolveReplies(snapshot([record('success')])) })
    expect(current.replies.data?.success).toBe(1)
    expect(current.replies.status).toBe('ready')
  })
  it('first-read failures are unknown, not zero or a stale successful timestamp', async () => {
    mocks.runtime.mockRejectedValueOnce(new Error('PRIVATE_ERROR'))
    mocks.replies.mockResolvedValueOnce({ ...snapshot(), readError: 'PRIVATE_ERROR' })
    await render()
    expect(current.runtime).toEqual({ status: 'unavailable', data: null })
    expect(current.replies).toEqual({ status: 'unavailable', data: null })
    expect(metricValue('已开启会话')).toBe('—')
    expect(metricValue('本地成功')).toBe('—')
    expect(host.textContent).not.toContain('数据不可用')
    expect(host.textContent).not.toContain('上次成功')
    expect(host.textContent).not.toContain('暂无 AI 回复记录')
  })
  it('clears successful old identity values immediately and ignores both old pending responses', async () => {
    await render()
    let oldRuntime!: (value: ChatAiReplyEnabledChatsResult) => void
    let oldReplies!: (value: MessageListSnapshot) => void
    let newRuntime!: (value: ChatAiReplyEnabledChatsResult) => void
    let newReplies!: (value: MessageListSnapshot) => void
    mocks.runtime.mockReturnValueOnce(new Promise(resolve => { oldRuntime = resolve }))
    mocks.replies.mockReturnValueOnce(new Promise(resolve => { oldReplies = resolve }))
    await render(2)
    mocks.runtime.mockReturnValueOnce(new Promise(resolve => { newRuntime = resolve }))
    mocks.replies.mockReturnValueOnce(new Promise(resolve => { newReplies = resolve }))
    await act(async () => { window.dispatchEvent(new Event('fixture-identity-change')) })
    expect(current.runtime).toEqual({ status: 'loading', data: null })
    expect(current.replies).toEqual({ status: 'loading', data: null })
    expect(host.textContent).not.toContain('上次成功')
    expect(metricValue('已开启会话')).toBe('—')
    expect(metricValue('本地成功')).toBe('—')
    await act(async () => { oldRuntime(runtime()); oldReplies(snapshot([record('success')])) })
    expect(current.runtime.data).toBeNull()
    expect(current.replies.data).toBeNull()
    await act(async () => { newRuntime({ ...runtime(), chats: [] }); newReplies(snapshot()) })
    expect(current.runtime.data?.enabled).toBe(0)
    expect(current.replies.data?.success).toBe(0)
    expect(metricValue('本地成功')).toBe('0')
    expect(host.textContent).not.toContain('全库近100条·含分段')
  })
  it('ignores both sources after unmount without resurrecting content', async () => {
    let resolveRuntime!: (value: ChatAiReplyEnabledChatsResult) => void
    let resolveReplies!: (value: MessageListSnapshot) => void
    mocks.runtime.mockReturnValueOnce(new Promise(resolve => { resolveRuntime = resolve }))
    mocks.replies.mockReturnValueOnce(new Promise(resolve => { resolveReplies = resolve }))
    await render()
    await act(async () => { root.unmount() })
    await act(async () => { resolveRuntime(runtime()); resolveReplies(snapshot([record('success')])) })
    expect(host.textContent).toBe('')
    root = createRoot(host)
  })
  it('does not restart reads or remount metrics for an unchanged refresh key', async () => {
    await render()
    const oldRuntime = current.runtime.data
    const label = Array.from(host.querySelectorAll('span')).find(el => el.textContent === '已开启会话')!
    await render()
    expect(current.runtime.data).toBe(oldRuntime)
    expect(host.contains(label)).toBe(true)
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(mocks.replies).toHaveBeenCalledTimes(1)
  })
})
describe('overview operations source wiring', () => {
  it('does not present lastUpdated as card freshness, and states the store-wide reply sample', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const here = import.meta.dirname
    const cards = readFileSync(join(here, 'overview-operations-cards.tsx'), 'utf8')
    const panel = readFileSync(join(here, 'overview-panel.tsx'), 'utf8')
    const ops = readFileSync(join(here, 'overview-operations.ts'), 'utf8')
    expect(panel).toContain('useOverviewOperations(lastUpdated)')
    expect(cards).toContain('本地成功')
    expect(cards).toContain('已开启会话')
    expect(cards).toContain("const UNKNOWN = '—'")
    expect(cards).not.toContain('全库近100条·含分段')
    expect(cards).not.toContain('最近50条')
    expect(cards).not.toContain('本机累计')
    expect(cards).not.toContain('没有账号过滤')
    expect(cards).not.toContain('不是全量待办')
    expect(cards).not.toContain('不是发送量')
    expect(cards).not.toContain('本地成功不表示已送达')
    expect(cards).not.toContain('暂无 AI 回复记录')
    expect(cards).not.toContain('读取中')
    expect(cards).not.toContain('SnapshotNote')
    expect(cards).not.toMatch(/<p[^>]*title=/)
    expect(cards).not.toContain('随总览刷新')
    expect(cards).toContain('最近100条')
    expect(cards).toContain('非全量统计')
    expect(cards).toContain('role="status"')
    expect(cards).toContain('MESSAGE_LIST_UPDATED_EVENT')
    expect(ops).toContain('no account filter')
    expect(panel).not.toContain('css.spinner')
    expect(panel).not.toContain('setDone')
    expect(panel).toContain("loading && data === null ? '统计中…' : '刷新'")
    expect(panel).toContain('if (!current()) return')
    expect(panel).toContain('fetchOverviewExtras(current,')
    expect(panel).toContain('identityGenerationRef.current += 1')
    expect(panel).toContain('window.removeEventListener(DATA_IDENTITY_CHANGED_EVENT, identityChanged)')
    expect(panel).toContain('正在展示上次成功数据（可能已过期）')
    expect(panel).not.toMatch(/<CardCanvas[^>]*key=/)
    expect(panel).toContain('{data === null || debugSkeleton ? <SkeletonOverview /> : null}')
    expect(cards.split('css.opsMetricGrid').length - 1).toBe(3)
    const styles = readFileSync(join(here, 'overview.module.css'), 'utf8')
    expect(styles).toContain('.opsMetricGrid')
    expect(styles).toContain('repeat(3, minmax(0, 1fr))')
    expect(styles).toContain('repeat(auto-fit, minmax(120px, 1fr))')
  })
})
