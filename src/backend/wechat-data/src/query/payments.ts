/**
 * Payment authoritative status (转账/红包) from general.db — richer than the
 * message XML: transferTable / redEnvelopeTable carry state + clocks.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { contactMeta } from './meta.ts'
import { readRedpacketEvidence } from './payment-evidence.ts'

export interface PaymentStatus {
  found: boolean
  kind?: 'transfer' | 'redpacket'
  serverId?: string
  /** transferTable */
  transfer?: {
    transferId: string
    /** The id that actually matched (primary or secondary card). */
    matchedServerId: string
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
    senderName?: string
    senderEnterpriseName?: string
    hbStatus: number
    hbType: number
    receiveStatus: number
    sendId: string
    /**
     * Claim state proved by a local system message. When absent, the UI must
     * show the raw pair `(hbStatus, receiveStatus)` instead of guessing.
     */
    claimEvidence?: 'self-claimed' | 'other-claimed' | 'returned'
  }
}

function readText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** 红包主表。 */
const RED_SQL = 'SELECT sender_user_name AS snd, hb_status AS hs, hb_type AS ht, receive_status AS rs, send_id AS sid2 FROM redEnvelopeTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1'

/**
 * 每个「数据根 × 表」只提醒一次：快照里没有这张表是常见形态（这台机器没用过支付），
 * 而支付状态是按单查的 —— 不开这盏灯就会刷屏，开了又不许让「空白」变得查不出原因。
 */
const missingTableWarned = new Set<string>()

function warnMissingTable(decryptedDir: string, table: string): void {
  const key = `${decryptedDir}|${table}`
  if (missingTableWarned.has(key)) return
  if (missingTableWarned.size >= 64) missingTableWarned.clear()
  missingTableWarned.add(key)
  console.warn('[wechat-payments] 解密快照里没有', table, '—— 该机器无支付记录，按「查无此单」处理')
}

/**
 * Read a table's columns without treating "table missing" as a corrupt DB.
 * `PRAGMA table_info` returns an empty set for a missing table, so check
 * `sqlite_master` first to preserve the distinction.
 * @param db - open read-only connection.
 * @param table - exact table name.
 * @param decryptedDir - data root, used to de-duplicate the missing-table warning.
 * @returns Column names, or `null` when the table does not exist.
 */
function tableColumns(
  db: DatabaseSync,
  table: string,
  decryptedDir: string,
): Set<string> | null {
  const exists = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table)
  if (exists === undefined) {
    warnMissingTable(decryptedDir, table)
    return null
  }
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(row => row.name),
  )
}

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
function getRow(
  db: DatabaseSync,
  sql: string,
  params: string[],
  decryptedDir: string,
): Record<string, unknown> | undefined {
  try {
    return db.prepare(sql).get(...params) as Record<string, unknown> | undefined
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (/no such table/i.test(msg)) {
      const table = /no such table: (\S+)/.exec(msg)?.[1] ?? 'unknown'
      warnMissingTable(decryptedDir, table)
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
export async function queryPaymentStatus(decryptedDir: string, serverId: string): Promise<PaymentStatus> {
  const dbPath = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(dbPath) || serverId.trim() === '') return { found: false }
  // 一次性只读连接由 `withDb` 拥有（P0-1 的口径：不要在 catch/早退分支里自己 close）
  const base = withDb<PaymentStatus>(dbPath, (db) => {
    const sid = serverId
    const transferCols = tableColumns(db, 'transferTable', decryptedDir)
    const hasSecondary = transferCols?.has('second_message_server_id') ?? false
    const transferSql = `SELECT transfer_id AS tid,
      CAST(message_server_id AS TEXT) AS mid,
      ${hasSecondary ? 'CAST(second_message_server_id AS TEXT)' : "''"} AS sid2,
      pay_sub_type AS pst, pay_receiver AS rcv, pay_payer AS pay,
      begin_transfer_time AS bt, last_modified_time AS lmt, invalid_time AS it,
      delay_confirm_flag AS dcf
      FROM transferTable
      WHERE CAST(message_server_id AS TEXT) = ?
      ${hasSecondary ? 'OR CAST(second_message_server_id AS TEXT) = ?' : ''}
      LIMIT 1`
    const t = transferCols === null
      ? undefined
      : getRow(db, transferSql, hasSecondary ? [sid, sid] : [sid], decryptedDir)
    if (t) {
      const primary = readText(t.mid)
      const secondary = readText(t.sid2)
      const matchedServerId = primary === sid ? primary : secondary === sid ? secondary : sid
      return {
        found: true,
        kind: 'transfer',
        serverId: sid,
        transfer: {
          transferId: readText(t.tid),
          matchedServerId,
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
    const redCols = tableColumns(db, 'redEnvelopeTable', decryptedDir)
    const r = redCols === null
      ? undefined
      : getRow(db, RED_SQL, [sid], decryptedDir)
    if (r) {
      const sender = readText(r.snd)
      const meta = contactMeta(decryptedDir)
      const senderName = meta.names.get(sender)?.trim()
      const senderEnterpriseName = meta.enterpriseNames.get(sender)?.trim()
      return {
        found: true,
        kind: 'redpacket',
        serverId: sid,
        redpacket: {
          sender,
          ...(senderName !== undefined && senderName !== '' ? { senderName } : {}),
          ...(senderEnterpriseName !== undefined && senderEnterpriseName !== ''
            ? { senderEnterpriseName }
            : {}),
          hbStatus: Number(r.hs ?? 0),
          hbType: Number(r.ht ?? 0),
          receiveStatus: Number(r.rs ?? 0),
          sendId: readText(r.sid2),
        },
      }
    }
    return { found: false }
  })
  if (base.kind !== 'redpacket' || !base.redpacket) return base

  const sendId = base.redpacket.sendId.trim()
  if (sendId === '') return base
  const evidence = await readRedpacketEvidence(decryptedDir)
  const claimEvidence = evidence.returned.has(sendId)
    ? 'returned'
    : evidence.selfClaimed.has(sendId)
      ? 'self-claimed'
      : evidence.otherClaimed.has(sendId) || evidence.exhausted.has(sendId)
        ? 'other-claimed'
        : undefined
  return {
    ...base,
    redpacket: {
      ...base.redpacket,
      ...(claimEvidence === undefined ? {} : { claimEvidence }),
    },
  }
}
