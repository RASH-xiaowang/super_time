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

  it('工具调用落库并按顺序读回（含失败码与耗时）', () => {
    writeChatAiReplyTrace(decrypted, {
      recordId: 14,
      tools: [
        { name: 'weather', ok: false, code: 'tool_network', elapsedMs: 6500 },
        { name: 'current_datetime', ok: true, elapsedMs: 1 },
      ],
    })
    const read = readChatAiReplyTrace(decrypted, 14)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.trace.tools).toEqual([
      { name: 'weather', ok: false, code: 'tool_network', elapsedMs: 6500 },
      { name: 'current_datetime', ok: true, elapsedMs: 1 },
    ])
  })

  it('老库缺 tools 列时自动补上（不补的话详情里永远看不到工具调用）', () => {
    // 手工造一张没有 tools 列的老表
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.exec(`CREATE TABLE chat_ai_reply_traces (
        record_id INTEGER PRIMARY KEY,
        source_ref TEXT NOT NULL DEFAULT '', account_key TEXT NOT NULL DEFAULT '',
        chat_username TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL DEFAULT 0, finished_at INTEGER NOT NULL DEFAULT 0,
        context TEXT NOT NULL DEFAULT '', kb TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '', user_prompt TEXT NOT NULL DEFAULT '',
        image_count INTEGER NOT NULL DEFAULT 0, voice_count INTEGER NOT NULL DEFAULT 0,
        output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        redacted INTEGER NOT NULL DEFAULT 0, stages TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )`)
      db.prepare('INSERT INTO chat_ai_reply_traces (record_id, updated_at) VALUES (99, 1)').run()
    })
    // 旧行没有 tools ⇒ 读成空数组（不是 undefined，界面不用再判空）
    const old = readChatAiReplyTrace(decrypted, 99)
    expect(old.ok && old.trace.tools).toEqual([])
    writeChatAiReplyTrace(decrypted, { recordId: 99, tools: [{ name: 'weather', ok: true, elapsedMs: 12 }] })
    const read = readChatAiReplyTrace(decrypted, 99)
    expect(read.ok && read.trace.tools).toEqual([{ name: 'weather', ok: true, elapsedMs: 12 }])
  })

  it('坏掉/超长的工具条目被丢弃而不是整条留痕读不出来', () => {
    writeChatAiReplyTrace(decrypted, {
      recordId: 15,
      // 名字为空、类型不对的条目都不该进结果
      tools: [{ name: '', ok: true, elapsedMs: 1 }, { name: 42 as never, ok: true, elapsedMs: 2 }],
    })
    const read = readChatAiReplyTrace(decrypted, 15)
    expect(read.ok && read.trace.tools).toEqual([])
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
