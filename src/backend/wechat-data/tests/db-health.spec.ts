/**
 * Data health snapshot over a minimal root: decrypted SQLite walk + store sizes.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { queryDbHealth } from '../src/query/db-health.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

describe('queryDbHealth', () => {
  it('walks the decrypted tree and reports plugin stores', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-health-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    mkdirSync(join(dec, 'session'), { recursive: true })
    mkdirSync(join(root, 'decoded_images'), { recursive: true })
    writeFileSync(join(dec, 'session', 'session.db'), 'x'.repeat(100))
    writeFileSync(join(root, 'decoded_images', 'a.png'), 'img')
    writeFileSync(join(root, 'wechat_tasks.db'), 'taskdb')

    const snap = queryDbHealth(dec)
    expect(snap.dbFiles).toBe(1)
    expect(snap.dbBytes).toBe(100)
    expect(snap.stores.some(s => s.name === 'wechat_tasks.db' && s.size > 0)).toBe(true)
    expect(snap.decodedImagesCount).toBe(1)
  })
})
