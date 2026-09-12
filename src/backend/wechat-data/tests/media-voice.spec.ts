/**
 * VoiceInfo lookup: 64-bit svr_id values must come back as text, never throw
 * node:sqlite's "value too large" error.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveVoiceInfo } from '../src/query/media-voice.ts'

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeMediaDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-voice-'))
  scratch.push(root)
  const dir = join(root, 'message')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'media_0.db'))
  db.exec('CREATE TABLE Name2Id (user_name TEXT)')
  db.exec('CREATE TABLE VoiceInfo (chat_name_id INTEGER, local_id INTEGER, svr_id INTEGER, voice_data BLOB, create_time INTEGER)')
  db.prepare('INSERT INTO Name2Id (user_name) VALUES (?)').run('wxid_test@chatroom')
  // 64-bit svr_id values exceeding Number.MAX_SAFE_INTEGER (literal, as INTEGER).
  db.prepare('INSERT INTO VoiceInfo (chat_name_id, local_id, svr_id, voice_data, create_time) VALUES (1, 3, 6939560591294896016, ?, 1000)').run(new Uint8Array([0x02, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
  db.prepare('INSERT INTO VoiceInfo (chat_name_id, local_id, svr_id, voice_data, create_time) VALUES (1, 4, 12345, ?, 900)').run(new Uint8Array([9, 8]))
  db.close()
  return root
}

describe('resolveVoiceInfo', () => {
  it('returns bigint svr_id as text instead of throwing', () => {
    const root = makeMediaDb()
    const r = resolveVoiceInfo(root, 'wxid_test@chatroom', 3)
    expect(r.available).toBe(true)
    expect(r.svrId).toBe('6939560591294896016')
    expect(r.length).toBe(10)
  })

  it('handles in-range svr_id too', () => {
    const root = makeMediaDb()
    const r = resolveVoiceInfo(root, 'wxid_test@chatroom', 4)
    expect(r.available).toBe(true)
    expect(r.svrId).toBe('12345')
    expect(r.length).toBe(2)
  })

  it('reports missing data without crashing', () => {
    const root = makeMediaDb()
    const r = resolveVoiceInfo(root, 'nobody@chatroom', 99)
    expect(r.available).toBe(false)
    expect(r.error).toMatch(/未找到语音数据/)
  })
})
