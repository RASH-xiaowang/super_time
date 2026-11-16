// @vitest-environment node
/**
 * 消息列表下游投递的台账脱敏、隐私闸、批量重发和批量删除。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withWritableDb } from '../src/query/db-open.ts'
import {
  batchResendMessageListRecords,
  dispatchMessageListRecord,
  dispatchPendingMessageListRecords,
} from '../src/query/message-list-dispatch.ts'
import {
  deleteMessageListRecords,
  getMessageListRecord,
  insertMessageListRecord,
  listMessageListRecords,
  saveMessageListRule,
} from '../src/query/message-list-store.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import {
  cleanupMessageListFixture,
  decrypted,
  dispatchDeps,
  setupMessageListFixture,
} from './message-list-spec-fixtures.ts'

beforeEach(setupMessageListFixture)
afterEach(cleanupMessageListFixture)

describe('下游投递：台账、批量与删除', () => {
  it('历史台账记录即使匹配全局 Webhook，也拒绝通用单条与批量投递', async () => {
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'https://downstream.example/global-must-not-run',
    }).ok).toBe(true)
    const legacyRef = 'clawbot:legacy:manual-client-isolation-1'
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '历史台账对象',
      text: '历史台账正文',
      note: '仅验证旧来源标记的 fail-closed 行为',
    })
    expect(inserted.ok).toBe(true)
    expect(inserted.id).toBeGreaterThan(0)
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare(`UPDATE message_list_records
        SET source_ref = ?, status = 'failed', error = ? WHERE id = ?`)
        .run(legacyRef, '历史台账已停用', inserted.id ?? 0)
    })
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)).toMatchObject({
      status: 'failed',
      sourceRef: legacyRef,
    })

    let calls = 0
    const deps = dispatchDeps(async () => {
      calls += 1
      return new Response('{"ok":true}', { status: 200 })
    })
    const single = await dispatchMessageListRecord(decrypted, inserted.id ?? 0, deps)
    expect(single).toMatchObject({
      ok: false,
      record: { status: 'failed' },
    })
    expect(single.error).toContain('禁止进入通用 Webhook 投递')

    const batch = await batchResendMessageListRecords(decrypted, [inserted.id ?? 0], deps)
    expect(batch).toMatchObject({
      ok: true,
      requested: 1,
      succeeded: 0,
      failed: 0,
      skipped: 1,
      items: [{
        id: inserted.id,
        status: 'skipped',
      }],
    })
    expect(batch.items[0]?.error).toContain('禁止进入批量 Webhook 重发')
    expect(calls).toBe(0)
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)?.status).toBe('failed')
  })

  it('下游错误回显完整 Webhook 地址时，台账不保存路径令牌', async () => {
    const token = 'private-token-that-must-not-leak'
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/' + token,
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '会失败',
    })
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => {
        throw new Error('connect failed: http://192.0.2.10:17890/webhook/' + token)
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(token)
    expect(result.record?.error).not.toContain(token)
  })

  it('下游响应体单独回显令牌时也会脱敏', async () => {
    const token = 'body-token-that-must-not-leak'
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/webhook/' + token,
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '会失败',
    })
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => new Response('invalid token: ' + token, { status: 401 })),
    )
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(token)
    expect(result.record?.error).not.toContain(token)
    expect(result.record?.responseSummary).not.toContain(token)
  })

  it('脱敏不会误伤 /send/text 路径中的普通单词', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '小王',
      webhookUrl: 'http://192.0.2.10:17890/send/text',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '会失败',
    })
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => new Response('send/text failed: text', { status: 500 })),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('send/text failed: text')
    expect(result.record?.error).toContain('send/text failed: text')
    expect(result.record?.responseSummary).toContain('send/text failed: text')
  })

  it('成功投递只发一次，隐私闸生效，普通下游 id 不污染任务字段', async () => {
    expect(saveMessageListRule(decrypted, {
      chatName: '客户会话',
      targetName: '',
      webhookUrl: 'https://downstream.example/reply',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      chatName: '客户会话',
      targetName: '文件传输助手',
      chatUsername: 'room@chatroom',
      text: '包含 秘密 的回复',
      images: [{ url: 'https://cdn.example/a.png' }],
    })
    expect(inserted.id).toBeGreaterThan(0)

    const calls: Array<{ url: string; init?: RequestInit }> = []
    const gateCalls: string[] = []
    const result = await dispatchMessageListRecord(decrypted, inserted.id ?? 0, dispatchDeps(
      async (url, init) => {
        calls.push({ url, init })
        return new Response('{"data":{"id":"down-42"}}', { status: 200 })
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
      jobState: 'submitted',
      error: '',
    })
    expect(result.record?.jobId).toBeUndefined()
    expect(result.record?.responseSummary).toContain('HTTP 200')
    expect(gateCalls).toEqual(['task_callback'])
  })

  it('隐私闸抛错时记录落到 failed，而不是永久停在 dispatching', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '闸门对象',
      webhookUrl: 'https://downstream.example/reply',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '闸门对象',
      text: '不能静默卡住',
    })
    let calls = 0
    const result = await dispatchMessageListRecord(decrypted, inserted.id ?? 0, dispatchDeps(
      async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      },
      () => { throw new Error('隐私设置读取失败') },
    ))
    expect(result.ok).toBe(false)
    expect(result.record).toMatchObject({ status: 'failed', attempts: 0 })
    expect(result.record?.error).toContain('隐私设置读取失败')
    expect(calls).toBe(0)
  })

  it.each([
    ['超时', Object.assign(new Error('请求超时'), { name: 'TimeoutError' })],
    ['断连', new Error('socket hang up')],
  ])('请求已发起后%s只记 sent_unconfirmed，自动与批量都不重发', async (_name, failure) => {
    expect(saveMessageListRule(decrypted, {
      targetName: '未确认对象',
      webhookUrl: 'https://downstream.example/unconfirmed',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '未确认对象',
      text: '只能发一次',
    })
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      throw failure
    }
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(fetchImpl),
    )
    expect(result.ok).toBe(false)
    expect(result.record).toMatchObject({
      status: 'sent_unconfirmed',
      attempts: 1,
    })
    expect(result.error).toContain('可能已发出')
    expect(calls).toBe(1)

    const automatic = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(fetchImpl),
    )
    expect(automatic.ok).toBe(false)
    const batch = await batchResendMessageListRecords(
      decrypted,
      [inserted.id ?? 0],
      dispatchDeps(fetchImpl),
    )
    expect(batch.items).toEqual([{
      id: inserted.id,
      status: 'skipped',
      error: '记录已发出但结果未确认，禁止自动重复发送',
    }])
    expect(calls).toBe(1)
  })

  it('普通下游的 data.id 不会被误当成 Feather 异步 job id', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '文件传输助手',
      webhookUrl: 'https://downstream.example/reply',
    }).ok).toBe(true)
    const inserted = insertMessageListRecord(decrypted, {
      targetName: '文件传输助手',
      text: '普通下游',
    })
    const result = await dispatchMessageListRecord(
      decrypted,
      inserted.id ?? 0,
      dispatchDeps(async () => new Response(
        '{"ok":true,"data":{"id":"ordinary-id","replyId":"reply-9"}}',
        { status: 200 },
      )),
    )
    expect(result.ok).toBe(true)
    expect(result.record?.jobId).toBeUndefined()
    expect(result.record?.replyId).toBe('reply-9')
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
    // 夹具覆盖了「chatName 被归一化为占位名」的路径：投递目标仍须回落到触发对象。
    expect(getMessageListRecord(decrypted, inserted.id ?? 0)?.chatName).toBe('未命名会话')
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
    expect(failedResult.record?.status).toBe('failed')
    expect(failedResult.record?.attempts).toBe(1)
    expect(failedResult.error).toContain('HTTP 500')
  })

  it('批量重发按 id 去重、顺序处理，并允许 failed 记录再次重试', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '批量对象',
      webhookUrl: 'https://downstream.example/batch',
    }).ok).toBe(true)
    const first = insertMessageListRecord(decrypted, {
      targetName: '批量对象',
      text: '第一条',
    })
    const second = insertMessageListRecord(decrypted, {
      targetName: '批量对象',
      text: '第二条',
    })
    const order: number[] = []
    let firstAttempts = 0
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { recordId?: number }
      order.push(Number(body.recordId))
      if (body.recordId === first.id && firstAttempts++ === 0) {
        return new Response('first failed', { status: 503 })
      }
      return new Response('{"ok":true}', { status: 200 })
    }

    const batch = await batchResendMessageListRecords(
      decrypted,
      [first.id ?? 0, first.id ?? 0, second.id ?? 0],
      dispatchDeps(fetchImpl),
    )
    expect(batch).toMatchObject({
      ok: true,
      requested: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
    })
    expect(order).toEqual([first.id, second.id])
    expect(batch.items).toEqual([
      { id: first.id, status: 'failed', error: 'HTTP 503：first failed' },
      { id: second.id, status: 'success' },
    ])

    const retry = await batchResendMessageListRecords(
      decrypted,
      [first.id ?? 0],
      dispatchDeps(fetchImpl),
    )
    expect(retry).toMatchObject({ ok: true, requested: 1, succeeded: 1, failed: 0, skipped: 0 })
  })

  it('批量重发跳过不存在、未确认和空内容记录', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '跳过对象',
      webhookUrl: 'https://downstream.example/skip',
    }).ok).toBe(true)
    const unconfirmed = insertMessageListRecord(decrypted, {
      targetName: '跳过对象',
      text: '已发出但未确认',
    })
    const empty = insertMessageListRecord(decrypted, {
      targetName: '跳过对象',
      text: '稍后清空',
    })
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare(`UPDATE message_list_records SET status = 'sent_unconfirmed' WHERE id = ?`)
        .run(unconfirmed.id ?? 0)
      db.prepare(`UPDATE message_list_records SET text = '', images = '[]' WHERE id = ?`)
        .run(empty.id ?? 0)
    })
    let calls = 0
    const batch = await batchResendMessageListRecords(
      decrypted,
      [unconfirmed.id ?? 0, empty.id ?? 0, 999_999],
      dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(calls).toBe(0)
    expect(batch).toMatchObject({ ok: true, requested: 3, succeeded: 0, failed: 0, skipped: 3 })
    expect(batch.items.map((item) => item.error)).toEqual([
      '记录已发出但结果未确认，禁止自动重复发送',
      '正文和附件均为空，无法重发',
      '消息记录不存在',
    ])
  })

  it('批量重发单次最多处理 100 条记录', async () => {
    const result = await batchResendMessageListRecords(
      decrypted,
      Array.from({ length: 101 }, (_value, index) => index + 1),
      dispatchDeps(async () => new Response('{"ok":true}', { status: 200 })),
    )
    expect(result).toMatchObject({
      ok: false,
      requested: 101,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    })
    expect(result.error).toContain('最多批量重发 100 条')
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

  it('历史 clawbot 地址快照永远不占自动批次，普通 pending 仍按时间优先处理', async () => {
    expect(saveMessageListRule(decrypted, {
      webhookUrl: 'https://downstream.example/pending-queue',
    }).ok).toBe(true)
    const legacy = insertMessageListRecord(decrypted, {
      targetName: '历史 ClawBot 对象',
      text: '旧台账正文',
    })
    const current = insertMessageListRecord(decrypted, {
      targetName: '普通后台回复',
      text: '新台账正文',
    })
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare(`UPDATE message_list_records
        SET source_ref = ?, status = 'pending', webhook_url = ?,
            triggered_at = ? WHERE id = ?`)
        .run(
          'clawbot:legacy:pending-must-not-starve-queue',
          'https://downstream.example/legacy-must-not-run',
          1,
          legacy.id ?? 0,
        )
    })

    const calls: number[] = []
    const result = await dispatchPendingMessageListRecords(
      decrypted,
      dispatchDeps(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { recordId?: number }
        calls.push(Number(body.recordId))
        return new Response('{"ok":true}', { status: 200 })
      }),
      1,
    )
    expect(result).toEqual({ dispatched: 1, failed: 0 })
    expect(calls).toEqual([current.id])
    expect(getMessageListRecord(decrypted, legacy.id ?? 0)).toMatchObject({
      status: 'pending',
      sourceRef: 'clawbot:legacy:pending-must-not-starve-queue',
    })
  })

  it('批量删除去重并跳过不存在或投递中的记录', () => {
    const removable = insertMessageListRecord(decrypted, {
      targetName: '删除对象 A',
      text: '删除我',
    })
    const dispatching = insertMessageListRecord(decrypted, {
      targetName: '删除对象 B',
      text: '投递中',
    })
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare("UPDATE message_list_records SET status = 'dispatching' WHERE id = ?")
        .run(dispatching.id ?? 0)
    })

    const result = deleteMessageListRecords(decrypted, [
      removable.id ?? 0,
      removable.id ?? 0,
      dispatching.id ?? 0,
      999_999,
    ])
    expect(result).toMatchObject({
      ok: true,
      requested: 3,
      removed: 1,
      skipped: 2,
    })
    expect(result.items).toEqual([
      { id: removable.id, status: 'removed' },
      { id: dispatching.id, status: 'skipped', error: '记录正在投递，不能删除' },
      { id: 999_999, status: 'skipped', error: '消息记录不存在' },
    ])
    const remaining = listMessageListRecords(decrypted)
    expect(remaining.items.map((item) => item.id)).toEqual([dispatching.id])
  })

  it('下游 queued/running 记录禁止批次重发与删除，避免丢任务或重复外发', async () => {
    expect(saveMessageListRule(decrypted, {
      targetName: '异步对象',
      webhookUrl: 'https://downstream.example/async',
    }).ok).toBe(true)
    const queued = insertMessageListRecord(decrypted, {
      targetName: '异步对象',
      text: '排队中',
    })
    const running = insertMessageListRecord(decrypted, {
      targetName: '异步对象',
      text: '执行中',
    })
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare("UPDATE message_list_records SET status = 'queued', job_id = 'job-queued' WHERE id = ?")
        .run(queued.id ?? 0)
      db.prepare("UPDATE message_list_records SET status = 'running', job_id = 'job-running' WHERE id = ?")
        .run(running.id ?? 0)
    })
    let calls = 0
    const resend = await batchResendMessageListRecords(
      decrypted,
      [queued.id ?? 0, running.id ?? 0],
      dispatchDeps(async () => {
        calls += 1
        return new Response('{"ok":true}', { status: 200 })
      }),
    )
    expect(calls).toBe(0)
    expect(resend.items.map((item) => item.error)).toEqual([
      '下游异步任务尚未结束，禁止重复发送',
      '下游异步任务尚未结束，禁止重复发送',
    ])

    const removed = deleteMessageListRecords(decrypted, [queued.id ?? 0, running.id ?? 0])
    expect(removed).toMatchObject({ removed: 0, skipped: 2 })
    expect(removed.items.map((item) => item.error)).toEqual([
      '下游异步任务尚未结束，不能删除',
      '下游异步任务尚未结束，不能删除',
    ])
  })

  it('通用批量删除跳过 AI 回复记录，避免删掉生成中的预约或已付费正文', () => {
    const aiRecord = insertMessageListRecord(decrypted, {
      targetName: 'AI 对象',
      text: 'AI 生成的正文',
    })
    withWritableDb(taskDbPath(decrypted), (db) => {
      db.prepare("UPDATE message_list_records SET source = 'ai_reply' WHERE id = ?")
        .run(aiRecord.id ?? 0)
    })

    const result = deleteMessageListRecords(decrypted, [aiRecord.id ?? 0])
    expect(result).toMatchObject({ ok: true, requested: 1, removed: 0, skipped: 1 })
    expect(result.items[0]).toMatchObject({
      id: aiRecord.id,
      status: 'skipped',
      error: 'AI 回复记录请使用 AI 专用删除/清理',
    })
    expect(getMessageListRecord(decrypted, aiRecord.id ?? 0)).toBeDefined()
  })

  it('批量删除拒绝空批次和非法 id', () => {
    expect(deleteMessageListRecords(decrypted, [])).toMatchObject({
      ok: false,
      error: '请至少选择一条记录',
    })
    expect(deleteMessageListRecords(decrypted, [1.5])).toMatchObject({
      ok: false,
      error: '批量删除的记录 id 无效',
    })
  })
})
