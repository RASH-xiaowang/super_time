/**
 * Funds ledger: aggregates transferTable / redEnvelopeTable rows, resolves
 * amounts and timestamps from message shards by server_id, and derives
 * per-contact totals plus fund anomaly warnings.
 */
import { DatabaseSync } from './db-open.ts'
import { raiseAnalyticsCache } from '../sqlite-connection.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import type { LedgerContactRow, LedgerSnapshot, LedgerWarning } from '../types.ts'
import { parseMessageContent } from './parse.ts'
import { cachedBySigAsync, contactMeta, fileSigOf, shardCatalogDirs, shardCatalogSig } from './meta.ts'
import { yieldToLoop } from './search-build.ts'
import { displayNameForUsername } from './message-identity.ts'
import { centsToYuan, parseCnyAmount } from './payment-money.ts'
import { readRedpacketEvidence } from './payment-evidence.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** Decode a BLOB/TEXT cell to UTF-8 text (zstd + GBK aware). */
function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(decompressed)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(decompressed)
  }
}


/** Resolve server ids to raw message rows (amount via XML, create_time). */
async function resolveMessagesByServerIds(
  decryptedDir: string,
  serverIds: string[],
): Promise<Map<string, { createTime: number; content: string }>> {
  const out = new Map<string, { createTime: number; content: string }>()
  if (serverIds.length === 0) return out
  const pending = [...new Set(serverIds)].filter(Boolean)
  // 纯数字 id 先用整型等值走 server_id 索引（大 64 位值用 BigInt 保精度），
  // 未命中的再用 CAST 文本形式兜底，避免每表全量 CAST 扫描废掉索引。
  const numeric = new Map<string, bigint>()
  for (const id of pending) {
    if (/^\d+$/.test(id)) {
      try { numeric.set(id, BigInt(id)) } catch { /* non-numeric fallback below */ }
    }
  }
  const shards = shardCatalogDirs(decryptedDir, ['message'])
  const scan = async (serverExpr: string, params: Array<string | bigint>): Promise<void> => {
    const placeholders = params.map(() => '?').join(',')
    for (const shard of shards) {
      // P1-2：这两趟扫描是「账本打开就卡住别的面板」的正主 —— 每个 id 批次都要把**所有分片**
      // 各开一遍库（Pass 1 整型等值 + Pass 2 文本 CAST 兜底）。分片之间必须让出。
      await yieldToLoop()
      let db: DatabaseSync
      // readBigInts: 64 位 server_id 以 BigInt 原样读回，避免 double 精度损失。
      try { db = new DatabaseSync(shard.file, { readOnly: true, readBigInts: true }) } catch { continue }
      // 分析型扫描：全局读缓存 256KB 对「几十个 server_id 的 IN 查询 + 文本 CAST 兜底」
      // 会反复打穿页缓存（本机实测整条 getLedger 334ms → 163ms）。
      raiseAnalyticsCache(db)
      try {
        for (const [table, meta] of shard.tables) {
          if (!meta.cols.has('server_id') || !meta.cols.has('message_content')) continue
          const sel = [
            meta.cols.has('local_id') ? 'local_id' : '0',
            meta.cols.has('create_time') ? 'create_time' : '0',
            'message_content',
            `${serverExpr} AS server_id`,
          ].join(', ')
          try {
            const rows = db.prepare(`SELECT ${sel} FROM "${table}" WHERE ${serverExpr} IN (${placeholders})`).all(...params) as Array<Record<string, unknown>>
            for (const r of rows) {
              const sid = decodeCell(r['server_id']).trim()
              if (sid && !out.has(sid)) {
                out.set(sid, {
                  createTime: Number(r['create_time'] ?? 0),
                  content: decodeCell(r['message_content']),
                })
              }
            }
          } catch { /* table unreadable */ }
        }
      } finally {
        db.close()
      }
    }
  }
  // Pass 1: indexed integer equality for all pure-digit ids.
  const numericIds = [...numeric.values()]
  if (numericIds.length > 0) {
    for (let i = 0; i < numericIds.length; i += 400) {
      await scan('server_id', numericIds.slice(i, i + 400))
    }
  }
  // Pass 2: text CAST fallback for ids still missing (text-stored or non-numeric).
  const leftover = pending.filter(id => !out.has(id))
  if (leftover.length > 0) {
    for (let i = 0; i < leftover.length; i += 400) {
      await scan('CAST(server_id AS TEXT)', leftover.slice(i, i + 400))
    }
  }
  return out
}

/** Parse a payment message content into integer cents + kind. */
function paymentFromContent(content: string): { cents: number | null; kind: 'transfer' | 'redpacket' | null } {
  if (!content) return { cents: null, kind: null }
  const parsed = parseMessageContent(49, content, false)
  const rich = parsed.rich
  if (!rich) return { cents: null, kind: null }
  if (rich.type === 'transfer') return { cents: parseCnyAmount(rich.title).cents, kind: 'transfer' }
  if (rich.type === 'redpacket') return { cents: parseCnyAmount(rich.amount).cents, kind: 'redpacket' }
  return { cents: null, kind: null }
}

/** Month start/end epoch seconds for YYYY-MM (local midnight). */
function monthRange(month: string | null | undefined): { from: number; to: number } {
  if (month === null || month === undefined || month === '') return { from: 0, to: 0 }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new RangeError('月份必须是 YYYY-MM，且月份范围为 01–12')
  }
  const [yearText = '', monthText = ''] = month.split('-')
  const y = Number(yearText)
  const m = Number(monthText)
  if (y < 1970 || y > 9999) throw new RangeError('月份年份超出支持范围')
  const from = Math.floor(new Date(y, m - 1, 1).getTime() / 1000)
  const to = Math.floor(new Date(y, m, 1).getTime() / 1000) - 1
  return { from, to }
}

interface TransferRow {
  transferId: string
  session: string
  payer: string
  receiver: string
  direction: 'in' | 'out' | 'unknown'
  time: number
  invalidTime: number
  serverIds: string[]
}

interface RedpacketRow {
  session: string
  sender: string
  direction: 'in' | 'out' | 'unknown'
  sendId: string
  serverId: string
}

interface LedgerRows {
  transfers: TransferRow[]
  redpackets: RedpacketRow[]
  serverIds: Set<string>
}

function readLedgerRows(
  decryptedDir: string,
  from: number,
  to: number,
  self: string,
  readErrors: string[],
): LedgerRows {
  const gdb = join(decryptedDir, 'general', 'general.db')
  const transfers: TransferRow[] = []
  const redpackets: RedpacketRow[] = []
  const serverIds = new Set<string>()
  const seenTransfers = new Set<string>()
  const addServerId = (id: string): void => {
    if (id !== '' && id !== '0') serverIds.add(id)
  }

  if (!existsSync(gdb)) {
    readErrors.push('还没有资金往来数据（general.db 不存在）')
    return { transfers, redpackets, serverIds }
  }

  const db = new DatabaseSync(gdb, { readOnly: true })
  raiseAnalyticsCache(db)
  try {
    let tCols = new Set<string>()
    try {
      tCols = new Set((db.prepare('PRAGMA table_info(transferTable)').all() as Array<{ name: string }>).map(r => r.name))
    } catch (e) {
      readErrors.push('转账表结构读取失败：' + ((e as Error)?.message ?? String(e)))
    }
    if (tCols.size > 0) {
      if (tCols.has('session_name') && tCols.has('message_server_id')) {
        const t = tCols.has('begin_transfer_time') ? 'begin_transfer_time' : '0'
        const inv = tCols.has('invalid_time') ? 'invalid_time' : '0'
        const transferId = tCols.has('transfer_id') ? 'transfer_id' : "''"
        const payer = tCols.has('pay_payer') ? 'pay_payer' : "''"
        const receiver = tCols.has('pay_receiver') ? 'pay_receiver' : "''"
        const sid2 = tCols.has('second_message_server_id')
          ? 'CAST(second_message_server_id AS TEXT)'
          : "''"
        const where = from > 0 && t !== '0' ? ` WHERE ${t} >= ${from} AND ${t} <= ${to}` : ''
        try {
          const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id,
            ${sid2} AS second_message_server_id, ${transferId} AS transfer_id,
            ${payer} AS pay_payer, ${receiver} AS pay_receiver,
            ${t} AS begin_transfer_time, ${inv} AS invalid_time
            FROM transferTable${where}`
          const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
          for (const r of rows) {
            const sid = decodeCell(r['message_server_id']).trim()
            const sid2Value = decodeCell(r['second_message_server_id']).trim()
            const transferIdValue = decodeCell(r['transfer_id']).trim()
            const dedupeKey = transferIdValue || (sid !== '0' ? sid : sid2Value)
            if (dedupeKey === '' || seenTransfers.has(dedupeKey)) continue
            seenTransfers.add(dedupeKey)
            addServerId(sid)
            addServerId(sid2Value)
            const payerValue = decodeCell(r['pay_payer']).trim()
            const receiverValue = decodeCell(r['pay_receiver']).trim()
            const session = decodeCell(r['session_name']).trim()
            const direction: 'in' | 'out' | 'unknown' = self && payerValue === self
              ? 'out'
              : self && receiverValue === self
                ? 'in'
                : 'unknown'
            transfers.push({
              transferId: transferIdValue,
              session,
              payer: payerValue,
              receiver: receiverValue,
              direction,
              time: Number(r['begin_transfer_time'] ?? 0),
              invalidTime: Number(r['invalid_time'] ?? 0),
              serverIds: [sid, sid2Value].filter(id => id !== '' && id !== '0'),
            })
          }
        } catch (e) {
          readErrors.push('转账表读取失败：' + ((e as Error)?.message ?? String(e)))
        }
      } else {
        readErrors.push('转账表缺少必要字段，无法核对转账记录')
      }
    }

    let rpCols = new Set<string>()
    try {
      rpCols = new Set((db.prepare('PRAGMA table_info(redEnvelopeTable)').all() as Array<{ name: string }>).map(r => r.name))
    } catch (e) {
      readErrors.push('红包表结构读取失败：' + ((e as Error)?.message ?? String(e)))
    }
    if (rpCols.size > 0) {
      if (rpCols.has('session_name') && rpCols.has('message_server_id')) {
        const senderCol = rpCols.has('sender_user_name') ? 'sender_user_name' : "''"
        const sendIdCol = rpCols.has('send_id') ? 'send_id' : "''"
        try {
          const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id,
            ${senderCol} AS sender_user_name, ${sendIdCol} AS send_id
            FROM redEnvelopeTable`
          const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
          for (const r of rows) {
            const sid = decodeCell(r['message_server_id']).trim()
            addServerId(sid)
            const sender = decodeCell(r['sender_user_name']).trim()
            const sendId = decodeCell(r['send_id']).trim()
            const session = decodeCell(r['session_name']).trim()
            const direction: 'in' | 'out' | 'unknown' = self && sender === self
              ? 'out'
              : self
                ? 'in'
                : 'unknown'
            redpackets.push({ session, sender, direction, sendId, serverId: sid })
          }
        } catch (e) {
          readErrors.push('红包表读取失败：' + ((e as Error)?.message ?? String(e)))
        }
      } else {
        readErrors.push('红包表缺少必要字段，无法核对红包记录')
      }
    }
  } finally {
    db.close()
  }
  return { transfers, redpackets, serverIds }
}

/**
 * Compute the funds ledger snapshot.
 *
 * G（2026-09-28 性能修复）：实测 `queryLedger` 无缓存时 **125ms**，而它每次被
 * 「账本面板重渲染 / 切月 / 切回来」都整跑一遍 —— 但它的输入只有三样东西：
 * 会话库、通讯录库、消息分片目录，全都可以用文件签名判断「变没变」。
 * 所以按签名缓存（`cachedBySigAsync`，与 `queryGraph` 同一个入口）。
 *
 * 签名含 `month` 与 `selfUsername`：两者都是查询参数，混用会让「切月后拿到上月数据」
 * 这种错静默发生。等价的单张缓存示例见 `contacts.ts`（把参数编进 key）。
 * @param decryptedDir - decrypted data root.
 * @param month - optional YYYY-MM filter.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @returns the ledger snapshot.
 */
export async function queryLedger(decryptedDir: string, month?: string, selfUsername?: string): Promise<LedgerSnapshot> {
  const sig = shardCatalogSig(decryptedDir, ['message'])
    + '|contact:' + fileSigOf(join(decryptedDir, 'contact', 'contact.db'))
    + '|general:' + fileSigOf(join(decryptedDir, 'general', 'general.db'))
    + '|month:' + String(month ?? '')
    + '|self:' + String(selfUsername ?? '')
  return cachedBySigAsync('ledger:' + decryptedDir, sig, () => computeLedger(decryptedDir, month, selfUsername))
}

/**
 * `queryLedger` 的实际计算体（签名缓存包一层；为了装配/测试可直接单测它）。
 * @param decryptedDir - decrypted data root.
 * @param month - optional YYYY-MM filter.
 * @param selfUsername - logged-in account wxid (direction labels).
 */
async function computeLedger(decryptedDir: string, month?: string, selfUsername?: string): Promise<LedgerSnapshot> {
  const meta = contactMeta(decryptedDir)
  const names = meta.names
  const enterpriseNames = meta.enterpriseNames
  const self = (selfUsername ?? '').trim()
  const { from, to } = monthRange(month)
  const now = Math.floor(Date.now() / 1000)
  const readErrors: string[] = []
  const { transfers, redpackets, serverIds } = readLedgerRows(
    decryptedDir,
    from,
    to,
    self,
    readErrors,
  )

  // Resolve amounts + times for all referenced server ids in one shard pass.
  const resolved = await resolveMessagesByServerIds(decryptedDir, [...serverIds])
  const byMsg = new Map<string, { cents: number | null; time: number; kind: 'transfer' | 'redpacket' }>()
  for (const [sid, info] of resolved) {
    const pay = paymentFromContent(info.content)
    if (pay.kind) byMsg.set(sid, { cents: pay.cents, time: info.createTime, kind: pay.kind })
  }
  let evidence: Awaited<ReturnType<typeof readRedpacketEvidence>> | null = null
  if (redpackets.length > 0) {
    try {
      evidence = await readRedpacketEvidence(decryptedDir)
    } catch (e) {
      readErrors.push('红包领取证据读取失败：' + ((e as Error)?.message ?? String(e)))
    }
  }

  const contactAgg = new Map<string, { username: string; name: string; count: number; amountCents: number; direction: 'in' | 'out' }>()
  const addContact = (username: string, amountCents: number | null, direction: 'in' | 'out', count = 1): void => {
    // A contact row with a fabricated zero amount is worse than omitting it.
    if (username === '' || amountCents === null) return
    const key = username + ':' + direction
    const cur = contactAgg.get(key)
    if (cur) {
      cur.count += count
      cur.amountCents += amountCents
    } else {
      contactAgg.set(key, { username, name: displayNameForUsername(username, names), count, amountCents, direction })
    }
  }

  const warnings: LedgerWarning[] = []
  let transferIn = 0
  let transferOut = 0
  let transferInCents = 0n
  let transferOutCents = 0n
  let transferCount = 0
  let transferThirdPartyCount = 0
  let amountUnknownCount = 0
  for (const t of transfers) {
    transferCount += 1
    const msg = t.serverIds.map(s => byMsg.get(s)).find(m => m?.kind === 'transfer')
    const amountCents = msg?.cents ?? null
    const time = msg?.time ?? t.time
    if (amountCents === null) amountUnknownCount += 1
    if (t.direction === 'in') {
      transferIn += 1
      if (amountCents !== null) transferInCents += BigInt(amountCents)
      addContact(t.payer || t.session, amountCents, 'in')
    } else if (t.direction === 'out') {
      transferOut += 1
      if (amountCents !== null) transferOutCents += BigInt(amountCents)
      addContact(t.receiver || t.session, amountCents, 'out')
    } else {
      transferThirdPartyCount += 1
    }
  }

  let rpSent = 0
  let rpReceived = 0
  let rpSentCents = 0n
  let rpReceivedCents = 0n
  let rpKnownReceived = 0
  let rpAmountUnknownCount = 0
  let rpStatusUnknownCount = 0
  for (const r of redpackets) {
    const msg = byMsg.get(r.serverId)
    const verifiedMsg = msg?.kind === 'redpacket' ? msg : undefined
    const amountCents = verifiedMsg?.cents ?? null
    const time = msg?.time ?? 0
    if (from > 0 && (time <= 0 || time < from || time > to)) continue
    const isReturned = evidence?.returned.has(r.sendId) ?? false
    const selfClaimed = r.sendId !== '' && (evidence?.selfClaimed.has(r.sendId) ?? false)
    if (r.direction === 'out') {
      rpSent += 1
      if (amountCents === null) {
        rpAmountUnknownCount += 1
        amountUnknownCount += 1
      }
      else if (!isReturned) {
        rpSentCents += BigInt(amountCents)
        addContact(r.session, amountCents, 'out')
      }
      if (isReturned) {
        const username = r.session || r.sender
        const enterpriseName = enterpriseNames.get(username)?.trim()
        warnings.push({
          kind: 'redpacket-returned',
          label: '红包已退回',
          username,
          name: displayNameForUsername(username, names),
          ...(enterpriseName ? { enterpriseName } : {}),
          time,
          ...(amountCents === null ? {} : { amount: centsToYuan(amountCents) }),
        })
      }
    } else if (selfClaimed) {
      rpReceived += 1
      if (amountCents === null) {
        rpAmountUnknownCount += 1
        amountUnknownCount += 1
      } else {
        rpReceivedCents += BigInt(amountCents)
        rpKnownReceived += 1
        addContact(r.sender || r.session, amountCents, 'in')
      }
    } else {
      // No local claim record exists. Do not turn this into received income.
      rpStatusUnknownCount += 1
    }
  }

  // W2-9.3 实测记录：**这个 slice 就是「按联系人」的硬上界**。
  // 面板 `Ledger.tsx` 用 `useProgressiveList(byContact.length, 80)` 渲染，
  // 而 step=80 > 20 ⇒ 渐进窗口**永远不触发**，最多也就 20 行、约 340 个 DOM 节点。
  // 所以「记录类长列表虚拟化」这一条在 Ledger 这半边**前提不成立**：
  // 没有无界增长，就没有虚拟化可省。真要放开这里，得先想清楚「联系人排行要多少行」。
  const byContactRows: LedgerContactRow[] = [...contactAgg.values()]
    .sort((a, b) => b.amountCents - a.amountCents || b.count - a.count)
    .slice(0, 20)
    .map((row) => {
      const enterpriseName = enterpriseNames.get(row.username)?.trim()
      return {
        username: row.username,
        name: row.name,
        ...(enterpriseName ? { enterpriseName } : {}),
        count: row.count,
        amount: centsToYuan(row.amountCents),
        direction: row.direction,
      }
    })

  const totalInCents = transferInCents + rpReceivedCents
  const totalOutCents = transferOutCents + rpSentCents
  const receivedAmounts = redpackets
    .filter(r => r.direction !== 'out' && (evidence?.selfClaimed.has(r.sendId) ?? false))
    .map(r => byMsg.get(r.serverId))
    .filter((m): m is { cents: number; time: number; kind: 'transfer' | 'redpacket' } =>
      m?.kind === 'redpacket' && m.cents !== null,
    )
    .map(m => m.cents)
  const redpacketBestCents = receivedAmounts.length > 0 ? Math.max(...receivedAmounts) : 0
  const redpacketAvgCents = rpKnownReceived > 0
    ? Math.round(Number(rpReceivedCents) / rpKnownReceived)
    : 0

  return {
    month: month ?? null,
    summary: {
      transfers: transferCount,
      transferIn,
      transferOut,
      transferAmountIn: centsToYuan(Number(transferInCents)),
      transferAmountOut: centsToYuan(Number(transferOutCents)),
      redpacketsSent: rpSent,
      redpacketsReceived: rpReceived,
      redpacketAmountSent: centsToYuan(Number(rpSentCents)),
      redpacketAmountReceived: centsToYuan(Number(rpReceivedCents)),
      totalAmountIn: centsToYuan(Number(totalInCents)),
      totalAmountOut: centsToYuan(Number(totalOutCents)),
      amountUnknownCount,
      redpacketUnconfirmedCount: rpStatusUnknownCount,
      transferThirdPartyCount,
    },
    byContact: byContactRows,
    redpacket: {
      sentCount: rpSent,
      receivedCount: rpReceived,
      sentAmount: centsToYuan(Number(rpSentCents)),
      receivedAmount: centsToYuan(Number(rpReceivedCents)),
      bestAmount: centsToYuan(redpacketBestCents),
      avgAmount: centsToYuan(redpacketAvgCents),
      amountUnknownCount: rpAmountUnknownCount,
      statusUnknownCount: rpStatusUnknownCount,
    },
    warnings,
    ...(readErrors.length === 0 ? {} : { readError: readErrors.join('；') }),
    updatedAt: now,
  }
}
