/**
 * 朋友圈统计工具（2026-11-13 新增）。
 *
 * ## 为什么不是 `search_moments`
 *
 * `search_moments` 是**找具体某条动态**（按配文检索）；而「我今年发了多少条」
 * 「谁给我点赞最多」「哪个月发得最多」的答案不在任何一条帖子里 —— 需要
 * COUNT / GROUP BY。把统计单独做成工具，模型才不会拿几条片段去「数」。
 *
 * ## 区间口径必须说清楚
 *
 * `queryMomentsInsights` 只接受作者、**不接受日期**。所以：
 *   · 不传 `from/to` → 直接用洞察快照（全量），标题写「全量」；
 *   · 传了 `from/to` → 用 `queryMoments` 分页扫描并在本地按时间过滤；
 *   · 恰好是完整自然年且未限作者 → 再用 `queryAnnualMoments` 的全年口径补强
 *     发布数与月度峰值（该模块会完整扫完，不受分页预算影响）。
 * 任何被扫描预算截断的结果都会在 `note` 里说明「仅扫描前 N 条」，不伪装成全量。
 *
 * ## 没有 `sns.db` 不是「0 条动态」
 *
 * 库缺失通常是「还没解密/没配置」，必须返回 `not_configured`，让界面提示
 * 「朋友圈库不存在（可能未解密）」。这与「今年真的没发朋友圈」是两件事。
 *
 * @module query/tools/moments-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fmtDateTimeSec } from '../../format.ts'
import { resolveSelfUsername } from '../../config/resolve.ts'
import { contactMeta } from '../meta.ts'
import { displayNameForUsername } from '../message-identity.ts'
import { queryMoments, type MomentEntry } from '../moments.ts'
import { queryMomentsInsights } from '../moments-insights.ts'
import { queryAnnualMoments } from '../annual-moments.ts'
import { yieldToLoop } from '../search-build.ts'
import {
  argInt, argString,
  type RetrievalTool, type ToolHit, type ToolResult,
} from './types.ts'

/** 默认/上限 TOP 条数（同时用于排行榜与最近帖子）。 */
const DEFAULT_TOP = 10
const MAX_TOP = 30
/** 按时间区间扫描时每页取多少条（`queryMoments` 单页上限 500）。 */
const SCAN_PAGE = 500
/** 区间扫描的动态条数预算；超出后只能算「本次扫描」。 */
const SCAN_MAX_POSTS = 1000
/** 区间扫描的时间预算（毫秒）。 */
const SCAN_BUDGET_MS = 2500

/** 排行榜中的一行（已解析成显示名）。 */
interface TopRow {
  name: string
  count: number
}

/** 区间扫描的累计结果。 */
interface RangeStats {
  posts: number
  likes: number
  comments: number
  likers: Map<string, TopRow>
  commenters: Map<string, TopRow>
  monthly: Map<string, number>
  entries: MomentEntry[]
  scanned: number
  truncated: boolean
  reason: string
}

/** 作者参数的解析结果。 */
type AuthorLookup =
  | { status: 'none' }
  | { status: 'ok'; username: string; display: string }
  | { status: 'not-found'; value: string }
  | { status: 'error'; error: string; errorCode: 'invalid_arguments' | 'unsupported_scope' }

/** `sns.db` 是否存在（两条候选路径与 moments/annual 模块逐字一致）。 */
function snsDbExists(decryptedDir: string): boolean {
  return existsSync(join(decryptedDir, 'sns', 'db_sns', 'sns.db'))
    || existsSync(join(decryptedDir, 'sns', 'sns.db'))
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

/**
 * 判断 `from ~ to` 是否恰好覆盖一个完整自然年。
 * @returns 年份；不是完整自然年时返回 0。
 */
function fullYearOf(from: string, to: string): number {
  const start = /^(\d{4})-01-01$/.exec(from.trim())
  const end = /^(\d{4})-12-31$/.exec(to.trim())
  if (!start || !end || start[1] !== end[1]) return 0
  return Number(start[1])
}

/**
 * 把作者参数解析成 username。
 *
 * 支持：微信号原样、显示名（仅当联系人表里**唯一**）、以及「我/自己/本人」。
 * 显示名歧义时明确报错，绝不随便挑一个。
 */
function resolveAuthor(decryptedDir: string, raw: string): AuthorLookup {
  const value = raw.trim()
  if (value === '') return { status: 'none' }
  const meta = contactMeta(decryptedDir)
  const names = meta.names
  const self = resolveSelfUsername(decryptedDir).trim()

  if (value === '我' || value === '自己' || value === '本人') {
    if (self === '') {
      return { status: 'error', errorCode: 'unsupported_scope', error: '无法确定本人微信号，不能按「我」筛选朋友圈作者' }
    }
    return { status: 'ok', username: self, display: displayNameForUsername(self, names) }
  }
  // 已经是微信号形态：直接当 username（好友删了/不在联系人表也能查归档）。
  if (value.startsWith('wxid_') || value.startsWith('gh_') || value.includes('@')) {
    return { status: 'ok', username: value, display: displayNameForUsername(value, names) }
  }
  if (names.has(value)) {
    return { status: 'ok', username: value, display: displayNameForUsername(value, names) }
  }
  const matches: string[] = []
  for (const [username, name] of names) {
    if (name.trim() === value && username !== value) matches.push(username)
  }
  if (matches.length === 1) {
    const username = matches[0] ?? ''
    return { status: 'ok', username, display: displayNameForUsername(username, names) }
  }
  if (matches.length > 1) {
    return {
      status: 'error',
      errorCode: 'invalid_arguments',
      error: `作者显示名「${value}」对应多个联系人，请改用微信号`,
    }
  }
  return { status: 'not-found', value }
}

/** 往互动人聚合表里累加一次点赞/评论。 */
function addInteractor(
  map: Map<string, TopRow>,
  username: string,
  nickname: string,
  names: ReadonlyMap<string, string>,
): void {
  const key = username.trim() || nickname.trim() || '?'
  const current = map.get(key)
  if (current) {
    current.count += 1
    return
  }
  const name = nickname.trim() || (username.trim() !== '' ? displayNameForUsername(username, names) : '') || '未知'
  map.set(key, { name, count: 1 })
}

/** 按次数降序、名字升序取前 N（并列顺序固定，测试与界面都稳定）。 */
function topRows(map: ReadonlyMap<string, TopRow>, limit: number): TopRow[] {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/** 排行榜格式：`王五 32、李四 18`。 */
function formatTop(rows: readonly TopRow[]): string {
  return rows.map(row => `${row.name} ${row.count}`).join('、')
}

/**
 * 月度峰值：把跨年的 `YYYY-MM` 按**日历月份**合并，取条数最多的月份。
 *
 * 为什么跨年合并：用户问「哪个月发得最多」通常指 1-12 月里的某个月，
 * 而不是「2024-03」与「2025-03」各算一项。并列取更小的月份。
 */
function peakMonth(monthly: ReadonlyMap<string, number>): { month: number; count: number } | null {
  const byMonth = new Map<number, number>()
  for (const [key, count] of monthly) {
    const m = Number(key.slice(5, 7))
    if (!Number.isInteger(m) || m < 1 || m > 12) continue
    byMonth.set(m, (byMonth.get(m) ?? 0) + count)
  }
  let best: { month: number; count: number } | null = null
  for (const [month, count] of byMonth) {
    if (count <= 0) continue
    if (best === null || count > best.count) best = { month, count }
  }
  return best
}

/** 扫描按时间过滤的朋友圈：分页 + 行数/时间预算 + 取消信号。 */
async function scanMomentRange(
  decryptedDir: string,
  authorUsername: string,
  lo: number,
  hi: number,
  signal: AbortSignal | undefined,
  started: number,
): Promise<RangeStats> {
  const stats: RangeStats = {
    posts: 0,
    likes: 0,
    comments: 0,
    likers: new Map(),
    commenters: new Map(),
    monthly: new Map(),
    entries: [],
    scanned: 0,
    truncated: false,
    reason: '',
  }
  const names = contactMeta(decryptedDir).names
  let offset = 0
  let total = Number.POSITIVE_INFINITY

  while (offset < total && stats.scanned < SCAN_MAX_POSTS) {
    if (signal?.aborted) { stats.truncated = true; stats.reason = '已取消'; break }
    if (Date.now() - started > SCAN_BUDGET_MS) { stats.truncated = true; stats.reason = '时间预算'; break }
    const page = queryMoments(
      decryptedDir,
      offset,
      SCAN_PAGE,
      authorUsername === '' ? undefined : authorUsername,
    )
    if (page.moments.length === 0) break
    total = page.total
    for (const entry of page.moments) {
      stats.scanned += 1
      if (stats.scanned > SCAN_MAX_POSTS) {
        stats.truncated = true
        stats.reason = '动态条数预算'
        break
      }
      // 没有 createTime 的条目无法证明落在区间内 —— 区间统计里排除，不猜。
      if (entry.ts <= 0 || entry.ts < lo || entry.ts > hi) continue
      stats.posts += 1
      stats.likes += entry.likes?.length ?? 0
      stats.comments += entry.comments?.length ?? 0
      for (const like of entry.likes ?? []) addInteractor(stats.likers, like.username, like.nickname, names)
      for (const comment of entry.comments ?? []) addInteractor(stats.commenters, comment.username, comment.nickname, names)
      const d = new Date(entry.ts * 1000)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      stats.monthly.set(key, (stats.monthly.get(key) ?? 0) + 1)
      stats.entries.push(entry)
    }
    if (stats.truncated) break
    offset += page.moments.length
    if (offset >= total) break
    await yieldToLoop()
  }
  if (!stats.truncated && offset < total) {
    stats.truncated = true
    stats.reason = '动态条数预算'
  }
  return stats
}

/** 把 `MomentEntry` 投影成证据层可用的朋友圈命中。 */
function momentHits(
  entries: readonly MomentEntry[],
  limit: number,
  names: ReadonlyMap<string, string>,
): ToolHit[] {
  return [...entries]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((entry, index) => {
      const username = entry.username.trim()
      const timelineId = entry.tid.trim()
      const stableKey = `moment:${username}:${timelineId || entry.ts || index}`
      const text = entry.text.trim()
      const snippet = text !== ''
        ? text.slice(0, 200)
        : entry.media_desc?.trim()
          || (entry.images.length > 0 ? '[图片]' : '')
          || (entry.videos.length > 0 ? '[视频]' : '')
          || (entry.link_title?.trim() ? `[链接] ${entry.link_title.trim()}` : '')
          || (entry.location?.trim() ? `[位置] ${entry.location.trim()}` : '')
          || '（无正文）'
      return {
        key: stableKey,
        name: entry.author.trim() || (username !== '' ? displayNameForUsername(username, names) : '朋友圈'),
        time: fmtDateTimeSec(entry.ts),
        snippet,
        source: 'resource' as const,
        trace: {
          kind: 'resource' as const,
          resource: {
            resourceKind: 'moment' as const,
            stableKey,
            ...(entry.ts > 0 ? { time: fmtDateTimeSec(entry.ts) } : {}),
            ...(username !== '' ? { username } : {}),
            ...(timelineId !== '' ? { timelineId } : {}),
          },
        },
      }
    })
}

/** 统计/排行正文（facts 的 body）。 */
function buildFactBody(
  posts: number,
  likes: number,
  comments: number,
  likers: ReadonlyMap<string, TopRow>,
  commenters: ReadonlyMap<string, TopRow>,
  peak: { month: number; count: number } | null,
  top: number,
  geo: { points: number; city?: string; cityCount?: number } | null,
): string {
  const parts = [`发布 ${posts} 条，获赞 ${likes}，评论 ${comments}`]
  const likedTop = topRows(likers, top)
  if (likedTop.length > 0) parts.push(`点赞 TOP ${formatTop(likedTop)}`)
  const commentTop = topRows(commenters, top)
  if (commentTop.length > 0) parts.push(`评论 TOP ${formatTop(commentTop)}`)
  if (peak !== null) parts.push(`月度峰值 ${peak.month} 月 ${peak.count} 条`)
  if (geo !== null && geo.points > 0) {
    parts.push(`定位打卡 ${geo.points} 个点${geo.city ? `，城市 TOP ${geo.city} ${geo.cityCount ?? 0}` : ''}`)
  }
  return parts.join('；')
}

/** 朋友圈统计（发布/获赞/评论/TOP/月度峰值）。 */
export const getMomentsStatsTool: RetrievalTool = {
  name: 'get_moments_stats',
  category: 'aggregate',
  description:
    '统计**朋友圈**的发布数、获赞数、评论数、点赞/评论排行与月度峰值。'
    + '适用于「我今年发了多少条朋友圈」「谁给我点赞最多」「哪个月发得最多」这类问题。'
    + '注意：按内容找单条动态请用 search_moments；这两类问题不要混用。',
  parameters: {
    type: 'object',
    properties: {
      author: { type: 'string', description: '限定作者（显示名或微信号；不填 = 全部作者）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 全量）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 全量）' },
      top: { type: 'number', description: '排行榜与最近帖子的条数（默认 10，上限 30）' },
      includeGeo: { type: 'boolean', description: '是否附带定位打卡统计（默认 false）' },
    },
  },
  run: async (args, ctx): Promise<ToolResult> => {
    const started = Date.now()
    // 显式 author 优先；scope.username 只在会话内问答里代表作者。
    // 微信问答的会话 scope 由执行层剥离，避免把群/联系人当成朋友圈作者。
    const rawAuthor = argString(args['author']).trim() || ctx.scope?.username?.trim() || ''
    const from = ctx.scope?.from?.trim() || argString(args['from']).trim()
    const to = ctx.scope?.to?.trim() || argString(args['to']).trim()
    const top = argInt(args['top'], DEFAULT_TOP, 1, MAX_TOP)
    const includeGeo = args['includeGeo'] === true
    const lo = from ? dayStartSec(from) : 0
    const hi = to ? dayEndSec(to) : 0
    const hasRange = from !== '' || to !== ''

    // 没有朋友圈库 = 数据源不可用，不能交一个「0 条」的假结论。
    if (!snsDbExists(ctx.decryptedDir)) {
      return {
        tool: 'get_moments_stats',
        ok: false,
        errorCode: 'not_configured',
        error: '朋友圈库不存在（可能未解密）',
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }

    const author = resolveAuthor(ctx.decryptedDir, rawAuthor)
    if (author.status === 'error') {
      return {
        tool: 'get_moments_stats',
        ok: false,
        errorCode: author.errorCode,
        error: author.error,
        errorDetails: { parameter: 'author' },
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
    if (author.status === 'not-found') {
      return {
        tool: 'get_moments_stats',
        ok: true,
        hits: [],
        facts: [],
        note: `未找到朋友圈作者「${author.value}」；显示名需与联系人备注/昵称一致，也可以直接传微信号`,
        elapsedMs: Date.now() - started,
      }
    }
    const authorUsername = author.status === 'ok' ? author.username : ''
    const authorSuffix = author.status === 'ok' ? ` · 作者 ${author.display}` : ''
    const names = contactMeta(ctx.decryptedDir).names

    try {
      if (!hasRange) {
        // 全量口径：洞察快照本身就是「全部时间」的 COUNT/GROUP BY，
        // 且归档优先（好友删掉的动态仍计入）。
        const snap = await queryMomentsInsights(
          ctx.decryptedDir,
          authorUsername === '' ? undefined : authorUsername,
        )
        if (snap.posts === 0) {
          return {
            tool: 'get_moments_stats',
            ok: true,
            hits: [],
            facts: [],
            note: `朋友圈暂无统计数据${author.status === 'ok' ? `（作者 ${author.display}）` : ''}`,
            elapsedMs: Date.now() - started,
          }
        }
        const page = queryMoments(
          ctx.decryptedDir,
          0,
          Math.max(top, 1),
          authorUsername === '' ? undefined : authorUsername,
        )
        const hits = momentHits(page.moments, top, names)
        // geo 是可选的聚合块：归档缺失或未统计定位时不存在，不能假设一定有。
        const topCity = snap.geo?.cities[0]
        const geo = includeGeo && snap.geo
          ? {
              points: snap.geo.points,
              ...(topCity ? { city: topCity.city, cityCount: topCity.count } : {}),
            }
          : null
        const likers = new Map<string, TopRow>()
        for (const row of snap.likedBy) {
          likers.set(row.username || row.nickname || '?', {
            name: row.nickname.trim() || displayNameForUsername(row.username, names),
            count: row.count,
          })
        }
        const commenters = new Map<string, TopRow>()
        for (const row of snap.commenters) {
          commenters.set(row.username || row.nickname || '?', {
            name: row.nickname.trim() || displayNameForUsername(row.username, names),
            count: row.count,
          })
        }
        const monthly = new Map<string, number>(
          snap.monthly.map((row): [string, number] => [row.month, row.count]),
        )
        return {
          tool: 'get_moments_stats',
          ok: true,
          hits,
          facts: [{
            title: `朋友圈（全量）${authorSuffix}`,
            body: buildFactBody(snap.posts, snap.likes, snap.comments, likers, commenters, peakMonth(monthly), top, geo),
          }],
          note: `全量统计（含归档保留的已删除动态）${authorSuffix} · 发布 ${snap.posts} 条`,
          elapsedMs: Date.now() - started,
        }
      }

      // 区间口径：洞察接口不支持日期，改为分页扫描后本地过滤。
      const stats = await scanMomentRange(
        ctx.decryptedDir, authorUsername, lo, hi, ctx.signal, started,
      )
      if (stats.posts === 0) {
        return {
          tool: 'get_moments_stats',
          ok: true,
          hits: [],
          facts: [],
          note: `所选范围内的朋友圈没有数据（${from || '不限'} ~ ${to || '不限'}）`
            + (stats.truncated ? `；扫描已截断（${stats.reason}）` : ''),
          elapsedMs: Date.now() - started,
        }
      }

      // 完整自然年且未限作者：年度模块会**完整**扫完该年（没有分页预算），
      // 用它的发布数/月度峰值补强被截断的统计；互动数仍来自本次归档扫描。
      const year = authorUsername === '' && from !== '' && to !== '' ? fullYearOf(from, to) : 0
      let posts = stats.posts
      let peak = peakMonth(stats.monthly)
      let annualUsed = false
      if (year > 0) {
        try {
          const annual = await queryAnnualMoments(ctx.decryptedDir, year)
          if (annual.available) {
            annualUsed = true
            posts = Math.max(posts, annual.count)
            if (annual.topMonth !== null && (peak === null || annual.topMonth.count > peak.count)) {
              peak = { month: annual.topMonth.month, count: annual.topMonth.count }
            }
          }
        } catch { /* 年度模块失败时保留本次扫描结果 */ }
      }

      // 地理统计：区间模式下只能从已扫描到的条目里算，不读第二遍全表。
      let geo: { points: number; city?: string; cityCount?: number } | null = null
      if (includeGeo) {
        const cityCounts = new Map<string, number>()
        let points = 0
        for (const entry of stats.entries) {
          if (entry.city?.trim()) {
            const city = entry.city.trim()
            cityCounts.set(city, (cityCounts.get(city) ?? 0) + 1)
          }
          const lat = Number(entry.lat ?? 0)
          const lng = Number(entry.lng ?? 0)
          if ((lat !== 0 || lng !== 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) points += 1
        }
        const topCity = [...cityCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
        geo = {
          points,
          ...(topCity ? { city: topCity[0], cityCount: topCity[1] } : {}),
        }
      }

      // 标题写清口径：完整年份写年份，其余写「区间」；截断时 note 再说明。
      const annualTitle = year > 0 && annualUsed
      const title = annualTitle ? `朋友圈（${year} 年）` : '朋友圈（区间）'
      const body = buildFactBody(
        posts,
        stats.likes,
        stats.comments,
        stats.likers,
        stats.commenters,
        peak,
        top,
        geo,
      )
      const noteParts = [
        `${from || '不限'} ~ ${to || '不限'}`,
        `扫描 ${stats.scanned} 条动态 → 区间内 ${stats.posts} 条`,
        annualUsed ? `发布数/月度峰值参考 ${year} 年年度统计` : '',
        stats.truncated ? `已截断（${stats.reason}），统计可能不完整` : '全量扫描',
        authorSuffix.trim(),
      ].filter(part => part !== '')
      return {
        tool: 'get_moments_stats',
        ok: true,
        hits: momentHits(stats.entries, top, names),
        facts: [{
          title: `${title}${authorSuffix}`,
          body,
        }],
        note: noteParts.join(' · '),
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return {
        tool: 'get_moments_stats',
        ok: false,
        errorCode: 'upstream_failure',
        error: '朋友圈统计失败：' + ((e as Error)?.message ?? String(e)),
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }
  },
}

/** 朋友圈统计类工具集。 */
export const MOMENTS_TOOLS: readonly RetrievalTool[] = [getMomentsStatsTool]
