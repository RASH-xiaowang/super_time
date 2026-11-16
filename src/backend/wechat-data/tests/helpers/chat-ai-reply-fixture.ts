/**
 * Shared temporary state for the chat AI reply behavior suites.
 *
 * Store wrappers and default runner deps stay here so split spec files exercise
 * the same real SQLite paths without duplicating setup or changing behavior.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatAiReplyScanDeps } from '../../src/query/ai-reply/types.ts'
import {
  completeAiReplyMessageListRecord,
  completeAiReplyMessageListRecordSegments,
  dropAiReplyMessageListRecord,
  failAiReplyMessageListSegmentsAfter,
  failAiReplyMessageListRecord,
  getMessageListRecord,
  listAiReplyMessageListSegments,
  reserveAiReplyMessageListRecord,
} from '../../src/query/message-list-store.ts'

export interface ChatAiReplyTestHarness {
  root: string
  decrypted: string
  decoded: string
  reset: () => void
  dispose: () => void
  reserveReply: ChatAiReplyScanDeps['reserveReply']
  completeReply: ChatAiReplyScanDeps['completeReply']
  completeReplySegments: NonNullable<ChatAiReplyScanDeps['completeReplySegments']>
  listReplySegments: NonNullable<ChatAiReplyScanDeps['listReplySegments']>
  failReplySegmentsAfter: NonNullable<ChatAiReplyScanDeps['failReplySegmentsAfter']>
  failReply: ChatAiReplyScanDeps['failReply']
  dropReply: NonNullable<ChatAiReplyScanDeps['dropReply']>
  getReply: ChatAiReplyScanDeps['getReply']
  deps: (overrides?: Partial<ChatAiReplyScanDeps>) => ChatAiReplyScanDeps
}

export function createChatAiReplyTestHarness(): ChatAiReplyTestHarness {
  let root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-'))
  let decrypted = join(root, 'data', 'decrypted')
  let decoded = join(root, 'data', 'decoded')

  const createPaths = (): void => {
    mkdirSync(decrypted, { recursive: true })
  }
  createPaths()

  const reserveReply: ChatAiReplyScanDeps['reserveReply'] = async (input) => {
    const result = reserveAiReplyMessageListRecord(decrypted, input)
    return {
      ok: result.ok,
      ...(result.id === undefined ? {} : { id: result.id }),
      ...(result.created === undefined ? {} : { created: result.created }),
      ...(result.record === undefined ? {} : {
        status: result.record.status,
        text: result.record.text,
      }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }

  const completeReply: ChatAiReplyScanDeps['completeReply'] = async (input) => {
    const result = completeAiReplyMessageListRecord(decrypted, input.id, {
      text: input.text,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    return {
      ok: result.ok,
      ...(result.id === undefined ? {} : { id: result.id }),
      ...(result.record === undefined ? {} : {
        status: result.record.status,
        text: result.record.text,
      }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }

  const completeReplySegments: NonNullable<ChatAiReplyScanDeps['completeReplySegments']> = async (input) => {
    return completeAiReplyMessageListRecordSegments(decrypted, input.id, {
      segments: input.segments,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
  }

  const listReplySegments: NonNullable<ChatAiReplyScanDeps['listReplySegments']> = async (sourceRef) => {
    return listAiReplyMessageListSegments(decrypted, sourceRef)
  }

  const failReplySegmentsAfter: NonNullable<ChatAiReplyScanDeps['failReplySegmentsAfter']> = async (input) => {
    return failAiReplyMessageListSegmentsAfter(
      decrypted,
      input.sourceRef,
      input.segmentIndex,
      input.error,
      input.failureKind,
    )
  }

  const failReply: ChatAiReplyScanDeps['failReply'] = async (input) => {
    const result = failAiReplyMessageListRecord(
      decrypted,
      input.id,
      input.error,
      input.failureKind,
    )
    return {
      ok: result.ok,
      ...(result.id === undefined ? {} : { id: result.id }),
      ...(result.record === undefined ? {} : {
        status: result.record.status,
        text: result.record.text,
      }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }

  const dropReply: NonNullable<ChatAiReplyScanDeps['dropReply']> = async (input) => {
    const dropped = dropAiReplyMessageListRecord(decrypted, input.id, input.sourceRef)
    return dropped.ok
      ? { ok: true }
      : { ok: false, ...(dropped.error === undefined ? {} : { error: dropped.error }) }
  }

  const getReply: ChatAiReplyScanDeps['getReply'] = async (id) => {
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

  const deps = (overrides: Partial<ChatAiReplyScanDeps> = {}): ChatAiReplyScanDeps => ({
    decryptedDir: () => decrypted,
    selfUsername: () => 'wxid_self',
    listMessages: async () => [
      { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '你好' },
    ],
    collectContext: () => ({
      lines: ['对方：你好'],
      latestPeer: '你好',
      count: 1,
      prompt: '以下是当前微信单聊最近的对话：\n对方：你好',
    }),
    generate: async () => ({ ok: true, text: '你好呀' }),
    gate: (_feature, _stats, texts) => texts,
    reserveReply,
    completeReply,
    completeReplySegments,
    listReplySegments,
    failReplySegmentsAfter,
    failReply,
    dropReply,
    getReply,
    dispatchReply: async () => ({ ok: true }),
    op: () => {},
    ...overrides,
  })

  return {
    get root() {
      return root
    },
    get decrypted() {
      return decrypted
    },
    get decoded() {
      return decoded
    },
    reset(): void {
      rmSync(root, { recursive: true, force: true })
      root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-'))
      decrypted = join(root, 'data', 'decrypted')
      decoded = join(root, 'data', 'decoded')
      createPaths()
    },
    dispose(): void {
      rmSync(root, { recursive: true, force: true })
    },
    reserveReply,
    completeReply,
    completeReplySegments,
    listReplySegments,
    failReplySegmentsAfter,
    failReply,
    dropReply,
    getReply,
    deps,
  }
}
