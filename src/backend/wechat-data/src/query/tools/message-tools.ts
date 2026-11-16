/**
 * 消息类检索工具（2026-10-16 新增）。
 *
 * 三个工具覆盖「找消息」的三种粒度：
 *   · `search_messages` —— 关键词找**片段**（最常用）；
 *   · `get_session_messages` —— 取某个会话在**某时段**的消息（「那个群上周聊了啥」）；
 *   · `get_message_context` —— 取某条消息**前后**的上下文（「这句话是在说什么」）。
 *
 * 为什么拆成三个而不是一个带 `mode` 参数的工具：模型对「一个工具做三件事」的
 * 参数填写准确率明显低于「三个工具各做一件事」—— 而参数填错的表现是**静默返回空**，
 * 不是报错（最难查的一类失败）。
 *
 * @module query/tools/message-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadDisplayNames, searchIndexMessages } from '../search.ts'
import { loadMessageWindow } from '../search-query.ts'
import { withDb } from '../db-open.ts'
import { contactMeta } from '../meta.ts'
import { searchIndexPath } from '../search-scaffold.ts'
import { fmtDateTimeSec } from '../../format.ts'
import {
  fallbackChatDisplayName,
  isInternalWechatId,
  mergeDisplayNames,
  messageTableHash,
  messageTableName,
  readableIdentityLabel,
  replaceWechatIds,
  resolveTalkerUsername,
} from '../message-identity.ts'
import {
  argInt, argString, argStringArray,
  type RetrievalTool, type ToolContext, type ToolHit, type ToolResult,
} from './types.ts'
import type { SearchHit } from '../../types.ts'

/** 把 `YYYY-MM-DD` 转成当天 00:00 的 epoch 秒（本地时区）。 */
function dayStartSec(d: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m) return 0
  return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0).getTime() / 1000)
}

/** 把 `YYYY-MM-DD` 转成当天 23:59:59 的 epoch 秒（本地时区）。 */
function dayEndSec(d: string): number {
  const s = dayStartSec(d)
  return s === 0 ? 0 : s + 86399
}

interface DisplayIdentity {
  name: string
  enterpriseName?: string
}

/** 会话显示名与企业名；统一从身份索引 + contact.db 读取，兼容旧索引库。 */
function displayNames(decryptedDir: string): Map<string, DisplayIdentity> {
  const out = new Map<string, DisplayIdentity>()
  const meta = contactMeta(decryptedDir)
  for (const [username, name] of mergeDisplayNames(decryptedDir)) {
    out.set(username, { name: name.trim() || fallbackChatDisplayName(username) })
  }
  for (const [username, enterpriseName] of meta.enterpriseNames) {
    const current = out.get(username)
    out.set(username, {
      name: current?.name || meta.names.get(username)?.trim() || fallbackChatDisplayName(username),
      enterpriseName,
    })
  }
  return out
}

function mappedIdentityName(
  names: Map<string, DisplayIdentity>,
  raw: string,
): string {
  const direct = names.get(raw)?.name
    ?? names.get(raw.toLowerCase())?.name
    ?? ''
  return readableIdentityLabel(direct, raw)
}

/** Resolve a stored sender at the tool boundary; never expose an internal ID. */
function readableSender(
  sender: string,
  names: Map<string, DisplayIdentity>,
  preferred: string,
): string {
  const raw = sender.trim()
  if (raw === '') return ''
  // Search indexes built by newer versions already store display labels.
  if (!isInternalWechatId(raw)) return raw
  const mapped = mappedIdentityName(names, raw)
  if (mapped !== '') return mapped
  const preferredLabel = readableIdentityLabel(preferred, raw)
  if (preferredLabel !== '') return preferredLabel
  return raw.toLowerCase().endsWith('@chatroom') ? '某个群聊' : '某位成员'
}

/** Sanitize message bodies before snippets enter the synthesis prompt. */
function readableMessageText(
  text: string,
  names: Map<string, DisplayIdentity>,
  chatUsername: string,
  chatName: string,
): string {
  const ownChat = readableIdentityLabel(chatName, chatUsername)
    || (chatUsername.endsWith('@chatroom') ? '某个群聊' : fallbackChatDisplayName(chatUsername))
  return replaceWechatIds(
    text,
    raw => mappedIdentityName(names, raw),
    (raw) => {
      if (raw === chatUsername) return ownChat
      if (raw.toLowerCase().endsWith('@chatroom')) return '某个群聊'
      return chatUsername.endsWith('@chatroom') ? '某位成员' : '某位联系人'
    },
  )
}

/**
 * 正文是否真的包含关键词。
 *
 * 为什么 `sender` 场景需要它：索引的 `person` 是 `who:` 召回分支（OR 进 MATCH），
 * 只按「这个人的会话/名字」命中的消息可能正文里根本没有关键词。用户同时给了
 * keyword 与 sender 时，语义是「这个人说的、包含这个词的消息」= AND，
 * 所以这里强制正文包含关键词；未给 sender 时保持旧的 who 召回行为不变。
 */
function textContainsKeyword(text: string, keyword: string): boolean {
  const t = String(text ?? '').toLowerCase()
  const k = keyword.trim().toLowerCase()
  if (k === '') return true
  if (t.includes(k)) return true
  // FTS 会丢弃空白/标点：多段关键词逐段都出现，等价于 bigram 短语命中。
  const parts = k.split(/\s+/).filter(Boolean)
  return parts.length > 1 && parts.every(p => t.includes(p))
}

/**
 * 命中是否来自指定发送者。
 *
 * 为什么还要在工具层再筛一次：索引里的 `person` 是 `who:` 召回分支（与会话名/发送者名
 * 的 BM25 匹配，OR 进查询），它**提高**相关命中的排名，但不是严格过滤。模型参数
 * `sender` 是显式意图，必须真的只返回这个人的消息 —— 否则「张三说过什么」会混入
 * 别人提到张三的消息。
 */
function senderMatches(
  hit: SearchHit,
  want: string,
  names: Map<string, DisplayIdentity>,
): boolean {
  const target = want.trim().toLowerCase()
  if (target === '') return true
  const raw = (hit.sender_username ?? '').trim()
  const mapped = raw ? (names.get(raw) ?? names.get(raw.toLowerCase())) : undefined
  const candidates = [
    raw,
    hit.sender ?? '',
    mapped?.name ?? '',
    mapped?.enterpriseName ?? '',
  ]
  // 单聊没有群前缀（message_meta.sender 为空）；会话对方就是消息的发送者，
  // 因此允许用对方的会话 username / 显示名作为 sender。
  if (!hit.username.endsWith('@chatroom')) {
    candidates.push(hit.username, hit.name, names.get(hit.username)?.name ?? '')
  }
  return candidates.some(v => v.trim() !== '' && v.trim().toLowerCase() === target)
}

/** 日期范围硬过滤（epoch 秒；0 = 不限）。 */
function inTimeRange(sec: number, lo: number, hi: number): boolean {
  if (lo > 0 && sec < lo) return false
  if (hi > 0 && sec > hi) return false
  return true
}

/**
 * 把发送者参数（显示名 / username / 企业名）解析成 SQL `IN` 可用的原始 wxid 别名。
 *
 * `message_meta.sender` 存的是原始 wxid（见 search-build.ts），而模型通常给显示名；
 * 不反查就会「按显示名筛出 0 条」—— 这种失败不报错，最难发现。
 */
function resolveSenderAliases(
  decryptedDir: string,
  sender: string,
  // 同时接受 `DisplayIdentity`（含企业名）与纯显示名映射：群内备注只在
  // `loadDisplayNames` 里有，而企业名只在 `displayNames` 里有，调用方按需选。
  names: ReadonlyMap<string, string | DisplayIdentity>,
): string[] {
  const raw = sender.trim()
  if (raw === '') return []
  const out = new Set<string>([raw])
  const resolved = resolveTalkerUsername(decryptedDir, raw)
  if (resolved) out.add(resolved)
  const target = raw.toLowerCase()
  for (const [username, entry] of names) {
    const display = typeof entry === 'string' ? entry : entry.name
    const enterprise = typeof entry === 'string' ? '' : entry.enterpriseName ?? ''
    if (display.trim().toLowerCase() === target) out.add(username)
    if (enterprise.trim().toLowerCase() === target) out.add(username)
  }
  return [...out]
}

/** 关键词检索聊天消息。 */
export const searchMessagesTool: RetrievalTool = {
  name: 'search_messages',
  category: 'message',
  description:
    '按关键词检索本机微信聊天记录，返回命中的消息片段。'
    + '适用于「谁说过 X」「关于 X 的聊天」「X 是什么时候说的」这类**找具体内容**的问题。'
    + '多个关键词用空格分隔：match=any（默认）分别检索后合并；match=all 取交集（多条件同时满足）。'
    + '可用 sender 限定群内某个人，order=recent 按时间倒序。'
    + '注意：它返回的是**片段**，不是统计结果 —— 问「一共多少条」请用 aggregate_messages。',
  parameters: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array', items: { type: 'string' },
        description: '检索关键词（1-6 个，每个 2-12 字，用有区分度的实词，不要用「什么/怎么/我的」这类疑问词）',
      },
      username: { type: 'string', description: '限定某个会话（不填 = 全库）' },
      sender: { type: 'string', description: '限定发送者：群内成员的显示名或 username；单聊可填对方（不填 = 不限发送者）' },
      match: {
        type: 'string',
        enum: ['all', 'any'],
        description: '多关键词匹配方式：any = 任一命中（默认，覆盖面广）；all = 全部命中（交集，多条件精确定位）',
      },
      order: {
        type: 'string',
        enum: ['relevance', 'recent'],
        description: '结果顺序：relevance = 相关度（默认）；recent = 按消息时间倒序，问「最近/最新」时使用',
      },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      limit: { type: 'number', description: '最多返回几条（默认 24，上限 100）' },
    },
    required: ['keywords'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const keywords = argStringArray(args['keywords'], 6)
    if (keywords.length === 0) return { tool: 'search_messages', ok: false, error: '缺少 keywords', hits: [] }
    const limit = argInt(args['limit'], 24, 1, 100)
    // 枚举值非法时回退默认值（不报错）：模型偶尔会写 `"ALL"`、`"time"` 这类词，
    // 报错会让它整次调用失败，而回退到兼容行为仍能给出有用结果。
    const match = argString(args['match']).trim().toLowerCase() === 'all' ? 'all' : 'any'
    const order = argString(args['order']).trim().toLowerCase() === 'recent' ? 'recent' : 'relevance'
    const sender = argString(args['sender']).trim()
    // `ctx.scope` 是服务端锁定的硬范围，优先级高于模型参数。
    const requestedUsername = ctx.scope?.username || argString(args['username'])
    const username = requestedUsername
      ? resolveTalkerUsername(ctx.decryptedDir, requestedUsername)
      : ''
    if (requestedUsername && !username) {
      return { tool: 'search_messages', ok: false, error: '无法解析会话身份', hits: [] }
    }
    const from = ctx.scope?.from || argString(args['from'])
    const to = ctx.scope?.to || argString(args['to'])
    const lo = dayStartSec(from)
    const hi = dayEndSec(to)
    // 有发送者/日期/交集/时间排序时要更大的候选池：
    //   · 日期已经下推到索引 SQL（见 searchIndexMessages），不会因 top-N 截断误判为 0；
    //   · `sender` 的 person 分支是 OR 召回，严格过滤后可能只剩一部分，需要更深的池；
    //   · `match=all` 的交集与 `order=recent` 的排序仍在内存里做，需要约 10 倍池。
    const needsPool = sender !== '' || match === 'all' || order === 'recent' || lo > 0 || hi > 0
    const candidateLimit = needsPool ? Math.min(Math.max(limit * 10, 100), 1000) : limit
    const range = lo > 0 || hi > 0
      ? { ...(lo > 0 ? { lo } : {}), ...(hi > 0 ? { hi } : {}) }
      : undefined
    const names = displayNames(ctx.decryptedDir)
    const keyOf = (h: SearchHit): string => h.username + ':' + h.local_id

    // 逐词检索（person 作为索引召回线索一起下发）。
    const perTerm: SearchHit[][] = []
    for (const kw of keywords) {
      const r = searchIndexMessages(
        ctx.decryptedDir, kw, candidateLimit,
        username || undefined, sender || undefined, range,
      )
      perTerm.push(r.hits.filter(h =>
        inTimeRange(h.create_time, lo, hi)
        && senderMatches(h, sender, names)
        && (sender === '' || textContainsKeyword(h.text, kw))))
    }

    let merged: SearchHit[]
    if (match === 'all') {
      // 交集：以第一个词的命中为骨架，要求同一个 key 也出现在其余每个词的结果里。
      // 任一关键词 0 命中 ⇒ 交集必然为空（直接短路，省掉后续集合运算）。
      const first = perTerm[0] ?? []
      const otherKeys = perTerm.slice(1).map(list => new Set(list.map(keyOf)))
      merged = perTerm.some(list => list.length === 0)
        ? []
        : first.filter(h => otherKeys.every(set => set.has(keyOf(h))))
    } else {
      const seen = new Set<string>()
      merged = []
      for (const list of perTerm) {
        for (const h of list) {
          const key = keyOf(h)
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(h)
        }
      }
    }

    // recent 按真实消息时间倒序（相关度顺序回答不了「最近一次」；同秒用 local_id 兜底稳定）。
    if (order === 'recent') {
      merged.sort((a, b) => b.create_time - a.create_time || b.local_id - a.local_id)
    }

    const hits: ToolHit[] = merged.slice(0, limit).map((h) => {
      const key = keyOf(h)
      const identity = names.get(h.username)
      const enterpriseName = h.enterpriseName
        || identity?.enterpriseName
      const senderEnterpriseName = h.senderEnterpriseName
        || (h.sender_username ? names.get(h.sender_username)?.enterpriseName : undefined)
      const name = identity?.name ?? h.name ?? fallbackChatDisplayName(h.username)
      const senderLabelText = readableSender(
        h.sender ?? '',
        names,
        h.username.endsWith('@chatroom') ? '' : name,
      )
      return {
        key,
        name,
        ...(enterpriseName ? { enterpriseName } : {}),
        time: fmtDateTimeSec(h.create_time),
        snippet: readableMessageText(h.snippet, names, h.username, name),
        ...(senderLabelText ? { sender: senderLabelText } : {}),
        ...(senderEnterpriseName ? { senderEnterpriseName } : {}),
        source: 'msg',
      }
    })
    return {
      tool: 'search_messages', ok: true, hits,
      note: `关键词 ${keywords.join(' / ')} → 命中 ${hits.length} 条`
        + (match === 'all' ? '（交集）' : '')
        + (order === 'recent' ? ' · 最新优先' : '')
        + (sender ? ` · 发送者 ${sender}` : ''),
      elapsedMs: Date.now() - started,
    }
  },
}

/** 取某个会话在某时段的消息（默认按时间升序，可显式取最新优先）。 */
export const getSessionMessagesTool: RetrievalTool = {
  name: 'get_session_messages',
  category: 'message',
  description:
    '取**指定会话**在指定时间段内的消息（默认按时间升序，order=desc 时最新优先）。'
    + '适用于「X 群上周聊了什么」「我和张三 9 月 3 号说了什么」这类**已知会话与时间**的问题。'
    + '与 search_messages 的区别：它不需要关键词，直接按会话 + 时间取。',
  parameters: {
    type: 'object',
    properties: {
      username: { type: 'string', description: '会话标识（群是 xxx@chatroom，单聊是 wxid_xxx；会话已锁定时可省略）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
      sender: { type: 'string', description: '只看某个发送者（群内成员显示名或 username；不填 = 全部）' },
      limit: { type: 'number', description: '最多返回几条（默认 40，上限 200）' },
      offset: { type: 'number', description: '跳过前几条（默认 0，上限 1000；用于翻页）' },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: '返回顺序：asc = 按时间正序（默认）；desc = 最新优先，问「最近/最新」时使用',
      },
    },
    required: ['username'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const requestedUsername = ctx.scope?.username || argString(args['username'])
    if (!requestedUsername) return { tool: 'get_session_messages', ok: false, error: '缺少 username', hits: [] }
    const username = resolveTalkerUsername(ctx.decryptedDir, requestedUsername)
    if (!username) return { tool: 'get_session_messages', ok: false, error: '无法解析会话身份', hits: [] }
    const limit = argInt(args['limit'], 40, 1, 200)
    const offset = argInt(args['offset'], 0, 0, 1000)
    const order = argString(args['order']).trim().toLowerCase() === 'desc' ? 'desc' : 'asc'
    const senderArg = argString(args['sender']).trim()
    // 服务端固定范围必须兜底：漏填 `from/to` 时不能退化成「查全历史」。
    const from = ctx.scope?.from || argString(args['from'])
    const to = ctx.scope?.to || argString(args['to'])
    const lo = dayStartSec(from)
    const hi = dayEndSec(to)
    const names = displayNames(ctx.decryptedDir)
    const identity = names.get(username)
    const name = identity?.name ?? fallbackChatDisplayName(username)

    const p = searchIndexPath(ctx.decryptedDir)
    if (!existsSync(p)) return { tool: 'get_session_messages', ok: false, error: '检索索引不存在', hits: [] }
    try {
      const rows = withDb(p, (db) => {
        const aliases = [...new Set([
          requestedUsername,
          username,
          messageTableHash(username),
          messageTableName(username),
        ])]
        const parts = [`username IN (${aliases.map(() => '?').join(', ')})`]
        const params: Array<string | number> = [...aliases]
        if (lo > 0) { parts.push('create_time >= ?'); params.push(lo) }
        if (hi > 0) { parts.push('create_time <= ?'); params.push(hi) }
        // sender 在 SQL 里过滤（`message_meta.sender` 存的是原始 wxid）。
        // 模型/用户给的是显示名时，先把显示名反查成 username 再放进 IN —— 否则
        // 「只看张三」会静默返回 0 条（查不到还不报错是最难查的一类失败）。
        const senderAliases = senderArg
          ? resolveSenderAliases(ctx.decryptedDir, senderArg, loadDisplayNames(ctx.decryptedDir))
          : []
        if (senderAliases.length > 0) {
          parts.push(`sender IN (${senderAliases.map(() => '?').join(', ')})`)
          params.push(...senderAliases)
        }
        return db.prepare(
          `SELECT local_id, create_time, text, sender FROM message_meta WHERE ${parts.join(' AND ')} ORDER BY create_time ${order === 'desc' ? 'DESC' : 'ASC'}, local_id ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset) as Array<{ local_id: number; create_time: number; text: string; sender?: string }>
      })
      const hits: ToolHit[] = rows.map((r) => {
        const sender = readableSender(
          r.sender ?? '',
          names,
          username.endsWith('@chatroom') ? '' : name,
        )
        return {
          key: username + ':' + r.local_id,
          name,
          ...(identity?.enterpriseName ? { enterpriseName: identity.enterpriseName } : {}),
          time: fmtDateTimeSec(r.create_time),
          snippet: readableMessageText(r.text, names, username, name).slice(0, 200),
          ...(sender ? { sender } : {}),
          ...(r.sender && names.get(r.sender)?.enterpriseName
            ? { senderEnterpriseName: names.get(r.sender)?.enterpriseName }
            : {}),
          source: 'msg',
        }
      })
      return {
        tool: 'get_session_messages', ok: true, hits,
        note: `${name} · ${hits.length} 条${order === 'desc' ? ' · 最新优先' : ''}${offset > 0 ? ` · 跳过 ${offset} 条` : ''}${senderArg ? ` · 发送者 ${senderArg}` : ''}${lo > 0 || hi > 0 ? `（${from || '不限'} ~ ${to || '不限'}）` : ''}`,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return { tool: 'get_session_messages', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 取某条消息前后的上下文窗口。 */
export const getMessageContextTool: RetrievalTool = {
  name: 'get_message_context',
  category: 'message',
  description:
    '取某条消息**前后若干条**的上下文（同一会话、时间相邻）。'
    + '适用于「这句话是在说什么」「[n] 那条的前因后果」这类需要**展开上下文**的问题。'
    + '参数用 search_messages 返回的 key（`username:local_id`）。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '消息键，形如 `wxid_xxx:12345` 或 `12345678@chatroom:678`' },
      spanMinutes: { type: 'number', description: '前后各取多少分钟（默认 15，上限 120）' },
      maxMessages: { type: 'number', description: '最多返回几条（默认 14，上限 60）' },
    },
    required: ['key'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const key = argString(args['key'])
    const at = key.lastIndexOf(':')
    if (at <= 0) return { tool: 'get_message_context', ok: false, error: 'key 形状不对（应为 username:local_id）', hits: [] }
    const requestedUsername = key.slice(0, at)
    const username = resolveTalkerUsername(ctx.decryptedDir, requestedUsername)
    if (!username) return { tool: 'get_message_context', ok: false, error: '无法解析会话身份', hits: [] }
    const localId = Number(key.slice(at + 1))
    if (!Number.isFinite(localId)) return { tool: 'get_message_context', ok: false, error: 'key 里的 local_id 不是数字', hits: [] }
    const spanMin = argInt(args['spanMinutes'], 15, 1, 120)
    const maxMsgs = argInt(args['maxMessages'], 14, 1, 60)

    // 先定位这条消息的时间（窗口展开需要中心时间）。
    const p = searchIndexPath(ctx.decryptedDir)
    if (!existsSync(p)) return { tool: 'get_message_context', ok: false, error: '检索索引不存在', hits: [] }
    let centerSec = 0
    try {
      const aliases = [...new Set([
        requestedUsername,
        username,
        messageTableHash(username),
        messageTableName(username),
      ])]
      const row = withDb(p, (db) => db.prepare(
        `SELECT create_time FROM message_meta WHERE username IN (${aliases.map(() => '?').join(', ')}) AND local_id = ? LIMIT 1`,
      ).get(...aliases, localId) as { create_time?: number } | undefined)
      centerSec = Number(row?.create_time ?? 0)
    } catch { /* 取不到就报错 */ }
    if (centerSec <= 0) return { tool: 'get_message_context', ok: false, error: '找不到这条消息（key 可能过期）', hits: [] }

    const names = displayNames(ctx.decryptedDir)
    const from = ctx.scope?.from ?? ''
    const to = ctx.scope?.to ?? ''
    const win = loadMessageWindow(ctx.decryptedDir, username, centerSec * 1000, spanMin * 60 * 1000, maxMsgs)
      .filter((w) => {
        const day = fmtDateTimeSec(w.create_time).slice(0, 10)
        return (from === '' || day >= from) && (to === '' || day <= to)
      })
    const name = names.get(username)?.name ?? fallbackChatDisplayName(username)
    const hits: ToolHit[] = win.map((w) => {
      const sender = readableSender(
        w.sender ?? '',
        names,
        username.endsWith('@chatroom') ? '' : name,
      )
      return {
        key: username + ':' + w.local_id,
        name,
        ...(names.get(username)?.enterpriseName
          ? { enterpriseName: names.get(username)?.enterpriseName }
          : {}),
        time: fmtDateTimeSec(w.create_time),
        snippet: readableMessageText(w.text, names, username, name).slice(0, 200),
        ...(sender ? { sender } : {}),
        ...(w.sender && names.get(w.sender)?.enterpriseName
          ? { senderEnterpriseName: names.get(w.sender)?.enterpriseName }
          : {}),
        source: 'msg',
      }
    })
    return {
      tool: 'get_message_context', ok: true, hits,
      note: `上下文 ${hits.length} 条（±${spanMin} 分钟）`,
      elapsedMs: Date.now() - started,
    }
  },
}

/** 会话列表（按活跃度或时间排序）。 */
export const listSessionsTool: RetrievalTool = {
  name: 'list_sessions',
  category: 'message',
  description:
    '列出会话（聊天对象），可按消息数或最近活跃时间排序。'
    + '适用于「我有哪些群」「最近跟谁聊过」「哪个会话最活跃」这类**先确定范围**的问题。'
    + '返回的是会话清单（含消息数），不是消息内容。',
  parameters: {
    type: 'object',
    properties: {
      orderBy: { type: 'string', enum: ['count', 'recent'], description: 'count = 按消息数（默认）；recent = 按最近活跃' },
      kind: { type: 'string', enum: ['all', 'group', 'single'], description: 'all = 全部（默认）；group = 只看群聊；single = 只看单聊' },
      limit: { type: 'number', description: '最多返回几个（默认 20，上限 100）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const orderBy = argString(args['orderBy'], 'count') === 'recent' ? 'recent' : 'count'
    const kind = argString(args['kind'], 'all')
    const limit = argInt(args['limit'], 20, 1, 100)
    const p = searchIndexPath(ctx.decryptedDir)
    if (!existsSync(p)) return { tool: 'list_sessions', ok: false, error: '检索索引不存在', hits: [] }
    try {
      const order = orderBy === 'recent' ? 'MAX(create_time) DESC' : 'COUNT(*) DESC'
      const rows = withDb(p, (db) => db.prepare(
        `SELECT username, COUNT(*) AS c, MIN(create_time) AS mn, MAX(create_time) AS mx FROM message_meta GROUP BY username ORDER BY ${order} LIMIT ?`,
      ).all(5000) as Array<{ username: string; c: number; mn: number; mx: number }>)
      const names = displayNames(ctx.decryptedDir)
      const grouped = new Map<string, { c: number; mn: number; mx: number }>()
      for (const row of rows) {
        const username = resolveTalkerUsername(ctx.decryptedDir, row.username)
        if (!username) continue
        if (kind === 'group' && !username.endsWith('@chatroom')) continue
        if (kind === 'single' && username.endsWith('@chatroom')) continue
        const previous = grouped.get(username)
        grouped.set(username, {
          c: (previous?.c ?? 0) + Number(row.c ?? 0),
          mn: previous ? Math.min(previous.mn, Number(row.mn ?? 0)) : Number(row.mn ?? 0),
          mx: previous ? Math.max(previous.mx, Number(row.mx ?? 0)) : Number(row.mx ?? 0),
        })
      }
      const canonicalRows = [...grouped.entries()]
        .sort((a, b) => orderBy === 'recent' ? b[1].mx - a[1].mx : b[1].c - a[1].c)
        .slice(0, limit)
      const hits: ToolHit[] = canonicalRows.map(([username, r]) => {
        const identity = names.get(username)
        return {
          key: username,
          name: identity?.name ?? fallbackChatDisplayName(username),
          ...(identity?.enterpriseName ? { enterpriseName: identity.enterpriseName } : {}),
          time: fmtDateTimeSec(r.mx),
          snippet: `${r.c} 条消息（${fmtDateTimeSec(r.mn).slice(0, 10)} ~ ${fmtDateTimeSec(r.mx).slice(0, 10)}）`,
          source: 'msg',
        }
      })
      return {
        tool: 'list_sessions', ok: true, hits,
        note: `${hits.length} 个会话（按${orderBy === 'recent' ? '最近活跃' : '消息数'}）`,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return { tool: 'list_sessions', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 消息类工具集。 */
export const MESSAGE_TOOLS: readonly RetrievalTool[] = [
  searchMessagesTool,
  getSessionMessagesTool,
  getMessageContextTool,
  listSessionsTool,
]

/** 供其它模块复用的时间工具（避免各工具各写一份）。 */
export { dayStartSec, dayEndSec, displayNames }
