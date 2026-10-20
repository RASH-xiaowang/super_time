/**
 * ClawBot 库的迁移纪律守卫。
 *
 * 建这个库时**没有**老版本可迁 —— 这条守的是**机制**：新列必须走
 * `ALTER TABLE ADD COLUMN`（老库缺列时补齐、既有行一行不丢），
 * 而不是改建表语句（那会让老库上的 `INSERT … 新列` 抛 `no such column`，
 * 而写入多为 best-effort ⇒ 症状是**静默少记**）。
 *
 * 做法：手工造一个「缺列的老库」，跑一次真实写路径（ensure 顺带迁移），
 * 再断言缺的列被补上、老行还在、按新列读写都不抛。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import { completeBinding, markBindingQr, readBinding, readBindingInternal, saveSendContextToken } from '../src/query/clawbot/clawbot-binding.ts'
import { listClawbotMessages, insertClawbotMessage, readClawbotMessageInternal } from '../src/query/clawbot/clawbot-message.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-mig-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 造一个「老版本」的 clawbot.db：绑定表缺二维码/身份列，消息表缺 msg_type。 */
function makeOldDb(dir: string): void {
  const db = new DatabaseSync(clawbotDbPath(dir))
  db.exec(`CREATE TABLE clawbot_binding (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    status     TEXT NOT NULL DEFAULT 'unbound',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE clawbot_message (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    direction  TEXT NOT NULL,
    content    TEXT,
    created_at INTEGER NOT NULL
  )`)
  db.prepare('INSERT INTO clawbot_binding(id, status, created_at, updated_at) VALUES (1, ?, 111, 222)').run('unbound-by-user')
  db.prepare('INSERT INTO clawbot_message(ts, direction, content, created_at) VALUES (5, ?, ?, 5)').run('in', '老消息')
  db.close()
}

describe('clawbot 库迁移：老库缺列时补齐、既有行不丢', () => {
  it('写路径顺带跑迁移：补列后按新列读写都不抛，老行保持原样', () => {
    const dir = root()
    makeOldDb(dir)

    // 真实写路径（内部先 ensureClawbotSchema ⇒ 补列），这一步在老库上不许抛 no such column
    const after = markBindingQr(dir, { token: 'tok-mig', expiresAt: 42 })
    expect(after.status).toBe('binding')
    expect(after.qrToken).toBe('tok-mig')
    // 老行还是同一行（id=1），created_at 原样保留
    expect(after.id).toBe(1)
    expect(after.createdAt).toBe(111)

    // iLink 凭证列（2026-10-12 新增）在**老库**上也要能写能读 —— 这正是本期迁移的场景。
    const creds = { botToken: 'bt', ilinkBotId: 'bot', ilinkUserId: 'user', baseUrl: '' }
    completeBinding(dir, { wxid: 'user' }, creds)
    expect(readBindingInternal(dir).credentials).toEqual(creds)
    saveSendContextToken(dir, 'ctx-mig')
    expect(readBindingInternal(dir).sendContextToken).toBe('ctx-mig')

    // 消息表同理：msg_type / msg_id / 附件列被补上，老消息还在、新写入可用、去重生效。
    insertClawbotMessage(dir, { ts: 6, direction: 'out', content: '新消息', msgType: 'text', msgId: 66 })
    insertClawbotMessage(dir, { ts: 7, direction: 'in', content: '同 id 重发', msgId: 66 })
    insertClawbotMessage(dir, {
      ts: 8, direction: 'in', msgType: 'image', content: '[图片]',
      media: { kind: 'image', ref: 'enc-mig', key: 'k-mig', name: null, size: 9, duration: null },
    })
    const msgs = listClawbotMessages(dir)
    expect(msgs.total).toBe(3)
    expect(msgs.items.map(m => m.content).sort()).toEqual(['[图片]', '新消息', '老消息'].sort())
    expect(msgs.items.find(m => m.content === '新消息')?.msgType).toBe('text')
    const img = msgs.items.find(m => m.content === '[图片]')
    expect(img?.media).toEqual({ kind: 'image', name: null, size: 9, duration: null })
    expect(readClawbotMessageInternal(dir, img?.id ?? 0)?.media?.ref).toBe('enc-mig')
  })

  it('迁移是幂等的：连着跑两次写路径不抛、行数不变', () => {
    const dir = root()
    makeOldDb(dir)
    markBindingQr(dir, { token: 'a', expiresAt: 1 })
    markBindingQr(dir, { token: 'b', expiresAt: 2 })
    const db = new DatabaseSync(clawbotDbPath(dir))
    const n = (db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding').get() as { n?: number } | undefined)?.n
    db.close()
    expect(Number(n ?? 0)).toBe(1)
    expect(readBinding(dir).binding.qrToken).toBe('b')
  })

  it('全新的库直接建出完整结构（不走迁移分支）：四态之外的列一个不少', () => {
    const dir = root()
    markBindingQr(dir, { token: 't', expiresAt: 9 })
    const db = new DatabaseSync(clawbotDbPath(dir))
    const cols = (db.prepare('PRAGMA table_info(clawbot_binding)').all() as Array<{ name?: string }>).map(c => c.name)
    const msgCols = (db.prepare('PRAGMA table_info(clawbot_message)').all() as Array<{ name?: string }>).map(c => c.name)
    db.close()
    for (const col of ['qr_token', 'qr_expires_at', 'wxid', 'user_name', 'avatar', 'bound_at', 'unbound_at',
      'bot_token', 'ilink_bot_id', 'ilink_user_id', 'base_url', 'sync_buf', 'send_context_token']) {
      expect(cols, `新库缺列 ${col}`).toContain(col)
    }
    for (const col of ['msg_id', 'media_kind', 'media_ref', 'media_key', 'media_name', 'media_size']) {
      expect(msgCols, `新库消息表缺 ${col}`).toContain(col)
    }
  })
})
