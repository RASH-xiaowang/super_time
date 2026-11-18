// @vitest-environment node
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listEnabledChatAiReplyStates,
  readChatAiReplyState,
  saveChatAiReplySetting,
  updateChatAiReplyRunState,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type { ChatAiReplyScanDeps } from '../src/query/ai-reply/types.ts'
import { createChatAiReplyRemotes } from '../src/remotes/chat-ai-reply.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import {
  completeAiReplyMessageListRecord,
  completeAiReplyMessageListRecordSegments,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  insertAiReplyMessageListRecord,
  claimMessageListRecordForDispatch,
  listMessageListRecords,
  reserveAiReplyMessageListRecord,
  saveMessageListDispatchResult,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import {
  dispatchMessageListRecord,
  dispatchPendingMessageListRecords,
} from '../src/query/message-list-dispatch.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let root = ''
let decrypted = ''

beforeEach(() => {
  harness.reset()
  root = harness.root
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

const reserveReply = (input: Parameters<ChatAiReplyScanDeps['reserveReply']>[0]) => (
  harness.reserveReply(input)
)
const completeReply = (input: Parameters<ChatAiReplyScanDeps['completeReply']>[0]) => (
  harness.completeReply(input)
)
const failReply = (input: Parameters<ChatAiReplyScanDeps['failReply']>[0]) => (
  harness.failReply(input)
)
const getReply = harness.getReply
const deps = (overrides: Partial<ChatAiReplyScanDeps> = {}) => harness.deps(overrides)

describe('消息列表 AI 来源与幂等', () => {
  it('旧版 AI 预约按创建时刻回填排序时间，升级后仍能在默认首屏看到', () => {
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
    })
    expect(reserved.ok).toBe(true)
    const record = listMessageListRecords(decrypted).items.find((item) => item.id === reserved.id)
    expect(record).toMatchObject({
      source: 'ai_reply',
      status: 'pending',
      text: '',
    })
    expect(record?.triggeredAt).toBe(record?.updatedAt)
    expect(record?.triggeredAt).toBeGreaterThan(1_000)
  })

  it('预约记录保持空正文和无地址，不会被后台批次提前投递', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1:1:pending',
    })
    expect(reserved).toMatchObject({
      ok: true,
      created: true,
      record: {
        source: 'ai_reply',
        status: 'pending',
        text: '',
        webhookUrl: '',
      },
    })
    let calls = 0
    const dispatchDeps = {
      decodeImage: async () => ({}),
      gate: (_feature: string, _stats: { sessions: number; messages: number }, texts: string[]) => texts,
      fetchImpl: async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      },
    }
    expect(await dispatchPendingMessageListRecords(decrypted, dispatchDeps)).toEqual({
      dispatched: 0,
      failed: 0,
    })
    expect(calls).toBe(0)

    const completed = completeAiReplyMessageListRecord(decrypted, reserved.id ?? 0, {
      text: '生成好的回复',
    })
    expect(completed).toMatchObject({
      ok: true,
      record: {
        status: 'pending',
        text: '生成好的回复',
        webhookUrl: '',
      },
    })
    const result = await dispatchMessageListRecord(decrypted, reserved.id ?? 0, dispatchDeps)
    expect(result.ok).toBe(true)
    expect(calls).toBe(1)
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      status: 'success',
      text: '生成好的回复',
      webhookUrl: 'https://downstream.example/ai',
    })
  })

  it('已存在的 sourceRef 返回 created=false，且不会重复投递', async () => {
    let calls = 0
    const input = {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      text: '只发一次',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1:1:1',
    }
    const first = insertAiReplyMessageListRecord(decrypted, input)
    const second = insertAiReplyMessageListRecord(decrypted, input)
    expect(first.created).toBe(true)
    expect(second).toMatchObject({ created: false, id: first.id })
    expect(listMessageListRecords(decrypted).total).toBe(1)

    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)
    const deps = {
      decodeImage: async () => ({}),
      gate: (_feature: string, _stats: { sessions: number; messages: number }, texts: string[]) => texts,
      fetchImpl: async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      },
    }
    await dispatchMessageListRecord(decrypted, first.id ?? 0, deps)
    expect(calls).toBe(1)
    expect(listMessageListRecords(decrypted).items[0]?.status).toBe('success')
  })
})

describe('群聊 AI 回复投递：@ 提问者', () => {
  it('群名作 target，提问者作 mention；规则按会话名仍然命中', async () => {
    // 群聊记录的 targetName 是提问者（用于 @ 人），chatName 才是群名（发送目的地）。
    const bodies: string[] = []
    const dispatchDeps = {
      decodeImage: async () => ({}),
      gate: (_feature: string, _stats: { sessions: number; messages: number }, texts: string[]) => texts,
      fetchImpl: async (_url: string, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''))
        return new Response('{"ok":true}', { status: 200 })
      },
    }
    // 默认 Webhook 自动绑定的规则是「会话名 + 会话名」，记录里没有地址快照。
    expect(saveMessageListRule(decrypted, {
      chatName: '测试群',
      targetName: '测试群',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '测试群',
      chatUsername: 'room@chatroom',
      targetName: '张三',
      targetUsername: 'wxid_asker',
      sourceRef: 'ai-reply:wxid_self:room@chatroom:3000:3:pending',
    })
    expect(reserved.ok, reserved.ok ? '' : reserved.error).toBe(true)
    completeAiReplyMessageListRecord(decrypted, reserved.id ?? 0, { text: '报价 100' })

    const result = await dispatchMessageListRecord(decrypted, reserved.id ?? 0, dispatchDeps)
    expect(result.ok, result.ok ? '' : result.error).toBe(true)
    expect(JSON.parse(bodies[0] ?? '{}')).toMatchObject({
      target: '测试群',
      message: '报价 100',
      mention: '张三',
    })
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      status: 'success',
      webhookUrl: 'https://downstream.example/ai',
    })
  })

  it('同一批次被拆成 3 段：只有首条 @ 提问者，后续段落是普通群消息', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const dispatchDeps = {
      decodeImage: async () => ({}),
      gate: (_feature: string, _stats: { sessions: number; messages: number }, texts: string[]) => texts,
      fetchImpl: async (_url: string, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        return new Response('{"ok":true}', { status: 200 })
      },
    }
    expect(saveMessageListRule(decrypted, {
      chatName: '测试群',
      targetName: '测试群',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)
    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '测试群',
      chatUsername: 'room@chatroom',
      targetName: '张三',
      targetUsername: 'wxid_asker',
      sourceRef: 'ai-reply:wxid_self:room@chatroom:4000:4',
    })
    expect(reserved.ok, reserved.ok ? '' : reserved.error).toBe(true)
    const completed = completeAiReplyMessageListRecordSegments(decrypted, reserved.id ?? 0, {
      segments: ['报价 100', '含运费 8 元', '今天下单明天到'],
    })
    expect(completed.ok, completed.ok ? '' : completed.error).toBe(true)
    const segments = completed.segments ?? []
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([1, 2, 3])

    // 逐条按顺序投递，模拟 runner 的串行补发。
    for (const segment of segments) {
      const result = await dispatchMessageListRecord(decrypted, segment.id, dispatchDeps)
      expect(result.ok, result.ok ? '' : result.error).toBe(true)
    }

    expect(bodies).toHaveLength(3)
    // 首条点名提问者。
    expect(bodies[0]).toMatchObject({ target: '测试群', message: '报价 100', mention: '张三' })
    // 后续段落在群里接着发，不再重复 @ 同一个人。
    expect(bodies[1]).toMatchObject({ target: '测试群', message: '含运费 8 元' })
    expect(bodies[2]).toMatchObject({ target: '测试群', message: '今天下单明天到' })
    expect(bodies[1]?.['mention']).toBeUndefined()
    expect(bodies[2]?.['mention']).toBeUndefined()
  })
})
