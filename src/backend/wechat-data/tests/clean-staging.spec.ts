/**
 * cleanStaleSnapshotLeftovers: startup sweep of interrupted-sync leftovers.
 *
 * 实现在 `query/snapshot-sidecars.ts`（2026-10-13 从 `sync.ts` 抽出：那条纪律的证据链
 * 与判据只有一份，而 `sync.ts` 贴着 1000 行硬上限）。本文件名保留不改 ——
 * `fixtures/ci/local-baseline.json` 按路径记着它的读数，改名要重采整份基线。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanStaleSnapshotLeftovers } from '../src/query/snapshot-sidecars.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

describe('cleanStaleSnapshotLeftovers', () => {
  it('removes .stage_src/.stage_wal/.decrypt_tmp recursively and keeps real files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-clean-'))
    scratch.push(root)
    const sub = join(root, 'message')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(root, 'config.json'), '{}')
    writeFileSync(join(sub, 'message_0.db'), 'real')
    writeFileSync(join(sub, 'message_0.db.stage_src'), 'x')
    writeFileSync(join(sub, 'message_0.db.stage_wal'), 'y')
    writeFileSync(join(sub, 'biz_message_0.db.decrypt_tmp'), 'z')
    await cleanStaleSnapshotLeftovers(root)
    expect(existsSync(join(root, 'config.json'))).toBe(true)
    expect(existsSync(join(sub, 'message_0.db'))).toBe(true)
    expect(existsSync(join(sub, 'message_0.db.stage_src'))).toBe(false)
    expect(existsSync(join(sub, 'message_0.db.stage_wal'))).toBe(false)
    expect(existsSync(join(sub, 'biz_message_0.db.decrypt_tmp'))).toBe(false)
  })

  /**
   * 非空 `-wal` 是「上一代残留」，启动时不可能有活写者持有它 ⇒ 白捡一次自愈
   * （成因与实测见 sync.ts#discardSupersededWal）。≤32B 的空 WAL 只是个头，
   * SQLite 本来就不当它有帧，删不删都行 —— 这条同时钉住「不去动它」。
   */
  it('清掉上一代残留的非空 -wal/-shm，但不动空 WAL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-clean-'))
    scratch.push(root)
    const sub = join(root, 'message')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'message_0.db'), 'real')
    writeFileSync(join(sub, 'message_0.db-wal'), Buffer.alloc(4096, 7))
    writeFileSync(join(sub, 'message_0.db-shm'), Buffer.alloc(32768, 7))
    writeFileSync(join(sub, 'session.db'), 'real')
    writeFileSync(join(sub, 'session.db-wal'), Buffer.alloc(32))
    await cleanStaleSnapshotLeftovers(root)
    expect(existsSync(join(sub, 'message_0.db-wal'))).toBe(false)
    expect(existsSync(join(sub, 'message_0.db-shm'))).toBe(false)
    expect(existsSync(join(sub, 'message_0.db'))).toBe(true)
    expect(existsSync(join(sub, 'session.db-wal'))).toBe(true)
  })

  it('is a no-op on a missing directory', async () => {
    const missing = join(tmpdir(), 'wx-nope-' + String(Date.now()))
    await expect(cleanStaleSnapshotLeftovers(missing)).resolves.toBeUndefined()
  })
})
