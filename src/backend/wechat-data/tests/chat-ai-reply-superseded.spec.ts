// @vitest-environment node
/**
 * AI 回复 · 「已过期（superseded）」的端到端语义。
 *
 * 被会话新消息越过的回复不是发送/生成失败：它按设计不发送，既不能进入自动
 * 批次，也不应该混进界面的失败统计。本组用例钉住三条：
 *  ① 生成完成但会话已推进 → 记录 failed + failureKind='superseded'；
 *  ② superseded 记录不会被 automatic 批次选中投递；
 *  ③ 旧版只有错误前缀的行由 schema 幂等回填，读取时仍是 superseded。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readChatAiReplyState,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type { ChatAiReplyScanMessage } from '../src/query/ai-reply/types.ts'
import { dispatchPendingMessageListRecords } from '../src/query/message-list-dispatch.ts'
import {
  completeAiReplyMessageListRecord,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  listMessageListRecords,
  reserveAiReplyMessageListRecord,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

const STALE_ERROR =
  '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题'

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
): ChatAiReplyScanMessage {
  return {
    localId,
    sortSeq,
    createTime,
    isSender: 0,
    renderType: 'text',
    displayText: text,
  }
}

describe('AI 回复 · 已过期（superseded）', () => {
  it('生成完成但会话已推进：记录 failed 且 failureKind=superseded，不投递', async () => {
    enable('v2:100:1')
    const old = message(2, 200, 1000, '旧问题')
    const newer = message(3, 300, 2000, '新问题')
    let generated = false
    const generate = vi.fn(async () => {
      generated = true
      return { ok: true, text: '已经生成的回答' }
    })
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(harness.deps({
      // 生成前看不到新消息；生成完成后会话已经推进，旧答复必须作废。
      listMessages: async () => (generated ? [old, newer] : [old]),
      listMessagesAfter: async () => (generated ? [newer] : []),
      generate,
      dispatchReply,
    }))

    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0), { timeout: 8_000 })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(dispatchReply).not.toHaveBeenCalled()
    const records = listMessageListRecords(decrypted)
    expect(records.total).toBe(1)
    const record = records.items[0]
    expect(record).toMatchObject({
      status: 'failed',
      text: '已经生成的回答',
      failureKind: 'superseded',
      source: 'ai_reply',
    })
    expect(record?.error).toContain('会话已有更新的消息')
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('failed')
    runner.dispose()
  })

  it('superseded 记录不会进入 automatic 批次投递', async () => {
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.id ?? 0
    expect(completeAiReplyMessageListRecord(decrypted, recordId, {
      text: '旧问题的回答',
    }).ok).toBe(true)
    expect(failAiReplyMessageListRecord(decrypted, recordId, STALE_ERROR, 'superseded').ok)
      .toBe(true)
    expect(saveMessageListRule(decrypted, {
      chatName: '小王',
      targetName: '小王',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)

    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const batch = await dispatchPendingMessageListRecords(decrypted, {
      decodeImage: async () => ({}),
      gate: (_feature, _stats, texts) => texts,
      fetchImpl,
    }, 20)

    expect(batch.dispatched).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'failed',
      failureKind: 'superseded',
    })
  })

  it('旧错误前缀由 schema 幂等回填，读取仍是 superseded 而不是 pending', () => {
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:2',
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.id ?? 0
    // 旧调用方没有 kind：本次写入得到未分类 failed 行。
    const failed = failAiReplyMessageListRecord(decrypted, recordId, STALE_ERROR)
    expect(failed.record?.status).toBe('failed')
    expect(failed.record?.failureKind).toBeUndefined()

    // 下一次 schema 初始化按旧错误前缀回填；读取不得退化成 pending。
    const read = getMessageListRecord(decrypted, recordId)
    expect(read).toMatchObject({
      status: 'failed',
      failureKind: 'superseded',
    })
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      status: 'failed',
      failureKind: 'superseded',
    })
  })
})
