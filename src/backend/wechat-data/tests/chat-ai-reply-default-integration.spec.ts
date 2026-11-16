// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readChatAiReplyState } from '../src/query/ai-reply/config-store.ts'
import {
  readChatAiReplyDefaultWebhookStrict,
  saveChatAiReplyDefaultWebhook,
} from '../src/query/ai-reply/default-webhook-store.ts'
import {
  completeAiReplyMessageListRecord,
  getMessageListRecord,
  listMessageListRecords,
  listMessageListRules,
  reserveAiReplyMessageListRecord,
  saveMessageListDispatchResult,
} from '../src/query/message-list-store.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import { createChatAiReplyRemotes } from '../src/remotes/chat-ai-reply.ts'

let root = ''
let decrypted = ''

const WEBHOOK = 'http://192.168.1.4:17890/webhook/0123456789abcdef0123456789abcdef'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-ai-reply-default-integration-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function remotes(changed = vi.fn()) {
  return {
    changed,
    value: createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate: async () => ({ ok: true, text: '不应生成' }),
      dispatch: async () => ({ ok: true }),
      changed,
    }),
  }
}

function seedMessages(
  rows: Array<{
    localId: number
    sortSeq: number
    type: number
    createTime: number
    senderRowId: number
    content: string
  }>,
): void {
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  const db = new DatabaseSync(join(decrypted, 'message', 'message_0.db'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS Name2Id (user_name TEXT)')
    const names = db.prepare('INSERT OR REPLACE INTO Name2Id (rowid, user_name) VALUES (?, ?)')
    names.run(1, '')
    names.run(2, 'wxid_peer')
    const table = 'Msg_' + createHash('md5').update('wxid_peer', 'utf8').digest('hex')
    db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
      local_id INTEGER PRIMARY KEY,
      sort_seq INTEGER,
      local_type INTEGER,
      create_time INTEGER,
      real_sender_id INTEGER,
      message_content TEXT
    )`)
    const insert = db.prepare(`INSERT OR REPLACE INTO "${table}" (
      local_id, sort_seq, local_type, create_time, real_sender_id, message_content
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    for (const row of rows) {
      insert.run(
        row.localId,
        row.sortSeq,
        row.type,
        row.createTime,
        row.senderRowId,
        row.content,
      )
    }
  } finally {
    db.close()
  }
}

async function dispatchSuccess(recordId: number): Promise<{ ok: true }> {
  saveMessageListDispatchResult(decrypted, recordId, {
    status: 'success',
    error: '',
    responseSummary: 'test success',
  })
  return { ok: true }
}

describe('AI 回复默认 Webhook 编排', () => {
  it('保存默认值后自动创建精确规则，并只向界面返回脱敏端点', () => {
    const runtime = remotes()
    const saved = runtime.value.saveDefaultWebhook({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: WEBHOOK,
    })

    expect(saved).toMatchObject({
      ok: true,
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
      ruleCreated: true,
    })
    expect(JSON.stringify(saved)).not.toContain('0123456789abcdef0123456789abcdef')
    expect(listMessageListRules(decrypted).items).toEqual([
      expect.objectContaining({
        chatName: '小王',
        targetName: '小王',
        webhookUrl: WEBHOOK,
      }),
    ])
    expect(runtime.changed).toHaveBeenCalled()
    expect(runtime.value.getState({
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })).toMatchObject({
      defaultWebhookConfigured: true,
      defaultWebhookEndpoint: 'http://192.168.1.4:17890/webhook/***',
    })
    runtime.value.dispose()
  })

  it('开启 AI 回复时绑定已保存默认地址，并回填同会话 pending 记录', () => {
    const stored = saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: WEBHOOK,
    })
    expect(stored.ok).toBe(true)

    const reserved = reserveAiReplyMessageListRecord(decrypted, {
      chatName: '小王',
      targetName: '小王',
      chatUsername: 'wxid_peer',
      targetUsername: 'wxid_peer',
      sourceRef: 'ai-reply:wxid_self:wxid_peer:4:4',
    })
    if (!reserved.ok || reserved.id === undefined) throw new Error(reserved.error)
    expect(completeAiReplyMessageListRecord(decrypted, reserved.id, {
      text: '等待发送的 AI 回复',
    }).ok).toBe(true)

    const runtime = remotes()
    const enabled = runtime.value.setEnabled({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(enabled).toMatchObject({
      ok: true,
      state: {
        enabled: true,
        defaultWebhookConfigured: true,
        defaultWebhookEndpoint: 'http://192.168.1.4:17890/webhook/***',
      },
    })
    expect(listMessageListRules(decrypted).items).toEqual([
      expect.objectContaining({
        chatName: '小王',
        targetName: '小王',
        webhookUrl: WEBHOOK,
      }),
    ])
    expect(getMessageListRecord(decrypted, reserved.id)).toMatchObject({
      status: 'pending',
      webhookUrl: WEBHOOK,
    })
    runtime.value.dispose()
  })

  it('读取默认值只返回脱敏端点，完整 token 仍保存在任务库', () => {
    const runtime = remotes()
    expect(runtime.value.getDefaultWebhook({ chatUsername: 'wxid_peer' })).toMatchObject({
      configured: false,
      endpoint: '',
    })
    expect(runtime.value.saveDefaultWebhook({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: WEBHOOK,
    }).ok).toBe(true)
    expect(runtime.value.getDefaultWebhook({ chatUsername: 'wxid_peer' })).toMatchObject({
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
    })
    expect(readChatAiReplyDefaultWebhookStrict(
      decrypted,
      'wxid_self',
      'wxid_peer',
    )).toMatchObject({
      ok: true,
      webhook: {
        configured: true,
        endpoint: 'http://192.168.1.4:17890/webhook/***',
      },
    })
    runtime.value.dispose()
  })

  it('开启时规则绑定失败会回传到状态，而不是只写日志后假装完全成功', () => {
    expect(saveChatAiReplyDefaultWebhook(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: WEBHOOK,
    }).ok).toBe(true)
    expect(listMessageListRules(decrypted).total).toBe(0)
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.exec(`CREATE TRIGGER fail_ai_default_rule
        BEFORE INSERT ON message_list_rules
        BEGIN
          SELECT RAISE(ABORT, 'forced binding failure');
        END`)
    })

    const runtime = remotes()
    const enabled = runtime.value.setEnabled({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })
    expect(enabled).toMatchObject({
      ok: true,
      state: {
        enabled: true,
      },
    })
    expect(enabled.state?.error).toContain('默认 Webhook 自动绑定失败')
    expect(enabled.state?.error).toContain('forced binding failure')
    runtime.value.dispose()
  })

  it('首次开启时最新图片也写入 v2 水位，后续扫描不回放历史图片', async () => {
    seedMessages([
      {
        localId: 1,
        sortSeq: 100,
        type: 1,
        createTime: 1_000,
        senderRowId: 2,
        content: '更早的文本',
      },
      {
        localId: 2,
        sortSeq: 200,
        type: 3,
        createTime: 2_000,
        senderRowId: 2,
        content: '<msg><img md5="latest-image"/></msg>',
      },
    ])
    const generate = vi.fn(async () => ({ ok: true as const, text: '不应生成' }))
    const runtime = createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate,
      dispatch: dispatchSuccess,
      changed: () => {},
    })

    expect(runtime.setEnabled({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })).toMatchObject({ ok: true })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      enabled: true,
      cursor: 'v2:200:2',
    })

    await runtime.scanOnce()
    expect(generate).not.toHaveBeenCalled()
    expect(listMessageListRecords(decrypted).items).toEqual([])
    runtime.dispose()
  })

  it('首次开启时最新表情也写入 v2 水位，避免把历史表情当成新消息', async () => {
    seedMessages([{
      localId: 4,
      sortSeq: 400,
      type: 47,
      createTime: 4_000,
      senderRowId: 2,
      content: '<msg><emoji md5="0123456789abcdef0123456789abcdef" cdnurl="https://mmbiz.qpic.cn/example.gif" /></msg>',
    }])
    const generate = vi.fn(async () => ({ ok: true as const, text: '不应生成' }))
    const runtime = createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate,
      dispatch: dispatchSuccess,
      changed: () => {},
    })

    expect(runtime.setEnabled({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })).toMatchObject({ ok: true })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      enabled: true,
      cursor: 'v2:400:4',
    })

    await runtime.scanOnce()
    expect(generate).not.toHaveBeenCalled()
    expect(listMessageListRecords(decrypted).items).toEqual([])
    runtime.dispose()
  })

  it('最近 80 条没有入站消息时仍以最新合法消息建立水位，第一条新消息不被漏掉', async () => {
    const rows: Parameters<typeof seedMessages>[0] = [{
      localId: 1,
      sortSeq: 100,
      type: 1,
      createTime: 1_000,
      senderRowId: 2,
      content: '开启前已经回答过的旧问题',
    }]
    for (let localId = 2; localId <= 82; localId += 1) {
      rows.push({
        localId,
        sortSeq: localId * 100,
        type: 1,
        createTime: localId * 1_000,
        senderRowId: 1,
        content: '我自己的历史消息 ' + String(localId),
      })
    }
    seedMessages(rows)
    const generate = vi.fn(async () => ({ ok: true, text: '新问题回复' }))
    const runtime = createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate,
      dispatch: dispatchSuccess,
      changed: () => {},
    })

    expect(runtime.setEnabled({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })).toMatchObject({ ok: true })
    expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
      enabled: true,
      cursor: 'v2:8200:82',
    })

    await runtime.scanOnce()
    expect(generate).not.toHaveBeenCalled()

    seedMessages([{
      localId: 83,
      sortSeq: 8_300,
      type: 1,
      createTime: 83_000,
      senderRowId: 2,
      content: '开启后的第一条新问题',
    }])
    await runtime.scanOnce()
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'success',
        cursor: 'v2:8300:83',
      })
    })
    expect(listMessageListRecords(decrypted).items[0]?.sourceRef)
      .toBe('ai-reply:wxid_self:wxid_peer:83000:83')
    runtime.dispose()
  })

  it('下游返回成功但台账仍 pending 时转为待核对，禁止自动重发', async () => {
    seedMessages([{
      localId: 1,
      sortSeq: 100,
      type: 1,
      createTime: 1_000,
      senderRowId: 2,
      content: '开启前的消息',
    }])
    const dispatch = vi.fn(async () => ({ ok: true }))
    const runtime = createChatAiReplyRemotes({
      dirs: () => ({ decrypted, decoded: join(root, 'data', 'decoded') }),
      selfUsername: () => 'wxid_self',
      op: () => {},
      gate: (_feature, _stats, texts) => texts,
      generate: async () => ({ ok: true, text: '一条新回复' }),
      dispatch,
      changed: () => {},
    })

    expect(runtime.setEnabled({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    })).toMatchObject({ ok: true })
    seedMessages([{
      localId: 2,
      sortSeq: 200,
      type: 1,
      createTime: 2_000,
      senderRowId: 2,
      content: '新的问题',
    }])

    await runtime.scanOnce()
    await vi.waitFor(() => {
      expect(readChatAiReplyState(decrypted, 'wxid_self', 'wxid_peer')).toMatchObject({
        stage: 'failed',
      })
    })
    const record = listMessageListRecords(decrypted).items[0]
    expect(record).toMatchObject({
      status: 'sent_unconfirmed',
      text: '一条新回复',
    })
    expect(record?.error).toContain('待核对')

    await runtime.scanOnce()
    expect(dispatch).toHaveBeenCalledTimes(1)
    runtime.dispose()
  })
})
