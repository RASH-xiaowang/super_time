/**
 * Payment authoritative status (转账/红包) from general.db — richer than the
 * message XML: transferTable / redEnvelopeTable carry state + clocks.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface PaymentStatus {
  found: boolean
  kind?: 'transfer' | 'redpacket'
  serverId?: string
  /** transferTable */
  transfer?: {
    transferId: string
    paySubType: number
    receiver: string
    payer: string
    beginTime: number
    lastModifiedTime: number
    invalidTime: number
    delayConfirm: boolean
  }
  /** redEnvelopeTable */
  redpacket?: {
    sender: string
    hbStatus: number
    hbType: number
    receiveStatus: number
    sendId: string
  }
}

function readText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * Look up one payment record by its message server_id.
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @returns authoritative status (found=false when absent).
 */
export function queryPaymentStatus(decryptedDir: string, serverId: string): PaymentStatus {
  const dbPath = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(dbPath)) return { found: false }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const sid = serverId
    const t = db.prepare('SELECT transfer_id AS tid, pay_sub_type AS pst, pay_receiver AS rcv, pay_payer AS pay, begin_transfer_time AS bt, last_modified_time AS lmt, invalid_time AS it, delay_confirm_flag AS dcf FROM transferTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1').get(sid) as Record<string, unknown> | undefined
    if (t) {
      return {
        found: true,
        kind: 'transfer',
        serverId: sid,
        transfer: {
          transferId: readText(t.tid),
          paySubType: Number(t.pst ?? 0),
          receiver: readText(t.rcv),
          payer: readText(t.pay),
          beginTime: Number(t.bt ?? 0),
          lastModifiedTime: Number(t.lmt ?? 0),
          invalidTime: Number(t.it ?? 0),
          delayConfirm: Number(t.dcf ?? 0) !== 0,
        },
      }
    }
    const r = db.prepare('SELECT sender_user_name AS snd, hb_status AS hs, hb_type AS ht, receive_status AS rs, send_id AS sid2 FROM redEnvelopeTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1').get(sid) as Record<string, unknown> | undefined
    if (r) {
      return {
        found: true,
        kind: 'redpacket',
        serverId: sid,
        redpacket: {
          sender: readText(r.snd),
          hbStatus: Number(r.hs ?? 0),
          hbType: Number(r.ht ?? 0),
          receiveStatus: Number(r.rs ?? 0),
          sendId: readText(r.sid2),
        },
      }
    }
    return { found: false }
  } finally {
    db.close()
  }
}
