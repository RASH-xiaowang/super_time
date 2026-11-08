// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureChatAiReplySchema,
  readChatAiReplyGeneration,
  readChatAiReplyState,
  saveChatAiReplySetting,
  updateChatAiReplyRunState,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type {
  ChatAiReplyRecordResult,
  ChatAiReplyScanDeps,
} from '../src/query/ai-reply/types.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import {
  completeAiReplyMessageListRecord,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  reserveAiReplyMessageListRecord,
} from '../src/query/message-list-store.ts'

const configFaults = vi.hoisted(() => ({
  stateReadFailures: 0,
  generationReadFailures: 0,
}))

vi.mock('../src/query/ai-reply/config-store.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/query/ai-reply/config-store.ts')>()
  return {
    ...actual,
    readChatAiReplyStateStrict: (...args: Parameters<typeof actual.readChatAiReplyStateStrict>) => {
      if (configFaults.stateReadFailures > 0) {
        configFaults.stateReadFailures -= 1
        return { ok: false, error: '注入：AI 回复设置临时读取失败' }
      }
      return actual.readChatAiReplyStateStrict(...args)
    },
    readChatAiReplyGenerationStrict: (
      ...args: Parameters<typeof actual.readChatAiReplyGenerationStrict>
    ) => {
      if (configFaults.generationReadFailures > 0) {
        configFaults.generationReadFailures -= 1
        return { ok: false, error: '注入：AI 回复生成快照临时读取失败' }
      }
      return actual.readChatAiReplyGenerationStrict(...args)
    },
  }
})

let root = ''
let decrypted = ''

beforeEach(() => {
  configFaults.stateReadFailures = 0
  configFaults.generationReadFailures = 0
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-recovery-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'
const message = {
  localId: 1,
  sortSeq: 100,
  createTime: 1000,
  isSender: 0,
  renderType: 'text',
  displayText: '你好',
}

async function reserveReply(
  input: Parameters<ChatAiReplyScanDeps['reserveReply']>[0],
): Promise<ChatAiReplyRecordResult> {
  const result = reserveAiReplyMessageListRecord(decrypted, input)
  return result.ok
    ? {
        ok: true,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.created === undefined ? {} : { created: result.created }),
        ...(result.record === undefined ? {} : {
          status: result.record.status,
          text: result.record.text,
        }),
      }
    : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
}

async function completeReply(
  input: Parameters<ChatAiReplyScanDeps['completeReply']>[0],
): Promise<ChatAiReplyRecordResult> {
  const result = completeAiReplyMessageListRecord(decrypted, input.id, {
    text: input.text,
    ...(input.note === undefined ? {} : { note: input.note }),
  })
  return result.ok
    ? {
        ok: true,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.record === undefined ? {} : {
          status: result.record.status,
          text: result.record.text,
        }),
      }
    : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
}

async function failReply(
  input: Parameters<ChatAiReplyScanDeps['failReply']>[0],
): Promise<ChatAiReplyRecordResult> {
  const result = failAiReplyMessageListRecord(decrypted, input.id, input.error)
  return result.ok
    ? {
        ok: true,
        ...(result.id === undefined ? {} : { id: result.id }),
        ...(result.record === undefined ? {} : {
          status: result.record.status,
          text: result.record.text,
        }),
      }
    : { ok: false, ...(result.error === undefined ? {} : { error: result.error }) }
}

async function getReply(id: number) {
  const record = getMessageListRecord(decrypted, id)
  return record === undefined
    ? { found: false }
    : {
        found: true,
        status: record.status,
        text: record.text,
        ...(record.sourceRef === undefined ? {} : { sourceRef: record.sourceRef }),
        ...(record.error === '' ? {} : { error: record.error }),
      }
}

function deps(overrides: Partial<ChatAiReplyScanDeps> = {}): ChatAiReplyScanDeps {
  return {
    decryptedDir: () => decrypted,
    selfUsername: () => 'wxid_self',
    listMessages: async () => [message],
    collectContext: () => ({
      lines: ['对方：你好'],
      latestPeer: '你好',
      count: 1,
      prompt: '当前微信单聊最近的对话：\n对方：你好',
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

function setPending(
  cursor: string,
  ref: string,
  revision: number | 'missing' = 1,
): void {
  expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
    stage: 'generating',
    pendingCursor: cursor,
    pendingSourceRef: ref,
    ...(revision === 'missing' ? {} : { pendingRevision: revision }),
  })).toBe(true)
}

describe('AI 回复恢复 fail-closed', () => {
  it.each([
    { name: 'sortSeq 越界', cursor: 'v2:999:1', ref: sourceRef, messages: [message] },
    { name: 'createTime 不一致', cursor: 'v2:100:1', ref: 'ai-reply:wxid_self:wxid_peer:9999:1', messages: [message] },
    { name: '账号不一致', cursor: 'v2:100:1', ref: 'ai-reply:wxid_other:wxid_peer:1000:1', messages: [message] },
    { name: '会话不一致', cursor: 'v2:100:1', ref: 'ai-reply:wxid_self:wxid_other:1000:1', messages: [message] },
    { name: '真实消息不存在', cursor: 'v2:100:1', ref: sourceRef, messages: [] },
  ])('$name 时绝不生成、投递或推进水位', async ({ cursor, ref, messages }) => {
    enable()
    setPending(cursor, ref)
    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      listMessages: async () => messages,
      generate,
      dispatchReply,
    }))

    const result = await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(result.errors?.length ?? 0).toBeGreaterThan(0)
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      cursor: '999:0',
      pendingCursor: cursor,
      pendingSourceRef: ref,
    })
    runner.dispose()
  })

  it.each([
    { name: '缺失', revision: 'missing' as const },
    { name: '为 0', revision: 0 },
    { name: '为非整数', revision: 1.5 },
  ])('pendingRevision $name 时 fail-closed，不回退当前 revision', async ({ revision }) => {
    enable()
    setPending('v2:100:1', sourceRef, revision)
    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const runner = createChatAiReplyRunner(deps({ generate }))

    const result = await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(result.errors?.[0]).toContain('pendingRevision')
    expect(generate).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').cursor).toBe('999:0')
    runner.dispose()
  })

  it('运行器读取设置失败时保留 pending，不预约、不生成，后续扫描可继续', async () => {
    enable()
    setPending('v2:100:1', sourceRef)
    configFaults.stateReadFailures = 1
    const firstGenerate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const firstReserve = vi.fn(reserveReply)
    const runner = createChatAiReplyRunner(deps({
      generate: firstGenerate,
      reserveReply: firstReserve,
    }))

    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(firstReserve).not.toHaveBeenCalled()
    expect(firstGenerate).not.toHaveBeenCalled()
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
    })
    runner.dispose()

    const restartedGenerate = vi.fn(async () => ({ ok: true, text: '恢复后生成' }))
    const restarted = createChatAiReplyRunner(deps({
      generate: restartedGenerate,
    }))
    await restarted.recover()
    await vi.waitFor(() => expect(restarted.pending()).toBe(0))
    expect(restartedGenerate).toHaveBeenCalledTimes(1)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    restarted.dispose()
  })

  it('旧版 pending 只标 legacy，不把当前 revision 抄成 pendingRevision', () => {
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
        stage TEXT NOT NULL DEFAULT 'idle',
        last_run_at INTEGER,
        record_id INTEGER,
        error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_key, chat_username)
      )`)
      db.prepare(`INSERT INTO chat_ai_reply_settings
        (account_key, chat_username, chat_name, enabled, revision, cursor,
         pending_cursor, pending_source_ref, pending_revision, stage, updated_at)
        VALUES (?, ?, ?, 1, 7, '999:0', 'v2:100:1', ?, 0, 'generating', ?)`)
        .run('wxid_self', 'wxid_peer', '小王', sourceRef, Date.now())
      ensureChatAiReplySchema(db)
      const row = db.prepare(`SELECT pending_revision_marker FROM chat_ai_reply_settings
        WHERE account_key = 'wxid_self' AND chat_username = 'wxid_peer'`)
        .get() as { pending_revision_marker?: unknown } | undefined
      expect(row?.pending_revision_marker).toBe('legacy')
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').pendingRevision).toBeUndefined()
  })
})

describe('AI 回复生成结果恢复', () => {
  it('模型结果已持久化、消息列表补全前崩溃：重启只补全/投递，不再生成', async () => {
    enable()
    let completeCalls = 0
    const firstGenerate = vi.fn(async () => ({ ok: true, text: '已经付费生成的结果' }))
    const firstRunner = createChatAiReplyRunner(deps({
      generate: firstGenerate,
      completeReply: async (input) => {
        completeCalls += 1
        if (completeCalls === 1) throw new Error('simulated crash before message-list write')
        return completeReply(input)
      },
    }))
    await firstRunner.scan()
    await vi.waitFor(() => expect(firstRunner.pending()).toBe(0))
    expect(firstGenerate).toHaveBeenCalledTimes(1)
    const recordId = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').recordId ?? 0
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').pendingSourceRef).toBe(sourceRef)
    firstRunner.dispose()

    const secondGenerate = vi.fn(async () => ({ ok: true, text: '不得再次生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const secondRunner = createChatAiReplyRunner(deps({
      generate: secondGenerate,
      dispatchReply,
    }))
    const recovery = await secondRunner.recover()
    expect(recovery.recovered).toBe(1)
    await vi.waitFor(() => expect(secondRunner.pending()).toBe(0))
    expect(secondGenerate).not.toHaveBeenCalled()
    expect(dispatchReply).toHaveBeenCalledTimes(1)
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '已经付费生成的结果',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    secondRunner.dispose()
  })

  it('生成完成瞬间设置读取失败：先保留生成结果和 pending，重启后再补全投递', async () => {
    enable()
    const firstGenerate = vi.fn(async () => {
      configFaults.stateReadFailures = 1
      return { ok: true, text: '设置抖动也不能丢的回复' }
    })
    const firstComplete = vi.fn(completeReply)
    const firstDispatch = vi.fn(async () => ({ ok: true }))
    const firstRunner = createChatAiReplyRunner(deps({
      generate: firstGenerate,
      completeReply: firstComplete,
      dispatchReply: firstDispatch,
    }))

    await firstRunner.scan()
    await vi.waitFor(() => expect(firstRunner.pending()).toBe(0))
    expect(firstGenerate).toHaveBeenCalledTimes(1)
    expect(firstComplete).not.toHaveBeenCalled()
    expect(firstDispatch).not.toHaveBeenCalled()
    const interrupted = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const recordId = interrupted.recordId ?? 0
    expect(interrupted).toMatchObject({
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      stage: 'failed',
    })
    expect(interrupted.error).toContain('读取失败')
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '',
    })
    expect(readChatAiReplyGeneration(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      state: 'result',
      text: '设置抖动也不能丢的回复',
      sourceRef,
      revision: 1,
    })
    firstRunner.dispose()

    const secondGenerate = vi.fn(async () => ({ ok: true, text: '不得再次生成' }))
    const secondDispatch = vi.fn(async () => ({ ok: true }))
    const secondRunner = createChatAiReplyRunner(deps({
      generate: secondGenerate,
      dispatchReply: secondDispatch,
    }))
    await secondRunner.recover()
    await vi.waitFor(() => expect(secondRunner.pending()).toBe(0))
    expect(secondGenerate).not.toHaveBeenCalled()
    expect(secondDispatch).toHaveBeenCalledTimes(1)
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '设置抖动也不能丢的回复',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    secondRunner.dispose()
  })

  it('持久化只有生成意图、没有结果时 fail-closed，不重复调用模型', async () => {
    enable()
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.ok ? (reserved.id ?? 0) : 0
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'generating',
      recordId,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
      generationState: 'intent',
      generationSourceRef: sourceRef,
      generationText: '',
      generationRevision: 1,
    })).toBe(true)

    const generate = vi.fn(async () => ({ ok: true, text: '不得再次生成' }))
    const runner = createChatAiReplyRunner(deps({ generate }))
    await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(generate).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('没有可恢复结果'),
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'failed',
      cursor: 'v2:100:1',
    })
    runner.dispose()
  })

  it('生成快照连续两次读取失败时保留 pending，后续重启仍可补全且不重复生成', async () => {
    enable()
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.ok ? (reserved.id ?? 0) : 0
    expect(updateChatAiReplyRunState(decrypted, 'wxid_self', 'wxid_peer', {
      stage: 'saving',
      recordId,
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
      pendingRevision: 1,
      generationState: 'result',
      generationSourceRef: sourceRef,
      generationText: '读取抖动前已落盘的回复',
      generationRevision: 1,
    })).toBe(true)

    configFaults.generationReadFailures = 2
    const firstGenerate = vi.fn(async () => ({ ok: true, text: '不得重新生成' }))
    const firstDispatch = vi.fn(async () => ({ ok: true }))
    const firstRunner = createChatAiReplyRunner(deps({
      generate: firstGenerate,
      dispatchReply: firstDispatch,
    }))
    await firstRunner.recover()
    await vi.waitFor(() => expect(firstRunner.pending()).toBe(0))
    expect(firstGenerate).not.toHaveBeenCalled()
    expect(firstDispatch).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
    })
    firstRunner.dispose()

    const restartedGenerate = vi.fn(async () => ({ ok: true, text: '不得重新生成' }))
    const restartedDispatch = vi.fn(async () => ({ ok: true }))
    const restarted = createChatAiReplyRunner(deps({
      generate: restartedGenerate,
      dispatchReply: restartedDispatch,
    }))
    await restarted.recover()
    await vi.waitFor(() => expect(restarted.pending()).toBe(0))
    expect(restartedGenerate).not.toHaveBeenCalled()
    expect(restartedDispatch).toHaveBeenCalledTimes(1)
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '读取抖动前已落盘的回复',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    restarted.dispose()
  })

  it('生成中被 dispose 时不补全、不投递，保留结果供下一次恢复', async () => {
    enable()
    let releaseGeneration: (() => void) | undefined
    let markEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const generate = vi.fn(async () => {
      markEntered?.()
      await new Promise<void>((resolve) => {
        releaseGeneration = resolve
      })
      return { ok: true, text: '停止期间已经生成的回复' }
    })
    const completeReplySpy = vi.fn(completeReply)
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({
      generate,
      completeReply: completeReplySpy,
      dispatchReply,
    }))

    const scanning = runner.scan()
    await entered
    runner.dispose()
    releaseGeneration?.()
    await scanning
    await vi.waitFor(() => {
      expect(readChatAiReplyGeneration(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        state: 'result',
        text: '停止期间已经生成的回复',
      })
    })
    expect(completeReplySpy).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    const interrupted = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const recordId = interrupted.recordId ?? 0
    expect(interrupted).toMatchObject({
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
    })
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'pending',
      text: '',
    })

    const restartedGenerate = vi.fn(async () => ({ ok: true, text: '不得再次生成' }))
    const restartedDispatch = vi.fn(async () => ({ ok: true }))
    const restarted = createChatAiReplyRunner(deps({
      generate: restartedGenerate,
      dispatchReply: restartedDispatch,
    }))
    await restarted.recover()
    await vi.waitFor(() => expect(restarted.pending()).toBe(0))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(restartedGenerate).not.toHaveBeenCalled()
    expect(restartedDispatch).toHaveBeenCalledTimes(1)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    restarted.dispose()
  })
})

describe('AI 回复孤儿预约收口', () => {
  it('初次设置读取失败时不扫描、不关 orphan、不推进水位', async () => {
    enable()
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.ok ? (reserved.id ?? 0) : 0
    setPending('v2:100:1', sourceRef)

    const listMessages = vi.fn(async () => [message])
    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const failReplySpy = vi.fn(failReply)
    const runner = createChatAiReplyRunner(deps({
      readEnabledStates: () => ({ ok: false, error: '模拟设置库临时读取失败' }),
      listMessages,
      generate,
      failReply: failReplySpy,
    }))

    const result = await runner.recover()
    expect(result.errors).toContain('模拟设置库临时读取失败')
    expect(listMessages).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(failReplySpy).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({ status: 'pending' })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
    })
    runner.dispose()
  })

  it('单会话二次设置读取失败时不用空列表继续或关 orphan', async () => {
    enable()
    setPending('v2:100:1', sourceRef)
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.ok ? (reserved.id ?? 0) : 0
    const listed = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const readEnabledStates = vi.fn()
      .mockReturnValueOnce({ ok: true, states: [listed] })
      .mockReturnValueOnce({ ok: false, error: '模拟单会话二次读取失败' })
    const listMessages = vi.fn(async () => [message])
    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const failReplySpy = vi.fn(failReply)
    const runner = createChatAiReplyRunner(deps({
      readEnabledStates,
      listMessages,
      generate,
      failReply: failReplySpy,
    }))

    const result = await runner.recover()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(readEnabledStates).toHaveBeenCalledTimes(2)
    // 二次设置读取失败后必须先停住，不能为了读消息窗口绕过 fail-closed。
    expect(listMessages).not.toHaveBeenCalled()
    expect(result.errors?.some((error) => error.includes('模拟单会话二次读取失败'))).toBe(true)
    expect(generate).not.toHaveBeenCalled()
    expect(failReplySpy).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({ status: 'pending' })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      cursor: '999:0',
      pendingCursor: 'v2:100:1',
      pendingSourceRef: sourceRef,
    })
    runner.dispose()
  })

  it('设置行缺失时把 pending 安全标记失败，不生成也不出网', async () => {
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.ok ? (reserved.id ?? 0) : 0
    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const dispatchReply = vi.fn(async () => ({ ok: true }))
    const runner = createChatAiReplyRunner(deps({ generate, dispatchReply }))
    await runner.recover()
    expect(generate).not.toHaveBeenCalled()
    expect(dispatchReply).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('设置行缺失'),
    })
    runner.dispose()
  })

  it('设置行已关闭时收口遗留 pending', async () => {
    enable()
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: false,
      provider: 'dsh-wechat-bridge',
      expectedRevision: 1,
    }).ok).toBe(true)
    const reserved = await reserveReply({
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000_000,
      sourceRef,
    })
    expect(reserved.ok).toBe(true)
    const recordId = reserved.ok ? (reserved.id ?? 0) : 0
    const generate = vi.fn(async () => ({ ok: true, text: '不得生成' }))
    const runner = createChatAiReplyRunner(deps({ generate }))
    await runner.recover()
    expect(generate).not.toHaveBeenCalled()
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('已关闭'),
    })
    runner.dispose()
  })
})
