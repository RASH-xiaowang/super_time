import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchPendingTaskCallbacks,
  dispatchTaskCallback,
  ensureTaskSchema,
  listTaskTriggers,
  taskDbPath,
} from '../src/query/task-center.ts'
import type { TaskDispatchDeps } from '../src/query/task-center.ts'

let root = ''
let decrypted = ''
let decoded = ''
let triggerId = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-center-dispatch-lease-'))
  decrypted = join(root, 'data', 'decrypted')
  decoded = join(root, 'data', 'decoded')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function seedFixture(legacyTriggerSchema = false): void {
  const file = taskDbPath(decrypted)
  if (legacyTriggerSchema) {
    const old = new DatabaseSync(file)
    try {
      old.exec(`CREATE TABLE task_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        task_name TEXT NOT NULL DEFAULT '',
        chat_username TEXT NOT NULL DEFAULT '',
        chat_name TEXT NOT NULL DEFAULT '',
        target_username TEXT NOT NULL DEFAULT '',
        target_name TEXT NOT NULL DEFAULT '',
        keyword TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        images TEXT NOT NULL DEFAULT '[]',
        message_local_id INTEGER NOT NULL,
        message_sort_seq INTEGER NOT NULL,
        triggered_at INTEGER NOT NULL,
        callback_status TEXT NOT NULL DEFAULT 'pending',
        callback_at INTEGER,
        callback_error TEXT NOT NULL DEFAULT '',
        UNIQUE(task_id, message_local_id)
      )`)
    } finally {
      old.close()
    }
  }

  const db = new DatabaseSync(file)
  try {
    ensureTaskSchema(db)
    const task = db.prepare(`INSERT INTO task_info(
      name, chat_username, chat_name, chat_type, keywords,
      trigger_method, callback_url, trigger_config, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'dispatch lease',
      'wxid_target',
      'target',
      'private',
      '["invoice"]',
      'webhook',
      'https://callback.example/hook',
      JSON.stringify({ url: 'https://callback.example/hook' }),
      'ready',
      1,
      1,
    )
    const taskId = Number(task.lastInsertRowid)
    const trigger = db.prepare(`INSERT INTO task_triggers(
      task_id, task_name, chat_username, chat_name, keyword, text,
      message_local_id, message_sort_seq, triggered_at, callback_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
      taskId,
      'dispatch lease',
      'wxid_target',
      'target',
      'invoice',
      'invoice content',
      1,
      1,
      1,
    )
    triggerId = Number(trigger.lastInsertRowid)
  } finally {
    db.close()
  }
}

function dispatchDeps(fetchImpl: TaskDispatchDeps['fetchImpl']): TaskDispatchDeps {
  return {
    decodeImage: async () => ({ url: 'data:image/png;base64,AAAA' }),
    gate: (_feature, _stats, texts) => texts,
    fetchImpl,
  }
}

describe('task-center per-record dispatch lease', () => {
  it('background batch and manual redelivery racing on one record issue at most one HTTP request', async () => {
    seedFixture()
    const now = Date.now()
    let calls = 0
    let release!: (response: Response) => void
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }
    const deps = dispatchDeps(fetchImpl)
    const batch = dispatchPendingTaskCallbacks(decrypted, decoded, deps)
    await vi.waitFor(() => expect(calls).toBe(1))

    const manual = await dispatchTaskCallback(decrypted, decoded, triggerId, deps, {
      owner: 'manual-worker',
      now,
      leaseMs: 60_000,
    })
    expect(manual).toMatchObject({
      ok: false,
      status: 'sent_unconfirmed',
      error: expect.stringContaining('正在投递中'),
    })
    expect(calls).toBe(1)

    release(new Response('ok', { status: 200 }))
    await expect(batch).resolves.toEqual({ dispatched: 1, failed: 0 })
  })

  it('a repeated call after success never sends the record again', async () => {
    seedFixture()
    let calls = 0
    const deps = dispatchDeps(async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    })

    await expect(dispatchTaskCallback(decrypted, decoded, triggerId, deps, {
      owner: 'first',
      now: 2_000,
    })).resolves.toMatchObject({ ok: true, status: 'sent' })
    await expect(dispatchTaskCallback(decrypted, decoded, triggerId, deps, {
      owner: 'duplicate',
      now: 2_001,
    })).resolves.toMatchObject({
      ok: false,
      status: 'sent',
      error: '记录已投递，不能重复投递',
    })
    expect(calls).toBe(1)
  })

  it('an expired lease can be taken over, but the old owner cannot overwrite the new result', async () => {
    seedFixture()
    let calls = 0
    let releaseOld!: (response: Response) => void
    const oldRequest = dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Promise<Response>((resolve) => {
        releaseOld = resolve
      })
    }), {
      owner: 'old-owner',
      now: 3_000,
      leaseMs: 10,
      heartbeatMs: 0,
    })
    await vi.waitFor(() => expect(calls).toBe(1))

    const takeover = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Response('rejected', { status: 400 })
    }), {
      owner: 'new-owner',
      now: 3_020,
      leaseMs: 1_000,
    })
    expect(takeover).toMatchObject({ ok: false, status: 'failed' })
    expect(calls).toBe(2)

    releaseOld(new Response('ok', { status: 200 }))
    await expect(oldRequest).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: expect.stringContaining('投递租约已失效'),
    })
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('failed')
  })

  it('a failed record can be manually redelivered once the lease is released', async () => {
    seedFixture()
    let calls = 0
    const first = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Response('boom', { status: 400 })
    }), {
      owner: 'first',
      now: 4_000,
    })
    expect(first).toMatchObject({ ok: false, status: 'failed' })
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('failed')

    const retry = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    }), {
      owner: 'retry',
      now: 4_001,
    })
    expect(retry).toMatchObject({ ok: true, status: 'sent' })
    expect(calls).toBe(2)
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('sent')
  })

  it('heartbeat renews owner/fence while HTTP is in flight, so a live request is not taken over', async () => {
    seedFixture()
    let calls = 0
    let release!: (response: Response) => void
    const first = dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Promise<Response>((resolve) => { release = resolve })
    }), {
      owner: 'heartbeat-owner',
      leaseMs: 40,
      heartbeatMs: 10,
    })
    await vi.waitFor(() => expect(calls).toBe(1))
    await new Promise((resolve) => { setTimeout(resolve, 90) })

    const duplicate = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Response('duplicate', { status: 200 })
    }), { owner: 'duplicate' })
    expect(duplicate).toMatchObject({
      ok: false,
      status: 'sent_unconfirmed',
      error: expect.stringContaining('正在投递中'),
    })
    expect(calls).toBe(1)

    release(new Response('ok', { status: 200 }))
    await expect(first).resolves.toMatchObject({ ok: true, status: 'sent' })
  })

  it('a failed renewal aborts the in-flight fetch and leaves sent_unconfirmed', async () => {
    seedFixture()
    let calls = 0
    const request = dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async (_url, init) => {
      calls += 1
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = (): void => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    }), {
      owner: 'renew-owner',
      leaseMs: 1_000,
      heartbeatMs: 10,
    })
    await vi.waitFor(() => expect(calls).toBe(1))

    const db = new DatabaseSync(taskDbPath(decrypted))
    try {
      db.prepare(`UPDATE task_triggers SET
        callback_lease_owner = 'replacement',
        callback_lease_fence = callback_lease_fence + 1
        WHERE id = ?`).run(triggerId)
    } finally {
      db.close()
    }

    await expect(request).resolves.toMatchObject({
      ok: false,
      status: 'sent_unconfirmed',
      error: expect.stringContaining('不会自动重投'),
    })
    expect(calls).toBe(1)
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('sent_unconfirmed')
  })

  it('a terminal write failure preserves sent_unconfirmed and automatic dispatch never retries it', async () => {
    seedFixture()
    let calls = 0
    let lock: DatabaseSync | null = null
    const result = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      lock = new DatabaseSync(taskDbPath(decrypted))
      lock.exec('BEGIN IMMEDIATE')
      return new Response('ok', { status: 200 })
    }), {
      owner: 'success-save-fails',
      leaseMs: 1_000,
      heartbeatMs: 20,
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'sent_unconfirmed',
      error: expect.stringContaining('不会自动重投'),
    })
    expect(listTaskTriggers(decrypted).items[0]?.callbackStatus).toBe('sent_unconfirmed')
    if (lock !== null) {
      ;(lock as DatabaseSync).exec('ROLLBACK')
      ;(lock as DatabaseSync).close()
    }

    const automatic = await dispatchPendingTaskCallbacks(decrypted, decoded, dispatchDeps(async () => {
      calls += 1
      return new Response('duplicate', { status: 200 })
    }))
    expect(automatic).toEqual({ dispatched: 0, failed: 0 })
    expect(calls).toBe(1)

    const manual = await dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    }), {
      owner: 'manual-after-confirmation',
      now: Date.now() + 200_000,
      leaseMs: 1_000,
      heartbeatMs: 20,
    })
    expect(manual).toMatchObject({ ok: true, status: 'sent' })
    expect(calls).toBe(2)
  })

  it('claim lock exhaustion is reported by the batch instead of being silently skipped', async () => {
    seedFixture()
    let calls = 0
    const lock = new DatabaseSync(taskDbPath(decrypted))
    lock.exec('BEGIN IMMEDIATE')
    try {
      const pending = await dispatchPendingTaskCallbacks(decrypted, decoded, dispatchDeps(async () => {
        calls += 1
        return new Response('ok', { status: 200 })
      }))
      expect(pending.dispatched).toBe(0)
      expect(pending.failed).toBe(1)
      expect(pending.errors?.[0]).toContain('认领触发记录失败')
      expect(calls).toBe(0)
    } finally {
      lock.exec('ROLLBACK')
      lock.close()
    }

    await expect(dispatchPendingTaskCallbacks(decrypted, decoded, dispatchDeps(async () => {
      calls += 1
      return new Response('ok', { status: 200 })
    }))).resolves.toEqual({ dispatched: 1, failed: 0 })
  })

  it('tolerates a concurrent duplicate-column ALTER while upgrading an old schema', () => {
    const file = taskDbPath(decrypted)
    const db = new DatabaseSync(file)
    try {
      db.exec(`CREATE TABLE task_triggers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        task_name TEXT NOT NULL DEFAULT '',
        chat_username TEXT NOT NULL DEFAULT '',
        chat_name TEXT NOT NULL DEFAULT '',
        target_username TEXT NOT NULL DEFAULT '',
        target_name TEXT NOT NULL DEFAULT '',
        keyword TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        images TEXT NOT NULL DEFAULT '[]',
        message_local_id INTEGER NOT NULL,
        message_sort_seq INTEGER NOT NULL,
        triggered_at INTEGER NOT NULL,
        callback_status TEXT NOT NULL DEFAULT 'pending',
        callback_at INTEGER,
        callback_error TEXT NOT NULL DEFAULT '',
        UNIQUE(task_id, message_local_id)
      )`)
      const originalExec = db.exec.bind(db)
      let injected = false
      ;(db as unknown as { exec: (sql: string) => void }).exec = (sql: string): void => {
        if (!injected && sql.includes('ADD COLUMN callback_lease_owner')) {
          injected = true
          originalExec(sql)
          originalExec(sql)
          return
        }
        originalExec(sql)
      }
      expect(() => ensureTaskSchema(db)).not.toThrow()
      const names = (db.prepare('PRAGMA table_info(task_triggers)').all() as Array<Record<string, unknown>>)
        .map((row) => String(row['name']))
      expect(names).toContain('callback_lease_owner')
      expect(names).toContain('callback_lease_until')
      expect(names).toContain('callback_lease_fence')
    } finally {
      db.close()
    }
  })

  it('migrates an old task_triggers table with lease defaults before claiming', async () => {
    seedFixture(true)
    const db = new DatabaseSync(taskDbPath(decrypted))
    try {
      const columns = new Map(
        (db.prepare('PRAGMA table_info(task_triggers)').all() as Array<Record<string, unknown>>)
          .map((row) => [String(row['name']), row]),
      )
      expect(columns.get('callback_lease_owner')?.['dflt_value']).toBe("''")
      expect(Number(columns.get('callback_lease_until')?.['dflt_value'])).toBe(0)
      expect(Number(columns.get('callback_lease_fence')?.['dflt_value'])).toBe(0)
    } finally {
      db.close()
    }

    await expect(dispatchTaskCallback(decrypted, decoded, triggerId, dispatchDeps(async () => (
      new Response('ok', { status: 200 })
    )), {
      owner: 'migrated',
      now: 5_000,
    })).resolves.toMatchObject({ ok: true, status: 'sent' })
  })
})
