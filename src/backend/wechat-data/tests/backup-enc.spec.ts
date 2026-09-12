/**
 * Encrypted backup round-trip: create .wcb, wrong password rejected, restore
 * reproduces the original decrypted files.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEncryptedBackup, listBackups, restoreEncryptedBackup } from '../src/query/backup.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-bkenc-'))
  scratch.push(base)
  return base
}

describe('encrypted backup', () => {
  it('creates, rejects a wrong password and restores the original files', async () => {
    const base = root()
    const dec = join(base, 'decrypted')
    mkdirSync(join(dec, 'session'), { recursive: true })
    writeFileSync(join(dec, 'session', 'session.db'), 'hello backup')

    const entry = await createEncryptedBackup(dec, 'pw123')
    expect(entry.kind).toBe('enc')
    const listed = listBackups(dec)
    expect(listed.items[0]?.kind).toBe('enc')

    const bad = restoreEncryptedBackup(dec, entry.name, 'wrong')
    expect(bad.ok).toBe(false)

    const good = restoreEncryptedBackup(dec, entry.name, 'pw123')
    expect(good.ok).toBe(true)
    expect(readFileSync(join(good.path as string, 'session', 'session.db'), 'utf8')).toBe('hello backup')
  })
})
