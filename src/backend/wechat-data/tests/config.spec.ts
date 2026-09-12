/**
 * Raw WeChat db_storage resolution for the realtime sync loop.
 * @vitest-environment node
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRawDbDir } from '../src/query/config.ts'

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/** Temp data root: <root>/config.json + <root>/all_keys.json beside <root>/decrypted. */
function makeRoot(files: { config?: unknown; allKeys?: unknown }): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-cfg-'))
  scratch.push(root)
  if (files.config !== undefined) writeFileSync(join(root, 'config.json'), JSON.stringify(files.config))
  if (files.allKeys !== undefined) writeFileSync(join(root, 'all_keys.json'), JSON.stringify(files.allKeys))
  return root
}

describe('resolveRawDbDir', () => {
  it('prefers config.json db_dir over all_keys.json and the env pin', () => {
    const root = makeRoot({
      config: { db_dir: 'C:/cfg/db_storage' },
      allKeys: { _db_dir: 'C:/keys/db_storage' },
    })
    const env = { DSH_WECHAT_BASE_DIR: 'C:/pinned' }
    expect(resolveRawDbDir(join(root, 'decrypted'), env)).toBe('C:/cfg/db_storage')
  })

  it('falls back to all_keys.json _db_dir when config.json has no db_dir', () => {
    const root = makeRoot({ config: { key_format: 'wx_key_v4.1' }, allKeys: { _db_dir: 'C:/keys/db_storage' } })
    expect(resolveRawDbDir(join(root, 'decrypted'), {})).toBe('C:/keys/db_storage')
  })

  it('falls back to DSH_WECHAT_BASE_DIR + db_storage when both files are missing', () => {
    const root = makeRoot({})
    const env = { DSH_WECHAT_BASE_DIR: 'C:/accounts/wxid_abc' }
    expect(resolveRawDbDir(join(root, 'decrypted'), env)).toBe(resolve(join('C:/accounts/wxid_abc', 'db_storage')))
  })

  it('returns empty when every source is missing', () => {
    const root = makeRoot({})
    expect(resolveRawDbDir(join(root, 'decrypted'), {})).toBe('')
  })

  it('ignores a blank db_dir and keeps falling through', () => {
    const root = makeRoot({ config: { db_dir: '   ' }, allKeys: { _db_dir: 'C:/keys/db_storage' } })
    expect(resolveRawDbDir(join(root, 'decrypted'), {})).toBe('C:/keys/db_storage')
  })

  it('treats an invalid all_keys.json as absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-cfg-'))
    scratch.push(root)
    writeFileSync(join(root, 'all_keys.json'), '{not json')
    expect(resolveRawDbDir(join(root, 'decrypted'), {})).toBe('')
  })
})
