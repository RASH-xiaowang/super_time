// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readChatAiReplyState,
  saveChatAiReplySetting,
  updateChatAiReplyRunState,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type {
  ChatAiReplyScanDeps,
  ChatAiReplyScanMessage,
} from '../src/query/ai-reply/types.ts'
import { getMessageListRecord } from '../src/query/message-list-store.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

const oldQuestion: ChatAiReplyScanMessage = {
  localId: 2,
  sortSeq: 200,
  createTime: 2000,
  isSender: 0,
  renderType: 'text',
  displayText: '旧问题',
}
const latestQuestion: ChatAiReplyScanMessage = {
  localId: 3,
  sortSeq: 300,
  createTime: 3000,
  isSender: 0,
  renderType: 'text',
  displayText: '最新问题',
}
const systemEvent: ChatAiReplyScanMessage = {
  localId: 4,
  sortSeq: 400,
  createTime: 4000,
  isSender: 0,
  renderType: 'system',
  displayText: '系统事件',
}
const newQuestion: ChatAiReplyScanMessage = {
  localId: 5,
  sortSeq: 500,
  createTime: 5000,
  isSender: 0,
  renderType: 'text',
  displayText: '系统事件之后的新问题',
}

beforeEach(() => {
  harness.reset()
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

function enable(cursor = 'v2:100:1'): void {
  expect(saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    chatName: '小王',
    enabled: true,
    provider: 'dsh-wechat-bridge',
    cursor,
  }).ok).toBe(true)
}

function deps(overrides: Partial<ChatAiReplyScanDeps> = {}): ChatAiReplyScanDeps {
  return harness.deps(overrides)
}

describe('AI 自动回复 · 同一轮只回最新问题', () => {
  it('连续入站消息合并为一次回复，旧消息不再逐条补答', async () => {
    enable()
    const listMessagesAfter = vi.fn(async (_talker: string, cursor: string) => {
      if (cursor === 'v2:100:1') return [oldQuestion, latestQuestion]
      return []
    })
    const seenAnchors: Array<number | undefined> = []
    const generate = vi.fn(async () => ({ ok: true, text: '合并回复' }))
    const reserveReply = vi.fn(harness.reserveReply)
    const runner = createChatAiReplyRunner(deps({
      listMessagesAfter,
      collectContext: (_dir, _talker, _self, anchorLocalId) => {
        seenAnchors.push(anchorLocalId)
        return {
          lines: ['对方：旧问题', '对方：最新问题'],
          latestPeer: '最新问题',
          count: 2,
          prompt: '当前问题',
        }
      },
      generate,
      reserveReply,
    }))

    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'success',
        cursor: 'v2:300:3',
      })
    })

    expect(seenAnchors).toEqual([3])
    expect(generate).toHaveBeenCalledTimes(1)
    expect(reserveReply).toHaveBeenCalledTimes(1)
    expect(reserveReply.mock.calls[0]?.[0].sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:3000:3')

    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(reserveReply).toHaveBeenCalledTimes(1)
    runner.dispose()
  })

  it('重启恢复时会话已前进，旧 pending 作废且不生成、不投递', async () => {
    enable()
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:2000:2'
    const reserved = await harness.reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 2_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    expect((await harness.completeReply({
      id: reserved.id ?? 0,
      text: '过期的旧回复',
    })).ok).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
      pendingCursor: 'v2:200:2',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessagesAtOrBefore: async () => [oldQuestion],
      listMessagesAfter: async () => [latestQuestion],
      generate,
      dispatchReply,
    }))

    const recovered = await runner.recover()
    expect(recovered.recovered).toBe(1)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)).toMatchObject({
      status: 'failed',
      text: '过期的旧回复',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'failed',
      cursor: 'v2:200:2',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').pendingSourceRef)
      .toBeUndefined()
    runner.dispose()
  })

  it('生成期间出现新消息时，投递前复核并取消旧回复', async () => {
    enable()
    let generated = false
    const generate = vi.fn(async () => {
      generated = true
      return { ok: true, text: '不应投递的旧回复' }
    })
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessagesAfter: async () => generated ? [latestQuestion] : [oldQuestion],
      generate,
      dispatchReply,
    }))

    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(generate).toHaveBeenCalledTimes(1)
    expect(dispatchReply).not.toHaveBeenCalled()
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    expect(state).toMatchObject({
      stage: 'failed',
      cursor: 'v2:200:2',
    })
    expect(state.pendingSourceRef).toBeUndefined()
    const record = getMessageListRecord(decrypted, state.recordId ?? 0)
    expect(record).toMatchObject({
      status: 'failed',
      text: '不应投递的旧回复',
    })
    runner.dispose()
  })

  it('旧状态丢失 recordId 时仍按 sourceRef 收口旧 pending，不给后台留下补发入口', async () => {
    enable()
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:2000:2'
    const reserved = await harness.reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 2_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      pendingCursor: 'v2:200:2',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessagesAtOrBefore: async () => [oldQuestion],
      listMessagesAfter: async () => [latestQuestion],
      generate,
      dispatchReply,
    }))

    const recovered = await runner.recover()
    expect(recovered.recovered).toBe(1)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('过期'),
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'failed',
      cursor: 'v2:200:2',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').pendingSourceRef)
      .toBeUndefined()
    runner.dispose()
  })

  it('没有可视历史时也先用最新合法消息建立水位，首条新问题不会被当成历史跳过', async () => {
    enable('')
    let messages = [systemEvent]
    const generate = vi.fn(async () => ({ ok: true, text: '新问题回复' }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => messages,
      generate,
    }))

    await runner.scan()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      cursor: 'v2:400:4',
    })
    expect(generate).not.toHaveBeenCalled()

    messages = [systemEvent, newQuestion]
    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'success',
        cursor: 'v2:500:5',
      })
    })
    runner.dispose()
  })
})
