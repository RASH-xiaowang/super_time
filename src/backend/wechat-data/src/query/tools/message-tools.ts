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
import { searchIndexMessages } from '../search.ts'
import { loadMessageWindow } from '../search-query.ts'
import { withDb } from '../db-open.ts'
import { searchIndexPath } from '../search-scaffold.ts'
import { fmtDateTimeSec } from '../../format.ts'
import {
  argInt, argString, argStringArray,
  type RetrievalTool, type ToolContext, type ToolHit, type ToolResult,
} from './types.ts'

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

/** 会话显示名（从索引库的 `contact_fts` 取；取不到就用 username）。 */
function displayNames(decryptedDir: string): Map<string, string> {
  const out = new Map<string, string>()
  const p = searchIndexPath(decryptedDir)
  if (!existsSync(p)) return out
  try {
    return withDb(p, (db) => {
      const rows = db.prepare('SELECT username, name, remark FROM contact_fts').all() as Array<{ username: string; name: string; remark: string }>
      for (const r of rows) out.set(r.username, (r.remark || r.name || r.username).trim())
      return out
    })
  } catch { return out }
}

/** 关键词检索聊天消息。 */
export const searchMessagesTool: RetrievalTool = {
  name: 'search_messages',
  category: 'message',
  description:
    '按关键词检索本机微信聊天记录，返回命中的消息片段。'
    + '适用于「谁说过 X」「关于 X 的聊天」「X 是什么时候说的」这类**找具体内容**的问题。'
    + '多个关键词用空格分隔（会分别检索后合并）。'
    + '注意：它返回的是**片段**，不是统计结果 —— 问「一共多少条」请用 aggregate_messages。',
  parameters: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array', items: { type: 'string' },
        description: '检索关键词（1-6 个，每个 2-12 字，用有区分度的实词，不要用「什么/怎么/我的」这类疑问词）',
      },
      username: { type: 'string', description: '限定某个会话（不填 = 全库）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      limit: { type: 'number', description: '最多返回几条（默认 24，上限 60）' },
    },
    required: ['keywords'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const keywords = argStringArray(args['keywords'], 6)
    if (keywords.length === 0) return { tool: 'search_messages', ok: false, error: '缺少 keywords', hits: [] }
    const limit = argInt(args['limit'], 24, 1, 60)
    const username = argString(args['username']) || ctx.scope?.username || ''
    const from = argString(args['from']) || ctx.scope?.from || ''
    const to = argString(args['to']) || ctx.scope?.to || ''
    const lo = dayStartSec(from)
    const hi = dayEndSec(to)
    const names = displayNames(ctx.decryptedDir)

    const seen = new Set<string>()
    const hits: ToolHit[] = []
    for (const kw of keywords) {
      const r = searchIndexMessages(ctx.decryptedDir, kw, limit, username || undefined)
      for (const h of r.hits) {
        const key = h.username + ':' + h.local_id
        if (seen.has(key)) continue
        // 时间范围是**硬过滤**（用户/模型明确给了日期）—— 与流水线的软偏好不同：
        // 工具的参数是显式意图，填了就该生效。
        if (lo > 0 && h.create_time < lo) continue
        if (hi > 0 && h.create_time > hi) continue
        seen.add(key)
        hits.push({
          key,
          name: names.get(h.username) ?? h.name ?? h.username,
          time: fmtDateTimeSec(h.create_time),
          snippet: h.snippet,
          ...(h.sender ? { sender: h.sender } : {}),
          source: 'msg',
        })
        if (hits.length >= limit) break
      }
      if (hits.length >= limit) break
    }
    return {
      tool: 'search_messages', ok: true, hits,
      note: `关键词 ${keywords.join(' / ')} → 命中 ${hits.length} 条`,
      elapsedMs: Date.now() - started,
    }
  },
}

/** 取某个会话在某时段的消息（按时间升序）。 */
export const getSessionMessagesTool: RetrievalTool = {
  name: 'get_session_messages',
  category: 'message',
  description:
    '取**指定会话**在指定时间段内的消息（按时间升序）。'
    + '适用于「X 群上周聊了什么」「我和张三 9 月 3 号说了什么」这类**已知会话与时间**的问题。'
    + '与 search_messages 的区别：它不需要关键词，直接按会话 + 时间取。',
  parameters: {
    type: 'object',
    properties: {
      username: { type: 'string', description: '会话标识（群是 xxx@chatroom，单聊是 wxid_xxx）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
      limit: { type: 'number', description: '最多返回几条（默认 40，上限 200）' },
    },
    required: ['username'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const username = argString(args['username'])
    if (!username) return { tool: 'get_session_messages', ok: false, error: '缺少 username', hits: [] }
    const limit = argInt(args['limit'], 40, 1, 200)
    const lo = dayStartSec(argString(args['from']))
    const hi = dayEndSec(argString(args['to']))
    const names = displayNames(ctx.decryptedDir)
    const name = names.get(username) ?? username

    const p = searchIndexPath(ctx.decryptedDir)
    if (!existsSync(p)) return { tool: 'get_session_messages', ok: false, error: '检索索引不存在', hits: [] }
    try {
      const rows = withDb(p, (db) => {
        const parts = ['username = ?']
        const params: Array<string | number> = [username]
        if (lo > 0) { parts.push('create_time >= ?'); params.push(lo) }
        if (hi > 0) { parts.push('create_time <= ?'); params.push(hi) }
        return db.prepare(
          `SELECT local_id, create_time, text FROM message_meta WHERE ${parts.join(' AND ')} ORDER BY create_time ASC LIMIT ?`,
        ).all(...params, limit) as Array<{ local_id: number; create_time: number; text: string }>
      })
      const hits: ToolHit[] = rows.map(r => ({
        key: username + ':' + r.local_id,
        name,
        time: fmtDateTimeSec(r.create_time),
        snippet: r.text.slice(0, 200),
        source: 'msg',
      }))
      return {
        tool: 'get_session_messages', ok: true, hits,
        note: `${name} · ${hits.length} 条${lo > 0 || hi > 0 ? `（${argString(args['from']) || '不限'} ~ ${argString(args['to']) || '不限'}）` : ''}`,
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
    const username = key.slice(0, at)
    const localId = Number(key.slice(at + 1))
    if (!Number.isFinite(localId)) return { tool: 'get_message_context', ok: false, error: 'key 里的 local_id 不是数字', hits: [] }
    const spanMin = argInt(args['spanMinutes'], 15, 1, 120)
    const maxMsgs = argInt(args['maxMessages'], 14, 1, 60)

    // 先定位这条消息的时间（窗口展开需要中心时间）。
    const p = searchIndexPath(ctx.decryptedDir)
    if (!existsSync(p)) return { tool: 'get_message_context', ok: false, error: '检索索引不存在', hits: [] }
    let centerSec = 0
    try {
      const row = withDb(p, (db) => db.prepare('SELECT create_time FROM message_meta WHERE username = ? AND local_id = ? LIMIT 1')
        .get(username, localId) as { create_time?: number } | undefined)
      centerSec = Number(row?.create_time ?? 0)
    } catch { /* 取不到就报错 */ }
    if (centerSec <= 0) return { tool: 'get_message_context', ok: false, error: '找不到这条消息（key 可能过期）', hits: [] }

    const names = displayNames(ctx.decryptedDir)
    const win = loadMessageWindow(ctx.decryptedDir, username, centerSec * 1000, spanMin * 60 * 1000, maxMsgs)
    const hits: ToolHit[] = win.map(w => ({
      key: username + ':' + w.local_id,
      name: names.get(username) ?? username,
      time: fmtDateTimeSec(w.create_time),
      snippet: w.text.slice(0, 200),
      ...(w.sender ? { sender: w.sender } : {}),
      source: 'msg',
    }))
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
      const kindWhere = kind === 'group' ? " WHERE username LIKE '%@chatroom'"
        : kind === 'single' ? " WHERE username NOT LIKE '%@chatroom'" : ''
      const order = orderBy === 'recent' ? 'MAX(create_time) DESC' : 'COUNT(*) DESC'
      const rows = withDb(p, (db) => db.prepare(
        `SELECT username, COUNT(*) AS c, MIN(create_time) AS mn, MAX(create_time) AS mx FROM message_meta${kindWhere} GROUP BY username ORDER BY ${order} LIMIT ?`,
      ).all(limit) as Array<{ username: string; c: number; mn: number; mx: number }>)
      const names = displayNames(ctx.decryptedDir)
      const hits: ToolHit[] = rows.map(r => ({
        key: r.username,
        name: names.get(r.username) ?? r.username,
        time: fmtDateTimeSec(r.mx),
        snippet: `${r.c} 条消息（${fmtDateTimeSec(r.mn).slice(0, 10)} ~ ${fmtDateTimeSec(r.mx).slice(0, 10)}）`,
        source: 'msg',
      }))
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
