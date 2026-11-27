/**
 * 社交圈摘要（不画整张图谱）。
 *
 * 「我和谁最熟」「有哪些班级/编号圈子」的答案不在某一条消息里，
 * 也不该为此重建整张关系图（群成员、邀请、回复边都很重）。
 * 这里只做两件便宜的事：按消息索引数出最常联系的人，再按备注编号归成圈子。
 *
 * @module query/tools/social-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSelfUsername } from '../../config/resolve.ts'
import { withDb, type DatabaseSync } from '../db-open.ts'
import { remarkClassKey } from '../graph.ts'
import { searchIndexPath } from '../search-scaffold.ts'
import { argInt, argString, type RetrievalTool, type ToolHit, type ToolResult } from './types.ts'

const PEOPLE_CAP = 30
const CIRCLE_CAP = 8
const CIRCLE_NAMES = 6

interface PersonRow {
  username: string
  name: string
  remark: string
  count: number
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(row => row.name))
  } catch {
    return new Set()
  }
}

function skipUsername(username: string, self: string): boolean {
  if (username === '' || username === self) return true
  if (username.endsWith('@chatroom')) return true
  if (username.startsWith('gh_')) return true
  return username === 'filehelper' || username === 'weixin' || username === 'newsapp' || username === 'fmessage'
}

function loadPeople(decryptedDir: string, self: string): PersonRow[] {
  const indexPath = searchIndexPath(decryptedDir)
  if (!existsSync(indexPath)) return []
  const counts = new Map<string, number>()
  const rows = withDb(indexPath, (db) => db.prepare(
    'SELECT username, COUNT(*) AS c FROM message_meta GROUP BY username ORDER BY c DESC LIMIT 400',
  ).all() as Array<{ username: string; c: number }>)
  for (const row of rows) {
    const username = String(row.username ?? '').trim()
    if (skipUsername(username, self)) continue
    counts.set(username, (counts.get(username) ?? 0) + Number(row.c ?? 0))
  }
  const names = loadNames(decryptedDir, [...counts.keys()])
  return [...counts.entries()]
    .map(([username, count]) => ({
      username,
      count,
      name: names.get(username)?.name || username,
      remark: names.get(username)?.remark ?? '',
    }))
    .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username))
}

function loadNames(decryptedDir: string, usernames: string[]): Map<string, { name: string; remark: string }> {
  const out = new Map<string, { name: string; remark: string }>()
  const dbPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(dbPath) || usernames.length === 0) return out
  const unique = [...new Set(usernames)].slice(0, 400)
  return withDb(dbPath, (db) => {
    const cols = tableColumns(db, 'contact')
    const userCol = cols.has('username') ? 'username' : cols.has('user_name') ? 'user_name' : ''
    if (userCol === '') return out
    const remarkCol = cols.has('remark') ? 'remark' : "''"
    const nickCol = cols.has('nick_name') ? 'nick_name' : cols.has('nickName') ? 'nickName' : "''"
    const placeholders = unique.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT ${userCol} AS username, ${remarkCol} AS remark, ${nickCol} AS nick FROM contact WHERE ${userCol} IN (${placeholders})`,
    ).all(...unique) as Array<{ username: string; remark: string; nick: string }>
    for (const row of rows) {
      const username = String(row.username ?? '').trim()
      const remark = String(row.remark ?? '').trim()
      const nick = String(row.nick ?? '').trim()
      if (username === '') continue
      out.set(username, { name: nick || remark || username, remark })
    }
    return out
  })
}

function circlesOf(people: readonly PersonRow[]): Array<{ key: string; names: string[]; total: number }> {
  const groups = new Map<string, PersonRow[]>()
  const claimed = new Set<string>()
  const add = (key: string, person: PersonRow): void => {
    const list = groups.get(key)
    if (list) list.push(person)
    else groups.set(key, [person])
  }
  for (const person of people) {
    const key = remarkClassKey(person.remark)
    if (key === '') continue
    add(key, person)
    claimed.add(person.username)
  }
  for (const person of people) {
    if (claimed.has(person.username)) continue
    const stem = remarkStem(person.remark)
    if (stem === '') continue
    add(stem, person)
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, CIRCLE_CAP)
    .map(([key, members]) => ({ key, total: members.length, names: members.slice(0, CIRCLE_NAMES).map(person => person.name) }))
}

/** 多级备注去掉最后一段。单段前缀（如「工商银行」）不在这里合并不同分行。 */
function remarkStem(remark: string): string {
  const parts = remark.trim().split(/[_—–\-|｜/／]+/).map(part => part.trim()).filter(part => part !== '')
  if (parts.length < 3) return ''
  parts.pop()
  const stem = parts.join('_')
  return stem.length >= 4 ? stem : ''
}

function matches(query: string, ...parts: string[]): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return parts.some(part => part.toLowerCase().includes(needle))
}

/** 最常联系的人，以及备注编号相同的圈子。 */
export const getSocialSummaryTool: RetrievalTool = {
  name: 'get_social_summary',
  category: 'contact',
  description:
    '给出社交圈摘要：按消息数列出最常联系的人，并把备注里同一编号的人收成圈子（如班级）。'
    + '适用于「我和谁最熟」「有哪些圈子/同班」。编号相同的备注、以及去掉姓名后仍有两级以上的备注前缀，会各自成圈。这是摘要，不是完整关系图，也不包含群成员和聊天原文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '可选。只保留名字、备注或圈子名里包含这个词的结果' },
      limit: { type: 'number', description: '最常联系的人最多返回几个（默认 12，上限 30）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const indexPath = searchIndexPath(ctx.decryptedDir)
    if (!existsSync(indexPath)) {
      return {
        tool: 'get_social_summary',
        ok: false,
        errorCode: 'not_configured',
        error: '检索索引不存在，还不能统计最常联系的人',
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    const query = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, PEOPLE_CAP)
    try {
      const self = resolveSelfUsername(ctx.decryptedDir)
      const ranked = loadPeople(ctx.decryptedDir, self)
      const people = ranked
        .filter(person => matches(query, person.name, person.remark, person.username))
        .slice(0, limit)
      const circles = circlesOf(ranked)
        .filter(circle => matches(query, circle.key, ...circle.names))
      const hits: ToolHit[] = [
        ...people.map(person => ({
          key: `social:person:${person.username}`,
          name: person.name,
          time: '',
          snippet: `${String(person.count)} 条消息${person.remark !== '' && person.remark !== person.name ? ` · 备注 ${person.remark}` : ''}`,
          source: 'agg' as const,
          score: person.count,
        })),
        ...circles.map(circle => ({
          key: `social:circle:${circle.key}`,
          name: circle.key,
          time: '',
          snippet: `${circle.names.join('、')}${circle.total > circle.names.length ? ' 等' : ''}，共 ${String(circle.total)} 人`,
          source: 'agg' as const,
        })),
      ]
      const facts = [
        people.length > 0
          ? { title: '最常联系', body: people.map(person => `${person.name} ${String(person.count)} 条`).join('；') }
          : undefined,
        circles.length > 0
          ? { title: '备注圈子', body: circles.map(circle => `${circle.key}（${circle.names.join('、')}）`).join('；') }
          : undefined,
      ].filter((fact): fact is { title: string; body: string } => fact !== undefined)
      return {
        tool: 'get_social_summary',
        ok: true,
        hits,
        ...(facts.length > 0 ? { facts } : {}),
        note: people.length === 0 && circles.length === 0
          ? '没有匹配的联系人或备注圈子'
          : `最常联系 ${String(people.length)} 人，备注圈子 ${String(circles.length)} 个`,
        elapsedMs: Date.now() - started,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        tool: 'get_social_summary',
        ok: false,
        errorCode: 'upstream_failure',
        error: message,
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
  },
}

export const SOCIAL_TOOLS: readonly RetrievalTool[] = [getSocialSummaryTool]
