/**
 * ClawBot 自动回复持久化 run / outbox 守卫。
 *
 * 重点不是「能写进去」，而是重启、重复入队、重复生成与发送结果不确定时，
 * 仍然只有一条 run、一组 outbox 和稳定不变的 client_id。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  REPLY_GENERATING_LEASE_MS,
  clearClawbotReplyState,
  enqueueOrMergeReplyRun,
  listRecoverableReplyRuns,
  listRecoverableReplyRunsAfterId,
  markReplyPartFailed,
  markReplyPartRetry,
  markReplyPartSending,
  markReplyPartSent,
  markReplyRunDone,
  markReplyRunGenerating,
  markReplyRunRetry,
  readReplyRun,
  saveReplyParts,
} from '../src/query/clawbot/clawbot-reply-store.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-reply-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

describe('clawbot reply store：run 入队与合并', () => {
  it('同一 slot 的 debouncing run 在窗口内合并，并更新 target/question/nextAttemptAt', () => {
    const dir = root()
    const first = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 101, question: '第一句', debounceMs: 500, now: 1_000,
    })
    const merged = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 102, question: '第二句', debounceMs: 500, now: 1_200,
    })

    expect(merged.id).toBe(first.id)
    expect(merged).toMatchObject({
      targetMessageId: 102,
      question: '第二句',
      status: 'debouncing',
      attempts: 0,
      nextAttemptAt: 1_700,
    })

    // 已合并的 target 再次出现时，保留窗口内最新一份，不把 question 倒回去。
    const duplicate = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 102, question: '重复帧', debounceMs: 500, now: 1_300,
    })
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.question).toBe('第二句')
    expect(duplicate.nextAttemptAt).toBe(1_700)

    // 窗口已到时才创建新 run。
    const later = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 103, question: '窗口之后', debounceMs: 500, now: 1_700,
    })
    expect(later.id).not.toBe(first.id)
    expect(later.nextAttemptAt).toBe(2_200)
  })

  it('重复 targetMessageId 幂等返回已有 run，即使该 run 已经终态', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 201, question: '原始问题', debounceMs: 10, now: 100,
    })
    markReplyRunDone(dir, run.id, 120)

    const duplicate = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 201, question: '重放帧', debounceMs: 10, now: 500,
    })
    expect(duplicate.id).toBe(run.id)
    expect(duplicate.status).toBe('done')
    expect(duplicate.question).toBe('原始问题')
    expect(listRecoverableReplyRuns(dir, 500)).toEqual([])
  })

  it('listRecoverableReplyRuns 返回未来到期的非终态 run；终态 run 不返回', () => {
    const dir = root()
    const due = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 301, question: 'due', debounceMs: 0, now: 1_000,
    })
    const future = enqueueOrMergeReplyRun(dir, {
      slot: 2, targetMessageId: 302, question: 'future', debounceMs: 60_000, now: 1_000,
    })
    const terminal = enqueueOrMergeReplyRun(dir, {
      slot: 3, targetMessageId: 303, question: 'terminal', debounceMs: 0, now: 1_000,
    })
    markReplyRunRetry(dir, terminal.id, 'stop', 2_000, 1_000)
    markReplyRunDone(dir, terminal.id, 1_000)

    const runs = listRecoverableReplyRuns(dir, 1_000, 20)
    expect(runs.map(r => r.id)).toEqual([due.id, future.id])
    expect(runs[1]?.nextAttemptAt).toBe(61_000)
  })

  it('maxPending 在入队事务内限制非终态 run；已有 debounce 仍可合并', () => {
    const dir = root()
    const first = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 311, question: '第一条', debounceMs: 1_000, maxPending: 1, now: 1_000,
    })
    const merged = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 312, question: '合并进窗口', debounceMs: 1_000, maxPending: 1, now: 1_100,
    })
    expect(merged.id).toBe(first.id)

    expect(() => enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 313, question: '应当拒绝', debounceMs: 1_000, maxPending: 1, now: 2_500,
    })).toThrow('积压 1 条')
    expect(listRecoverableReplyRuns(dir, 2_500, 20)).toHaveLength(1)
  })
})

describe('clawbot reply store：outbox 与发送幂等', () => {
  it('同一 run 重复生成分段不重复插入，且重启后 client_id 保持一致', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 401, question: '分段', debounceMs: 0, now: 1_000,
    })
    const first = saveReplyParts(dir, run.id, ['第一段', { text: '第二段' }], 1_100)
    const second = saveReplyParts(dir, run.id, ['不应覆盖', '也不应覆盖'], 1_200)

    expect(second.map(part => part.id)).toEqual(first.map(part => part.id))
    expect(second.map(part => part.clientId)).toEqual(first.map(part => part.clientId))
    expect(second.map(part => part.text)).toEqual(['第一段', '第二段'])
    expect(new Set(first.map(part => part.clientId)).size).toBe(2)

    const afterRestart = readReplyRun(dir, run.id)
    expect(afterRestart?.run.status).toBe('ready')
    expect(afterRestart?.parts.map(part => part.clientId)).toEqual(first.map(part => part.clientId))
  })

  it('发送成功但状态未落盘：run/outbox 仍可恢复，并沿用原 client_id 补记 sent', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 501, question: '恢复', debounceMs: 0, now: 1_000,
    })
    markReplyRunGenerating(dir, run.id, 1_000)
    const [part] = saveReplyParts(dir, run.id, ['只发一段'], 1_100)
    expect(part).toBeDefined()
    const sending = markReplyPartSending(dir, part?.id ?? 0, 1_200)
    expect(sending.status).toBe('sending')
    expect(sending.attempts).toBe(1)

    // 发送请求已发出、进程在写 sent 之前重启：租约仍由 lease_until 保留，
    // nextAttemptAt 只承担业务退避，不能被发送租约截止时间污染。
    const beforeRestart = readReplyRun(dir, run.id)
    expect(beforeRestart?.run.status).toBe('sending')
    expect(beforeRestart?.run.nextAttemptAt).toBe(1_100)
    expect(beforeRestart?.parts[0]?.clientId).toBe(sending.clientId)
    expect(listRecoverableReplyRuns(dir, 1_300, 10).map(r => r.id)).toContain(run.id)

    // 恢复后仍用同一 part/client_id 发送；成功后补记结果。
    const sent = markReplyPartSent(dir, sending.id, 9_001, 1_400)
    expect(sent).toMatchObject({ status: 'sent', sentMessageId: 9_001, clientId: sending.clientId })
  })

  it('重复标记 sent 幂等：attempts 不增加，sentMessageId 保留第一次值', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 601, question: 'sent 幂等', debounceMs: 0, now: 1_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['唯一分段'], 1_100)
    const sending = markReplyPartSending(dir, part?.id ?? 0, 1_200)
    const first = markReplyPartSent(dir, sending.id, 7_777, 1_300)
    const second = markReplyPartSent(dir, sending.id, 8_888, 1_400)

    expect(first.status).toBe('sent')
    expect(second.status).toBe('sent')
    expect(second.sentMessageId).toBe(7_777)
    expect(second.attempts).toBe(first.attempts)
    expect(second.updatedAt).toBe(first.updatedAt)

    // 重复生成同一 run 不能把 sending 回退成 ready，也不能重新打开已 sent 的分段。
    saveReplyParts(dir, run.id, ['唯一分段'], 1_500)
    const snapshot = readReplyRun(dir, run.id)
    expect(snapshot?.run.status).toBe('sending')
    expect(snapshot?.parts[0]).toMatchObject({ status: 'sent', sentMessageId: 7_777 })
  })

  it('分段可重试失败：part 回 pending，run 回 ready 并更新 nextAttemptAt', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 701, question: 'retry', debounceMs: 0, now: 1_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['retry me'], 1_100)
    const sending = markReplyPartSending(dir, part?.id ?? 0, 1_200)
    const retried = markReplyPartRetry(dir, sending.id, 'timeout', 5_000, 1_300)

    expect(retried).toMatchObject({ status: 'pending', attempts: 1, lastError: 'timeout' })
    const snapshot = readReplyRun(dir, run.id)
    expect(snapshot?.run).toMatchObject({ status: 'ready', lastError: 'timeout', nextAttemptAt: 5_000 })
  })

  it('每次实际 claim 都累计 attempts；已 failed 的分段不会被重新打开', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 711, question: 'claim', debounceMs: 0, now: 1_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['claim me'], 1_100)
    const first = markReplyPartSending(dir, part?.id ?? 0, 1_200)
    const second = markReplyPartSending(dir, first.id, 1_300)
    expect(second).toMatchObject({ status: 'sending', attempts: 2 })

    const failed = markReplyPartFailed(dir, second.id, 'permanent', 1_400)
    const after = markReplyPartSending(dir, failed.id, 1_500)
    expect(after).toMatchObject({ status: 'failed', attempts: 2, lastError: 'permanent' })
  })
})

describe('clawbot reply store：清理与批量', () => {
  it('清理只删除指定实例的 run/outbox，另一个实例不受影响', () => {
    const dir = root()
    const slot1 = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 801, question: 'slot1', debounceMs: 0, now: 1_000,
    })
    const slot2 = enqueueOrMergeReplyRun(dir, {
      slot: 2, targetMessageId: 802, question: 'slot2', debounceMs: 0, now: 1_000,
    })
    saveReplyParts(dir, slot1.id, ['a', 'b'], 1_100)
    saveReplyParts(dir, slot2.id, ['c'], 1_100)

    expect(clearClawbotReplyState(dir, 1)).toEqual({ removedRuns: 1, removedParts: 2 })
    expect(readReplyRun(dir, slot1.id)).toBeNull()
    expect(readReplyRun(dir, slot2.id)?.parts).toHaveLength(1)
    expect(listRecoverableReplyRuns(dir, 1_200).map(r => r.id)).toEqual([slot2.id])
    expect(clearClawbotReplyState(dir, 1)).toEqual({ removedRuns: 0, removedParts: 0 })
  })

  it('120 段 outbox soak：批量写、重复写与回读都稳定', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 901, question: 'soak', debounceMs: 0, now: 1_000,
    })
    const texts = Array.from({ length: 120 }, (_, index) => `第 ${String(index)} 段`)

    const first = saveReplyParts(dir, run.id, texts, 1_100)
    const second = saveReplyParts(dir, run.id, texts, 1_200)
    expect(first).toHaveLength(120)
    expect(second).toHaveLength(120)
    expect(second.map(part => part.partIndex)).toEqual(texts.map((_, index) => index))
    expect(second.map(part => part.text)).toEqual(texts)
    expect(new Set(second.map(part => part.clientId)).size).toBe(120)
    expect(second.map(part => part.id)).toEqual(first.map(part => part.id))
  })

  it('id 游标分页单调前进，不重不漏且跳过终态 run', () => {
    const dir = root()
    const first = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 951, question: 'first', debounceMs: 0, now: 1_000,
    })
    const terminal = enqueueOrMergeReplyRun(dir, {
      slot: 1, targetMessageId: 952, question: 'terminal', debounceMs: 0, now: 1_000,
    })
    const last = enqueueOrMergeReplyRun(dir, {
      slot: 2, targetMessageId: 953, question: 'last', debounceMs: 0, now: 1_000,
    })
    markReplyRunDone(dir, terminal.id, 1_100)

    const page1 = listRecoverableReplyRunsAfterId(dir, 0, 1)
    const page2 = listRecoverableReplyRunsAfterId(dir, page1[0]?.id ?? 0, 1)
    const exhausted = listRecoverableReplyRunsAfterId(dir, page2[0]?.id ?? 0, 10)

    expect(page1.map(run => run.id)).toEqual([first.id])
    expect(page2.map(run => run.id)).toEqual([last.id])
    expect(exhausted).toEqual([])
  })
})
