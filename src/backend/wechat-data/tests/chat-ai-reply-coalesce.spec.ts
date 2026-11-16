// @vitest-environment node
/**
 * AI 回复 · 连发合并与被取代预约的收口方式。
 *
 * 真机事故（2026-11-16）：同一位单聊对象 4 分钟内发了 49 条消息，消息列表
 * 「任务信息」里出现 49 条 AI 回复记录，绝大多数是状态=失败、备注「会话已有
 * 更新的消息…」。这些记录既没有发出去、也没有任何排查价值，还意味着同一轮
 * 连发被拆成了多次模型调用（烧 token）。
 *
 * 这一组用例钉住三件事：
 *  ① 同一轮连发只生成一次，锚点跟到最后一条对方消息；
 *  ② 被更新消息取代、且从未生成过正文的预约直接删除，不留失败记录；
 *  ③ 已经生成正文的预约（典型：待配置 Webhook）绝不能被删除。
 */
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
import {
  completeAiReplyMessageListRecord,
  getMessageListRecord,
  listMessageListRecords,
  reserveAiReplyMessageListRecord,
} from '../src/query/message-list-store.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

beforeEach(() => {
  harness.reset()
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

function enable(cursor: string): void {
  expect(saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    chatName: '小王',
    enabled: true,
    provider: 'dsh-wechat-bridge',
    cursor,
  }).ok).toBe(true)
}

function message(
  localId: number,
  sortSeq: number,
  createTime: number,
  text: string,
  isSender = 0,
): ChatAiReplyScanMessage {
  return {
    localId,
    sortSeq,
    createTime,
    isSender,
    renderType: 'text',
    displayText: text,
  }
}

function seedPendingRun(input: {
  localId: number
  sortSeq: number
  createTime: number
  text: string
}): { recordId: number; sourceRef: string } {
  const sourceRef = 'ai-reply:wxid_self:wxid_peer:'
    + String(input.createTime) + ':' + String(input.localId)
  const reserved = reserveAiReplyMessageListRecord(decrypted, {
    targetName: '小王',
    targetUsername: 'wxid_peer',
    chatName: '小王',
    chatUsername: 'wxid_peer',
    triggeredAt: 1_000_000,
    sourceRef,
  })
  expect(reserved.ok).toBe(true)
  const recordId = reserved.id ?? 0
  expect(recordId).toBeGreaterThan(0)
  if (input.text !== '') {
    expect(completeAiReplyMessageListRecord(decrypted, recordId, {
      text: input.text,
    }).ok).toBe(true)
  }
  expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
    stage: 'generating',
    recordId,
    pendingCursor: 'v2:' + String(input.sortSeq) + ':' + String(input.localId),
    pendingSourceRef: sourceRef,
    pendingRevision: 1,
  })).toBe(true)
  return { recordId, sourceRef }
}

describe('AI 回复 · 连发合并与被取代预约', () => {
  it('同一轮连发只生成一次：等待期间到达的新消息成为新锚点，只建一条记录', async () => {
    enable('v2:100:1')
    // 固定注入时钟，让锚点稳定落在「刚刚到达」的窗口里（默认 900ms）。
    const anchorMs = Math.floor(Date.now() / 1000) * 1000
    const nowSec = Math.floor(anchorMs / 1000)
    const first = message(2, 200, nowSec, '第一句')
    const second = message(3, 300, nowSec, '第二句')
    let listCalls = 0
    const listMessages = vi.fn(async () => {
      listCalls += 1
      // 扫描首拍只看到第一句；合并窗口的第一次轮询里第二句才到。
      return listCalls <= 1 ? [first] : [first, second]
    })
    const listMessagesAfter = vi.fn(async () => [first])
    const seenAnchors: Array<number | undefined> = []
    const generate = vi.fn(async () => ({ ok: true, text: '合并后的回复' }))
    const reserveReply = vi.fn(harness.reserveReply)
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages,
      listMessagesAfter,
      reserveReply,
      generate,
      collectContext: (_dir, _talker, _self, anchorLocalId) => {
        seenAnchors.push(anchorLocalId)
        return {
          lines: ['对方：第一句', '对方：第二句'],
          latestPeer: '第二句',
          count: 2,
          prompt: '当前问题',
        }
      },
    }), {
      now: () => anchorMs + 10,
      coalesceMs: 150,
    })

    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    }, { timeout: 8000 })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(seenAnchors).toEqual([3])
    expect(reserveReply).toHaveBeenCalledTimes(1)
    expect(reserveReply.mock.calls[0]?.[0].sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:' + String(nowSec) + ':3')
    const records = listMessageListRecords(decrypted)
    expect(records.total).toBe(1)
    expect(records.items[0]).toMatchObject({ source: 'ai_reply' })
    // 假 dispatcher 只回报成功、不写台账，所以记录停在 pending + 已有正文。
    expect(getMessageListRecord(decrypted, records.items[0]?.id ?? 0)).toMatchObject({
      status: 'pending',
      text: '合并后的回复',
    })
    runner.dispose()
  })

  it('被新消息取代的空白预约直接删除：不生成、不投递、不留失败记录', async () => {
    enable('v2:100:1')
    const old = message(1, 100, 1000, '旧问题')
    const newer = message(2, 200, 2000, '新问题')
    const seeded = seedPendingRun({
      localId: 1,
      sortSeq: 100,
      createTime: 1000,
      text: '',
    })
    const generate = vi.fn(async () => ({ ok: true, text: '不应生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const dropReply = vi.fn(harness.dropReply)
    const runner = createChatAiReplyRunner(harness.deps({
      listMessagesAtOrBefore: async () => [old],
      listMessagesAfter: async () => [newer],
      listMessages: async () => [old, newer],
      dropReply,
      generate,
      dispatchReply,
    }))

    const recovered = await runner.recover()
    expect(recovered.recovered).toBe(1)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(dropReply).toHaveBeenCalledWith({
      id: seeded.recordId,
      sourceRef: seeded.sourceRef,
    })
    // 台账里不再有任何「失败」行，连这条预约本身都不存在了。
    expect(getMessageListRecord(decrypted, seeded.recordId)).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(0)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    runner.dispose()
  })

  it('已经生成正文的预约不会被删除：保留正文并标记失败，供人工核对', async () => {
    enable('v2:100:1')
    const old = message(1, 100, 1000, '旧问题')
    const newer = message(2, 200, 2000, '新问题')
    const seeded = seedPendingRun({
      localId: 1,
      sortSeq: 100,
      createTime: 1000,
      text: '已经生成但还没发送的回复',
    })
    const generate = vi.fn(async () => ({ ok: true, text: '不应生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(harness.deps({
      listMessagesAtOrBefore: async () => [old],
      listMessagesAfter: async () => [newer],
      listMessages: async () => [old, newer],
      generate,
      dispatchReply,
    }))

    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, seeded.recordId)).toMatchObject({
      status: 'failed',
      text: '已经生成但还没发送的回复',
    })
    runner.dispose()
  })

  it('生成结果已落盘（快照 result）的预约不会被删除：已付费的模型结果不能丢', async () => {
    enable('v2:100:1')
    const old = message(1, 100, 1000, '旧问题')
    const newer = message(2, 200, 2000, '新问题')
    const seeded = seedPendingRun({
      localId: 1,
      sortSeq: 100,
      createTime: 1000,
      text: '',
    })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: seeded.recordId,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: seeded.sourceRef,
      pendingRevision: 1,
      generationState: 'result',
      generationSourceRef: seeded.sourceRef,
      generationText: '已经付费生成、只差补全的回复',
      generationRevision: 1,
    })).toBe(true)
    const generate = vi.fn(async () => ({ ok: true, text: '不应生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const dropReply = vi.fn(harness.dropReply)
    const runner = createChatAiReplyRunner(harness.deps({
      listMessagesAtOrBefore: async () => [old],
      listMessagesAfter: async () => [newer],
      listMessages: async () => [old, newer],
      dropReply,
      generate,
      dispatchReply,
    }))

    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    // 记录正文还是空的，但生成快照说明模型已经跑过：只允许标失败，不允许删除。
    expect(dropReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, seeded.recordId)).toMatchObject({
      status: 'failed',
    })
    runner.dispose()
  })

  it('没有删除能力时退回原来的标失败路径，绝不让预约悬空', async () => {
    enable('v2:100:1')
    const old = message(1, 100, 1000, '旧问题')
    const newer = message(2, 200, 2000, '新问题')
    const seeded = seedPendingRun({
      localId: 1,
      sortSeq: 100,
      createTime: 1000,
      text: '',
    })
    const runner = createChatAiReplyRunner(harness.deps({
      listMessagesAtOrBefore: async () => [old],
      listMessagesAfter: async () => [newer],
      listMessages: async () => [old, newer],
      dropReply: undefined,
    }))

    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(getMessageListRecord(decrypted, seeded.recordId)).toMatchObject({
      status: 'failed',
    })
    runner.dispose()
  })
})
