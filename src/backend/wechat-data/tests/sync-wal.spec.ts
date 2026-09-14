/**
 * decryptWalPatch: incremental WAL-frame patching of the decrypted snapshot.
 * Builds synthetic SQLCipher-4 pages and WAL frames (no real WeChat files).
 * @vitest-environment node
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicReplace, decryptWalPatch, walFramesPatchable } from '../src/query/sync.ts'

const PAGE_SZ = 4096
const RESERVE_SZ = 80
const WAL_HEADER_SZ = 32
const WAL_FRAME_HEADER_SZ = 24

/** Scratch dirs removed after each test. */
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

const KEY = Buffer.from('4304020f3020400d967181c0f2f68a45ae9eb6e806f442a2a96c470e7fb62e34', 'hex')

/** Encrypt one SQLCipher-4 page image: [enc][iv][64B hmac], page 1 salts aside. */
function encryptPage(plain: Buffer, pgno: number): Buffer {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', KEY, iv)
  cipher.setAutoPadding(false)
  const payload = pgno === 1 ? plain.subarray(16, PAGE_SZ - RESERVE_SZ) : plain.subarray(0, PAGE_SZ - RESERVE_SZ)
  const enc = Buffer.concat([cipher.update(payload), cipher.final()])
  const page = Buffer.alloc(PAGE_SZ)
  if (pgno === 1) plain.subarray(0, 16).copy(page, 0)
  enc.copy(page, pgno === 1 ? 16 : 0)
  iv.copy(page, PAGE_SZ - RESERVE_SZ)
  return page
}

/** Plain SQLite page: content in the first 4016 bytes, reserved tail zeroed. */
function plainPage(marker: number): Buffer {
  const page = Buffer.alloc(PAGE_SZ)
  page.fill(marker, 0, PAGE_SZ - RESERVE_SZ)
  return page
}

/** WAL header (32B) with the given salts. */
function walHeader(salt1: number, salt2: number): Buffer {
  const h = Buffer.alloc(WAL_HEADER_SZ)
  h.writeUInt32LE(0x377f0682, 0)
  h.writeUInt32LE(3_007_000, 4)
  h.writeUInt32LE(PAGE_SZ, 8)
  h.writeUInt32BE(salt1, 16)
  h.writeUInt32BE(salt2, 20)
  return h
}

/** WAL frame for pgno with the given salts and an encrypted page payload. */
function walFrame(pgno: number, salt1: number, salt2: number, encrypted: Buffer): Buffer {
  const h = Buffer.alloc(WAL_FRAME_HEADER_SZ)
  h.writeUInt32BE(pgno, 0)
  h.writeUInt32BE(1, 4)
  h.writeUInt32BE(salt1, 8)
  h.writeUInt32BE(salt2, 12)
  return Buffer.concat([h, encrypted])
}

/** Scratch file pair for one patch case. */
function makeFiles(wal: Buffer, targetSizePages: number): { walPath: string; targetPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wx-wal-'))
  scratch.push(dir)
  const walPath = join(dir, 'db-wal')
  const targetPath = join(dir, 'db')
  writeFileSync(walPath, wal)
  writeFileSync(targetPath, Buffer.alloc(PAGE_SZ * targetSizePages, 0xcc))
  return { walPath, targetPath }
}

describe('decryptWalPatch', () => {
  it('patches a salt-matching frame into the target page', async () => {
    const salt1 = 0xa1b2c3d4
    const salt2 = 0xe5f60718
    const plain = plainPage(0x42)
    const frame = walFrame(2, salt1, salt2, encryptPage(plain, 2))
    const { walPath, targetPath } = makeFiles(Buffer.concat([walHeader(salt1, salt2), frame]), 3)

    expect(await decryptWalPatch(walPath, targetPath, KEY)).toBe(1)
    const patched = readFileSync(targetPath).subarray(PAGE_SZ, PAGE_SZ * 2)
    expect(patched.subarray(0, PAGE_SZ - RESERVE_SZ).equals(plain.subarray(0, PAGE_SZ - RESERVE_SZ))).toBe(true)
    expect(patched.subarray(PAGE_SZ - RESERVE_SZ).equals(Buffer.alloc(RESERVE_SZ))).toBe(true)
    // Untouched pages keep their original bytes.
    expect(readFileSync(targetPath).subarray(0, PAGE_SZ).equals(Buffer.alloc(PAGE_SZ, 0xcc))).toBe(true)
  })

  it('skips frames whose salt epoch does not match the WAL header', async () => {
    const plain = plainPage(0x42)
    const frame = walFrame(2, 0xdeadbeef, 0x0badf00d, encryptPage(plain, 2))
    const { walPath, targetPath } = makeFiles(Buffer.concat([walHeader(0x11111111, 0x22222222), frame]), 3)
    const before = readFileSync(targetPath)

    expect(await decryptWalPatch(walPath, targetPath, KEY)).toBe(0)
    expect(readFileSync(targetPath).equals(before)).toBe(true)
  })

  it('ignores pgno 0 and out-of-range pages', async () => {
    const salt1 = 0x1234
    const salt2 = 0x5678
    const bad1 = walFrame(0, salt1, salt2, encryptPage(plainPage(1), 2))
    const bad2 = walFrame(2_000_000, salt1, salt2, encryptPage(plainPage(2), 2))
    const { walPath, targetPath } = makeFiles(Buffer.concat([walHeader(salt1, salt2), bad1, bad2]), 3)
    const before = readFileSync(targetPath)

    expect(await decryptWalPatch(walPath, targetPath, KEY)).toBe(0)
    expect(readFileSync(targetPath).equals(before)).toBe(true)
  })

  it('returns 0 for a header-only or missing WAL', async () => {
    const { walPath, targetPath } = makeFiles(walHeader(1, 2), 3)
    const before = readFileSync(targetPath)
    expect(await decryptWalPatch(walPath, targetPath, KEY)).toBe(0)
    expect(readFileSync(targetPath).equals(before)).toBe(true)
    const missing = join(mkdtempSync(join(tmpdir(), 'wx-wal-')), 'nope')
    scratch.push(join(missing, '..'))
    expect(await decryptWalPatch(missing, targetPath, KEY)).toBe(0)
  })
})

describe('walFramesPatchable', () => {
  it('true when at least one frame matches the header salt epoch', async () => {
    const s1 = 0xa1b2c3d4
    const s2 = 0xe5f60718
    const wal = Buffer.concat([
      walHeader(s1, s2),
      walFrame(2, s1, s2, encryptPage(plainPage(0x42), 2)),
    ])
    const dir = mkdtempSync(join(tmpdir(), 'wx-fp-'))
    scratch.push(dir)
    const p = join(dir, 'db-wal')
    writeFileSync(p, wal)
    expect(await walFramesPatchable(p)).toBe(true)
  })

  it('false when no frame matches the header salt epoch', async () => {
    const wal = Buffer.concat([
      walHeader(0x11111111, 0x22222222),
      walFrame(2, 0xdeadbeef, 0x0badf00d, encryptPage(plainPage(0x42), 2)),
    ])
    const dir = mkdtempSync(join(tmpdir(), 'wx-fp-'))
    scratch.push(dir)
    const p = join(dir, 'db-wal')
    writeFileSync(p, wal)
    expect(await walFramesPatchable(p)).toBe(false)
  })

  it('false for a header-only or missing WAL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-fp-'))
    scratch.push(dir)
    const p = join(dir, 'db-wal')
    writeFileSync(p, walHeader(1, 2))
    expect(await walFramesPatchable(p)).toBe(false)
    expect(await walFramesPatchable(join(dir, 'nope'))).toBe(false)
  })
})

describe('M4：快照替换期间目标必须始终存在', () => {
  it('替换过程不出现「目标不存在」的窗口', async () => {
    // 回归：旧实现是 `unlink(target)` + `rename(temp, target)`，两次系统调用之间
    // 目标文件不存在；并发只读查询正好落在那个窗口就是 ENOENT（用户看到「数据读不到」）。
    // Windows 实测：rename 覆盖一个已存在但未被打开的文件是允许的，所以不需要先删。
    const root = mkdtempSync(join(tmpdir(), 'atomic-replace-'))
    scratch.push(root)
    const target = join(root, 'message_0.db')
    const temp = join(root, 'temp.db')
    writeFileSync(target, 'OLD')
    writeFileSync(temp, 'NEW')

    let missing = 0
    let stop = false
    const watcher = (async () => {
      while (!stop) {
        if (!existsSync(target)) missing += 1
        await new Promise<void>((resolve) => { setImmediate(resolve) })
      }
    })()

    await atomicReplace(temp, target)
    stop = true
    await watcher

    expect(missing).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('NEW')
    expect(existsSync(temp)).toBe(false)
  })
})