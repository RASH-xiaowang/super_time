/**
 * Payment authoritative status (转账/红包) from general.db — richer than the
 * message XML: transferTable / redEnvelopeTable carry state + clocks.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { withDb } from './db-open.ts'

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

/** 转账主表（`message_server_id` 在库里可能是整数，比较一律转文本）。 */
const TRANSFER_SQL = 'SELECT transfer_id AS tid, pay_sub_type AS pst, pay_receiver AS rcv, pay_payer AS pay, begin_transfer_time AS bt, last_modified_time AS lmt, invalid_time AS it, delay_confirm_flag AS dcf FROM transferTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1'
/** 红包主表。 */
const RED_SQL = 'SELECT sender_user_name AS snd, hb_status AS hs, hb_type AS ht, receive_status AS rs, send_id AS sid2 FROM redEnvelopeTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1'

/**
 * 每个「数据根 × 表」只提醒一次：快照里没有这张表是常见形态（这台机器没用过支付），
 * 而支付状态是按单查的 —— 不开这盏灯就会刷屏，开了又不许让「空白」变得查不出原因。
 */
const missingTableWarned = new Set<string>()

/**
 * 取一行，把「这张表不存在」与「真的读失败」分开处理。
 *
 * `no such table` 是**结构事实**：这份解密快照里根本没有支付记录，那么被查的这个
 * server_id 当然是 `found: false` —— 这不是把读失败画成没数据（P1-1 禁的是后者）。
 * 其它错误（库损坏、打不开…）原样抛出，让调用方看见真实原因。
 * @param db - 已打开的只读连接。
 * @param sql - 查询语句。
 * @param sid - `message_server_id`（字符串，可能超过 2^53）。
 * @param decryptedDir - 数据根（只用于提醒的去重键）。
 */
function getRow(db: DatabaseSync, sql: string, sid: string, decryptedDir: string): Record<string, unknown> | undefined {
  try {
    return db.prepare(sql).get(sid) as Record<string, unknown> | undefined
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (/no such table/i.test(msg)) {
      const table = /no such table: (\S+)/.exec(msg)?.[1] ?? 'unknown'
      const key = `${decryptedDir}|${table}`
      if (!missingTableWarned.has(key)) {
        if (missingTableWarned.size >= 64) missingTableWarned.clear()
        missingTableWarned.add(key)
        console.warn('[wechat-payments] 解密快照里没有', table, '—— 该机器无支付记录，按「查无此单」处理')
      }
      return undefined
    }
    throw e
  }
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
  // 一次性只读连接由 `withDb` 拥有（P0-1 的口径：不要在 catch/早退分支里自己 close）
  return withDb<PaymentStatus>(dbPath, (db) => {
    const sid = serverId
    const t = getRow(db, TRANSFER_SQL, sid, decryptedDir)
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
    const r = getRow(db, RED_SQL, sid, decryptedDir)
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
  })
}
