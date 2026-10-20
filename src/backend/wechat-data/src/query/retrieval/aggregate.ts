/**
 * 聚合通道（2026-10-16 新增）。
 *
 * ## 为什么必须有
 *
 * 用户报「搜索微信数据时根本不准确」。实测（真实数据 18.5 万条消息）：
 *
 *   · 「我一共收到多少笔转账？」→ 答「14 条」，而**真实远不止**（只召回了 14 条片段）；
 *   · 「哪个群聊消息最多？」→ 答「判断不了，材料里没有计数」；
 *   · 「我总共跟多少人聊过天？」→ 答「没法数」。
 *
 * 根因：检索管线只做**片段召回**（FTS + 向量 + 结构化），`aggregation` 意图只是把
 * topK 放大（600/240/60），**没有任何真正的聚合执行**。而「一共多少笔」「哪个最多」
 * 这类问题的答案**不在任何一条消息里** —— 它需要 `COUNT(*)` / `GROUP BY`。
 *
 * 所以这里补一条**确定性聚合通道**：对聚合类问题直接跑 SQL，把结果作为
 * 「结构化事实」注入上下文。模型据此回答，而不是从片段里数数（它数不准，也不该数）。
 *
 * ## 为什么是确定性 SQL 而不是让模型算
 *
 * 模型从 10 条片段里「数出」总数，得到的必然是**片段数**而不是**真实总数** ——
 * 这正是上面那个「14 条」的来源。SQL 的 `COUNT(*)` 是唯一诚实的答案来源。
 *
 * ## 边界（刻意不做的事）
 *
 * 只做**能从消息元数据直接算出**的聚合：按会话计数、按时间计数、按关键词计数。
 * 不做「语义聚合」（如「一共借了多少钱」需要理解金额语义）—— 那属于模型该做的推理，
 * 而它需要的是**完整的候选集**，不是聚合结果。所以这里同时把「候选集规模」如实报出来，
 * 让模型知道「你看到的是全部还是抽样」。
 *
 * @module query/retrieval/aggregate
 */
import { existsSync } from 'node:fs'
import { withDb } from '../db-open.ts'
import { searchIndexPath } from '../search.ts'
import type { RetrievedDoc } from './types.ts'

/** 一条聚合事实。 */
export interface AggregateFact {
  /** 事实的标题（如「按会话统计消息数」）。 */
  title: string
  /** 事实正文（多行文本，直接进上下文）。 */
  body: string
  /** 参与统计的总行数（让模型知道这是全量还是抽样）。 */
  total: number
}

/** 聚合查询的输入。 */
export interface AggregateInput {
  decryptedDir: string
  /** 用户原始问题（用于挑聚合维度）。 */
  question: string
  /** 规划器关键词（用于关键词计数）。 */
  terms?: string[]
  /** 用户显式范围（硬过滤）。 */
  scope?: { username?: string; from?: string; to?: string }
  /** 规划器给出的日期（软偏好，作为默认时间窗）。 */
  from?: string
  to?: string
  /** 现在时刻（可注入，便于测试）。 */
  now?: Date
}

/** 聚合维度：从问题里识别出「要按什么分组」。 */
type Dimension = 'session' | 'day' | 'keyword' | 'distinct'

/**
 * 识别聚合维度。
 *
 * 规则是**确定性**的（可离线、可单测）：
 *   · 问「跟多少人/多少个会话/几个群」→ `distinct`（去重计数）；
 *   · 问「哪个群/谁/哪个会话最多」→ `session`（按会话分组）；
 *   · 问「哪天/哪个月」→ `day`（按天分组）；
 *   · 其余（「一共多少笔」）→ `keyword`（关键词计数）。
 *
 * `distinct` 必须**先于** `session` 判定：「我总共跟多少人聊过天」含「多少」，
 * 但它问的是**去重后的会话数**，不是「哪个会话最多」。
 * @param question - 用户问题。
 * @returns 维度。
 */
export function pickDimension(question: string): Dimension {
  const q = String(question || '')
  if (/多少(个|位|人|名)?(人|会话|群|联系人|好友)|几个(人|会话|群)|跟多少|和多少/.test(q)) return 'distinct'
  if (/哪个群|哪个会话|谁.*最多|谁.*最少|哪个.*最多|哪个.*最少|排行|排名|top|最多的是/.test(q)) return 'session'
  if (/哪天|哪一天|哪个月|哪几天|每天|按天|按日|按周|按月/.test(q)) return 'day'
  return 'keyword'
}

/**
 * 从问题里抽出「方向词 + 名词」的组合词（如「收到转账」「付出金额」）。
 *
 * ## 为什么需要（2026-10-16 实测踩到）
 *
 * 用户问「我一共**收到**多少笔转账」，规划器把关键词拆成了「转账」——
 * 于是聚合通道统计出「含「转账」：282 条」，而**真实答案是 240 条**
 * （含「收到转账」）。282 里混着付出，模型看出这一点后只能说
 * 「没找到你收到转账的记录」—— 聚合跑了，但答的还是错的。
 *
 * 根因：规划器做的是**分词**，而「收到/付出」是**方向**，分词会把它丢掉。
 * 方向词在微信账单文本里是**字面存在**的（「收到转账120.00元」），
 * 所以这里按字面组合去数，不做任何语义推断。
 *
 * ## 为什么允许中间插字
 *
 * 用户不会写「收到转账多少笔」，而是「收到**多少笔**转账」—— 方向词与名词之间
 * 隔着量词。所以匹配时允许中间出现**量词/助词**（多少、几、笔、了、过、的、钱…），
 * 但**不允许**出现别的实义词（否则「收到红包和转账」会被误判成「收到转账」）。
 *
 * 只认白名单里的方向词与名词，不做模糊匹配 —— 猜错会数出一个不存在的组合，比不数更糟。
 *
 * @param question - 用户问题。
 * @returns 组合词列表（可能为空）。
 */
export function directionTerms(question: string): string[] {
  const q = String(question || '')
  const DIRS = ['收到', '转入', '付出', '转出', '已收', '已付', '收款', '付款', '退还', '退回']
  const NOUNS = ['转账', '金额', '红包', '收款', '付款']
  // 方向词与名词之间允许出现的字（量词 / 助词 / 趋向动词 / 标点）—— 只放这些，不放实义词。
  // 「和/与」**刻意不放**：那是并列连词，「收到红包和转账」不是「收到转账」。
  const GAP = '[多少几笔个次条元块了过的是去到给、，,？?\\s]{0,6}'
  const out: string[] = []
  for (const d of DIRS) {
    for (const n of NOUNS) {
      // 组合必须**在问题里出现**（允许中间隔量词）才算 —— 否则「收到」+「金额」
      // 会造出「收到金额」这种用户没问过的词。
      if (new RegExp(d + GAP + n).test(q)) out.push(d + n)
    }
  }
  return out
}

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

/** 时间窗（epoch 秒）；两端为 0 表示不限。 */
interface Window { lo: number; hi: number }

/**
 * 决定聚合的时间窗。
 *
 * 优先级：用户显式范围 > 规划器日期 > 问题里的相对时间词 > 不限。
 * 「最近 N 天」这类词必须在这里换算 —— 否则「最近 7 天哪个群最多」会统计全库。
 * @param input - 聚合输入。
 * @returns 时间窗。
 */
export function resolveWindow(input: AggregateInput): Window {
  const now = input.now ?? new Date()
  const scope = input.scope ?? {}
  if (scope.from || scope.to) {
    return { lo: scope.from ? dayStartSec(scope.from) : 0, hi: scope.to ? dayEndSec(scope.to) : 0 }
  }
  if (input.from || input.to) {
    return { lo: input.from ? dayStartSec(input.from) : 0, hi: input.to ? dayEndSec(input.to) : 0 }
  }
  const q = input.question
  const rel = /最近\s*(\d+)\s*天/.exec(q)
  if (rel) {
    const days = Math.max(1, Math.min(365, Number(rel[1])))
    const hi = Math.floor(now.getTime() / 1000)
    return { lo: hi - days * 86400, hi }
  }
  if (/最近一周|这周|本周|近一周/.test(q)) {
    const hi = Math.floor(now.getTime() / 1000)
    return { lo: hi - 7 * 86400, hi }
  }
  if (/最近一个月|这个月|本月|近一个月/.test(q)) {
    const hi = Math.floor(now.getTime() / 1000)
    return { lo: hi - 30 * 86400, hi }
  }
  return { lo: 0, hi: 0 }
}

/** 索引库路径（聚合走 `wechat_search.db` 的 `message_meta`，它带 username/create_time）。 */
function indexDbPath(decryptedDir: string): string {
  return searchIndexPath(decryptedDir)
}

/** 拼 WHERE 子句与参数。 */
function whereOf(win: Window, scopeUsername?: string): { sql: string; params: Array<string | number> } {
  const parts: string[] = []
  const params: Array<string | number> = []
  if (win.lo > 0) { parts.push('create_time >= ?'); params.push(win.lo) }
  if (win.hi > 0) { parts.push('create_time <= ?'); params.push(win.hi) }
  if (scopeUsername) { parts.push('username = ?'); params.push(scopeUsername) }
  return { sql: parts.length > 0 ? ' WHERE ' + parts.join(' AND ') : '', params }
}

/** 时间窗的人话描述（写进事实标题，让模型知道统计范围）。 */
function windowLabel(win: Window): string {
  if (win.lo === 0 && win.hi === 0) return '全部时间'
  const f = (s: number): string => new Date(s * 1000).toISOString().slice(0, 10)
  if (win.lo > 0 && win.hi > 0) return `${f(win.lo)} ~ ${f(win.hi)}`
  return win.lo > 0 ? `${f(win.lo)} 起` : `截至 ${f(win.hi)}`
}

/**
 * 跑聚合查询。
 *
 * @param input - 聚合输入。
 * @returns 聚合事实列表（空数组 = 没有可聚合的数据或库不存在）。
 */
export function runAggregate(input: AggregateInput): AggregateFact[] {
  const p = indexDbPath(input.decryptedDir)
  if (!existsSync(p)) return []
  const win = resolveWindow(input)
  const dim = pickDimension(input.question)
  const { sql: where, params } = whereOf(win, input.scope?.username)
  const label = windowLabel(win)
  const facts: AggregateFact[] = []

  try {
    return withDb(p, (db) => {
      // 总量：任何聚合都要先报「分母」，否则「14 条」会被当成全部。
      const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM message_meta${where}`).get(...params) as { c?: number } | undefined
      const total = Number(totalRow?.c ?? 0)
      if (total === 0) return []

      if (dim === 'distinct') {
        // 去重计数：「我总共跟多少人聊过天」的**唯一诚实答案来源**。
        // 分两类报：群聊（`@chatroom`）与单聊 —— 用户问「多少人」时通常想知道的是人，
        // 而群聊不是「人」。两类都给，让模型按问题措辞选用。
        const row = db.prepare(
          `SELECT
             COUNT(DISTINCT username) AS all_sessions,
             COUNT(DISTINCT CASE WHEN username LIKE '%@chatroom' THEN username END) AS groups,
             COUNT(DISTINCT CASE WHEN username NOT LIKE '%@chatroom' THEN username END) AS singles
           FROM message_meta${where}`,
        ).get(...params) as { all_sessions?: number; groups?: number; singles?: number } | undefined
        const all = Number(row?.all_sessions ?? 0)
        const groups = Number(row?.groups ?? 0)
        const singles = Number(row?.singles ?? 0)
        facts.push({
          title: `去重会话数（${label}，共 ${total} 条消息）`,
          body: [
            `  · 有聊天记录的会话总数（去重）：${all} 个`,
            `  · 其中群聊：${groups} 个`,
            `  · 其中单聊（含公众号/服务号等非群会话）：${singles} 个`,
          ].join('\n'),
          total,
        })
      } else if (dim === 'session') {
        const rows = db.prepare(
          `SELECT username, COUNT(*) AS c, MIN(create_time) AS mn, MAX(create_time) AS mx
           FROM message_meta${where} GROUP BY username ORDER BY c DESC LIMIT 15`,
        ).all(...params) as Array<{ username: string; c: number; mn: number; mx: number }>
        const lines = rows.map((r, i) => {
          const d1 = new Date(r.mn * 1000).toISOString().slice(0, 10)
          const d2 = new Date(r.mx * 1000).toISOString().slice(0, 10)
          return `  ${i + 1}. ${r.username}：${r.c} 条（${d1} ~ ${d2}）`
        })
        facts.push({
          title: `按会话统计消息数（${label}，共 ${total} 条消息 / ${rows.length} 个会话上榜）`,
          body: lines.join('\n'),
          total,
        })
      } else if (dim === 'day') {
        const rows = db.prepare(
          `SELECT date(create_time, 'unixepoch', 'localtime') AS d, COUNT(*) AS c
           FROM message_meta${where} GROUP BY d ORDER BY c DESC LIMIT 15`,
        ).all(...params) as Array<{ d: string; c: number }>
        const lines = rows.map((r, i) => `  ${i + 1}. ${r.d}：${r.c} 条`)
        facts.push({
          title: `按天统计消息数（${label}，共 ${total} 条消息 / ${rows.length} 天上榜）`,
          body: lines.join('\n'),
          total,
        })
      } else {
        // 关键词计数：对每个检索词数「有多少条消息包含它」。
        // 这是「一共多少笔转账」这类问题的**唯一诚实答案来源** —— 模型从片段里数不出来。
        //
        // 方向词组合（「收到转账」）**排在规划器词之前**：规划器给的是分词结果
        // （「转账」），它把方向丢了；而用户问的正是带方向的那个数。两者都数，
        // 让模型看到「含「收到转账」：240 条」与「含「转账」：282 条」的差别。
        const dirs = directionTerms(input.question)
        const terms = [...new Set([...dirs, ...(input.terms ?? [])])].filter(t => t && t.length >= 2).slice(0, 8)
        if (terms.length > 0) {
          const lines: string[] = []
          for (const t of terms) {
            const like = '%' + t.replace(/[%_]/g, ' ') + '%'
            const r = db.prepare(`SELECT COUNT(*) AS c FROM message_meta${where}${where ? ' AND' : ' WHERE'} text LIKE ?`)
              .get(...params, like) as { c?: number } | undefined
            lines.push(`  · 含「${t}」：${Number(r?.c ?? 0)} 条`)
          }
          facts.push({
            title: `按关键词统计消息条数（${label}，全库共 ${total} 条消息）`,
            body: lines.join('\n'),
            total,
          })
        }
      }
      return facts
    })
  } catch (e) {
    // 聚合失败不该让问答整体不可用（与其余通道同策略：降级 + 如实说明）。
    // 但**不能静默** —— 静默 catch 会让「聚合通道没生效」变成一个查不出来的问题
    // （本轮实测踩到：聚合事实没进上下文，而日志里一条线索都没有）。
    console.error('[aggregate] 聚合查询失败:', (e as Error)?.message ?? String(e))
    return []
  }
}

/**
 * 把聚合事实转成「文档」，好让它走与其余通道相同的融合/压缩路径。
 *
 * 为什么复用 `RetrievedDoc` 而不是另开一条通路：融合、去重、压缩、上下文渲染
 * 都已经有一套经过验证的实现，另开一条只会让「聚合结果怎么进上下文」变成第二套逻辑。
 * 用 `source: 'agg'` 标记，让压缩阶段像 `kb` 一样**跳过窗口展开**（聚合结果没有
 * 「发生时间」，展开会得到空窗口）。
 *
 * @param facts - 聚合事实。
 * @returns 文档列表（每个事实一条）。
 */
export function factsToDocs(facts: AggregateFact[]): RetrievedDoc[] {
  return facts.map((f, i) => ({
    docKey: `agg:${i}`,
    username: '',
    name: f.title,
    local_id: 0,
    create_time: 0,
    text: f.body,
    snippet: f.body.slice(0, 120),
    source: 'agg',
  }))
}
