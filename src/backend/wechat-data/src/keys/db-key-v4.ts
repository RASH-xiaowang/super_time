/**
 * V4 database-key recovery from the WeChat process, migrated from
 * WeChatDataAnalysis `key_v4.py`. Pipeline:
 *
 * 1. Find candidate addresses via the GetKeyAddrStub YARA rule (a 32-byte
 *    pattern whose final 8 bytes are the address of a candidate key).
 * 2. Read 32 bytes at each address.
 * 3. Filter candidates by entropy/printability.
 * 4. Verify each candidate against the first page of a real encrypted DB
 *    using the SQLCipher PBKDF2-HMAC-SHA512 + AES check (reuses
 *    `verifyDbKey` from ./db-key-verify.ts).
 *
 * The internal DB key (from Weixin.dll scanning) is XOR-unmasked onto the raw
 * candidate before verification, exactly like the Python original.
 */
import { readFileSync } from 'node:fs'
import { readProcessMemory, enumerateScannableRegions } from './win32-memory.ts'
import { verifyDbKey } from './db-key-verify.ts'
import type { DbKeyResult } from './types.ts'

/** 32-byte key length. */
const KEY_SIZE = 32
/** SQLCipher first-page size. */
const PAGE_SIZE = 4096
/**
 * GetKeyAddrStub rule (from key_v4.py): a 32-byte frame whose fixed runs are
 * bytes 6-15 = 0x00, 16 = 0x20, 17-23 = 0x00, 24 = 0x2F, 25-31 = 0x00; the
 * first 6 bytes are wildcards. The 8-byte little-endian value AT THE MATCH
 * OFFSET is the candidate-key address.
 */
const STUB_FIXED = {
  /** index → required byte for every fixed position. */
  bytes: new Map<number, number>([
    [16, 0x20],
    [24, 0x2F],
  ]),
  /** zero-run ranges (inclusive) inside the frame. */
  zeroRuns: [[6, 15], [17, 23], [25, 31]] as const,
}

/** Read a little-endian u64 from a buffer. */
function readU64(data: Buffer, offset: number): number {
  return Number(data.readBigUInt64LE(offset))
}

/** Scan one memory chunk for the GetKeyAddrStub pattern (with 0x00 wildcards). */
/**
 * Scan a chunk for GetKeyAddrStub frames; address = u64 at the match offset.
 * @param chunk - memory chunk to scan.
 * @returns candidate key addresses found in the chunk.
 */
function findKeyAddresses(chunk: Buffer): number[] {
  const out: number[] = []
  for (let i = 0; i + 32 <= chunk.length; i += 1) {
    if (chunk[i + 16] !== 0x20 || chunk[i + 24] !== 0x2F) continue
    let ok = true
    for (const [from, to] of STUB_FIXED.zeroRuns) {
      for (let j = from; j <= to; j += 1) {
        if (chunk[i + j] !== 0x00) { ok = false; break }
      }
      if (!ok) break
    }
    if (!ok) continue
    const addr = readU64(chunk, i)
    if (addr > 0 && addr < 0x7FFF_FFFF_FFFF) out.push(addr)
  }
  return out
}

/**
 * Entropy/printability prefilter for 32-byte key candidates.
 * @param key - 32-byte candidate.
 * @returns true when the candidate looks like random key material.
 */
function isPotentialKey(key: Buffer): boolean {
  if (key.length !== KEY_SIZE) return false
  if (new Set(key).size < 15) return false
  let printable = 0
  for (const byte of key) {
    if (byte >= 32 && byte <= 126) printable += 1
  }
  return printable <= 24
}

/**
 * Scan a process's committed private memory for candidate key addresses.
 * @param pid - WeChat process id.
 * @returns candidate 32-byte keys (deduplicated).
 */
export async function scanProcessKeyCandidates(pid: number): Promise<Buffer[]> {
  const scan = await enumerateScannableRegions(pid)
  if (scan === null) return []
  const { api, handle, regions } = scan
  try {
    const addresses = new Set<number>()
    for (const region of regions) {
      // Private committed regions; read in 4 MiB chunks.
      const CHUNK = 4 * 1024 * 1024
      let offset = 0
      let trailing = Buffer.alloc(0)
      while (offset < region.size) {
        const size = Math.min(CHUNK, region.size - offset)
        const chunk = api.readMemory(handle, region.baseAddress + offset, size)
        if (chunk.length > 0) {
          const data = Buffer.concat([trailing, chunk])
          for (const addr of findKeyAddresses(data)) addresses.add(addr)
          trailing = data.subarray(-8)
        } else {
          trailing = Buffer.alloc(0)
        }
        offset += size
      }
    }
    const keys = new Map<string, Buffer>()
    for (const address of addresses) {
      const key = await readProcessMemory(pid, address, KEY_SIZE)
      if (key.length === KEY_SIZE) keys.set(key.toString('hex'), key)
    }
    return [...keys.values()]
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * Recover the V4 database key from a running WeChat process.
 * @param pid - WeChat main-process pid.
 * @param dbFilePath - path to one encrypted DB (first page used for verification).
 * @param internalDbKey - optional 32-byte internal key from Weixin.dll scanning (XOR mask).
 * @returns the recovered key as 64-hex, or an error.
 */
export async function recoverDbKeyV4(pid: number, dbFilePath: string, internalDbKey?: Buffer | null): Promise<DbKeyResult> {
  let page1: Buffer
  try {
    page1 = readFileSync(dbFilePath)
  } catch (e) {
    return { ok: false, error: '数据库文件不可读: ' + (e as Error).message }
  }
  if (page1.length < PAGE_SIZE) return { ok: false, error: '数据库文件太小，不是有效的 V4 加密库' }

  const rawCandidates = await scanProcessKeyCandidates(pid)
  if (rawCandidates.length === 0) return { ok: false, error: '进程内存中未找到密钥候选' }

  const filtered = rawCandidates.filter(isPotentialKey)
  // XOR-unmask raw candidates with the internal DB key, then verify.
  for (const candidate of filtered) {
    const testKey = internalDbKey && internalDbKey.length === KEY_SIZE
      ? Buffer.from(candidate.map((b, i) => b ^ (internalDbKey[i] ?? 0)))
      : candidate
    const { hmacOk, aesOk } = verifyDbKey(page1, testKey)
    if (hmacOk && aesOk) {
      // Return the UNMASKED raw key: SQLCipher verification and decryption
      // derive directly from the raw key (PBKDF2 with the page-1 salt), and
      // the configured db_enc_key is stored unmasked too — a masked candidate
      // would fail every later verify/decrypt round.
      return { ok: true, key: testKey.toString('hex'), source: 'key_v4_memory' }
    }
  }
  return { ok: false, error: '候选密钥均未通过 SQLCipher 校验' }
}

// Exported for tests.
export { isPotentialKey, findKeyAddresses, KEY_SIZE }
