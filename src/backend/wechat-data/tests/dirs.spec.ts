/**
 * WeChat data-root resolution and one-time bootstrap.
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bootstrapWechatData,
  DATA_DIR_ENV,
  DECRYPTED_DIR_ENV,
  DEFAULT_SOURCE_DIR,
  resolveDecodedDir,
  resolveDecryptedDir,
  resolveSourceDir,
  resolveWechatDataRoot,
  SOURCE_DIR_ENV,
} from '../src/dirs.ts'

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.unstubAllEnvs()
})

/** Create a temp source tree shaped like st_control data/wechat. */
function makeSource(): string {
  const src = mkdtempSync(join(tmpdir(), 'wx-src-'))
  scratch.push(src)
  mkdirSync(join(src, 'decrypted', 'session'), { recursive: true })
  writeFileSync(join(src, 'decrypted', 'session', 'session.db'), 'sqlite-session')
  // A -wal runtime artifact must never be copied.
  writeFileSync(join(src, 'decrypted', 'session', 'session.db-wal'), 'wal')
  mkdirSync(join(src, 'decoded_images'))
  writeFileSync(join(src, 'decoded_images', 'a.png'), 'img')
  writeFileSync(join(src, 'config.json'), JSON.stringify({ db_dir: 'x' }))
  writeFileSync(join(src, 'message_edits.db'), 'edits')
  return src
}

function makeEnv(source: string, dataRoot?: string): Record<string, string> {
  const env: Record<string, string> = { [SOURCE_DIR_ENV]: source }
  if (dataRoot !== undefined) env[DATA_DIR_ENV] = dataRoot
  return env
}

describe('resolveWechatDataRoot', () => {
  it('prefers DSH_WECHAT_DATA_DIR over the DSH home default', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-root-'))
    scratch.push(root)
    const env = { [DATA_DIR_ENV]: root }
    expect(resolveWechatDataRoot(env)).toBe(resolve(root))
  })

  it('falls back to $DSH_HOME/wechat-data when the data-root env is unset', () => {
    const home = mkdtempSync(join(tmpdir(), 'wx-home-'))
    scratch.push(home)
    const env = { DSH_HOME: home }
    expect(resolveWechatDataRoot(env)).toBe(resolve(join(home, 'wechat-data')))
  })

  it('keeps DEFAULT_SOURCE_DIR empty (no legacy fallback path)', () => {
    expect(DEFAULT_SOURCE_DIR).toBe('')
  })
})

describe('resolveDecryptedDir / resolveDecodedDir', () => {
  it('pins to legacy overrides when set', () => {
    const env = { [DECRYPTED_DIR_ENV]: 'C:/pinned/decrypted' }
    expect(resolveDecryptedDir(env)).toBe(resolve('C:/pinned/decrypted'))
    expect(resolveDecodedDir({ [DECRYPTED_DIR_ENV]: '', DSH_WECHAT_DECODED_DIR: 'C:/pinned/decoded' })).toBe(resolve('C:/pinned/decoded'))
  })

  it('derives from the owned root otherwise', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-root-'))
    scratch.push(root)
    const env = { [DATA_DIR_ENV]: root }
    expect(resolveDecryptedDir(env)).toBe(join(resolve(root), 'decrypted'))
    expect(resolveDecodedDir(env)).toBe(join(resolve(root), 'decoded_images'))
  })
})

describe('resolveSourceDir', () => {
  it('uses the env override when present', () => {
    expect(resolveSourceDir({ [SOURCE_DIR_ENV]: 'C:/my/source' })).toBe(resolve('C:/my/source'))
  })

  it('is null when no env override is present', () => {
    expect(resolveSourceDir({})).toBeNull()
  })
})

describe('bootstrapWechatData', () => {
  it('copies decrypted, decoded_images and write stores once, skipping -wal/-shm', () => {
    const src = makeSource()
    const root = mkdtempSync(join(tmpdir(), 'wx-root-'))
    scratch.push(root)
    const env = makeEnv(src, root)
    const first = bootstrapWechatData(env)
    expect(first.copied).toEqual(expect.arrayContaining(['decrypted', 'decoded_images', 'config.json', 'message_edits.db']))
    expect(existsSync(join(root, 'decrypted', 'session', 'session.db'))).toBe(true)
    expect(existsSync(join(root, 'decrypted', 'session', 'session.db-wal'))).toBe(false)
    expect(readFileSync(join(root, 'decrypted', 'session', 'session.db'), 'utf8')).toBe('sqlite-session')
    expect(readFileSync(join(root, 'message_edits.db'), 'utf8')).toBe('edits')
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toContain('db_dir')

    // Idempotent: a second call copies nothing.
    const second = bootstrapWechatData(env)
    expect(second.copied).toEqual([])
    expect(second.skipped).toBe(true)
  })

  it('skips bootstrap when decrypted already exists in the root', () => {
    const src = makeSource()
    const root = mkdtempSync(join(tmpdir(), 'wx-root-'))
    scratch.push(root)
    mkdirSync(join(root, 'decrypted'), { recursive: true })
    writeFileSync(join(root, 'decrypted', 'marker'), 'exists')
    const result = bootstrapWechatData(makeEnv(src, root))
    expect(result.copied).toEqual([])
    expect(result.skipped).toBe(true)
  })

  it('skips bootstrap when a legacy decrypted-dir override is pinned', () => {
    const src = makeSource()
    const root = mkdtempSync(join(tmpdir(), 'wx-root-'))
    scratch.push(root)
    const env = { ...makeEnv(src, root), [DECRYPTED_DIR_ENV]: 'C:/pinned/decrypted' }
    const result = bootstrapWechatData(env)
    expect(result.copied).toEqual([])
    expect(result.skipped).toBe(true)
  })

  it('is a no-op when the source is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-root-'))
    scratch.push(root)
    const env = { [SOURCE_DIR_ENV]: join(root, 'no-such-source'), [DATA_DIR_ENV]: root }
    const result = bootstrapWechatData(env)
    expect(result.copied).toEqual([])
    expect(result.skipped).toBe(true)
  })
})
