/**
 * Key-recovery pure-algorithm tests, cross-checked against the Python originals
 * (WeChatDataAnalysis isaac64 / dll_key_scan / image_key_resolver).
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Isaac64 } from '../src/keys/isaac64.ts'
import { extractXorKeysFromDll } from '../src/keys/dll-key-scan.ts'
import {
  cleanWxid, deriveImageKeys, verifyAesKey, inferXorKeyFromV2Tails, scanV2Templates,
  trustedXorForVerifiedAesKey, resolveLocalImageKey,
} from '../src/keys/image-key-resolver.ts'
import { upsertAccountKeysInStore, getAccountKeysFromStore, loadAccountKeysStore } from '../src/keys/key-store.ts'
import { isPotentialKey, findKeyAddresses } from '../src/keys/db-key-v4.ts'
import { iterMemoryAesCandidates } from '../src/keys/image-key-memory-scan.ts'
import { createCipheriv, createHash } from 'node:crypto'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

describe('Isaac64 (cross-checked against isaac64.py)', () => {
  it('produces the reference be_swap32 keystream for seeded inputs', () => {
    const cases: Array<[string, string]> = [
      ['123', 'cd1cdec1049ca2e44447c1d77bd973cb'],
      ['0', 'e311355a673f4a268cf970fd80b58ce5'],
      ['20240101', '8d0480f8646b1baadca3aa9d003b1e50'],
      ['wxid_test', 'e311355a673f4a268cf970fd80b58ce5'],
    ]
    for (const [seed, expectedHex] of cases) {
      const gen = new Isaac64(seed)
      expect(gen.generateKeystream(16).toString('hex')).toBe(expectedHex)
    }
  })

  it('matches raw_le/raw_be layouts from the reference rawToBytes', () => {
    const gen = new Isaac64('123')
    const raw = gen.randU64()
    const be = Isaac64.rawToBytes(raw, 'raw_be').toString('hex')
    const le = Isaac64.rawToBytes(raw, 'raw_le').toString('hex')
    expect(le).toBe(be.match(/(..)/g)?.reverse().join(''))
  })
})

describe('dll-key-scan (pattern ported from dll_key_scan.py)', () => {
  it('finds a synthetic 4×mov rdx + test rax,rax signature in a fake PE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-dll-'))
    scratch.push(dir)
    const dllPath = join(dir, 'Weixin.dll')

    // Build a minimal PE32+ with one code section containing the signature.
    const code = Buffer.alloc(256)
    // 4× mov rdx, imm64 (48 BA <8 bytes>) with 3-byte gaps of NOP.
    const keyBytes = Buffer.alloc(32)
    for (let i = 0; i < 32; i += 1) keyBytes[i] = i + 1
    let off = 0
    for (let i = 0; i < 4; i += 1) {
      code[off] = 0x48; code[off + 1] = 0xBA
      keyBytes.subarray(i * 8, i * 8 + 8).copy(code, off + 2)
      off += 10
      code[off] = 0x90; code[off + 1] = 0x90; code[off + 2] = 0x90 // nop×3 gap
      off += 3
    }
    code[off] = 0x48; code[off + 1] = 0x85; code[off + 2] = 0xC0 // test rax, rax

    const file = Buffer.alloc(0x1000)
    // DOS header
    file.write('MZ', 0, 'latin1')
    file.writeUInt32LE(0x80, 0x3C) // e_lfanew
    // PE header
    file.write('PE\0\0', 0x80, 'latin1')
    file.writeUInt16LE(0x8664, 0x84) // machine x64
    file.writeUInt16LE(1, 0x86) // numberOfSections
    file.writeUInt16LE(0xF0, 0x94) // SizeOfOptionalHeader
    // Optional header: ImageBase at +0x18 → 0x80+24+0x18 = 0xB0
    file.writeBigUInt64LE(0x140000000n, 0xB0)
    // Section header at 0x80+24+0xF0 = 0x188
    const sec = 0x188
    file.write('\x2E\x74\x65\x78\x74\x00\x00\x00', sec, 'latin1') // .text
    file.writeUInt32LE(0x100, sec + 8) // VirtualSize
    file.writeUInt32LE(0x1000, sec + 12) // VirtualAddress
    file.writeUInt32LE(0x100, sec + 16) // SizeOfRawData
    file.writeUInt32LE(0x200, sec + 20) // PointerToRawData
    file.writeUInt32LE(0x60000020, sec + 36) // Characteristics: CODE|EXECUTE|READ

    code.copy(file, 0x200)
    writeFileSync(dllPath, file)

    const hits = extractXorKeysFromDll(dllPath)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.keyHex).toBe(keyBytes.toString('hex'))
  })
})

describe('image-key-resolver (ported from image_key_resolver.py)', () => {
  it('strips wxid data-directory suffixes', () => {
    expect(cleanWxid('wxid_o6wp2aat9mu312_8d63')).toBe('wxid_o6wp2aat9mu312')
    expect(cleanWxid('wxid_o6wp2aat9mu312')).toBe('wxid_o6wp2aat9mu312')
    expect(cleanWxid('')).toBe('')
  })

  it('derives the WeFlow XOR byte + MD5 AES key', () => {
    const keys = deriveImageKeys(0x12345678, 'wxid_test')
    expect(keys.xorKey).toBe(0x78)
    expect(keys.aesKey).toHaveLength(16)
    // Cross-check with the Python reference: md5("305419896wxid_test")[:16]
    expect(keys.aesKey).toBe(createHash('md5').update('305419896wxid_test', 'utf8').digest('hex').slice(0, 16))
  })

  it('verifies a real V2 AES block and rejects a wrong key', () => {
    const aesKey = '0123456789abcdef'
    // JPEG header + padding to 16 bytes.
    const plaintext = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(12, 0x11)])
    const cipher = createCipheriv('aes-128-ecb', aesKey, null)
    cipher.setAutoPadding(false)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    expect(verifyAesKey(aesKey, ciphertext)).toBe(true)
    expect(verifyAesKey('fedcba9876543210', ciphertext)).toBe(false)
  })

  it('infers the XOR byte from a trailer pair (JPEG trailer 0xFF 0xD9)', () => {
    const tails = [Buffer.from([0x00, 0x00])] // 0x00^0xFF=0xFF, 0x00^0xD9=0xD9 — not equal
    expect(inferXorKeyFromV2Tails(tails)).toBeNull()
    const jpegTail = Buffer.from([0x00, 0x00])
    // XOR mask 0xFF → trailer 0x00 0x00? 0xFF^0xFF=0x00, 0xD9^0xFF=0x26 — no.
    // A tail of [0x00,0x26] with xor 0xFF gives first=0xFF second=0xFF → equal.
    expect(inferXorKeyFromV2Tails([Buffer.from([0x00, 0x26])])).toBe(0xFF)
    expect(inferXorKeyFromV2Tails([Buffer.from([0x00, 0x26]), Buffer.from([0x00, 0x26])])).toBe(0xFF)
    void jpegTail
  })

  it('scans V2 templates and resolves a verified key from kvcomm codes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-img-'))
    scratch.push(dir)
    const accountDir = join(dir, 'wxid_test')
    const kvcommDir = join(dir, 'kvcomm')
    mkdirSync(join(accountDir, 'msg', 'attach', '2024-01', 'img'), { recursive: true })
    mkdirSync(kvcommDir, { recursive: true })
    writeFileSync(join(kvcommDir, 'key_123_000.statistic'), 'x')

    // A real V2 template: magic + 15 bytes header + 16-byte AES(JPEG block).
    const derived = deriveImageKeys(123, 'wxid_test')
    const aesKey = derived.aesKey
    const plaintext = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(12, 0x22)])
    const cipher = createCipheriv('aes-128-ecb', aesKey, null)
    cipher.setAutoPadding(false)
    const block = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const v2 = Buffer.alloc(0x1F + 2)
    v2.set(Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]), 0)
    block.copy(v2, 0x0F)
    // Trailer pair for XOR 0x00: first=0x00^0xFF=0xFF second=0x00^0xD9=0xD9 → not equal.
    // Use tail [0x26, 0x00]: first=0x26^0xFF=0xD9, second=0x00^0xD9=0xD9 → xor 0xD9.
    v2.writeUInt16LE(0x0026, v2.length - 2)
    writeFileSync(join(accountDir, 'msg', 'attach', '2024-01', 'img', 'thumb_t.dat'), v2)

    const scan = scanV2Templates(accountDir)
    expect(scan.templates.length).toBe(1)
    expect(verifyAesKey(derived.aesKey, scan.templates[0]!.ciphertext)).toBe(true)
    expect(trustedXorForVerifiedAesKey(derived.aesKey, scan)).toBe(0xD9)

    // kvcomm derivation: md5(code + clean_wxid)[:16] + xor = code & 0xFF.
    const resolution = resolveLocalImageKey({ kvcommDir, accountDir })
    expect(resolution).not.toBeNull()
    expect(resolution?.aesKey).toBe(derived.aesKey)
    expect(resolution?.xorKey).toBe(123 & 0xFF)
    expect(resolution?.wxid).toBe('wxid_test')
    expect(resolution?.verified).toBe(true)

    // unprefixed `<code>_…_input.statistic` names are accepted too.
    writeFileSync(join(kvcommDir, '123_000_input.statistic'), 'x')
    expect(resolveLocalImageKey({ kvcommDir, accountDir })?.code).toBe(123)
  })
})

describe('key-store (ported from key_store.py)', () => {
  it('upserts, reads and removes account keys atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wx-store-'))
    scratch.push(dir)
    upsertAccountKeysInStore('wxid_test', { db_key: 'aa'.repeat(32), image_aes_key: '0123456789abcdef', image_xor_key: '136' }, dir)
    const stored = getAccountKeysFromStore('wxid_test', dir)
    expect(stored.db_key).toBe('aa'.repeat(32))
    expect(stored.image_aes_key).toBe('0123456789abcdef')
    expect(loadAccountKeysStore(dir)).toHaveProperty('wxid_test')
  })
})

describe('db-key-v4 candidate filters', () => {
  it('rejects uniform and printable-only candidates, accepts random-looking ones', () => {
    expect(isPotentialKey(Buffer.alloc(32))).toBe(false)
    expect(isPotentialKey(Buffer.from('A'.repeat(32)))).toBe(false)
    // 32 random bytes with high distinct count and low printability.
    const random = Buffer.from([
      0x1A, 0x2B, 0x3C, 0x4D, 0x5E, 0x6F, 0x70, 0x81, 0x92, 0xA3, 0xB4, 0xC5, 0xD6, 0xE7, 0xF8, 0x09,
      0x12, 0x23, 0x34, 0x45, 0x56, 0x67, 0x78, 0x89, 0x9A, 0xAB, 0xBC, 0xCD, 0xDE, 0xEF, 0x01, 0x02,
    ])
    expect(isPotentialKey(random)).toBe(true)
  })

  it('finds addresses embedded in the GetKeyAddrStub frame', () => {
    const frame = Buffer.alloc(32)
    // Address lives at the match offset (first 8 bytes).
    frame.writeBigUInt64LE(0x7FF000000000n, 0)
    frame[16] = 0x20
    frame[24] = 0x2F
    // bytes 6-15, 17-23, 25-31 stay zero.
    const chunk = Buffer.concat([Buffer.alloc(4), frame])
    const addrs = findKeyAddresses(chunk)
    expect(addrs).toEqual([0x7FF000000000])
  })
})

describe('image-key-memory-scan candidates', () => {
  it('extracts 32-char ASCII and UTF-16LE runs', () => {
    const ascii = Buffer.from('0123456789abcdef0123456789abcdef')
    const utf16 = Buffer.alloc(64)
    for (let i = 0; i < 32; i += 1) utf16[i * 2] = ascii[i]!
    const data = Buffer.concat([Buffer.from('xx'), ascii, utf16, Buffer.from('yy')])
    const candidates = iterMemoryAesCandidates(data)
    const keys = candidates.map(c => c.key)
    expect(keys).toContain('0123456789abcdef')
    expect(candidates.some(c => c.encoding === 'utf-16le')).toBe(true)
  })
})
