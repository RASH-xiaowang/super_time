/**
 * Realtime-sync key resolution across all_keys.json dialects.
 * @vitest-environment node
 */
import { pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveEncKeyCached, resolveShardKey } from '../src/query/sync.ts'

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

const KEY_HEX = '4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34'
const FALLBACK = '1122334455667788990011223344556677889900112233445566778899001122'

/** Temp data root with an all_keys.json beside the decrypted dir. */
function makeRoot(allKeys: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-key-'))
  scratch.push(root)
  if (allKeys !== null) writeFileSync(join(root, 'all_keys.json'), JSON.stringify(allKeys))
  return root
}

describe('resolveShardKey', () => {
  it('reads the DSH-generated `key` field', () => {
    const root = makeRoot({ 'message/message_0.db': { key: KEY_HEX } })
    expect(resolveShardKey(join(root, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(KEY_HEX)
  })

  it('reads the st_control `enc_key` field when `key` is absent', () => {
    const root = makeRoot({ 'message/message_0.db': { enc_key: KEY_HEX, salt: 'aa' } })
    expect(resolveShardKey(join(root, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(KEY_HEX)
  })

  it('prefers `key` over `enc_key` when both exist', () => {
    const root = makeRoot({ 'message/message_0.db': { key: KEY_HEX, enc_key: FALLBACK } })
    expect(resolveShardKey(join(root, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(KEY_HEX)
  })

  it('falls back to the config key when no entry matches', () => {
    const root = makeRoot({ 'session/session.db': { enc_key: KEY_HEX } })
    expect(resolveShardKey(join(root, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(FALLBACK)
  })

  it('rejects non-64-hex values from either field', () => {
    const root = makeRoot({ 'message/message_0.db': { enc_key: 'not-hex' } })
    expect(resolveShardKey(join(root, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(FALLBACK)
  })

  it('falls back when all_keys.json is missing or malformed', () => {
    const missing = makeRoot(null)
    expect(resolveShardKey(join(missing, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(FALLBACK)
    const broken = mkdtempSync(join(tmpdir(), 'wx-key-'))
    scratch.push(broken)
    writeFileSync(join(broken, 'all_keys.json'), '{broken')
    expect(resolveShardKey(join(broken, 'decrypted'), 'message/message_0.db', FALLBACK)).toBe(FALLBACK)
  })
})

describe('deriveEncKeyCached', () => {
  it('returns the same derived key from cache on repeat calls (no re-PBKDF2)', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-key-'))
    scratch.push(root)
    const raw = join(root, 'raw.db')
    const salt = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) salt[i] = i + 1
    const file = Buffer.concat([salt, Buffer.alloc(16, 0xaa)])
    writeFileSync(raw, file)

    const first = deriveEncKeyCached(root, 'message/message_0.db', raw, KEY_HEX, 'wx_key_v4.1')
    const second = deriveEncKeyCached(root, 'message/message_0.db', raw, KEY_HEX, 'wx_key_v4.1')
    const expected = pbkdf2Sync(Buffer.from(KEY_HEX, 'hex'), salt, 256000, 32, 'sha512')
    expect(first.equals(expected)).toBe(true)
    expect(second).toBe(first)
  })

  it('re-derives when the raw file salt changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-key-'))
    scratch.push(root)
    const raw = join(root, 'raw.db')
    writeFileSync(raw, Buffer.concat([Buffer.alloc(16, 0x11), Buffer.alloc(16, 0xaa)]))
    const withSaltA = deriveEncKeyCached(root, 'session/session.db', raw, KEY_HEX, 'wx_key_v4.1')
    writeFileSync(raw, Buffer.concat([Buffer.alloc(16, 0x22), Buffer.alloc(16, 0xaa)]))
    const withSaltB = deriveEncKeyCached(root, 'session/session.db', raw, KEY_HEX, 'wx_key_v4.1')
    expect(withSaltA.equals(withSaltB)).toBe(false)
  })
})
