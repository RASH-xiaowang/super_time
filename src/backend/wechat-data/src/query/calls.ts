/**
 * Call (type 50) inventory across every message shard.
 *
 * WeChat stores voice/video calls as `local_type = 50` rows whose
 * `message_content` is a zstd blob (magic 0x28B52FFD) holding a
 * `<voipmsg type="VoIPBubbleMsg">` XML. Everything the UI needs is in that XML:
 *
 * | field | measured (164/164 locally) | usable |
 * | --- | --- | --- |
 * | `<msg>` | 通话时长 00:21 / 对方已取消 / 已拒绝 / 未应答 / 已在其它设备接听 … | ✅ only informative field |
 * | `<duration>` | **always 0** | ❌ the real length is inside `<msg>` |
 * | `<room_type>` | 0×61 / 1×103, all in 1:1 chats | ✅ 0=语音 / 1=视频（判据见 parse.ts `parseVoipKind`） |
 *
 * Direction comes from `real_sender_id` resolved through each shard's own
 * `Name2Id` (rowid → wxid): the logged-in account means 呼出, anyone else 呼入.
 * Locally that resolves 135/135 rows, and the resolved "other" value is always
 * the conversation's own talker.
 *
 * 本文件（通话记录面板）**仍然只暴露原始 `room_type`、不自己下结论**：面板的语义是
 * 「按人/按月盘点通话」，语音还是视频不影响它的排序与汇总，少一个可能错的断言更安全。
 * 消息气泡那条链路（parse.ts → `rich.voipType`）需要画图标与「语音通话 / 视频通话」文案，
 * 所以它在拿到时长分布证据后按 **0=语音 / 1=视频** 判定 —— 判据与反例都写在
 * `parse.ts` 的 `parseVoipKind` 注释里。
 */
import { DatabaseSync } from './db-open.ts'
import { decompress } from 'fzstd'
import { join } from 'node:path'
import { contactMeta, shardCatalog, shardCatalogSig, cachedBySigAsync, fileSigOf } from './meta.ts'
import { displayNameForUsername, mergeDisplayNames, messageIdentityIndex } from './message-identity.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from './search-build.ts'
import type { CallRecord, CallPeer, CallMonthRow, CallsSnapshot } from '../types.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * `已在其它设备接听`：接通了，但本机没有时长。
 *
 * 导出给 `tools/calls-tools.ts` 复用：工具要把它写进「已接听/已在其它设备接听」
 * 的展示文案，复制一份正则就会出现两处判据漂移。
 */
export const ANSWERED_ELSEWHERE = /已在其它设备接听/

/**
 * Decode a message cell: zstd-inflate when the magic matches, else UTF-8/GBK.
 * @param v - raw cell (BLOB, or TEXT holding a comma-joined byte list).
 * @returns the decoded UTF-8 text.
 */
function decodeContent(v: unknown): string {
  let raw: Buffer
  if (v instanceof Uint8Array) raw = Buffer.from(v)
  else if (typeof v === 'string') {
    raw = /^\d+(,\d+)*$/.test(v.trim()) ? Buffer.from(v.split(',').map(Number)) : Buffer.from(v, 'utf8')
  } else return ''
  if (raw.length === 0) return ''
  const bytes = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(bytes)
  }
}

/** Inner text of the first `<tag>`; CDATA unwrapped. */
function tagText(xml: string, tag: string): string {
  const open = '<' + tag
  const si = xml.indexOf(open)
  if (si < 0) return ''
  const gt = xml.indexOf('>', si)
  if (gt < 0) return ''
  const ei = xml.indexOf('</' + tag, gt)
  if (ei < 0) return ''
  const body = xml.slice(gt + 1, ei).trim()
  const c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(body)
  return c ? (c[1] ?? '') : body
}

/** The duration lives in the `<msg>` text (the XML `<duration>` is always 0). */
function parseDuration(text: string): number | undefined {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!m) return undefined
  const a = Number(m[1] ?? 0)
  const b = Number(m[2] ?? 0)
  return m[3] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[3])
}

interface RawCall {
  username: string
  localId: number
  createTime: number
  status: string
  connected: boolean
  durationSec?: number
  outgoing: boolean
  roomType?: number
}

/**
 * 一次通话查询的可选范围/预算（`get_call_history` 工具新增）。
 *
 * 为什么这些不塞进 `CallsSnapshot`：时间范围、对方与扫描预算都是**这次查询的意图**，
 * 不是数据本身。放进快照会让缓存键与「统计口径」纠缠 —— 同一个快照可能只对某次
 * 带预算的调用成立。这里把它们作为独立参数，由 `queryCalls` 拼进缓存键。
 */
export interface CallsQueryOptions {
  /** 起始时间（epoch 秒，含端点）。 */
  fromSec?: number
  /** 截止时间（epoch 秒，含端点）。 */
  toSec?: number
  /** 只保留这些对方 username 的通话（已由调用方把显示名解析成 username）。 */
  peers?: ReadonlySet<string>
  /**
   * 最多检查多少条 type-50 候选行。
   *
   * 为什么不叫「最多返回多少条」：SQL 仍要扫整张表才能筛出 type-50，这个预算限制的是
   * **解码/解析的条数**（真正花 CPU 的部分），命中预算后立即停止并标记截断。
   */
  maxRows?: number
  /** 扫描时间预算（毫秒）。大账号上按块检查，达到后停止并标记截断。 */
  maxMs?: number
  /** 取消信号（问答运行时的 deadline/用户取消）。 */
  signal?: AbortSignal
}

/** 本次扫描是否被预算/取消截断。 */
export interface CallsScanInfo {
  /** 实际检查过的 type-50 候选行数（含随后被对方条件过滤掉的）。 */
  scannedRows: number
  /** 是否因预算停止（此时统计只覆盖已扫描部分）。 */
  truncated: boolean
  /** 截断原因：rows = 行数预算；time = 时间预算。 */
  truncationReason?: 'rows' | 'time'
  /** 是否被 `signal` 取消（结果同样不完整）。 */
  cancelled: boolean
  /** 扫描墙钟耗时（毫秒）。 */
  elapsedMs: number
}

/**
 * 工具需要的通话明细。
 *
 * 为什么不直接给 `CallRecord`：`room_type`（0=语音/1=视频）只在原始行里有，
 * 而 `CallRecord` 属于面板契约、不该为一个工具扩展。这里用子类型携带它，
 * 旧调用方拿到的仍是原来的 `CallsSnapshot`。
 */
export interface CallHistoryRecord extends CallRecord {
  roomType?: number
}

/** `queryCalls` 带扫描参数时的返回值（旧签名仍返回 `CallsSnapshot`）。 */
export interface CallsQueryResult extends CallsSnapshot {
  /** 过滤后的全部通话，按时间倒序（工具据此做 recent/duration/count 排序）。 */
  records: CallHistoryRecord[]
  /** 本次扫描的预算/截断信息（工具写进 note）。 */
  scan: CallsScanInfo
}

/**
 * 在本分片的 `Name2Id` 里定位「我」的 rowid。
 *
 * 为什么不能只比字符串：真机上有的分片把登录账号写成**空 user_name 行**
 * （见 `meta.ts#loadShardMeta` 与 `annual-assets.ts` 的同一判据），此时
 * `sender === selfUsername` 永远不成立，所有通话都会被算成呼入。
 * 优先匹配显式 wxid，缺失时按上述约定退回空行；两者都找不到才交给字符串比较。
 * @param name2id - 本分片的 rowid -> username。
 * @param self - 登录账号 wxid（可能为空）。
 * @returns 「我」的 rowid；无法判定时为 undefined。
 */
function findSelfRowId(name2id: ReadonlyMap<number, string>, self: string): number | undefined {
  if (self) {
    for (const [id, name] of name2id) if (name === self) return id
  }
  for (const [id, name] of name2id) if (name === '') return id
  return undefined
}

/** 扫描结果（含预算/取消状态）。 */
interface ScanCallsResult {
  raw: RawCall[]
  scannedRows: number
  truncated: boolean
  truncationReason?: 'rows' | 'time'
  cancelled: boolean
  elapsedMs: number
}

/** Scan every message shard for type-50 rows and decode the voip XML. */
async function scanCalls(
  decryptedDir: string,
  selfUsername: string,
  options: CallsQueryOptions = {},
): Promise<ScanCallsResult> {
  const started = Date.now()
  const identity = messageIdentityIndex(decryptedDir, ['message'])
  const self = (selfUsername ?? '').trim()
  const fromSec = typeof options.fromSec === 'number' && Number.isFinite(options.fromSec)
    ? Math.trunc(options.fromSec)
    : undefined
  const toSec = typeof options.toSec === 'number' && Number.isFinite(options.toSec)
    ? Math.trunc(options.toSec)
    : undefined
  const peers = options.peers
  const maxRows = typeof options.maxRows === 'number' && Number.isFinite(options.maxRows) && options.maxRows > 0
    ? Math.trunc(options.maxRows)
    : undefined
  const maxMs = typeof options.maxMs === 'number' && Number.isFinite(options.maxMs) && options.maxMs > 0
    ? Math.trunc(options.maxMs)
    : undefined
  const aborted = (): boolean => options.signal?.aborted === true
  const out: RawCall[] = []
  let scannedRows = 0
  let truncated = false
  let truncationReason: 'rows' | 'time' | undefined
  let cancelled = false
  // 标签用来从多层循环里一次退出；`finally` 仍会关掉当前分片连接。
  outer:
  for (const shard of shardCatalog(decryptedDir)) {
    if (aborted()) { cancelled = true; break }
    if (maxMs !== undefined && Date.now() - started >= maxMs) {
      truncated = true
      truncationReason = 'time'
      break
    }
    const tables = [...shard.tables.keys()]
    if (tables.length === 0) continue
    let db: DatabaseSync
    try { db = new DatabaseSync(shard.file, { readOnly: true }) } catch { continue }
    try {
      // Name2Id 是分片级共用的，先在表循环外定位一次「我」的 rowid。
      const firstMeta = shard.tables.values().next().value
      const selfRowId = findSelfRowId(firstMeta?.name2id ?? new Map(), self)
      for (const table of tables) {
        if (aborted()) { cancelled = true; break outer }
        if (maxMs !== undefined && Date.now() - started >= maxMs) {
          truncated = true
          truncationReason = 'time'
          break outer
        }
        const meta = shard.tables.get(table)
        if (!meta || !meta.cols.has('message_content')) continue
        // 时间范围下沉到 SQL：大账号里绝大多数行在 `create_time` 上就被排除，
        // 不必逐行解码 XML（真正的 CPU 开销所在）。
        const where = ['(local_type & 4294967295) = 50']
        const params: number[] = []
        if (fromSec !== undefined) { where.push('create_time >= ?'); params.push(fromSec) }
        if (toSec !== undefined) { where.push('create_time <= ?'); params.push(toSec) }
        // 2026-09-28：`.all()` → 游标 + 行级让出。
        // 本机真实数据实测 `queryCalls` 冷跑 **87ms 且一次都不让出**
        // （`working/probe-stall.txt`），是"整段独占"清单里剩下的最长一个：
        // 它要逐张消息分片把 type-50 的行捞出来，并对每行做 XML 解析（`tagText`）。
        let rows: Iterable<Record<string, unknown>>
        try {
          rows = db.prepare(
            `SELECT local_id AS l, create_time AS t, real_sender_id AS s, message_content AS c FROM "${table}" WHERE ${where.join(' AND ')}`,
          ).iterate(...params) as Iterable<Record<string, unknown>>
        } catch { continue }
        const talker = identity.tableToUsername.get(table) ?? ''
        let sinceYield = 0
        for (const r of rows) {
          // 行数预算按**检查过的候选行**计：即使最终被对方条件过滤掉，
          // 解码与 XML 解析的成本已经付过，必须计入预算。
          if (maxRows !== undefined && scannedRows >= maxRows) {
            truncated = true
            truncationReason = 'rows'
            break outer
          }
          scannedRows += 1
          // 每 256 行检查一次取消/时间预算：逐行 `Date.now()` 在大账号上本身就是
          // 可观开销，这个粒度既能及时停下，又不会把扫描拖慢。
          if ((scannedRows & 0xff) === 0) {
            if (aborted()) { cancelled = true; break outer }
            if (maxMs !== undefined && Date.now() - started >= maxMs) {
              truncated = true
              truncationReason = 'time'
              break outer
            }
          }
          const xml = decodeContent(r['c'])
          if (!xml) continue
          const status = tagText(xml, 'msg').trim()
          const durationSec = parseDuration(status)
          const connected = durationSec !== undefined || ANSWERED_ELSEWHERE.test(status)
          const sender = meta.name2id.get(Number(r['s'] ?? 0)) ?? ''
          // 方向：real_sender_id 是「我」→ 呼出；否则是对方（或退回表名反解）。
          // 「我」优先按 rowid 判（兼容空 user_name 行），再退回字符串比较。
          const senderRowId = Number(r['s'] ?? 0)
          const outgoing = (selfRowId !== undefined && senderRowId === selfRowId)
            || (self.length > 0 && sender === self)
          const username = outgoing ? talker : (sender && sender !== self ? sender : talker)
          if (peers && !peers.has(username)) continue
          // 空标签不能 `Number('')`：那会变成 0（语音），把「字段缺失」伪装成
          // 「确定是语音」。缺失就保持 undefined，工具只说「通话」。
          const roomTypeText = tagText(xml, 'room_type').trim()
          const roomType = roomTypeText === '' ? Number.NaN : Number(roomTypeText)
          out.push({
            username,
            localId: Number(r['l'] ?? 0),
            createTime: Number(r['t'] ?? 0),
            status,
            connected,
            ...(durationSec !== undefined ? { durationSec } : {}),
            outgoing,
            ...(Number.isFinite(roomType) ? { roomType } : {}),
          })
          sinceYield += 1
          if (sinceYield >= YIELD_EVERY_ROWS) {
            sinceYield = 0
            await yieldToLoop()
            if (aborted()) { cancelled = true; break outer }
          }
        }
      }
    } finally {
      db.close()
    }
    // 分片级让出：一张分片可以有十几万行，逐表之间也要交还控制权。
    await yieldToLoop()
  }
  return {
    raw: out,
    scannedRows,
    truncated,
    ...(truncationReason !== undefined ? { truncationReason } : {}),
    cancelled,
    elapsedMs: Date.now() - started,
  }
}

/** `YYYY-MM` in local time. */
function monthOf(sec: number): string {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 原始通话行 → 对外记录（面板 recent 与工具 records 共用同一份映射）。
 * @param c - 原始行。
 * @param names - 显示名映射。
 * @param enterpriseNames - 企业名映射。
 * @param includeRoomType - 是否带上 `roomType`（面板契约不含它，工具需要它判语音/视频）。
 */
function toCallRecord(
  c: RawCall,
  names: ReadonlyMap<string, string>,
  enterpriseNames: ReadonlyMap<string, string>,
  includeRoomType = false,
): CallHistoryRecord {
  const enterpriseName = enterpriseNames.get(c.username)?.trim()
  return {
    username: c.username,
    name: displayNameForUsername(c.username, names),
    ...(enterpriseName ? { enterpriseName } : {}),
    localId: c.localId,
    createTime: c.createTime,
    status: c.status,
    connected: c.connected,
    outgoing: c.outgoing,
    ...(c.durationSec !== undefined ? { durationSec: c.durationSec } : {}),
    ...(includeRoomType && c.roomType !== undefined ? { roomType: c.roomType } : {}),
  }
}

function buildSnapshot(
  raw: RawCall[],
  names: ReadonlyMap<string, string>,
  enterpriseNames: ReadonlyMap<string, string>,
  topPeers: number,
  recentLimit: number,
): CallsSnapshot {
  const byPeer = new Map<string, { calls: number; connected: number; durationSec: number; lastTime: number }>()
  const byMonth = new Map<string, { calls: number; connected: number; durationSec: number }>()
  const byHour = new Array<number>(24).fill(0)
  const unanswered = new Map<string, number>()
  let total = 0
  let connectedCount = 0
  let durationSec = 0
  let outgoing = 0
  let longestSec = 0
  let longestPeer = ''
  let firstTime: number | null = null
  let lastTime: number | null = null
  const connectedDurations: number[] = []

  for (const c of raw) {
    total += 1
    if (c.connected) connectedCount += 1
    if (c.outgoing) outgoing += 1
    const d = c.durationSec ?? 0
    durationSec += d
    if (d > longestSec) { longestSec = d; longestPeer = c.username }
    if (c.connected) connectedDurations.push(d)
    if (!c.connected && c.status) unanswered.set(c.status, (unanswered.get(c.status) ?? 0) + 1)
    const peer = byPeer.get(c.username) ?? { calls: 0, connected: 0, durationSec: 0, lastTime: 0 }
    peer.calls += 1
    if (c.connected) peer.connected += 1
    peer.durationSec += d
    if (c.createTime > peer.lastTime) peer.lastTime = c.createTime
    byPeer.set(c.username, peer)
    if (c.createTime > 0) {
      const m = monthOf(c.createTime)
      const row = byMonth.get(m) ?? { calls: 0, connected: 0, durationSec: 0 }
      row.calls += 1
      if (c.connected) row.connected += 1
      row.durationSec += d
      byMonth.set(m, row)
      const hour = new Date(c.createTime * 1000).getHours()
      byHour[hour] = (byHour[hour] ?? 0) + 1
      if (firstTime == null || c.createTime < firstTime) firstTime = c.createTime
      if (lastTime == null || c.createTime > lastTime) lastTime = c.createTime
    }
  }

  const peers: CallPeer[] = [...byPeer.entries()]
    .map(([username, p]) => {
      const enterpriseName = enterpriseNames.get(username)?.trim()
      return {
        username,
        name: displayNameForUsername(username, names),
        ...(enterpriseName ? { enterpriseName } : {}),
        ...p,
      }
    })
    .sort((a, b) => b.calls - a.calls || b.durationSec - a.durationSec)
  const months: CallMonthRow[] = [...byMonth.entries()]
    .map(([month, m]) => ({ month, ...m }))
    .sort((a, b) => (a.month < b.month ? -1 : 1))
  const recent: CallRecord[] = [...raw]
    .filter(c => c.createTime > 0)
    .sort((a, b) => b.createTime - a.createTime)
    .slice(0, recentLimit)
    .map(c => toCallRecord(c, names, enterpriseNames))

  return {
    total,
    connected: connectedCount,
    missed: total - connectedCount,
    durationSec,
    avgSec: connectedDurations.length > 0 ? Math.round(durationSec / connectedDurations.length) : 0,
    longestSec,
    longestPeer: longestPeer ? displayNameForUsername(longestPeer, names) : '',
    outgoing,
    incoming: total - outgoing,
    ackElsewhere: raw.filter(c => !c.durationSec && ANSWERED_ELSEWHERE.test(c.status)).length,
    peers: peers.slice(0, topPeers),
    peerCount: peers.length,
    months,
    byHour,
    unanswered: [...unanswered.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    recent,
    from: firstTime,
    to: lastTime,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

/** 过滤后的全部通话明细（工具排序用；时间倒序）。 */
function buildCallRecords(
  raw: RawCall[],
  names: ReadonlyMap<string, string>,
  enterpriseNames: ReadonlyMap<string, string>,
): CallHistoryRecord[] {
  return [...raw]
    .filter(c => c.createTime > 0)
    .sort((a, b) => b.createTime - a.createTime || b.localId - a.localId)
    .map(c => toCallRecord(c, names, enterpriseNames, true))
}

/**
 * Compute the call inventory snapshot (cached on shard + contact fingerprints).
 *
 * 旧签名保持不变（面板仍按 4 个位置参数调用）；第 5 个参数是工具新增的
 * 范围/对方/预算，只有传了它才返回带 `records` 与 `scan` 的扩展结果。
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @param topPeers - how many peers to return (default 20).
 * @param recentLimit - how many recent records to return (default 50).
 * @param options - 可选范围/对方/扫描预算（不传 = 旧的整份快照）。
 * @returns the calls snapshot（带 options 时额外含 records/scan）。
 */
export function queryCalls(
  decryptedDir: string,
  selfUsername?: string,
  topPeers?: number,
  recentLimit?: number,
): Promise<CallsSnapshot>
export function queryCalls(
  decryptedDir: string,
  selfUsername: string | undefined,
  topPeers: number,
  recentLimit: number,
  options: CallsQueryOptions,
): Promise<CallsQueryResult>
export async function queryCalls(
  decryptedDir: string,
  selfUsername?: string,
  topPeers = 20,
  recentLimit = 50,
  options?: CallsQueryOptions,
): Promise<CallsSnapshot | CallsQueryResult> {
  const self = selfUsername ?? ''
  const top = Math.max(0, Math.trunc(Number.isFinite(topPeers) ? topPeers : 20))
  const recent = Math.max(0, Math.trunc(Number.isFinite(recentLimit) ? recentLimit : 50))
  const fromSec = typeof options?.fromSec === 'number' && Number.isFinite(options.fromSec)
    ? Math.trunc(options.fromSec)
    : undefined
  const toSec = typeof options?.toSec === 'number' && Number.isFinite(options.toSec)
    ? Math.trunc(options.toSec)
    : undefined
  const peerKey = options?.peers ? JSON.stringify([...options.peers].sort()) : ''
  const hasOptions = options !== undefined
  // 通话快照里的对端昵称来自 contact.db，所以它也必须进签名：原先只签分片 + self，
  // 靠「事件后整表清空」兜住（M8 去掉那层兜底后必须补上真正读了的东西）。
  const sig = [
    shardCatalogSig(decryptedDir, ['message']),
    self,
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    fileSigOf(join(decryptedDir, 'message', 'message_resource.db')),
    fileSigOf(join(decryptedDir, 'session', 'session.db')),
  ].join('|')
  // 过滤器与预算必须进缓存键：否则第一次「只看李四」的结果会被后续「看全部」
  // 复用（或反过来），表现是**不报错但结果错**。不带 options 时保留旧键，
  // 面板的缓存命中行为与升级前完全一致。
  const key = hasOptions
    ? `calls:${decryptedDir}:q:${fromSec ?? ''}:${toSec ?? ''}:${peerKey}:${top}:${recent}:${options?.maxRows ?? ''}:${options?.maxMs ?? ''}`
    : 'calls:' + decryptedDir
  // 2026-09-28：同步 `cachedBySig` → async 版 —— 冷算实测 87ms 且**一次都不让出**
  // （真实数据 `working/probe-stall.txt`），换 async 才能在里面按档 `yieldToLoop()`。
  return cachedBySigAsync(key, sig, async () => {
    const scan = await scanCalls(decryptedDir, self, options ?? {})
    const meta = contactMeta(decryptedDir)
    const identity = messageIdentityIndex(decryptedDir, ['message'])
    const names = mergeDisplayNames(decryptedDir, identity.usernames)
    const snapshot = buildSnapshot(scan.raw, names, meta.enterpriseNames, top, recent)
    if (!hasOptions) return snapshot
    return {
      ...snapshot,
      records: buildCallRecords(scan.raw, names, meta.enterpriseNames),
      scan: {
        scannedRows: scan.scannedRows,
        truncated: scan.truncated,
        ...(scan.truncationReason !== undefined ? { truncationReason: scan.truncationReason } : {}),
        cancelled: scan.cancelled,
        elapsedMs: scan.elapsedMs,
      },
    } satisfies CallsQueryResult
  }, 60_000, (value) => {
    // 半成品（预算截断/被取消）不写缓存：下一次请求应当重新算，
    // 而不是在整个 TTL 里继续看到同一份不完整统计。
    const scan = (value as Partial<CallsQueryResult>).scan
    return scan === undefined || (!scan.truncated && !scan.cancelled)
  })
}
