// @vitest-environment node
/**
 * AI 回复生成期取消（止损 token）。
 *
 * 生成期间如果会话又来了新消息、租约易主或运行器停止，继续等模型说完只会白
 * 烧 token。这一组用例钉住：
 *  ① 新消息到达后中止生成，同一条消息只调用一次模型、绝不投递；
 *  ② 取消不会触发图片降级的第二次付费调用；
 *  ③ 租约丢失后没有写入资格，不回填任何生成/失败状态；
 *  ④ 正常完成不受取消器影响。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readChatAiReplyGenerationStrict,
  readChatAiReplyState,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { createDefaultChatAiReplyGenerator } from '../src/query/ai-reply/generator.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type {
  ChatAiReplyGenerationResult,
  ChatAiReplyScanDeps,
  ChatAiReplyScanMessage,
} from '../src/query/ai-reply/types.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import {
  getMessageListRecord,
  listMessageListRecords,
} from '../src/query/message-list-store.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

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

/** 模拟默认生成器：收到 abort 后立刻交回已流出的部分正文。 */
function abortAwareGenerate(
  partial: string,
  onStart?: () => void,
): ChatAiReplyScanDeps['generate'] {
  return (input) => {
    onStart?.()
    return new Promise<ChatAiReplyGenerationResult>((resolve) => {
      const signal = input.signal
      const canceled = (): void => {
        resolve({ ok: false, text: partial, canceled: true, error: '已取消' })
      }
      if (signal === undefined || signal.aborted) {
        canceled()
        return
      }
      signal.addEventListener('abort', canceled, { once: true })
    })
  }
}

function generationOf(chatUsername = 'wxid_peer') {
  const result = readChatAiReplyGenerationStrict(decrypted, 'wxid_self', chatUsername)
  expect(result.ok).toBe(true)
  return result.ok ? result.generation : undefined
}

function clearLease(chatUsername = 'wxid_peer'): void {
  withWritableDb(taskDbPath(decrypted), (db) => {
    db.prepare(`UPDATE chat_ai_reply_settings
      SET lease_owner = NULL, lease_until = 0
      WHERE account_key = 'wxid_self' AND chat_username = ?`).run(chatUsername)
  })
}

describe('AI 回复 · 生成期取消', () => {
  it('生成期间出现更新消息：取消生效且只生成一次、不投递，部分正文进入生成快照', async () => {
    enable()
    let messages: ChatAiReplyScanMessage[] = [
      message(1, 100, 1000, '旧消息'),
      message(2, 200, 2000, '在吗'),
    ]
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const generate = vi.fn(abortAwareGenerate('部分回复', () => { markEntered?.() }))
    const completeReply = vi.fn(harness.completeReply)
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const snapshots: Array<ReturnType<typeof generationOf>> = []
    const failReply = vi.fn(async (input: Parameters<ChatAiReplyScanDeps['failReply']>[0]) => {
      // 过期收口会把快照清掉；在收口写入前取一次，证明 partial 已先落盘。
      snapshots.push(generationOf())
      return harness.failReply(input)
    })
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => messages,
      generate,
      completeReply,
      failReply,
      dispatchReply,
    }), { owner: 'runner-cancel' })

    await runner.scan()
    await entered
    messages = [
      ...messages,
      message(3, 300, 3000, '又想起一件事'),
    ]

    await vi.waitFor(() => {
      expect(generate.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    }, { timeout: 5000, interval: 20 })
    await vi.waitFor(() => expect(runner.pending()).toBe(0), { timeout: 5000, interval: 20 })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(completeReply).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(failReply).toHaveBeenCalledTimes(1)
    expect(snapshots[0]).toMatchObject({
      state: 'result',
      text: '部分回复',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:2000:2',
    })
    const record = listMessageListRecords(decrypted).items[0]
    expect(record).toBeDefined()
    expect(record?.status).not.toBe('pending')
    expect(record?.status).toBe('failed')
    expect(getMessageListRecord(decrypted, record?.id ?? 0)).toMatchObject({
      status: 'failed',
      text: '',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('failed')
    runner.dispose()
  })

  it('取消不触发图片降级：只调用一次模型，返回部分正文', async () => {
    const controller = new AbortController()
    const seen: GenerateOptions[] = []
    const ctx = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'opencode', model: 'vision-model' }),
      },
      llm: {
        stream: (options: GenerateOptions) => {
          seen.push(options)
          return (async function* () {
            yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
            yield { type: 'text-delta' as const, index: 0, text: '部分' }
            controller.abort()
            // 即使错误文本看起来像图片不兼容，取消后也不允许再降级一次。
            throw new Error('LLM HTTP 400: image input is not supported')
          })()
        },
      },
    } as unknown as Context
    const generate = createDefaultChatAiReplyGenerator({ ctx: () => ctx })

    const result = await generate({
      system: 'system',
      prompt: '上下文\n\n本次随请求附带 1 张最近的图片，请结合图片内容理解上下文。\n\n请回复',
      images: [{
        localId: 1,
        dataUrl: 'data:image/png;base64,aGVsbG8=',
        mediaType: 'image/png',
        bytes: 5,
      }],
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      signal: controller.signal,
    })

    expect(result).toEqual({
      ok: false,
      text: '部分',
      canceled: true,
      error: '已取消',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.signal).toBe(controller.signal)
  })

  it('租约丢失后取消：不回写生成结果，也不标记失败', async () => {
    enable()
    const messages = [
      message(1, 100, 1000, '旧消息'),
      message(2, 200, 2000, '在吗'),
    ]
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const generate = vi.fn(abortAwareGenerate('不应落盘的部分回复', () => { markEntered?.() }))
    const failReply = vi.fn(harness.failReply)
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => messages,
      generate,
      failReply,
      dispatchReply,
    }), {
      owner: 'runner-lease-lost',
      heartbeatMs: 10,
      leaseMs: 60_000,
    })

    await runner.scan()
    await entered
    // 模拟另一个进程接管：心跳续租失败即宣告本 owner 失去写入资格。
    clearLease()

    await vi.waitFor(() => {
      expect(generate.mock.calls[0]?.[0].signal?.aborted).toBe(true)
    }, { timeout: 5000, interval: 20 })
    await vi.waitFor(() => expect(runner.pending()).toBe(0), { timeout: 5000, interval: 20 })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(failReply).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    // 生成意图仍在（证明没有追加 result），且记录保持 pending 空正文。
    expect(generationOf()).toMatchObject({ state: 'intent', text: '' })
    const records = listMessageListRecords(decrypted)
    expect(records.total).toBe(1)
    expect(getMessageListRecord(decrypted, records.items[0]?.id ?? 0)).toMatchObject({
      status: 'pending',
      text: '',
    })
    runner.dispose()
  })

  it('正常完成不受取消器影响', async () => {
    enable()
    const messages = [
      message(1, 100, 1000, '旧消息'),
      message(2, 200, 2000, '在吗'),
    ]
    let signal: AbortSignal | undefined
    const generate = vi.fn(async (input: Parameters<ChatAiReplyScanDeps['generate']>[0]) => {
      signal = input.signal
      return { ok: true, text: '正常回复' }
    })
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages: async () => messages,
      generate,
      dispatchReply,
    }), { owner: 'runner-normal' })

    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0), { timeout: 5000, interval: 20 })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(signal).toBeDefined()
    expect(signal?.aborted).toBe(false)
    expect(dispatchReply).toHaveBeenCalledTimes(1)
    const record = listMessageListRecords(decrypted).items[0]
    expect(record).toMatchObject({ status: 'pending', text: '正常回复' })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    runner.dispose()
  })
})
