/**
 * cleanStaleStagingFiles: startup sweep of interrupted-sync leftovers.
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanStaleStagingFiles } from '../src/query/sync.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

describe('cleanStaleStagingFiles', () => {
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
    await cleanStaleStagingFiles(root)
    expect(existsSync(join(root, 'config.json'))).toBe(true)
    expect(existsSync(join(sub, 'message_0.db'))).toBe(true)
    expect(existsSync(join(sub, 'message_0.db.stage_src'))).toBe(false)
    expect(existsSync(join(sub, 'message_0.db.stage_wal'))).toBe(false)
    expect(existsSync(join(sub, 'biz_message_0.db.decrypt_tmp'))).toBe(false)
  })

  it('is a no-op on a missing directory', async () => {
    const missing = join(tmpdir(), 'wx-nope-' + String(Date.now()))
    await expect(cleanStaleStagingFiles(missing)).resolves.toBeUndefined()
  })
})
