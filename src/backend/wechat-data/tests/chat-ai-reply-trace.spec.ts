// @vitest-environment node
/**
 * 过程留痕的落库与读取。
 *
 * 锁定三件事：增量补丁只覆盖给出的字段、阶段按时间追加、记录被删后留痕不留孤儿。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import { ensureMessageListSchema } from '../src/query/message-list-store-schema.ts'
import {
  pruneOrphanChatAiReplyTraces,
  readChatAiReplyTrace,
  writeChatAiReplyTrace,
} from '../src/query/ai-reply/trace-store.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-trace-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function insertRecord(id: number): void {
  withWritableDb(taskDbPath(decrypted), (db) => {
    ensureMessageListSchema(db)
    db.prepare(`INSERT INTO message_list_records
      (id, reply_id, triggered_at, source, status, created_at, updated_at)
      VALUES (?, ?, ?, 'ai_reply', 'pending', ?, ?)`)
      .run(id, 'reply-' + String(id), Date.now(), Date.now(), Date.now())
  })
}

describe('AI 回复过程留痕', () => {
  it('增量写入后能读回上下文、提示词与输出', () => {
    writeChatAiReplyTrace(decrypted, {
      recordId: 11,
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1000:1',
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      startedAt: 1000,
      context: '[2026-11-18 14:00] 对方：在吗',
    })
    writeChatAiReplyTrace(decrypted, {
      recordId: 11,
      systemPrompt: '你是助手',
      userPrompt: '请回复最后一条',
      output: '在的',
      model: 'opencode/kimi',
      imageCount: 1,
      voiceCount: 2,
      finishedAt: 2000,
      stage: { name: 'generated', at: 2000, detail: 'chars=2' },
    })
    const read = readChatAiReplyTrace(decrypted, 11)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.trace).toMatchObject({
      recordId: 11,
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      // 第一次写入的字段在第二次补丁里没给，必须保留。
      context: '[2026-11-18 14:00] 对方：在吗',
      systemPrompt: '你是助手',
      userPrompt: '请回复最后一条',
      output: '在的',
      model: 'opencode/kimi',
      imageCount: 1,
      voiceCount: 2,
      startedAt: 1000,
      finishedAt: 2000,
    })
    expect(read.trace.stages).toHaveLength(1)
    expect(read.trace.stages[0]).toMatchObject({ name: 'generated', detail: 'chars=2' })
  })

  it('阶段按调用顺序追加，不覆盖前面的阶段', () => {
    for (const name of ['reserved', 'context', 'generated'] as const) {
      writeChatAiReplyTrace(decrypted, { recordId: 12, stage: { name, at: Date.now() } })
    }
    const read = readChatAiReplyTrace(decrypted, 12)
    expect(read.ok && read.trace.stages.map((stage) => stage.name))
      .toEqual(['reserved', 'context', 'generated'])
  })

  it('超长上下文被截断，不会把整段聊天无限写进任务库', () => {
    writeChatAiReplyTrace(decrypted, { recordId: 13, context: 'x'.repeat(50_000) })
    const read = readChatAiReplyTrace(decrypted, 13)
    expect(read.ok && read.trace.context.length).toBe(40_000)
  })

  it('非法 recordId 与不存在的记录都不抛错', () => {
    expect(() => writeChatAiReplyTrace(decrypted, { recordId: 0, context: 'x' })).not.toThrow()
    expect(() => writeChatAiReplyTrace(decrypted, { recordId: -1, context: 'x' })).not.toThrow()
    expect(readChatAiReplyTrace(decrypted, 999).ok).toBe(false)
  })

  it('记录被删后留痕随之清理，不留孤儿聊天正文', () => {
    insertRecord(21)
    insertRecord(22)
    writeChatAiReplyTrace(decrypted, { recordId: 21, context: '要删掉的上下文' })
    writeChatAiReplyTrace(decrypted, { recordId: 22, context: '要保留的上下文' })
    withWritableDb(taskDbPath(decrypted), (db) => {
      ensureMessageListSchema(db)
      db.prepare('DELETE FROM message_list_records WHERE id = 21').run()
      expect(pruneOrphanChatAiReplyTraces(db)).toBe(1)
    })
    expect(readChatAiReplyTrace(decrypted, 21).ok).toBe(false)
    expect(readChatAiReplyTrace(decrypted, 22).ok).toBe(true)
  })
})
