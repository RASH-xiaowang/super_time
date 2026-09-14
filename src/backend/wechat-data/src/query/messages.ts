/**
 * Message queries over st_control's decrypted message DBs (wechat 4.x).
 * Each talker's messages live in a `Msg_<md5(username)>` table spread across
 * message_<n>.db / biz_message_<n>.db shards; the shard is located by scanning
 * for the table.
 *
 * Sender identity mirrors st_control: `real_sender_id` is an internal rowid
 * resolved through each shard's Name2Id table (rowid -> wxid); when that is
 * empty the content `wxid_xxx:\n` prefix is used. `is_self` is computed
 * (the raw `is_sender` column does not exist in wechat 4.x) by comparing the
 * sender with the logged-in account wxid; Name2Id rows whose user_name is
 * empty are WeChat's own marker for the logged-in account.
 *
 * Pagination is keyset-based on `sort_seq` (the millisecond-level stable
 * order key), matching st_control: newer messages have a larger sort_seq, and
 * the next page cursor is the smallest sort_seq of the current page. Sorting
 * by `create_time` + OFFSET is unstable — many WeChat 4.x rows share a
 * second-precision create_time, so OFFSET pages silently skip/duplicate rows.
 * `message_content` may be zstd-compressed (magic 0x28B52FFD) or GBK; both
 * are decoded here so text/rich parsing sees the real content.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { decompress } from 'fzstd'
import type { MessagesSnapshot, MessageTypeStat, WechatMessage } from '../types.ts'
import { classifyRender, parseAtUsernames, parseMessageContent, RENDER_LABEL, richPlaceholder } from './parse.ts'
import { cachedBySig, contactMeta, shardCatalog, shardCatalogSig } from './meta.ts'

/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/**
 * Normalize a wechat local_type.
 *
 * `local_type` 的高 32 位是 **appmsg 子类型 / 属性标志**，低 32 位才是类型。
 * 归一化必须取低 32 位：`25769803825 = 0x6_00000031`（文件）、
 * `8589934592049 = 0x7d0_00000031`（转账）、`244813135921 = 0x39_00000031`
 * （引用）都靠这一步落回 49。
 *
 * 旧实现写的是 `localType > 0x100000000 ? localType % 0x100000000 : localType`，
 * 对负值/恰好等于边界的值语义不明确；这里统一成 `& 0xFFFFFFFF` 语义，
 * 与 SQL 侧的 `(local_type & 4294967295)` 完全一致（此前两处口径不同）。
 * @param localType - raw local_type value from the DB.
 * @returns the normalized (low 32 bit) type value.
 */
export function normalizeMsgType(localType: number): number {
  if (!Number.isFinite(localType)) return 0
  const MOD = 0x100000000
  const v = Math.trunc(localType)
  // 正数取模即低 32 位（本机最大 8.6e12 < 2^53，整数精确）；负数按无符号回绕。
  return v >= 0 ? v % MOD : ((v % MOD) + MOD) % MOD
}

/**
 * Human label for a normalized message type (mirror st_control).
 *
 * 标签取值依据本机 138,604 条消息的 local_type 低 32 位普查：
 *   1×92865 文本 / 3×25987 图片 / 49×8740 应用消息 / 43×6646 视频 /
 *   10000×1955 系统消息 / 47×1466 表情 / 34×696 语音 / 50×135 通话 /
 *   48×92 位置 / 11000×13 无内容 / 42×5 名片 / 66×4 企业微信名片
 *
 * 两处经实测纠正、容易想当然的地方：
 *  - 49 不是"链接"：它只是 appmsg 容器。8,740 条里真正的链接只有约 506 条，
 *    其余是文件(6)/引用(57)/小程序(33)/接龙(53)/转账(2000)/合并转发(19)等，
 *    具体种类由 XML 的 <appmsg><type> 决定（见 parseAppmsg）。故通用标签用
 *    "应用消息"，精确种类由 rich 解析给出。
 *  - 10000 不是"撤回消息"：1,955 条中 revokemsg 仅 31 条，
 *    sysmsgtemplate 1,172 条、无 type 属性的纯文本系统消息 752 条。
 *    故通用标签保持"系统消息"，撤回只是其子类型。
 *
 * @param localType - raw local_type value from the DB.
 * @returns the Chinese display label for the type.
 */
export function msgTypeLabel(localType: number): string {
  switch (normalizeMsgType(localType)) {
    case 1: return '文本'
    case 3: return '图片'
    case 34: return '语音'
    case 42: return '名片'
    case 43: return '视频'
    case 47: return '表情'
    case 48: return '位置'
    case 49: return '应用消息'
    // 通话：Xml 里的 <room_type> 到底是语音还是视频**未经验证**（本机 135 条全在
    // 单聊会话，0×39 / 1×96），所以标签不再断言「语音」。
    case 50: return '通话'
    case 66: return '企业微信名片'
    case 244: case 246: return '文件'
    case 10000: return '系统消息'
    case 10002: return '撤回消息'
    case 11000: return '无内容消息'
    case 859832288: case 922746960: return '拍一拍'
    case 244135593199: return '小程序'
    default: return '未知消息'
  }
}

/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data: Buffer): Buffer | null {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { return Buffer.from(decompress(data)) } catch { return null }
  }
  return null
}

/** Decode a DB cell (TEXT or BLOB) to UTF-8 text, handling zstd + GBK. */
function decodeBlobText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = tryDecompress(raw)
  const bytes = decompressed ?? raw
  // UTF-8 first; GBK fallback for legacy-encoded fields.
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(bytes)
  }
}

/** Read a TEXT-or-BLOB column as raw bytes (rusqlite get_bytes equivalent). */
function cellBytes(v: unknown): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v)
  if (typeof v === 'string') return Buffer.from(v, 'utf8')
  return Buffer.alloc(0)
}

/**
 * Extract the group sender username from decoded message content.
 * The content is often a binary header + 'wxid_xxx:\n' + body; scan for a
 * username-like token followed by ':\n' anywhere, and skip binary blobs.
 * @param content - decoded message content.
 * @param talker - conversation username, used to reject the group-id prefix.
 */
function senderFromContent(content: string, talker: string): string | null {
  if (!content) return null
  let printable = 0
  for (let i = 0; i < content.length && i < 512; i += 1) {
    const c = content.charCodeAt(i)
    if ((c >= 0x20 && c <= 0x7e) || c >= 0x80) printable += 1
  }
  if (content.length > 0 && printable / Math.min(content.length, 512) < 0.6) return null
  const m = content.match(/([A-Za-z0-9_@.\-]{3,64}):\n/)
  if (!m) return null
  const head = m[1] ?? ''
  if (head.includes('<')) return null
  // 系统消息（sysmsg）的内容前缀是【会话本身】，例如
  // "50345516636@chatroom: <sysmsg ...>"。那不是发送者，
  // 若不排除会把系统消息记成"群自己发的"。
  if (talker && head === talker) return null
  return head
}
/**
 * Resolve wechat system-message placeholders: `$wxid_xxx$` to the contact’s
 * display name. System messages (type 10000) reference a sender by id and
 * must render as the contact name (e.g. the red-packet notice).
 * @param text - raw display text.
 * @param contactNames - username -> display-name map.
 * @returns text with resolved names (unknown ids stay as-is).
 */
function resolveSysRefs(text: string, contactNames: Map<string, string>): string {
  const D = String.fromCharCode(36)
  let out = ''
  let rest = text
  for (;;) {
    const s = rest.indexOf(D)
    if (s < 0) { out += rest; break }
    const e = rest.indexOf(D, s + 1)
    if (e < 0) { out += rest; break }
    const id = rest.slice(s + 1, e)
    if (/^[A-Za-z0-9_.@-]{3,64}$/.test(id) && contactNames.has(id)) {
      out += rest.slice(0, s) + ' ' + (contactNames.get(id) ?? id) + ' '
      rest = rest.slice(e + 1)
    } else {
      out += rest.slice(0, e + 1)
      rest = rest.slice(e + 1)
    }
  }
  return out
}

/**
 * Strip XML/二进制噪声，得到一句可读的正文预览。
 *
 * 旧实现是「删掉所有 `<...>` 再截断」，这在**标签未闭合或属性特别多**时会翻车：
 * 正则匹配不到 `>`，于是整串属性被当成正文 —— 实测 207 条表情、5,604 条视频消息
 * 由此渲染出 `fromusername = "wxid_..." md5 = "626ac..." …` 这样的属性汤。
 * 现在对 XML 只取**文本节点与 CDATA**（属性一律丢弃）；非 XML（含 base64 头）走原样。
 * @param content - raw message content.
 * @returns a plain-text preview (max 200 chars).
 */
export function msgText(content: string): string {
  if (!content) return ''
  let raw = content.replace(/^\s+/, '')
  // 群消息的原始内容是 `wxid_xxx:\n<sysmsg …>` 这种「发送者前缀 + 载荷」。
  // 不先剥掉前缀，下面「是不是 XML」的判断就会落空，整段 XML 被当普通文本原样返回
  // —— 实测群里的系统消息（10000）就是这样把 <sysmsg …> 直接显示出来的。
  const prefix = raw.match(/^[A-Za-z0-9_@.\-]{3,64}:\s/)
  if (prefix) raw = raw.slice(prefix[0].length).replace(/^\s+/, '')
  if (!raw.startsWith('<')) {
    // 非 XML：图片消息的 content 常是一段 base64 文件头，那不是给人看的内容。
    if (/^[A-Za-z0-9+/=]{40,}$/.test(raw.replace(/\s+/g, ''))) return ''
    return raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  const parts: string[] = []
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|>([^<]+)</g)) {
    const v = (m[1] ?? m[2] ?? '').trim()
    if (v) parts.push(v)
    if (parts.join(' ').length > 200) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * rich 描述 → 一句可读占位。
 *
 * 实现已迁到 `parse.ts`（`richPlaceholder`）以便与 `renderType` 分类同源；
 * 这里保留同名导出，避免其它模块的 import 断掉。
 */
export { richPlaceholder }

/**
 * 消息内容里是否可能带 @ 提及。
 *
 * 结构化 @ 列表在 `source` 列（`<msgsource><atuserlist>`），只有群消息才有；
 * 私聊/系统消息直接跳过，省掉每条的 XML 正则开销。
 */
function needsAtUsers(talker: string, type: number, content: string): boolean {
  if (!talker.endsWith('@chatroom')) return false
  if (type !== 1 && type !== 49) return false
  return content.includes('@')
}

function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** One raw message row from a shard. */
interface RawMsgRow {
  localId: number
  sortSeq: number
  localType: number
  isSender: number
  createTime: number
  senderUsername: string
  /** Name2Id 存在该 rowid 且 user_name 为空 —— WeChat 4.x 的「登录账号」标记。 */
  name2IdEmptySelf?: boolean
  content: Buffer
  realSenderId?: number
  serverId?: string
  /** `source` 列原文（`<msgsource>`，zstd 压缩）——群 @ 提及与签名在这里。 */
  source?: Buffer
}

/** A shard database that contains the talker's table. */
interface MsgShard {
  db: DatabaseSync
  file: string
  cols: Set<string>
  name2id: Map<number, string>
}

/**
 * 已删除：原先在分片 Name2Id 解析不到 real_sender_id 时，回退去查
 * message_resource.db 的 SenderName2Id。
 *
 * 这是错的：real_sender_id 是【分片自身 Name2Id 的 rowid】，而 SenderName2Id
 * 是 message_resource.db 自己的 id 空间。实测（本机真实数据）：
 *   - 两个空间同时存在的 719 个 id，**100% 指向不同的人**；
 *   - 分片 Name2Id 每库只有 1 行空串（message_0 的 rowid 40、message_1 的 rowid 6），
 *     但引用它们的消息有 **8,422 条（占全部消息 6%）**，原先全部被安上了错误人名；
 *   - 更糟的是 r.senderUsername 被填了值后，toWechatMessages 里更可靠的
 *     「内容 wxid_xxx:\n 前缀」解析永远轮不到。
 *
 * 现在解析不到就留空：由内容前缀兜底，或由界面显示为未知发送者。
 */

/**
 * 用 server_id 反查一条消息的 create_time（第 67 轮）。
 *
 * 用途：`SessionTable.unread_first_msg_srv_id` 指向该会话**最早的一条未读**，
 * 把它换成时间就能显示「未读 48 条 · 最早 2 小时前」，比光一个数字更能判断该先看哪个。
 * 实测本机 41 个未读会话里 39 个能解析（另 2 个 srv_id=0，是合成会话），
 * 全部解析耗时 ~7ms（复用 catalog 的分片索引），所以可以放在 getSessions 里同步做。
 *
 * ⚠️ `server_id` 是 int64：SQL 侧必须 `CAST(server_id AS TEXT)` 比对，否则读出来就 `ERR_OUT_OF_RANGE`。
 * @param decryptedDir - decrypted root.
 * @param talker - 会话 username（决定 Msg_ 表名与所在分片）。
 * @param serverId - server_id 的**字符串**形式。
 * @returns create_time（epoch 秒），解析不到返回 null。
 */
export function msgCreateTimeByServerId(decryptedDir: string, talker: string, serverId: string): number | null {
  if (!talker || !serverId || serverId === '0') return null
  const table = msgTableName(talker)
  for (const shard of findShards(decryptedDir, table)) {
    try {
      const row = shard.db.prepare(`SELECT CAST(create_time AS TEXT) AS ct FROM "${table}" WHERE CAST(server_id AS TEXT) = ?`).get(serverId) as { ct?: unknown } | undefined
      const n = Number(row?.ct ?? 0)
      if (n > 0) return n
    } catch {
      // 该分片读失败就试下一个
    } finally {
      shard.db.close()
    }
  }
  return null
}

/** Locate every shard DB containing the talker's Msg table (catalog-backed). */
function findShards(decryptedDir: string, table: string): MsgShard[] {
  const out: MsgShard[] = []
  for (const shard of shardCatalog(decryptedDir)) {
    const meta = shard.tables.get(table)
    if (!meta) continue
    try {
      const db = new DatabaseSync(shard.file, { readOnly: true })
      out.push({ db, file: shard.file, cols: meta.cols, name2id: meta.name2id })
    } catch {
      // try next shard
    }
  }
  return out
}

/**
 * Query one shard page (keyset by sort_seq, falling back to local_id).
 * @param shard - shard with the talker table.
 * @param table - Msg table name.
 * @param cursor - smallest sort_seq already loaded (exclusive), or undefined for the newest page.
 * @param limit - max rows from this shard.
 * @returns raw rows in descending order.
 */
function queryShardRows(shard: MsgShard, table: string, cursor: number | undefined, limit: number, cursorLocalId?: number): RawMsgRow[] {
  return queryShardRowsWith(shard, table, cursor, undefined, limit, false, cursorLocalId)
}

/**
 * Shared shard row query: newest-page / older-page / newer-than-after.
 *
 * ⚠️ 只靠 sort_seq 分页会**静默丢消息**：sort_seq 存在重复值（本机 235 张
 * Msg_ 表中 14 张有重复，最严重的一张 65,035 行漏 39 条），当分页边界恰好落在
 * 重复值上时，`WHERE sort_seq < cursor` 会跳过与边界同值的其余行。
 * 因此额外接受 `cursorLocalId`，改用复合游标
 * `sort_seq < c OR (sort_seq = c AND local_id < l)`，并给 ORDER BY 补上
 * local_id 兜底以保证页边界确定。未传 cursorLocalId 时保持原行为（向后兼容）。
 */
function queryShardRowsWith(
  shard: MsgShard, table: string, cursor: number | undefined, after: number | undefined,
  limit: number, ascending: boolean, cursorLocalId?: number,
): RawMsgRow[] {
  const { db, cols } = shard
  const has = (c: string): boolean => cols.has(c)
  const sel = (c: string, dft: string): string => (has(c) ? c : dft)
  if (!has('local_id') || !has('create_time')) return []
  const orderCol = has('sort_seq') ? 'sort_seq' : 'local_id'
  const useComposite = cursor !== undefined && cursorLocalId !== undefined && has('sort_seq')
  const params: number[] = []
  let whereClause = ''
  if (after !== undefined) {
    whereClause = has('sort_seq') ? 'WHERE sort_seq > ?' : 'WHERE local_id > ?'
    params.push(after)
  } else if (cursor !== undefined) {
    if (useComposite) {
      whereClause = 'WHERE sort_seq < ? OR (sort_seq = ? AND local_id < ?)'
      params.push(cursor, cursor, cursorLocalId as number)
    } else {
      whereClause = has('sort_seq') ? 'WHERE sort_seq < ?' : 'WHERE local_id < ?'
      params.push(cursor)
    }
  }
  const serverSel = has('server_id') ? 'CAST(server_id AS TEXT) AS server_id' : "'0' AS server_id"
  const sql = [
    'SELECT',
    [sel('local_id', '0'), sel('sort_seq', 'local_id'), sel('local_type', '0'), sel('is_sender', '0'),
      sel('create_time', '0'), sel('real_sender_id', '0'), sel('message_content', 'NULL'), serverSel,
      // source 是群消息 @提及（<atuserlist>）与反垃圾签名的唯一来源；
      // 缺失的库（老分片）用 NULL 兜底，解码端按空处理。
      sel('source', 'NULL')].join(', '),
    'FROM ' + table,
    whereClause,
    'ORDER BY ' + orderCol + (ascending ? ' ASC' : ' DESC') + ', local_id ' + (ascending ? 'ASC' : 'DESC'),
    'LIMIT ?',
  ].filter(Boolean).join(' ')
  params.push(limit)
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map((r) => {
    const realSenderId = Number(r[sel('real_sender_id', '0')] ?? 0)
    const rawSource = r[sel('source', 'NULL')]
    // has + get：区分「Name2Id 没有该 rowid」与「有该 rowid 但 user_name 为空」。
    // 空 user_name 是 WeChat 4.x 对登录账号自己的标记，不能和 miss 混为一谈。
    const hasName = shard.name2id.has(realSenderId)
    const nameVal = hasName ? (shard.name2id.get(realSenderId) ?? '') : undefined
    return {
      localId: Number(r[sel('local_id', '0')] ?? 0),
      sortSeq: Number(r[sel('sort_seq', 'local_id')] ?? 0),
      localType: Number(r[sel('local_type', '0')] ?? 0),
      isSender: Number(r[sel('is_sender', '0')] ?? 0),
      createTime: Number(r[sel('create_time', '0')] ?? 0),
      senderUsername: nameVal ?? '',
      ...(nameVal === '' && hasName && realSenderId > 0 ? { name2IdEmptySelf: true } : {}),
      content: cellBytes(r[sel('message_content', 'NULL')]),
      realSenderId,
      ...(rawSource !== null && rawSource !== undefined ? { source: cellBytes(rawSource) } : {}),
      ...(typeof r['server_id'] === 'string' ? { serverId: r['server_id'] } : {}),
    }
  })
}

/**
 * Map raw rows to WechatMessage (decode + parse + sender/is_self resolution).
 * @param rows - raw rows in display order.
 * @param talker - conversation username.
 * @param isGroup - whether the talker is a chatroom.
 * @param contactNames - username -> display-name map.
 * @param selfUsername - logged-in account wxid (empty => private heuristic).
 * @returns the mapped messages.
 */
function toWechatMessages(
  rows: RawMsgRow[], talker: string, isGroup: boolean,
  contactNames: Map<string, string>, selfUsername?: string,
): WechatMessage[] {
  return rows.map((r) => {
    const normType = normalizeMsgType(r.localType)
    const content = decodeBlobText(r.content)
    const parsed = parseMessageContent(normType, content, isGroup)
    // sender identity: 分片 Name2Id 最可靠；解析不到时用内容里的
    // "wxid_xxx:\n" 前缀（群消息）兜底。注意【不能】拿 real_sender_id 去查
    // message_resource.db 的 SenderName2Id —— 那是另一套 id 空间（实测同 id
    // 100% 指向不同的人），会给出错误的人名。
    const prefixSender = senderFromContent(content, talker)
    const name2IdSender = r.senderUsername || ''
    // 内容前缀（真实 wxid）优先于 Name2Id；Name2Id 空行是「自己」的占位。
    const sender = prefixSender || name2IdSender
    const self = selfUsername && selfUsername.length > 0 ? selfUsername.trim() : ''
    // isSelf 判定（WeChat 4.x Msg_ 表没有 is_sender 列，只能推导）：
    // 1. 已解析 sender 且已知 self → 精确比对；
    // 2. 内容前缀未给出 sender，且 Name2Id 为空行 → 登录账号自己
    //    （实测约 6% 消息走这条路径；原先漏判会把「我发的」全画到对方侧）；
    // 3. 私聊且 sender === talker → 对方；
    // 4. 私聊且 self 未知、sender 是别的 wxid → 按启发式视为自己；
    // 5. 其余（群聊未知 sender 等）→ 对方/未知，避免把别人的气泡画成自己。
    let isSelf = false
    if (sender.length > 0 && self.length > 0) {
      isSelf = sender === self
      // 私聊对端 talker 不可能是「自己」：selfUsername 被错配成对方 wxid 时
      // 若不拦，对方的消息会画到右侧（串成「我发的」）。
      if (!isGroup && sender === talker) isSelf = false
    } else if (!prefixSender && r.name2IdEmptySelf === true) {
      isSelf = true
    } else if (!isGroup && sender.length > 0 && sender === talker) {
      isSelf = false
    } else if (!isGroup && sender.length > 0 && sender !== talker && self.length === 0) {
      isSelf = true
    }
    const msg: WechatMessage = {
      localId: r.localId,
      ...(r.serverId ? { serverId: r.serverId } : {}),
      sortSeq: r.sortSeq,
      type: normType,
      isSender: isSelf ? 1 : 0,
      createTime: r.createTime,
      msgContent: content,
      strContent: content,
      typeLabel: msgTypeLabel(r.localType),
    }
    // displayText 必须**永远是可读文本**：界面在它为空时会退回 strContent/msgContent
    // （原始 XML/二进制），那正是「表情/视频消息显示成一串属性」的根因。
    // 有 rich 描述时给出类型占位（[图片]/[表情]…），没有 rich 才退回文本抽取。
    const displayText = parsed.text || (parsed.rich ? richPlaceholder(parsed.rich) : msgText(content))
    if (displayText) msg.displayText = resolveSysRefs(displayText, contactNames)
    if (parsed.rich) msg.rich = parsed.rich
    // 归一化呈现种类：界面只按它 switch，不再自己拼白名单。
    const render = classifyRender(normType, parsed.rich, parsed.sysKind)
    msg.renderType = render
    msg.renderLabel = RENDER_LABEL[render] ?? '未知消息'
    if (parsed.sysKind) msg.sysKind = parsed.sysKind
    // 群消息的 @提及：结构化列表在 source 列（<msgsource><atuserlist>），
    // 解析出 wxid 后配可展示昵称，界面才能只高亮真正的提及而不是所有 @。
    if (needsAtUsers(talker, normType, content) && r.source) {
      const names = parseAtUsernames(decodeBlobText(r.source))
      if (names.length > 0) {
        msg.atUsers = names.map((username) => ({
          username,
          displayName: username === 'notify@all' ? '所有人' : (contactNames.get(username) || username),
        }))
      }
    }
    // group chats: per-message member identity (incl. own messages, so the
    // UI can show the right avatar side/letter when it wants to).
    // 自己发的（Name2Id 空行）sender 为空时，用 selfWxid 补上，避免界面落到「成员」。
    if (isGroup) {
      const member = sender || (isSelf && self.length > 0 ? self : '')
      if (member) {
        msg.sender = member
        const name = contactNames.get(member)
        if (name) msg.senderName = name
      }
    }
    return msg
  })
}

/**
 * Incrementally fetch messages newer than a sort_seq watermark (real-time
 * polling). Mirrors st_control's monitor delta: any message whose order key
 * is above the seen high-water mark is returned oldest-first for appending.
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param after - only rows with sort_seq > this watermark are returned.
 * @param limit - max rows to return (default 200).
 * @param selfUsername - logged-in account wxid (see {@link queryMessages}).
 * @returns the newer messages (empty when nothing arrived).
 */
export function queryNewMessages(
  decryptedDir: string,
  talker: string,
  after: number,
  limit?: number,
  selfUsername?: string,
): MessagesSnapshot {
  const table = msgTableName(talker)
  const shards = findShards(decryptedDir, table)
  if (shards.length === 0) return { messages: [], total: 0 }
  try {
    const cap = Math.min(limit ?? 200, 1000)
    const merged: RawMsgRow[] = []
    for (const shard of shards) {
      merged.push(...queryShardRowsWith(shard, table, undefined, after, cap + 1, true))
    }
    merged.sort((a, b) => a.sortSeq - b.sortSeq || a.localId - b.localId)
    const rows = merged.slice(0, cap)
    const contactNames = contactMeta(decryptedDir).names
    const isGroup = talker.endsWith('@chatroom')
    const messages = toWechatMessages(rows, talker, isGroup, contactNames, selfUsername)
    const out: MessagesSnapshot = { messages, total: messages.length }
    if (selfUsername && selfUsername.length > 0) out.selfWxid = selfUsername
    return out
  } finally {
    for (const shard of shards) {
      try { shard.db.close() } catch { /* already closed */ }
    }
  }
}

interface MessageStats {
  total: number
  typeStats: MessageTypeStat[]
}

const statsCache = new Map<string, { sig: string; stats: MessageStats }>()

/** Fingerprint the shard files backing one talker's table (mtime+size). */
function shardStatsFingerprint(shards: MsgShard[]): string {
  return shards.map((s) => {
    try {
      const st = statSync(s.file)
      return `${s.file}:${st.mtimeMs}:${st.size}`
    } catch {
      return s.file + ':?'
    }
  }).join('|')
}

/** Cached per-talker typeStats + total; invalidated by shard file signatures. */
function messageStats(decryptedDir: string, table: string, shards: MsgShard[]): MessageStats {
  const sig = shardStatsFingerprint(shards)
  const key = decryptedDir + ':' + table
  const hit = statsCache.get(key)
  if (hit && hit.sig === sig) return hit.stats
  const statsMap = new Map<number, number>()
  for (const shard of shards) {
    const { db, cols } = shard
    if (!cols.has('local_type')) continue
    try {
      const rows = db.prepare('SELECT local_type AS t, COUNT(*) AS c FROM ' + table + ' GROUP BY local_type').all() as Array<{ t: number; c: number }>
      for (const r of rows) {
        const key2 = normalizeMsgType(r.t)
        statsMap.set(key2, (statsMap.get(key2) ?? 0) + r.c)
      }
    } catch { /* skip */ }
  }
  const typeStats = [...statsMap.entries()]
    .map(([type, count]) => ({ type, label: msgTypeLabel(type), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  const total = shards.reduce((a, s) => {
    try {
      return a + Number(s.db.prepare('SELECT COUNT(*) AS c FROM ' + table).get()?.c ?? 0)
    } catch { return a }
  }, 0)
  const stats: MessageStats = { total, typeStats }
  statsCache.set(key, { sig, stats })
  return stats
}

/**
 * Read one talker's messages (keyset pagination across all shards).
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param limit - max rows (per page).
 * @param cursor - previous page's smallest sort_seq (exclusive), or undefined for the newest page.
 * @param selfUsername - logged-in account wxid (used to mark own messages);
 *   when empty, a private-chat heuristic compares the sender against the talker.
 * @param cursorLocalId - 上一页最后一行的 local_id。与 cursor 组成复合游标，
 *   用于消除 sort_seq 重复导致的分页丢消息；不传则退回只按 sort_seq 分页。
 * @returns the messages snapshot.
 */
export function queryMessages(
  decryptedDir: string,
  talker: string,
  limit?: number,
  cursor?: number,
  selfUsername?: string,
  cursorLocalId?: number,
): MessagesSnapshot {
  const table = msgTableName(talker)
  const shards = findShards(decryptedDir, table)
  if (shards.length === 0) return { messages: [], total: 0 }
  try {
    const pageSize = Math.min(limit ?? 100, 1000)
    // Read one extra row per shard to detect hasMore, like st_control.
    const limitPerShard = pageSize + 1
    const merged: RawMsgRow[] = []
    for (const shard of shards) {
      merged.push(...queryShardRows(shard, table, cursor, limitPerShard, cursorLocalId))
    }
    // Global sort: sort_seq DESC, local_id DESC (stable across shards).
    merged.sort((a, b) => b.sortSeq - a.sortSeq || b.localId - a.localId)

    const hasMore = merged.length > pageSize
    const pageRows = merged.slice(0, pageSize)
    const lastRow = pageRows[pageRows.length - 1]
    const nextCursor = lastRow ? lastRow.sortSeq : 0
    // 复合游标的第二段：与 cursor 一起返回，下一页据此跳过同 sort_seq 的已读行。
    const nextCursorLocalId = lastRow ? lastRow.localId : 0

    const contactNames = contactMeta(decryptedDir).names
    const isGroup = talker.endsWith('@chatroom')
    // pageRows are newest-first; the UI prepends older pages, so emit oldest→newest.
    const messages = toWechatMessages(pageRows.reverse(), talker, isGroup, contactNames, selfUsername)

    const stats = messageStats(decryptedDir, table, shards)
    const base: MessagesSnapshot = { messages, total: stats.total, typeStats: stats.typeStats }
    if (selfUsername && selfUsername.length > 0) base.selfWxid = selfUsername
    return hasMore
      ? { ...base, hasMore, cursor: nextCursor, cursorLocalId: nextCursorLocalId }
      : { ...base, hasMore: false }
  } finally {
    for (const shard of shards) {
      try { shard.db.close() } catch { /* already closed */ }
    }
  }
}

/**
 * Resolve one message by its server_id (merged chat-log nested pointers).
 * Scans every message shard / Msg table; only type-49 appmsg cards are
 * resolved.
 *
 * **带签名缓存**（M11）：本机实测「命中」中位 1.8–3.8ms，而**未命中**要 77–80ms —— 它是两轮
 * 扫描（先按整型走 `server_id` 覆盖索引，再对未命中的整轮 `CAST(server_id AS TEXT)` 全表扫，
 * 本机 4 个分片共 304 张 `Msg_` 表 ⇒ 最坏 2432 次查询）。
 *
 * 收益范围要说准（复审纠正过我的说法）：`cachedBySig` 的 maxAge **从写入计时、不是从访问计时**，
 * 所以真正省掉的是「**5 秒内**的重复」——双击、重渲染、失败重试这一类；而「用户点了没找到 →
 * 等同步完成再点」的间隔通常 > 5s（实时同步 tick ≈10s），**那一次仍要重新扫**。
 * 失效按分片目录签名（任一分片被原子替换就变），所以同步落地后不会返回旧结论
 * —— 这条只对「同步走 rename 替换」成立：签名是 mtime+size 指纹，理论上保住时间戳的写入者
 * 可以击穿它（与仓库其它 `cachedBySig` 条目同款限制，非本处新引入）。
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @returns found flag plus the parsed message (when found).
 */
export function queryMessageByServerId(
  decryptedDir: string,
  serverId: string,
): { found: boolean; message?: WechatMessage } {
  const sig = shardCatalogSig(decryptedDir, ['message'])
  return cachedBySig('msg-by-sid:' + decryptedDir + ':' + serverId, sig, () =>
    queryMessageByServerIdUncached(decryptedDir, serverId))
}

/**
 * 真正干活的实现（无缓存）。与 {@link queryMessageByServerId} 分开，便于用例直接测扫描语义。
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string.
 * @returns found flag plus the parsed message (when found).
 */
function queryMessageByServerIdUncached(
  decryptedDir: string,
  serverId: string,
): { found: boolean; message?: WechatMessage } {
  const sid = serverId
  // 纯数字 server_id 先走整型等值命中索引，未命中再回退 CAST 文本（兼容
  // 文本存储/非数字 id），避免 askWechat/resolveChatHistory 每表全量 CAST 扫描。
  let numeric: bigint | null = null
  if (/^\d+$/.test(sid)) {
    try { numeric = BigInt(sid) } catch { /* keep text path */ }
  }
  const tryLookup = (predicate: string, param: string | bigint): { found: boolean; message?: WechatMessage } => {
    for (const shard of shardCatalog(decryptedDir)) {
      let db: DatabaseSync
      // readBigInts: 64 位 server_id 原样读回，避免 double 精度损失。
      try { db = new DatabaseSync(shard.file, { readOnly: true, readBigInts: true }) } catch { continue }
      try {
        for (const [table, meta] of shard.tables) {
          if (!meta.cols.has('server_id') || !meta.cols.has('local_type')) continue
          try {
            // 注意：Msg_ 表中【不存在】is_sender 列（本机 235 个 Msg_ 表普查：0 个含该列）。
            // 原实现把 is_sender 写进 SELECT，导致每条 SQL 都抛
            // "no such column: is_sender"，异常又被下面的 catch 吞掉，
            // 于是本方法在所有分片上恒返回 { found: false }。
            // 该列的值本来也没被读取（下面 isSender 硬编码为 0），故直接从 SELECT 移除。
            const sql = 'SELECT local_id, sort_seq, local_type, create_time, real_sender_id, message_content FROM "' + table + '" WHERE ' + predicate + ' = ? AND (local_type & 4294967295) = 49 LIMIT 1'
            const row = db.prepare(sql).get(param) as Record<string, unknown> | undefined
            if (!row) continue
            const normType = normalizeMsgType(Number(row['local_type'] ?? 0))
            const content = decodeBlobText(row['message_content'])
            const parsed = parseMessageContent(normType, content, false)
            const msg: WechatMessage = {
              localId: Number(row['local_id'] ?? 0),
              sortSeq: Number(row['sort_seq'] ?? 0),
              type: normType,
              isSender: 0,
              createTime: Number(row['create_time'] ?? 0),
              msgContent: content,
              strContent: content,
              typeLabel: msgTypeLabel(normType),
            }
            if (parsed.text) msg.displayText = parsed.text
            if (parsed.rich) msg.rich = parsed.rich
            const render = classifyRender(normType, parsed.rich, parsed.sysKind)
            msg.renderType = render
            msg.renderLabel = RENDER_LABEL[render] ?? '未知消息'
            if (parsed.sysKind) msg.sysKind = parsed.sysKind
            return { found: true, message: msg }
          } catch {
            // try the next table
          }
        }
      } finally {
        db.close()
      }
    }
    return { found: false }
  }
  if (numeric !== null) {
    const hit = tryLookup('server_id', numeric)
    if (hit.found) return hit
  }
  return tryLookup('CAST(server_id AS TEXT)', sid)
}
