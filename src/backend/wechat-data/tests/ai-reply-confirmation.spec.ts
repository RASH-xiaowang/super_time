/** Synthetic fixtures only; no model, network, live config or database. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAiReplyScanDeps, ChatAiReplyState } from '../src/query/ai-reply/types.ts'
import type { ChatAiReplyRunRef } from '../src/query/ai-reply/runner-state.ts'
const mocks = vi.hoisted(() => ({ state: vi.fn(), settle: vi.fn() }))
vi.mock('../src/query/ai-reply/config-store.ts', () => ({ readChatAiReplyState: mocks.state }))
vi.mock('../src/query/ai-reply/runner-state.ts', () => ({ settleChatAiReplyRun: mocks.settle }))
import { automaticReplyBlock, replyNeedsConfirmation } from '../src/query/ai-reply/reply-gate.ts'
import { deliverChatAiReply } from '../src/query/ai-reply/runner-policy.ts'
import { degradeToText } from '../src/query/message-list-text.ts'
const state = { accountKey: 'fixture', chatUsername: 'room@chatroom', kbEnabled: true } as ChatAiReplyState
const run = { recordId: 1 } as ChatAiReplyRunRef
beforeEach(() => { vi.clearAllMocks(); mocks.state.mockReturnValue({ enabled: true, kbEnabled: true }); mocks.settle.mockResolvedValue(true) })
describe('independent automatic reply safeguards', () => {
  it.each([[true, true, true], [true, false, false], [false, true, false], [false, false, false]])('group=%s kb=%s requires confirmation=%s', (group, kb, expected) => {
    expect(replyNeedsConfirmation(group, kb)).toBe(expected)
  })
  it('holds group KB output and settles without dispatch', async () => {
    const holdReply = vi.fn(async () => ({ ok: true })), dispatch = vi.fn(async () => true)
    expect(await deliverChatAiReply({ holdReply } as unknown as ChatAiReplyScanDeps, state, run, () => false, dispatch)).toBe(true)
    expect(holdReply).toHaveBeenCalledOnce(); expect(mocks.settle).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled()
  })
  it.each(['missing-writer', 'write-failed', 'settle-failed', 'missing-record'])('fails closed when %s', async mode => {
    const dispatch = vi.fn(async () => true)
    const deps = (mode === 'missing-writer' ? {} : { holdReply: async () => ({ ok: mode !== 'write-failed' }) }) as unknown as ChatAiReplyScanDeps
    if (mode === 'settle-failed') mocks.settle.mockResolvedValue(false)
    expect(await deliverChatAiReply(deps, state, mode === 'missing-record' ? {} as ChatAiReplyRunRef : run, () => false, dispatch)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it.each([true, false])('ordinary reply preserves dispatch outcome %s', async sent => {
    const dispatch = vi.fn(async () => sent)
    expect(await deliverChatAiReply({} as unknown as ChatAiReplyScanDeps, { ...state, kbEnabled: false }, run, () => false, dispatch)).toBe(sent)
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('does not dispatch cancelled work', async () => {
    const dispatch = vi.fn(async () => true)
    expect(await deliverChatAiReply({} as unknown as ChatAiReplyScanDeps, state, run, () => true, dispatch)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('checks group KB again on automatic pending-record retries', () => {
    expect(automaticReplyBlock('fixture', 'ai-reply:fixture:room@chatroom:100:1', 'room@chatroom')).toMatchObject({ action: 'hold' })
    mocks.state.mockReturnValue({ enabled: true, kbEnabled: false })
    expect(automaticReplyBlock('fixture', 'ai-reply:fixture:room@chatroom:100:1:segment:2', 'room@chatroom')).toBeUndefined()
  })
  it('preserves the existing parsed-source lookup contract', () => {
    expect(automaticReplyBlock('fixture', undefined, 'room@chatroom')).toBeUndefined()
    expect(mocks.state).not.toHaveBeenCalled()
    expect(automaticReplyBlock('fixture', 'ai-reply:fixture:room@chatroom:100:1', 'fallback')).toMatchObject({ action: 'hold' })
    expect(mocks.state).toHaveBeenCalledWith('fixture', 'fixture', 'room@chatroom')
  })
  it('keeps ordinary delivery plain-text fallback', () => { expect(degradeToText('## 标题\n- 一项\n看[这里](https://example.com)')).toBe('标题\n一项\n看这里') })
})
