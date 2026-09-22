/**
 * 回答接地审计 —— 生成之后的**确定性**复核。
 *
 * 为什么需要（与提示词、前端 `panels/utils/grounding.ts` 的分工）：
 *   · 提示词里的「只用材料里的事实」是**软**约束，模型仍会补一个看起来合理的值；
 *   · 前端那份审计只在界面上提示、不改写回答（刻意的：金额可能是正当的合计）；
 *   · 这里做的是**生成侧**的复核：拿回答里的高风险值与「回答自己引用的原文」逐项对照，
 *     对不上就带着**具体是哪几个值**回炉重写一次 —— 把编造挡在用户看到之前。
 *
 * 只查**必须逐字来自原文**的三类值，不查「可以正当算出来」的数：
 *   · 金额（带单位：元/块/万/圆）—— 最高风险（直接影响用户判断），且绝大多数写在原文里；
 *     **合计放行**：等于引用原文里 ≤3 个金额的组合和（如 3500+3500=7000）就算有出处。
 *   · 日期（YYYY-MM-DD / YYYY年M月D日）—— 材料里每条窗口头都带日期，不需要模型推测；
 *   · 长数字串（≥7 位：手机号、卡号、单号）—— 只可能来自原文。
 * **计数**（「一共 3 笔」）刻意不查：它是模型可以正当数出来的，拿它当编造会天天误报，
 * 提示很快就没人看了（与前端模块同一取舍）。
 *
 * 全部是纯函数、可离线，因此可以单测与回归。
 */
import { parseCitedIndexes } from './ask.ts'

/** 高风险值类型。 */
export type GroundingKind = 'amount' | 'date' | 'digits'

/** 一条「引用原文里找不到出处」的值。 */
export interface GroundingViolation {
  kind: GroundingKind
  /** 原样出现在回答里的值（回喂给模型与提示用户都用它）。 */
  value: string
}

/** 审计结果。 */
export interface GroundingAudit {
  /** 校验过的高风险值个数（按「类型 + 归一化值」去重）。 */
  checked: number
  /** 引用原文里找不到出处的值（去重，封顶 {@link MAX_REPORTED}）。 */
  unsupported: GroundingViolation[]
  /** 含高风险值、却没有 [n] 标注的句子数（软问题：只触发重写，不算失败）。 */
  uncited: number
  /** 回答真正引用到的来源序号（1 基，去重升序；越界的不算）。 */
  cited: number[]
  /** 是否通过（只有「引用原文里没有的硬值」才算不通过）。 */
  ok: boolean
}

/** 最多回报几条违规值（避免把提示词塞满）。 */
const MAX_REPORTED = 6
/** 合计校验：引用原文里金额加数的采样上限（避免超长材料把组合数炸开）。 */
const MAX_SUM_POOL = 40
/** 合计校验：只对 ≤10 万元的目标做组合和（覆盖转账/房租/工资的真实量级）。 */
const MAX_SUM_CENTS = 10_000_000
/** 合计校验：允许由原文里最多几个金额相加得出。 */
const MAX_SUM_TERMS = 3

/**
 * 单次扫描同时识别三类值。
 *
 * 顺序即优先级：**日期在最前**，否则 `2026-09-05` 会被长数字规则当成一串号码。
 * 三个分组互斥，因此一次 `matchAll` 得到的就是「不重叠」的值列表。
 */
const VALUE_RE =
  /(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?)|([¥￥]?\s*\d[\d,]*(?:\.\d+)?\s*(?:万元|万块|万|元|块钱|块|圆))|(\+?\d[\d\-\s]{5,}\d)/g

/** 引用原文里的所有数字（逐字出处池）。 */
const NUMBER_RE = /\d+(?:[.,]\d+)?/g

/** 时钟 HH:MM：不算金额出处。 */
const CLOCK_RE = /\d{1,2}:\d{2}/g

/** 句子切分（中英文句末 + 换行）。 */
const SENTENCE_RE = /[^\n。！？!?；;]+/g

/** 归一化日期为 `YYYY-MM-DD`（解析不出来返回空串）。 */
function normDate(raw: string): string {
  const m = raw.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/)
  if (!m) return ''
  // 三个组都是必选的，匹配成功就一定取得到；万一取不到仍算「解析不出来」⇒ 返回空串，
  // 而不是拿 `''` 去拼出一个 `NaN-NaN-NaN`（那会被当成一个看起来很正常的日期出处）。
  const [y, mo, d] = [m[1], m[2], m[3]]
  if (!y || !mo || !d) return ''
  const p = (n: string): string => String(Number(n)).padStart(2, '0')
  return `${y}-${p(mo)}-${p(d)}`
}

/** 金额 → 分（`3万元` = 3000000 分；解析不出来返回 NaN）。 */
function amountToCents(raw: string): number {
  const m = raw.match(/(\d[\d,]*(?:\.\d+)?)\s*(万元|万块|万|元|块钱|块|圆)/)
  if (!m) return NaN
  const [digits, unit] = [m[1], m[2]]
  if (!digits || !unit) return NaN
  const n = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(n)) return NaN
  const scale = unit === '万元' || unit === '万块' || unit === '万' ? 10000 : 1
  return Math.round(n * scale * 100)
}

/** 数字 → 分（原文侧的「逐字对比」用：不带单位的数字也认，如「差额是2000」）。 */
function numberToCents(raw: string): number {
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : NaN
}

/** 只保留数字字符（长数字串的比较键）。 */
function digitsOnly(raw: string): string {
  return raw.replace(/\D+/g, '')
}

/** 从一段文字里取出三类值（原始列表，未去重）。 */
function scanValues(text: string): Array<{ kind: GroundingKind; raw: string }> {
  const out: Array<{ kind: GroundingKind; raw: string }> = []
  for (const m of String(text || '').matchAll(VALUE_RE)) {
    if (m[1]) out.push({ kind: 'date', raw: m[1] })
    else if (m[2]) out.push({ kind: 'amount', raw: m[2] })
    else if (m[3]) out.push({ kind: 'digits', raw: m[3] })
  }
  return out
}

/** 引用原文侧的比对池。 */
interface ValuePools {
  dates: Set<string>
  digits: string[]
  cents: Set<number>
  /** 原文里 ≤{@link MAX_SUM_TERMS} 个金额能凑出的和（含单项本身）。 */
  sums: Set<number>
}

/**
 * 从「回答自己引用的原文」建比对池。
 * @param evidenceTexts - 每条被引用来源的正文（窗口全文优先，退化时用 snippet）。
 * @returns 见 {@link ValuePools}。
 */
export function buildValuePools(evidenceTexts: readonly string[]): ValuePools {
  const text = evidenceTexts.join('\n')
  const dates = new Set<string>()
  const digits: string[] = []
  /** 带单位的金额（**保留重复**）：合计只能由这些数相加得出。 */
  const amounts: number[] = []
  /** 不该被当成「金额出处」的时间片段区间：日期 `2026-09-05` 与时钟 `20:12`。
   *  不排除的话，时钟里的 `14`/`12` 相加就能凑出 `2026`，审计形同虚设。 */
  const timeRanges: Array<[number, number]> = []
  for (const m of text.matchAll(VALUE_RE)) {
    const at = m.index ?? 0
    if (m[1]) {
      const d = normDate(m[1])
      if (d) dates.add(d)
      timeRanges.push([at, at + m[1].length])
    } else if (m[2]) {
      const c = amountToCents(m[2])
      if (Number.isFinite(c) && c > 0) amounts.push(c)
    } else if (m[3]) {
      const s = digitsOnly(m[3])
      if (s.length >= 7) digits.push(s)
    }
  }
  for (const m of text.matchAll(CLOCK_RE)) {
    const at = m.index ?? 0
    timeRanges.push([at, at + m[0].length])
  }
  // 逐字出处池：原文里的**任何**数字（「差额是2000」这种没带单位的也算），
  // 但日期与时钟里的数字不算 —— 否则「2026 元」能被「2026-09-05」放过。
  const cents = new Set<number>()
  for (const m of text.matchAll(NUMBER_RE)) {
    const at = m.index ?? 0
    if (timeRanges.some(([a, b]) => at >= a && at < b)) continue
    const c = numberToCents(m[0])
    if (Number.isFinite(c) && c > 0) cents.add(c)
  }
  return { dates, digits, cents, sums: buildSums(amounts) }
}

/** 原文金额的「≤3 个相加」可达和（含单项）。用于放行正当的合计。 */
function buildSums(cents: readonly number[]): Set<number> {
  const out = new Set<number>()
  // 去重但保留少量重复：3500+3500=7000 这类**同值相加**是真实场景（两笔同额转账）。
  const pool: number[] = []
  const used = new Map<number, number>()
  for (const c of cents) {
    const n = used.get(c) ?? 0
    if (n >= MAX_SUM_TERMS) continue
    used.set(c, n + 1)
    pool.push(c)
    if (pool.length >= MAX_SUM_POOL) break
  }
  for (const c of pool) if (c <= MAX_SUM_CENTS) out.add(c)
  for (let i = 0; i < pool.length; i += 1) {
    const a = pool[i]
    // 读不到就跳过：**不能兜成 0** —— 这个池里的 0 是一个合法的、会进答案的金额（`out.add(0)`）。
    if (a === undefined) continue
    for (let j = i + 1; j < pool.length; j += 1) {
      const b = pool[j]
      if (b === undefined) continue
      const s2 = a + b
      if (s2 <= MAX_SUM_CENTS) out.add(s2)
      for (let k = j + 1; k < pool.length; k += 1) {
        const c = pool[k]
        if (c === undefined) continue
        const s3 = s2 + c
        if (s3 <= MAX_SUM_CENTS) out.add(s3)
      }
    }
  }
  return out
}

/** 长数字串是否有出处：完全相同，或双方互为子串（原文里常带 +/分隔符）。 */
function digitsSupported(value: string, pool: readonly string[]): boolean {
  for (const p of pool) {
    if (p === value || p.includes(value) || value.includes(p)) return true
  }
  return false
}

/**
 * 审计一轮回答的接地情况。
 * @param answer - 回答正文。
 * @param evidenceTexts - **回答自己引用到的**来源正文（一条来源一段文本）。
 * @param citationCount - 本轮引用条数（用于校验 [n] 是否越界）。
 * @returns 见 {@link GroundingAudit}。
 */
export function auditGrounding(
  answer: string,
  evidenceTexts: readonly string[],
  citationCount: number,
): GroundingAudit {
  const text = String(answer || '')
  const pools = buildValuePools(evidenceTexts)

  const seen = new Set<string>()
  const unsupported: GroundingViolation[] = []
  let checked = 0
  for (const v of scanValues(text)) {
    let key = ''
    let supported = false
    if (v.kind === 'date') {
      const d = normDate(v.raw)
      if (!d) continue
      key = 'date:' + d
      supported = pools.dates.has(d)
    } else if (v.kind === 'amount') {
      const c = amountToCents(v.raw)
      if (!Number.isFinite(c)) continue
      key = 'amount:' + c
      supported = pools.cents.has(c) || pools.sums.has(c)
    } else {
      const s = digitsOnly(v.raw)
      if (s.length < 7) continue
      key = 'digits:' + s
      supported = digitsSupported(s, pools.digits)
    }
    if (seen.has(key)) continue
    seen.add(key)
    checked += 1
    if (!supported && unsupported.length < MAX_REPORTED) {
      unsupported.push({ kind: v.kind, value: v.raw.replace(/\s+/g, '').trim() })
    }
  }

  // 句子级：带高风险值却没标 [n] 的句子（软问题，只触发一次重写）。
  let uncited = 0
  for (const sentence of text.match(SENTENCE_RE) ?? []) {
    if (scanValues(sentence).length === 0) continue
    if (!/\[\d{1,3}\]/.test(sentence)) uncited += 1
  }

  return {
    checked,
    unsupported,
    uncited,
    cited: parseCitedIndexes(text, citationCount),
    ok: unsupported.length === 0,
  }
}

/** 把违规值转成「回炉重写」的具体指令；没有违规时返回空串。 */
export function groundingRepairHint(audit: GroundingAudit): string {
  if (audit.unsupported.length === 0) return ''
  const list = audit.unsupported.map(v => `「${v.value}」`).join('、')
  return `【核对未通过】你写的 ${list} 在你引用的原文里找不到出处。请改写：\n`
    + ' · 如果它们是**合计**，写明由哪几条相加得出（如「3500+3500=7000」）；\n'
    + ' · 如果不是合计，就删掉，或改成原文里**原样出现**的值；\n'
    + ' · 日期只能写原文里出现过的日期，不要自己换算或推测。'
}
