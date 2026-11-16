// @vitest-environment node
/**
 * AI 回复跨会话并发准入。
 *
 * 每个会话单飞只保证同一会话不重复生成；同时开启很多会话时，一轮扫描仍会
 * 同时开出很多付费调用。这一组用例钉住：
 *  ① 并发上限只允许一个会话在飞，其余排队且不领租约；
 *  ② 前一个完成后队首才开始；
 *  ③ 队列已满（maxQueue=0）时本拍直接跳过，cursor/记录都不动；
 *  ④ dispose 唤醒等待者，不让扫描永久挂住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChatAiReplySetting } from '../src/query/ai-reply/config-store.ts'
import { createAdmissionLimiter } from '../src/query/ai-reply/runner-admission.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type {
  ChatAiReplyScanDeps,
  ChatAiReplyScanMessage,
} from '../src/query/ai-reply/types.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { listMessageListRecords } from '../src/query/message-list-store.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

beforeEach(() => {
  harness.reset()
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

function enable(chatUsername: string, chatName: string): void {
  expect(saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername,
    chatName,
    enabled: true,
    provider: 'dsh-wechat-bridge',
    cursor: 'v2:100:1',
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

function listMessages(talker: string): Promise<ChatAiReplyScanMessage[]> {
  return Promise.resolve([
    message(1, 100, 1000, '历史消息 ' + talker),
    message(2, 200, 2000, '新消息 ' + talker),
  ])
}

interface SettingRow {
  lease_owner?: unknown
  cursor?: unknown
  stage?: unknown
}

function settingRow(chatUsername: string): SettingRow {
  return withWritableDb(taskDbPath(decrypted), (db) => db.prepare(`SELECT
    lease_owner, cursor, stage
    FROM chat_ai_reply_settings
    WHERE account_key = 'wxid_self' AND chat_username = ?`).get(chatUsername) as SettingRow)
}

function leasedChats(): string[] {
  return ['wxid_peer_a', 'wxid_peer_b']
    .filter((chat) => settingRow(chat).lease_owner !== null)
}

function gateGenerate(): {
  generate: ChatAiReplyScanDeps['generate']
  release: () => void
  started: string[]
} {
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const started: string[] = []
  const generate: ChatAiReplyScanDeps['generate'] = async (input) => {
    started.push(input.chatUsername)
    // 只暂停第一个会话，排队会话拿到槽位后立即完成。
    if (started.length === 1) await firstGate
    return { ok: true, text: '回复 ' + input.chatUsername }
  }
  return {
    generate,
    release: () => { releaseFirst?.() },
    started,
  }
}

describe('AI 回复 · 跨会话并发准入', () => {
  it('maxConcurrentSessions=1 时同拍只有一个会话在飞，另一个排队且未领租约', async () => {
    enable('wxid_peer_a', '甲')
    enable('wxid_peer_b', '乙')
    const gated = gateGenerate()
    const generate = vi.fn(gated.generate)
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages,
      generate,
      dispatchReply,
    }), {
      owner: 'runner-admission',
      maxConcurrentSessions: 1,
      maxQueue: 8,
      coalesceMs: 0,
    })

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), {
      timeout: 5000,
      interval: 20,
    })

    // 另一个会话仍在排队：没有领租约，也没有建预约记录。
    expect(leasedChats()).toHaveLength(1)
    expect(settingRow(leasedChats()[0] ?? '').lease_owner).toBe('runner-admission')
    expect(listMessageListRecords(decrypted).total).toBe(1)

    gated.release()
    await vi.waitFor(() => expect(runner.pending()).toBe(0), {
      timeout: 5000,
      interval: 20,
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(dispatchReply).toHaveBeenCalledTimes(2)
    expect(listMessageListRecords(decrypted).total).toBe(2)
    runner.dispose()
  })

  it('一个会话完成后，排队的会话才开始生成', async () => {
    enable('wxid_peer_a', '甲')
    enable('wxid_peer_b', '乙')
    const gated = gateGenerate()
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages,
      generate: gated.generate,
    }), {
      owner: 'runner-queue',
      maxConcurrentSessions: 1,
      maxQueue: 8,
      coalesceMs: 0,
    })

    await runner.scan()
    await vi.waitFor(() => expect(gated.started).toHaveLength(1), {
      timeout: 5000,
      interval: 20,
    })
    const first = gated.started[0]
    expect(first).toBeDefined()

    gated.release()
    await vi.waitFor(() => expect(gated.started).toHaveLength(2), {
      timeout: 5000,
      interval: 20,
    })
    expect(gated.started[0]).toBe(first)
    expect(gated.started[1]).not.toBe(first)
    await vi.waitFor(() => expect(runner.pending()).toBe(0), {
      timeout: 5000,
      interval: 20,
    })
    runner.dispose()
  })

  it('maxQueue=0 时第二个会话本拍跳过：cursor 不变、不建记录', async () => {
    enable('wxid_peer_a', '甲')
    enable('wxid_peer_b', '乙')
    const gated = gateGenerate()
    const generate = vi.fn(gated.generate)
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages,
      generate,
    }), {
      owner: 'runner-no-queue',
      maxConcurrentSessions: 1,
      maxQueue: 0,
      coalesceMs: 0,
    })

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), {
      timeout: 5000,
      interval: 20,
    })

    const running = leasedChats()
    expect(running).toHaveLength(1)
    const skipped = running[0] === 'wxid_peer_a' ? 'wxid_peer_b' : 'wxid_peer_a'
    expect(settingRow(skipped)).toMatchObject({
      lease_owner: null,
      cursor: 'v2:100:1',
      stage: 'idle',
    })
    expect(listMessageListRecords(decrypted).total).toBe(1)

    gated.release()
    await vi.waitFor(() => expect(runner.pending()).toBe(0), {
      timeout: 5000,
      interval: 20,
    })
    // 本拍不会再补跑被跳过的会话。
    expect(generate).toHaveBeenCalledTimes(1)
    expect(settingRow(skipped)).toMatchObject({
      lease_owner: null,
      cursor: 'v2:100:1',
      stage: 'idle',
    })
    runner.dispose()
  })

  it('dispose 唤醒准入等待者', async () => {
    const limiter = createAdmissionLimiter({ maxConcurrent: 1, maxQueue: 2 })
    expect(await limiter.acquire(() => false)).toBe(true)
    expect(limiter.waiting()).toBe(0)

    const waiting = limiter.acquire(() => false)
    expect(limiter.waiting()).toBe(1)
    limiter.wakeAll(false)
    await expect(waiting).resolves.toBe(false)
    expect(limiter.waiting()).toBe(0)

    // 已停止的 runner 不再授予新槽位。
    expect(await limiter.acquire(() => true)).toBe(false)
    limiter.release()
  })

  it('runner.dispose 时等待中的会话不会创建预约', async () => {
    enable('wxid_peer_a', '甲')
    enable('wxid_peer_b', '乙')
    const gated = gateGenerate()
    const generate = vi.fn(gated.generate)
    const runner = createChatAiReplyRunner(harness.deps({
      listMessages,
      generate,
    }), {
      owner: 'runner-dispose',
      maxConcurrentSessions: 1,
      maxQueue: 8,
      coalesceMs: 0,
    })

    await runner.scan()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1), {
      timeout: 5000,
      interval: 20,
    })
    runner.dispose()
    gated.release()
    // 等第一个任务收尾；排队者已被 wakeAll(false) 唤醒并直接退出。
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(generate).toHaveBeenCalledTimes(1)
    expect(listMessageListRecords(decrypted).total).toBe(1)
  })
})
