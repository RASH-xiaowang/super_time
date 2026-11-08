// @vitest-environment node
/**
 * AI 回复跨进程 claim/lease/fence 的聚焦边界：
 *  · 老库补列不破坏既有设置；
 *  · 两个独立 runner 只能有一个生成；
 *  · 活动租约阻止接管，过期后 fence 递增；
 *  · 旧 owner 晚到结果不能回填；
 *  · 租约过期后新 runner 可从崩溃现场恢复，重启不重复生成。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureChatAiReplySchema,
  readChatAiReplyState,
  saveChatAiReplySetting,
  updateChatAiReplyRunState,
} from '../src/query/ai-reply/config-store.ts'
import {
  claimChatAiReplyRun,
  releaseChatAiReplyRunClaim,
  renewChatAiReplyRunClaim,
} from '../src/query/ai-reply/lease-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type { ChatAiReplyScanDeps } from '../src/query/ai-reply/types.ts'
import {
  completeAiReplyMessageListRecord,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  listMessageListRecords,
  reserveAiReplyMessageListRecord,
} from '../src/query/message-list-store.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-lease-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

function enable(cursor = '999:0'): void {
  expect(saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    chatName: '小王',
    enabled: true,
    provider: 'dsh-wechat-bridge',
    cursor,
  }).ok).toBe(true)
}

function reserveReply(input: Parameters<ChatAiReplyScanDeps['reserveReply']>[0]) {
  const result = reserveAiReplyMessageListRecord(decrypted, input)
  return Promise.resolve({
    ok: result.ok,
    ...(result.id === undefined ? {} : { id: result.id }),
    ...(result.created === undefined ? {} : { created: result.created }),
    ...(result.record === undefined
      ? {}
      : { status: result.record.status, text: result.record.text }),
    ...(result.error === undefined ? {} : { error: result.error }),
  })
}

function completeReply(input: Parameters<ChatAiReplyScanDeps['completeReply']>[0]) {
  const result = completeAiReplyMessageListRecord(decrypted, input.id, {
    text: input.text,
    ...(input.note === undefined ? {} : { note: input.note }),
  })
  return Promise.resolve({
    ok: result.ok,
    ...(result.id === undefined ? {} : { id: result.id }),
    ...(result.record === undefined
      ? {}
      : { status: result.record.status, text: result.record.text }),
    ...(result.error === undefined ? {} : { error: result.error }),
  })
}

function failReply(input: Parameters<ChatAiReplyScanDeps['failReply']>[0]) {
  const result = failAiReplyMessageListRecord(decrypted, input.id, input.error)
  return Promise.resolve({
    ok: result.ok,
    ...(result.id === undefined ? {} : { id: result.id }),
    ...(result.record === undefined
      ? {}
      : { status: result.record.status, text: result.record.text }),
    ...(result.error === undefined ? {} : { error: result.error }),
  })
}

function getReply(id: number) {
  const record = getMessageListRecord(decrypted, id)
  return Promise.resolve(record === undefined
    ? { found: false }
    : {
        found: true,
        status: record.status,
        text: record.text,
        ...(record.sourceRef === undefined ? {} : { sourceRef: record.sourceRef }),
        ...(record.error === '' ? {} : { error: record.error }),
      })
}

function deps(overrides: Partial<ChatAiReplyScanDeps> = {}): ChatAiReplyScanDeps {
  return {
    decryptedDir: () => decrypted,
    selfUsername: () => 'wxid_self',
    listMessages: async () => [
      { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '你好' },
    ],
    collectContext: () => ({
      lines: ['对方：你好'],
      latestPeer: '你好',
      count: 1,
      prompt: '对方：你好',
    }),
    generate: async () => ({ ok: true, text: '你好呀' }),
    gate: (_feature, _stats, texts) => texts,
    reserveReply,
    completeReply,
    failReply,
    getReply,
    dispatchReply: async () => ({ ok: true }),
    op: () => {},
    ...overrides,
  }
}

function leaseColumns() {
  return withWritableDb(taskDbPath(decrypted), (db) => db.prepare(`SELECT
    lease_owner, lease_until, lease_fence
    FROM chat_ai_reply_settings
    WHERE account_key = 'wxid_self' AND chat_username = 'wxid_peer'`).get() as {
      lease_owner?: unknown
      lease_until?: unknown
      lease_fence?: unknown
    })
}

describe('AI 回复持久化租约', () => {
  it('老库补 lease 列时保留既有设置，默认没有活动租约', () => {
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.exec(`CREATE TABLE chat_ai_reply_settings (
        account_key TEXT NOT NULL,
        chat_username TEXT NOT NULL,
        chat_name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL DEFAULT 'dsh-wechat-bridge',
        revision INTEGER NOT NULL DEFAULT 0,
        cursor TEXT NOT NULL DEFAULT '',
        pending_cursor TEXT NOT NULL DEFAULT '',
        pending_source_ref TEXT NOT NULL DEFAULT '',
        pending_revision INTEGER NOT NULL DEFAULT 0,
        pending_revision_marker TEXT NOT NULL DEFAULT '',
        generation_state TEXT NOT NULL DEFAULT '',
        generation_source_ref TEXT NOT NULL DEFAULT '',
        generation_text TEXT NOT NULL DEFAULT '',
        generation_revision INTEGER NOT NULL DEFAULT 0,
        stage TEXT NOT NULL DEFAULT 'idle',
        last_run_at INTEGER,
        record_id INTEGER,
        error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_key, chat_username)
      )`)
      db.prepare(`INSERT INTO chat_ai_reply_settings
        (account_key, chat_username, chat_name, enabled, provider, revision, cursor, stage, updated_at)
        VALUES ('wxid_self', 'wxid_peer', '小王', 1, 'dsh-wechat-bridge', 7, 'v2:10:1', 'idle', 1)`)
        .run()
      ensureChatAiReplySchema(db)
    })

    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer', '小王')).toMatchObject({
      enabled: true,
      revision: 7,
      cursor: 'v2:10:1',
      stage: 'idle',
    })
    expect(leaseColumns()).toMatchObject({
      lease_owner: null,
      lease_until: 0,
      lease_fence: 0,
    })
  })

  it('并发 claim 只成功一次；续租后可阻止接管，过期接管 fence 递增且旧写被拒', () => {
    enable('v2:10:1')
    const expected = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer', '小王')

    const ownerA = claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'runner-a',
      expected,
      now: 1_000,
      leaseMs: 100,
    })
    expect(ownerA).toEqual({ owner: 'runner-a', fence: 1, until: 1_100 })
    expect(claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'runner-b',
      expected,
      now: 1_001,
      leaseMs: 100,
    })).toBeNull()

    const renewed = renewChatAiReplyRunClaim(
      decrypted,
      'wxid_self',
      'wxid_peer',
      expected.revision,
      ownerA as NonNullable<typeof ownerA>,
      { now: 1_050, leaseMs: 100 },
    )
    expect(renewed).toEqual({ owner: 'runner-a', fence: 1, until: 1_150 })
    expect(claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'runner-b',
      expected,
      now: 1_149,
      leaseMs: 100,
    })).toBeNull()

    const ownerB = claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'runner-b',
      expected,
      now: 1_151,
      leaseMs: 100,
    })
    expect(ownerB).toEqual({ owner: 'runner-b', fence: 2, until: 1_251 })

    expect(updateChatAiReplyRunState(
      decrypted,
      'wxid_self',
      'wxid_peer',
      { stage: 'failed', error: 'old owner late write' },
      { revision: expected.revision, lease: ownerA as NonNullable<typeof ownerA> },
    )).toBe(false)
    expect(updateChatAiReplyRunState(
      decrypted,
      'wxid_self',
      'wxid_peer',
      { stage: 'generating', error: 'new owner claimed' },
      { revision: expected.revision, lease: ownerB as NonNullable<typeof ownerB> },
    )).toBe(true)
    expect(releaseChatAiReplyRunClaim(
      decrypted,
      'wxid_self',
      'wxid_peer',
      expected.revision,
      ownerB as NonNullable<typeof ownerB>,
    )).toBe(true)
    expect(leaseColumns()).toMatchObject({ lease_owner: null, lease_until: 0, lease_fence: 2 })
  })

  it('设置 revision 推进时立即撤销活动租约，旧 owner 不能继续心跳或回写', () => {
    enable('v2:10:1')
    const expected = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer', '小王')
    const lease = claimChatAiReplyRun(decrypted, 'wxid_self', 'wxid_peer', {
      owner: 'runner-a',
      expected,
      now: 1_000,
      leaseMs: 100,
    })
    expect(lease).not.toBeNull()

    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
      expectedRevision: expected.revision,
      cursor: 'v2:20:2',
    }).ok).toBe(true)
    expect(renewChatAiReplyRunClaim(
      decrypted,
      'wxid_self',
      'wxid_peer',
      expected.revision,
      lease as NonNullable<typeof lease>,
      { now: 1_050, leaseMs: 100 },
    )).toBeNull()
    expect(updateChatAiReplyRunState(
      decrypted,
      'wxid_self',
      'wxid_peer',
      { stage: 'failed', error: 'old revision' },
      { revision: expected.revision, lease: lease as NonNullable<typeof lease> },
    )).toBe(false)
    expect(leaseColumns()).toMatchObject({ lease_owner: null, lease_until: 0, lease_fence: 1 })
  })

  it('两个独立 runner 并发扫描同一会话时只允许一个生成', async () => {
    enable()
    let releaseGenerate: (() => void) | undefined
    const generateGate = new Promise<void>((resolve) => { releaseGenerate = resolve })
    const generate = vi.fn(async () => {
      await generateGate
      return { ok: true, text: '只生成一次' }
    })
    const reserve = vi.fn(reserveReply)
    const complete = vi.fn(completeReply)
    const dispatch = vi.fn(async () => ({ ok: true }))
    const runnerA = createChatAiReplyRunner(deps({
      generate,
      reserveReply: reserve,
      completeReply: complete,
      dispatchReply: dispatch,
    }), { owner: 'runner-a', heartbeatMs: 0 })
    const runnerB = createChatAiReplyRunner(deps({
      generate,
      reserveReply: reserve,
      completeReply: complete,
      dispatchReply: dispatch,
    }), { owner: 'runner-b', heartbeatMs: 0 })

    await Promise.all([runnerA.scan(), runnerB.scan()])
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    releaseGenerate?.()
    await vi.waitFor(() => {
      expect(runnerA.pending()).toBe(0)
      expect(runnerB.pending()).toBe(0)
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(listMessageListRecords(decrypted).total).toBe(1)
    runnerA.dispose()
    runnerB.dispose()
  })

  it('租约过期被新 runner 接管后，旧 owner 的晚到模型结果不可回填；再次重启不重复执行', async () => {
    enable()
    let now = 1_000
    let generationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { generationStarted = resolve })
    let releaseOld: (() => void) | undefined
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const generate = vi.fn(async () => {
      generationStarted?.()
      await oldGate
      return { ok: true, text: '旧 owner 晚到结果' }
    })
    const complete = vi.fn(completeReply)
    const fail = vi.fn(failReply)
    const dispatch = vi.fn(async () => ({ ok: true }))
    const oldRunner = createChatAiReplyRunner(deps({
      generate,
      completeReply: complete,
      failReply: fail,
      dispatchReply: dispatch,
    }), {
      owner: 'runner-old',
      now: () => now,
      leaseMs: 100,
      heartbeatMs: 0,
    })

    await oldRunner.scan()
    await started
    const reserved = listMessageListRecords(decrypted).items[0]
    expect(reserved).toMatchObject({ source: 'ai_reply', status: 'pending', text: '' })

    now = 1_101
    const recovering = createChatAiReplyRunner(deps({
      generate,
      completeReply: complete,
      failReply: fail,
      dispatchReply: dispatch,
    }), {
      owner: 'runner-new',
      now: () => now,
      leaseMs: 100,
      heartbeatMs: 0,
    })
    await recovering.recover()
    await vi.waitFor(() => expect(recovering.pending()).toBe(0))

    const failed = getMessageListRecord(decrypted, reserved?.id ?? 0)
    expect(failed).toMatchObject({ status: 'failed', text: '' })
    expect(failed?.error).toContain('生成已开始')
    expect(complete).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)

    releaseOld?.()
    await vi.waitFor(() => expect(oldRunner.pending()).toBe(0))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, reserved?.id ?? 0)).toMatchObject({
      status: 'failed',
      text: '',
    })

    now = 1_302
    const restarted = createChatAiReplyRunner(deps({
      generate,
      completeReply: complete,
      failReply: fail,
      dispatchReply: dispatch,
    }), {
      owner: 'runner-restarted',
      now: () => now,
      leaseMs: 100,
      heartbeatMs: 0,
    })
    const result = await restarted.recover()
    await vi.waitFor(() => expect(restarted.pending()).toBe(0))
    expect(result.recovered).toBe(0)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()

    oldRunner.dispose()
    recovering.dispose()
    restarted.dispose()
  })
})
