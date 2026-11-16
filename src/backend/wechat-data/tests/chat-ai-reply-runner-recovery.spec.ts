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

describe('AI 回复运行器 · 故障恢复与水位', () => {
  it('dispatchReply 抛异常时保留已落库记录并明确标注投递异常', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const runner = createChatAiReplyRunner(deps({
      dispatchReply: async () => {
        throw new Error('transport crashed')
      },
    }))
    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('failed')
    })
    const record = listMessageListRecords(decrypted).items[0]
    expect(record?.status).toBe('pending')
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    expect(state).toMatchObject({
      recordId: record?.id,
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
    })
    expect(state.error).toContain('投递异常')
    runner.dispose()
  })

  it('故障注入：缺少生成意图的旧空白 pending 必须 fail-closed，不重复调用模型', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved).toMatchObject({ ok: true, created: true })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'generating',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '恢复后的回复' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const reserveReplySpy = vi.fn(reserveReply)
    const runner = createChatAiReplyRunner(deps({
      generate,
      dispatchReply,
      reserveReply: reserveReplySpy,
    }))
    const recovered = await runner.recover()
    expect(recovered.recovered).toBe(1)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('缺少生成意图'),
      sourceRef,
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'failed',
      cursor: 'v2:100:1',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').pendingSourceRef).toBeUndefined()
    runner.dispose()
  })

  it('故障注入：已补全但未投递的 pending 只补投，不再次生成', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect((await completeReply({
      id: reserved.id ?? 0,
      text: '崩溃前已生成',
    })).ok).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不应再次生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({ generate, dispatchReply }))
    await runner.recover()
    await vi.waitFor(() => expect(dispatchReply).toHaveBeenCalledTimes(1))
    expect(generate).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    runner.dispose()
  })

  it('恢复时发现会话已推进：旧 pending 不生成不投递，下一拍处理最新消息', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: 'v2:100:1',
    }).ok).toBe(true)
    const oldSourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef: oldSourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '旧问题回复' })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: oldSourceRef,
      pendingRevision: 1,
    })).toBe(true)

    const oldMessage = {
      localId: 1,
      sortSeq: 100,
      createTime: 1000,
      isSender: 0,
      renderType: 'text',
      displayText: '旧问题',
    }
    const newerMessage = {
      localId: 2,
      sortSeq: 200,
      createTime: 2000,
      isSender: 0,
      renderType: 'text',
      displayText: '新问题',
    }
    const listMessagesAtOrBefore = vi.fn(async () => [oldMessage])
    const listMessagesAfter = vi.fn(async (_talker: string, cursor: string) => (
      cursor === 'v2:100:1' ? [newerMessage] : []
    ))
    const listMessages = vi.fn(async () => [oldMessage, newerMessage])
    const generate = vi.fn(async () => ({ ok: true, text: '新问题回复' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessages,
      listMessagesAtOrBefore,
      listMessagesAfter,
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
      cursor: 'v2:100:1',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').pendingSourceRef)
      .toBeUndefined()

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:200:2',
    })
    expect(listMessageListRecords(decrypted).items.some((record) =>
      record.sourceRef === 'ai-reply:wxid_self:wxid_peer:2000:2')).toBe(true)
    runner.dispose()
  })

  it('恢复补投前发现新消息时停止旧回复，不调用下游', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: 'v2:100:1',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '旧问题回复' })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)

    const oldMessage = {
      localId: 1,
      sortSeq: 100,
      createTime: 1000,
      isSender: 0,
      renderType: 'text',
      displayText: '旧问题',
    }
    const newerMessage = {
      localId: 2,
      sortSeq: 200,
      createTime: 2000,
      isSender: 0,
      renderType: 'text',
      displayText: '新问题',
    }
    let afterCalls = 0
    const listMessagesAfter = vi.fn(async () => {
      afterCalls += 1
      return afterCalls === 1 ? [] : [newerMessage]
    })
    const listMessagesAtOrBefore = vi.fn(async () => [oldMessage])
    const generate = vi.fn(async () => ({ ok: true, text: '不应生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessagesAtOrBefore,
      listMessagesAfter,
      generate,
      dispatchReply,
    }))

    const recovered = await runner.recover()
    expect(recovered.recovered).toBe(1)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(afterCalls).toBe(2)
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('过期'),
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'failed',
      cursor: 'v2:100:1',
    })
    runner.dispose()
  })

  it('故障注入：认领后崩溃的 dispatching 只收口，不自动重发', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '可能已发出' })
    expect(claimMessageListRecordForDispatch(
      decrypted,
      reserved.id ?? 0,
      'https://downstream.example/ai',
    )?.status).toBe('dispatching')
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'dispatching',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare('UPDATE message_list_records SET updated_at = ? WHERE id = ?')
        .run(Date.now() - 6 * 60_000, reserved.id ?? 0)
    })

    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({ generate, dispatchReply }))
    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)?.status).toBe('dispatching')
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    expect(state).toMatchObject({ stage: 'failed', cursor: 'v2:100:1' })
    expect(state.error).toContain('无法确认')
    runner.dispose()
  })

  it('旧状态缺少 pending 锚点且找不到原始消息时不猜测 sortSeq、不推进水位', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: 'v2:900:9',
    }).ok).toBe(true)
    const inserted = insertAiReplyMessageListRecord(decrypted, {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      text: '已有正文',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
    })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: inserted.id,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不应生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => [],
      generate,
      dispatchReply,
    }))
    const result = await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))

    expect(result.recovered).toBe(0)
    expect(result.errors?.[0]).toContain('缺少原始消息排序键')
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'saving',
      cursor: 'v2:900:9',
    })
    runner.dispose()
  })

  it('旧状态有 recordId 和 pending 正文时从消息列表 sourceRef 恢复补投，不重新生成', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '旧版本已生成' })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不得重新生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => [
        { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '原始消息' },
      ],
      generate,
      dispatchReply,
    }))
    await runner.recover()
    await vi.waitFor(() => expect(dispatchReply).toHaveBeenCalledTimes(1))
    expect(generate).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    runner.dispose()
  })

  it('pendingRevision 与当前 revision 不同：只收口旧记录，不生成也不出网', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'generating',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare(`UPDATE chat_ai_reply_settings SET revision = 2
        WHERE account_key = 'wxid_self' AND chat_username = 'wxid_peer'`).run()
    })

    const generate = vi.fn(async () => ({ ok: true, text: '旧配置不得继续' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({ generate, dispatchReply }))
    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)?.status).toBe('failed')
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'failed',
      cursor: 'v2:100:1',
      revision: 2,
    })
    runner.dispose()
  })

  it('设置 revision 推进时同步收口 pending 记录，填住旧 runner 回写前的崩溃窗口', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '旧配置生成' })
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)

    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      expectedRevision: 1,
      cursor: 'v2:200:2',
    }).ok).toBe(true)
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)).toMatchObject({
      status: 'failed',
      text: '旧配置生成',
    })
    const generate = vi.fn(async () => ({ ok: true, text: '不得继续' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const restarted = createChatAiReplyRunner(deps({ generate, dispatchReply }))
    await restarted.recover()
    await vi.waitFor(() => expect(restarted.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    restarted.dispose()
  })

  it('故障注入：HTTP 已成功但状态回写前崩溃时不会第二次出网', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)
    let calls = 0
    const dispatchOnceThenCrash = vi.fn(async (id: number) => {
      await dispatchMessageListRecord(decrypted, id, {
        decodeImage: async () => ({}),
        gate: (_feature, _stats, texts) => texts,
        fetchImpl: async () => {
          calls += 1
          return new Response('{"ok":true}', { status: 200 })
        },
      })
      throw new Error('simulated process crash after HTTP')
    })
    const runner = createChatAiReplyRunner(deps({
      generate: async () => ({ ok: true, text: '只发一次' }),
      dispatchReply: dispatchOnceThenCrash,
    }))
    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    })
    expect(calls).toBe(1)
    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(dispatchOnceThenCrash).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)
    runner.dispose()
  })

  it.each([
    { stage: 'generating' as const, text: '', generateCalls: 0, dispatchCalls: 0, httpCalls: 0, final: 'failed' },
    { stage: 'saving' as const, text: '已生成但未投递', generateCalls: 0, dispatchCalls: 1, httpCalls: 1, final: 'success' },
    { stage: 'dispatching' as const, text: '已认领但未确认', generateCalls: 0, dispatchCalls: 0, httpCalls: 0, final: 'failed' },
  ])(
    '重建 runner 的崩溃矩阵：$stage 同一 pending 二次恢复不重复生成/出网',
    async ({ stage, text, generateCalls, dispatchCalls, httpCalls, final }) => {
      expect(saveChatAiReplySetting(decrypted, {
        accountKey: 'wxid_self',
        chatUsername: 'wxid_peer',
        chatName: '小王',
        enabled: true,
        provider: 'dsh-wechat-bridge',
        cursor: '999:0',
      }).ok).toBe(true)
      expect(saveMessageListRule(decrypted, {
        targetName: '小王',
        webhookUrl: 'https://downstream.example/crash-matrix',
      }).ok).toBe(true)
      const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
      const reserved = await reserveReply({
        targetName: '小王',
        targetUsername: 'wxid_peer',
        chatName: '小王',
        chatUsername: 'wxid_peer',
        triggeredAt: 1_000_000,
        sourceRef,
      })
      const recordId = reserved.id ?? 0
      if (text !== '') {
        expect((await completeReply({ id: recordId, text })).ok).toBe(true)
      }
      if (stage === 'dispatching') {
        expect(claimMessageListRecordForDispatch(
          decrypted,
          recordId,
          'https://downstream.example/crash-matrix',
        )?.status).toBe('dispatching')
      }
      expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
        stage,
        recordId,
        pendingCursor: 'v2:100:1',
        pendingSourceRef: sourceRef,
        pendingRevision: 1,
      })).toBe(true)

      let generated = 0
      let dispatched = 0
      let fetched = 0
      const dispatchReply = vi.fn(async (id: number) => {
        dispatched += 1
        const result = await dispatchMessageListRecord(decrypted, id, {
          decodeImage: async () => ({}),
          gate: (_feature, _stats, texts) => texts,
          fetchImpl: async () => {
            fetched += 1
            return new Response('{"ok":true}', { status: 200 })
          },
        })
        return { ok: result.ok, ...(result.error === undefined ? {} : { error: result.error }) }
      })
      const crashDeps = deps({
        listMessages: async () => [
          { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '崩溃前消息' },
        ],
        generate: async () => {
          generated += 1
          return { ok: true, text: '恢复后发送' }
        },
        dispatchReply,
      })
      const crashed = createChatAiReplyRunner(crashDeps)
      const recovery = await crashed.recover()
      expect(recovery.recovered).toBe(1)
      await vi.waitFor(() => {
        expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe(final)
      })
      await vi.waitFor(() => expect(crashed.pending()).toBe(0))
      expect(generated).toBe(generateCalls)
      expect(dispatchReply).toHaveBeenCalledTimes(dispatchCalls)
      expect(fetched).toBe(httpCalls)
      const afterFirst = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
      expect(afterFirst.pendingCursor).toBeUndefined()
      expect(afterFirst.pendingSourceRef).toBeUndefined()
      expect(afterFirst.cursor).toBe('v2:100:1')
      crashed.dispose()

      const restarted = createChatAiReplyRunner(crashDeps)
      await restarted.recover()
      await vi.waitFor(() => expect(restarted.pending()).toBe(0))
      expect(generated).toBe(generateCalls)
      expect(dispatchReply).toHaveBeenCalledTimes(dispatchCalls)
      expect(fetched).toBe(httpCalls)
      restarted.dispose()
    },
  )

  it('同一会话存在多条新消息时只合并回复最新一条，不逐条补答旧问题', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const messages = [
      { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '第一条' },
      { localId: 2, sortSeq: 200, createTime: 2000, isSender: 0, renderType: 'text', displayText: '第二条' },
    ]
    const reserveReplySpy = vi.fn(reserveReply)
    const generate = vi.fn(async () => ({ ok: true, text: '合并回复' }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => messages,
      reserveReply: reserveReplySpy,
      generate,
    }))
    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'success',
        cursor: 'v2:200:2',
      })
    })
    expect(reserveReplySpy.mock.calls[0]?.[0].sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:2000:2')
    expect(generate).toHaveBeenCalledTimes(1)
    await runner.scan()
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
    runner.dispose()
  })

  it('Remote 启动恢复入口发现 pending 对应真实消息缺失时 fail-closed', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '启动时补投' })
    updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })

    const dispatch = vi.fn(async () => ({ ok: true }))
    const remotes = createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate: async () => ({ ok: true, text: '不应再次生成' }),
      dispatch,
      changed: () => {},
    })
    const result = await remotes.recoverOnce()
    expect(result.recovered).toBe(0)
    expect(result.errors?.[0]).toContain('不存在')
    expect(dispatch).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'saving',
      cursor: '999:0',
    })
    remotes.dispose()
  })

  it('Remote 启动恢复遇到无法校验的 dispatching 锚点时不越过水位', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    await completeReply({ id: reserved.id ?? 0, text: '可能已发出' })
    expect(claimMessageListRecordForDispatch(
      decrypted,
      reserved.id ?? 0,
      'https://downstream.example/ai',
    )?.status).toBe('dispatching')
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'dispatching',
      recordId: reserved.id,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
    })).toBe(true)
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare('UPDATE message_list_records SET updated_at = ? WHERE id = ?')
        .run(Date.now() - 6 * 60_000, reserved.id ?? 0)
    })

    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const dispatch = vi.fn(async () => ({ ok: true }))
    const remotes = createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate,
      dispatch,
      changed: () => {},
    })
    const result = await remotes.recoverOnce()
    expect(result.recovered).toBe(0)
    expect(result.errors?.[0]).toContain('不存在')
    expect(generate).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved.id ?? 0)?.status).toBe('sent_unconfirmed')
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'dispatching',
      cursor: '999:0',
    })
    remotes.dispose()
  })
})
