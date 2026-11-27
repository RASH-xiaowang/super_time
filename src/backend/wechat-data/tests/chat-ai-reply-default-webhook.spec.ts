// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyChatAiReplyDefaultWebhook,
  readChatAiReplyDefaultWebhook,
  readChatAiReplyDefaultWebhookStrict,
  saveChatAiReplyDefaultWebhook,
} from '../src/query/ai-reply/default-webhook-store.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import {
  completeAiReplyMessageListRecord,
  getMessageListRecord,
  insertMessageListRecord,
  listMessageListRules,
  matchMessageListRule,
  pendingMessageListRecordIds,
  reserveAiReplyMessageListRecord,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import { dispatchMessageListRecord } from '../src/query/message-list-dispatch.ts'
import { taskDbPath } from '../src/query/task-db.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-default-webhook-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('AI 回复默认 Webhook', () => {
  it('旧消息规则表会迁移到账号作用域唯一索引', () => {
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.exec(`CREATE TABLE message_list_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_name TEXT NOT NULL DEFAULT '',
        target_name TEXT NOT NULL DEFAULT '',
        webhook_url TEXT NOT NULL,
        greeting_text TEXT NOT NULL DEFAULT '你好',
        note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`)
      db.exec(`CREATE UNIQUE INDEX idx_message_list_rule_pair
        ON message_list_rules(chat_name, target_name)`)
    })

    for (const account of ['wxid_self', 'wxid_other']) {
      expect(saveChatAiReplyDefaultWebhook(decrypted, {
        accountKey: account,
        chatUsername: 'wxid_peer',
        chatName: '小王',
        webhookUrl: 'http://192.168.1.4:17890/webhook/' + account,
      }).ok).toBe(true)
      expect(applyChatAiReplyDefaultWebhook(decrypted, {
        accountKey: account,
        chatUsername: 'wxid_peer',
        chatName: '小王',
      }).ok).toBe(true)
    }
    expect(listMessageListRules(decrypted).total).toBe(2)
    const indexColumns = withWritableDb(taskDbPath(decrypted), (db) => (
      db.prepare(`PRAGMA index_info('idx_message_list_rule_pair')`).all() as Array<{ name?: unknown }>
    )).map((row) => String(row.name ?? ''))
    expect(indexColumns).toEqual(['account_key', 'chat_username', 'chat_name', 'target_name'])
  })

  it('按账号保存完整地址，但读取只返回脱敏端点', () => {
    const fullUrl = 'http://192.168.1.4:17890/webhook/0123456789abcdef0123456789abcdef?token=secret'
    const saved = saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: fullUrl,
    })
    if (!saved.ok) throw new Error(saved.error)

    expect(saved.webhook).toMatchObject({
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
    })
    expect(JSON.stringify(saved)).not.toContain('0123456789abcdef0123456789abcdef')
    expect(readChatAiReplyDefaultWebhookStrict(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      ok: true,
      webhook: {
        configured: true,
        endpoint: 'http://192.168.1.4:17890/webhook/***',
      },
    })
    expect(readChatAiReplyDefaultWebhook(decrypted, 'wxid_other', 'wxid_peer')).toEqual({
      configured: false,
      endpoint: '',
      updatedAt: 0,
    })

    const row = withWritableDb(taskDbPath(decrypted), (db) => (
      db.prepare(`SELECT account_key, chat_username, webhook_url FROM chat_ai_reply_defaults
        WHERE account_key = ? AND chat_username = ?`).get('wxid_self', 'wxid_peer')
    )) as { webhook_url?: string }
    expect(row.webhook_url).toBe(fullUrl)
  })

  it('应用默认值时自动创建精确规则，并保持幂等', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    }).ok).toBe(true)

    const first = applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })
    expect(first).toMatchObject({
      ok: true,
      configured: true,
      ruleCreated: true,
      backfilled: 0,
    })
    const second = applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })
    expect(second).toMatchObject({
      ok: true,
      configured: true,
      ruleCreated: false,
      backfilled: 0,
    })

    const rules = listMessageListRules(decrypted)
    expect(rules.total).toBe(1)
    expect(rules.items[0]).toMatchObject({
      chatName: '小王',
      targetName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    })
    expect(matchMessageListRule(decrypted, '小王', '小王', {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })?.webhookUrl)
      .toBe('http://192.168.1.4:17890/webhook/default-token')
  })

  it('更换默认地址会刷新同一账号的系统规则与旧 pending 快照', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/old-token',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    }).ok).toBe(true)

    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:8:8',
    })
    if (!reserved.ok || reserved.id === undefined) throw new Error(reserved.error)
    expect(completeAiReplyMessageListRecord(decrypted, reserved.id, {
      text: '旧 token 下待发送的回复',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    }).ok).toBe(true)

    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/new-token',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })).toMatchObject({
      ok: true,
      ruleCreated: false,
      backfilled: 1,
    })
    expect(getMessageListRecord(decrypted, reserved.id)?.webhookUrl)
      .toBe('http://192.168.1.4:17890/webhook/new-token')
    expect(matchMessageListRule(decrypted, '小王', '小王', {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })?.webhookUrl).toBe('http://192.168.1.4:17890/webhook/new-token')
  })

  it('系统默认规则经人工编辑后升格为手工规则，不再被默认地址覆盖', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/system-token',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    }).ok).toBe(true)
    const rule = listMessageListRules(decrypted).items[0]
    if (rule === undefined) throw new Error('缺少自动规则')
    expect(saveMessageListRule(decrypted, {
      id: rule.id,
      chatName: '小王',
      targetName: '小王',
      webhookUrl: 'http://manual.example.test/webhook/manual-token',
      greetingText: '你好',
      note: '人工接管',
      enabled: true,
    }).ok).toBe(true)

    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/replacement-token',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })).toMatchObject({ ok: true, ruleCreated: false })
    expect(matchMessageListRule(decrypted, '小王', '小王', {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })).toMatchObject({
      webhookUrl: 'http://manual.example.test/webhook/manual-token',
      note: '人工接管',
    })
  })

  it('普通规则编辑保留账号/会话作用域，回填只命中同账号同会话', () => {
    for (const account of ['wxid_self', 'wxid_other']) {
      expect(saveChatAiReplyDefaultWebhook(decrypted, {
        accountKey: account,
        chatUsername: 'wxid_peer',
        chatName: '小王',
        webhookUrl: 'http://192.168.1.4:17890/webhook/' + account,
      }).ok).toBe(true)
      expect(applyChatAiReplyDefaultWebhook(decrypted, {
        accountKey: account,
        chatUsername: 'wxid_peer',
        chatName: '小王',
      }).ok).toBe(true)
    }
    const current = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:11:11',
    })
    const other = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_other:wxid_peer:11:11',
    })
    if (!current.ok || current.id === undefined) throw new Error(current.error)
    if (!other.ok || other.id === undefined) throw new Error(other.error)
    expect(completeAiReplyMessageListRecord(decrypted, current.id, {
      text: '当前账号待回填',
    }).ok).toBe(true)
    expect(completeAiReplyMessageListRecord(decrypted, other.id, {
      text: '另一个账号不得回填',
    }).ok).toBe(true)

    const ruleId = withWritableDb(taskDbPath(decrypted), (db) => {
      const row = db.prepare(`SELECT id FROM message_list_rules
        WHERE account_key = 'wxid_self' AND chat_username = 'wxid_peer'`)
        .get() as { id?: unknown } | undefined
      return Number(row?.id)
    })
    expect(saveMessageListRule(decrypted, {
      id: ruleId,
      chatName: '小王',
      targetName: '小王',
      webhookUrl: 'http://manual.example.test/webhook/scoped-manual',
      greetingText: '你好',
      note: '保留作用域的人工编辑',
      enabled: true,
    }).ok).toBe(true)

    expect(withWritableDb(taskDbPath(decrypted), (db) => (
      db.prepare(`SELECT account_key, chat_username, managed_by
        FROM message_list_rules WHERE id = ?`).get(ruleId)
    ))).toEqual({
      account_key: 'wxid_self',
      chat_username: 'wxid_peer',
      managed_by: '',
    })
    expect(getMessageListRecord(decrypted, current.id)?.webhookUrl)
      .toBe('http://manual.example.test/webhook/scoped-manual')
    expect(getMessageListRecord(decrypted, other.id)?.webhookUrl).toBe('')
  })

  it('同名会话按账号创建独立系统规则，匹配与回填互不串用', () => {
    for (const row of [
      { account: 'wxid_self', token: 'account-a' },
      { account: 'wxid_other', token: 'account-b' },
    ]) {
      expect(saveChatAiReplyDefaultWebhook(decrypted, {
        accountKey: row.account,
        chatUsername: 'wxid_peer',
        chatName: '小王',
        webhookUrl: 'http://192.168.1.4:17890/webhook/' + row.token,
      }).ok).toBe(true)
    }

    const first = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:9:9',
    })
    const second = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_other:wxid_peer:9:9',
    })
    if (!first.ok || first.id === undefined) throw new Error(first.error)
    if (!second.ok || second.id === undefined) throw new Error(second.error)
    expect(completeAiReplyMessageListRecord(decrypted, first.id, { text: '账号 A 回复' }).ok).toBe(true)
    expect(completeAiReplyMessageListRecord(decrypted, second.id, { text: '账号 B 回复' }).ok).toBe(true)

    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })).toMatchObject({ ok: true, backfilled: 1 })
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_other',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })).toMatchObject({ ok: true, backfilled: 1 })

    expect(listMessageListRules(decrypted).total).toBe(2)
    expect(getMessageListRecord(decrypted, first.id)?.webhookUrl)
      .toBe('http://192.168.1.4:17890/webhook/account-a')
    expect(getMessageListRecord(decrypted, second.id)?.webhookUrl)
      .toBe('http://192.168.1.4:17890/webhook/account-b')
    expect(matchMessageListRule(decrypted, '小王', '小王', {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })?.webhookUrl).toBe('http://192.168.1.4:17890/webhook/account-a')
    expect(matchMessageListRule(decrypted, '小王', '小王', {
      accountKey: 'wxid_other',
      chatUsername: 'wxid_peer',
    })?.webhookUrl).toBe('http://192.168.1.4:17890/webhook/account-b')
  })

  it('生成中的空预约不会被回填或自动批次投递', async () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    }).ok).toBe(true)

    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:10:10',
    })
    if (!reserved.ok || reserved.id === undefined) throw new Error(reserved.error)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })).toMatchObject({ ok: true, backfilled: 0 })
    expect(getMessageListRecord(decrypted, reserved.id)?.webhookUrl).toBe('')
    expect(pendingMessageListRecordIds(decrypted, 20)).not.toContain(reserved.id)

    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const blocked = await dispatchMessageListRecord(decrypted, reserved.id, {
      decodeImage: async () => ({}),
      gate: (_feature, _stats, texts) => texts,
      fetchImpl,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toContain('已拒绝投递空消息')
    expect(fetchImpl).not.toHaveBeenCalled()

    expect(completeAiReplyMessageListRecord(decrypted, reserved.id, {
      text: '生成完成后的正文',
    }).ok).toBe(true)
    const sent = await dispatchMessageListRecord(decrypted, reserved.id, {
      decodeImage: async () => ({}),
      gate: (_feature, _stats, texts) => texts,
      fetchImpl,
    })
    expect(sent.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('已有手工精确规则时绝不覆盖，并用手工规则地址回填 AI pending', () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '小王',
      targetName: '小王',
      webhookUrl: 'http://manual.example.test/webhook/manual-token',
      greetingText: '你好',
      note: '人工规则',
      enabled: true,
    }).ok).toBe(true)
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    }).ok).toBe(true)

    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:1:1',
    })
    if (!reserved.ok || reserved.id === undefined) throw new Error(reserved.error)
    expect(completeAiReplyMessageListRecord(decrypted, reserved.id, {
      text: '这是 AI 回复',
    }).ok).toBe(true)

    const applied = applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })
    expect(applied).toMatchObject({
      ok: true,
      ruleCreated: false,
      backfilled: 1,
    })
    expect(listMessageListRules(decrypted).items).toEqual([
      expect.objectContaining({
        webhookUrl: 'http://manual.example.test/webhook/manual-token',
        note: '人工规则',
      }),
    ])
    expect(getMessageListRecord(decrypted, reserved.id)).toMatchObject({
      status: 'pending',
      webhookUrl: 'http://manual.example.test/webhook/manual-token',
    })

    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/replacement-token',
    }).ok).toBe(true)
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })).toMatchObject({
      ok: true,
      ruleCreated: false,
      backfilled: 0,
    })
    expect(listMessageListRules(decrypted).items[0]).toMatchObject({
      webhookUrl: 'http://manual.example.test/webhook/manual-token',
      note: '人工规则',
    })
  })

  it('只回填同一会话、同一触发对象且无地址的 AI pending 记录', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    }).ok).toBe(true)

    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:2:2',
    })
    if (!reserved.ok || reserved.id === undefined) throw new Error(reserved.error)
    expect(completeAiReplyMessageListRecord(decrypted, reserved.id, {
      text: '待发送的 AI 回复',
    }).ok).toBe(true)

    const manual = insertMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      text: '人工消息不能被自动规则改道',
    })
    if (!manual.ok || manual.id === undefined) throw new Error(manual.error)

    const other = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小李',
      targetName: '小李',
      chatUsername: 'wxid_other_peer',
      targetUsername: 'wxid_other_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_other_peer:1:1',
    })
    if (!other.ok || other.id === undefined) throw new Error(other.error)
    expect(completeAiReplyMessageListRecord(decrypted, other.id, {
      text: '另一个会话的 AI 回复',
    }).ok).toBe(true)

    const applied = applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })
    expect(applied).toMatchObject({ ok: true, backfilled: 1 })
    expect(getMessageListRecord(decrypted, reserved.id)).toMatchObject({
      status: 'pending',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    })
    expect(getMessageListRecord(decrypted, manual.id)?.webhookUrl).toBe('')
    expect(getMessageListRecord(decrypted, other.id)?.webhookUrl).toBe('')
  })

  it('同名会话跨账号只回填当前账号的 AI pending', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    }).ok).toBe(true)

    const currentAccount = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:3:3',
    })
    if (!currentAccount.ok || currentAccount.id === undefined) {
      throw new Error(currentAccount.error)
    }
    expect(completeAiReplyMessageListRecord(decrypted, currentAccount.id, {
      text: '当前账号的 AI 回复',
    }).ok).toBe(true)

    const otherAccount = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_other:wxid_peer:3:3',
    })
    if (!otherAccount.ok || otherAccount.id === undefined) throw new Error(otherAccount.error)
    expect(completeAiReplyMessageListRecord(decrypted, otherAccount.id, {
      text: '另一个账号下同名会话的 AI 回复',
    }).ok).toBe(true)

    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })).toMatchObject({ ok: true, backfilled: 1 })
    expect(getMessageListRecord(decrypted, currentAccount.id)).toMatchObject({
      status: 'pending',
      webhookUrl: 'http://192.168.1.4:17890/webhook/default-token',
    })
    expect(getMessageListRecord(decrypted, otherAccount.id)).toMatchObject({
      status: 'pending',
      webhookUrl: '',
    })
  })

  it('未配置或非法 Webhook 时 fail-closed', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'file:///tmp/not-a-webhook',
    })).toMatchObject({ ok: false })
    expect(applyChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      targetName: '小王',
    })).toMatchObject({
      ok: false,
      configured: false,
      reason: 'missing_webhook',
    })
    expect(listMessageListRules(decrypted).total).toBe(0)
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/hooks/super-secret',
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining('/webhook/<token>'),
    })
  })
})
