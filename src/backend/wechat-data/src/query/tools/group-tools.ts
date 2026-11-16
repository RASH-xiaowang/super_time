/**
 * 群资料检索工具（2026-11 新增）。
 *
 * `get_group_detail` 回答的是「这个群是什么、谁在里面、活跃度如何」——
 * 这些问题需要的是一条**群档案**，而不是聊天记录里的片段：
 *   · `search_messages` 能搜到「提到项目群的消息」，但答不了「群主是谁、多少人」；
 *   · `aggregate_messages` 能数消息，但答不了公告、成员列表。
 *
 * 所以这里把它做成独立工具，复用面板已有的三条只读链路：
 *   · `queryGroupInfo` —— 群名/群主/成员/公告（contact.db）；
 *   · `queryGroupInsights` —— 总量/活跃天数/TOP 成员（message 分片）；
 *   · `searchMembers` / `contactMeta` —— 把用户给的群名解析成 `@chatroom`。
 *
 * 为什么 `hits` 恒为空：群资料不是「某条消息」，没有 `username:local_id` 定位，
 * 硬造一个 locator 会让引用卡片指向不存在的位置。结论全部放 `facts`。
 *
 * @module query/tools/group-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { withDb, type DatabaseSync } from '../db-open.ts'
import { queryGroupInfo } from '../group-info.ts'
import { queryGroupInsights } from '../group-insights.ts'
import { searchMembers } from '../members.ts'
import { contactMeta } from '../meta.ts'
import { cellText } from '../region.ts'
import { argInt, argString, type RetrievalTool, type ToolResult } from './types.ts'

/** 群聊 username 的稳定判据（大小写按微信实际值兜底）。 */
function isChatroomUsername(value: string): boolean {
  return /@chatroom$/i.test(value.trim())
}

/** 候选群（用于歧义时让用户/模型指定完整 `@chatroom`）。 */
interface GroupCandidate {
  username: string
  name: string
}

type GroupResolution =
  | { ok: true; username: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: GroupCandidate[] }

/** 列名白名单：SQL 里的标识符只能来自这里，不能拼接用户输入。 */
function tableColumns(db: DatabaseSync, table: 'contact'): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map(row => row.name))
  } catch {
    return new Set()
  }
}

/** 同一 username 只保留一条候选（LIKE 可能因多条命中重复）。 */
function dedupeCandidates(rows: GroupCandidate[]): GroupCandidate[] {
  const seen = new Set<string>()
  const out: GroupCandidate[] = []
  for (const row of rows) {
    if (!row.username || seen.has(row.username)) continue
    seen.add(row.username)
    out.push(row)
  }
  return out
}

/**
 * 把「群名」解析成群 `@chatroom`。
 *
 * 顺序刻意分成两步：
 *   ① 精确匹配 contact.remark / nick_name —— 用户说「项目群」时，
 *      同名的另一个「项目群（2）」不应把它挤成歧义；
 *   ② 精确匹配不到才交给 `searchMembers`（支持部分名称/拼音/别名），
 *      仍然多于一个就如实报歧义，而不是随便挑一个（挑错群比报错更难发现）。
 *
 * 只读：SQL 用参数绑定，列名白名单取自 `PRAGMA table_info`。
 * @param decryptedDir - 已解密数据根。
 * @param raw - 用户给的群名或 `@chatroom`。
 * @returns 解析结果（歧义时候选列表）。
 */
function resolveGroupUsername(decryptedDir: string, raw: string): GroupResolution {
  // 用户直接给了 `@chatroom`：这是最精确的标识，不再做名称匹配。
  if (isChatroomUsername(raw)) return { ok: true, username: raw.trim() }

  const dbPath = join(decryptedDir, 'contact', 'contact.db')
  if (existsSync(dbPath)) {
    try {
      const exact = withDb(dbPath, (db) => {
        const cols = tableColumns(db, 'contact')
        if (!cols.has('username')) return [] as GroupCandidate[]
        // 动态列名只从这两列白名单里取；缺列的老快照自动跳过。
        const nameCols = ['remark', 'nick_name'].filter(col => cols.has(col))
        if (nameCols.length === 0) return [] as GroupCandidate[]
        const rows = db.prepare(
          `SELECT username, remark, nick_name FROM contact ` +
          `WHERE username LIKE '%@chatroom' AND (${nameCols.map(col => `${col} = ?`).join(' OR ')}) LIMIT 50`,
        ).all(...nameCols.map(() => raw)) as Array<Record<string, unknown>>
        return rows.map(row => ({
          username: cellText(row['username']).trim(),
          name: cellText(row['remark']).trim() || cellText(row['nick_name']).trim() || cellText(row['username']).trim(),
        }))
      })
      const exactCandidates = dedupeCandidates(exact)
      if (exactCandidates.length === 1) return { ok: true, username: exactCandidates[0]!.username }
      if (exactCandidates.length > 1) return { ok: false, reason: 'ambiguous', candidates: exactCandidates }
    } catch {
      // 库损坏/缺表时不让工具抛错：继续走下面的模糊解析（失败会统一报 not_found）。
    }
  }

  // 精确匹配落空：用现有的成员搜索做模糊/拼音解析，只保留群聊。
  try {
    const snapshot = searchMembers(decryptedDir, raw, { limit: 50 })
    const fuzzy = dedupeCandidates(
      snapshot.items
        .filter(hit => isChatroomUsername(hit.username))
        .map(hit => ({ username: hit.username, name: hit.name.trim() || hit.username })),
    )
    if (fuzzy.length === 1) return { ok: true, username: fuzzy[0]!.username }
    if (fuzzy.length > 1) return { ok: false, reason: 'ambiguous', candidates: fuzzy }
  } catch {
    // 搜索索引不可用不应该把「按名字找群」变成抛错；下面统一返回 not_found。
  }
  return { ok: false, reason: 'not_found', candidates: [] }
}

/** 秒级时间戳 → `YYYY-MM-DD HH:mm`（本地时区，与界面口径一致）。 */
function ymdhm(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 秒级时间戳 → `YYYY-MM-DD`。 */
function ymd(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 群资料与活跃度。
 *
 * 返回 `hits: []`：群资料没有消息定位；`facts` 固定包含「群资料」与「群活跃」两条，
 * `includeActivity=false` 时后者如实写「未统计」而不是假装 0。
 */
export const getGroupDetailTool: RetrievalTool = {
  name: 'get_group_detail',
  category: 'contact',
  description:
    '查群资料与活跃度：群主、公告、成员数/成员列表、消息总量、活跃天数、TOP 成员。'
    + '适用于「X 群是谁建的」「群里有多少人」「这个群活跃吗」这类问题。'
    + '参数 group 可以填群名（部分名称/拼音也行）或完整的 `@chatroom`；'
    + '不用于群消息原文（请用 search_messages）或单聊档案（请用 get_contact_detail）。',
  parameters: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        description: '群名（支持部分名称/拼音）或完整的 `@chatroom` 群标识',
      },
      membersLimit: {
        type: 'number',
        description: '成员列表最多列出几个（默认 50，上限 200）',
      },
      topMembers: {
        type: 'number',
        description: '活跃榜取前几名（默认 10，上限 30；本机洞察最多统计 10 位）',
      },
      includeActivity: {
        type: 'boolean',
        description: '是否统计消息总量/活跃天数/TOP 成员（默认 true；false 可跳过全量消息扫描）',
      },
    },
    required: ['group'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const raw = argString(args['group']).trim()
    if (!raw) {
      return {
        tool: 'get_group_detail', ok: false, errorCode: 'invalid_arguments',
        error: '缺少 group（群名或 @chatroom）', hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    const membersLimit = argInt(args['membersLimit'], 50, 1, 200)
    const topMembers = argInt(args['topMembers'], 10, 1, 30)
    // 只有显式 false（布尔 / 字符串 / 0）才跳过；缺省/null/畸形值按默认 true。
    const activityArg = args['includeActivity']
    const includeActivity = !(
      activityArg === false
      || activityArg === 0
      || (typeof activityArg === 'string' && activityArg.trim().toLowerCase() === 'false')
    )

    // 缺 contact.db 与「查不到群」是两件事：前者是数据没准备好，后者是名字不对。
    if (!existsSync(join(ctx.decryptedDir, 'contact', 'contact.db'))) {
      return {
        tool: 'get_group_detail', ok: false, errorCode: 'not_configured',
        error: '通讯录库不存在（contact.db），请先同步微信数据', hits: [],
        elapsedMs: Date.now() - started,
      }
    }

    const resolved = resolveGroupUsername(ctx.decryptedDir, raw)
    if (!resolved.ok) {
      if (resolved.reason === 'ambiguous') {
        const listed = resolved.candidates
          .map(candidate => `${candidate.name}（${candidate.username}）`)
          .join('、')
        return {
          tool: 'get_group_detail', ok: false, errorCode: 'invalid_arguments',
          error: `群名「${raw}」匹配到 ${resolved.candidates.length} 个群，请用完整 @chatroom 指定：${listed}`,
          errorDetails: { candidates: resolved.candidates },
          hits: [], elapsedMs: Date.now() - started,
        }
      }
      return {
        tool: 'get_group_detail', ok: false, errorCode: 'invalid_arguments',
        error: `找不到群「${raw}」（本机通讯录中没有匹配的群聊）`,
        hits: [], elapsedMs: Date.now() - started,
      }
    }

    let snapshot
    try {
      snapshot = queryGroupInfo(ctx.decryptedDir, resolved.username)
    } catch (e) {
      return {
        tool: 'get_group_detail', ok: false, errorCode: 'upstream_failure',
        error: `读取群资料失败：${(e as Error).message}`, hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    const group = snapshot.group
    if (!group) {
      // 解析到了 username 但 contact 行不存在（可能是刚退群/数据不完整）。
      return {
        tool: 'get_group_detail', ok: false, errorCode: 'invalid_arguments',
        error: `找不到群「${raw}」（${resolved.username} 不在本机通讯录中）`,
        hits: [], elapsedMs: Date.now() - started,
      }
    }

    const ownerUsername = (group.owner ?? '').trim()
    // 群主在 contact 里通常有备注/昵称；解析不到时保留 username，不假装「未知」。
    const ownerName = ownerUsername
      ? (contactMeta(ctx.decryptedDir).names.get(ownerUsername)?.trim() || ownerUsername)
      : ''
    const displayName = group.remark || group.name

    const shownMembers = group.members.slice(0, membersLimit)
    const memberLine = shownMembers.length > 0
      ? `成员列表（${shownMembers.length}/${group.totalMembers}）：`
        + shownMembers.map(member => (member.isSelf ? `${member.name}（我）` : member.name)).join('、')
      : group.totalMembers > 0
        ? `成员列表：明细不可读（已知 ${group.totalMembers} 人）`
        : '成员列表：无（成员表不可读或空群）'

    const profileLines = [
      `群名：${displayName}`,
      group.remark && group.remark !== group.name ? `群昵称：${group.name}` : '',
      ownerUsername ? `群主：${ownerName}` : '群主：未知（chat_room 未记录）',
      `成员数：${group.totalMembers} 人`,
      `公告：${group.announcement || '无'}`,
      group.announcementTime ? `公告时间：${ymdhm(group.announcementTime)}` : '',
      memberLine,
    ].filter(Boolean)

    let activityBody: string
    let activityNote = ''
    if (includeActivity) {
      try {
        const insights = queryGroupInsights(ctx.decryptedDir, resolved.username)
        const top = insights.topMembers.slice(0, topMembers)
        const range = insights.from != null && insights.to != null
          ? `时间范围：${ymd(insights.from)} ~ ${ymd(insights.to)}`
          : ''
        activityBody = [
          `消息总量：${insights.total} 条`,
          `活跃天数：${insights.activeDays} 天`,
          `日均：${insights.avgPerDay > 0 ? insights.avgPerDay.toFixed(1) : '0'} 条/天`,
          range,
          top.length > 0
            ? `TOP 成员：${top.map(member => `${member.name} ${member.count} 条`).join('、')}`
            : 'TOP 成员：无（本机没有该群消息或消息里没有发送者前缀）',
          // 本机洞察算法固定只保留 10 位；要更多也没有，不要装作「只有这几位」。
          topMembers > 10 ? '说明：群洞察最多统计 10 位活跃成员' : '',
        ].filter(Boolean).join('\n')
        activityNote = ` · 消息 ${insights.total} 条 / 活跃 ${insights.activeDays} 天`
      } catch (e) {
        // 工具约定「不抛错」：活跃度读失败不影响群资料本身。
        activityBody = `未统计（活跃度读取失败：${(e as Error).message}）`
      }
    } else {
      activityBody = '未统计（includeActivity=false）'
    }

    return {
      tool: 'get_group_detail', ok: true,
      // 群资料不是消息：没有 locator 就不伪造 locator。
      hits: [],
      facts: [
        { title: '群资料', body: profileLines.join('\n') },
        { title: '群活跃', body: activityBody },
      ],
      note: `已解析「${raw}」→ ${displayName}（${resolved.username}）· 成员 ${group.totalMembers} 人${activityNote}`,
      elapsedMs: Date.now() - started,
    }
  },
}

/** 群资料类工具集。 */
export const GROUP_TOOLS: readonly RetrievalTool[] = [getGroupDetailTool]
