// @vitest-environment node
/**
 * ClawBot 存储预热：真实 SQLite、不 mock。
 *
 * 钉住四类不变量：
 *   ① 库不存在时只返回未预热，绝不创建空库；
 *   ② 已存在的库只走一次可写连接，schema 自愈后按 bound slot 预热；
 *   ③ 可选 reply run/outbox 表存在时计数，缺表时安全跳过；
 *   ④ 损坏库不向启动流程抛错，traceStage 字段形状稳定。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withWritableDb } from '../src/query/db-open.ts'
import { clawbotDbPath, ensureClawbotSchema } from '../src/query/clawbot/clawbot-db.ts'
import { traceStage, warmClawbotStore } from '../src/query/clawbot/clawbot-store-warmup.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function dataRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'clawbot-warmup-'))
  scratch.push(base)
  const decrypted = join(base, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

/** 两条 bound slot（1、3）、一条 unbound（4），每条 slot 都有消息；仅 bound 参与预热。 */
function seedCore(decrypted: string): void {
  withWritableDb(clawbotDbPath(decrypted), (db) => {
    ensureClawbotSchema(db)
    db.prepare("UPDATE clawbot_binding SET status = 'bound' WHERE slot = 1").run()
    const now = Date.now()
    // slot 是稳定实例号，schema 自愈会把历史行回填成 slot=id；夹具显式同号才能代表真实库。
    db.prepare("INSERT INTO clawbot_binding(id, slot, status, created_at, updated_at) VALUES (3, 3, 'bound', ?, ?)").run(now, now)
    db.prepare("INSERT INTO clawbot_binding(id, slot, status, created_at, updated_at) VALUES (4, 4, 'unbound', ?, ?)").run(now, now)

    db.prepare(`INSERT INTO clawbot_instance_config
      (slot, auto_reply, kb_enabled, kb_id, system_prompt, split_reply, created_at, updated_at)
      VALUES (?, 1, 1, 9, '客服语气', 1, ?, ?)`).run(1, now, now)
    db.prepare(`INSERT INTO clawbot_instance_config
      (slot, auto_reply, kb_enabled, kb_id, system_prompt, split_reply, created_at, updated_at)
      VALUES (?, 0, 0, NULL, '', 1, ?, ?)`).run(3, now, now)

    const insertMessage = db.prepare(
      "INSERT INTO clawbot_message(slot, ts, direction, msg_type, content, created_at) VALUES (?, ?, 'in', 'text', ?, ?)",
    )
    insertMessage.run(1, 100, 'slot1 old', now)
    insertMessage.run(1, 300, 'slot1 newest', now)
    insertMessage.run(3, 200, 'slot3 newest', now)
    insertMessage.run(4, 400, 'slot4 unbound', now)
  })
}

describe('warmClawbotStore', () => {
  it('库不存在：返回未预热，且不创建空库', () => {
    const decrypted = dataRoot()
    const path = clawbotDbPath(decrypted)
    expect(existsSync(path)).toBe(false)

    const result = warmClawbotStore(decrypted)

    expect(result).toMatchObject({
      warmed: false,
      slots: 0,
      recentMessages: 0,
      pendingRuns: 0,
      pendingParts: 0,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
    expect(existsSync(path), '库不存在时预热不得落出一个空库').toBe(false)
  })

  it('空库文件：一次预热完成 schema，自愈出默认未绑定行', () => {
    const decrypted = dataRoot()
    writeFileSync(clawbotDbPath(decrypted), '')

    const result = warmClawbotStore(decrypted)

    expect(result.warmed).toBe(true)
    expect(result.slots).toBe(0)
    expect(result.recentMessages).toBe(0)
    withWritableDb(clawbotDbPath(decrypted), (db) => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding').get() as { n?: number }
      expect(row.n).toBe(1)
    })
  })

  it('正常库：只为 bound slot 预热绑定、配置与最近消息', () => {
    const decrypted = dataRoot()
    seedCore(decrypted)

    const result = warmClawbotStore(decrypted)

    expect(result).toMatchObject({
      warmed: true,
      slots: 2,
      recentMessages: 2,
      pendingRuns: 0,
      pendingParts: 0,
    })
    expect(result.error).toBeUndefined()
  })

  it('可选 reply run/outbox 表存在时统计待处理；缺表时安全跳过', () => {
    const decrypted = dataRoot()
    seedCore(decrypted)

    const withoutOptional = warmClawbotStore(decrypted)
    expect(withoutOptional.pendingRuns).toBe(0)
    expect(withoutOptional.pendingParts).toBe(0)

    withWritableDb(clawbotDbPath(decrypted), (db) => {
      const now = Date.now()
      const insertRun = db.prepare(`INSERT INTO clawbot_reply_run(
        slot, target_message_id, question, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
      insertRun.run(1, 1, 'queued', 'queued', now, now, now)
      insertRun.run(1, 2, 'generating', 'generating', now, now, now)
      insertRun.run(1, 3, 'done', 'done', now, now, now)
      const insertPart = db.prepare(`INSERT INTO clawbot_reply_outbox(
        run_id, slot, part_index, text, client_id, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      insertPart.run(1, 1, 0, 'pending', 'warmup-pending', 'pending', now, now)
      insertPart.run(2, 1, 0, 'sending', 'warmup-sending', 'sending', now, now)
      insertPart.run(3, 1, 0, 'sent', 'warmup-sent', 'sent', now, now)
    })

    const withOptional = warmClawbotStore(decrypted)
    expect(withOptional.warmed).toBe(true)
    expect(withOptional.pendingRuns).toBe(2)
    expect(withOptional.pendingParts).toBe(2)
  })

  it('重复调用幂等：统计稳定，不重复插默认绑定行', () => {
    const decrypted = dataRoot()
    seedCore(decrypted)
    withWritableDb(clawbotDbPath(decrypted), (db) => {
      const now = Date.now()
      db.prepare(`INSERT INTO clawbot_reply_run(
        slot, target_message_id, question, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`).run(1, 11, 'queued', now, now, now)
    })

    const first = warmClawbotStore(decrypted)
    const second = warmClawbotStore(decrypted)
    const firstStable = { ...first, durationMs: 0 }
    const secondStable = { ...second, durationMs: 0 }

    expect(secondStable).toEqual(firstStable)
    withWritableDb(clawbotDbPath(decrypted), (db) => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding').get() as { n?: number }
      expect(row.n, '预热不得反复补默认实例').toBe(3)
    })
  })

  it('缺核心表的既有库：预热自愈 core schema，不误读可选表', () => {
    const decrypted = dataRoot()
    withWritableDb(clawbotDbPath(decrypted), (db) => {
      db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
    })

    const result = warmClawbotStore(decrypted)

    expect(result).toMatchObject({
      warmed: true,
      slots: 0,
      recentMessages: 0,
      pendingRuns: 0,
      pendingParts: 0,
    })
    withWritableDb(clawbotDbPath(decrypted), (db) => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>
      const names = new Set(tables.map((row) => row.name))
      expect(names.has('clawbot_binding')).toBe(true)
      expect(names.has('clawbot_message')).toBe(true)
      expect(names.has('clawbot_instance_config')).toBe(true)
    })
  })

  it('损坏库：不抛到启动流程，返回 warmed:false 与可读 error', () => {
    const decrypted = dataRoot()
    writeFileSync(clawbotDbPath(decrypted), 'this is not a sqlite database')

    let result: ReturnType<typeof warmClawbotStore> | undefined
    expect(() => { result = warmClawbotStore(decrypted) }).not.toThrow()
    expect(result?.warmed).toBe(false)
    expect(result?.error).toContain('ClawBot 存储预热失败')
    expect(result?.slots).toBe(0)
  })
})

describe('traceStage', () => {
  it('字段稳定：可选关联键收敛成 null，elapsedMs 归一到非负整数', () => {
    const event = traceStage({
      stage: 'generate',
      runId: 'run-1',
      partId: undefined,
      clientId: undefined,
      elapsedMs: 12.6,
    })

    expect(Object.keys(event)).toEqual(['stage', 'runId', 'partId', 'clientId', 'elapsedMs'])
    expect(event).toEqual({
      stage: 'generate',
      runId: 'run-1',
      partId: null,
      clientId: null,
      elapsedMs: 13,
    })
    expect(traceStage({ stage: 'send', runId: 'run-2', elapsedMs: -4 }).elapsedMs).toBe(0)
    expect(traceStage({ stage: 'send', runId: 'run-2', elapsedMs: Number.NaN }).elapsedMs).toBe(0)
  })

  it('是纯函数：不修改输入对象', () => {
    const input = {
      stage: 'send',
      runId: 'run-3',
      partId: 'part-2',
      clientId: 'client-9',
      elapsedMs: 8,
    }
    const snapshot = { ...input }
    expect(traceStage(input)).toEqual(input)
    expect(input).toEqual(snapshot)
  })
})
