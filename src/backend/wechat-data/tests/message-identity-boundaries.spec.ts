/**
 * Mutation-boundary regressions for WeChat 4.x message-table hashes.
 *
 * The read-side resolver is covered by message-identity.spec.ts. This file
 * verifies that tasks, AI settings, message-list records and exports cannot
 * turn a physical hash back into a persisted or user-visible chat identity.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateWechatMeta } from '../src/query/meta.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import {
  ensureExactMessageListRule,
  insertMessageListRecord,
  listMessageListRecords,
} from '../src/query/message-list-store.ts'
import { listTaskInfos, saveTaskInfo } from '../src/query/task-center.ts'
import {
  readChatAiReplyState,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import {
  readChatAiReplyDefaultWebhook,
  saveChatAiReplyDefaultWebhook,
} from '../src/query/ai-reply/default-webhook-store.ts'
import { exportSessionMessages } from '../src/query/export.ts'

const scratch: string[] = []

afterEach(() => {
  invalidateWechatMeta()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-identity-boundary-'))
  scratch.push(root)
  return root
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function hashOf(username: string): string {
  return createHash('md5').update(username, 'utf8').digest('hex')
}

function tableOf(username: string): string {
  return 'Msg_' + hashOf(username)
}

function fixture(): { root: string; room: string; roomHash: string; person: string; personHash: string } {
  const dataRoot = tempRoot()
  const root = join(dataRoot, 'wechat', 'decrypted')
  const room = '44626999237@chatroom'
  const person = 'wxid_peer'
  const roomHash = hashOf(room)
  const personHash = hashOf(person)
  makeDb(join(root, 'message', 'message_0.db'), (db) => {
    db.exec('CREATE TABLE Name2Id (user_name TEXT)')
    const add = db.prepare('INSERT INTO Name2Id VALUES (?)')
    add.run(room)
    add.run(person)
    db.exec(`CREATE TABLE "${tableOf(room)}" (
      local_id INTEGER PRIMARY KEY, sort_seq INTEGER, local_type INTEGER,
      create_time INTEGER, real_sender_id INTEGER, message_content TEXT
    )`)
    db.prepare(`INSERT INTO "${tableOf(room)}" VALUES (?, ?, ?, ?, ?, ?)`).run(
      1, 1700000000000, 1, 1780000000, 2, 'wxid_peer:\n项目明天交付',
    )
    db.exec(`CREATE TABLE "${tableOf(person)}" (local_id INTEGER)`)
  })
  return { root, room, roomHash, person, personHash }
}

describe('legacy hash mutation boundaries', () => {
  it('canonicalizes message-list records and scoped AI rules', () => {
    const { root, room, roomHash, person } = fixture()
    const inserted = insertMessageListRecord(root, {
      chatName: roomHash,
      chatUsername: roomHash,
      targetName: '成员',
      targetUsername: person,
      text: '请发送',
      images: [],
    })

    expect(inserted.ok, inserted.error).toBe(true)
    expect(inserted.record).toMatchObject({
      chatUsername: room,
      chatName: '群聊 44626999237',
    })
    expect(listMessageListRecords(root).items[0]).toMatchObject({
      chatUsername: room,
      chatName: '群聊 44626999237',
    })
    expect(JSON.stringify(listMessageListRecords(root))).not.toContain(roomHash)

    const rule = ensureExactMessageListRule(root, {
      webhookUrl: 'https://sender.example/webhook/token',
      chatName: '项目群',
      targetName: '成员',
      accountKey: 'wxid_self',
      chatUsername: roomHash,
    })
    expect(rule.ok, rule.ok ? '' : rule.error).toBe(true)
    const db = new DatabaseSync(taskDbPath(root), { readOnly: true })
    try {
      const row = db.prepare(`SELECT chat_username FROM message_list_rules
        WHERE managed_by = 'ai_reply_default'`).get() as { chat_username?: string }
      expect(row.chat_username).toBe(room)
    } finally {
      db.close()
    }
  })

  it('canonicalizes task configuration and AI reply settings', () => {
    const { root, room, roomHash, person, personHash } = fixture()
    const task = saveTaskInfo(root, {
      chatUsername: roomHash,
      chatName: roomHash,
      chatType: 'private',
      targetUsername: person,
      targetName: '成员',
      keywords: ['交付'],
      triggerMethod: 'webhook',
      callbackUrl: 'https://callback.example/hook',
      status: 'incomplete',
    }, 'wxid_self')

    expect(task.ok, task.error).toBe(true)
    expect(listTaskInfos(root).items[0]).toMatchObject({
      chatUsername: room,
      chatName: '群聊 44626999237',
      chatType: 'group',
    })

    const ai = saveChatAiReplySetting(root, {
      accountKey: 'wxid_self',
      chatUsername: personHash,
      chatName: personHash,
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(ai.ok, ai.ok ? '' : ai.error).toBe(true)
    expect(readChatAiReplyState(root, 'wxid_self', personHash)).toMatchObject({
      chatUsername: person,
      chatName: '未知联系人',
      enabled: true,
    })

    const webhook = saveChatAiReplyDefaultWebhook(root, {
      accountKey: 'wxid_self',
      chatUsername: personHash,
      chatName: personHash,
      webhookUrl: 'https://sender.example/webhook/default-token',
    })
    expect(webhook.ok, webhook.ok ? '' : webhook.error).toBe(true)
    expect(readChatAiReplyDefaultWebhook(root, 'wxid_self', personHash).configured).toBe(true)

    const rejectedGroup = saveChatAiReplySetting(root, {
      accountKey: 'wxid_self',
      chatUsername: roomHash,
      chatName: '',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(rejectedGroup.ok).toBe(false)
    expect(rejectedGroup.error).toContain('仅支持单聊')

    const db = new DatabaseSync(taskDbPath(root), { readOnly: true })
    try {
      const taskRow = db.prepare('SELECT chat_username FROM task_info').get() as { chat_username?: string }
      const aiRow = db.prepare('SELECT chat_username FROM chat_ai_reply_settings').get() as { chat_username?: string }
      const hookRow = db.prepare('SELECT chat_username FROM chat_ai_reply_defaults').get() as { chat_username?: string }
      expect(taskRow.chat_username).toBe(room)
      expect(aiRow.chat_username).toBe(person)
      expect(hookRow.chat_username).toBe(person)
    } finally {
      db.close()
    }
  })

  it('exports a legacy hash session under its canonical identity', () => {
    const { root, roomHash } = fixture()
    const result = exportSessionMessages(
      root,
      roomHash,
      'json',
      10,
      join(dirname(root), 'exports'),
      undefined,
      undefined,
      undefined,
      undefined,
    )

    const content = readFileSync(result.path, 'utf8')
    expect(result.path).not.toContain(roomHash)
    expect(result.path).toContain('44626999237')
    expect(content).not.toContain(roomHash)
  })
})
