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
import { displayNameForUsername, messageTableHash, messageTableName, resolveTalkerUsername } from './message-identity.ts'
import { centsToYuan, parseCnyAmount } from './payment-money.ts'
import { readRedpacketEvidence } from './payment-evidence.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * 长循环每 N 行检查一次取消信号。
 *
 * 账本一次要扫资金表 + 所有消息分片；问答工具被取消后如果还跑完整趟，
 * 用户看到的「已停止」与实际后台负载会对不上。512 行与检索侧的取消粒度一致。
 */
const ABORT_CHECK_EVERY_ROWS = 512

/** 账本计算被取消时的稳定错误码（问答工具据此返回「已取消」而不是「读失败」）。 */
export const LEDGER_CANCELED_CODE = 'ledger_canceled'

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return
  throw Object.assign(new Error('资金统计已取消'), { code: LEDGER_CANCELED_CODE })
}

/** 判断异常是否来自取消（而不是数据读取失败）。 */
export function isLedgerCanceled(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === LEDGER_CANCELED_CODE
}

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
  signal?: AbortSignal,
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
      throwIfAborted(signal)
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
            for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
              if ((rowIndex & (ABORT_CHECK_EVERY_ROWS - 1)) === 0) throwIfAborted(signal)
              const r = rows[rowIndex]
              if (r === undefined) continue
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
  /**
   * 资金表的原始状态字段。pay_sub_type 的取值域在本仓库没有权威映射，
   * 只原样保留给「状态未确认」的展示，绝不据此编造「已收款/已退还」。
   */
  paySubType: number
  lastModifiedTime: number
  delayConfirm: boolean
  serverIds: string[]
}

interface RedpacketRow {
  session: string
  sender: string
  direction: 'in' | 'out' | 'unknown'
  sendId: string
  serverId: string
  /** 原始状态对；未在本地证据里确认领取/退回时只按原值展示。 */
  hbStatus: number
  receiveStatus: number
}

interface LedgerRows {
  transfers: TransferRow[]
  redpackets: RedpacketRow[]
  serverIds: Set<string>
  /** transferTable 是否存在可用的 begin_transfer_time（缺失时范围只能靠消息时间兜底）。 */
  transferTimeColumn: boolean
  /** general.db 是否存在（调用方据此区分「没数据」与「没解密」）。 */
  generalExists: boolean
}

function readLedgerRows(
  decryptedDir: string,
  from: number,
  to: number,
  self: string,
  readErrors: string[],
  signal?: AbortSignal,
): LedgerRows {
  const gdb = join(decryptedDir, 'general', 'general.db')
  const transfers: TransferRow[] = []
  const redpackets: RedpacketRow[] = []
  const serverIds = new Set<string>()
  const seenTransfers = new Set<string>()
  let transferTimeColumn = false
  const addServerId = (id: string): void => {
    if (id !== '' && id !== '0') serverIds.add(id)
  }

  if (!existsSync(gdb)) {
    readErrors.push('还没有资金往来数据（general.db 不存在）')
    return { transfers, redpackets, serverIds, transferTimeColumn, generalExists: false }
  }
  throwIfAborted(signal)

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
        transferTimeColumn = t !== '0'
        const inv = tCols.has('invalid_time') ? 'invalid_time' : '0'
        const transferId = tCols.has('transfer_id') ? 'transfer_id' : "''"
        const payer = tCols.has('pay_payer') ? 'pay_payer' : "''"
        const receiver = tCols.has('pay_receiver') ? 'pay_receiver' : "''"
        const paySubType = tCols.has('pay_sub_type') ? 'pay_sub_type' : '0'
        const lastModified = tCols.has('last_modified_time') ? 'last_modified_time' : '0'
        const delayConfirm = tCols.has('delay_confirm_flag') ? 'delay_confirm_flag' : '0'
        const sid2 = tCols.has('second_message_server_id')
          ? 'CAST(second_message_server_id AS TEXT)'
          : "''"
        // 只给到一端的范围也要过滤：旧实现要求 from>0，导致「截至某天」被静默当成不限。
        const whereParts: string[] = []
        if (t !== '0') {
          if (from > 0) whereParts.push(`${t} >= ${from}`)
          if (to > 0) whereParts.push(`${t} <= ${to}`)
        }
        const where = whereParts.length > 0 ? ` WHERE ${whereParts.join(' AND ')}` : ''
        try {
          const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id,
            ${sid2} AS second_message_server_id, ${transferId} AS transfer_id,
            ${payer} AS pay_payer, ${receiver} AS pay_receiver,
            ${t} AS begin_transfer_time, ${inv} AS invalid_time,
            ${paySubType} AS pay_sub_type, ${lastModified} AS last_modified_time,
            ${delayConfirm} AS delay_confirm_flag
            FROM transferTable${where}`
          const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            if ((rowIndex & (ABORT_CHECK_EVERY_ROWS - 1)) === 0) throwIfAborted(signal)
            const r = rows[rowIndex]
            if (r === undefined) continue
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
              paySubType: Number(r['pay_sub_type'] ?? 0),
              lastModifiedTime: Number(r['last_modified_time'] ?? 0),
              delayConfirm: Number(r['delay_confirm_flag'] ?? 0) !== 0,
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
        const hbStatusCol = rpCols.has('hb_status') ? 'hb_status' : '0'
        const receiveStatusCol = rpCols.has('receive_status') ? 'receive_status' : '0'
        try {
          const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id,
            ${senderCol} AS sender_user_name, ${sendIdCol} AS send_id,
            ${hbStatusCol} AS hb_status, ${receiveStatusCol} AS receive_status
            FROM redEnvelopeTable`
          const rows = db.prepare(sql).all() as Array<Record<string, unknown>>
          for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
            if ((rowIndex & (ABORT_CHECK_EVERY_ROWS - 1)) === 0) throwIfAborted(signal)
            const r = rows[rowIndex]
            if (r === undefined) continue
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
            redpackets.push({
              session,
              sender,
              direction,
              sendId,
              serverId: sid,
              hbStatus: Number(r['hb_status'] ?? 0),
              receiveStatus: Number(r['receive_status'] ?? 0),
            })
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
  return { transfers, redpackets, serverIds, transferTimeColumn, generalExists: true }
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
  return cachedBySigAsync('ledger:' + decryptedDir, sig,
    async () => (await computeLedger(decryptedDir, { month, selfUsername })).snapshot)
}

/** 逐笔资金记录（`get_funds_summary` 的 hits 用；不是面板快照的一部分）。 */
export interface LedgerFundRecord {
  recordType: 'transfers' | 'redpackets'
  /** 相对当前账号的方向：收入 / 支出 / 无法判断（第三方之间）。 */
  direction: 'in' | 'out' | 'unknown'
  /** 本地时区 epoch 秒；0 = 本地数据无法证明时间。 */
  time: number
  /** 资金记录所属会话（原样存储值）。 */
  session: string
  /** 交易对方 username（收入=付款人，支出=收款人/会话）。 */
  username: string
  /** 交易对方显示名。 */
  name: string
  /** 企业微信联系人的企业名称。 */
  enterpriseName?: string
  /** 整数分；`null` = 本地卡片没有可证明的人民币金额（不得伪造成 0）。 */
  amountCents: number | null
  /**
   * 本地证据能证明的状态。
   *
   * `received`/`sent` 只表示资金表把这一笔记成了对应方向；红包的领取/退回
   * 必须有本地系统消息证据才升级成 `received`/`returned`，其余保持 `unknown`。
   */
  status: 'received' | 'sent' | 'returned' | 'claimed-other' | 'invalid' | 'unknown'
  /**
   * 资金表的原始状态值（红包 `hb_status/receive_status`）。
   *
   * 取值域在本仓库没有权威映射，只用于在「状态未确认」时如实附上原值；
   * 绝不据此推断「已领取/已退回」。
   */
  rawStatus?: string
  transferId?: string
  sendId?: string
  serverId?: string
}

/** 按联系人合并后的收支（TOP 事实用；不截断，由调用方按 top 取）。 */
export interface LedgerContactTotal {
  username: string
  name: string
  enterpriseName?: string
  count: number
  amountInCents: number
  amountOutCents: number
}

/** 范围版账本查询参数（epoch 秒，含端点；0/缺省 = 该端不限）。 */
export interface LedgerRangeOptions {
  from?: number
  to?: number
  /** 限定联系人或会话；空 = 全库。 */
  username?: string
  /** 只算收入或只算支出；缺省 = 全部。 */
  direction?: 'in' | 'out'
  /** 只算转账或只算红包；缺省 = 全部。 */
  kind?: 'transfer' | 'redpacket'
  /** 是否收集异常提醒（默认 true）。 */
  includeWarnings?: boolean
  /** 取消信号：长循环每 512 行检查一次。 */
  signal?: AbortSignal
}

/** 范围版账本结果：快照 + 逐笔明细 + 未截断的按人汇总。 */
export interface LedgerRangeResult {
  snapshot: LedgerSnapshot
  records: LedgerFundRecord[]
  contactTotals: LedgerContactTotal[]
  /**
   * 红包时间无法证明、已回退为「全部时间统计」。true 时调用方必须如实标注，
   * 不能把这个区间内的红包数说成精确值。
   */
  redpacketsAllTime: boolean
  /** general.db 是否存在（false 时调用方应返回 not_configured）。 */
  generalExists: boolean
}

interface LedgerComputeInput {
  /** month 模式（`queryLedger` 的既有入口）；与 `range` 互斥。 */
  month?: string
  selfUsername?: string
  /** 范围模式：一旦提供就不再读 `month`。 */
  range?: { from: number; to: number }
  /** 限定联系人或会话（已由调用方保证 `ctx.scope.username` 优先）。 */
  scopedUsername?: string
  direction?: 'in' | 'out'
  kind?: 'transfer' | 'redpacket'
  includeWarnings?: boolean
  signal?: AbortSignal
  /** 是否收集逐笔明细；面板快照不需要，问答工具需要。 */
  collectRecords?: boolean
}

/**
 * 范围版资金账本（问答 `get_funds_summary` 的专用入口）。
 *
 * 刻意不改 `queryLedger` 的签名与 month 口径：面板的行为必须逐字不变。
 * 本函数只把同一套计算体换成「显式 epoch 范围 + 可选会话/方向/类型过滤」，
 * 并额外带回逐笔明细与未截断的联系人汇总。
 * @param decryptedDir - decrypted data root.
 * @param options - 范围与过滤参数（epoch 秒，含端点）。
 * @param opts.selfUsername - 当前账号 wxid；为空时方向只能是 unknown。
 * @returns 快照、明细与降级标记。
 */
export async function queryLedgerRange(
  decryptedDir: string,
  options: LedgerRangeOptions,
  opts: { selfUsername?: string } = {},
): Promise<LedgerRangeResult> {
  const from = Math.max(0, Math.trunc(options.from ?? 0))
  const to = Math.max(0, Math.trunc(options.to ?? 0))
  const username = (options.username ?? '').trim()
  const direction = options.direction === 'in' || options.direction === 'out' ? options.direction : undefined
  const kind = options.kind === 'transfer' || options.kind === 'redpacket' ? options.kind : undefined
  const includeWarnings = options.includeWarnings !== false
  const self = (opts.selfUsername ?? '').trim()
  const sig = shardCatalogSig(decryptedDir, ['message'])
    + '|contact:' + fileSigOf(join(decryptedDir, 'contact', 'contact.db'))
    + '|general:' + fileSigOf(join(decryptedDir, 'general', 'general.db'))
    + '|range:' + String(from) + ':' + String(to)
    + '|scope:' + username
    + '|dir:' + String(direction ?? '')
    + '|kind:' + String(kind ?? '')
    + '|warn:' + (includeWarnings ? '1' : '0')
    + '|self:' + self
  return cachedBySigAsync('ledger-range:' + decryptedDir, sig, () => computeLedger(decryptedDir, {
    range: { from, to },
    selfUsername: self,
    ...(username !== '' ? { scopedUsername: username } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(kind !== undefined ? { kind } : {}),
    includeWarnings,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    collectRecords: true,
  }))
}

/**
 * 把「联系人」参数扩展成资金表里可能出现的等价值。
 *
 * `transferTable.session_name` 既可能是 canonical username，也可能是
 * `Msg_<md5>` 这类历史物理表名；联系人参数还允许填备注/昵称。只比较 raw
 * 字符串会让「按张三查」和「按 wxid_a 查」得到两个答案。
 */
function ledgerScopeAliases(
  decryptedDir: string,
  username: string,
  names: ReadonlyMap<string, string>,
): Set<string> {
  const raw = username.trim()
  const aliases = new Set<string>()
  if (raw === '') return aliases
  aliases.add(raw)
  const canonical = resolveTalkerUsername(decryptedDir, raw)
  for (const id of [raw, canonical]) {
    if (id === '') continue
    aliases.add(id)
    aliases.add(messageTableHash(id))
    aliases.add(messageTableName(id))
  }
  // 允许模型用备注/昵称限定；映射来自 contactMeta，不额外读库。
  for (const [id, name] of names) {
    if (name.trim() === raw) aliases.add(id)
  }
  return aliases
}

/**
 * `queryLedger` / `queryLedgerRange` 共用的实际计算体。
 *
 * 为什么把两种入口合到一处：月份只是「月初 00:00 ~ 月末 23:59:59」的一种范围，
 * 分成两份实现必然在金额、证据、异常口径上分叉，而「同一个数在两处不一样」
 * 是资金类问题里最难解释的 bug。
 * @param decryptedDir - decrypted data root.
 * @param input - 月份或显式范围 + 过滤条件。
 * @returns 范围结果（`queryLedger` 只取 snapshot）。
 */
async function computeLedger(decryptedDir: string, input: LedgerComputeInput = {}): Promise<LedgerRangeResult> {
  const meta = contactMeta(decryptedDir)
  const names = meta.names
  const enterpriseNames = meta.enterpriseNames
  const self = (input.selfUsername ?? '').trim()
  const rangeMode = input.range !== undefined
  const { from, to } = rangeMode
    ? {
      from: Math.max(0, Math.trunc(input.range?.from ?? 0)),
      to: Math.max(0, Math.trunc(input.range?.to ?? 0)),
    }
    : monthRange(input.month)
  const rangeActive = rangeMode && (from > 0 || to > 0)
  const signal = input.signal
  throwIfAborted(signal)
  const now = Math.floor(Date.now() / 1000)
  const readErrors: string[] = []
  const {
    transfers: allTransfers,
    redpackets: allRedpackets,
    serverIds,
    transferTimeColumn,
    generalExists,
  } = readLedgerRows(decryptedDir, from, to, self, readErrors, signal)

  // Resolve amounts + times for all referenced server ids in one shard pass.
  const resolved = await resolveMessagesByServerIds(decryptedDir, [...serverIds], signal)
  const byMsg = new Map<string, { cents: number | null; time: number; kind: 'transfer' | 'redpacket' }>()
  for (const [sid, info] of resolved) {
    const pay = paymentFromContent(info.content)
    if (pay.kind) byMsg.set(sid, { cents: pay.cents, time: info.createTime, kind: pay.kind })
  }

  const includeTransfers = input.kind !== 'redpacket'
  const includeRedpackets = input.kind !== 'transfer'
  const scopedUsername = (input.scopedUsername ?? '').trim()
  const scopeAliases = scopedUsername !== ''
    ? ledgerScopeAliases(decryptedDir, scopedUsername, names)
    : null
  const inScope = (values: string[]): boolean =>
    scopeAliases === null || values.some(value => value !== '' && scopeAliases.has(value))
  const transfers = includeTransfers
    ? allTransfers.filter(t => inScope([t.session, t.payer, t.receiver]))
    : []
  const redpackets = includeRedpackets
    ? allRedpackets.filter(r => inScope([r.session, r.sender]))
    : []

  let evidence: Awaited<ReturnType<typeof readRedpacketEvidence>> | null = null
  if (redpackets.length > 0) {
    try {
      evidence = await readRedpacketEvidence(decryptedDir)
    } catch (e) {
      readErrors.push('红包领取证据读取失败：' + ((e as Error)?.message ?? String(e)))
    }
  }
  throwIfAborted(signal)

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

  const includeWarnings = input.includeWarnings !== false
  const warnings: LedgerWarning[] = []
  const records: LedgerFundRecord[] = []
  const collectRecords = input.collectRecords === true
  let transferIn = 0
  let transferOut = 0
  let transferInCents = 0n
  let transferOutCents = 0n
  let transferCount = 0
  let transferThirdPartyCount = 0
  let amountUnknownCount = 0
  for (let index = 0; index < transfers.length; index += 1) {
    if ((index & (ABORT_CHECK_EVERY_ROWS - 1)) === 0) throwIfAborted(signal)
    const t = transfers[index]
    if (t === undefined) continue
    if (input.direction === 'in' && t.direction !== 'in') continue
    if (input.direction === 'out' && t.direction !== 'out') continue
    const msg = t.serverIds.map(s => byMsg.get(s)).find(m => m?.kind === 'transfer')
    const amountCents = msg?.cents ?? null
    const time = msg?.time ?? t.time
    // 资金表没有时间列时，SQL 范围没有生效；用消息卡片时间兜底，
    // 时间仍为 0 的行保留（无法证明它在范围外，不能静默丢弃）。
    if (rangeMode && rangeActive && !transferTimeColumn && time > 0 && (time < from || time > to)) continue
    transferCount += 1
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
    if (collectRecords) {
      const counterpart = t.direction === 'in'
        ? (t.payer || t.session)
        : t.direction === 'out'
          ? (t.receiver || t.session)
          : (t.session || t.payer || t.receiver)
      const name = t.session.endsWith('@chatroom')
        ? displayNameForUsername(t.session, names)
        : displayNameForUsername(counterpart || t.session, names)
      const enterpriseName = enterpriseNames.get(counterpart)?.trim()
      const status: LedgerFundRecord['status'] = t.invalidTime > 0
        ? 'invalid'
        : t.direction === 'in'
          ? 'received'
          : t.direction === 'out'
            ? 'sent'
            : 'unknown'
      const serverId = t.serverIds[0]
      records.push({
        recordType: 'transfers',
        direction: t.direction,
        time,
        session: t.session,
        username: counterpart,
        name,
        ...(enterpriseName !== undefined && enterpriseName !== '' ? { enterpriseName } : {}),
        amountCents,
        status,
        ...(t.transferId !== '' ? { transferId: t.transferId } : {}),
        ...(serverId !== undefined && serverId !== '' ? { serverId } : {}),
      })
    }
  }

  // 红包表本身没有可靠的发送时间；时间只能从消息卡片解析。只要有一笔解析不出来，
  // 就无法声称「这个区间内的红包」是精确的 —— 回退到全部时间并在事实里标注。
  const redpacketsAllTime = rangeActive && redpackets.some(r => (byMsg.get(r.serverId)?.time ?? 0) <= 0)
  const filteredRedpackets: RedpacketRow[] = []
  let rpSent = 0
  let rpReceived = 0
  let rpSentCents = 0n
  let rpReceivedCents = 0n
  let rpKnownReceived = 0
  let rpAmountUnknownCount = 0
  let rpStatusUnknownCount = 0
  for (let index = 0; index < redpackets.length; index += 1) {
    if ((index & (ABORT_CHECK_EVERY_ROWS - 1)) === 0) throwIfAborted(signal)
    const r = redpackets[index]
    if (r === undefined) continue
    if (input.direction === 'in' && r.direction !== 'in') continue
    if (input.direction === 'out' && r.direction !== 'out') continue
    const msg = byMsg.get(r.serverId)
    const verifiedMsg = msg?.kind === 'redpacket' ? msg : undefined
    const amountCents = verifiedMsg?.cents ?? null
    const time = msg?.time ?? 0
    // month 模式保留既有口径（只按 message 时间过滤）；范围模式在时间不可证明时
    // 回退到全部时间，而不是把整批红包过滤成 0。
    const timeFiltered = rangeMode ? (rangeActive && !redpacketsAllTime) : from > 0
    if (timeFiltered && (time <= 0 || time < from || time > to)) continue
    filteredRedpackets.push(r)
    const isReturned = evidence?.returned.has(r.sendId) ?? false
    const selfClaimed = r.sendId !== '' && (evidence?.selfClaimed.has(r.sendId) ?? false)
    const otherClaimed = r.sendId !== ''
      && ((evidence?.otherClaimed.has(r.sendId) ?? false) || (evidence?.exhausted.has(r.sendId) ?? false))
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
      if (isReturned && includeWarnings) {
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
    if (collectRecords) {
      const counterpart = r.direction === 'out'
        ? (r.session || r.sender)
        : (r.sender || r.session)
      const name = r.session.endsWith('@chatroom')
        ? displayNameForUsername(r.session, names)
        : displayNameForUsername(counterpart || r.session, names)
      const enterpriseName = enterpriseNames.get(counterpart)?.trim()
      const status: LedgerFundRecord['status'] = isReturned
        ? 'returned'
        : selfClaimed
          ? 'received'
          : otherClaimed
            ? 'claimed-other'
            : r.direction === 'out'
              ? 'sent'
              : 'unknown'
      records.push({
        recordType: 'redpackets',
        direction: r.direction,
        time,
        session: r.session,
        username: counterpart,
        name,
        ...(enterpriseName !== undefined && enterpriseName !== '' ? { enterpriseName } : {}),
        amountCents,
        status,
        ...(r.hbStatus > 0 || r.receiveStatus > 0 ? { rawStatus: `${String(r.hbStatus)}/${String(r.receiveStatus)}` } : {}),
        ...(r.sendId !== '' ? { sendId: r.sendId } : {}),
        ...(r.serverId !== '' ? { serverId: r.serverId } : {}),
      })
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

  // 未截断的按人汇总：面板只要 TOP 20，问答的「按人 TOP」上限是 30，
  // 在 byContact 上再切会悄悄少人。
  const totalsMap = new Map<string, LedgerContactTotal>()
  for (const row of contactAgg.values()) {
    let total = totalsMap.get(row.username)
    if (total === undefined) {
      const enterpriseName = enterpriseNames.get(row.username)?.trim()
      total = {
        username: row.username,
        name: row.name,
        ...(enterpriseName ? { enterpriseName } : {}),
        count: 0,
        amountInCents: 0,
        amountOutCents: 0,
      }
      totalsMap.set(row.username, total)
    }
    total.count += row.count
    if (row.direction === 'in') total.amountInCents += row.amountCents
    else total.amountOutCents += row.amountCents
  }
  const contactTotals = [...totalsMap.values()].sort(
    (a, b) => (b.amountInCents + b.amountOutCents) - (a.amountInCents + a.amountOutCents) || b.count - a.count,
  )

  const totalInCents = transferInCents + rpReceivedCents
  const totalOutCents = transferOutCents + rpSentCents
  // month 模式沿用既有快照口径（最佳手气不按月份过滤）；范围模式只用通过过滤的行，
  // 否则「9 月最佳红包」会把 8 月的金额算进来。
  const receivedSource = rangeMode ? filteredRedpackets : redpackets
  const receivedAmounts = receivedSource
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

  const snapshot: LedgerSnapshot = {
    month: rangeMode ? null : (input.month ?? null),
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

  return {
    snapshot,
    records,
    contactTotals,
    redpacketsAllTime,
    generalExists,
  }
}
