/**
 * 媒体消息盘点工具（2026-11-13 新增）。
 *
 * ## 为什么必须扫消息分片，而不是查索引
 *
 * 消息检索索引里只有**文本**（`message_meta.text`），没有 `local_type`，也没有
 * 媒体元信息；「一共有多少张图片」「最近发过哪些语音」这类问题无法靠索引回答。
 * 所以本工具直接扫 `message/*.db` 的 `Msg_%` 表，按 `local_type` 的低 32 位筛出
 * 媒体行，再用**消息渲染链同一套解析器**（`parseMessageContent`）取时长/文件名/地点。
 *
 * ## 有界扫描
 *
 * 全库扫描在真机上有十几万行，工具调用不能无限占用事件循环。这里给了
 * **行数预算 + 时间预算 + 取消信号**三重上界，并在 `note` 里明确写「本次扫描」
 * 还是全量 —— 部分结果绝不能被当成完整统计。
 *
 * ## 方向为什么可能「不确定」
 *
 * `real_sender_id` 要通过分片自己的 `Name2Id` 才能还原成 wxid；群消息还可能以
 * 正文前缀为准。取不到发送者时**归入「方向未知」**而不是猜成收/发：
 * 猜错方向会让「我发了多少张图」直接答反。
 *
 * @module query/tools/media-tools
 */
import { fmtDateTimeSec } from '../../format.ts'
import { resolveSelfUsername } from '../../config/resolve.ts'
import { DatabaseSync } from '../db-open.ts'
import { displayNameForUsername, messageIdentityIndex, resolveTalkerUsername } from '../message-identity.ts'
import { contactMeta, shardCatalog } from '../meta.ts'
import { decodeBlobText, normalizeMsgType } from '../messages.ts'
import { parseMessageContent } from '../parse.ts'
import { YIELD_EVERY_ROWS, yieldToLoop } from '../search-build.ts'
import {
  argInt, argString,
  type RetrievalTool, type ToolHit, type ToolResult,
} from './types.ts'

/** 支持的媒体种类（与模型参数枚举一致）。 */
type MediaKind = 'image' | 'video' | 'voice' | 'file' | 'emoji' | 'location'

const KIND_LABELS: Readonly<Record<MediaKind, string>> = {
  image: '图片',
  video: '视频',
  voice: '语音',
  file: '文件',
  emoji: '表情',
  location: '位置',
}

/**
 * 各类媒体在 SQL 层的候选 `local_type`（已归一化到低 32 位）。
 *
 * 49 是 appmsg 容器：里面既有文件也有链接/小程序/转账等，所以只能先捞出来，
 * 再由 `parseMessageContent` 的 rich.type 精确判定为文件后才计入。
 * 244/246 是部分客户端直接落库的「文件」类型（见 `messages.ts#msgTypeLabel`）。
 */
const KIND_TYPES: Readonly<Record<MediaKind, readonly number[]>> = {
  image: [3],
  video: [43],
  voice: [34],
  file: [49, 244, 246],
  emoji: [47],
  location: [48],
}

/** 方向筛选口径。 */
type Direction = 'all' | 'sent' | 'received'

/** 单次调用的扫描预算：行数与时间都要有界。 */
const SCAN_MAX_ROWS = 50_000
const SCAN_BUDGET_MS = 1200

/** 默认/上限返回条数。 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 60

/** `parseMessageContent` 的 rich 描述类型（避免再引一份重复定义）。 */
type ParsedRich = NonNullable<ReturnType<typeof parseMessageContent>['rich']>

/** 扫描到的一条媒体消息（未截断的中间形态）。 */
interface MediaRow {
  /** 会话 username（`WechatSession.username` 的别名，不是显示名）。 */
  talker: string
  sender: string
  localId: number
  createTime: number
  kind: MediaKind
  snippet: string
}

/** 扫描结果：`truncated` 为 true 时只能当「本次扫描」用。 */
interface ScanResult {
  rows: MediaRow[]
  scanned: number
  truncated: boolean
  reason: string
}

/** 把 `YYYY-MM-DD` 转成当天 00:00 的 epoch 秒（本地时区）；非法日期返回 0。 */
function dayStartSec(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return 0
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const probe = new Date(y, mo - 1, d, 0, 0, 0)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return 0
  return Math.floor(probe.getTime() / 1000)
}

/** 把 `YYYY-MM-DD` 转成当天 23:59:59 的 epoch 秒（本地时区）；非法日期返回 0。 */
function dayEndSec(value: string): number {
  const start = dayStartSec(value)
  return start === 0 ? 0 : start + 86399
}

/** 折成单行短文本（文件名/地点里可能夹换行）。 */
function oneLine(value: string, max = 80): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

/** 按媒体种类生成一行可读摘要（与聊天界面的占位文案保持同一语感）。 */
function mediaSnippet(kind: MediaKind, rich: ParsedRich | undefined): string {
  switch (kind) {
    case 'image':
      return '[图片]'
    case 'video': {
      const sec = rich?.durationSec ?? 0
      return sec > 0 ? `[视频] ${sec}秒` : '[视频]'
    }
    case 'voice': {
      // voicelength 的单位是**毫秒**（见 parse.ts case 34），展示按秒取整。
      const sec = rich?.durationMs !== undefined ? Math.round(rich.durationMs / 1000) : 0
      return sec > 0 ? `[语音] ${sec}秒` : '[语音]'
    }
    case 'file': {
      const title = oneLine(rich?.title ?? '')
      return title !== '' ? `[文件] ${title}` : '[文件]'
    }
    case 'emoji':
      return '[表情]'
    case 'location': {
      const title = oneLine(rich?.title ?? '')
      const desc = oneLine(rich?.desc ?? '')
      const joined = [title, desc].filter(v => v !== '').join(' / ')
      return joined !== '' ? `[位置] ${joined}` : '[位置]'
    }
  }
}

/**
 * 把归一化类型 + rich 描述映射成工具支持的媒体种类。
 *
 * 返回 null 表示这条 49/244/246 不是「文件」，或本来就是无关类型 —— 一律跳过，
 * 不把链接/小程序/转账硬塞进「文件」统计。
 */
function mediaKindOf(normType: number, rich: ParsedRich | undefined): MediaKind | null {
  switch (normType) {
    case 3: return 'image'
    case 43: return 'video'
    case 34: return 'voice'
    case 47: return 'emoji'
    case 48: return 'location'
    case 49: return rich?.type === 'file' ? 'file' : null
    case 244:
    case 246: return 'file'
    default: return null
  }
}

/**
 * 方向判定：只做**有证据**的结论。
 *
 * `self` 或 `sender` 任一未知时返回 `unknown`，调用方按「归 all」处理（见模块头注）。
 */
function classifyDirection(sender: string, self: string): Direction | 'unknown' {
  if (self === '' || sender === '') return 'unknown'
  return sender === self ? 'sent' : 'received'
}

/**
 * 从群消息正文前缀里取真实发送者（`wxid_xxx:\n正文`）。
 *
 * 与 `messages.ts#senderFromContent` 同一判据：跳过不可打印的二进制块，
 * 允许前缀出现在正文任意位置，并排除「前缀就是群 id」的系统消息
 * （那会把系统提示误记成群成员发的）。
 */
function prefixSenderOf(content: string, isGroup: boolean, talker: string): string {
  if (!isGroup || content === '') return ''
  let printable = 0
  for (let i = 0; i < content.length && i < 512; i += 1) {
    const c = content.charCodeAt(i)
    if ((c >= 0x20 && c <= 0x7e) || c >= 0x80) printable += 1
  }
  if (printable / Math.min(content.length, 512) < 0.6) return ''
  const match = /([A-Za-z0-9_@.\-]{3,64}):\n/.exec(content)
  if (!match) return ''
  const head = match[1] ?? ''
  if (head.includes('<') || (talker !== '' && head === talker)) return ''
  return head
}

/**
 * 扫描全部分片里的媒体消息。
 * @param decryptedDir - 解密数据根。
 * @param kind - 要盘点的媒体种类。
 * @param wantedUsername - 会话 username 过滤（空串 = 全库）。
 * @param direction - 方向过滤；`all` 时未知方向也计入。
 * @param lo - 起始 epoch 秒（0 = 不限）。
 * @param hi - 截止 epoch 秒（0 = 不限）。
 * @param self - 本人 wxid（空串 = 未知）。
 * @param signal - 取消信号。
 * @returns 匹配行 + 扫描量 + 是否截断。
 */
async function scanMedia(
  decryptedDir: string,
  kind: MediaKind,
  wantedUsername: string,
  direction: Direction,
  lo: number,
  hi: number,
  self: string,
  signal: AbortSignal | undefined,
): Promise<ScanResult> {
  const started = Date.now()
  const types = KIND_TYPES[kind]
  const identity = messageIdentityIndex(decryptedDir, ['message'])
  const rows: MediaRow[] = []
  let scanned = 0
  let truncated = false
  let reason = ''

  outer:
  for (const shard of shardCatalog(decryptedDir)) {
    let db: DatabaseSync
    try {
      db = new DatabaseSync(shard.file, { readOnly: true })
    } catch {
      // 单个分片打不开（权限/损坏）不应让整次盘点失败。
      continue
    }
    try {
      for (const [table, meta] of shard.tables) {
        if (signal?.aborted) { truncated = true; reason = '已取消'; break outer }
        if (Date.now() - started > SCAN_BUDGET_MS) { truncated = true; reason = '时间预算'; break outer }
        if (!meta.cols.has('local_type') || !meta.cols.has('message_content')) continue
        // 表名 → 会话 username 是**唯一**可靠归属；解析不到就跳过该表，
        // 否则会产出没有 username 的 key（证据层无法定位）。
        const talker = identity.tableToUsername.get(table) ?? ''
        if (talker === '') continue
        if (wantedUsername !== '' && talker !== wantedUsername) continue
        const isGroup = talker.endsWith('@chatroom')
        const sel = (column: string, fallback: string): string =>
          meta.cols.has(column) ? column : fallback
        // local_id 缺失的老分片回退 rowid（与归档模块的回退口径一致），
        // 保证 key 仍然是 `username:local_id` 的稳定形状。
        const sql = `SELECT ${sel('local_id', 'rowid')} AS l, ${sel('create_time', '0')} AS t, `
          + `${sel('real_sender_id', '0')} AS s, local_type AS lt, `
          + `${sel('message_content', 'NULL')} AS c, rowid AS rk `
          + `FROM "${table.replace(/"/g, '""')}" `
          + `WHERE (local_type & 4294967295) IN (${types.join(',')})`
        let cursor: Iterable<Record<string, unknown>>
        try {
          cursor = db.prepare(sql).iterate() as Iterable<Record<string, unknown>>
        } catch {
          continue
        }
        for (const row of cursor) {
          if (signal?.aborted) { truncated = true; reason = '已取消'; break outer }
          if (scanned >= SCAN_MAX_ROWS) { truncated = true; reason = '行数预算'; break outer }
          if (Date.now() - started > SCAN_BUDGET_MS) { truncated = true; reason = '时间预算'; break outer }
          scanned += 1
          // 每 2000 行让出一次事件循环；让出点同时是取消检查点。
          if (scanned % YIELD_EVERY_ROWS === 0) await yieldToLoop()

          const createTime = Number(row['t'] ?? 0)
          if (lo > 0 && createTime < lo) continue
          if (hi > 0 && createTime > hi) continue

          const content = decodeBlobText(row['c'])
          const rawType = Number(row['lt'] ?? 0)
          const normType = normalizeMsgType(rawType)
          const parsed = parseMessageContent(normType, content, isGroup)
          const mediaKind = mediaKindOf(normType, parsed.rich)
          if (mediaKind === null || mediaKind !== kind) continue

          // 发送者：群前缀（真实 wxid）优先于 Name2Id；Name2Id 空行代表自己，
          // 但「自己」的 wxid 仍未解析出来 ⇒ 方向归未知，不猜。
          const name2IdSender = meta.name2id.get(Number(row['s'] ?? 0)) ?? ''
          const sender = prefixSenderOf(content, isGroup, talker).trim() || name2IdSender.trim()
          const dir = classifyDirection(sender, self)
          if (direction !== 'all' && dir !== direction) continue

          const localIdRaw = Number(row['l'] ?? 0)
          const localId = Number.isSafeInteger(localIdRaw) && localIdRaw > 0
            ? localIdRaw
            : Number(row['rk'] ?? 0)
          if (!Number.isSafeInteger(localId) || localId <= 0) continue
          rows.push({
            talker,
            sender,
            localId,
            createTime,
            kind: mediaKind,
            snippet: mediaSnippet(mediaKind, parsed.rich),
          })
        }
        // 表之间也让出：一张分片可能有十几万行、多个 Msg_ 表。
        await yieldToLoop()
      }
    } finally {
      db.close()
    }
    await yieldToLoop()
  }

  return { rows, scanned, truncated, reason }
}

/** 媒体消息盘点（图片/视频/语音/文件/表情/位置）。 */
export const aggregateMediaTool: RetrievalTool = {
  name: 'aggregate_media',
  category: 'aggregate',
  description:
    '盘点聊天里的**媒体消息**（图片/视频/语音/文件/表情/位置），返回条数、收发方向与最近一条。'
    + '适用于「发了多少张图片」「最近有哪些语音」「收过哪些文件」这类问题。'
    + '注意：它按本机消息分片统计，不是语义检索；找具体某张图用搜索类工具。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['image', 'video', 'voice', 'file', 'emoji', 'location'],
        description: '要盘点的媒体种类（必填）',
      },
      direction: {
        type: 'string',
        enum: ['all', 'sent', 'received'],
        description: '方向：all=全部（默认），sent=我发出的，received=我收到的',
      },
      username: { type: 'string', description: '限定某个会话（不填 = 全库）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      order: {
        type: 'string',
        enum: ['recent', 'oldest'],
        description: '返回顺序：recent=最近优先（默认），oldest=最早优先',
      },
      limit: { type: 'number', description: '最多返回几条（默认 20，上限 60）' },
    },
    required: ['kind'],
  },
  run: async (args, ctx): Promise<ToolResult> => {
    const started = Date.now()
    const rawKind = argString(args['kind']).trim()
    const kind = (['image', 'video', 'voice', 'file', 'emoji', 'location'] as const)
      .find(k => k === rawKind)
    if (kind === undefined) {
      return {
        tool: 'aggregate_media',
        ok: false,
        errorCode: 'invalid_arguments',
        error: 'kind 必须是 image / video / voice / file / emoji / location 之一',
        errorDetails: { parameter: 'kind' },
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    const directionArg = argString(args['direction']).trim()
    // 非法枚举回退 all（不报错、不猜某个方向）。
    const direction: Direction = directionArg === 'sent' || directionArg === 'received' ? directionArg : 'all'
    const orderArg = argString(args['order']).trim()
    const order = orderArg === 'oldest' ? 'oldest' : 'recent'
    const limit = argInt(args['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT)
    // 服务端锁定的 scope 优先于模型参数。
    const usernameArg = ctx.scope?.username?.trim() || argString(args['username']).trim()
    const from = ctx.scope?.from?.trim() || argString(args['from']).trim()
    const to = ctx.scope?.to?.trim() || argString(args['to']).trim()
    const lo = from ? dayStartSec(from) : 0
    const hi = to ? dayEndSec(to) : 0
    /*
     * 旧导航目标可能把 `Msg_<hash>` 当 username 传进来。解析失败时**不能**
     * 退化成空串扫描全库：`scanMedia` 会把空串当成「不限会话」，一次锁定
     * 请求就变成了跨会话统计（2026-11-13 审计的 fail-open）。宁可明确拒绝。
     */
    const resolvedUsername = usernameArg !== '' ? resolveTalkerUsername(ctx.decryptedDir, usernameArg) : ''
    if (usernameArg !== '' && resolvedUsername === '') {
      return {
        tool: 'aggregate_media',
        ok: false,
        errorCode: 'unsupported_scope',
        error: `无法解析会话 ${usernameArg} 的消息归属，不能扫描全库；请改用可识别的会话名或 username`,
        errorDetails: { username: usernameArg },
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    const wantedUsername = resolvedUsername
    const self = resolveSelfUsername(ctx.decryptedDir).trim()

    if (direction !== 'all' && self === '') {
      // 没有本人微信号就无法判定「我发的」；返回明确不可执行，而不是静默空结果。
      return {
        tool: 'aggregate_media',
        ok: false,
        errorCode: 'unsupported_scope',
        error: '无法确定本人微信号，不能按发/收方向筛选；请改用 direction=all',
        errorDetails: { parameter: 'direction' },
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }

    try {
      const scan = await scanMedia(
        ctx.decryptedDir, kind, wantedUsername, direction, lo, hi, self, ctx.signal,
      )
      const label = KIND_LABELS[kind]
      const matched = scan.rows
      const rangeLabel = from || to
        ? `${from || '不限'} ~ ${to || '不限'}`
        : '全部时间'

      if (matched.length === 0) {
        return {
          tool: 'aggregate_media',
          ok: true,
          hits: [],
          facts: [],
          note: `没有找到${label}消息（${rangeLabel}`
            + `${wantedUsername !== '' ? `，会话 ${wantedUsername}` : ''}`
            + `，方向 ${direction === 'all' ? '全部' : direction === 'sent' ? '发出' : '收到'}）`
            + (scan.truncated ? `；扫描已截断（${scan.reason}）` : ''),
          elapsedMs: Date.now() - started,
        }
      }

      matched.sort((a, b) => (order === 'recent'
        ? b.createTime - a.createTime || b.localId - a.localId
        : a.createTime - b.createTime || a.localId - b.localId))

      const meta = contactMeta(ctx.decryptedDir)
      const names = meta.names
      const enterpriseNames = meta.enterpriseNames
      const hits: ToolHit[] = matched.slice(0, limit).map((row) => {
        const name = displayNameForUsername(row.talker, names)
        const enterpriseName = enterpriseNames.get(row.talker)?.trim()
        const senderIsGroupMember = row.talker.endsWith('@chatroom') && row.sender !== ''
        return {
          key: `${row.talker}:${row.localId}`,
          name,
          ...(enterpriseName ? { enterpriseName } : {}),
          time: fmtDateTimeSec(row.createTime),
          snippet: row.snippet,
          ...(senderIsGroupMember
            ? { sender: row.sender === self ? '我' : displayNameForUsername(row.sender, names) }
            : {}),
          source: 'msg' as const,
          trace: {
            kind: 'msg' as const,
            username: row.talker,
            localId: row.localId,
          },
        }
      })

      // 统计口径：按**本次实际扫描到的**匹配行计数；截断时标题明确写「本次扫描」。
      let sent = 0
      let received = 0
      let unknown = 0
      let latest = 0
      for (const row of matched) {
        const dir = classifyDirection(row.sender, self)
        if (dir === 'sent') sent += 1
        else if (dir === 'received') received += 1
        else unknown += 1
        if (row.createTime > latest) latest = row.createTime
      }
      const recentDay = latest > 0 ? fmtDateTimeSec(latest).slice(0, 10) : ''
      const titlePrefix = scan.truncated ? '本次扫描 · ' : ''
      const factBody = [
        recentDay !== '' ? `最近 ${recentDay}` : '最近时间未知',
        unknown > 0 ? `方向未知 ${unknown} 条` : '',
      ].filter(part => part !== '').join('；')

      const noteParts = [
        `${label} ${matched.length} 条`,
        rangeLabel,
        wantedUsername !== '' ? `会话 ${wantedUsername}` : '全库',
        direction === 'all' ? '全部方向' : direction === 'sent' ? '仅发出' : '仅收到',
        `扫描 ${scan.scanned} 条媒体候选`,
        scan.truncated
          ? `已截断（${scan.reason}），统计仅代表本次扫描`
          : '全量扫描',
      ]
      return {
        tool: 'aggregate_media',
        ok: true,
        hits,
        facts: [{
          title: `${titlePrefix}${label}：${matched.length} 条（发 ${sent} / 收 ${received}）`,
          body: factBody,
        }],
        note: noteParts.join(' · '),
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return {
        tool: 'aggregate_media',
        ok: false,
        errorCode: 'upstream_failure',
        error: '媒体消息扫描失败：' + ((e as Error)?.message ?? String(e)),
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
  },
}

/** 媒体类工具集。 */
export const MEDIA_TOOLS: readonly RetrievalTool[] = [aggregateMediaTool]
