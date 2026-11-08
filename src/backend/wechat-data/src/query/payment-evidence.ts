/**
 * Evidence-backed red-packet state from local system messages.
 *
 * `redEnvelopeTable.hb_status/receive_status` values do not have a documented
 * mapping in this repository, and real rows have already contradicted the old
 * "hb_status=4 => returned" guess. Until an authoritative mapping exists, the
 * only safe claim state is one directly stated by a local WeChat system
 * message, such as `你领取了…红包` or `…领取了你的红包`.
 */
import { DatabaseSync } from './db-open.ts'
import { decompress } from 'fzstd'
import { shardCatalogDirs, shardCatalogSig } from './meta.ts'
import { yieldToLoop } from './search-build.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
const SEND_ID_RE = /(?:[?&]sendid=|sendid=)([^&"'<>\\\s]+)/i
const SYSTEM_TYPES = new Set([10000, 10002])

export interface RedpacketEvidence {
  /** Current account explicitly claimed the packet. */
  selfClaimed: ReadonlySet<string>
  /** Another participant explicitly claimed a packet sent by this account. */
  otherClaimed: ReadonlySet<string>
  /** A local system message explicitly states that a packet was returned. */
  returned: ReadonlySet<string>
  /** A local system message explicitly states that an outgoing packet was exhausted. */
  exhausted: ReadonlySet<string>
}

interface CacheEntry {
  sig: string
  promise: Promise<RedpacketEvidence>
}

const evidenceCache = new Map<string, CacheEntry>()

function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (!(v instanceof Uint8Array)) return ''
  let raw = Buffer.from(v)
  if (raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { raw = Buffer.from(decompress(raw)) } catch { /* keep original */ }
  }
  return raw.toString('utf8')
}

function low32(value: unknown): number {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return 0
  return n > 4294967295 ? n % 4294967296 : n
}

function addEvidence(target: Set<string>, text: string): void {
  const match = SEND_ID_RE.exec(text)
  if (match?.[1] !== undefined && match[1] !== '') target.add(match[1])
}

/**
 * Read explicit red-packet claim/return evidence once per message-shard
 * signature. The scan is intentionally limited to local system-message types;
 * ordinary chat text is never treated as payment proof.
 * @param decryptedDir - Decrypted WeChat data root.
 * @returns Sets of red-packet `sendid` values backed by local messages.
 */
export async function readRedpacketEvidence(decryptedDir: string): Promise<RedpacketEvidence> {
  const sig = shardCatalogSig(decryptedDir, ['message'])
  const cached = evidenceCache.get(decryptedDir)
  if (cached?.sig === sig) return cached.promise

  const promise = scanEvidence(decryptedDir)
  evidenceCache.set(decryptedDir, { sig, promise })
  try {
    return await promise
  } catch (error) {
    if (evidenceCache.get(decryptedDir)?.promise === promise) evidenceCache.delete(decryptedDir)
    throw error
  }
}

async function scanEvidence(decryptedDir: string): Promise<RedpacketEvidence> {
  const selfClaimed = new Set<string>()
  const otherClaimed = new Set<string>()
  const returned = new Set<string>()
  const exhausted = new Set<string>()

  for (const shard of shardCatalogDirs(decryptedDir, ['message'])) {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(shard.file, { readOnly: true, readBigInts: true })
    } catch {
      continue
    }
    try {
      for (const [table, meta] of shard.tables) {
        if (!meta.cols.has('local_type') || !meta.cols.has('message_content')) continue
        let rows: Array<Record<string, unknown>>
        try {
          rows = db.prepare(
            `SELECT local_type AS lt, message_content AS mc
             FROM "${table}"
             WHERE local_type = 10000 OR local_type = 10002
                OR (local_type % 4294967296) IN (10000, 10002)`,
          ).all() as Array<Record<string, unknown>>
        } catch {
          continue
        }
        for (const row of rows) {
          if (!SYSTEM_TYPES.has(low32(row['lt']))) continue
          const text = decodeCell(row['mc'])
          if (!text.includes('红包') && !text.includes('sendid=')) continue
          if (text.includes('你领取了')) addEvidence(selfClaimed, text)
          if (text.includes('领取了你的')) addEvidence(otherClaimed, text)
          if (text.includes('已被领完')) addEvidence(exhausted, text)
          if (/红包.*(?:退回|退还)|未领取.*退回|超过24小时未领取/.test(text)) addEvidence(returned, text)
        }
      }
    } finally {
      db.close()
    }
    // Keep the evidence scan cooperative with other panels.
    await yieldToLoop()
  }

  return {
    selfClaimed,
    otherClaimed,
    returned,
    exhausted,
  }
}
