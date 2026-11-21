/** @vitest-environment node */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatAiReplyScanDeps, ChatAiReplyState } from '../src/query/ai-reply/types.ts'
import type { ChatAiReplyRunRef } from '../src/query/ai-reply/runner-state.ts'
const mocks = vi.hoisted(() => ({ settle: vi.fn() }))
vi.mock('../src/query/ai-reply/runner-state.ts', () => ({ settleChatAiReplyRun: mocks.settle }))
import { deferReplyIfBlocked, deliverChatAiReply, resetReplyPolicyLog } from '../src/query/ai-reply/runner-policy.ts'
const state = { accountKey: 'fixture-account', chatUsername: 'fixture@chatroom', kbEnabled: true } as ChatAiReplyState
const run = { recordId: 7 } as ChatAiReplyRunRef
beforeEach(() => { vi.clearAllMocks(); mocks.settle.mockResolvedValue(true); resetReplyPolicyLog() })
describe('Agent v41 reply policy: no fallback dispatch from held/deferred output', () => {
  it('preflight defers before the caller reaches generation', () => {
    const assessOutbound = vi.fn(() => ({ action: 'defer', reason: 'quiet fixture' }))
    const deps = { assessOutbound, op: vi.fn() } as unknown as ChatAiReplyScanDeps
    expect(deferReplyIfBlocked(deps, state)).toBe(true)
    expect(assessOutbound).toHaveBeenCalledWith(expect.objectContaining({ phase: 'preflight', group: true, kbEnabled: true }))
  })
  it.each(['defer', 'hold-failed', 'hold-missing', 'hold-settle-failed'])('%s cannot dispatch', async (mode) => {
    const dispatch = vi.fn(async () => true)
    const deps = { assessOutbound: () => ({ action: mode === 'defer' ? 'defer' : 'hold', reason: 'fixture' }), op: vi.fn(), ...(mode === 'hold-missing' ? {} : { holdReply: vi.fn(async () => ({ ok: mode !== 'hold-failed' })) }) } as unknown as ChatAiReplyScanDeps
    mocks.settle.mockResolvedValue(mode !== 'hold-settle-failed')
    expect(await deliverChatAiReply(deps, state, run, () => false, dispatch)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('successful hold settles the run but does not send or consume sending budget', async () => {
    const dispatch = vi.fn(async () => true), noteReplySent = vi.fn(), holdReply = vi.fn(async () => ({ ok: true }))
    const deps = { assessOutbound: () => ({ action: 'hold', reason: 'group kb fixture' }), holdReply, noteReplySent, op: vi.fn() } as unknown as ChatAiReplyScanDeps
    expect(await deliverChatAiReply(deps, state, run, () => false, dispatch)).toBe(true)
    expect(holdReply).toHaveBeenCalledWith({ id: 7, reason: 'group kb fixture' })
    expect(mocks.settle).toHaveBeenCalledOnce()
    expect(dispatch).not.toHaveBeenCalled(); expect(noteReplySent).not.toHaveBeenCalled()
  })
  it.each([false, true])('sending budget updates only when mock dispatch returns %s', async (sent) => {
    const dispatch = vi.fn(async () => sent), noteReplySent = vi.fn()
    const deps = { assessOutbound: () => ({ action: 'send', reason: 'fixture' }), noteReplySent, op: vi.fn() } as unknown as ChatAiReplyScanDeps
    expect(await deliverChatAiReply(deps, state, run, () => false, dispatch)).toBe(sent)
    expect(dispatch).toHaveBeenCalledOnce(); expect(noteReplySent).toHaveBeenCalledTimes(sent ? 1 : 0)
  })
})