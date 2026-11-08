/**
 * 联系人类检索工具（2026-10-16 新增）。
 *
 * 两个工具：
 *   · `search_contacts` —— 按名字/备注/拼音找**人**（「房东是谁」「有没有叫张三的」）；
 *   · `get_contact_detail` —— 取某个人的**详情**（备注/标签/共同群/最近互动）。
 *
 * 为什么「找人」必须独立成工具：聊天记录里搜「房东」只能搜到**提到房东的消息**，
 * 而用户问「房东的微信号是多少」要的是**联系人档案**。改造前两者混在一条检索里，
 * 于是模型只能答「聊天记录里没找到微信号」—— 而通讯录里其实有。
 *
 * @module query/tools/contact-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withDb } from '../db-open.ts'
import { searchMembers } from '../members.ts'
import {
  enterpriseNameFromExtra,
  isEnterpriseWechatUser,
  loadOpenimWordingNames,
} from '../openim.ts'
import { searchIndexPath } from '../search-scaffold.ts'
import { messageTableHash, messageTableName, resolveTalkerUsername } from '../message-identity.ts'
import { readableProfileSignature } from '../profile-signature.ts'
import { argInt, argString, type RetrievalTool, type ToolResult } from './types.ts'

/** 联系人检索（复用成员搜索，自动兼容 contact_fts 新旧 schema 与 LIKE 降级）。 */
export const searchContactsTool: RetrievalTool = {
  name: 'search_contacts',
  category: 'contact',
  description:
    '在**通讯录**里按名字、备注或拼音检索联系人（返回 username 与显示名）。'
    + '适用于「X 是谁」「有没有叫 X 的人」「X 的微信号/备注」这类问题。'
    + '注意：它查的是**联系人档案**，不是聊天记录 —— 问「X 说过什么」请用 search_messages。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '名字 / 备注 / 拼音（支持全拼与首字母）' },
      limit: { type: 'number', description: '最多返回几个（默认 20，上限 100）' },
    },
    required: ['query'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    if (!q) return { tool: 'search_contacts', ok: false, error: '缺少 query', hits: [] }
    const limit = argInt(args['limit'], 20, 1, 100)
    try {
      const snapshot = searchMembers(ctx.decryptedDir, q, { limit })
      const hits = snapshot.items.map(r => ({
        key: r.username,
        name: (r.name || r.username).trim(),
        ...(r.enterpriseName ? { enterpriseName: r.enterpriseName } : {}),
        time: '',
        snippet: [
          r.name ? `显示名：${r.name}` : '',
          r.enterpriseName ? `企业名称：${r.enterpriseName}` : '',
          `username：${r.username}`,
        ].filter(Boolean).join(' · '),
        source: 'msg' as const,
      }))
      return {
        tool: 'search_contacts', ok: true, hits,
        note: `「${q}」→ ${hits.length} 个联系人`,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return { tool: 'search_contacts', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 联系人详情（备注/标签/共同群/最近互动）。 */
export const getContactDetailTool: RetrievalTool = {
  name: 'get_contact_detail',
  category: 'contact',
  description:
    '取某个联系人的**档案详情**：备注、昵称、微信号、标签、共同群、最近互动时间。'
    + '适用于「X 的微信号是多少」「我和 X 有哪些共同群」「X 最近跟我聊过吗」。'
    + '参数用 search_contacts 返回的 username。',
  parameters: {
    type: 'object',
    properties: {
      username: { type: 'string', description: '联系人标识（wxid_xxx 或 xxx@chatroom）' },
    },
    required: ['username'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const requestedUsername = argString(args['username']).trim()
    if (!requestedUsername) return { tool: 'get_contact_detail', ok: false, error: '缺少 username', hits: [] }
    const username = resolveTalkerUsername(ctx.decryptedDir, requestedUsername)
    if (!username) return { tool: 'get_contact_detail', ok: false, error: '无法解析联系人身份', hits: [] }
    const p = join(ctx.decryptedDir, 'contact', 'contact.db')
    if (!existsSync(p)) return { tool: 'get_contact_detail', ok: false, error: '通讯录库不存在', hits: [] }
    try {
      const row = withDb(p, (db) => {
        const cols = new Set((db.prepare('PRAGMA table_info(contact)').all() as Array<{ name: string }>).map(c => c.name))
        const sel = (c: string, fallback = "''"): string => (cols.has(c) ? c : fallback)
        const data = db.prepare(
          `SELECT ${sel('username')} AS username, ${sel('alias')} AS alias, ${sel('remark')} AS remark,
                  ${sel('nick_name')} AS nick, ${sel('description')} AS descr, ${sel('local_type')} AS ltype,
                  ${sel('extra_buffer', 'NULL')} AS extra_buffer
           FROM contact WHERE username = ? LIMIT 1`,
        ).get(username) as {
          username: string
          alias: string
          remark: string
          nick: string
          descr: string
          ltype: number
          extra_buffer: unknown
        } | undefined
        if (!data) return undefined
        const enterpriseName = isEnterpriseWechatUser(data.username)
          ? enterpriseNameFromExtra(data.extra_buffer, loadOpenimWordingNames(db))
          : undefined
        return { ...data, enterpriseName }
      })
      if (!row) return { tool: 'get_contact_detail', ok: false, error: '通讯录里没有这个人', hits: [] }

      // 共同群 + 最近互动：从索引库取（它带 username 与时间）。
      const ip = searchIndexPath(ctx.decryptedDir)
      let recent = ''
      let msgCount = 0
      if (existsSync(ip)) {
        try {
          const aliases = [...new Set([
            requestedUsername,
            username,
            messageTableHash(username),
            messageTableName(username),
          ])]
          const r = withDb(ip, (db) => db.prepare(
            `SELECT COUNT(*) AS c, MAX(create_time) AS mx FROM message_meta WHERE username IN (${aliases.map(() => '?').join(', ')})`,
          ).get(...aliases) as { c?: number; mx?: number } | undefined)
          msgCount = Number(r?.c ?? 0)
          if (r?.mx) recent = new Date(Number(r.mx) * 1000).toISOString().slice(0, 16).replace('T', ' ')
        } catch { /* 索引读不到就不显示 */ }
      }

      const name = (row.remark || row.nick || row.username).trim()
      const signature = readableProfileSignature(row.descr)
      const lines = [
        `显示名：${name}`,
        row.enterpriseName ? `企业名称：${row.enterpriseName}` : '',
        row.remark && row.nick && row.remark !== row.nick ? `昵称：${row.nick}` : '',
        row.alias ? `微信号：${row.alias}` : '',
        signature ? `签名：${signature}` : '',
        `username：${row.username}`,
        msgCount > 0 ? `聊天记录：${msgCount} 条${recent ? `，最近 ${recent}` : ''}` : '聊天记录：无',
      ].filter(Boolean)
      return {
        tool: 'get_contact_detail', ok: true,
        hits: [{
          key: username,
          name,
          ...(row.enterpriseName ? { enterpriseName: row.enterpriseName } : {}),
          time: recent,
          snippet: lines.join('\n'),
          source: 'msg',
        }],
        note: `${name}${row.enterpriseName ? `（${row.enterpriseName}）` : ''} 的档案`,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return { tool: 'get_contact_detail', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 联系人类工具集。 */
export const CONTACT_TOOLS: readonly RetrievalTool[] = [searchContactsTool, getContactDetailTool]
