/**
 * 回答接地审计 —— 把「回答里的金额」和「回答自己引用的原文」对照，挑出原文里没有的。
 *
 * 为什么需要：提示词已经写明「检索结果里没有的信息一律不要补充，尤其不要凭常识
 * 推测人名、金额、日期」，但模型仍可能补一个看起来合理的金额。实测出现过一次
 * 典型的编造：来源全是「收到转账 13.00 元」「收到转账 500.00 元」，回答却写
 * 「最近一次转账来自王五，金额 5000.00 元」—— 人名与金额都凭空生成，而界面上
 * 「来源 10 条（回答引用了 1 条）」看起来一切正常，用户没有任何办法察觉。
 *
 * 这里做一道**确定性、可离线**的检查，只在界面上提示，不拦截也不改写回答。
 *
 * 只查**金额**，不查计数与合计：计数（「共 3 笔」）和求和是模型可以正当算出来的，
 * 拿它们当编造会天天误报，提示很快就没人看了。金额是最高风险也最容易核对的一类
 * （金额一旦编造直接影响用户判断），而且绝大多数情况下就写在原文里。
 */
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'

/** 审计结果。 */
export interface GroundingAudit {
  /** 回答真正引用到的来源条数（序号越界的不算）。 */
  citedCount: number
  /** 来源总数（0 表示本轮压根没检索到材料）。 */
  total: number
  /** 回答里出现、但所引用原文里没有的金额（去重，最多 {@link MAX_GHOST_AMOUNTS} 个）。 */
  ghostAmounts: string[]
}

/** 回答里的金额：`5000.00 元` / `¥100` / `3 万元` / `5000块`。 */
const AMOUNT_RE = /[¥￥]?\s?(\d+(?:[.,]\d+)?)\s?(?:万元|元|块钱|块|圆)/g
/** 任意数字，用于收集原文里的数值池。 */
const NUMBER_RE = /\d+(?:[.,]\d+)?/g

const MAX_GHOST_AMOUNTS = 5

/** 数值归一化：`5,000.00` 与 `5000` 视为同一个数。 */
function normNumber(raw: string): string {
  const v = Number(raw.replace(/,/g, ''))
  return Number.isFinite(v) ? String(v) : raw
}

/**
 * 审计一轮回答的接地情况。
 * @param answer - 回答正文（streaming 中也应传当前全文）。
 * @param citations - 本轮检索到的来源。
 * @param citedIndexes - 回答正文里引用到的序号（1 基）。
 * @returns 引用条数与「原文里没有的金额」。
 */
export function auditAnswerGrounding(
  answer: string,
  citations: readonly NonNullable<AskResult['citations']>[number][] | undefined,
  citedIndexes: readonly number[] | undefined,
): GroundingAudit {
  const total = citations?.length ?? 0
  const cited = (citedIndexes ?? []).filter(i => Number.isInteger(i) && i >= 1 && i <= total)
  // 有引用就只看被引用的那几段（回答只需要对得起自己引用的材料）；
  // 一条都没引用时退回全部来源，此时另有「未引用任何来源」的提示。
  const usable = cited.length > 0 ? cited : citations?.map((_, i) => i + 1) ?? []
  const evidence = usable
    .map(i => citations?.[i - 1])
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map(c => `${c.name} ${c.sender ?? ''} ${c.time} ${c.snippet}`)
    .join('\n')
  const pool = new Set((evidence.match(NUMBER_RE) ?? []).map(normNumber))

  const ghostAmounts: string[] = []
  for (const m of answer.matchAll(AMOUNT_RE)) {
    const label = m[0].replace(/\s+/g, '')
    if (pool.has(normNumber(m[1]))) continue
    if (ghostAmounts.includes(label)) continue
    ghostAmounts.push(label)
    if (ghostAmounts.length >= MAX_GHOST_AMOUNTS) break
  }
  return { citedCount: cited.length, total, ghostAmounts }
}

/**
 * 把审计结果转成一句给用户看的提示；没有可疑之处时返回 null。
 * @param audit - {@link auditAnswerGrounding} 的结果。
 * @param streaming - 该轮是否仍在生成中（生成中不提示，避免半句话误报）。
 */
export function groundingWarning(audit: GroundingAudit, streaming = false): string | null {
  if (streaming || audit.total === 0) return null
  if (audit.citedCount === 0) {
    return `本回答没有引用任何检索来源，内容无法与聊天记录逐条对应，请先核对下方原文再采信。`
  }
  if (audit.ghostAmounts.length > 0) {
    return `回答里的 ${audit.ghostAmounts.join('、')} 在它引用的原文里没有出现，可能是编造或推算，请对照下方原文核对。`
  }
  return null
}
