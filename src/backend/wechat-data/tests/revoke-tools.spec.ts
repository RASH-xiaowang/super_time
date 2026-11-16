/**
 * `search_revoked` 工具用例：归档原文、筛选、空归档与截断。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { searchRevokedTool } from '../src/query/tools/revoke-tools.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeRoot(): { root: string; decrypted: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'wx-revoke-tool-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return { root, decrypted, ctx: { decryptedDir: decrypted } }
}

/** 与 revoke-retain 的 talker 编码一致：`message_1.db#Msg_<md5(username)>`。 */
function talkerOf(username: string): string {
  return 'message_1.db#Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

function makeContacts(decrypted: string, contacts: Array<[string, string]>): void {
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const db = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  try {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
    const insert = db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)')
    for (const [username, name] of contacts) insert.run(username, name, name)
  } finally {
    db.close()
  }
}

interface RevokeSpec {
  session: string
  sender: string
  senderName: string
  content: string
  createTime: number
  localId: number
}

/**
 * 直接构造最小归档库（不经过消息分片）：
 * 一条原文 + 紧随其后的撤回提示，正是 `queryRevokedRetained` 的配对形状。
 */
function makeArchive(root: string, specs: readonly RevokeSpec[]): void {
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
    // 批量插入包一层事务：几千行逐条自动提交在 Windows 上会拖到秒级。
    archive.exec('BEGIN')
    try {
      specs.forEach((spec, index) => {
        const talker = talkerOf(spec.session)
        const base = index * 2 + 1
        // 原文（local_type=1 文本）
        insert.run(
          talker, base, spec.createTime, 1,
          spec.sender, spec.localId, 's' + String(spec.localId), spec.content,
        )
        // 撤回提示（local_type=10000）—— 必须紧跟在原文之后（row_key 更大）。
        insert.run(
          talker, base + 1, spec.createTime, 10000,
          spec.sender, spec.localId + 10000, '',
          `“${spec.senderName}” 撤回了一条消息`,
        )
      })
      archive.exec('COMMIT')
    } catch (e) {
      archive.exec('ROLLBACK')
      throw e
    }
  } finally {
    archive.close()
  }
}

function epoch(y: number, mo: number, d: number, h = 12): number {
  return Math.floor(new Date(y, mo - 1, d, h, 0, 0).getTime() / 1000)
}

/**
 * 追加一条**无法归属会话**的撤回记录：talker 不以 `#Msg_<md5>` 结尾，
 * `queryRevokedRetained` 便不会给出 `session_username`。用于验证会话过滤的
 * fail closed：缺失归属的行不能漏进会话内问答。
 */
function appendOrphanRevoke(root: string, content: string, createTime: number): void {
  const archive = new DatabaseSync(join(root, 'message-archive.db'))
  try {
    const insert = archive.prepare('INSERT INTO archived_msg VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 1)')
    insert.run('orphan_talker', 9001, createTime, 1, 'wxid_orphan', 901, 's901', content)
    insert.run(
      'orphan_talker', 9002, createTime, 10000, 'wxid_orphan', 10901, '',
      '“某人” 撤回了一条消息',
    )
  } finally {
    archive.close()
  }
}

const SPECS: RevokeSpec[] = [
  { session: 'wxid_a', sender: 'wxid_wang', senderName: '王五', content: '合同已经签好了', createTime: epoch(2025, 3, 10), localId: 11 },
  { session: 'wxid_a', sender: 'wxid_wang', senderName: '王五', content: '明天发你', createTime: epoch(2025, 3, 11), localId: 12 },
  { session: 'wxid_b', sender: 'wxid_li', senderName: '李四', content: '收到合同了', createTime: epoch(2025, 4, 2), localId: 21 },
]

describe('search_revoked', () => {
  it('返回归档原文、稳定 key 与统计 facts', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeContacts(decrypted, [['wxid_a', '张三'], ['wxid_b', '李四']])
    makeArchive(root, SPECS)

    const result = await searchRevokedTool.run({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toHaveLength(3)
    // 最近优先（归档按 create_time DESC 出列表）。
    expect(result.hits[0]?.key).toBe('wxid_b:21')
    expect(result.hits[0]?.snippet.startsWith('撤回：')).toBe(true)
    expect(result.hits[0]?.source).toBe('msg')
    expect(result.hits[0]?.trace?.kind).toBe('msg')
    expect(result.facts?.[0]?.title).toBe('撤回（全量）')
    expect(result.facts?.[0]?.body).toContain('共 3 条')
    expect(result.facts?.[0]?.body).toContain('王五 2 条')
  })

  it('query 匹配原文并统计关键词命中数', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeContacts(decrypted, [['wxid_a', '张三'], ['wxid_b', '李四']])
    makeArchive(root, SPECS)

    const result = await searchRevokedTool.run({ query: '合同' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toHaveLength(2)
    expect(result.facts?.[0]?.body).toContain('含「合同」2 条')
  })

  it('sender 与日期区间都是硬过滤', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeContacts(decrypted, [['wxid_a', '张三'], ['wxid_b', '李四']])
    makeArchive(root, SPECS)

    const bySender = await searchRevokedTool.run({ sender: '李四' }, ctx)
    expect(bySender.hits).toHaveLength(1)
    expect(bySender.hits[0]?.key).toBe('wxid_b:21')
    expect(bySender.facts?.[0]?.body).toContain('李四 1 条')

    const byRange = await searchRevokedTool.run({ from: '2025-03-01', to: '2025-03-31' }, ctx)
    expect(byRange.hits).toHaveLength(2)
    expect(byRange.facts?.[0]?.title).toBe('撤回（区间）')
  })

  it('会话内问答只保留能归属当前会话的行，缺失 session_username 的记录被排除', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeContacts(decrypted, [['wxid_a', '张三'], ['wxid_b', '李四']])
    makeArchive(root, SPECS)
    appendOrphanRevoke(root, '不属于任何已解析会话的撤回', epoch(2025, 5, 1))

    // 不锁会话时全部可见（确认孤儿行确实进了归档，而不是没被配对）。
    const all = await searchRevokedTool.run({}, ctx)
    expect(all.hits).toHaveLength(4)

    const scoped = await searchRevokedTool.run({}, { ...ctx, scope: { username: 'wxid_a' } })
    expect(scoped.ok).toBe(true)
    expect(scoped.hits).toHaveLength(2)
    expect(scoped.hits.every(hit => hit.key.startsWith('wxid_a:'))).toBe(true)
    // facts 只统计过滤后的行，而不是归档全量。
    expect(scoped.facts?.[0]?.body).toContain('共 2 条')
    expect(scoped.facts?.[0]?.body).toContain('王五 2 条')
    expect(scoped.note).toContain('仅当前会话')

    // 另一个会话只看到自己的 1 条；孤儿行在任何会话里都不会出现。
    const other = await searchRevokedTool.run({}, { ...ctx, scope: { username: 'wxid_b' } })
    expect(other.hits.map(hit => hit.key)).toEqual(['wxid_b:21'])

    // 没有命中的会话：空结果 note 也要明确「仅当前会话」。
    const none = await searchRevokedTool.run({}, { ...ctx, scope: { username: 'wxid_c' } })
    expect(none.hits).toEqual([])
    expect(none.facts).toEqual([])
    expect(none.note).toContain('仅当前会话')
  })

  it('参数非法时回退到安全默认值', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeContacts(decrypted, [['wxid_a', '张三'], ['wxid_b', '李四']])
    makeArchive(root, SPECS)

    const result = await searchRevokedTool.run({ limit: 'abc' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toHaveLength(3)

    const clamped = await searchRevokedTool.run({ limit: -5 }, ctx)
    expect(clamped.hits).toHaveLength(1)
  })

  it('归档表存在但为空：不是「没有撤回」，也不报错', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeArchive(root, [])
    const result = await searchRevokedTool.run({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toEqual([])
    expect(result.facts).toEqual([])
    expect(result.note).toContain('归档中没有匹配')
  })

  it('归档不存在：note 明确说明「没有撤回归档」，不报成没有撤回', async () => {
    const { ctx } = makeRoot()
    const result = await searchRevokedTool.run({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toEqual([])
    expect(result.facts).toEqual([])
    expect(result.note).toContain('归档')
    expect(result.note).toContain('不等于')
  })

  it('超过扫描上界时如实标记结果不完整', async () => {
    const { root, decrypted, ctx } = makeRoot()
    makeContacts(decrypted, [['wxid_a', '张三']])
    const many: RevokeSpec[] = []
    for (let i = 0; i < 1005; i += 1) {
      many.push({
        session: 'wxid_a',
        sender: 'wxid_wang',
        senderName: '王五',
        content: `消息 ${String(i)}`,
        createTime: epoch(2025, 1, 1) + i,
        localId: i + 1,
      })
    }
    makeArchive(root, many)

    const result = await searchRevokedTool.run({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toHaveLength(20)
    expect(result.note).toContain('结果可能不完整')
    expect(result.facts?.[0]?.body).toContain('共 1000 条')
  })
})
