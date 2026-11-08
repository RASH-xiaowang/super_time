// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readChatAiReplyState,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyRunner } from '../src/query/ai-reply/runner.ts'
import type {
  ChatAiReplyRecordResult,
  ChatAiReplyScanDeps,
} from '../src/query/ai-reply/types.ts'
import { dispatchMessageListRecord } from '../src/query/message-list-dispatch.ts'
import {
  completeAiReplyMessageListRecord,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  reserveAiReplyMessageListRecord,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'

let root = ''
let decrypted = ''

const incoming = {
  localId: 1,
  sortSeq: 100,
  createTime: 1000,
  isSender: 0,
  renderType: 'text',
  displayText: '你好',
}
const sourceRef = 'ai-reply:wxid_self:wxid_peer:1000:1'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-waiting-config-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

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

function dispatchViaMessageList(
  fetchImpl?: NonNullable<Parameters<typeof dispatchMessageListRecord>[2]['fetchImpl']>,
): ChatAiReplyScanDeps['dispatchReply'] {
  return async (recordId) => {
    const result = await dispatchMessageListRecord(decrypted, recordId, {
      decodeImage: async () => ({}),
      gate: (_feature, _stats, texts) => texts,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
    return {
      ok: result.ok,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    }
  }
}

function makeDeps(
  dispatchReply: ChatAiReplyScanDeps['dispatchReply'],
  op: ChatAiReplyScanDeps['op'] = () => {},
): ChatAiReplyScanDeps {
  return {
    decryptedDir: () => decrypted,
    selfUsername: () => 'wxid_self',
    listMessages: async () => [incoming],
    collectContext: () => ({
      lines: ['对方：你好'],
      latestPeer: '你好',
      count: 1,
      prompt: '当前微信单聊最近的对话：\n对方：你好',
    }),
    generate: async () => ({ ok: true, text: '自动回复' }),
    gate: (_feature, _stats, texts) => texts,
    reserveReply,
    completeReply,
    failReply,
    getReply,
    dispatchReply,
    op,
  }
}

function enable(): void {
  expect(saveChatAiReplySetting(decrypted, {
    accountKey: 'wxid_self',
    chatUsername: 'wxid_peer',
    chatName: '小王',
    enabled: true,
    provider: 'dsh-wechat-bridge',
    cursor: '999:0',
  }).ok).toBe(true)
}

async function enterWaitingConfig(
  op: ChatAiReplyScanDeps['op'] = () => {},
): Promise<ReturnType<typeof createChatAiReplyRunner>> {
  enable()
  const runner = createChatAiReplyRunner(makeDeps(dispatchViaMessageList(), op))
  await runner.scan()
  await vi.waitFor(() => expect(runner.pending()).toBe(0))
  expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
    stage: 'waiting_config',
    cursor: '999:0',
    pendingCursor: 'v2:100:1',
    pendingSourceRef: sourceRef,
  })
  return runner
}

describe('AI 回复待配置状态', () => {
  it('没有 Webhook 规则时保留 pending 记录并进入 waiting_config', async () => {
    const runner = await enterWaitingConfig()
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const record = getMessageListRecord(decrypted, state.recordId ?? 0)

    expect(record).toMatchObject({
      status: 'pending',
      text: '自动回复',
      webhookUrl: '',
    })
    expect(record?.error).toContain('未匹配到 Webhook')
    expect(state.error).toContain('配置后会自动继续')
    runner.dispose()
  })

  it('连续扫描同一待配置原因不重复记录失败日志', async () => {
    const op = vi.fn<ChatAiReplyScanDeps['op']>()
    const runner = await enterWaitingConfig(op)
    const afterFirst = op.mock.calls.length

    expect(op.mock.calls.some((call) => call[1] === false)).toBe(false)
    await runner.scan()
    await vi.waitFor(() => expect(runner.pending()).toBe(0))
    expect(op).toHaveBeenCalledTimes(afterFirst)
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer').stage)
      .toBe('waiting_config')
    runner.dispose()
  })

  it('补齐规则后下一次扫描沿用原记录完成投递', async () => {
    const runner = await enterWaitingConfig()
    const state = readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')
    const recordId = state.recordId ?? 0
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))

    expect(saveMessageListRule(decrypted, {
      chatName: '小王',
      targetName: '小王',
      webhookUrl: 'https://downstream.example/ai',
    }).ok).toBe(true)
    expect(getMessageListRecord(decrypted, recordId)?.webhookUrl)
      .toBe('https://downstream.example/ai')

    const restarted = createChatAiReplyRunner(makeDeps(dispatchViaMessageList(fetchImpl)))
    await restarted.scan()
    await vi.waitFor(() => expect(restarted.pending()).toBe(0))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(getMessageListRecord(decrypted, recordId)).toMatchObject({
      status: 'success',
    })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      stage: 'success',
      cursor: 'v2:100:1',
    })
    runner.dispose()
    restarted.dispose()
  })
})
