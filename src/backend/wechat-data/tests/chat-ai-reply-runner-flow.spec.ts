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

describe('AI 回复运行器 · 流程与游标', () => {
  it('首次扫描只建立水位，不回复历史；新消息到达后先预约消息列表再生成', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)

    let messages = [
      { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '历史消息' },
    ]
    const generate = vi.fn(async () => {
      // 预约已经成功，但尚未完成/投递前水位必须停在上一锚点。
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'generating',
        cursor: 'v2:100:1',
        pendingCursor: 'v2:200:2',
        pendingSourceRef: 'ai-reply:wxid_self:wxid_peer:2000:2',
      })
      expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
        source: 'ai_reply',
        status: 'pending',
        text: '',
        webhookUrl: '',
      })
      return { ok: true, text: '新回复' }
    })
    const gate = vi.fn((_feature: string, _stats: { sessions: number; messages: number }, texts: string[]) => texts)
    const reserveReplySpy = vi.fn(reserveReply)
    const completeReplySpy = vi.fn(completeReply)
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => messages,
      generate,
      gate,
      reserveReply: reserveReplySpy,
      completeReply: completeReplySpy,
    }))

    const first = await runner.scan()
    expect(first.queued).toBe(0)
    expect(generate).not.toHaveBeenCalled()

    messages = [
      ...messages,
      { localId: 2, sortSeq: 200, createTime: 2000, isSender: 0, renderType: 'text', displayText: '在吗' },
    ]
    const second = await runner.scan()
    expect(second.queued).toBe(1)
    await vi.waitFor(() => expect(completeReplySpy).toHaveBeenCalledTimes(1))
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(gate).toHaveBeenCalledWith('ai_reply_analyze', expect.any(Object), expect.any(Array))
    const record = listMessageListRecords(decrypted).items[0]
    expect(record).toMatchObject({
      source: 'ai_reply',
      text: '新回复',
      targetName: '小王',
      targetUsername: 'wxid_peer',
      webhookUrl: '',
    })
    expect(record?.sourceRef).toBe('ai-reply:wxid_self:wxid_peer:2000:2')
    runner.dispose()
  })

  it('AI 预约使用触发时刻排序，超过首屏 200 条后仍在默认列表首条可见', async () => {
    const fixedNow = 1_800_000_000_000
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: 'v2:100:1',
    }).ok).toBe(true)
    for (let index = 0; index < 201; index += 1) {
      const inserted = insertAiReplyMessageListRecord(decrypted, {
        targetName: '小王',
        chatName: '小王',
        chatUsername: 'wxid_peer',
        targetUsername: 'wxid_peer',
        text: '历史台账 ' + String(index),
        triggeredAt: fixedNow - index - 1,
        sourceRef: 'ai-reply:wxid_self:wxid_peer:' + String(index + 1) + ':' + String(index + 1),
      })
      expect(inserted.ok).toBe(true)
    }

    let releaseGenerate: (result: { ok: boolean, text: string }) => void = () => {}
    const generating = new Promise<{ ok: boolean, text: string }>((resolve) => {
      releaseGenerate = resolve
    })
    const generate = vi.fn(() => generating)
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => [
        { localId: 2, sortSeq: 200, createTime: 1_700_000_000, isSender: 0, renderType: 'text', displayText: '在吗' },
      ],
      generate,
    }), { now: () => fixedNow })

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))

    const page = listMessageListRecords(decrypted)
    expect(page.items).toHaveLength(200)
    expect(page.hasMore).toBe(true)
    expect(page.items[0]).toMatchObject({
      source: 'ai_reply',
      status: 'pending',
      text: '',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1700000000:2',
    })
    expect(page.items[0]?.triggeredAt).toBe(fixedNow)

    releaseGenerate({ ok: false, text: '' })
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    runner.dispose()
  })

  it('cursor 后存在积压时合并到最新消息，不逐条补答旧消息', async () => {
    const saved = saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(saved.ok).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'idle',
      cursor: 'v2:100:1',
    })).toBe(true)

    const listMessagesAfter = vi.fn(async () => [
      { localId: 2, sortSeq: 101, createTime: 2000, isSender: 0, renderType: 'text', displayText: '积压最早一条' },
      { localId: 3, sortSeq: 102, createTime: 3000, isSender: 0, renderType: 'text', displayText: '积压第二条' },
    ])
    const generate = vi.fn(async () => ({ ok: true, text: '回复最新一条' }))
    const runner = createChatAiReplyRunner(deps({
      // 最新窗口故意完全看不到积压消息。
      listMessages: async () => [
        { localId: 900, sortSeq: 999, createTime: 999_000, isSender: 0, renderType: 'text', displayText: '最新消息' },
      ],
      listMessagesAfter,
      generate,
    }))

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    expect(listMessagesAfter).toHaveBeenCalledWith('wxid_peer', 'v2:100:1', 80)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:999:900',
    })
    expect(listMessageListRecords(decrypted).items[0]?.sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:999000:900')
    expect(generate).toHaveBeenCalledTimes(1)
    runner.dispose()
  })

  it('最新可视消息是自己时不自动回复，等对方再次发言才处理', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: 'v2:100:1',
    }).ok).toBe(true)
    let messages = [
      { localId: 2, sortSeq: 200, createTime: 2000, isSender: 0, renderType: 'text', displayText: '已经问过' },
      { localId: 3, sortSeq: 300, createTime: 3000, isSender: 1, renderType: 'text', displayText: '已经回复' },
    ]
    const generate = vi.fn(async () => ({ ok: true, text: '新回复' }))
    const reserveReplySpy = vi.fn(reserveReply)
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => messages,
      generate,
      reserveReply: reserveReplySpy,
    }))

    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(reserveReplySpy).not.toHaveBeenCalled()

    messages = [
      ...messages,
      { localId: 4, sortSeq: 400, createTime: 4000, isSender: 0, renderType: 'text', displayText: '新问题' },
    ]
    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:400:4',
    })
    expect(reserveReplySpy.mock.calls[0]?.[0].sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:4000:4')
    runner.dispose()
  })

  it('pending 锚点掉出最新窗口后按 localId 精确恢复，不永久卡住会话', async () => {
    const saved = saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(saved.ok).toBe(true)
    const revision = saved.state?.revision ?? 1
    const sourceRef = 'ai-reply:wxid_self:wxid_peer:5000:42'
    const reserved = await reserveReply({
      targetName: '小王',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      triggeredAt: 5_000_000,
      sourceRef,
      note: 'AI 回复 · 生成中',
    })
    expect(reserved.ok).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'generating',
      pendingCursor: 'v2:50:42',
      pendingSourceRef: sourceRef,
      pendingRevision: revision,
      recordId: reserved.id ?? null,
      generationState: 'intent',
      generationSourceRef: sourceRef,
      generationRevision: revision,
    })).toBe(true)

    const listMessagesAtOrBefore = vi.fn(async () => [
      { localId: 42, sortSeq: 50, createTime: 5000, isSender: 0, renderType: 'text', displayText: '旧锚点' },
    ])
    const listMessages = vi.fn(async () => Array.from({ length: 80 }, (_, index) => ({
      localId: 1000 + index,
      sortSeq: 1000 + index,
      createTime: 1_000_000 + index,
      isSender: 0,
      renderType: 'text',
      displayText: '最新窗口 ' + String(index),
    })))
    const runner = createChatAiReplyRunner(deps({
      listMessages,
      listMessagesAtOrBefore,
    }))

    const result = await runner.scan()
    expect(result.errors).toBeUndefined()
    expect(listMessages).not.toHaveBeenCalled()
    expect(listMessagesAtOrBefore).toHaveBeenCalledWith('wxid_peer', 42, 20)
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    runner.dispose()
  })

  it('预约消息列表失败时不推进水位，重启后仍从同一锚点恢复', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const send = vi.fn(async () => ({ ok: true }))
    const generate = vi.fn(async () => ({ ok: true, text: '恢复后生成' }))
    const reserveReplySpy = vi.fn(async (input: Parameters<ChatAiReplyScanDeps['reserveReply']>[0]) => {
      if (reserveReplySpy.mock.calls.length === 1) {
        return { ok: false, error: '消息列表写入失败' }
      }
      return reserveReply(input)
    })
    const runner = createChatAiReplyRunner(deps({
      reserveReply: reserveReplySpy,
      generate,
      dispatchReply: send,
    }))
    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'failed',
        cursor: '999:0',
        pendingCursor: 'v2:100:1',
        pendingSourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
      })
    })
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(listMessageListRecords(decrypted).total).toBe(0)
    runner.dispose()

    const restartedReserve = vi.fn(reserveReply)
    const restarted = createChatAiReplyRunner(deps({
      reserveReply: restartedReserve,
      generate,
      dispatchReply: send,
    }))
    const recovered = await restarted.recover()
    expect(recovered.recovered).toBe(1)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(restartedReserve).toHaveBeenCalledTimes(1)
    expect(restartedReserve.mock.calls[0]?.[0].sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:1000:1')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    restarted.dispose()
  })

  it('落库成功但投递失败时保留记录，并把状态明确标为已落库、投递失败', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const events: string[] = []
    const runner = createChatAiReplyRunner(deps({
      onRecordSaved: () => events.push('saved'),
      dispatchReply: async () => ({ ok: false, error: 'webhook 返回 HTTP 500' }),
      onDispatchFinished: ({ ok }) => events.push(ok ? 'dispatched' : 'dispatch-failed'),
    }))
    await runner.scan()
    await vi.waitFor(() => expect(events).toEqual(['saved', 'dispatch-failed']))
    const records = listMessageListRecords(decrypted)
    expect(records.total).toBe(1)
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    expect(state).toMatchObject({
      stage: 'failed',
      recordId: records.items[0]?.id,
    })
    expect(state.error).toContain('已写入消息列表')
    expect(state.error).toContain('投递失败')
    runner.dispose()
  })

  it('模型生成期间关闭开关后，保留失败记录但不补全也不投递', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const reserveReplySpy = vi.fn(reserveReply)
    const completeReplySpy = vi.fn(completeReply)
    const dispatchReply = vi.fn(async (id: number) => {
      saveMessageListDispatchResult(decrypted, id, {
        status: 'success',
        error: '',
        responseSummary: 'test success',
      })
      return { ok: true }
    })
    const runner = createChatAiReplyRunner(deps({
      generate: async () => {
        expect(saveChatAiReplySetting(decrypted, {
          accountKey: 'wxid_self',
          chatUsername: 'wxid_peer',
          chatName: '小王',
          enabled: false,
          provider: 'dsh-wechat-bridge',
          expectedRevision: 1,
          cursor: '1000:1',
        }).ok).toBe(true)
        return { ok: true, text: '不应发送' }
      },
      reserveReply: reserveReplySpy,
      completeReply: completeReplySpy,
      dispatchReply,
    }))
    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    expect(completeReplySpy).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      source: 'ai_reply',
      status: 'failed',
      text: '',
      webhookUrl: '',
    })
    expect(listMessageListRecords(decrypted).items[0]?.error).toContain('已关闭')
    runner.dispose()
  })

  it('生成期间关闭再重开会作废旧任务，不写旧回复也不回退新游标', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const reserveReplySpy = vi.fn(reserveReply)
    const completeReplySpy = vi.fn(completeReply)
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      generate: async () => {
        expect(saveChatAiReplySetting(decrypted, {
          accountKey: 'wxid_self',
          chatUsername: 'wxid_peer',
          chatName: '小王',
          enabled: false,
          provider: 'dsh-wechat-bridge',
          expectedRevision: 1,
        }).ok).toBe(true)
        expect(saveChatAiReplySetting(decrypted, {
          accountKey: 'wxid_self',
          chatUsername: 'wxid_peer',
          chatName: '小王',
          enabled: true,
          provider: 'dsh-wechat-bridge',
          expectedRevision: 2,
          cursor: '2000:2',
        }).ok).toBe(true)
        return { ok: true, text: '旧任务不得发送' }
      },
      reserveReply: reserveReplySpy,
      completeReply: completeReplySpy,
      dispatchReply,
    }))
    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    expect(completeReplySpy).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      source: 'ai_reply',
      status: 'failed',
      text: '',
      webhookUrl: '',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      enabled: true,
      revision: 3,
      cursor: '2000:2',
      stage: 'idle',
    })
    runner.dispose()
  })

  it('重复 sourceRef 返回 created=false，绝不再次调用 dispatchReply', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const dispatchReply = vi.fn(async (id: number) => {
      saveMessageListDispatchResult(decrypted, id, {
        status: 'success',
        error: '',
        responseSummary: 'test success',
      })
      return { ok: true }
    })
    const runner = createChatAiReplyRunner(deps({ dispatchReply }))
    await runner.scan()
    await vi.waitFor(() => expect(dispatchReply).toHaveBeenCalledTimes(1))
    // 重开开关会重置游标，但同一 anchor 的 sourceRef 仍必须命中幂等。
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      expectedRevision: 1,
      cursor: '999:0',
    }).ok).toBe(true)
    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(dispatchReply).toHaveBeenCalledTimes(1)
    runner.dispose()
  })

  it('并发 scan 仍按会话单飞，只生成一次', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const generate = vi.fn(async () => ({ ok: true, text: '只生成一次' }))
    const reserveReplySpy = vi.fn(reserveReply)
    const completeReplySpy = vi.fn(completeReply)
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      generate,
      reserveReply: reserveReplySpy,
      completeReply: completeReplySpy,
      dispatchReply,
    }))

    await Promise.all([runner.scan(), runner.scan()])
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    expect(completeReplySpy).toHaveBeenCalledTimes(1)
    expect(dispatchReply).toHaveBeenCalledTimes(1)
    runner.dispose()
  })

  it('读取消息期间水位前进后，延迟 scan 不会用旧 cursor 再次生成', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    let release: (() => void) | undefined
    let listCalls = 0
    const generate = vi.fn(async () => ({ ok: true, text: '不应生成' }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => {
        listCalls += 1
        if (listCalls === 1) {
          await new Promise<void>((resolve) => { release = resolve })
        }
        return [
          { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '旧消息' },
        ]
      },
      generate,
    }))
    const scanning = runner.scan()
    await vi.waitFor(() => expect(release).toBeDefined())
    updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'success',
      cursor: '2000:2',
    })
    release?.()
    await scanning
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').cursor).toBe('2000:2')
    runner.dispose()
  })

  it('延迟任务不能把较新的 cursor 回退到旧锚点', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '2000:20',
    }).ok).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'success',
      cursor: '1000:10',
    })).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').cursor).toBe('2000:20')
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'success',
      cursor: '2000:21',
    })).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').cursor).toBe('2000:21')
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'success',
      cursor: 'v2:500:5',
    })).toBe(true)
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'success',
      cursor: 'v2:499:999',
    })).toBe(true)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').cursor).toBe('v2:500:5')
  })

  it('v2 水位按 sortSeq 判断，迟到但排序更靠后的同步消息不会被 createTime 永久跳过', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: 'v2:500:5',
    }).ok).toBe(true)
    const generate = vi.fn(async () => ({ ok: true, text: '迟到消息也能回复' }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => [
        {
          localId: 6,
          sortSeq: 600,
          createTime: 100,
          isSender: 0,
          renderType: 'text',
          displayText: '同步迟到但排序更新',
        },
      ],
      generate,
    }))

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'success',
        cursor: 'v2:600:6',
      })
    })
    runner.dispose()
  })

  it('空历史首次开启后到达的第一条消息仍会生成回复', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '0:0',
    }).ok).toBe(true)
    let messages: Array<{
      localId: number
      sortSeq: number
      createTime: number
      isSender: number
      renderType: string
      displayText: string
    }> = []
    const generate = vi.fn(async () => ({ ok: true, text: '第一条回复' }))
    const reserveReplySpy = vi.fn(reserveReply)
    const completeReplySpy = vi.fn(completeReply)
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => messages,
      generate,
      reserveReply: reserveReplySpy,
      completeReply: completeReplySpy,
    }))
    await runner.scan()
    expect(generate).not.toHaveBeenCalled()
    messages = [
      { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '你好' },
    ]
    await runner.scan()
    await vi.waitFor(() => expect(completeReplySpy).toHaveBeenCalledTimes(1))
    expect(reserveReplySpy).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledTimes(1)
    runner.dispose()
  })

  it('模型失败保留失败锚点，不自动回放旧消息', async () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      cursor: '999:0',
    }).ok).toBe(true)
    const generate = vi.fn(async () => ({ ok: false, text: '', error: '模型不可用' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({ generate, dispatchReply }))
    await runner.scan()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'failed',
        cursor: 'v2:100:1',
      })
    })
    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      source: 'ai_reply',
      status: 'failed',
      text: '',
      webhookUrl: '',
    })
    expect(listMessageListRecords(decrypted).items[0]?.error).toContain('模型不可用')
    runner.dispose()
  })

})
