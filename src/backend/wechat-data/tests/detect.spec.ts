/**
 * Account detection: xwechat_files scan roots from defaults, per-user config
 * ini files, and the registry install path.
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectScanRoots, detectWechatAccounts } from '../src/query/config.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.unstubAllEnvs()
})

/** Create an xwechat_files root with one account dir (db_storage + message). */
function makeAccountRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-detect-'))
  scratch.push(root)
  const account = join(root, 'wxid_test123_8a1b')
  mkdirSync(join(account, 'db_storage', 'message'), { recursive: true })
  writeFileSync(join(account, 'db_storage', 'message', 'm.db'), 'x')
  return root
}

describe('detectWechatAccounts', () => {
  it('scans the given roots and normalizes the wxid instance suffix', () => {
    const root = makeAccountRoot()
    const accounts = detectWechatAccounts([root])
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      wxid: 'wxid_test123',
      db_dir: join(root, 'wxid_test123_8a1b', 'db_storage'),
    })
    expect(accounts[0]?.last_active).toEqual(expect.any(Number))
  })

  it('counts .db files under each account db_storage', () => {
    const root = makeAccountRoot()
    const dbDir = join(root, 'wxid_test123_8a1b', 'db_storage')
    writeFileSync(join(dbDir, 'session.db'), 'x')
    writeFileSync(join(dbDir, 'session.db-wal'), 'x')
    const accounts = detectWechatAccounts([root])
    expect(accounts[0]?.db_files).toBe(2)
  })

  it('ignores a root without any account db_storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-detect-'))
    scratch.push(root)
    expect(detectWechatAccounts([root])).toEqual([])
  })
})

describe('collectScanRoots', () => {
  it('adds per-user ini data bases from %APPDATA%/Tencent/xwechat/config', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-base-'))
    scratch.push(base)
    const configDir = join(base, 'Tencent', 'xwechat', 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'deadbeef.ini'), `${base}\n`)
    vi.stubEnv('APPDATA', base)

    const roots = collectScanRoots()
    expect(roots).toContain(join(base, 'xwechat_files'))
    expect(roots).toContain(base)
  })

  it('dedupes roots case-insensitively', () => {
    const base = mkdtempSync(join(tmpdir(), 'wx-base-'))
    scratch.push(base)
    const configDir = join(base, 'Tencent', 'xwechat', 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'deadbeef.ini'), `${base}\\xwechat_files\n`)
    vi.stubEnv('APPDATA', base)

    const roots = collectScanRoots()
    const lower = roots.map(root => root.toLowerCase())
    expect(new Set(lower).size).toBe(lower.length)
  })
})
