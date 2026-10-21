/**
 * 多 worker 共用 clawbot.db 时的 lease/fencing 守卫。
 *
 * 这里不模拟“两个进程”的时序，而是用真实 SQLite 按两个 owner 顺序调用：
 * 第一次 claim 形成活动租约，第二次 claim 必须失败；推进 now 越过 lease 后第二次
 * 接管成功，随后第一次的迟到回填必须被 fencing 拒绝。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claimReplyPartSending,
  claimReplyRunGeneration,
  enqueueOrMergeReplyRun,
  failReplyPartAndRunClaimed,
  markReplyPartFailedClaimed,
  markReplyPartRetryClaimed,
  markReplyPartSending,
  markReplyPartSent,
  markReplyPartSentClaimed,
  markReplyRunDoneClaimed,
  markReplyRunDoneIfIdle,
  markReplyRunFailedIfIdle,
  markReplyRunSkippedIfIdle,
  readReplyRun,
  renewReplyPartSendingClaim,
  renewReplyRunGenerationClaim,
  saveReplyParts,
  saveReplyPartsClaimed,
} from '../src/query/clawbot/clawbot-reply-store.ts'
import { clawbotDbPath, ensureClawbotStore } from '../src/query/clawbot/clawbot-db.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-lease-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

describe('clawbot reply lease：生成 claim', () => {
  it('活动 leases 阻止第二个 worker；attempts 只在成功 claim 时递增', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_001,
      question: 'generation claim',
      debounceMs: 0,
      now: 1_000,
    })

    const workerA = claimReplyRunGeneration(dir, {
      runId: run.id,
      owner: 'worker-a',
      now: 1_000,
      leaseMs: 100,
    })
    expect(workerA).toMatchObject({
      run: { id: run.id, status: 'generating', attempts: 1 },
      lease: { owner: 'worker-a', fence: 1, until: 1_100 },
    })

    const workerB = claimReplyRunGeneration(dir, {
      runId: run.id,
      owner: 'worker-b',
      now: 1_050,
      leaseMs: 100,
    })
    expect(workerB).toBeNull()
    expect(readReplyRun(dir, run.id)?.run).toMatchObject({ status: 'generating', attempts: 1 })

    const renewed = renewReplyRunGenerationClaim(dir, workerA as NonNullable<typeof workerA>, 100, 1_050)
    expect(renewed).toMatchObject({ lease: { owner: 'worker-a', fence: 1, until: 1_150 } })
    expect(claimReplyRunGeneration(dir, {
      runId: run.id,
      owner: 'worker-b',
      now: 1_100,
      leaseMs: 100,
    })).toBeNull()
  })

  it('过期后可接管；旧 owner 的迟到分段写入被 fence 拒绝', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_002,
      question: 'generation takeover',
      debounceMs: 0,
      now: 1_000,
    })
    const workerA = claimReplyRunGeneration(dir, {
      runId: run.id,
      owner: 'worker-a',
      now: 1_000,
      leaseMs: 100,
    })
    expect(workerA).not.toBeNull()

    const workerB = claimReplyRunGeneration(dir, {
      runId: run.id,
      owner: 'worker-b',
      now: 1_100,
      leaseMs: 100,
    })
    expect(workerB).toMatchObject({
      run: { id: run.id, status: 'generating', attempts: 2 },
      lease: { owner: 'worker-b', fence: 2, until: 1_200 },
    })

    expect(saveReplyPartsClaimed(dir, workerA as NonNullable<typeof workerA>, ['旧 owner 晚到'], 1_101)).toBeNull()
    expect(readReplyRun(dir, run.id)?.parts).toEqual([])

    const saved = saveReplyPartsClaimed(dir, workerB as NonNullable<typeof workerB>, ['新 owner 结果'], 1_101)
    expect(saved).toHaveLength(1)
    expect(saved?.[0]).toMatchObject({ text: '新 owner 结果', status: 'pending' })
    expect(readReplyRun(dir, run.id)?.run).toMatchObject({ status: 'ready', attempts: 2 })
  })

  it('租约过期但尚无接管者时，原 owner 仍可提交结果，避免长任务白算', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_003,
      question: 'long generation',
      debounceMs: 0,
      now: 1_000,
    })
    const workerA = claimReplyRunGeneration(dir, {
      runId: run.id,
      owner: 'worker-a',
      now: 1_000,
      leaseMs: 100,
    })
    expect(workerA).not.toBeNull()

    const saved = saveReplyPartsClaimed(
      dir,
      workerA as NonNullable<typeof workerA>,
      ['租约过期后完成'],
      1_500,
    )
    expect(saved).toHaveLength(1)
    expect(readReplyRun(dir, run.id)?.run.status).toBe('ready')
  })
})

describe('clawbot reply lease：发送 claim', () => {
  it('part/run 双层 lease 阻止并发发送；过期接管后旧 owner 不能回填 sent', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_101,
      question: 'send claim',
      debounceMs: 0,
      now: 2_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['发送这一段'], 2_001)
    expect(part).toBeDefined()

    const workerA = claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-a',
      now: 2_001,
      leaseMs: 100,
    })
    expect(workerA).toMatchObject({
      part: { id: part?.id, status: 'sending', attempts: 1 },
      lease: { owner: 'worker-a', fence: 1, until: 2_101 },
      runLease: { owner: 'worker-a', fence: 1, until: 2_101 },
    })

    expect(claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-b',
      now: 2_051,
      leaseMs: 100,
    })).toBeNull()
    expect(readReplyRun(dir, run.id)?.parts[0]?.attempts).toBe(1)

    const workerB = claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-b',
      now: 2_101,
      leaseMs: 100,
    })
    expect(workerB).toMatchObject({
      part: { id: part?.id, status: 'sending', attempts: 2 },
      lease: { owner: 'worker-b', fence: 2, until: 2_201 },
      runLease: { owner: 'worker-b', fence: 2, until: 2_201 },
    })

    expect(markReplyPartSentClaimed(
      dir,
      workerA as NonNullable<typeof workerA>,
      9_001,
      2_101,
    )).toBeNull()

    const sent = markReplyPartSentClaimed(
      dir,
      workerB as NonNullable<typeof workerB>,
      9_002,
      2_101,
    )
    expect(sent).toMatchObject({ status: 'sent', attempts: 2, sentMessageId: 9_002 })

    expect(markReplyRunDoneClaimed(dir, workerA as NonNullable<typeof workerA>, 2_102)).toBeNull()
    expect(markReplyRunDoneClaimed(dir, workerB as NonNullable<typeof workerB>, 2_102))
      .toMatchObject({ status: 'done' })
  })

  it('发送租约可续租；过期但未被接管时旧 owner 仍可幂等回填 sent', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_102,
      question: 'long send',
      debounceMs: 0,
      now: 2_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['长发送'], 2_001)
    const workerA = claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-a',
      now: 2_001,
      leaseMs: 100,
    })
    expect(workerA).not.toBeNull()

    const renewed = renewReplyPartSendingClaim(
      dir,
      workerA as NonNullable<typeof workerA>,
      100,
      2_051,
    )
    expect(renewed).toMatchObject({
      lease: { owner: 'worker-a', fence: 1, until: 2_151 },
      runLease: { owner: 'worker-a', fence: 1, until: 2_151 },
    })
    expect(claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-b',
      now: 2_101,
      leaseMs: 100,
    })).toBeNull()

    const sent = markReplyPartSentClaimed(
      dir,
      workerA as NonNullable<typeof workerA>,
      9_003,
      2_500,
    )
    expect(sent).toMatchObject({ status: 'sent', sentMessageId: 9_003 })
  })

  it('发送退避未到期时不 claim，到期后才允许重试', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_103,
      question: 'backoff claim',
      debounceMs: 0,
      now: 3_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['退避后重试'], 3_001)
    const first = claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-a',
      now: 3_001,
      leaseMs: 100,
    })
    expect(first).not.toBeNull()
    expect(markReplyPartRetryClaimed(
      dir,
      first as NonNullable<typeof first>,
      'socket timeout',
      5_000,
      3_002,
    )).toMatchObject({ status: 'pending' })

    expect(claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-b',
      now: 4_999,
      leaseMs: 100,
    })).toBeNull()
    expect(claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-b',
      now: 5_000,
      leaseMs: 100,
    })).toMatchObject({
      part: { status: 'sending', attempts: 2 },
      lease: { owner: 'worker-b' },
    })
  })

  it('claim/续租只动 lease，不推进 nextAttemptAt；第一段成功后第二段可立即 claim', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_104,
      question: 'two parts',
      debounceMs: 0,
      now: 6_000,
    })
    const [first, second] = saveReplyParts(dir, run.id, ['第一段', '第二段'], 6_001)
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const firstClaim = claimReplyPartSending(dir, {
      partId: first?.id ?? 0,
      owner: 'worker-a',
      now: 6_001,
      leaseMs: 100,
    })
    expect(firstClaim).not.toBeNull()
    expect(readReplyRun(dir, run.id)?.run.nextAttemptAt).toBe(6_001)

    const renewed = renewReplyPartSendingClaim(
      dir,
      firstClaim as NonNullable<typeof firstClaim>,
      100,
      6_050,
    )
    expect(renewed).not.toBeNull()
    expect(readReplyRun(dir, run.id)?.run.nextAttemptAt).toBe(6_001)

    expect(markReplyPartSentClaimed(
      dir,
      renewed as NonNullable<typeof renewed>,
      9_104,
      6_060,
    )).toMatchObject({ status: 'sent' })
    expect(claimReplyPartSending(dir, {
      partId: second?.id ?? 0,
      owner: 'worker-a',
      now: 6_060,
      leaseMs: 100,
    })).toMatchObject({
      part: { id: second?.id, status: 'sending', attempts: 1 },
      lease: { owner: 'worker-a' },
    })
  })

  it('旧 API 不把发送租约写入 nextAttemptAt；第一段成功后第二段可立即 claim', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_106,
      question: 'legacy two parts',
      debounceMs: 0,
      now: 6_500,
    })
    const [first, second] = saveReplyParts(dir, run.id, ['旧 API 第一段', '旧 API 第二段'], 6_501)
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    expect(markReplyPartSending(dir, first?.id ?? 0, 6_501)).toMatchObject({
      status: 'sending',
      attempts: 1,
    })
    expect(readReplyRun(dir, run.id)).toMatchObject({
      run: { status: 'sending', nextAttemptAt: 6_501 },
    })

    expect(markReplyPartSent(dir, first?.id ?? 0, 9_106, 6_502)).toMatchObject({
      status: 'sent',
      sentMessageId: 9_106,
    })
    expect(readReplyRun(dir, run.id)).toMatchObject({
      run: { status: 'sending', nextAttemptAt: 6_501 },
    })
    expect(claimReplyPartSending(dir, {
      partId: second?.id ?? 0,
      owner: 'worker-a',
      now: 6_502,
      leaseMs: 100,
    })).toMatchObject({
      part: { id: second?.id, status: 'sending', attempts: 1 },
      lease: { owner: 'worker-a' },
    })
  })

  it('永久失败在同一事务内同时落 part 与 run，后续分段不再发送', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_105,
      question: 'atomic failure',
      debounceMs: 0,
      now: 7_000,
    })
    const [first, second] = saveReplyParts(dir, run.id, ['第一段', '第二段'], 7_001)
    const claim = claimReplyPartSending(dir, {
      partId: first?.id ?? 0,
      owner: 'worker-a',
      now: 7_001,
      leaseMs: 100,
    })
    expect(claim).not.toBeNull()

    expect(failReplyPartAndRunClaimed(
      dir,
      claim as NonNullable<typeof claim>,
      '第 1 段永久失败',
      7_050,
    )).toMatchObject({
      part: { id: first?.id, status: 'failed' },
      run: { id: run.id, status: 'failed' },
    })
    expect(readReplyRun(dir, run.id)).toMatchObject({
      run: { status: 'failed', lastError: '第 1 段永久失败' },
      parts: [
        { id: first?.id, status: 'failed' },
        { id: second?.id, status: 'pending' },
      ],
    })
    expect(claimReplyPartSending(dir, {
      partId: second?.id ?? 0,
      owner: 'worker-b',
      now: 7_051,
      leaseMs: 100,
    })).toBeNull()
  })
})

describe('clawbot reply lease：无 claim 的终态收尾', () => {
  it('活动 run/part 租约期间不能落 done/failed/skipped', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_201,
      question: 'active terminal fence',
      debounceMs: 0,
      now: 4_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['唯一分段'], 4_001)
    const claim = claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-a',
      now: 4_001,
      leaseMs: 100,
    })
    expect(claim).not.toBeNull()

    expect(markReplyRunDoneIfIdle(dir, run.id, 4_050)).toBeNull()
    expect(markReplyRunFailedIfIdle(dir, run.id, 'late failure', 4_050)).toBeNull()
    expect(markReplyRunSkippedIfIdle(dir, run.id, 'late skip', 4_050)).toBeNull()

    expect(markReplyPartSentClaimed(
      dir,
      claim as NonNullable<typeof claim>,
      9_201,
      4_060,
    )).toMatchObject({ status: 'sent' })
    expect(markReplyRunDoneIfIdle(dir, run.id, 4_061)).toMatchObject({ status: 'done' })
  })

  it('part 已永久失败且 run 空闲时可安全落终态，旧 owner 回填被拒绝', () => {
    const dir = root()
    const run = enqueueOrMergeReplyRun(dir, {
      slot: 1,
      targetMessageId: 1_202,
      question: 'expired terminal fence',
      debounceMs: 0,
      now: 5_000,
    })
    const [part] = saveReplyParts(dir, run.id, ['唯一分段'], 5_001)
    const claim = claimReplyPartSending(dir, {
      partId: part?.id ?? 0,
      owner: 'worker-a',
      now: 5_001,
      leaseMs: 100,
    })
    expect(claim).not.toBeNull()

    expect(markReplyPartFailedClaimed(
      dir,
      claim as NonNullable<typeof claim>,
      'permanent send failure',
      5_100,
    )).toMatchObject({ status: 'failed' })
    expect(markReplyRunFailedIfIdle(dir, run.id, 'lease expired', 5_101))
      .toMatchObject({ status: 'failed' })
    expect(markReplyPartSentClaimed(
      dir,
      claim as NonNullable<typeof claim>,
      9_202,
      5_102,
    )).toBeNull()
  })
})

describe('clawbot reply lease：老库迁移', () => {
  it('自动补 lease 列与 claim 索引，并保留旧执行中行的租约截止时间', () => {
    const dir = root()
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec(`CREATE TABLE clawbot_reply_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot INTEGER NOT NULL,
      target_message_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE clawbot_reply_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      client_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_message_id INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    db.prepare(`INSERT INTO clawbot_reply_run(
      id, slot, target_message_id, question, status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (1, 1, 1, '旧 generating', 'generating', 1, 5_000, 1_000, 1_000)`).run()
    db.prepare(`INSERT INTO clawbot_reply_outbox(
      id, run_id, slot, part_index, text, client_id, status, attempts, created_at, updated_at
    ) VALUES (1, 1, 1, 0, '旧 sending', 'client-old', 'sending', 1, 1_000, 1_000)`).run()
    db.close()

    ensureClawbotStore(dir)

    const migrated = new DatabaseSync(clawbotDbPath(dir))
    try {
      const runCols = (migrated.prepare('PRAGMA table_info(clawbot_reply_run)').all() as Array<{ name?: string }>)
        .map(row => row.name)
      const partCols = (migrated.prepare('PRAGMA table_info(clawbot_reply_outbox)').all() as Array<{ name?: string }>)
        .map(row => row.name)
      for (const col of ['lease_owner', 'lease_until', 'lease_fence']) {
        expect(runCols, `run 缺 lease 列 ${col}`).toContain(col)
        expect(partCols, `outbox 缺 lease 列 ${col}`).toContain(col)
      }

      const indexes = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name?: string }>)
        .map(row => row.name)
      expect(indexes).toContain('clawbot_reply_run_claim')
      expect(indexes).toContain('clawbot_reply_outbox_claim')

      expect(migrated.prepare(`SELECT lease_owner, lease_until, lease_fence
        FROM clawbot_reply_run WHERE id = 1`).get())
        .toMatchObject({ lease_owner: null, lease_until: 5_000, lease_fence: 0 })
      expect(migrated.prepare('SELECT lease_until FROM clawbot_reply_outbox WHERE id = 1').get())
        .toMatchObject({ lease_until: 5_000 })

      migrated.prepare('UPDATE clawbot_reply_run SET lease_until = 0 WHERE id = 1').run()
    } finally {
      migrated.close()
    }

    ensureClawbotStore(dir)
    const afterSecondEnsure = new DatabaseSync(clawbotDbPath(dir))
    try {
      expect(afterSecondEnsure.prepare('SELECT lease_until FROM clawbot_reply_run WHERE id = 1').get())
        .toMatchObject({ lease_until: 0 })
    } finally {
      afterSecondEnsure.close()
    }
  })
})
