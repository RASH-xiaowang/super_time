// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chatAiReplySegmentSourceRef,
  parseChatAiReplySourceRef,
  splitChatAiReplyText,
  CHAT_AI_REPLY_SEGMENT_MAX_UTF16,
} from '../src/query/ai-reply/segments.ts'
import {
  completeAiReplyMessageListRecordSegments,
  failAiReplyMessageListSegmentsAfter,
  listAiReplyMessageListSegments,
  listMessageListRecords,
  pendingMessageListRecordIds,
  reserveAiReplyMessageListRecord,
} from '../src/query/message-list-store.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-segments-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('AI 回复语义分段', () => {
  it('短回复保持一段，长回复优先按句意拆分且每段不超过上限', () => {
    expect(splitChatAiReplyText('收到，我马上处理。')).toEqual(['收到，我马上处理'])
    const text = [
      '第一段先回应对方的问题。',
      '第二段补充具体时间和处理方式。',
      '第三段说明如果还有问题可以继续联系。',
    ].join('\n\n')
    const segments = splitChatAiReplyText(text, 34)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every((segment) => segment.length <= 34)).toBe(true)
    expect(segments.every((segment) => !segment.endsWith('\n'))).toBe(true)
  })

  it('硬切不会拆开 emoji 代理对', () => {
    expect(CHAT_AI_REPLY_SEGMENT_MAX_UTF16).toBe(25)
    const segments = splitChatAiReplyText('😀'.repeat(120))
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every((segment) => segment.length <= CHAT_AI_REPLY_SEGMENT_MAX_UTF16))
      .toBe(true)
    expect(segments.every((segment) =>
      !/[\uD800-\uDBFF]$/.test(segment) && !/^[\uDC00-\uDFFF]/.test(segment))).toBe(true)
  })

  it('分段结尾只保留问号和感叹号，其他句末标点自动去掉', () => {
    const segments = splitChatAiReplyText([
      '第一段说明时间，',
      '第二段说明路线。',
      '第三段询问安排？',
      '第四段表达期待！',
    ].join('\n\n'), 25)

    expect(segments).toEqual([
      '第一段说明时间',
      '第二段说明路线',
      '第三段询问安排？',
      '第四段表达期待！',
    ])
    expect(segments.every((segment) => !/[。，、；：,.…;:]$/.test(segment))).toBe(true)
  })

  it('分段 sourceRef 可稳定解析回同一基础幂等键', () => {
    const base = 'ai-reply:wxid_self:wxid_peer:1700000000:42'
    expect(chatAiReplySegmentSourceRef(base, 1)).toBe(base)
    expect(chatAiReplySegmentSourceRef(base, 3)).toBe(base + ':segment:3')
    expect(parseChatAiReplySourceRef(base)).toMatchObject({
      segmentIndex: 1,
      baseSourceRef: base,
    })
    expect(parseChatAiReplySourceRef(base + ':segment:3')).toMatchObject({
      segmentIndex: 3,
      baseSourceRef: base,
    })
  })
})

describe('AI 回复分段消息列表台账', () => {
  function reserve(): number {
    const result = reserveAiReplyMessageListRecord(decrypted, {
      targetName: '小王',
      targetUsername: 'wxid_peer',
      chatName: '小王',
      chatUsername: 'wxid_peer',
      triggeredAt: 1_000,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
    })
    expect(result.ok).toBe(true)
    return result.id ?? 0
  }

  it('一次事务写入多段，重复补全保持幂等', () => {
    const id = reserve()
    const first = completeAiReplyMessageListRecordSegments(decrypted, id, {
      segments: ['第一段', '第二段', '第三段'],
    })
    expect(first.ok).toBe(true)
    expect(first.segments).toHaveLength(3)
    const snapshot = listMessageListRecords(decrypted)
    expect(snapshot.total).toBe(3)
    const ordered = [...snapshot.items].sort((a, b) =>
      (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0))
    expect(ordered.map((record) => record.text)).toEqual(['第一段', '第二段', '第三段'])
    expect(ordered.map((record) => record.segmentIndex)).toEqual([1, 2, 3])
    expect(ordered.every((record) => record.segmentCount === 3)).toBe(true)
    expect(ordered.every((record) => record.segmentGroupRef
      === 'ai-reply:wxid_self:wxid_peer:1000:1')).toBe(true)
    expect(ordered[1]?.sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:1000:1:segment:2')

    const repeated = completeAiReplyMessageListRecordSegments(decrypted, id, {
      segments: ['第一段', '第二段', '第三段'],
    })
    expect(repeated.ok).toBe(true)
    expect(listMessageListRecords(decrypted).total).toBe(3)
    expect(listAiReplyMessageListSegments(
      decrypted,
      'ai-reply:wxid_self:wxid_peer:1000:1',
    )).toHaveLength(3)
  })

  it('正文冲突时拒绝覆盖，后续分段失败收口且不进入通用批次', () => {
    const id = reserve()
    expect(completeAiReplyMessageListRecordSegments(decrypted, id, {
      segments: ['第一段', '第二段', '第三段'],
    }).ok).toBe(true)
    expect(completeAiReplyMessageListRecordSegments(decrypted, id, {
      segments: ['被篡改的首段', '第二段', '第三段'],
    })).toMatchObject({ ok: false })
    expect(listMessageListRecords(decrypted).items.find((record) => record.segmentIndex === 1)?.text)
      .toBe('第一段')

    expect(failAiReplyMessageListSegmentsAfter(
      decrypted,
      'ai-reply:wxid_self:wxid_peer:1000:1',
      1,
      '首段发送失败',
    ).ok).toBe(true)
    const ordered = [...listMessageListRecords(decrypted).items].sort((a, b) =>
      (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0))
    expect(ordered.map((record) => record.status)).toEqual(['pending', 'failed', 'failed'])

    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare("UPDATE message_list_records SET webhook_url = 'https://example.test/ai'")
        .run()
    })
    expect(pendingMessageListRecordIds(decrypted, 100)).toEqual([])
  })
})
