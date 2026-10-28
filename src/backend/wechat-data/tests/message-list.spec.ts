// @vitest-environment node
/**
 * 消息列表的持久化、规则匹配与下游投递守卫。
 *
 * 这组用例只走合成 SQLite / 假 fetch，不联网，重点钉住四个容易「看起来正常」的边界：
 *  ① 规则优先级必须是 精确 > 同会话通配 > 全局；
 *  ② 记录落库时保存地址快照，改规则不能悄悄改道重发；
 *  ③ 无规则仍落库为 pending，下游失败落库为 failed，且一次显式重发只发一次；
 *  ④ 任务问候的 sourceRef 幂等，重复扫描不会多插一条。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withWritableDb } from '../src/query/db-open.ts'
import {
  dispatchMessageListRecord,
  dispatchPendingMessageListRecords,
} from '../src/query/message-list-dispatch.ts'
import type { MessageListDispatchDeps } from '../src/query/message-list-dispatch.ts'
import {
  ingestMessageListWebhook,
  insertMessageListRecord,
  insertTaskTriggerGreeting,
  listMessageListRecords,
  listMessageListRules,
  matchMessageListRule,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import { taskDbPath } from '../src/query/task-db.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'message-list-'))
  decrypted = join(root, 'data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function dispatchDeps(
  fetchImpl: MessageListDispatchDeps['fetchImpl'],
  gate: MessageListDispatchDeps['gate'] = (_feature, _stats, texts) => texts,
): MessageListDispatchDeps {
  return {
    decodeImage: async () => ({ url: 'data:image/png;base64,AAAA' }),
    gate,
    fetchImpl,
  }
}

/** Build `contact.extra_buffer` with protobuf field 2 = enterprise wording id. */
function enterpriseBuffer(wordingId: string): Buffer {
  const value = Buffer.from(wordingId, 'utf8')
  return Buffer.concat([Buffer.from([0x12, value.length]), value])
}

function seedEnterpriseContacts(rows: ReadonlyArray<[username: string, name: string]>): void {
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  const db = new DatabaseSync(join(decrypted, 'contact', 'contact.db'))
  db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
  db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
  db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-ent', '示例企业')
  const ins = db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)')
  for (const [username, name] of rows) {
    ins.run(username, name, '', enterpriseBuffer('wording-ent'))
  }
  db.close()
}

describe('规则匹配与记录快照', () => {
  it('精确会话+对象 > 同会话任意对象 > 任意会话指定对象 > 全局；记录保存命中地址快照', () => {
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'https://hooks.example/global',
      greetingText: '全局问候',
    }).ok).toBe(true)
    expect(saveMessageListRule(decrypted, {
      chatName: '客户群 A',
      webhookUrl: 'https://hooks.example/chat',
      greetingText: '会话问候',
    }).ok).toBe(true)
    expect(saveMessageListRule(decrypted, {
      chatName: '客户群 A',
      targetName: '张三',
      webhookUrl: 'https://hooks.example/exact',
      greetingText: '精确问候',
    }).ok).toBe(true)

    expect(saveMessageListRule(decrypted, {
      targetName: '李四',
      webhookUrl: 'https://hooks.example/target-any-chat',
    }).ok).toBe(true)

    expect(matchMessageListRule(decrypted, '客户群 A', '张三')?.webhookUrl)
      .toBe('https://hooks.example/exact')
    expect(matchMessageListRule(decrypted, '客户群 A', '王五')?.webhookUrl)
      .toBe('https://hooks.example/chat')
    expect(matchMessageListRule(decrypted, '客户群 A', '李四')?.webhookUrl)
      .toBe('https://hooks.example/chat')
    expect(matchMessageListRule(decrypted, '其他会话', '李四')?.webhookUrl)
      .toBe('https://hooks.example/target-any-chat')
    expect(matchMessageListRule(decrypted, '其他会话', '王五')?.webhookUrl)
      .toBe('https://hooks.example/global')

    const inserted = insertMessageListRecord(decrypted, {
      chatName: '客户群 A',
      targetName: '张三',
      text: '报价如下',
    })
    expect(inserted.ok).toBe(true)
    expect(inserted.record).toMatchObject({
      source: 'manual',
      status: 'pending',
      webhookUrl: 'https://hooks.example/exact',
    })
    expect(inserted.record?.replyId).toMatch(/^ml-/)

    const exact = listMessageListRules(decrypted).items.find((rule) => rule.targetName === '张三')
    expect(exact).toBeDefined()
    expect(saveMessageListRule(decrypted, {
      id: exact?.id,
      chatName: '客户群 A',
      targetName: '张三',
      webhookUrl: 'https://hooks.example/exact-v2',
      greetingText: '精确问候',
    }).ok).toBe(true)
    // 已落库记录保留原快照；新记录才使用更新后的规则。
    expect(listMessageListRecords(decrypted).items[0]?.webhookUrl)
      .toBe('https://hooks.example/exact')
    const next = insertMessageListRecord(decrypted, {
      chatName: '客户群 A',
      targetName: '张三',
      text: '第二次报价',
    })
    expect(next.record?.webhookUrl).toBe('https://hooks.example/exact-v2')
  })

  it('Webhook 入站强制 source=webhook，只保留 http(s)/安全 data URL/微信本地图片引用', () => {
    const inserted = ingestMessageListWebhook(decrypted, {
      target: '文件传输助手',
      message: '你好',
      replyId: 'external-reply-7',
      attachments: [
        'https://cdn.example/a.png',
        'data:image/png;base64,AAAA',
        'file:///C:/secret.txt',
        'C:\\secret.png',
        { localId: 12, createTime: 100, md5: 'abcd' },
      ],
    })
    expect(inserted.ok).toBe(true)
    expect(inserted.record).toMatchObject({
      replyId: 'external-reply-7',
      targetName: '文件传输助手',
      text: '你好',
      source: 'webhook',
      status: 'pending',
    })
    expect(inserted.record?.images).toEqual([
      { url: 'https://cdn.example/a.png' },
      { dataUrl: 'data:image/png;base64,AAAA' },
      { localId: 12, createTime: 100, sender: '', md5: 'abcd' },
    ])
    expect(ingestMessageListWebhook(decrypted, {
      target: '',
      message: '你好',
    }).ok).toBe(false)

    const groupAlias = ingestMessageListWebhook(decrypted, {
      chat: '智能回复机器人·ai-1群',
      target: 'Y.M',
      message: '憨憨，晚安',
    })
    expect(groupAlias.record).toMatchObject({
      chatName: '智能回复机器人·ai-1群',
      targetName: 'Y.M',
      text: '憨憨，晚安',
    })

    // 兼容轻羽原生参数：target 是群名，mention 是群内要 @ 的成员。
    const qingyuShape = ingestMessageListWebhook(decrypted, {
      target: '智能回复机器人·ai-1群',
      mention: 'Y.M',
      message: '憨憨，晚安',
    })
    expect(qingyuShape.record).toMatchObject({
      chatName: '智能回复机器人·ai-1群',
      targetName: 'Y.M',
      text: '憨憨，晚安',
    })
  })

  it('消息记录的会话与触发对象在写入和投递返回中都带企微企业名', async () => {
    seedEnterpriseContacts([
      ['wxid_chat@openim', '客户群'],
      ['wxid_target@openim', '小王'],
    ])
    expect(saveMessageListRule(decrypted, {
      chatName: '客户群',
      targetName: '小王',
      webhookUrl: 'https://downstream.example/enterprise',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      chatName: '客户群',
      targetName: '小王',
      chatUsername: 'wxid_chat@openim',
      targetUsername: 'wxid_target@openim',
      text: '企业消息',
    })
    expect(inserted.record).toMatchObject({
      chatEnterpriseName: '示例企业',
      targetEnterpriseName: '示例企业',
    })
    expect(listMessageListRecords(decrypted).items[0]).toMatchObject({
      chatEnterpriseName: '示例企业',
      targetEnterpriseName: '示例企业',
    })

    const dispatched = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => new Response('{"ok":true}', { status: 200 })),
    )
    expect(dispatched.record).toMatchObject({
      status: 'success',
      chatEnterpriseName: '示例企业',
      targetEnterpriseName: '示例企业',
    })
  })
})

describe('下游投递', () => {
  it('成功投递只发一次，隐私闸生效，下游回复 id 回写', async () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '客户会话',
      targetName: '',
      webhookUrl: 'https://downstream.example/reply',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      chatName: '客户会话',
      targetName: '文件传输助手',
      text: '包含 秘密 的回复',
      images: [{ url: 'https://cdn.example/a.png' }],
    })
    expect(inserted.id).toBeGreaterThan(0)

    const calls: Array<{ url: string; init?: RequestInit }> = []
    const gateCalls: string[] = []
    const result = await dispatchMessageListRecord(decrypted, inserted.id ?? 0, dispatchDeps(
      async (url, init) => {
        calls.push({ url, init })
        return new Response('{"data":{"replyId":"down-42"}}', { status: 200 })
      },
      (feature, stats, texts) => {
        gateCalls.push(feature)
        expect(stats).toEqual({ sessions: 1, messages: 1 })
        return texts.map((text) => text.replace('秘密', '***'))
      },
    ))

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://downstream.example/reply')
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      target: '客户会话',
      mention: '文件传输助手',
      message: '包含 *** 的回复',
      attachments: ['https://cdn.example/a.png'],
      recordId: inserted.id,
    })
    expect(result.record).toMatchObject({
      status: 'success',
      attempts: 1,
      replyId: 'down-42',
      error: '',
    })
    expect(result.record?.responseSummary).toContain('HTTP 200')
    expect(gateCalls).toEqual(['task_callback'])
  })

  it('私聊不发送 mention，target 直接使用触发对象', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '文件传输助手',
      webhookUrl: 'https://downstream.example/private',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '文件传输助手',
      text: '私聊消息',
    })
    let body: Record<string, unknown> = {}
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    expect(result.ok).toBe(true)
    expect(body.target).toBe('文件传输助手')
    expect(body.mention).toBeUndefined()
  })

  it('无规则记录保持 pending；有规则但下游 500 只尝试一次并落库 failed', async () => {
    const noRule = insertMessageListRecord(decrypted, {
      targetName: '没有规则的助手',
      text: '你好',
    })
    let calls = 0
    const noRuleResult = await dispatchMessageListRecord(
      decrypted,
      noRule.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response('should-not-run', { status: 200 })
      }),
    )
    expect(noRuleResult.ok).toBe(false)
    expect(noRuleResult.record).toMatchObject({
      status: 'pending',
      webhookUrl: '',
      attempts: 0,
    })
    expect(noRuleResult.record?.lastAttemptAt).toBeUndefined()
    expect(noRuleResult.error).toContain('未匹配到 Webhook')
    expect(calls).toBe(0)

    expect(saveMessageListRule(decrypted, {
      chatName: '',
      targetName: '失败助手',
      webhookUrl: 'https://downstream.example/fail',
    }).ok).toBe(true)
    const failing = insertMessageListRecord(decrypted, {
      targetName: '失败助手',
      text: '请回复',
    })
    const failedResult = await dispatchMessageListRecord(
      decrypted,
      failing.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response('upstream failed', { status: 500 })
      }),
    )
    expect(failedResult.ok).toBe(false)
    expect(calls, '显式重发/首次投递都不能自动重试成两条微信消息').toBe(1)
    expect(failedResult.record).toMatchObject({
      status: 'failed',
      attempts: 1,
    })
    expect(failedResult.error).toContain('HTTP 500')
  })

  it('重发优先使用记录里的旧地址快照；批量只取有地址的 pending', async () => {
    const saved = saveMessageListRule(decrypted, {
      chatName: '快照会话',
      webhookUrl: 'https://downstream.example/old',
    })
    const inserted = insertMessageListRecord(decrypted, {
      chatName: '快照会话',
      targetName: '对象 A',
      text: '保持原路',
    })
    expect(saveMessageListRule(decrypted, {
      id: saved.id,
      chatName: '快照会话',
      webhookUrl: 'https://downstream.example/new',
    }).ok).toBe(true)

    const urls: string[] = []
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async (url) => {
        urls.push(url)
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(result.ok).toBe(true)
    expect(urls).toEqual(['https://downstream.example/old'])

    const pending = insertMessageListRecord(decrypted, {
      chatName: '尚无规则',
      targetName: '待执行对象',
      text: '等待配置',
    })
    expect(pending.record?.webhookUrl).toBe('')
    const batch = await dispatchPendingMessageListRecords(decrypted, dispatchDeps(
      async () => new Response('{"ok":true}', { status: 200 }),
    ))
    expect(batch).toEqual({ dispatched: 0, failed: 0 })
  })
})

describe('任务触发问候', () => {
  it('同一会话的不同触发对象可分别使用不同的首次触发文本', () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '项目群',
      targetName: '小王',
      webhookUrl: 'https://downstream.example/wang',
      greetingText: '小王你好，已收到',
    }).ok).toBe(true)
    expect(saveMessageListRule(decrypted, {
      chatName: '项目群',
      targetName: '小李',
      webhookUrl: 'https://downstream.example/li',
      greetingText: '小李你好，资料已收到',
    }).ok).toBe(true)

    const wang = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(db, {
      taskId: 11,
      triggerId: 81,
      taskName: '项目跟进',
      chatName: '项目群',
      chatUsername: 'room@chatroom',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      images: [],
      triggeredAt: 1_700_000_000_200,
    }))
    const li = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(db, {
      taskId: 12,
      triggerId: 82,
      taskName: '项目跟进',
      chatName: '项目群',
      chatUsername: 'room@chatroom',
      targetName: '小李',
      targetUsername: 'wxid_li',
      images: [],
      triggeredAt: 1_700_000_000_300,
    }))

    expect(wang.record).toMatchObject({
      targetName: '小王',
      text: '小王你好，已收到',
      webhookUrl: 'https://downstream.example/wang',
    })
    expect(li.record).toMatchObject({
      targetName: '小李',
      text: '小李你好，资料已收到',
      webhookUrl: 'https://downstream.example/li',
    })
  })

  it('按会话+对象选问候文本，并用 task-trigger:<id> 保证幂等', () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '项目群',
      targetName: '小王',
      webhookUrl: 'https://downstream.example/project',
      greetingText: '小王你好，已收到',
    }).ok).toBe(true)

    const first = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(db, {
      taskId: 9,
      triggerId: 77,
      taskName: '项目报价',
      chatName: '项目群',
      chatUsername: 'room@chatroom',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      images: [],
      triggeredAt: 1_700_000_000_000,
    }))
    const second = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(db, {
      taskId: 9,
      triggerId: 77,
      taskName: '项目报价',
      chatName: '项目群',
      chatUsername: 'room@chatroom',
      targetName: '小王',
      targetUsername: 'wxid_wang',
      images: [],
      triggeredAt: 1_700_000_000_000,
    }))

    expect(first.ok).toBe(true)
    expect(second.id).toBe(first.id)
    expect(listMessageListRecords(decrypted)).toMatchObject({
      total: 1,
      items: [{
        text: '小王你好，已收到',
        source: 'first_trigger',
        taskId: 9,
        triggerId: 77,
        sourceRef: 'task-trigger:77',
      }],
    })

    const defaultGreeting = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(db, {
      taskId: 10,
      triggerId: 78,
      taskName: '无规则任务',
      chatName: '其他会话',
      chatUsername: 'wxid_other',
      targetName: '其他对象',
      targetUsername: '',
      images: [],
      triggeredAt: 1_700_000_000_100,
    }))
    expect(defaultGreeting.record?.text).toBe('你好')
  })
})
