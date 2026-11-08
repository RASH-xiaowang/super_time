// @vitest-environment node
/**
 * 消息列表的规则匹配、记录快照、任务问候与恢复守卫。
 *
 * 请求体和附件投递、台账脱敏、批量重发/删除拆在同目录的行为文件中；本文件保留
 * 规则优先级、入站幂等、任务问候、健康检查、旧库迁移和崩溃恢复覆盖。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withWritableDb } from '../src/query/db-open.ts'
import {
  dispatchCreatedMessageListRecord,
  dispatchMessageListRecord,
  probeMessageListWebhook,
  queryMessageListWebhookJob,
  redactWebhookEndpoint,
  safeWebhookJobId,
} from '../src/query/message-list-dispatch.ts'
import {
  claimMessageListRecordForDispatch,
  getMessageListRecord,
  getMessageListRule,
  ingestMessageListWebhook,
  insertAiReplyMessageListRecord,
  insertMessageListRecord,
  insertTaskTriggerGreeting,
  listMessageListRecords,
  listMessageListRules,
  matchMessageListRule,
  pendingMessageListRecordIds,
  recoverInterruptedMessageListDispatches,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import {
  PNG_DATA_URL,
  cleanupMessageListFixture,
  decrypted,
  dispatchDeps,
  seedEnterpriseContacts,
  setupMessageListFixture,
} from './message-list-spec-fixtures.ts'

beforeEach(setupMessageListFixture)
afterEach(cleanupMessageListFixture)

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

  it('Webhook 入站强制 source=webhook，只保留受控 http(s) 与严格图片 data URL', () => {
    const inserted = ingestMessageListWebhook(decrypted, {
      target: '文件传输助手',
      message: '你好',
      replyId: 'external-reply-7',
      attachments: [
        'https://cdn.example/a.png',
        PNG_DATA_URL,
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
      { dataUrl: PNG_DATA_URL },
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

  it('历史非法附件不会降级为纯文本投递，落 failed 且零出网', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '历史附件对象',
      webhookUrl: 'https://downstream.example/legacy-attachments',
    }).ok).toBe(true)
    let calls = 0
    for (const images of [
      '{not-json',
      '[{"url":"http://127.0.0.1/private.png"}]',
      '[{"localId":0}]',
    ]) {
      const inserted = insertMessageListRecord(decrypted, {
        targetName: '历史附件对象',
        text: '正文仍然存在',
      })
      withWritableDb(taskDbPath(decrypted), (db) => {
        db.prepare('UPDATE message_list_records SET images = ? WHERE id = ?')
          .run(images, inserted.id ?? 0)
      })
      const result = await dispatchMessageListRecord(
        decrypted,
        inserted.id ?? 0,
        dispatchDeps(async () => {
          calls += 1
          return new Response('{"ok":true}', { status: 200 })
        }),
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain('历史附件')
      expect(result.record).toMatchObject({ status: 'failed', attempts: 0 })
    }
    expect(calls).toBe(0)
  })

  it('带 client replyId 的 Webhook 重放只落库并投递一次', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '幂等对象',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const payload = {
      target: '幂等对象',
      message: '只发一次',
      replyId: 'external-idempotent-1',
    }
    const first = ingestMessageListWebhook(decrypted, payload)
    const replay = ingestMessageListWebhook(decrypted, payload)
    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(replay.id).toBe(first.id)
    expect(listMessageListRecords(decrypted).total).toBe(1)

    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('{"ok":true}', { status: 200 })
    }
    await dispatchCreatedMessageListRecord(decrypted, first, dispatchDeps(fetchImpl))
    await dispatchCreatedMessageListRecord(decrypted, replay, dispatchDeps(fetchImpl))
    expect(calls).toBe(1)
  })

  it('没有 replyId 时可用 idempotencyKey 保证 Webhook 重放幂等', () => {
    const payload = {
      target: '幂等对象',
      message: '只落一次',
      idempotencyKey: 'upstream-event-20261029-001',
    }
    const first = ingestMessageListWebhook(decrypted, payload)
    const replay = ingestMessageListWebhook(decrypted, payload)
    expect(first.created).toBe(true)
    expect(replay).toMatchObject({ created: false, id: first.id })
    expect(listMessageListRecords(decrypted).total).toBe(1)
  })

  it('无显式幂等键但提供 triggeredAt 时按内容生成稳定回退键', () => {
    const payload = {
      chatName: '回退键群',
      targetName: '小王',
      message: '网络重试只发一次',
      attachments: ['https://cdn.example/fallback.png'],
      triggeredAt: 1_700_000_123_456,
    }
    const first = ingestMessageListWebhook(decrypted, payload)
    const replay = ingestMessageListWebhook(decrypted, { ...payload })
    expect(first.created).toBe(true)
    expect(first.record?.sourceRef).toMatch(/^webhook-payload:[0-9a-f]{32}$/)
    expect(replay).toMatchObject({ created: false, id: first.id })
    expect(listMessageListRecords(decrypted).total).toBe(1)

    const nextMessage = ingestMessageListWebhook(decrypted, {
      ...payload,
      triggeredAt: payload.triggeredAt + 1,
    })
    expect(nextMessage.created).toBe(true)
    expect(nextMessage.id).not.toBe(first.id)
    expect(listMessageListRecords(decrypted).total).toBe(2)

    const differentAttachment = ingestMessageListWebhook(decrypted, {
      ...payload,
      attachments: ['https://cdn.example/fallback-other.png'],
    })
    expect(differentAttachment.created).toBe(true)
    expect(differentAttachment.id).not.toBe(first.id)
    expect(listMessageListRecords(decrypted).total).toBe(3)
  })

  it('未提供 triggeredAt 的旧 Webhook 调用保持逐条落库', () => {
    const payload = {
      target: '旧调用对象',
      message: '相同正文仍可能是两条正常消息',
    }
    const first = ingestMessageListWebhook(decrypted, payload)
    const second = ingestMessageListWebhook(decrypted, payload)
    expect(first).toMatchObject({ created: true })
    expect(second).toMatchObject({ created: true })
    expect(second.id).not.toBe(first.id)
    expect(first.record?.sourceRef).toBeUndefined()
    expect(second.record?.sourceRef).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(2)
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

    const wang = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(decrypted, db, {
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
    const li = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(decrypted, db, {
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

    const first = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(decrypted, db, {
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
    const second = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(decrypted, db, {
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

    const defaultGreeting = withWritableDb(taskDbPath(decrypted), (db) => insertTaskTriggerGreeting(decrypted, db, {
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

describe('大肥鱼健康检查、任务查询与旧库兼容', () => {
  it('健康检查只用已保存地址 GET，返回地址不含 token', async () => {
    const saved = saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/secret-token?key=query-secret',
    })
    expect(saved.ok).toBe(true)
    let seenUrl = ''
    let seenMethod = ''
    const probe = await probeMessageListWebhook(
      decrypted,
      { ruleId: saved.id },
      {
        fetchImpl: async (url, init) => {
          seenUrl = url
          seenMethod = String(init?.method)
          return new Response(
            '{"ok":true,"service":"feather","version":"1.0","api":1,"webhook":true}',
            { status: 200 },
          )
        },
      },
    )
    expect(probe).toMatchObject({
      ok: true,
      status: 200,
      service: 'feather',
      version: '1.0',
      api: 1,
      webhook: true,
      endpoint: 'http://192.0.2.10:17890/webhook/***',
    })
    expect(seenMethod).toBe('GET')
    expect(seenUrl).not.toContain('***')
    expect(probe.endpoint).not.toContain('secret-token')
    expect(probe.endpoint).not.toContain('query-secret')
  })

  it('健康检查拒绝缺少 Feather 结构的 2xx 响应', async () => {
    const saved = saveMessageListRule(decrypted, {
      targetName: '结构校验对象',
      webhookUrl: 'http://192.0.2.10:17890/webhook/structure-token',
    })
    let calls = 0
    const probe = await probeMessageListWebhook(
      decrypted,
      { ruleId: saved.id },
      {
        fetchImpl: async () => {
          calls += 1
          return new Response(
            '{"ok":true,"service":"feather","version":"1.0","api":1}',
            { status: 200 },
          )
        },
      },
    )
    expect(probe).toMatchObject({ ok: false, status: 200 })
    expect(probe.error).toContain('健康响应结构无效')
    expect(calls).toBe(1)
  })

  it('任务查询拼接 /jobs/<id>、拒绝非法 id，并把状态写回记录', async () => {
    expect(getMessageListRule(decrypted, 1)).toBeUndefined()
    expect(safeWebhookJobId('../escape')).toBe('')
    expect(safeWebhookJobId('job_ok-1')).toBe('job_ok-1')
    expect(redactWebhookEndpoint('not-a-url')).toBe('')

    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '查询任务',
    })
    expect((await queryMessageListWebhookJob(
      decrypted,
      { recordId: inserted.id ?? 0, jobId: '../escape' },
      { fetchImpl: async () => { throw new Error('must not fetch') } },
    )).ok).toBe(false)

    let seenUrl = ''
    let seenMethod = ''
    const job = await queryMessageListWebhookJob(
      decrypted,
      { recordId: inserted.id ?? 0, jobId: 'job_ok-1' },
      {
        fetchImpl: async (url, init) => {
          seenUrl = url
          seenMethod = String(init?.method)
          return new Response(
            '{"ok":true,"id":"job_ok-1","type":"text","state":"done",'
              + '"content_verified":true,"sent_count":1,"mention_newline":false}',
            { status: 200 },
          )
        },
      },
    )
    expect(job).toMatchObject({
      ok: true,
      id: 'job_ok-1',
      type: 'text',
      state: 'done',
      contentVerified: true,
      sentCount: 1,
      mentionNewline: false,
      endpoint: 'http://192.0.2.10:17890/webhook/***',
    })
    expect(seenMethod).toBe('GET')
    expect(seenUrl).toBe('http://192.0.2.10:17890/webhook/token/jobs/job_ok-1')
    const stored = listMessageListRecords(decrypted).items[0]
    expect(stored).toMatchObject({ jobId: 'job_ok-1', jobState: 'done', status: 'success' })
    expect(stored?.jobCheckedAt).toBeGreaterThan(0)
  })

  it('Feather 202 queued 只记为已受理；任务 running/failed 会同步台账且失败可追踪', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '异步任务对象',
      webhookUrl: 'http://192.0.2.10:17890/webhook/token',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '异步任务对象',
      text: '异步投递',
    })
    let getCalls = 0
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'POST') {
        return new Response(
          '{"ok":true,"id":"job_async-1","type":"text","state":"queued"}',
          { status: 202 },
        )
      }
      getCalls += 1
      return new Response(
        getCalls === 1
          ? '{"ok":true,"id":"job_async-1","type":"text","state":"mystery"}'
          : getCalls === 2
            ? '{"ok":true,"id":"job_async-1","type":"text","state":"running"}'
            : '{"ok":true,"id":"job_async-1","type":"text","state":"failed","message":"WeChat window unavailable"}',
        { status: 200 },
      )
    }

    const accepted = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(fetchImpl),
    )
    expect(accepted.ok).toBe(true)
    expect(accepted.record).toMatchObject({
      status: 'queued',
      jobId: 'job_async-1',
      jobState: 'queued',
      attempts: 1,
      error: '',
    })

    const unknown = await queryMessageListWebhookJob(
      decrypted,
      { recordId: inserted.id ?? 0 },
      { fetchImpl },
    )
    expect(unknown).toMatchObject({ ok: true, state: 'mystery' })
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)).toMatchObject({
      status: 'queued',
      jobState: 'mystery',
      attempts: 1,
    })

    const running = await queryMessageListWebhookJob(
      decrypted,
      { recordId: inserted.id ?? 0 },
      { fetchImpl },
    )
    expect(running).toMatchObject({ ok: true, state: 'running' })
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)).toMatchObject({
      status: 'running',
      jobState: 'running',
      attempts: 1,
    })

    const failed = await queryMessageListWebhookJob(
      decrypted,
      { recordId: inserted.id ?? 0 },
      { fetchImpl },
    )
    expect(failed).toMatchObject({ ok: true, state: 'failed' })
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)).toMatchObject({
      status: 'failed',
      jobState: 'failed',
      attempts: 1,
    })
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)?.error)
      .toContain('WeChat window unavailable')
  })

  it('任务查询只允许 tokenized /webhook/<token> 地址', async () => {
    let calls = 0
    for (const [targetName, webhookUrl] of [
      ['send-text 查询对象', 'http://192.0.2.10:17890/send/text'],
      ['非 tokenized 查询对象', 'http://192.0.2.10:17890/webhook/token/jobs'],
    ] as const) {
      expect(saveMessageListRule(decrypted, { targetName, webhookUrl }).ok).toBe(true)
      const inserted = insertMessageListRecord(decrypted, {
        targetName,
        text: '不应查询',
      })
      const result = await queryMessageListWebhookJob(
        decrypted,
        { recordId: inserted.id ?? 0, jobId: 'job_ok-1' },
        {
          fetchImpl: async () => {
            calls += 1
            return new Response('{"ok":true,"state":"done"}', { status: 200 })
          },
        },
      )
      expect(result).toMatchObject({ ok: false })
      expect(result.error).toContain('/webhook/<token>')
    }
    expect(calls).toBe(0)
  })

  it('附件资源端点不能被保存为发送规则', () => {
    const result = saveMessageListRule(decrypted, {
      targetName: '资源端点对象',
      webhookUrl: 'http://192.0.2.10:17890/webhook/token/resources',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('/resources')
    expect(listMessageListRules(decrypted).total).toBe(0)
  })

  it('旧记录的快照若指向资源端点，投递前失败且零出网', async () => {
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '旧资源快照',
      text: '不应发送',
    })
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare('UPDATE message_list_records SET webhook_url = ? WHERE id = ?')
        .run('http://192.0.2.10:17890/webhook/token/resources', inserted.id ?? 0)
    })
    let calls = 0

    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.error).toContain('/resources')
    expect(calls).toBe(0)
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)).toMatchObject({
      status: 'failed',
      attempts: 0,
    })
  })

  it('旧库缺 job_id / job_state / job_checked_at 时自动补列', () => {
    const file = taskDbPath(decrypted)
    mkdirSync(join(file, '..'), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE message_list_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reply_id TEXT NOT NULL,
      chat_name TEXT NOT NULL DEFAULT '',
      target_name TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      triggered_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      chat_username TEXT NOT NULL DEFAULT '',
      target_username TEXT NOT NULL DEFAULT '',
      webhook_url TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      response_summary TEXT NOT NULL DEFAULT '',
      task_id INTEGER,
      trigger_id INTEGER,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    db.close()
    expect(saveMessageListRule(decrypted, {
      targetName: '旧库对象',
      webhookUrl: 'https://downstream.example/legacy',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '旧库对象',
      text: '旧库写入',
    })
    expect(inserted.ok).toBe(true)
    const columns = withWritableDb(file, (opened) => (
      opened.prepare('PRAGMA table_info(message_list_records)').all() as Array<{ name?: string }>
    ).map((row) => row.name))
    expect(columns).toEqual(expect.arrayContaining(['job_id', 'job_state', 'job_checked_at']))
  })

  it('原子认领只允许 pending -> dispatching，第二次认领失败', () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '认领对象',
      webhookUrl: 'https://downstream.example/claim',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '认领对象',
      text: '只认领一次',
    })
    expect(claimMessageListRecordForDispatch(decrypted, inserted.id ?? 0)?.status).toBe('dispatching')
    expect(claimMessageListRecordForDispatch(decrypted, inserted.id ?? 0)).toBeUndefined()
    expect(listMessageListRecords(decrypted).items[0]?.status).toBe('dispatching')
  })

  it('启动恢复把遗留 dispatching 转为 sent_unconfirmed，并允许人工单条重发', () => {
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '中断恢复对象',
      text: '请人工核对',
    })
    const id = inserted.id ?? 0
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare("UPDATE message_list_records SET status = 'dispatching', updated_at = ? WHERE id = ?")
        .run(Date.now() - 6 * 60_000, id)
    })

    expect(recoverInterruptedMessageListDispatches(decrypted)).toBe(1)
    expect(getMessageListRecord(decrypted, id)).toMatchObject({
      status: 'sent_unconfirmed',
    })
    expect(getMessageListRecord(decrypted, id)?.error).toContain('进程在投递期间中断')
    expect(pendingMessageListRecordIds(decrypted, 10), '恢复后不能进入自动批次').toEqual([])
    expect(
      claimMessageListRecordForDispatch(decrypted, id, '', 'automatic'),
      '启动恢复后的待核对记录不能被自动路径认领',
    ).toBeUndefined()
    expect(getMessageListRecord(decrypted, id)?.status).toBe('sent_unconfirmed')
    expect(
      claimMessageListRecordForDispatch(decrypted, id, '', 'manual_single')?.status,
      '只有人工单条重发可以认领 sent_unconfirmed',
    ).toBe('dispatching')
  })

  it('启动恢复不会回收仍在投递超时窗口内的 dispatching', () => {
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '活跃投递对象',
      text: '另一个进程正在发送',
    })
    const id = inserted.id ?? 0
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare("UPDATE message_list_records SET status = 'dispatching', updated_at = ? WHERE id = ?")
        .run(Date.now(), id)
    })

    expect(recoverInterruptedMessageListDispatches(decrypted)).toBe(0)
    expect(getMessageListRecord(decrypted, id)?.status).toBe('dispatching')
  })

  it('人工单条成功后，自动投递不能再次认领或出网', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '成功防重对象',
      webhookUrl: 'https://downstream.example/only-once',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '成功防重对象',
      text: '只允许成功一次',
    })
    const id = inserted.id ?? 0
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response('{"ok":true}', { status: 200 })
    }

    const manual = await dispatchMessageListRecord(
      decrypted,
      id,
      dispatchDeps(fetchImpl),
      'manual_single',
    )
    expect(manual.ok).toBe(true)
    expect(manual.record?.status).toBe('success')
    expect(calls).toBe(1)

    const automatic = await dispatchMessageListRecord(decrypted, id, dispatchDeps(fetchImpl))
    expect(automatic.ok).toBe(false)
    expect(automatic.error).toContain('自动投递只允许 pending')
    expect(automatic.record?.status).toBe('success')
    expect(calls).toBe(1)
  })
})
