/**
 * Realtime sync must include message/media_*.db: VoiceInfo is the source for
 * both voice playback and transcription.
 * @vitest-environment node
 */
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetSyncFailures } from '../src/query/sync-pacing.ts'
import { forgetFullDecryptCooldown, startRealtimeSync } from '../src/query/sync.ts'
import { forgetPendingSyncSourceState } from '../src/query/sync-state.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const SALT_SZ = 16
const RAW_KEY = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'

const scratch: string[] = []
const disposers: Array<() => void> = []

beforeEach(() => {
  forgetSyncFailures()
  forgetFullDecryptCooldown()
  forgetPendingSyncSourceState()
})

afterEach(() => {
  for (const stop of disposers.splice(0)) stop()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Convert a small plain SQLite file to SQLCipher's 80-byte reserved layout. */
function toReservedLayout(plain: Buffer): Buffer {
  const out = Buffer.from(plain)
  out[20] = RESERVE_SZ
  for (let base = 0; base + PAGE_SZ <= out.length; base += PAGE_SZ) {
    const header = base + (base === 0 ? 100 : 0)
    const cells = out.readUInt16BE(header + 3)
    const contentStart = out.readUInt16BE(header + 5)
    if (contentStart === 0) continue
    const ptr = header + 8
    for (let i = 0; i < cells; i += 1) {
      out.writeUInt16BE(out.readUInt16BE(ptr + i * 2) - RESERVE_SZ, ptr + i * 2)
    }
    out.writeUInt16BE(contentStart - RESERVE_SZ, header + 5)
    out.copy(out, base + contentStart - RESERVE_SZ, base + contentStart, base + PAGE_SZ)
    out.fill(0, base + PAGE_SZ - RESERVE_SZ, base + PAGE_SZ)
  }
  return out
}

/** Encrypt plain SQLite pages into the SQLCipher-4 page layout used by WeChat. */
function encryptSqlite(plain: Buffer): Buffer {
  const pages = Math.ceil(plain.length / PAGE_SZ)
  const out = Buffer.alloc(pages * PAGE_SZ)
  plain.copy(out, 0)
  const salt = randomBytes(SALT_SZ)
  salt.copy(out, 0)
  const encKey = pbkdf2Sync(Buffer.from(RAW_KEY, 'hex'), salt, 256_000, 32, 'sha512')
  for (let pgno = 1; pgno <= pages; pgno += 1) {
    const base = (pgno - 1) * PAGE_SZ
    const iv = randomBytes(16)
    const from = base + (pgno === 1 ? SALT_SZ : 0)
    const to = base + PAGE_SZ - RESERVE_SZ
    const cipher = createCipheriv('aes-256-cbc', encKey, iv)
    cipher.setAutoPadding(false)
    const encrypted = Buffer.concat([cipher.update(out.subarray(from, to)), cipher.final()])
    encrypted.copy(out, from)
    iv.copy(out, to)
  }
  return out
}

function makeFixture(): { root: string; raw: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-sync-media-voice-'))
  scratch.push(root)
  const raw = join(root, 'raw')
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(raw, 'message'), { recursive: true })
  mkdirSync(join(decrypted, 'message'), { recursive: true })

  const plainPath = join(root, 'media-plain.db')
  const db = new DatabaseSync(plainPath)
  db.exec('PRAGMA page_size = 4096')
  db.exec('CREATE TABLE Name2Id (user_name TEXT)')
  db.exec('CREATE TABLE VoiceInfo (chat_name_id INTEGER, local_id INTEGER, svr_id INTEGER, voice_data BLOB, create_time INTEGER)')
  db.prepare('INSERT INTO Name2Id (user_name) VALUES (?)').run('voice@chatroom')
  db.exec("INSERT INTO VoiceInfo VALUES (1, 80, 7159402480703923277, X'020102', 1792569845)")
  db.close()

  writeFileSync(
    join(raw, 'message', 'media_0.db'),
    encryptSqlite(toReservedLayout(readFileSync(plainPath))),
  )
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    db_enc_key: RAW_KEY,
    key_format: 'wx_key_v4.1',
  }), 'utf8')
  return { root, raw, decrypted }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  return predicate()
}

describe('realtime media shard sync', () => {
  it('publishes new VoiceInfo rows from message/media_0.db', async () => {
    const { raw, decrypted } = makeFixture()
    const seen: string[] = []
    disposers.push(startRealtimeSync(
      () => raw,
      () => decrypted,
      (items) => { seen.push(...items) },
    ))

    const target = join(decrypted, 'message', 'media_0.db')
    expect(await waitFor(() => {
      if (!seen.some((item) => item.startsWith('message/media_0.db:full'))) return false
      try {
        const db = new DatabaseSync(target, { readOnly: true })
        const row = db.prepare("SELECT CAST(svr_id AS TEXT) AS svr_id FROM VoiceInfo WHERE local_id = 80").get() as { svr_id?: string } | undefined
        db.close()
        return row?.svr_id === '7159402480703923277'
      } catch {
        return false
      }
    })).toBe(true)
  })
})
