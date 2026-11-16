// @vitest-environment node
/**
 * 桌面端「重新生成」AI 回复的端到端守卫。
 *
 * 这个入口会**明确再花一次模型钱**，因此本组用例钉住三件事：
 *  ① 只有空白 failed、24 小时内、失败分类可重试的记录会被原地复用并恰好生成一次；
 *  ② 已有正文/投递事实/job/attempts/超时/会话推进全部在调用模型之前拒绝；
 *  ③ 租约被其它进程持有时同样拒绝，且不写记录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readChatAiReplyState,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { claimChatAiReplyRun } from '../src/query/ai-reply/lease-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type { ChatAiReplyScanMessage } from '../src/query/ai-reply/types.ts'
import {
  completeAiReplyMessageListRecord,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  listMessageListRecords,
  reserveAiReplyMessageListRecord,
  saveMessageListDispatchResult,
} from '../src/query/message-list-store.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

const SOURCE_REF = 'ai-reply:wxid_self:wxid_peer:1000:1'
const PEER_MESSAGE: ChatAiReplyScanMessage = {
  localId: 1,
  sortSeq: 100,
  createTime: 1000,
  isSender: 0,
  renderType: 'text',
  displayText: '你好',
}

beforeEach(() => {
  harness.reset()
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

/** 开启当前会话 AI 回复；直接调 regenerate 不依赖扫描器建立水位。 */
function enable(): void {
  expect(saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    chatName: '小王',
    enabled: true,
    provider: 'dsh-wechat-bridge',
    cursor: 'v2:0:0',
  }).ok).toBe(true)
}

/** 建一条空白 failed 记录（模拟模型失败/被设计取消后的失败收口）。 */
function seedFailedBlank(
  failureKind = 'generation_failed',
  sourceRef = SOURCE_REF,
): number {
  const reserved = reserveAiReplyMessageListRecord(decrypted, {
    targetName: '小王',
    targetUsername: 'wxid_peer',
    chatName: '小王',
    chatUsername: 'wxid_peer',
    triggeredAt: Date.now(),
    sourceRef,
  })
  expect(reserved.ok).toBe(true)
  const id = reserved.id ?? 0
  expect(failAiReplyMessageListRecord(decrypted, id, '模型没有返回可用回复', failureKind).ok)
    .toBe(true)
  return id
}

/** 建一条已生成正文、随后又被标失败的记录（正文守卫用）。 */
function seedFailedWithText(): number {
  const reserved = reserveAiReplyMessageListRecord(decrypted, {
    targetName: '小王',
    targetUsername: 'wxid_peer',
    chatName: '小王',
    chatUsername: 'wxid_peer',
    triggeredAt: Date.now(),
    sourceRef: SOURCE_REF,
  })
  expect(reserved.ok).toBe(true)
  const id = reserved.id ?? 0
  expect(completeAiReplyMessageListRecord(decrypted, id, { text: '已经生成过的回答' }).ok)
    .toBe(true)
  expect(failAiReplyMessageListRecord(decrypted, id, '后续步骤失败', 'generation_failed').ok)
    .toBe(true)
  return id
}

function makeRunner(overrides: {
  generate?: (input: { prompt: string }) => Promise<{ ok: boolean; text: string; error?: string }>
  listMessages?: (talker: string, limit: number) => Promise<ChatAiReplyScanMessage[]>
  now?: () => number
  dispatchReply?: (recordId: number) => Promise<{ ok: boolean; error?: string }>
  runnerOptions?: { leaseMs?: number; heartbeatMs?: number }
} = {}) {
  const generate = vi.fn(overrides.generate ?? (async () => ({
    ok: true,
    text: '重新生成的回答',
  })))
  const dispatchReply = vi.fn(overrides.dispatchReply ?? (async (recordId: number) => {
    saveMessageListDispatchResult(decrypted, recordId, {
      status: 'success',
      error: '',
      responseSummary: '',
      countAttempt: false,
    })
    return { ok: true }
  }))
  const runner = createChatAiReplyRunner(harness.deps({
    listMessages: overrides.listMessages ?? (async () => [PEER_MESSAGE]),
    generate: generate as never,
    dispatchReply: dispatchReply as never,
  }), {
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...overrides.runnerOptions,
  })
  return { runner, generate, dispatchReply }
}

describe('AI 回复 · 桌面端重新生成：成功路径', () => {
  it('空白 failed 记录被原地复用：generate 恰好 1 次，不新增 sourceRef，最终 success', async () => {
    enable()
    const id = seedFailedBlank()
    const { runner, generate } = makeRunner()

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result).toEqual({ ok: true })
    expect(generate).toHaveBeenCalledTimes(1)
    const items = listMessageListRecords(decrypted).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id,
      source: 'ai_reply',
      sourceRef: SOURCE_REF,
      status: 'success',
      text: '重新生成的回答',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage).toBe('success')
    runner.dispose()
  })

  it('模型调用超过租约窗口时心跳续租，外面的扫描不能抢走付款结果', async () => {
    enable()
    const id = seedFailedBlank()
    const { runner } = makeRunner({
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 900))
        return { ok: true, text: '心跳续租后的回答' }
      },
      runnerOptions: { leaseMs: 300, heartbeatMs: 20 },
    })

    const pending = runner.regenerate(id, SOURCE_REF)
    // 已超过一次租约窗口（300ms），但心跳仍在续期；此时另一进程不能认领。
    // 观察点留足余量，避免 CI 事件循环抖动把租约放过期造成偶发失败。
    await new Promise((resolve) => setTimeout(resolve, 400))
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const stolen = claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'other-process',
      expected: state,
      now: Date.now(),
      leaseMs: 300,
    })
    expect(stolen, '心跳没有续租，租约被外部扫描抢走').toBeNull()
    expect(await pending).toEqual({ ok: true })
    expect(getMessageListRecord(decrypted, id)).toMatchObject({
      status: 'success',
      text: '心跳续租后的回答',
    })
    runner.dispose()
  })

  it('模型再次失败：记录回到 failed 且保留可重试分类，不产生第二条记录', async () => {
    enable()
    const id = seedFailedBlank('generation_failed')
    const { runner, generate } = makeRunner({
      generate: async () => ({ ok: false, text: '', error: '模型暂时不可用' }),
    })

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('模型暂时不可用')
    expect(generate).toHaveBeenCalledTimes(1)
    const items = listMessageListRecords(decrypted).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id,
      sourceRef: SOURCE_REF,
      status: 'failed',
      failureKind: 'generation_failed',
      text: '',
    })
    runner.dispose()
  })
})

describe('AI 回复 · 桌面端重新生成：模型调用前拒绝', () => {
  it('已有生成正文 → 拒绝且不调模型', async () => {
    enable()
    const id = seedFailedWithText()
    const { runner, generate } = makeRunner()

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('正文')
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('已成功 / sent_unconfirmed 等投递事实 → 拒绝且不调模型', async () => {
    enable()
    const successId = seedFailedBlank()
    saveMessageListDispatchResult(decrypted, successId, {
      status: 'success',
      error: '',
      responseSummary: '',
      countAttempt: false,
    })
    const uncertainId = seedFailedBlank('generation_failed', 'ai-reply:wxid_self:wxid_peer:1000:2')
    saveMessageListDispatchResult(decrypted, uncertainId, {
      status: 'sent_unconfirmed',
      error: '结果无法确认',
      responseSummary: '',
      countAttempt: false,
      failureKind: 'unconfirmed',
    })
    const { runner, generate } = makeRunner()

    expect((await runner.regenerate(successId, SOURCE_REF)).ok).toBe(false)
    expect((await runner.regenerate(
      uncertainId,
      'ai-reply:wxid_self:wxid_peer:1000:2',
    )).ok).toBe(false)
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('job_id 非空或 attempts>0 → 拒绝且不调模型', async () => {
    enable()
    const jobId = seedFailedBlank()
    saveMessageListDispatchResult(decrypted, jobId, {
      status: 'failed',
      error: '投递失败',
      responseSummary: '',
      jobId: 'job-123',
      failureKind: 'generation_failed',
      countAttempt: false,
    })
    const attemptId = seedFailedBlank('generation_failed', 'ai-reply:wxid_self:wxid_peer:1000:2')
    saveMessageListDispatchResult(decrypted, attemptId, {
      status: 'failed',
      error: '投递失败',
      responseSummary: '',
      failureKind: 'generation_failed',
    })
    const { runner, generate } = makeRunner()

    expect((await runner.regenerate(jobId, SOURCE_REF)).ok).toBe(false)
    expect((await runner.regenerate(
      attemptId,
      'ai-reply:wxid_self:wxid_peer:1000:2',
    )).ok).toBe(false)
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('失败分类不在 superseded/generation_failed/config_changed 内 → 拒绝', async () => {
    enable()
    const id = seedFailedBlank('send_failed')
    const { runner, generate } = makeRunner()

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('失败分类')
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('记录超过 24 小时 → 拒绝且不调模型', async () => {
    enable()
    const id = seedFailedBlank()
    const { runner, generate } = makeRunner({
      now: () => Date.now() + 25 * 60 * 60 * 1000,
    })

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('24 小时')
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('会话已有更新的消息 → 拒绝且不调模型', async () => {
    enable()
    const id = seedFailedBlank()
    const newer: ChatAiReplyScanMessage = {
      localId: 2,
      sortSeq: 200,
      createTime: 2000,
      isSender: 0,
      renderType: 'text',
      displayText: '新问题',
    }
    const { runner, generate } = makeRunner({
      listMessages: async () => [PEER_MESSAGE, newer],
    })

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result).toEqual({ ok: false, error: '会话已有新的消息，不能重新生成' })
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('设置已关闭或 sourceRef 不一致 → 拒绝且不调模型', async () => {
    enable()
    const id = seedFailedBlank()
    const { runner, generate } = makeRunner()

    expect((await runner.regenerate(id, 'ai-reply:wxid_self:wxid_peer:1000:9')).ok).toBe(false)
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: false,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    expect((await runner.regenerate(id, SOURCE_REF)).ok).toBe(false)
    expect(generate).not.toHaveBeenCalled()
    runner.dispose()
  })

  it('租约已被其它进程持有 → 拒绝且不调模型', async () => {
    enable()
    const id = seedFailedBlank()
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const lease = claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'other-process',
      expected: state,
      now: Date.now(),
      leaseMs: 60_000,
    })
    expect(lease).not.toBeNull()
    const { runner, generate } = makeRunner()

    const result = await runner.regenerate(id, SOURCE_REF)

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('正在执行')
    expect(generate).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, id)).toMatchObject({
      status: 'failed',
      text: '',
    })
    runner.dispose()
  })
})

describe('AI 回复 · 重新打开记录的 CAS 守卫', () => {
  it('sourceRef 不一致时不改记录', async () => {
    enable()
    const id = seedFailedBlank()
    const { reopenReply } = harness
    expect(await reopenReply({
      id,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:9',
    })).toMatchObject({ ok: false })
    expect(getMessageListRecord(decrypted, id)).toMatchObject({
      status: 'failed',
      text: '',
      failureKind: 'generation_failed',
    })
  })

  it('重复重新生成成功记录会被状态守卫拒绝', async () => {
    enable()
    const id = seedFailedBlank()
    const { runner } = makeRunner()
    expect((await runner.regenerate(id, SOURCE_REF)).ok).toBe(true)
    const { reopenReply } = harness
    expect(await reopenReply({ id, sourceRef: SOURCE_REF })).toMatchObject({ ok: false })
    runner.dispose()
  })
})
