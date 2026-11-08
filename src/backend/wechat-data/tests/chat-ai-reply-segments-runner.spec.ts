// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readChatAiReplyState,
  saveChatAiReplySetting,
  updateChatAiReplyRunState,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import { splitChatAiReplyText } from '../src/query/ai-reply/segments.ts'
import {
  getMessageListRecord,
  listAiReplyMessageListSegments,
  listMessageListRecords,
  saveMessageListDispatchResult,
} from '../src/query/message-list-store.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

beforeEach(() => {
  harness.reset()
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

const LONG_REPLY = [
  '第一段：我已经看到你的消息了，先别着急，我会马上帮你确认具体情况。',
  '第二段：这个问题通常需要核对订单时间和当前处理状态，我正在查看相关记录。',
  '第三段：确认完成后我会把结果告诉你；如果还需要补充材料，我也会一次说明。',
].join('\n\n')

function enableReply(cursor = 'v2:100:1', splitReply = true): number {
  const saved = saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    chatName: '小王',
    enabled: true,
    provider: 'dsh-wechat-bridge',
    splitReply,
    cursor,
  })
  expect(saved.ok).toBe(true)
  return saved.state?.revision ?? 1
}

function incomingMessages() {
  return [
    {
      localId: 2,
      sortSeq: 200,
      createTime: 2_000,
      isSender: 0,
      renderType: 'text',
      displayText: '请帮我看一下现在处理到哪一步了',
    },
  ]
}

describe('AI 回复长文本分段调度', () => {
  it('关闭自动分段时只写一条，并按 UTF-16 安全截断到发送端上限', async () => {
    enableReply('v2:100:1', false)
    const completeReply = vi.fn(harness.completeReply)
    const completeReplySegments = vi.fn(harness.completeReplySegments)
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => incomingMessages(),
      generate: async () => ({ ok: true, text: '😀'.repeat(400) }),
      completeReply,
      completeReplySegments,
      dispatchReply: async (id) => {
        saveMessageListDispatchResult(decrypted, id, {
          status: 'success',
          error: '',
          responseSummary: 'accepted',
          webhookUrl: 'https://example.test/ai',
        })
        return { ok: true }
      },
    }))

    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    })
    expect(completeReply).toHaveBeenCalledTimes(1)
    expect(completeReplySegments).not.toHaveBeenCalled()
    const records = listMessageListRecords(decrypted).items
    expect(records).toHaveLength(1)
    expect(records[0]?.text.length).toBe(511)
    expect(records[0]?.text.endsWith('…')).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
      .test(records[0]?.text ?? '')).toBe(false)
    runner.dispose()
  })

  it('只调用一次模型，按分段顺序串行投递并逐段写入消息列表', async () => {
    enableReply()
    const expected = splitChatAiReplyText(LONG_REPLY)
    expect(expected.length).toBeGreaterThan(1)
    const generate = vi.fn(async () => ({ ok: true, text: LONG_REPLY }))
    const completeReply = vi.fn(harness.completeReply)
    const completeReplySegments = vi.fn(harness.completeReplySegments)
    const dispatchOrder: number[] = []
    let dispatchIndex = 0
    const dispatchReply = vi.fn(async (id: number) => {
      dispatchOrder.push(id)
      dispatchIndex += 1
      saveMessageListDispatchResult(decrypted, id, {
        status: 'success',
        error: '',
        responseSummary: 'accepted',
        webhookUrl: 'https://example.test/ai',
      })
      return { ok: true }
    })
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => incomingMessages(),
      generate,
      completeReply,
      completeReplySegments,
      dispatchReply,
    }))

    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'success',
        cursor: 'v2:200:2',
      })
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(completeReply).not.toHaveBeenCalled()
    expect(completeReplySegments).toHaveBeenCalledTimes(1)
    expect(dispatchIndex).toBe(expected.length)

    const records = [...listMessageListRecords(decrypted).items].sort((a, b) =>
      (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0))
    expect(records.map((record) => record.text)).toEqual(expected)
    expect(records.map((record) => record.id)).toEqual(dispatchOrder)
    expect(records.every((record) => record.status === 'success')).toBe(true)
    runner.dispose()
  })

  it('第二段失败后停止发送，保留首段成功并把后续 pending 明确收口为 failed', async () => {
    enableReply()
    const expected = splitChatAiReplyText(LONG_REPLY)
    expect(expected.length).toBeGreaterThan(2)
    const failAfter = vi.fn(harness.failReplySegmentsAfter)
    const dispatchOrder: number[] = []
    let attempt = 0
    const dispatchReply = vi.fn(async (id: number) => {
      attempt += 1
      dispatchOrder.push(id)
      if (attempt === 1) {
        saveMessageListDispatchResult(decrypted, id, {
          status: 'success',
          error: '',
          responseSummary: 'accepted',
          webhookUrl: 'https://example.test/ai',
        })
        return { ok: true }
      }
      saveMessageListDispatchResult(decrypted, id, {
        status: 'failed',
        error: '模拟第二段发送失败',
        responseSummary: '',
        webhookUrl: 'https://example.test/ai',
      })
      return { ok: false, error: '模拟第二段发送失败' }
    })
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => incomingMessages(),
      generate: async () => ({ ok: true, text: LONG_REPLY }),
      failReplySegmentsAfter: failAfter,
      dispatchReply,
    }))

    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('failed')
    })
    expect(dispatchOrder).toHaveLength(2)
    expect(failAfter).toHaveBeenCalledTimes(1)

    const records = [...listMessageListRecords(decrypted).items].sort((a, b) =>
      (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0))
    expect(records[0]?.status).toBe('success')
    expect(records[1]?.status).toBe('failed')
    expect(records.slice(2).every((record) => record.status === 'failed')).toBe(true)
    expect(records.slice(2).every((record) => record.error.includes('后续分段已取消')))
      .toBe(true)
    runner.dispose()
  })

  it('重启后从首个未发送分段恢复，不重新生成也不重发首段', async () => {
    const revision = enableReply()
    const reserved = await harness.reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 2_000,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:2000:2',
      note: 'AI 回复 · 生成中',
    })
    const baseRecordId = reserved.id ?? 0
    const segments = splitChatAiReplyText(LONG_REPLY)
    expect(segments.length).toBeGreaterThan(2)
    const materialized = await harness.completeReplySegments({
      id: baseRecordId,
      segments,
    })
    expect(materialized.ok).toBe(true)
    const ids = materialized.segments?.map((segment) => segment.id) ?? []
    expect(ids).toHaveLength(segments.length)
    saveMessageListDispatchResult(decrypted, ids[0] ?? 0, {
      status: 'success',
      error: '',
      responseSummary: 'accepted',
      webhookUrl: 'https://example.test/ai',
    })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'dispatching',
      pendingCursor: 'v2:200:2',
      pendingSourceRef: 'ai-reply:wxid_self:wxid_peer:2000:2',
      pendingRevision: revision,
      recordId: baseRecordId,
      generationState: 'result',
      generationSourceRef: 'ai-reply:wxid_self:wxid_peer:2000:2',
      generationText: LONG_REPLY,
      generationRevision: revision,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不得再次生成' }))
    const dispatchOrder: number[] = []
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => incomingMessages(),
      generate,
      dispatchReply: async (id) => {
        dispatchOrder.push(id)
        saveMessageListDispatchResult(decrypted, id, {
          status: 'success',
          error: '',
          responseSummary: 'accepted',
          webhookUrl: 'https://example.test/ai',
        })
        return { ok: true }
      },
    }))

    await runner.recover()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    })
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchOrder).toEqual(ids.slice(1))
    expect(getMessageListRecord(decrypted, ids[0] ?? 0)?.status).toBe('success')
    expect(listAiReplyMessageListSegments(
      decrypted,
      'ai-reply:wxid_self:wxid_peer:2000:2',
    ).every((segment) => segment.status === 'success')).toBe(true)
    runner.dispose()
  })
})
