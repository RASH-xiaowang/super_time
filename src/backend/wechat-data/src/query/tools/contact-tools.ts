/**
 * 联系人类检索工具（2026-10-16 新增，2026-11 补齐承诺）。
 *
 * 两个工具：
 *   · `search_contacts` —— 按名字/备注/拼音找**人**（「房东是谁」「有没有叫张三的」）；
 *   · `get_contact_detail` —— 取某个人的**详情**（备注/地区/共同群/互动统计）。
 *
 * 为什么「找人」必须独立成工具：聊天记录里搜「房东」只能搜到**提到房东的消息**，
 * 而用户问「房东的微信号是多少」要的是**联系人档案**。改造前两者混在一条检索里，
 * 于是模型只能答「聊天记录里没找到微信号」—— 而通讯录里其实有。
 *
 * 2026-11 的补齐点：`get_contact_detail` 的描述此前承诺了「标签、共同群、最近互动」，
 * 实现却只读 contact 行 + 消息数 —— 描述与能力不一致。本次：
 *   · 共同群 / 资金往来复用 `queryContact360`；
 *   · 地区/性别从 `contact.extra_buffer` 解码（与通讯录面板同一套 `region.ts`）；
 *   · **标签不补**：本机 contact.db 只有 `contact_label`（标签定义表），
 *     `contact` 表没有标签列，也没有联系人↔标签的映射表（2026-11 用本机真实库核实）。
 *     拿不到映射就不编造，把描述改成实际能力。
 *
 * @module query/tools/contact-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withDb, type DatabaseSync } from '../db-open.ts'
import { queryContact360 } from '../contact360.ts'
import { contactCategoryOf } from '../contacts.ts'
import { searchMembers } from '../members.ts'
import {
  enterpriseNameFromExtra,
  isEnterpriseWechatUser,
  loadOpenimWordingNames,
} from '../openim.ts'
import { searchIndexPath } from '../search-scaffold.ts'
import { messageTableHash, messageTableName, resolveTalkerUsername } from '../message-identity.ts'
import { readableProfileSignature } from '../profile-signature.ts'
import { buildRegion, cellText, parseContactExtra } from '../region.ts'
import { argInt, argString, type RetrievalTool, type ToolResult } from './types.ts'

/** 列名白名单：SQL 标识符只能来自代码常量，不能拼接用户输入。 */
function tableColumns(db: DatabaseSync, table: 'contact'): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(row => row.name))
  } catch {
    return new Set()
  }
}

/** BLOB/TEXT → Buffer（contact.extra_buffer 在不同 Node/sqlite 版本下类型不同）。 */
function extraBufferOf(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string' && value.length > 0) return Buffer.from(value, 'utf8')
  return Buffer.alloc(0)
}

/** 从 extra_buffer 解出地区与性别（口径与通讯录面板一致）。 */
function decodeExtra(value: unknown): { region: string; gender?: number } {
  const raw = extraBufferOf(value)
  if (raw.length === 0) return { region: '' }
  const extra = parseContactExtra(raw)
  const region = buildRegion(extra.country ?? '', extra.province ?? '', extra.city ?? '').trim()
  // 只接受微信写过的 1/2；0 与其它值都是「未知」，不要当成第三种性别。
  const gender = extra.gender === 1 || extra.gender === 2 ? extra.gender : undefined
  return { region, ...(gender === undefined ? {} : { gender }) }
}

/** extra_buffer 里除了地区/性别，还可能有企业微信的 wording id。 */
function enterpriseNameOf(username: string, value: unknown, wordingNames: ReadonlyMap<string, string>): string {
  if (!isEnterpriseWechatUser(username)) return ''
  return enterpriseNameFromExtra(value, wordingNames) ?? ''
}

/** search_contacts 命中的 contact 行补充信息（searchMembers 本身不返回备注/地区）。 */
interface ContactEnrichment {
  remark: string
  nick: string
  alias: string
  localType: number
  deleteFlag: number
  region: string
  gender?: number
  enterpriseName: string
}

/**
 * 按 username 批量补 contact 行。
 *
 * 为什么不直接用 `searchMembers` 的返回：它走 FTS 时只 select name/username/alias/enterprise，
 * 走 LIKE 时也不 select `extra_buffer` —— 地区在两条路径上都拿不到。
 * 这里用一条 `IN (...)` 查询补齐，参数绑定，不逐条打开连接。
 * @param decryptedDir - 已解密数据根。
 * @param usernames - 需要补齐的联系人 username。
 * @returns username → 补充信息。
 */
function readEnrichment(decryptedDir: string, usernames: string[]): Map<string, ContactEnrichment> {
  const out = new Map<string, ContactEnrichment>()
  const unique = [...new Set(usernames.filter(name => name !== ''))]
  if (unique.length === 0) return out
  const dbPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(dbPath)) return out
  try {
    return withDb(dbPath, (db) => {
      const cols = tableColumns(db, 'contact')
      if (!cols.has('username')) return out
      const sel = (col: string, fallback = "''"): string => (cols.has(col) ? col : fallback)
      const wordingNames = loadOpenimWordingNames(db)
      const rows = db.prepare(
        `SELECT ${sel('username')} AS username, ${sel('remark')} AS remark, ${sel('nick_name')} AS nick,
                ${sel('alias')} AS alias, ${sel('local_type', '0')} AS ltype,
                ${sel('delete_flag', '0')} AS dflag, ${sel('extra_buffer', 'NULL')} AS eb
         FROM contact WHERE username IN (${unique.map(() => '?').join(', ')})`,
      ).all(...unique) as Array<Record<string, unknown>>
      for (const row of rows) {
        const username = cellText(row['username']).trim()
        if (!username) continue
        const { region, ...gender } = decodeExtra(row['eb'])
        out.set(username, {
          remark: cellText(row['remark']).trim(),
          nick: cellText(row['nick']).trim(),
          alias: cellText(row['alias']).trim(),
          localType: Number(row['ltype'] ?? 0),
          deleteFlag: Number(row['dflag'] ?? 0),
          region,
          ...gender,
          enterpriseName: enterpriseNameOf(username, row['eb'], wordingNames),
        })
      }
      return out
    })
  } catch {
    // 通讯录库读不到时仍保留 searchMembers 的原始命中（只是没有备注/地区）。
    return out
  }
}

/** `kind` 参数的有效值（未知值按 all 处理，不报错也不猜）。 */
type ContactKind = 'all' | 'person' | 'group' | 'enterprise'

/** 把不可信的 kind 参数收敛到枚举。 */
function parseKind(value: unknown): ContactKind {
  const kind = argString(value).trim().toLowerCase()
  return kind === 'person' || kind === 'group' || kind === 'enterprise' ? kind : 'all'
}

/**
 * 联系人检索（复用成员搜索，自动兼容 contact_fts 新旧 schema 与 LIKE 降级）。
 *
 * 新增的 `region` / `enterprise` / `kind` 都是**后置过滤**：搜索仍然由
 * `searchMembers` 完成（它负责拼音/FTS/降级），过滤只作用于已命中的联系人。
 * 带过滤时多取一些再筛（最多 200），避免「前 20 条恰好没有目标地区」导致
 * 明明有结果却返回空。
 */
export const searchContactsTool: RetrievalTool = {
  name: 'search_contacts',
  category: 'contact',
  description:
    '在**通讯录**里按名字、备注或拼音检索联系人（返回 username、显示名、备注、地区、企业）。'
    + '适用于「X 是谁」「有没有叫 X 的人」「X 的微信号/备注」「深圳的客户有哪些」这类问题。'
    + '可用 region / enterprise / kind 过滤地区、企业和类别。'
    + '注意：它查的是**联系人档案**，不是聊天记录 —— 问「X 说过什么」请用 search_messages。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '名字 / 备注 / 拼音（支持全拼与首字母）' },
      limit: { type: 'number', description: '最多返回几个（默认 20，上限 100）' },
      region: { type: 'string', description: '按地区过滤（包含匹配，如「深圳」）' },
      enterprise: { type: 'string', description: '按企业微信的企业名称过滤（包含匹配）' },
      kind: {
        type: 'string',
        enum: ['all', 'person', 'group', 'enterprise'],
        description: '类别过滤：all=全部（默认）、person=个人联系人、group=群聊、enterprise=企业微信联系人',
      },
    },
    required: ['query'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    if (!q) {
      return {
        tool: 'search_contacts', ok: false, errorCode: 'invalid_arguments',
        error: '缺少 query', hits: [], elapsedMs: Date.now() - started,
      }
    }
    const limit = argInt(args['limit'], 20, 1, 100)
    const regionFilter = argString(args['region']).trim()
    const enterpriseFilter = argString(args['enterprise']).trim()
    const kind = parseKind(args['kind'])
    const filtered = regionFilter !== '' || enterpriseFilter !== '' || kind !== 'all'
    // 缺库与「没找到人」必须区分：前者是数据没准备好，不该被当成「通讯录没人」。
    if (!existsSync(join(ctx.decryptedDir, 'contact', 'contact.db'))) {
      return {
        tool: 'search_contacts', ok: false, errorCode: 'not_configured',
        error: '通讯录库不存在（contact.db），请先同步微信数据', hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    try {
      const cap = filtered ? Math.min(Math.max(limit * 5, 50), 200) : limit
      const snapshot = searchMembers(ctx.decryptedDir, q, { limit: cap })
      const enrichment = readEnrichment(ctx.decryptedDir, snapshot.items.map(hit => hit.username))
      const lowerRegion = regionFilter.toLocaleLowerCase()
      const lowerEnterprise = enterpriseFilter.toLocaleLowerCase()
      const hits = []
      for (const item of snapshot.items) {
        const meta = enrichment.get(item.username)
        const region = (meta?.region ?? item.region ?? '').trim()
        const enterpriseName = (meta?.enterpriseName || item.enterpriseName || '').trim()
        // 类别口径与通讯录面板共用 `contactCategoryOf`，避免同一账号两处分类不一致。
        const category = meta
          ? contactCategoryOf(meta.localType, item.username, meta.deleteFlag)
          : (item.username.endsWith('@chatroom') ? 'group' : 'member')
        if (regionFilter !== '' && !region.toLocaleLowerCase().includes(lowerRegion)) continue
        if (enterpriseFilter !== '' && !enterpriseName.toLocaleLowerCase().includes(lowerEnterprise)) continue
        if (kind === 'group' && category !== 'group') continue
        if (kind === 'enterprise' && category !== 'enterprise') continue
        if (kind === 'person' && category !== 'friend' && category !== 'member') continue

        const display = (item.name || item.username).trim()
        const snippet = [
          `显示名：${display}`,
          meta?.remark ? `备注：${meta.remark}` : '',
          meta?.nick ? `昵称：${meta.nick}` : '',
          region ? `地区：${region}` : '',
          enterpriseName ? `企业名称：${enterpriseName}` : '',
          `username：${item.username}`,
        ].filter(Boolean).join(' · ')
        hits.push({
          key: item.username,
          name: display,
          ...(enterpriseName ? { enterpriseName } : {}),
          time: '',
          snippet,
          source: 'msg' as const,
        })
        if (hits.length >= limit) break
      }
      const filters = [
        regionFilter ? `地区 ${regionFilter}` : '',
        enterpriseFilter ? `企业 ${enterpriseFilter}` : '',
        kind !== 'all' ? `类别 ${kind}` : '',
      ].filter(Boolean)
      return {
        tool: 'search_contacts', ok: true, hits,
        note: `「${q}」→ ${hits.length} 个联系人${filters.length > 0 ? `（${filters.join(' · ')}）` : ''}`,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return {
        tool: 'search_contacts', ok: false, errorCode: 'upstream_failure',
        error: (e as Error).message, hits: [], elapsedMs: Date.now() - started,
      }
    }
  },
}

/** `get_contact_detail` 可选的返回分区。 */
const CONTACT_INCLUDES = ['profile', 'stats', 'region', 'groups', 'funds'] as const
type ContactInclude = typeof CONTACT_INCLUDES[number]

/**
 * 解析 `include` 数组：缺省=全开；显式数组=只取认识的项（未知值忽略）。
 *
 * 一个认识的值都没有时（模型传 `[]` 或拼错）按「未指定」处理：
 * 返回空 snippet 比返回全量更容易被误读成「这个人没有任何资料」。
 */
function parseIncludes(value: unknown): Set<ContactInclude> {
  const all = new Set<ContactInclude>(CONTACT_INCLUDES)
  if (!Array.isArray(value)) return all
  const known = new Set<string>(CONTACT_INCLUDES)
  const requested = new Set<ContactInclude>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const key = item.trim().toLowerCase()
    if (known.has(key)) requested.add(key as ContactInclude)
  }
  return requested.size > 0 ? requested : all
}

/** 性别码 → 中文（未知不给标签）。 */
function genderLabel(gender: number | undefined): string {
  if (gender === 1) return '男'
  if (gender === 2) return '女'
  return ''
}

/**
 * 联系人详情（备注/地区/共同群/互动统计/资金往来）。
 *
 * 描述不再承诺「标签」：本机 contact.db 只有标签定义表（contact_label），
 * `contact` 没有标签列，也没有联系人↔标签映射 —— 编造一个永远为空的
 * 「标签」字段只会让模型答「没有标签」，而用户以为数据丢了。
 */
export const getContactDetailTool: RetrievalTool = {
  name: 'get_contact_detail',
  category: 'contact',
  description:
    '取某个联系人的**档案详情**：备注、昵称、微信号、地区、性别、共同群、聊天统计与资金往来。'
    + '适用于「X 的微信号是多少」「我和 X 有哪些共同群」「X 最近跟我聊过吗」。'
    + '参数用 search_contacts 返回的 username；include 可只取其中几类（profile/stats/region/groups/funds）。'
    + '注意：本机通讯录没有标签数据（contact_label 只有标签定义、没有联系人映射），不要向用户承诺联系人标签。',
  parameters: {
    type: 'object',
    properties: {
      username: { type: 'string', description: '联系人标识（wxid_xxx 或 xxx@chatroom）' },
      include: {
        type: 'array',
        items: { type: 'string', enum: [...CONTACT_INCLUDES] },
        description: '要返回的分区：profile=档案、stats=聊天统计、region=地区/性别、groups=共同群、funds=资金往来；默认全开',
      },
    },
    required: ['username'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const requestedUsername = argString(args['username']).trim()
    if (!requestedUsername) {
      return {
        tool: 'get_contact_detail', ok: false, errorCode: 'invalid_arguments',
        error: '缺少 username', hits: [], elapsedMs: Date.now() - started,
      }
    }
    const include = parseIncludes(args['include'])
    // 注意：这里刻意不读 ctx.scope.username —— 本工具没有 username 范围内的
    // 「会话锁定」语义，注入一个会话 username 会把联系人档案查错人。
    const username = resolveTalkerUsername(ctx.decryptedDir, requestedUsername)
    if (!username) {
      return {
        tool: 'get_contact_detail', ok: false, errorCode: 'invalid_arguments',
        error: '无法解析联系人身份', hits: [], elapsedMs: Date.now() - started,
      }
    }
    const p = join(ctx.decryptedDir, 'contact', 'contact.db')
    if (!existsSync(p)) {
      return {
        tool: 'get_contact_detail', ok: false, errorCode: 'not_configured',
        error: '通讯录库不存在（contact.db），请先同步微信数据', hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    try {
      const row = withDb(p, (db) => {
        const cols = tableColumns(db, 'contact')
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
      if (!row) {
        return {
          tool: 'get_contact_detail', ok: false, errorCode: 'invalid_arguments',
          error: '通讯录里没有这个人', hits: [], elapsedMs: Date.now() - started,
        }
      }

      // 共同群/资金往来来自 360° 档案；只在真的需要时才跑（它要扫消息分片）。
      const wantGroups = include.has('groups')
      const wantFunds = include.has('funds')
      let profile360: ReturnType<typeof queryContact360> | undefined
      if (wantGroups || wantFunds) {
        try {
          profile360 = queryContact360(ctx.decryptedDir, username)
        } catch {
          // 360° 读不到时降级：档案主体照常返回，缺的分区在正文里如实写「无」。
          profile360 = undefined
        }
      }

      // 消息数/最近互动仍走检索索引（快）；索引读不到就不显示，不伪造 0 条以外的结论。
      let recent = ''
      let msgCount = 0
      if (include.has('stats')) {
        const ip = searchIndexPath(ctx.decryptedDir)
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
      }

      const name = (row.remark || row.nick || row.username).trim()
      const signature = readableProfileSignature(row.descr)
      const { region, gender } = decodeExtra(row.extra_buffer)
      const commonGroups = profile360?.commonGroups ?? []
      const funds = profile360?.funds
      const lines = [
        include.has('profile') ? `显示名：${name}` : '',
        include.has('profile') && row.remark ? `备注：${row.remark}` : '',
        include.has('profile') && row.nick ? `昵称：${row.nick}` : '',
        include.has('profile') && row.alias ? `微信号：${row.alias}` : '',
        include.has('profile') && signature ? `签名：${signature}` : '',
        include.has('profile') && row.enterpriseName ? `企业名称：${row.enterpriseName}` : '',
        include.has('profile') ? `username：${row.username}` : '',
        include.has('region') && region ? `地区：${region}` : '',
        include.has('region') && genderLabel(gender) ? `性别：${genderLabel(gender)}` : '',
        wantGroups
          ? commonGroups.length > 0
            // queryContact360 已把共同群限制在 10 个以内。
            // 只列群名：它的 memberCount 是该成员在 room 里的行数（恒为 1），
            // 不是群总人数，展示出来会误导「这个群只有 1 人」。
            ? `共同群（${commonGroups.length}）：${commonGroups.map(group => group.name).join('、')}`
            : '共同群：无'
          : '',
        include.has('stats')
          ? msgCount > 0
            ? `聊天记录：${msgCount} 条${recent ? `，最近 ${recent}` : ''}`
            : '聊天记录：无'
          : '',
        wantFunds
          ? `资金往来：转账 ${funds?.transfers ?? 0} 笔、红包 ${funds?.redpackets ?? 0} 笔`
          : '',
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
      return {
        tool: 'get_contact_detail', ok: false, errorCode: 'upstream_failure',
        error: (e as Error).message, hits: [], elapsedMs: Date.now() - started,
      }
    }
  },
}

/** 联系人类工具集。 */
export const CONTACT_TOOLS: readonly RetrievalTool[] = [searchContactsTool, getContactDetailTool]
