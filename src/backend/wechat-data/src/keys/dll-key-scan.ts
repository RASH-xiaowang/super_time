/**
 * Static scan of Weixin.dll for the 32-byte internal DB key used by V4 key
 * recovery, migrated from WeChatDataAnalysis `dll_key_scan.py`. The x64
 * signature is the WeFlow/scan.py pattern: four consecutive
 * `mov rdx, imm64` immediates followed by `test rax, rax`; the four
 * immediates concatenated are the XOR-masked internal DB key.
 */
import { readFileSync, statSync } from 'node:fs'

/** PE32+ optional-header SizeOfOptionalHeader is 0xF0; we read it from the file. */
/** mov rdx, imm64 opcode bytes. */
const MOV_RDX = Buffer.from([0x48, 0xBA])
/** test rax, rax opcode bytes. */
const TEST_RAX_RAX = Buffer.from([0x48, 0x85, 0xC0])
/** PE code-section characteristic. */
const CODE_SECTION_CHARACTERISTIC = 0x20000000
/** Chunk size for sequential scanning. */
const CHUNK_SIZE = 2 * 1024 * 1024
/** Overlap retained across chunk boundaries. */
const OVERLAP_SIZE = 100

/** One found internal-key candidate. */
export interface DllKeyCandidate {
  /** Virtual address of the signature start (hex string). */
  va: string
  /** File offset of the signature start (hex string). */
  fileOffset: string
  /** Space-separated uppercase hex bytes (display form). */
  key: string
  /** Lowercase hex key (32 bytes → 64 chars). */
  keyHex: string
}

/**
 * Match the 4×mov rdx + test rax,rax signature at a chunk offset. Between
 * consecutive `mov rdx, imm64` (10 bytes each) and before the tail there is
 * a 3..8 byte gap of unrelated instructions.
 * @param buf - chunk buffer.
 * @param start - candidate offset of the first `48 BA`.
 * @returns the concatenated 32-byte key, or null when the pattern fails.
 */
function matchKeyAt(buf: Buffer, start: number): Buffer | null {
  let offset = start
  const parts: Buffer[] = []
  for (let i = 0; i < 4; i += 1) {
    if (!MOV_RDX.equals(buf.subarray(offset, offset + 2))) return null
    if (offset + 10 > buf.length) return null
    parts.push(buf.subarray(offset + 2, offset + 10))
    offset += 10
    if (i < 3) {
      // Between the first three movs: 3..8 bytes of other instructions.
      const next = buf.indexOf(MOV_RDX, offset)
      if (next === -1) return null
      const gap = next - offset
      if (gap < 3 || gap > 8) return null
      offset = next
    }
  }
  // Tail after the fourth mov: test rax, rax within 3..8 bytes.
  const tail = buf.indexOf(TEST_RAX_RAX, offset)
  if (tail === -1) return null
  const tailGap = tail - offset
  if (tailGap < 3 || tailGap > 8) return null
  return Buffer.concat(parts)
}

/**
 * Scan one chunk for the internal-key signature.
 * @param buf - chunk data (with overlap).
 * @param chunkSize - real chunk length (without overlap).
 * @returns candidate keys in scan order.
 */
function scanChunk(buf: Buffer, chunkSize: number): Buffer[] {
  const out: Buffer[] = []
  let offset = 0
  while (offset < chunkSize) {
    const idx = buf.indexOf(MOV_RDX, offset)
    if (idx === -1 || idx >= chunkSize) break
    const key = matchKeyAt(buf, idx)
    if (key !== null && key.length === 32) out.push(key)
    offset = idx + 1
  }
  return out
}

/**
 * Extract all internal-key candidates from a Weixin.dll file.
 * @param dllPath - path to Weixin.dll.
 * @returns candidates sorted by virtual address.
 */
export function extractXorKeysFromDll(dllPath: string): DllKeyCandidate[] {
  const stat = statSync(dllPath)
  if (stat.size < 0x400) return []
  const file = readFileSync(dllPath)

  // PE header: e_lfanew at 0x3C.
  const peOffset = file.readUInt32LE(0x3C)
  if (peOffset + 24 > file.length) return []
  if (file.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') return []

  const imageBase = Number(file.readBigUInt64LE(peOffset + 24 + 0x18))
  const numberOfSections = file.readUInt16LE(peOffset + 6)
  const sizeOfOptionalHeader = file.readUInt16LE(peOffset + 20)
  const sectionsStart = peOffset + 24 + sizeOfOptionalHeader
  const candidates: DllKeyCandidate[] = []

  for (let i = 0; i < numberOfSections; i += 1) {
    const entry = sectionsStart + i * 40
    if (entry + 40 > file.length) break
    const characteristics = file.readUInt32LE(entry + 36)
    if ((characteristics & CODE_SECTION_CHARACTERISTIC) === 0) continue
    const virtualSize = file.readUInt32LE(entry + 8)
    const virtualAddress = file.readUInt32LE(entry + 12)
    const sizeOfRawData = file.readUInt32LE(entry + 16)
    const pointerToRawData = file.readUInt32LE(entry + 20)
    const rawSize = Math.min(sizeOfRawData, virtualSize > 0 ? virtualSize : sizeOfRawData)
    if (rawSize === 0) continue

    for (let chunkOffset = 0; chunkOffset < rawSize; chunkOffset += CHUNK_SIZE) {
      const chunkSize = Math.min(CHUNK_SIZE, rawSize - chunkOffset)
      const chunk = file.subarray(pointerToRawData + chunkOffset, pointerToRawData + chunkOffset + chunkSize + OVERLAP_SIZE)
      for (const key of scanChunk(chunk, chunkSize)) {
        const va = imageBase + virtualAddress + chunkOffset
        candidates.push({
          va: '0x' + va.toString(16).toUpperCase(),
          fileOffset: '0x' + (pointerToRawData + chunkOffset).toString(16).toUpperCase(),
          key: key.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim(),
          keyHex: key.toString('hex'),
        })
      }
    }
  }

  candidates.sort((a, b) => parseInt(a.va, 16) - parseInt(b.va, 16))
  return candidates
}
