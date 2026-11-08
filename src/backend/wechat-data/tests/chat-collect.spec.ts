// @vitest-environment node
/**
 * 聊天素材收集任务的后端落盘守卫（2026-10-19「新建任务」）。
 *
 * 这里不造真实消息库：`queryMessages` 在没有分片目录时返回空快照，正好覆盖
 * 「空会话也能建任务」这条边界 —— 目录 / texts.json / task.json / DB 行都必须真的写出来。
 * 有消息时的选条逻辑由 `queryMessages` 自己的用例保证，本文件只守任务壳。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createChatCollectTask, listChatCollectTasks } from '../src/query/chat-collect.ts'

let root = ''
let decrypted = ''
let decoded = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-collect-'))
  decrypted = join(root, 'data', 'decrypted')
  decoded = join(root, 'data', 'decoded_images')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('新建任务：聊天素材收集', () => {
  it('空会话也能创建任务：texts.json / task.json / DB 行都落盘', async () => {
    const r = await createChatCollectTask(decrypted, decoded, {
      username: 'wxid_lisi',
      displayName: '李四',
      textLimit: 20,
      imageLimit: 6,
    })
    expect(r.ok).toBe(true)
    expect(r.task).toBeDefined()
    if (r.task === undefined) return
    expect(r.task.username).toBe('wxid_lisi')
    expect(r.task.displayName).toBe('李四')
    expect(r.task.textLimit).toBe(20)
    expect(r.task.imageLimit).toBe(6)
    expect(r.task.textCount).toBe(0)
    expect(r.task.imageCount).toBe(0)
    expect(existsSync(r.task.dir)).toBe(true)
    expect(existsSync(join(r.task.dir, 'texts.json'))).toBe(true)
    expect(existsSync(join(r.task.dir, 'task.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(r.task.dir, 'texts.json'), 'utf8'))).toEqual([])
    expect(JSON.parse(readFileSync(join(r.task.dir, 'task.json'), 'utf8'))).toMatchObject({
      username: 'wxid_lisi', displayName: '李四', textCount: 0, imageCount: 0,
    })
  })

  it('任务记录可列出（最新在前），数量字段来自实际落盘', async () => {
    const first = await createChatCollectTask(decrypted, decoded, { username: 'wxid_a', textLimit: 10, imageLimit: 3 })
    const second = await createChatCollectTask(decrypted, decoded, { username: 'wxid_b', textLimit: 50, imageLimit: 0 })
    expect(first.ok && second.ok).toBe(true)
    const snap = listChatCollectTasks(decrypted)
    expect(snap.readError).toBeUndefined()
    expect(snap.total).toBe(2)
    expect(snap.items.map((t) => t.username)).toEqual(['wxid_b', 'wxid_a'])
    expect(snap.items[0]?.textLimit).toBe(50)
    expect(snap.items[0]?.imageLimit).toBe(0)
  })

  it('没指定会话直接拒绝（不建目录、不写库）', async () => {
    const r = await createChatCollectTask(decrypted, decoded, { username: '  ' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未指定会话')
    expect(listChatCollectTasks(decrypted).items).toHaveLength(0)
  })

  it('旧消息表 hash 在新建和读取任务时都归一为真实群身份', async () => {
    const room = '44626999237@chatroom'
    const hash = createHash('md5').update(room, 'utf8').digest('hex')
    const table = 'Msg_' + createHash('md5').update(room, 'utf8').digest('hex')
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    const messageDb = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
    try {
      messageDb.exec('CREATE TABLE Name2Id (user_name TEXT)')
      messageDb.prepare('INSERT INTO Name2Id VALUES (?)').run(room)
      messageDb.exec(`CREATE TABLE "${table}" (local_id INTEGER)`)
    } finally {
      messageDb.close()
    }
    mkdirSync(join(decrypted, 'session'), { recursive: true })
    const sessionDb = new DatabaseSync(join(decrypted, 'session', 'session.db'))
    try {
      sessionDb.exec('CREATE TABLE SessionNoContactInfoTable (username TEXT, session_title TEXT)')
      sessionDb.prepare('INSERT INTO SessionNoContactInfoTable VALUES (?, ?)').run(hash, '旧群正式名称')
    } finally {
      sessionDb.close()
    }

    const created = await createChatCollectTask(decrypted, decoded, {
      username: hash,
      displayName: hash,
      textLimit: 10,
      imageLimit: 0,
    })
    expect(created.ok, created.error).toBe(true)
    expect(created.task).toMatchObject({
      username: room,
      displayName: '旧群正式名称',
    })
    expect(JSON.stringify(created.task)).not.toContain(hash)

    const taskDb = new DatabaseSync(join(dirname(decrypted), 'wechat_collect.db'))
    try {
      taskDb.prepare('UPDATE chat_collect_tasks SET username = ?, display_name = ?').run(hash, hash)
    } finally {
      taskDb.close()
    }
    const listed = listChatCollectTasks(decrypted)
    expect(listed.items[0]).toMatchObject({
      username: room,
      displayName: '旧群正式名称',
    })
    expect(JSON.stringify(listed)).not.toContain(hash)
  })
})
