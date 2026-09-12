/**
 * Deterministic local image-key resolution compatible with WeFlow, migrated
 * from WeChatDataAnalysis `image_key_resolver.py`. A V2 image is the source
 * of truth: a kvcomm code and wxid are only returned after their derived AES
 * key decrypts a real V2 block to a supported image signature.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** V2 image magic. */
export const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
/** V2 ciphertext starts at this offset. */
export const V2_CIPHERTEXT_START = 0x0F
/** AES block size. */
export const AES_BLOCK_SIZE = 16
/** Max kvcomm code value. */
const MAX_CODE = 0xFFFFFFFF
/** Fallback traversal cap. */
const MAX_PREFERRED_DIRS = 2000
/** Fallback dirs skipped by name. */
const SKIPPED_FALLBACK_DIR_PARTS = ['thumb', 'emoticon']
/** Month dir regexp. */
const MONTH_DIR_RE = /^\d{4}-\d{2}$/

/** Derived image key pair. */
export interface DerivedImageKeys {
  /** XOR byte. */
  xorKey: number
  /** 16-char ASCII AES key. */
  aesKey: string
}

/** A V2 template file. */
export interface V2Template {
  /** Absolute template path. */
  path: string
  /** First AES block of ciphertext. */
  ciphertext: Buffer
  /** File mtime in ns. */
  mtimeNs: number
  /** Inferred XOR key from the trailer (may be null). */
  tailXorKey: number | null
  /** Raw 2-byte trailer. */
  tailBytes: Buffer
}

/** Result of scanning for V2 templates. */
export interface TemplateScanResult {
  /** Templates found, newest first. */
  templates: V2Template[]
  /** Most common XOR key across trailers. */
  inferredXorKey: number | null
  /** Whether the fallback traversal was used. */
  usedFallback: boolean
  /** Files scanned. */
  filesScanned: number
  /** Support count for the inferred XOR key. */
  xorSupport: number
}

/** Resolved image key. */
export interface ImageKeyResolution {
  /** kvcomm code. */
  code: number
  /** Clean wxid. */
  wxid: string
  /** XOR byte. */
  xorKey: number
  /** 16-char ASCII AES key. */
  aesKey: string
  /** Verified against a real V2 image. */
  verified: boolean
  /** Template path used for verification. */
  templatePath: string
  /** Inferred XOR key (may be null). */
  inferredXorKey: number | null
}

/**
 * Strip the data-directory suffix from a wxid (wxid_x_<suffix> → wxid_x).
 * @param value - raw account id.
 * @returns the cleaned wxid, or an empty string.
 */
export function cleanWxid(value: string | null | undefined): string {
  const candidate = (value == null ? '' : value).trim()
  if (candidate === '') return ''
  const match = /^(wxid_[^_]+)(?:_.+)$/i.exec(candidate)
  return match ? (match[1] ?? '') : candidate
}

/**
 * Derive WeFlow's XOR byte and 16-byte ASCII AES key.
 * @param code - kvcomm code (1..0xffffffff).
 * @param wxid - account wxid (suffix stripped).
 * @returns the derived key pair.
 * @throws when code or wxid are invalid.
 */
export function deriveImageKeys(code: number, wxid: string): DerivedImageKeys {
  if (typeof code !== 'number' || !Number.isInteger(code) || code <= 0 || code > MAX_CODE) {
    throw new Error('code must be an integer in the range 1..0xffffffff')
  }
  const cleanedWxid = cleanWxid(wxid)
  if (cleanedWxid === '') throw new Error('wxid must not be empty')
  const digest = createHash('md5').update(String(code) + cleanedWxid, 'utf8').digest('hex')
  return { xorKey: code & 0xFF, aesKey: digest.slice(0, 16) }
}

/** Decrypt one AES-ECB block. */
function decryptAesBlock(aesKey: string | Buffer, ciphertext: Buffer): Buffer | null {
  let keyBytes: Buffer
  try {
    keyBytes = typeof aesKey === 'string' ? Buffer.from(aesKey, 'ascii') : Buffer.from(aesKey)
  } catch {
    return null
  }
  if (keyBytes.length < AES_BLOCK_SIZE || ciphertext.length !== AES_BLOCK_SIZE) return null
  try {
    const decipher = createDecipheriv('aes-128-ecb', keyBytes.subarray(0, AES_BLOCK_SIZE), null)
    decipher.setAutoPadding(false)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return null
  }
}

/**
 * Detect the image format of a decrypted V2 block.
 * @param plaintext - decrypted first block.
 * @returns the detected format (jpeg/png/webp/wxgf/gif), or null.
 */
export function detectImageFormat(plaintext: Buffer | null): string | null {
  if (plaintext === null || plaintext.length === 0) return null
  if (plaintext.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) return 'jpeg'
  if (plaintext.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png'
  if (plaintext.subarray(0, 4).toString('latin1') === 'RIFF' && plaintext.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (plaintext.subarray(0, 4).toString('latin1').toLowerCase() === 'wxgf') return 'wxgf'
  if (plaintext.subarray(0, 5).toString('latin1').startsWith('GIF8')) return 'gif'
  return null
}

/**
 * Verify one AES key against the encrypted first block of a V2 image.
 * @param aesKey - 16-byte ASCII key (string or buffer).
 * @param ciphertext - first encrypted AES block.
 * @returns true when the block decrypts to a supported image signature.
 */
export function verifyAesKey(aesKey: string | Buffer, ciphertext: Buffer): boolean {
  return detectImageFormat(decryptAesBlock(aesKey, ciphertext)) !== null
}

/**
 * Infer XOR from the most common raw trailer pair, matching WeFlow.
 * @param tails - raw 2-byte trailer pairs.
 * @returns the inferred XOR byte, or null.
 */
export function inferXorKeyFromV2Tails(tails: Iterable<Buffer>): number | null {
  const counts = new Map<string, number>()
  for (const tail of tails) {
    if (tail.length !== 2) continue
    const key = tail.toString('hex')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  let best: string | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  if (best === null) return null
  const pair = Buffer.from(best, 'hex')
  const first = (pair[0] ?? 0) ^ 0xFF
  const second = (pair[1] ?? 0) ^ 0xD9
  return first === second ? first : null
}

/** Infer XOR with support count. */
function inferXorWithSupport(tails: Iterable<Buffer>): { xor: number | null; support: number } {
  const counts = new Map<string, number>()
  for (const tail of tails) {
    if (tail.length !== 2) continue
    const key = tail.toString('hex')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return { xor: null, support: 0 }
  let best: string | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  if (best === null) return { xor: null, support: 0 }
  const pair = Buffer.from(best, 'hex')
  const first = (pair[0] ?? 0) ^ 0xFF
  const second = (pair[1] ?? 0) ^ 0xD9
  return { xor: first === second ? first : null, support: bestCount }
}

/** List child directories of a path (best-effort). */
function listChildDirs(dir: string): string[] {
  const out: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(join(dir, entry.name))
    }
  } catch {
    return []
  }
  return out
}

/** Read a V2 template file's first block + trailer. */
function readV2Template(filePath: string): V2Template | null {
  try {
    const stat = statSync(filePath)
    const fd = readFileSync(filePath)
    const headerLen = V2_CIPHERTEXT_START + AES_BLOCK_SIZE
    if (fd.length < headerLen || !fd.subarray(0, V2_MAGIC.length).equals(V2_MAGIC)) return null
    const tailBytes = fd.subarray(fd.length - 2)
    return {
      path: filePath,
      ciphertext: Buffer.from(fd.subarray(V2_CIPHERTEXT_START, headerLen)),
      mtimeNs: stat.mtimeMs * 1_000_000,
      tailXorKey: inferXorKeyFromV2Tails([tailBytes]),
      tailBytes: Buffer.from(tailBytes),
    }
  } catch {
    return null
  }
}

/** Offer recent *_t.dat files into a max-heap (implemented as sorted list capped). */
function offerRecentTemplates(dir: string, capacity: number): V2Template[] {
  const out: V2Template[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.toLowerCase().endsWith('_t.dat') || !entry.isFile()) continue
      const tpl = readV2Template(join(dir, entry.name))
      if (tpl === null) continue
      out.push(tpl)
    }
  } catch {
    return out
  }
  out.sort((a, b) => b.mtimeNs - a.mtimeNs)
  return out.slice(0, capacity)
}

/**
 * Scan for recent V2 thumbnail templates under an account dir.
 * @param accountDir - WeChat account data dir (wxid_* folder).
 * @param limit - max templates to return.
 * @param maxFallbackDirs - cap for the fallback BFS.
 * @returns the template scan result.
 */
export function scanV2Templates(accountDir: string, limit = 32, maxFallbackDirs = 500): TemplateScanResult {
  if (limit <= 0) return { templates: [], inferredXorKey: null, usedFallback: false, filesScanned: 0, xorSupport: 0 }
  const discoveryCapacity = Math.max(limit * 4, 64)

  // Preferred: msg/attach/<date>/img/*_t.dat newest-first.
  const preferred: V2Template[] = []
  let visited = 0
  const attachRoot = join(accountDir, 'msg', 'attach')
  const attachDirs = listChildDirs(attachRoot)
  attachDirs.sort((a, b) => (statSync(b).mtimeMs || 0) - (statSync(a).mtimeMs || 0) || a.localeCompare(b))
  for (const attachDir of attachDirs) {
    if (visited >= MAX_PREFERRED_DIRS) break
    visited += 1
    const monthDirs = listChildDirs(attachDir).filter(d => MONTH_DIR_RE.test(d.split(/[\\/]/).pop() ?? ''))
    monthDirs.sort((a, b) => b.localeCompare(a))
    for (const monthDir of monthDirs) {
      if (visited >= MAX_PREFERRED_DIRS) break
      visited += 1
      for (const imgDir of listChildDirs(monthDir)) {
        if ((imgDir.split(/[\\/]/).pop() ?? '').toLowerCase() !== 'img') continue
        if (visited >= MAX_PREFERRED_DIRS) break
        visited += 1
        preferred.push(...offerRecentTemplates(imgDir, discoveryCapacity))
      }
    }
  }
  preferred.sort((a, b) => b.mtimeNs - a.mtimeNs)
  let templates = preferred.slice(0, limit)
  let filesScanned = preferred.length
  let usedFallback = false

  if (templates.length === 0 && maxFallbackDirs > 0) {
    usedFallback = true
    const queue = ['msg', 'cache', 'resource'].map(name => join(accountDir, name)).filter((d) => {
      try { return statSync(d).isDirectory() } catch { return false }
    })
    const fallback: V2Template[] = []
    let queueIndex = 0
    while (queueIndex < queue.length && queueIndex < maxFallbackDirs) {
      const directory = queue[queueIndex]
      if (directory === undefined) break
      queueIndex += 1
      fallback.push(...offerRecentTemplates(directory, discoveryCapacity))
      const children = listChildDirs(directory)
      children.sort((a, b) => a.localeCompare(b))
      for (const child of children) {
        const lower = (child.split(/[\\/]/).pop() ?? '').toLowerCase()
        if (SKIPPED_FALLBACK_DIR_PARTS.some(part => lower.includes(part))) continue
        if (queue.length >= maxFallbackDirs) break
        queue.push(child)
      }
    }
    fallback.sort((a, b) => b.mtimeNs - a.mtimeNs)
    templates = fallback.slice(0, limit)
    filesScanned += fallback.length
  }

  const { xor, support } = inferXorWithSupport(templates.map(t => t.tailBytes))
  return { templates, inferredXorKey: xor, usedFallback, filesScanned, xorSupport: support }
}

/**
 * Trusted XOR for a verified AES key across templates.
 * @param aesKey - candidate AES key.
 * @param templateData - V2 template scan or template list.
 * @returns the trusted XOR byte, or null.
 */
export function trustedXorForVerifiedAesKey(aesKey: string | Buffer, templateData: TemplateScanResult | V2Template[]): number | null {
  const templates = Array.isArray(templateData) ? templateData : templateData.templates
  if (templates.length === 0) return null
  const current = templates[0]
  if (current === undefined) return null
  if (detectImageFormat(decryptAesBlock(aesKey, current.ciphertext)) === null) return null
  const matching: number[] = []
  for (const template of templates) {
    if (detectImageFormat(decryptAesBlock(aesKey, template.ciphertext)) === 'jpeg' && template.tailXorKey !== null) {
      matching.push(template.tailXorKey)
    }
  }
  if (matching.length === 0) return null
  const counts = new Map<number, number>()
  for (const x of matching) counts.set(x, (counts.get(x) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [x, count] of counts) {
    if (count > bestCount) { best = x; bestCount = count }
  }
  return best
}

/** kvcomm cache file pattern: `key_<code>_…_input.statistic` (4.x) or `<code>_…_input.statistic`. */
const KVCOMM_FILE_RE = /^(?:key_)?(\d+)_.+\.statistic$/i

/**
 * Enumerate kvcomm codes from `*_input.statistic` file names in the WeChat 4.x
 * kvcomm cache dir (`%APPDATA%/Tencent/xwechat/net/kvcomm`).
 * @param kvcommDir - kvcomm cache directory.
 * @returns unique codes, empty when none.
 */
export function kvcommCodesFromDir(kvcommDir: string): number[] {
  const codes: number[] = []
  try {
    for (const entry of readdirSync(kvcommDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const match = KVCOMM_FILE_RE.exec(entry.name)
      if (!match) continue
      const code = parseInt(match[1] ?? '', 10)
      if (code > 0 && code <= MAX_CODE && !codes.includes(code)) codes.push(code)
    }
  } catch {
    return []
  }
  return codes
}

/**
 * Resolve the first code/wxid pair that passes real V2 AES validation.
 * @param opts - kvcomm dir, account dir and optional hints.
 * @returns the verified resolution, or null.
 */
export function resolveLocalImageKey(opts: {
  kvcommDir: string
  accountDir: string
  targetWxid?: string | null
  account?: string | null
  localNativeWxids?: Iterable<string> | string | null
  templateLimit?: number
  maxFallbackDirs?: number
}): ImageKeyResolution | null {
  const { kvcommDir, accountDir, targetWxid, account, localNativeWxids } = opts
  const templateLimit = opts.templateLimit ?? 32
  const maxFallbackDirs = opts.maxFallbackDirs ?? 500

  const codes = kvcommCodesFromDir(kvcommDir)
  if (codes.length === 0) return null

  const nativeValues: string[] = []
  if (typeof localNativeWxids === 'string') nativeValues.push(localNativeWxids)
  else if (localNativeWxids) nativeValues.push(...localNativeWxids)
  nativeValues.push(accountDir.split(/[\\/]/).pop() ?? '')

  const wxids: string[] = []
  const seen = new Set<string>()
  for (const raw of [targetWxid, account, ...nativeValues, 'unknown']) {
    const value = cleanWxid(raw)
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    wxids.push(value)
  }

  const templateData = scanV2Templates(accountDir, templateLimit, maxFallbackDirs)
  if (templateData.templates.length === 0) return null
  const current = templateData.templates[0]
  if (current === undefined) return null
  const currentXorKey = templateData.inferredXorKey !== null && templateData.xorSupport >= 2
    ? templateData.inferredXorKey
    : current.tailXorKey

  const orderedCodes = [...codes]
  if (currentXorKey !== null) {
    orderedCodes.sort((a, b) => ((a & 0xFF) !== currentXorKey ? 1 : 0) - ((b & 0xFF) !== currentXorKey ? 1 : 0))
  }

  for (const wxid of wxids) {
    for (const code of orderedCodes) {
      const keys = deriveImageKeys(code, wxid)
      if (!verifyAesKey(keys.aesKey, current.ciphertext)) continue
      return {
        code,
        wxid: cleanWxid(wxid),
        xorKey: keys.xorKey,
        aesKey: keys.aesKey,
        verified: true,
        templatePath: current.path,
        inferredXorKey: currentXorKey,
      }
    }
  }
  return null
}
