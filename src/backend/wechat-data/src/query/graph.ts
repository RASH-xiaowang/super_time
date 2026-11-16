/**
 * Relationship graph: contact/group nodes with display names, message counts,
 * compact shared-member detail, and explicit evidence-backed observed edges.
 *
 * Full membership comes from `chatroom_member` plus the chat_room ext_buffer
 * snapshot; `shared_members` stays a bounded detail payload and is never used
 * as the authoritative source for common-group/common-member edges.
 */
import type { DatabaseSync } from './db-open.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cachedBySigAsync, contactMeta, fileSigOf, shardCatalog, shardCatalogSig } from './meta.ts'
import { yieldToLoop } from './search-build.ts'
import { withDb, withDbAsync } from './db-open.ts'
import { parseChatRoomExtBuffer } from './group-info.ts'
import { decodeBlobText, normalizeMsgType } from './messages.ts'
import { parseAppmsg } from './parse-rich.ts'
import { parseAtUsernames } from './parse-system.ts'
import type { GraphCoverage, GraphSnapshot } from '../types.ts'
import {
  GRAPH_MAX_OBSERVED_EDGES,
  GRAPH_PAIR_WORK_BUDGET,
  buildObservedEdges,
  type GraphCallRelationRecord,
  type GraphInviteRecord,
  type GraphMembershipEvidence,
  type GraphMembershipRecord,
  type GraphMessageRelationRecord,
  type GraphRelationCoverage,
} from './graph-relations.ts'
import {
  displayNameForUsername,
  mergeDisplayNames,
  messageIdentityIndex,
  messageTableName,
  resolveTalkerUsername,
} from './message-identity.ts'

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

/** Strip the WeChat instance suffix (wxid_xxx_f312 -> wxid_xxx). */
function cleanWxid(username: string): string {
  const m = username.match(/^(wxid_[A-Za-z0-9]+)(?:_[A-Za-z0-9]+)?$/)
  return m ? (m[1] ?? username) : username
}

/** `@chatroom` is the only suffix that is sufficient on its own. */
function isChatroomId(username: string): boolean {
  return username.endsWith('@chatroom')
}

/**
 * Some enterprise rooms use `@openim`, but the same suffix is also used by
 * ordinary external contacts. Only chat_room/member evidence can promote such
 * an id to a group; the suffix alone must not turn a person into a room.
 */
function isGroupConversationId(username: string, knownRoomIds: ReadonlySet<string>): boolean {
  return isChatroomId(username) || knownRoomIds.has(username)
}

/** Main database + WAL signature; WAL changes must invalidate graph edges too. */
function graphDbSig(path: string): string {
  return fileSigOf(path) + '|' + fileSigOf(path + '-wal')
}

/** 「非数字开头前缀 + 数字编号」形态；前缀 lazy 取最短，先遇到的编号就分组。 */
const REMARK_KEY_RE = /^([^\d\s][^\d]*?)\s*(\d+)(?=\D|$)/
/** 前缀**去标点后**至少几个字（挡住 `--202` / `_12` 这类纯符号前缀成组）。 */
const REMARK_KEY_MIN_PREFIX = 2
/** 编号位数区间：1 位是噪声（门店序号偶合），>6 位是手机号/单号。 */
const REMARK_KEY_MIN_DIGITS = 2
const REMARK_KEY_MAX_DIGITS = 6
/** 判定「纯符号前缀」时剔除的标点（中英文都算）。 */
const PUNCT_RE = /[\s\-_—–~～·、,，.。:：;；/|()（）【】#*+"'“”‘’]/g

/**
 * 群节点携带的共同成员上限。
 *
 * 8 → 200 的依据（真机探针：64 个群、2541 条成员条目，见 working/probe-remark-key.txt ③）：
 *   cap=8   439 条 / ≈21KB / 群组网络边 1228 / **被截断的群 38 个**
 *   cap=200 2115 条 / ≈98KB / 群组网络边 3079 / 被截断的群 3 个
 * 8 的上限把 38/64 个群的成员关系直接砍掉，这正是「群与群之间看不到共同成员」的来源；
 * 200 让 95% 的群拿到完整成员，IPC 体积仍在百 KB 量级。前端 `GROUP_PAIR_MEMBERS`
 * 还会再按权重截一次配对规模，两处口径不冲突。
 */
const GROUP_MEMBER_CAP = 200
/** 备注班级名册每个键最多带多少成员（详情面板展示用；真机最大班 43 人）。 */
const REMARK_ROSTER_CAP = 100
/** Reply/@ edges inspect only a bounded newest window per group. */
export const GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP = 2_000
/** Shared scan budget keeps relation extraction independent of total history size. */
export const GRAPH_RELATION_MESSAGE_WINDOW_TOTAL = 50_000
/** Bound aggregation memory even if one @ list contains many usernames. */
export const GRAPH_MESSAGE_RELATION_RECORD_CAP = 50_000
const YIELD_EVERY_RELATION_ROWS = 500

/**
 * 备注里的「班级/批次」键：**非数字前缀 + 数字编号**（`宜州一中404陈泳达` → `宜州一中404`）。
 *
 * 规则为什么是这几个数（真机 280 条备注全量扫描，见 working/probe-remark-key.txt ①）：
 *   - **编号 ≥2 位**：`前缀≥2/编号≥2` 与 `前缀≥3/编号≥2` 结果**完全一致**（86 人 / 9 组 /
 *     1233 条潜在边），而放宽到 1 位只多出「一汽大众-7」这种**门店序号**的偶然同号
 *     （多 1 条边）—— 收益为 0、误连风险不为 0，所以取下界 2；
 *   - **编号 ≤6 位**：更长的数字串是手机号/单号（备注里真实存在，如
 *     `一汽大众-7鑫广达吴善钊19195897571`），当班级处理会造出假关系；
 *   - **前缀去标点后 ≥2 字**：挡掉纯符号前缀。
 * 未被命中的 194 条备注抽样全是「表弟_陈忠凯」「法院_梧州万秀_会计小郭」这类
 * 亲属/单位+姓名（无编号），确实不该成组 —— 说明规则没有漏掉成规模的班级型分组。
 * @param remark - 原始备注（含首尾空白也可）。
 * @returns 分组键；不构成「前缀+编号」形态、或编号位数不在区间内时返回空串。
 */
export function remarkClassKey(remark: string | undefined | null): string {
  const s = (remark ?? '').trim()
  if (!s) return ''
  const m = REMARK_KEY_RE.exec(s)
  if (!m) return ''
  const prefix = (m[1] ?? '').trim()
  const digits = m[2] ?? ''
  if (digits.length < REMARK_KEY_MIN_DIGITS || digits.length > REMARK_KEY_MAX_DIGITS) return ''
  if (prefix.replace(PUNCT_RE, '').length < REMARK_KEY_MIN_PREFIX) return ''
  return prefix + digits
}

interface MessageStats {
  /** Per-talker message counts after cross-shard identity de-duplication. */
  counts: Map<string, number>
  /** Group username -> known member username -> message count. */
  groupSenderCounts: Map<string, Map<string, number>>
  /** Aggregated reply/@ observations from the bounded newest message window. */
  messageRelations: GraphMessageRelationRecord[]
  /** Directed 1:1 call counts from stable type-50 message rows. */
  callRelations: GraphCallRelationRecord[]
  /** Number of distinct chats/rooms whose relation window was inspected. */
  relationScopes: number
  /** Rows actually read for reply/@ parsing. */
  relationRowsScanned: number
  /** Effective newest-row allowance per scope after spreading the global budget. */
  relationRowBudgetPerScope: number
  /** Scopes whose newest window was full (older relation evidence may exist). */
  relationScopesTruncated: number
  /** Distinct reply/@ aggregates rejected after the bounded record cap. */
  relationRecordsDropped: number
}

/** Mirror the message reader's bounded group-sender fallback（前缀必须锚在开头）. */
function senderFromContent(content: string, talker: string): string {
  if (!content) return ''
  let printable = 0
  for (let i = 0; i < content.length && i < 512; i += 1) {
    const code = content.charCodeAt(i)
    if ((code >= 0x20 && code <= 0x7e) || code >= 0x80) printable += 1
  }
  if (content.length > 0 && printable / Math.min(content.length, 512) < 0.6) return ''
  const match = /^([A-Za-z0-9_@.\-]{3,64}):\r?\n/.exec(content)
  const sender = match?.[1] ?? ''
  if (!sender || sender.includes('<') || sender === talker) return ''
  return sender
}

interface MessageRelationAccumulator {
  relations: Map<string, GraphMessageRelationRecord>
  dropped: number
}

function addMessageRelation(
  accumulator: MessageRelationAccumulator,
  scope: string,
  sender: string,
  targets: readonly string[],
  type: GraphMessageRelationRecord['type'],
): void {
  const candidates = [...new Set(targets.map(target => target.trim()).filter(Boolean))]
    .filter(target => target !== sender && target !== scope && !target.endsWith('@chatroom'))
  if (!sender || candidates.length === 0) return
  const target = candidates[0]
  if (target === undefined) return
  const key = type + '\u0000' + scope + '\u0000' + sender + '\u0000' + candidates.join('\u0001')
  const current = accumulator.relations.get(key)
  if (current === undefined) {
    if (accumulator.relations.size >= GRAPH_MESSAGE_RELATION_RECORD_CAP) {
      accumulator.dropped += 1
      return
    }
    accumulator.relations.set(key, {
      group: scope,
      sender,
      target,
      targets: candidates,
      type,
      count: 1,
    })
  } else {
    current.count += 1
  }
}

interface MessageTableState {
  /**
   * Stable message identity -> sender username. `null` means the shard's
   * Name2Id table did not resolve the sender id (as opposed to the empty
   * username used by WeChat for the local account).
   */
  identities: Map<string, string | null>
  /** Newest rows collected from every shard; identity de-duplicates copies. */
  relationRows: Map<string, MessageRelationRow>
  /** Stable call-message identity -> resolved sender (empty means the local account). */
  calls: Map<string, string | null>
}

interface MessageRelationRow {
  identity: string
  senderName: string | null
  localType: number
  content: unknown
  source: unknown
  sortSeq: number
  localId: number
}

const MESSAGE_IDENTITY_FALLBACK_COLUMNS = [
  'local_id',
  'server_seq',
  'sort_seq',
  'create_time',
  'local_type',
  'is_sender',
  'real_sender_id',
] as const

/**
 * Build a stable identity expression for one message row.
 *
 * `server_id` is the preferred identity. It is missing/zero for a tiny number
 * of locally-created rows, so the fallback combines the table's stable scalar
 * fields. `rowid` is deliberately excluded: a copied row can have a different
 * shard-local rowid. Callers pass the columns common to every occurrence of
 * the table, so a schema difference cannot split the same message.
 */
function messageIdentitySql(cols: ReadonlySet<string>): string {
  const serverId = cols.has('server_id')
    ? "NULLIF(TRIM(CAST(server_id AS TEXT)), '')"
    : 'NULL'
  const fallback = MESSAGE_IDENTITY_FALLBACK_COLUMNS.map((name) => {
    const label = `'${name}='`
    return cols.has(name)
      ? `${label} || CASE WHEN ${name} IS NULL THEN 'N' ELSE 'V:' || CAST(${name} AS TEXT) END`
      : `${label} || 'M'`
  }).join(" || '|' || ")
  return `CASE WHEN ${serverId} IS NOT NULL AND ${serverId} <> '0' `
    + `THEN 's:' || ${serverId} `
    + `ELSE 'l:' || ${fallback} END`
}

function senderForShard(
  tableMeta: { name2id: ReadonlyMap<number, string> },
  senderId: number,
): string | null {
  if (!Number.isFinite(senderId) || senderId <= 0) return null
  return tableMeta.name2id.has(senderId) ? (tableMeta.name2id.get(senderId) ?? '') : null
}

/**
 * Load per-talker counts and group sender activity while opening each shard
 * once. A message table may be present in several shards; counts are merged by
 * stable message identity instead of taking the first shard's file.
 */
async function loadMessageStats(
  decryptedDir: string,
  usernames: string[],
  groupTalkers: ReadonlySet<string>,
): Promise<MessageStats> {
  const counts = new Map<string, number>()
  const groupSenderCounts = new Map<string, Map<string, number>>()
  const messageRelations: MessageRelationAccumulator = { relations: new Map(), dropped: 0 }
  const callRelations = new Map<string, GraphCallRelationRecord>()
  const tableToUser = new Map<string, string>()
  for (const u of usernames) tableToUser.set(messageTableName(u), u)
  const shards = shardCatalog(decryptedDir)
  const occurrenceCounts = new Map<string, number>()
  const commonTableColumns = new Map<string, Set<string>>()
  let relationOccurrences = 0
  for (const sh of shards) {
    for (const [table, meta] of sh.tables) {
      if (!tableToUser.has(table)) continue
      occurrenceCounts.set(table, (occurrenceCounts.get(table) ?? 0) + 1)
      const common = commonTableColumns.get(table)
      if (common === undefined) {
        commonTableColumns.set(table, new Set(meta.cols))
      } else {
        for (const name of [...common]) {
          if (!meta.cols.has(name)) common.delete(name)
        }
      }
      if (
        (meta.cols.has('message_content') && meta.cols.has('local_type'))
        || meta.cols.has('source')
      ) relationOccurrences += 1
    }
  }
  const relationLimitPerOccurrence = relationOccurrences === 0
    ? 0
    : Math.max(1, Math.min(
        GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP,
        Math.floor(GRAPH_RELATION_MESSAGE_WINDOW_TOTAL / relationOccurrences),
      ))
  const tableStates = new Map<string, MessageTableState>()
  const relationScopeSet = new Set<string>()
  const relationScopeTruncated = new Set<string>()
  let relationRowsScanned = 0

  const finalizeTable = async (table: string, state: MessageTableState): Promise<void> => {
    const username = tableToUser.get(table)
    if (username === undefined) return
    counts.set(username, state.identities.size)
    if (groupTalkers.has(username)) {
      const senderCounts = new Map<string, number>()
      for (const sender of state.identities.values()) {
        // Name2Id's empty username marks the logged-in account. It is not a
        // person id, so do not invent a self activity edge.
        if (sender === null || sender === '') continue
        senderCounts.set(sender, (senderCounts.get(sender) ?? 0) + 1)
      }
      if (senderCounts.size > 0) groupSenderCounts.set(username, senderCounts)
    } else {
      let outgoing = 0
      let incoming = 0
      for (const sender of state.calls.values()) {
        if (sender === null) continue
        if (sender === '' || cleanWxid(sender) !== cleanWxid(username)) outgoing += 1
        else incoming += 1
      }
      if (outgoing > 0 || incoming > 0) {
        callRelations.set(username, { talker: username, outgoing, incoming })
      }
    }

    const rows = [...state.relationRows.values()]
      .sort((a, b) => b.sortSeq - a.sortSeq || b.localId - a.localId)
      .slice(0, GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP)
    for (let index = 0; index < rows.length; index += 1) {
      if (index > 0 && index % YIELD_EVERY_RELATION_ROWS === 0) await yieldToLoop()
      const row = rows[index]
      if (row === undefined) continue
      let sender = row.senderName === null ? '' : row.senderName
      if (row.senderName !== null && sender === '') sender = 'self'
      const localType = normalizeMsgType(row.localType)
      let content = ''
      if ((!sender || sender === 'self' || localType === 49) && row.content !== null && row.content !== undefined) {
        content = decodeBlobText(row.content)
        const prefixSender = senderFromContent(content, username)
        if (prefixSender) sender = prefixSender
      }
      if (localType === 49 && content) {
        try {
          const parsed = parseAppmsg(content)
          if (parsed) {
            const targets = [parsed.referChatUsername, parsed.referFromUsername]
              .map(value => (value ?? '').trim())
              .filter(Boolean)
            if (targets.length > 0) addMessageRelation(messageRelations, username, sender, targets, 'reply')
          }
        } catch { /* one malformed appmsg must not stop the window */ }
      }
      if (row.source !== null && row.source !== undefined) {
        try {
          for (const target of parseAtUsernames(decodeBlobText(row.source))) {
            const mention = target.trim()
            if (mention === 'notify@all') continue
            addMessageRelation(messageRelations, username, sender, [mention], 'mention_user')
          }
        } catch { /* malformed msgsource is evidence-only */ }
      }
    }
  }

  for (const sh of shards) {
    const wanted = [...sh.tables.entries()]
      .filter(([table]) => tableToUser.has(table))
      .map(([table, meta]) => ({ table, meta }))
    if (wanted.length === 0) continue
    // Keep one open/close per shard even though this now processes both the
    // count identity set and the bounded relation rows.
    await yieldToLoop()
    try {
      await withDbAsync(sh.file, async (db) => {
        for (const { table, meta } of wanted) {
          const username = tableToUser.get(table)
          if (username === undefined) continue
          let state = tableStates.get(table)
          if (state === undefined) {
            state = { identities: new Map(), relationRows: new Map(), calls: new Map() }
            tableStates.set(table, state)
          }
          const identityExpr = messageIdentitySql(commonTableColumns.get(table) ?? meta.cols)
          const senderExpr = meta.cols.has('real_sender_id') ? 'real_sender_id' : 'NULL'
          const countTypeExpr = meta.cols.has('local_type') ? 'local_type' : '0'
          try {
            const rows = db.prepare(
              `SELECT ${senderExpr} AS sender_id, ${countTypeExpr} AS local_type, `
                + `${identityExpr} AS identity_key FROM "${table}"`,
            ).iterate() as Iterable<Record<string, unknown>>
            let seen = 0
            for (const row of rows) {
              if (seen > 0 && seen % YIELD_EVERY_RELATION_ROWS === 0) await yieldToLoop()
              seen += 1
              const identity = cellString(row['identity_key'])
              if (!identity) continue
              const senderId = Number(row['sender_id'])
              const sender = senderForShard(meta, senderId)
              if (!state.identities.has(identity)) {
                state.identities.set(identity, sender)
              } else if (state.identities.get(identity) === null && sender !== null) {
                state.identities.set(identity, sender)
              }
              if (normalizeMsgType(Number(row['local_type']) || 0) === 50) {
                if (!state.calls.has(identity) || (state.calls.get(identity) === null && sender !== null)) {
                  state.calls.set(identity, sender)
                }
              }
            }

            const canReply = meta.cols.has('message_content') && meta.cols.has('local_type')
            const canMention = meta.cols.has('source')
            if ((!canReply && !canMention) || relationLimitPerOccurrence <= 0) {
              // The table may still be waiting for another shard occurrence.
            } else {
              relationScopeSet.add(username)
              const orderBy = meta.cols.has('sort_seq')
                ? `sort_seq DESC${meta.cols.has('local_id') ? ', local_id DESC' : ''}`
                : meta.cols.has('local_id') ? 'local_id DESC' : 'rowid DESC'
              const contentSelect = meta.cols.has('message_content') ? 'message_content' : 'NULL'
              const sourceSelect = meta.cols.has('source') ? 'source' : 'NULL'
              const typeSelect = meta.cols.has('local_type') ? 'local_type' : '0'
              const select = `SELECT ${senderExpr} AS sender_id, ${typeSelect} AS local_type, `
                + `${contentSelect} AS content, ${sourceSelect} AS source, `
                + `${identityExpr} AS identity_key, `
                + `${meta.cols.has('sort_seq') ? 'sort_seq' : (meta.cols.has('local_id') ? 'local_id' : 'rowid')} AS sort_key, `
                + `${meta.cols.has('local_id') ? 'local_id' : 'rowid'} AS local_key `
                + `FROM "${table}" ORDER BY ${orderBy} LIMIT ?`
              const relationRows = db.prepare(select).all(relationLimitPerOccurrence) as Array<Record<string, unknown>>
              relationRowsScanned += relationRows.length
              if (relationRows.length >= relationLimitPerOccurrence) relationScopeTruncated.add(username)
              for (const row of relationRows) {
                const identity = cellString(row['identity_key'])
                if (!identity) continue
                const senderId = Number(row['sender_id'])
                const sender = senderForShard(meta, senderId)
                const existing = state.relationRows.get(identity)
                const candidate: MessageRelationRow = {
                  identity,
                  senderName: sender,
                  localType: Number(row['local_type']) || 0,
                  content: row['content'],
                  source: row['source'],
                  sortSeq: Number(row['sort_key']) || 0,
                  localId: Number(row['local_key']) || 0,
                }
                if (existing === undefined || candidate.sortSeq > existing.sortSeq
                  || (candidate.sortSeq === existing.sortSeq && candidate.localId > existing.localId)) {
                  state.relationRows.set(identity, candidate)
                } else if (existing.senderName === null && candidate.senderName !== null) {
                  existing.senderName = candidate.senderName
                }
              }
            }
          } catch { /* 这张表读不到就算 0，下一张 */ }

          const remaining = (occurrenceCounts.get(table) ?? 1) - 1
          occurrenceCounts.set(table, remaining)
          if (remaining <= 0) {
            await finalizeTable(table, state)
            tableStates.delete(table)
          }
        }
      })
    } catch { /* 整个分片开不了：跳过 */ }
  }
  // A malformed/unreadable shard can leave a table unfinished. Flush what was
  // observed instead of silently dropping a conversation that had data.
  for (const [table, state] of tableStates) await finalizeTable(table, state)
  return {
    counts,
    groupSenderCounts,
    messageRelations: [...messageRelations.relations.values()],
    callRelations: [...callRelations.values()],
    relationScopes: relationScopeSet.size,
    relationRowsScanned,
    relationRowBudgetPerScope: relationLimitPerOccurrence,
    relationScopesTruncated: relationScopeTruncated.size,
    relationRecordsDropped: messageRelations.dropped,
  }
}

/** Friend flag + avatar + remark per contact username. */
function loadContactMeta(decryptedDir: string): Map<string, { isFriend: boolean; avatar: string; remark: string }> {
  const meta = new Map<string, { isFriend: boolean; avatar: string; remark: string }>()
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return meta
  try {
    withDb(p, (db) => {
    const cols = tableColumns(db, 'contact')
    if (!cols.has('username')) return
    const sel = (c: string, dft: string): string => (cols.has(c) ? c : dft)
    // 备注列名有 remark / Remark 两种历史写法（与 meta.ts 同口径）
    const remarkSel = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : "''"
    const rows = db.prepare(`SELECT ${sel('username', "''")} AS u, ${sel('local_type', '0')} AS lt, ${sel('delete_flag', '0')} AS df, ${sel('small_head_url', "''")} AS s, ${sel('big_head_url', "''")} AS b, ${remarkSel} AS rm FROM contact`).all() as Array<{ u: string; lt: number; df: number; s: string; b: string; rm: string }>
    for (const r of rows) {
      const u = cellString(r.u)
      if (!u || isChatroomId(u)) continue
      const avatar = cellString(r.b).trim() || cellString(r.s).trim()
      meta.set(u, { isFriend: r.lt === 1 && r.df === 0, avatar, remark: cellString(r.rm).trim() })
    }
    })
  } catch { /* contact db unavailable */ }
  return meta
}

interface RoomMemberData {
  /** username -> set of chatroom usernames it belongs to. */
  memberGroups: Map<string, Set<string>>
  /** chatroom username -> member usernames (chatroom_member + ext_buffer). */
  roomMembers: Map<string, Set<string>>
  /** Rooms with an actual member source; an empty ext_buffer snapshot still counts. */
  membershipKnown: Set<string>
  /** chatroom username -> member count (union). */
  roomCounts: Map<string, number>
  /** chatroom username -> member username -> authoritative source kinds. */
  membershipByGroup: Map<string, Map<string, Set<GraphMembershipEvidence>>>
  /** chatroom username -> owner username from chat_room.owner. */
  groupOwners: Map<string, string>
  /** Structured inviter -> invitee records from the member snapshot. */
  invites: GraphInviteRecord[]
}

/** Build memberships plus authoritative owner/inviter records from chat_room. */
function loadRoomData(decryptedDir: string): RoomMemberData {
  const out: RoomMemberData = {
    memberGroups: new Map(),
    roomMembers: new Map(),
    membershipKnown: new Set(),
    roomCounts: new Map(),
    membershipByGroup: new Map(),
    groupOwners: new Map(),
    invites: [],
  }
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return out
  const addMember = (room: string, member: string, source: GraphMembershipEvidence): void => {
    if (!room || !member) return
    out.membershipKnown.add(room)
    let members = out.roomMembers.get(room)
    if (members === undefined) {
      members = new Set()
      out.roomMembers.set(room, members)
    }
    members.add(member)
    let groups = out.memberGroups.get(member)
    if (groups === undefined) {
      groups = new Set()
      out.memberGroups.set(member, groups)
    }
    groups.add(room)
    let byMember = out.membershipByGroup.get(room)
    if (byMember === undefined) {
      byMember = new Map()
      out.membershipByGroup.set(room, byMember)
    }
    let sources = byMember.get(member)
    if (sources === undefined) {
      sources = new Set()
      byMember.set(member, sources)
    }
    sources.add(source)
  }
  try {
    withDb(p, (db) => {
    const cols = tableColumns(db, 'contact')
    const cid = cols.has('id') ? 'id' : 'rowid'
    const idToUser = new Map<number, string>()
    try {
      const users = db.prepare(`SELECT ${cid} AS id, username FROM contact`).all() as Array<{ id: number; username: string }>
      for (const r of users) idToUser.set(r.id, cellString(r.username))
    } catch { /* no contact rows */ }

    let rooms: Array<{ id: number; username: string; owner?: unknown; ext?: unknown }> = []
    try {
      const crCols = tableColumns(db, 'chat_room')
      if (crCols.has('id') && crCols.has('username')) {
        const ownerCol = crCols.has('owner') ? 'owner' : crCols.has('Owner') ? 'Owner' : ''
        const ownerSelect = ownerCol === '' ? 'NULL' : ownerCol
        const extSelect = crCols.has('ext_buffer') ? 'ext_buffer' : 'NULL'
        rooms = db.prepare(
          `SELECT id, username, ${ownerSelect} AS owner, ${extSelect} AS ext FROM chat_room`,
        ).all() as Array<{ id: number; username: string; owner?: unknown; ext?: unknown }>
      }
    } catch { /* no chat_room */ }
    const inviteKeys = new Set<string>()
    for (const room of rooms) {
      const u = cellString(room.username)
      if (!u) continue
      if (!out.roomMembers.has(u)) out.roomMembers.set(u, new Set())
      const owner = cellString(room.owner).trim()
      if (owner) out.groupOwners.set(u, owner)
    }
    try {
      const rows = db.prepare('SELECT room_id, member_id FROM chatroom_member').all() as Array<{ room_id: number; member_id: number }>
      const roomByUsername = new Map<number, string>()
      for (const room of rooms) roomByUsername.set(room.id, cellString(room.username))
      for (const r of rows) {
        const room = roomByUsername.get(r.room_id)
        const user = idToUser.get(r.member_id)
        if (!room || !user) continue
        addMember(room, user, 'chatroom_member')
      }
    } catch { /* no member rows */ }
    // ext_buffer snapshot: members absent from chatroom_member still count
    for (const room of rooms) {
      const u = cellString(room.username)
      const raw = room.ext
      const buf = raw instanceof Uint8Array
        ? Buffer.from(raw)
        : typeof raw === 'string' && raw.length > 0
          ? Buffer.from(raw, 'utf8')
          : Buffer.alloc(0)
      if (!u || buf.length === 0) continue
      // A non-empty ext_buffer is the persisted room snapshot. It remains
      // authoritative even when it parses to zero MemberInfo entries.
      out.membershipKnown.add(u)
      let snap: ReturnType<typeof parseChatRoomExtBuffer> = []
      try { snap = parseChatRoomExtBuffer(buf) } catch { snap = [] }
      for (const s of snap) {
        if (!s.username) continue
        addMember(u, s.username, 'chatroom_snapshot')
        const inviter = s.inviter?.trim() ?? ''
        if (!inviter || inviter === s.username) continue
        const key = u + '\u0000' + inviter + '\u0000' + s.username
        if (inviteKeys.has(key)) continue
        inviteKeys.add(key)
        out.invites.push({ group: u, inviter, invitee: s.username })
      }
    }
    for (const [u, members] of out.roomMembers) out.roomCounts.set(u, members.size)
    })
  } catch { /* room data unavailable */ }
  return out
}

/**
 * Build a graph snapshot: contact/group nodes plus observed relationship edges.
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (excluded from persons).
 * @returns nodes + evidence-backed edges + summary.
 */
/**
 * 关系图谱快照（节点 + 群/班级元数据）。
 *
 * 后端加签名缓存（P1-3 的第②半）：`cachedBySig` 的键由会话/通讯录/消息分片以及
 * 朋友圈、资金库签名拼成，**没变就是 0ms**；实时同步写过这些文件后签名自然变化 ⇒ 不需要显式失效，
 * 也不会像「整体清空缓存」那样把没变的条目一起丢掉（M8 那场风暴）。
 * 前端 `apiGetGraph` 那层 30s 的 `cachedGet` 管的是「同一会话里切回来」，
 * 这一层管的是「换了进程 / 超了 30 秒 / 首次打开」—— 那正是原先必须完整等 866ms 的三种情形。
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - 当前账号（用于把自己从人物节点里剔除）。
 * @returns 图谱快照。
 */
export async function queryGraph(decryptedDir: string, selfUsername?: string): Promise<GraphSnapshot> {
  const sig = [
    graphDbSig(join(decryptedDir, 'session', 'session.db')),
    graphDbSig(join(decryptedDir, 'contact', 'contact.db')),
    graphDbSig(join(decryptedDir, 'message', 'message_resource.db')),
    graphDbSig(join(decryptedDir, 'sns', 'db_sns', 'sns.db')),
    graphDbSig(join(decryptedDir, 'sns', 'sns.db')),
    graphDbSig(join(decryptedDir, 'general', 'general.db')),
    shardCatalogSig(decryptedDir, ['message']),
  ].join('|')
  return cachedBySigAsync('graph:' + decryptedDir + '|' + (selfUsername ?? ''), sig, () => computeGraph(decryptedDir, selfUsername))
}

function buildGraphGroupNodes(
  groupUniverse: Iterable<string>,
  roomData: RoomMemberData,
  personIds: ReadonlySet<string>,
  names: Parameters<typeof displayNameForUsername>[1],
  enterpriseNames: Map<string, string>,
  meta: ReturnType<typeof loadContactMeta>,
  counts: ReadonlyMap<string, number>,
): GraphSnapshot['nodes'] {
  const groups: GraphSnapshot['nodes'] = []
  for (const u of groupUniverse) {
    const members = roomData.roomMembers.get(u) ?? new Set<string>()
    const membershipKnown = roomData.membershipKnown.has(u)
    const shared: Array<{
      username: string
      name: string
      enterpriseName?: string
      is_friend: boolean
      msg_count: number
    }> = []
    for (const m of members) {
      if (!personIds.has(m)) continue
      const enterpriseName = enterpriseNames.get(m)?.trim()
      shared.push({
        username: m,
        name: displayNameForUsername(m, names),
        ...(enterpriseName ? { enterpriseName } : {}),
        is_friend: meta.get(m)?.isFriend ?? false,
        msg_count: counts.get(m) ?? 0,
      })
    }
    shared.sort((a, b) => b.msg_count - a.msg_count || a.username.localeCompare(b.username))
    groups.push({
      id: u,
      label: displayNameForUsername(u, names),
      kind: 'group',
      msg_count: counts.get(u) ?? 0,
      ...(membershipKnown ? {
        member_count: roomData.roomCounts.get(u) ?? members.size,
        membership_status: 'known' as const,
      } : {
        membership_status: 'unknown' as const,
      }),
      shared_count: shared.length,
      shared_members: shared.slice(0, GROUP_MEMBER_CAP),
      ...(membershipKnown ? {
        members_total: members.size,
        members_returned: Math.min(shared.length, GROUP_MEMBER_CAP),
        members_truncated: shared.length > GROUP_MEMBER_CAP,
      } : {}),
      is_friend: false,
    })
  }
  return groups.sort((a, b) =>
    (b.shared_count ?? 0) - (a.shared_count ?? 0)
    || (b.msg_count ?? 0) - (a.msg_count ?? 0)
    || b.id.localeCompare(a.id),
  )
}

function loadSessionTalkers(decryptedDir: string): Set<string> {
  const talkerSet = new Set<string>()
  const sessionPath = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(sessionPath)) return talkerSet
  try {
    withDb(sessionPath, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined
      if (!has) return
      const rows = db.prepare('SELECT username FROM SessionTable').all() as Array<{ username: string }>
      for (const r of rows) {
        const stored = cellString(r.username).trim()
        const u = stored ? resolveTalkerUsername(decryptedDir, stored) : ''
        if (u && u !== 'self') talkerSet.add(u)
      }
    })
  } catch { /* no sessions */ }
  return talkerSet
}

async function computeGraph(decryptedDir: string, selfUsername?: string): Promise<GraphSnapshot> {
  const nodes: GraphSnapshot['nodes'] = []

  // session talkers (bounded) so isolated contacts stay out
  const talkerSet = loadSessionTalkers(decryptedDir)
  const talkers = [...talkerSet]
  const sessionTalkers = new Set(talkers)
  const messageIdentities = messageIdentityIndex(decryptedDir, ['message'])
  const tableTalkers = new Set(messageIdentities.tableToUsername.values())
  const allTalkers = new Set([...talkers, ...tableTalkers])

  const contactMetas = contactMeta(decryptedDir)
  // Session titles are the only readable name for groups that have fallen out
  // of contact.db. `contactMeta().names` alone would label those as "群聊 <id>".
  const names = mergeDisplayNames(decryptedDir)
  const enterpriseNames = contactMetas.enterpriseNames
  const meta = loadContactMeta(decryptedDir)
  const roomData = loadRoomData(decryptedDir)
  const knownRoomIds = new Set([
    ...roomData.roomMembers.keys(),
    ...roomData.groupOwners.keys(),
  ])
  const conversationGroups = new Set(
    [...allTalkers].filter(u => isGroupConversationId(u, knownRoomIds)),
  )
  const privateTalkers = new Set(
    [...allTalkers].filter(u => !isGroupConversationId(u, knownRoomIds)),
  )
  /**
   * A room can be present in chat_room but no longer have a SessionTable row.
   * Keep one group universe for nodes, membership, owner, invite and message
   * activity; otherwise every relation from such a room is gated away.
   */
  const groupUniverse = new Set<string>([
    ...conversationGroups,
    ...roomData.roomMembers.keys(),
    ...roomData.groupOwners.keys(),
  ])
  const messageTalkers = [...new Set([...allTalkers, ...groupUniverse])]
  const messageStats = await loadMessageStats(decryptedDir, messageTalkers, conversationGroups)
  const counts = messageStats.counts
  const selfWxid = selfUsername ? cleanWxid(selfUsername) : ''

  // persons: contacts + official accounts (except the current account)
  const persons: GraphSnapshot['nodes'] = []
  const personIds = new Set<string>()
  // 备注「班级」名册：键 → 全库成员。刻意在**好友过滤 / nodeLimit 之前**收集 ——
  // 详情面板要靠它说明「本班全库 N 人、当前视图只显示 M 人」，
  // 而这正是「同前缀却没有连线」最常见的原因（人被挡在图外，不是关系缺失）。
  const classRoster = new Map<string, Array<{
    username: string
    name: string
    enterpriseName?: string
    is_friend: boolean
    msg_count: number
  }>>()
  for (const [u, info] of meta) {
    if (selfWxid && cleanWxid(u) === selfWxid) continue
    if (isGroupConversationId(u, knownRoomIds)) continue
    const kind = u.startsWith('gh_') || u.includes('@hardcode') ? 'official' : 'contact'
    const groups = Array.from(roomData.memberGroups.get(u) ?? []).sort()
    const enterpriseName = enterpriseNames.get(u)?.trim()
    const node: GraphSnapshot['nodes'][number] = {
      id: u,
      label: displayNameForUsername(u, names),
      kind,
      ...(enterpriseName ? { enterpriseName } : {}),
      msg_count: counts.get(u) ?? 0,
      group_count: groups.length,
      group_codes: groups,
      is_friend: info.isFriend,
    }
    if (info.avatar) node.avatar_url = info.avatar
    const classKey = remarkClassKey(info.remark)
    if (classKey) {
      node.remark_group = classKey
      let roster = classRoster.get(classKey)
      if (!roster) { roster = []; classRoster.set(classKey, roster) }
      roster.push({
        username: u,
        name: node.label,
        ...(enterpriseName ? { enterpriseName } : {}),
        is_friend: info.isFriend,
        msg_count: node.msg_count ?? 0,
      })
    }
    persons.push(node)
    personIds.add(u)
  }
  // Private sessions with no contact row are still real graph nodes. The
  // session username is a stable local identity, unlike a display name.
  for (const u of privateTalkers) {
    if (personIds.has(u) || (selfWxid && cleanWxid(u) === selfWxid)) continue
    const groups = Array.from(roomData.memberGroups.get(u) ?? []).sort()
    const node: GraphSnapshot['nodes'][number] = {
      id: u,
      label: displayNameForUsername(u, names),
      kind: u.startsWith('gh_') || u.includes('@hardcode') ? 'official' : 'contact',
      msg_count: counts.get(u) ?? 0,
      group_count: groups.length,
      group_codes: groups,
      is_friend: false,
    }
    persons.push(node)
    personIds.add(u)
  }
  persons.sort((a, b) => (b.msg_count ?? 0) - (a.msg_count ?? 0) || (b.group_count ?? 0) - (a.group_count ?? 0) || a.id.localeCompare(b.id))

  // groups: union of sessions and chat_room snapshots.
  const groups = buildGraphGroupNodes(
    groupUniverse,
    roomData,
    personIds,
    names,
    enterpriseNames,
    meta,
    counts,
  )

  const membershipByGroup = new Map<string, GraphMembershipRecord[]>()
  for (const [group, byMember] of roomData.membershipByGroup) {
    membershipByGroup.set(
      group,
      [...byMember.entries()]
        .map(([username, sources]) => ({ username, sources: [...sources].sort() }))
        .sort((a, b) => a.username.localeCompare(b.username)),
    )
  }
  const friendIds = new Set<string>()
  for (const [username, info] of meta) {
    if (info.isFriend && !isGroupConversationId(username, knownRoomIds)) friendIds.add(username)
  }
  const relationCoverage: GraphRelationCoverage = {
    derived_pairs: {
      budget: GRAPH_PAIR_WORK_BUDGET,
      used: 0,
      truncated: false,
      common_group: { candidates: 0, emitted: 0 },
      common_member: { candidates: 0, emitted: 0 },
    },
    dropped_edges: 0,
    dropped_by_type: {},
    unresolved_actors: {
      membership: 0,
      owner: 0,
      invite: 0,
      message_relation: 0,
      total: 0,
    },
  }
  const edges = await buildObservedEdges({
    decryptedDir,
    ...(selfUsername === undefined ? {} : { selfUsername }),
    personIds,
    groupIds: groupUniverse,
    friendIds,
    privateTalkers,
    sessionTalkers,
    sessionGroups: conversationGroups,
    messageCounts: counts,
    groupSenderCounts: messageStats.groupSenderCounts,
    membershipByGroup,
    groupOwners: roomData.groupOwners,
    invites: roomData.invites,
    messageRelations: messageStats.messageRelations,
    callRelations: messageStats.callRelations,
  }, relationCoverage)

  const coverage: GraphCoverage = {
    observed_edges: {
      cap: GRAPH_MAX_OBSERVED_EDGES,
      returned: edges.length,
      dropped: relationCoverage.dropped_edges,
      dropped_by_type: relationCoverage.dropped_by_type,
    },
    message_relations: {
      scopes: messageStats.relationScopes,
      scanned: messageStats.relationRowsScanned,
      budget: GRAPH_RELATION_MESSAGE_WINDOW_TOTAL,
      per_scope_budget: messageStats.relationRowBudgetPerScope,
      window_per_scope_cap: GRAPH_RELATION_MESSAGE_WINDOW_PER_GROUP,
      truncated_scopes: messageStats.relationScopesTruncated,
      record_budget: GRAPH_MESSAGE_RELATION_RECORD_CAP,
      dropped_records: messageStats.relationRecordsDropped,
    },
    derived_pairs: relationCoverage.derived_pairs,
    unresolved_actors: relationCoverage.unresolved_actors,
  }

  const totalMessages = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  const friendCount = persons.filter(n => n.is_friend).length
  const groupNames: Record<string, string> = {}
  for (const g of groups) groupNames[g.id] = g.label
  const topRelations = persons.slice(0, 8).map(n => ({
    username: n.id,
    name: n.label,
    ...(n.enterpriseName ? { enterpriseName: n.enterpriseName } : {}),
    msg_count: n.msg_count ?? 0,
  }))

  // 只有 ≥2 人的键才构成「班级」（单例不产生任何关系，前端也会直接跳过）
  const remarkGroups = [...classRoster.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => {
      members.sort((a, b) =>
        Number(b.is_friend) - Number(a.is_friend)
        || b.msg_count - a.msg_count
        || a.username.localeCompare(b.username),
      )
      return { key, total: members.length, members: members.slice(0, REMARK_ROSTER_CAP) }
    })
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))

  const selfMeta = selfWxid ? meta.get(selfWxid) : undefined
  nodes.push({
    id: 'self', label: '我', kind: 'self', msg_count: 0, is_friend: true,
    ...(selfMeta?.avatar ? { avatar_url: selfMeta.avatar } : {}),
  })
  nodes.push(...persons, ...groups)

  return {
    self: selfUsername ?? '',
    group_names: groupNames,
    remark_groups: remarkGroups,
    nodes,
    edges,
    coverage,
    summary: {
      total_contacts: persons.filter(n => n.kind === 'contact').length,
      total_groups: groups.length,
      total_messages: totalMessages,
      contact_book_total: persons.length,
      contact_book_friends: friendCount,
      contact_book_members: persons.filter(n => (n.group_count ?? 0) > 0).length,
      selected_contacts: persons.length,
      selected_groups: groups.length,
      top_relations: topRelations,
    },
  }
}
