/**
 * Effective image-key resolution: config.json wins, keys.json (key store)
 * is the fallback so auto-recovered keys work before the user saves config.
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveImageKeyPair } from '../src/query/image-key.ts'
import { saveConfig } from '../src/query/config.ts'
import { upsertAccountKeysInStore } from '../src/keys/key-store.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function dataRoot(): { root: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-imgkey-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted)
  return { root, decrypted }
}

describe('resolveImageKeyPair', () => {
  it('falls back to the key store when config.json has no image key', () => {
    const { root, decrypted } = dataRoot()
    upsertAccountKeysInStore('default', { image_aes_key: 'e57c869f15dd8764', image_xor_key: '60', image_key_verified: true }, root)
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBe('e57c869f15dd8764')
    expect(img.xorKey).toBe(60)
  })

  it('prefers config.json over the key store', () => {
    const { root, decrypted } = dataRoot()
    upsertAccountKeysInStore('default', { image_aes_key: 'e57c869f15dd8764', image_xor_key: '60', image_key_verified: true }, root)
    saveConfig(decrypted, { image_aes_key: 'cccccccccccccccc', image_xor_key: 0xab })
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBe('cccccccccccccccc')
    expect(img.xorKey).toBe(0xab)
  })

  it('returns empty key + default xor when neither source has an image key', () => {
    const { decrypted } = dataRoot()
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBe('')
    expect(img.xorKey).toBe(136)
  })
})
