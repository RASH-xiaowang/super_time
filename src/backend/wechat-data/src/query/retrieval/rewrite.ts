/**
 * 查询改写（目标 1 的第一阶段）。
 *
 * 三件事：
 *   ① 归一化：全角转半角、压空白 —— 否则「２０２４」这类全角数字在 bigram 索引里
 *      永远匹配不到半角写入的内容（微信正文基本是半角）。
 *   ② 多查询扩展：原句 + 规划器关键词 + 同义扩展，形成多个检索变体。
 *      「转账」在记录里可能写成「汇款/打钱/微信转账」，单查询会漏召回。
 *   ③ 时间归一：把「昨天/上周三/9月3日/上个月」确定性地换算成绝对日期。
 *      这是对 LLM 规划器的**兜底** —— 模型偶尔会把相对时间原样返回，
 *      而检索需要绝对日期才能做时间偏好。
 */
import { extractAskTerms } from '../ask.ts'
import type { QueryPlan } from './types.ts'
import { RECENCY_RE } from './intent.ts'

/**
 * 常见同义扩展表（双向）。
 *
 * 只收「微信语境下高频且真正会换词」的少量词对 —— 盲目的同义词表会引入
 * 大量低区分度词项，反而稀释 BM25 的真实 IDF（实测加入泛化同义词后 MRR 下降）。
 */
const SYNONYM_GROUPS: string[][] = [
  ['转账', '汇款', '打钱', '转钱', '微信转账'],
  ['红包', '压岁钱', '发红包'],
  ['电话', '手机', '号码', '手机号'],
  ['合同', '协议', '合约'],
  ['工资', '薪水', '薪资', '发薪'],
  ['房租', '租金', '租房'],
  ['借款', '借钱', '欠款', '还钱'],
  ['地址', '住址', '位置'],
  ['开会', '会议', '例会'],
  ['发票', '报销'],
  ['文件', '文档', '资料'],
  ['收款', '收到', '到账'],
]

/** 全角 → 半角（数字与常用标点）。 */
export function toHalfWidth(s: string): string {
  return String(s || '').replace(/[\uFF01-\uFF5E]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/** 归一化问题：全角转半角 + 压缩空白。 */
export function normalizeQuestion(q: string): string {
  return toHalfWidth(q).replace(/\s+/g, ' ').trim()
}

/** 某天的 YYYY-MM-DD（本地时区）。 */
function ymd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 周一为 0 的周内偏移。 */
function mondayOffset(d: Date): number {
  return (d.getDay() + 6) % 7
}

/** 中文数字 → 阿拉伯（仅覆盖 1-31，足够日期用）。 */
function cnNum(s: string): number {
  const map: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  if (s.length === 2 && s[0] === '十') return 10 + (map[s[1]] ?? 0)
  if (s.length === 2 && s[1] === '十') return (map[s[0]] ?? 0) * 10
  if (s.length === 3 && s[1] === '十') return (map[s[0]] ?? 0) * 10 + (map[s[2]] ?? 0)
  return map[s] ?? NaN
}

/**
 * 确定性相对时间解析：把问题里的相对时间换算成绝对日期范围。
 *
 * 只处理**模式明确**的几种（昨天/前天/上周X/周X/N月N日/上个月/去年）。
 * 解析不出来返回空 —— 宁可交给 LLM 规划器，也不要猜错日期把检索收窄成空集。
 * @param text - 归一化后的问题。
 * @param now - 当前时间（可注入，便于测试）。
 * @returns { from, to }（YYYY-MM-DD，未识别为空串）。
 */
export function resolveRelativeDate(text: string, now: Date = new Date()): { from: string; to: string } {
  const q = text
  const day = (offset: number): { from: string; to: string } => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const s = ymd(d)
    return { from: s, to: s }
  }
  if (/前天/.test(q)) return day(-2)
  if (/昨天|昨日/.test(q)) return day(-1)
  if (/今天|今日/.test(q)) return day(0)

  // 上周X / 本周X / 周X / 星期X
  const wm = q.match(/(上|这|本)?(?:周|星期)([一二三四五六日天])/)
  if (wm) {
    const wantsLast = wm[1] === '上'
    const idx = ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 } as Record<string, number>)[wm[2]]
    if (idx) {
      const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset(now))
      const target = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() + (idx - 1) + (wantsLast ? -7 : 0))
      const s = ymd(target)
      return { from: s, to: s }
    }
  }

  // N月N日 / N月N号
  const md = q.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (md) {
    const d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]))
    // 日期落在未来（如 12 月问 3 月）→ 视作去年。
    if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1)
    const s = ymd(d)
    return { from: s, to: s }
  }
  // 中文数字日期：九月三号
  const mdc = q.match(/([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})[日号]/)
  if (mdc) {
    const mo = cnNum(mdc[1])
    const da = cnNum(mdc[2])
    if (Number.isFinite(mo) && Number.isFinite(da)) {
      const d = new Date(now.getFullYear(), mo - 1, da)
      if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1)
      const s = ymd(d)
      return { from: s, to: s }
    }
  }

  // 上个月 / 这个月 / 下个月
  const mm = q.match(/(上|这|本|下)个月/)
  if (mm) {
    const delta = mm[1] === '上' ? -1 : mm[1] === '下' ? 1 : 0
    const first = new Date(now.getFullYear(), now.getMonth() + delta, 1)
    const last = new Date(now.getFullYear(), now.getMonth() + delta + 1, 0)
    return { from: ymd(first), to: ymd(last) }
  }
  if (/去年|上一年/.test(q)) {
    return { from: `${now.getFullYear() - 1}-01-01`, to: `${now.getFullYear() - 1}-12-31` }
  }
  if (/今年|本年度/.test(q)) {
    return { from: `${now.getFullYear()}-01-01`, to: ymd(now) }
  }
  return { from: '', to: '' }
}

/** 从词项出发做同义扩展（返回新增词，不含原词）。 */
export function synonymExpand(terms: string[]): string[] {
  const out: string[] = []
  const seen = new Set(terms)
  for (const g of SYNONYM_GROUPS) {
    const hit = g.some(w => terms.some(t => t.includes(w) || w.includes(t)))
    if (!hit) continue
    for (const w of g) {
      if (!seen.has(w)) { seen.add(w); out.push(w) }
    }
  }
  return out
}

/** 构建查询计划的输入。 */
export interface BuildPlanInput {
  question: string
  /** 规划器关键词。 */
  subQueries?: string[]
  /** 规划器点名的人。 */
  entity?: string
  /** 规划器换算出的日期。 */
  from?: string
  to?: string
  /** 用户显式选择的检索范围（硬过滤）。 */
  scopeFrom?: string
  scopeTo?: string
  /** 已知实体名（联系人显示名）。 */
  knownEntities?: string[]
  /** 现在时刻（可注入）。 */
  now?: Date
}

/**
 * 组装查询计划：归一化 + 词项 + 多查询变体 + 实体 + 时间。
 * @param input - 见 BuildPlanInput。
 * @returns 查询计划。
 */
export function buildQueryPlan(input: BuildPlanInput): QueryPlan {
  const now = input.now ?? new Date()
  const normalized = normalizeQuestion(input.question)
  const recency = RECENCY_RE.test(normalized)

  // 词项：规划器关键词优先，问题 bigram 补齐；同义扩展最后追加（权重最低，见 ask.ts）。
  //
  // **规划器关键词原样保留一份**（而不是只拆 bigram）：检索侧 `ftsPhrase` 会把多字词编成
  // 「连续 bigram 短语」，命中「收到转账」这种整词才算数 —— 精度高得多；而只拆 bigram
  // 再 OR 起来，会同时引入跨词噪音（「收到转账」→ 收到/到转/转账，其中「到转」是纯噪音）。
  // 两者都进词表：短语负责把**真正那句话**排前面，bigram 负责兜住换词/断行的召回。
  // 只收 3-8 字、不含空格的关键词（2 字词拆出来就是它自己，无需重复）。
  const plannedPhrases: string[] = []
  for (const q of input.subQueries ?? []) {
    const t = normalizeQuestion(q)
    if (t.length >= 3 && t.length <= 8 && !t.includes(' ')) plannedPhrases.push(t)
    if (plannedPhrases.length >= 4) break
  }
  const planned = (input.subQueries ?? []).flatMap(q => extractAskTerms(q))
  const fallback = extractAskTerms(normalized)
  const baseTerms: string[] = []
  const seen = new Set<string>()
  for (const t of [...plannedPhrases, ...planned, ...fallback]) {
    if (recency && /^(最近|最新|最后|一次|上次|上一|近一|刚刚)$/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t); baseTerms.push(t)
  }
  const synonyms = synonymExpand([...planned, ...fallback])
  const terms = [...baseTerms, ...synonyms].slice(0, 24)

  // 时间：显式 scope 是硬过滤；规划器/确定性解析是软偏好。
  const scopeFrom = (input.scopeFrom || '').trim()
  const scopeTo = (input.scopeTo || '').trim()
  const timeHard = Boolean(scopeFrom || scopeTo)
  let from = scopeFrom
  let to = scopeTo
  if (!timeHard) {
    const det = resolveRelativeDate(normalized, now)
    from = (input.from || det.from || '').trim()
    to = (input.to || det.to || '').trim()
  }

  // 实体：规划器给的优先，否则从已知实体里找问题里出现的。
  let entity = (input.entity || '').trim()
  if (!entity && input.knownEntities?.length) {
    entity = input.knownEntities.find(e => e && e.length >= 2 && normalized.includes(e)) ?? ''
  }

  // 多查询变体：原句 + 规划器关键词 + 同义扩展句。
  const variants: string[] = []
  const pushVariant = (v: string): void => {
    const t = v.trim()
    if (t && !variants.includes(t)) variants.push(t)
  }
  pushVariant(normalized)
  for (const s of input.subQueries ?? []) pushVariant(normalizeQuestion(s))
  if (synonyms.length > 0) pushVariant(synonyms.slice(0, 4).join(' '))

  return { original: input.question, normalized, terms, variants, entity, from, to, timeHard, recency }
}
