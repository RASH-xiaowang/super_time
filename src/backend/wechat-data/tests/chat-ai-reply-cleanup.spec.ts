// @vitest-environment node
/**
 * 桌面端 AI 回复预约的专用清理。
 *
 * 与「有正文不删」的 `dropAiReplyMessageListRecord` 不同，本入口允许清理 failed
 * 记录，但只放宽状态：正文、图片、job、发送尝试与任何投递事实都必须同样严格；
 * 删除按 sourceRef/segment_group_ref 整组进行，且记录不存在算 skipped（幂等）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteAiReplyMessageListRecordsForCleanup,
  ensureMessageListSchema,
  getMessageListRecord,
  insertMessageListRecord,
  listMessageListRecords,
  completeAiReplyMessageListRecord,
  failAiReplyMessageListRecord,
  reserveAiReplyMessageListRecord,
  saveMessageListDispatchResult,
} from '../src/query/message-list-store.ts'
import { withWritableDb } from '../src/query/db-open.ts'
import { taskDbPath } from '../src/query/task-db.ts'
import {
  ensureChatAiReplySchema,
  saveChatAiReplySetting,
} from '../src/query/ai-reply/config-store.ts'
import { createChatAiReplyTestHarness } from './helpers/chat-ai-reply-fixture.ts'

const harness = createChatAiReplyTestHarness()
let decrypted = ''

const SOURCE_REF = 'ai-reply:wxid_self:wxid_peer:1000:1'

beforeEach(() => {
  harness.reset()
  decrypted = harness.decrypted
})

afterEach(() => harness.dispose())

function reserve(sourceRef = SOURCE_REF): number {
  const reserved = reserveAiReplyMessageListRecord(decrypted, {
    targetName: '小王',
    targetUsername: 'wxid_peer',
    chatName: '小王',
    chatUsername: 'wxid_peer',
    triggeredAt: Date.now(),
    sourceRef,
  })
  expect(reserved.ok).toBe(true)
  return reserved.id ?? 0
}

function seedFailedBlank(
  failureKind = 'generation_failed',
  sourceRef = SOURCE_REF,
): number {
  const id = reserve(sourceRef)
  expect(failAiReplyMessageListRecord(decrypted, id, '生成失败', failureKind).ok).toBe(true)
  return id
}

function seedFailedWithText(sourceRef = SOURCE_REF): number {
  const id = reserve(sourceRef)
  expect(completeAiReplyMessageListRecord(decrypted, id, { text: '已有回复' }).ok).toBe(true)
  expect(failAiReplyMessageListRecord(decrypted, id, '后续失败', 'generation_failed').ok)
    .toBe(true)
  return id
}

function setRaw(id: number, sql: string, value: string): void {
  withWritableDb(taskDbPath(decrypted), (db) => {
    ensureMessageListSchema(db)
    db.prepare(sql).run(value, id)
  })
}

function cleanup(ids: number[]) {
  return deleteAiReplyMessageListRecordsForCleanup(decrypted, ids)
}

describe('AI 回复 · 专用清理：允许的空白预约', () => {
  it('空白 failed 整组删除', () => {
    const id = seedFailedBlank('superseded')
    const result = cleanup([id])

    expect(result).toMatchObject({ ok: true, removed: 1, skipped: 0 })
    expect(result.items).toEqual([{ id, status: 'removed' }])
    expect(getMessageListRecord(decrypted, id)).toBeUndefined()
  })

  it('空白 pending 整组删除', () => {
    const id = reserve()
    const result = cleanup([id])

    expect(result).toMatchObject({ ok: true, removed: 1, skipped: 0 })
    expect(getMessageListRecord(decrypted, id)).toBeUndefined()
  })

  it('按 source_ref/segment_group_ref 整组删除，不留下分段', () => {
    const base = reserve(SOURCE_REF)
    const segment = reserve(SOURCE_REF + ':segment:2')
    expect(failAiReplyMessageListRecord(decrypted, base, '分段收口', 'generation_failed').ok)
      .toBe(true)
    expect(listMessageListRecords(decrypted).total).toBe(2)

    const result = cleanup([base])

    // removed 按**行**计：基础记录 + 分段都被删掉，界面上的条数才能对上。
    expect(result).toMatchObject({ ok: true, removed: 2, skipped: 0 })
    expect(listMessageListRecords(decrypted).total).toBe(0)
    expect(getMessageListRecord(decrypted, base)).toBeUndefined()
    expect(getMessageListRecord(decrypted, segment)).toBeUndefined()
  })

  it('重复删除幂等：记录不存在只算 skipped，不报错', () => {
    const id = seedFailedBlank()
    expect(cleanup([id])).toMatchObject({ ok: true, removed: 1, skipped: 0 })
    const again = cleanup([id])

    expect(again).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(again.items[0]).toMatchObject({ id, status: 'skipped' })
    expect(again.items[0]?.error).toContain('不存在')
  })

  it('同一分组重复传入只删除一次，两条 id 都如实记为已删除', () => {
    const base = reserve(SOURCE_REF)
    const segment = reserve(SOURCE_REF + ':segment:2')
    const result = cleanup([base, segment])

    // 两条 id 指向同一分组，实际删掉两行；不能把分段报成「跳过」。
    expect(result).toMatchObject({ ok: true, removed: 2, skipped: 0 })
    expect(result.items[0]).toMatchObject({ id: base, status: 'removed' })
    expect(result.items[1]).toMatchObject({ id: segment, status: 'removed' })
    expect(listMessageListRecords(decrypted).total).toBe(0)
  })
})

describe('AI 回复 · 专用清理：守卫与逐条原因', () => {
  it('运行窗口仍在生成或待恢复 → 拒绝删除空白 pending；收口后才可清理', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    const id = reserve()
    const setWindow = (stage: string, pendingSourceRef: string): void => {
      withWritableDb(taskDbPath(decrypted), (db) => {
        ensureChatAiReplySchema(db)
        db.prepare(`UPDATE chat_ai_reply_settings
          SET stage = ?, pending_source_ref = ?
          WHERE account_key = 'wxid_self' AND chat_username = 'wxid_peer'`)
          .run(stage, pendingSourceRef)
      })
    }

    // 删除行不会中止在途模型调用；运行窗口显示 generating 时必须 fail-closed。
    setWindow('generating', SOURCE_REF)
    const blocked = cleanup([id])
    expect(blocked).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(blocked.items[0]?.error).toContain('待恢复')
    expect(getMessageListRecord(decrypted, id)).toBeDefined()

    // defer 留下的「stage=failed + pending 锚点」仍是下一拍可恢复的任务：
    // 只删台账行会让扫描重新预约并投递，所以 stage 不是 unfinished 也要拒绝。
    setWindow('failed', SOURCE_REF)
    const deferred = cleanup([id])
    expect(deferred).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(deferred.items[0]?.error).toContain('待恢复')
    expect(getMessageListRecord(decrypted, id)).toBeDefined()

    // 这一轮真正收口（pending 锚点已清）后，同一空白记录可以清理。
    setWindow('failed', '')
    expect(cleanup([id])).toMatchObject({ ok: true, removed: 1, skipped: 0 })
    expect(getMessageListRecord(decrypted, id)).toBeUndefined()
  })

  it('已有正文 → 整组 skipped 且记录仍在', () => {
    const id = seedFailedWithText()
    const result = cleanup([id])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(result.items[0]?.error).toContain('正文')
    expect(getMessageListRecord(decrypted, id)).toMatchObject({
      status: 'failed',
      text: '已有回复',
    })
  })

  it('分组里任一段有正文 → 整组都不删除', () => {
    const base = reserve(SOURCE_REF)
    const segment = reserve(SOURCE_REF + ':segment:2')
    expect(completeAiReplyMessageListRecord(decrypted, base, { text: '首段正文' }).ok).toBe(true)

    const result = cleanup([base])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(result.items[0]?.error).toContain('正文')
    expect(listMessageListRecords(decrypted).total).toBe(2)
    expect(getMessageListRecord(decrypted, segment)).toBeDefined()
  })

  it('包含图片 → skipped 且记录仍在', () => {
    const id = seedFailedBlank()
    setRaw(id, 'UPDATE message_list_records SET images = ? WHERE id = ?',
      JSON.stringify([{ url: 'https://example.com/a.png' }]))

    const result = cleanup([id])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(result.items[0]?.error).toContain('图片')
    expect(getMessageListRecord(decrypted, id)).toBeDefined()
  })

  it('存在异步发送任务 / 发送尝试 → skipped 且记录仍在', () => {
    const jobId = seedFailedBlank()
    saveMessageListDispatchResult(decrypted, jobId, {
      status: 'failed',
      error: '投递失败',
      responseSummary: '',
      jobId: 'job-123',
      failureKind: 'generation_failed',
      countAttempt: false,
    })
    const attemptId = seedFailedBlank('generation_failed', 'ai-reply:wxid_self:wxid_peer:1000:2')
    saveMessageListDispatchResult(decrypted, attemptId, {
      status: 'failed',
      error: '投递失败',
      responseSummary: '',
      failureKind: 'generation_failed',
    })

    expect(cleanup([jobId]).items[0]?.error).toContain('异步发送任务')
    expect(cleanup([attemptId]).items[0]?.error).toContain('发送尝试')
    expect(getMessageListRecord(decrypted, jobId)).toBeDefined()
    expect(getMessageListRecord(decrypted, attemptId)).toBeDefined()
  })

  it('已成功 / 正在投递等有投递事实的组 → skipped 且记录仍在', () => {
    const successId = seedFailedBlank()
    saveMessageListDispatchResult(decrypted, successId, {
      status: 'success',
      error: '',
      responseSummary: '',
      countAttempt: false,
    })
    const dispatchingId = seedFailedBlank('generation_failed', 'ai-reply:wxid_self:wxid_peer:1000:2')
    saveMessageListDispatchResult(decrypted, dispatchingId, {
      status: 'dispatching',
      error: '',
      responseSummary: '',
      countAttempt: false,
    })

    expect(cleanup([successId]).items[0]?.error).toContain('发送或受理事实')
    expect(cleanup([dispatchingId]).items[0]?.error).toContain('发送或受理事实')
    expect(getMessageListRecord(decrypted, successId)).toBeDefined()
    expect(getMessageListRecord(decrypted, dispatchingId)).toBeDefined()
  })

  it('非 AI 回复记录与不存在的 id 都只 skipped', () => {
    const manual = insertMessageListRecord(decrypted, {
      targetName: '小王',
      text: '手动消息',
    })
    expect(manual.ok).toBe(true)
    const result = cleanup([manual.id ?? 0, 999_999])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 2 })
    expect(result.items[0]?.error).toContain('不是 AI 回复')
    expect(result.items[1]?.error).toContain('不存在')
    expect(getMessageListRecord(decrypted, manual.id ?? 0)).toBeDefined()
  })

  it('混合批次：可删的删掉，有正文的跳过并保留', () => {
    const blank = seedFailedBlank()
    const kept = seedFailedWithText('ai-reply:wxid_self:wxid_peer:1000:2')
    const result = cleanup([blank, kept])

    expect(result).toMatchObject({ ok: true, removed: 1, skipped: 1 })
    expect(getMessageListRecord(decrypted, blank)).toBeUndefined()
    expect(getMessageListRecord(decrypted, kept)).toMatchObject({
      status: 'failed',
      text: '已有回复',
    })
  })

  it('非法入参：空数组 / 超上限 / 非正整数一律拒绝', () => {
    expect(cleanup([])).toMatchObject({ ok: false, removed: 0, skipped: 0 })
    expect(cleanup(Array.from({ length: 101 }, (_, index) => index + 1)))
      .toMatchObject({ ok: false })
    expect(cleanup([0])).toMatchObject({ ok: false })
    expect(cleanup([-1])).toMatchObject({ ok: false })
    expect(cleanup([1.5])).toMatchObject({ ok: false })
  })
})

describe('AI 回复 · 终态删除（includeTerminal）', () => {
  function cleanupTerminal(ids: number[]) {
    return deleteAiReplyMessageListRecordsForCleanup(decrypted, ids, { includeTerminal: true })
  }

  it('已成功、已发出未确认、有正文的失败记录都可以按终态删除', () => {
    const okId = reserve('ai-reply:wxid_self:wxid_peer:1000:11')
    expect(completeAiReplyMessageListRecord(decrypted, okId, { text: '已发出的回复' }).ok).toBe(true)
    setRaw(okId, 'UPDATE message_list_records SET status = ? WHERE id = ?', 'success')

    const failedWithText = seedFailedWithText('ai-reply:wxid_self:wxid_peer:1000:12')

    const unconfirmed = reserve('ai-reply:wxid_self:wxid_peer:1000:13')
    expect(completeAiReplyMessageListRecord(decrypted, unconfirmed, { text: '可能已发出' }).ok).toBe(true)
    setRaw(unconfirmed, 'UPDATE message_list_records SET status = ? WHERE id = ?', 'sent_unconfirmed')

    const result = cleanupTerminal([okId, failedWithText, unconfirmed])

    expect(result).toMatchObject({ ok: true, removed: 3, skipped: 0 })
    expect(getMessageListRecord(decrypted, okId)).toBeUndefined()
    expect(getMessageListRecord(decrypted, failedWithText)).toBeUndefined()
    expect(getMessageListRecord(decrypted, unconfirmed)).toBeUndefined()
    expect(listMessageListRecords(decrypted).total).toBe(0)
  })

  it('默认口径不变：不传 includeTerminal 时，有正文的记录仍然跳过', () => {
    const kept = seedFailedWithText()
    const result = cleanup([kept])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(result.items[0]?.error).toContain('已有正文')
    expect(getMessageListRecord(decrypted, kept)).toBeDefined()
  })

  it('在途状态仍然拒绝：pending / dispatching / queued / running', () => {
    const pending = reserve('ai-reply:wxid_self:wxid_peer:1000:21')
    const dispatching = reserve('ai-reply:wxid_self:wxid_peer:1000:22')
    setRaw(dispatching, 'UPDATE message_list_records SET status = ? WHERE id = ?', 'dispatching')
    const queued = reserve('ai-reply:wxid_self:wxid_peer:1000:23')
    setRaw(queued, 'UPDATE message_list_records SET status = ? WHERE id = ?', 'queued')
    const running = reserve('ai-reply:wxid_self:wxid_peer:1000:24')
    setRaw(running, 'UPDATE message_list_records SET status = ? WHERE id = ?', 'running')

    const result = cleanupTerminal([pending, dispatching, queued, running])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 4 })
    for (const id of [pending, dispatching, queued, running]) {
      expect(getMessageListRecord(decrypted, id), '#' + String(id) + ' 不该被删').toBeDefined()
    }
    expect(result.items[0]?.error).toContain('仍在生成或投递中')
    expect(result.items[1]?.error).toContain('仍在生成或投递中')
  })

  it('终态记录的下游任务仍在排队/执行时也拒绝', () => {
    const id = reserve('ai-reply:wxid_self:wxid_peer:1000:31')
    expect(completeAiReplyMessageListRecord(decrypted, id, { text: '已受理' }).ok).toBe(true)
    withWritableDb(taskDbPath(decrypted), (db) => {
      ensureMessageListSchema(db)
      db.prepare("UPDATE message_list_records SET status = 'success', job_id = 'job-1', job_state = 'running' WHERE id = ?").run(id)
    })

    const result = cleanupTerminal([id])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(result.items[0]?.error).toContain('下游异步任务尚未结束')
    expect(getMessageListRecord(decrypted, id)).toBeDefined()
  })

  it('会话仍挂着该分组的待恢复锚点时，终态删除同样拒绝', () => {
    expect(saveChatAiReplySetting(decrypted, {
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
      chatName: '小王',
      enabled: true,
      provider: 'dsh-wechat-bridge',
    }).ok).toBe(true)
    const id = reserve('ai-reply:wxid_self:wxid_peer:1000:41')
    expect(completeAiReplyMessageListRecord(decrypted, id, { text: '待恢复' }).ok).toBe(true)
    setRaw(id, 'UPDATE message_list_records SET status = ? WHERE id = ?', 'success')
    withWritableDb(taskDbPath(decrypted), (db) => {
      ensureChatAiReplySchema(db)
      db.prepare(`UPDATE chat_ai_reply_settings
        SET stage = 'failed', pending_source_ref = ?
        WHERE account_key = 'wxid_self' AND chat_username = 'wxid_peer'`)
        .run('ai-reply:wxid_self:wxid_peer:1000:41')
    })

    const result = cleanupTerminal([id])

    expect(result).toMatchObject({ ok: true, removed: 0, skipped: 1 })
    expect(result.items[0]?.error).toContain('待恢复')
    expect(getMessageListRecord(decrypted, id)).toBeDefined()
  })
})
