/**
 * Revoked-message rows resolve the same WeCom enterprise names as the rest of
 * the read path, for both the conversation and the message sender.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryRevokedRetained } from '../src/query/revoke-retain.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function protobufString(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes])
}

function addContact(
  db: DatabaseSync,
  username: string,
  name: string,
  wordingId?: string,
): void {
  db.prepare(
    'INSERT INTO contact (username, remark, nick_name, extra_buffer) VALUES (?, ?, ?, ?)',
  ).run(
    username,
    name,
    name,
    wordingId === undefined ? Buffer.alloc(0) : protobufString(2, wordingId),
  )
}

function talkerOf(username: string): string {
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  return 'message_1.db#' + table
}

describe('queryRevokedRetained enterprise identity', () => {
  it('adds enterprise names for direct sessions and group senders', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-revoke-enterprise-'))
    scratch.push(root)
    const decrypted = join(root, 'decrypted')
    mkdirSync(join(decrypted, 'contact'), { recursive: true })

    const direct = 'wxid_direct@openim'
    const sender = 'wxid_sender@openim'
    const group = '123@chatroom'
    const contactDb = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
    try {
      contactDb.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
      contactDb.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
      contactDb.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-a', '甲方公司')
      contactDb.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-b', '乙方公司')
      addContact(contactDb, direct, '张三', 'wording-a')
      addContact(contactDb, sender, '李四', 'wording-b')
      addContact(contactDb, group, '项目群')
    } finally {
      contactDb.close()
    }

    const archive = new DatabaseSync(join(root, 'message-archive.db'))
    try {
      archive.exec(`CREATE TABLE archived_msg (
        talker TEXT NOT NULL,
        row_key INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        local_type INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_username TEXT NOT NULL DEFAULT '',
        local_id INTEGER NOT NULL DEFAULT 0,
        server_id TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (talker, row_key)
      )`)
      const insert = archive.prepare(
        'INSERT INTO archived_msg VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 1)',
      )
      insert.run(talkerOf(direct), 1, 100, 1, direct, 11, 's11', '你好')
      insert.run(talkerOf(direct), 2, 101, 10000, direct, 12, 's12', '“张三” 撤回了一条消息')
      insert.run(talkerOf(group), 1, 200, 1, sender, 21, 's21', '李四:\n项目进度已更新')
      insert.run(
        talkerOf(group),
        2,
        201,
        10000,
        sender,
        22,
        's22',
        `${sender}: “李四” 撤回了一条消息`,
      )
    } finally {
      archive.close()
    }

    const { items } = queryRevokedRetained(decrypted, 10, 0)
    expect(items).toHaveLength(2)
    expect(items.find(item => !item.session_is_group)).toMatchObject({
      session_username: direct,
      session_name: '张三',
      enterpriseName: '甲方公司',
      sender_username: direct,
      senderEnterpriseName: '甲方公司',
    })
    expect(items.find(item => item.session_is_group)).toMatchObject({
      session_username: group,
      session_name: '项目群',
      sender_username: sender,
      senderEnterpriseName: '乙方公司',
    })
  })
})
