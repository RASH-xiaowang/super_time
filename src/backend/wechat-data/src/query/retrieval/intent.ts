/**
 * 查询意图识别与分类路由（目标 3）。
 *
 * 为什么必须分类：同一个检索引擎对「最近一次转账给谁」和「我一共转了多少」
 * 的最优参数是**相反**的 —— 前者要时间优先、少召回；后者要覆盖度、多召回。
 * 旧实现只有一条 `recency` 布尔线索，其余问题全走同一套参数，于是聚合类问题
 * 因为 topK 太小而漏证据、实体类问题因为通用词挤占名额而找不到人。
 *
 * 这里用**确定性规则**做主分类（可离线、零延迟、可单测），LLM 只作为可选补充
 * （pipeline 里按 config.intent.llmAssist 决定是否调用）。规则分类即便被 LLM 覆盖，
 * 也仍然作为回退基准，保证「LLM 挂了也能路由」。
 */
import type { IntentKind } from './types.ts'

/** 「最近/最新/最后」类排序意图（与既有 ask.ts 的 RECENCY_RE 保持一致语义）。 */
export const RECENCY_RE = /最近|最新|最后|上一次|上一回|上次|前几天|这两天|这几天|刚刚|近期/

/** 聚合意图：问数量/合计/次数。 */
const AGG_RE = /一共|总共|合计|总计|汇总|加起来|总共多少|多少次|几次|几笔|多少笔|统计|总额|总金额|平均/

/** 对比意图。 */
const CMP_RE = /对比|比较|区别|差异|哪个更|谁更|哪个好|相比|vs\b|versus/i

/** 实体属性词典：命中「<实体>的<属性>」结构时判定为实体查找。 */
const ENTITY_ATTR_RE = /(电话|手机|号码|微信|微信号|地址|住址|生日|邮箱|邮箱地址|身份证|银行卡|老家|公司|单位|职位|职务|联系人)/

/** 显式时间表达（用于判定 time_range 意图）。 */
const TIME_EXPR_RE = /(昨天|前天|今天|明天|上周[一二三四五六日天]?|这周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]|\d{4}年|\d{1,2}月份?|上个月|这个月|下个月|去年|前年|今年|\d{1,2}:\d{2})/

/**
 * 开放问法（问状态/进展/经过）。
 *
 * 必须**先于**实体规则判定：这类问题常点名某人（「王五借钱的事怎么样了」），
 * 但它问的是「怎么样」而非某个属性；按实体查找去窄化召回反而漏证据
 * （实测把「王五借钱的事怎么样了」判成实体查找后，只召回与王五的会话，
 *  漏掉他在群里的相关发言）。
 */
const OPEN_ENDED_RE = /怎么样|怎样|如何|进展|什么情况|怎么回事/

/** 「谁」类问法：问的是某个主体是谁（如「合同差额的那个客户是谁」）。 */
const WHO_RE = /是谁|谁的|哪个人|哪一位|哪位|何人/

/** 判定结果。 */
export interface IntentDecision {
  intent: IntentKind
  /** 规则命中的依据（写进日志，便于解释路由）。 */
  reason: string
  /** 是否含「最近/最后一次」这类排序意图（无论最终意图是什么都返回）。 */
  recency: boolean
}

/**
 * 规则意图分类。
 *
 * 顺序即优先级：显式时间表达（time_range）与「最近」这类排序词会先被识别；
 * 聚合/对比是明确的问法特征；实体属性结构次之；最后落到 open_qa。
 * @param question - 用户原始问题。
 * @param knownEntities - 已知实体名（联系人群里的显示名），命中则实体意图更可信。
 * @returns 意图判定。
 */
export function classifyIntent(question: string, knownEntities: string[] = []): IntentDecision {
  const q = String(question || '')
  const recency = RECENCY_RE.test(q)
  if (!q.trim()) return { intent: 'open_qa', reason: '空问题', recency }

  // 「最近一次转账给谁」既是 recency 也含「谁」，但按时间取最新才是正解 → 优先 recency_lookup。
  if (recency) {
    // 「最近一共/总共」→ 仍倾向聚合（问的是总量而非最新一条）。
    if (AGG_RE.test(q)) return { intent: 'aggregation', reason: '含聚合词', recency }
    return { intent: 'recency_lookup', reason: '含「最近/最新/最后」排序词', recency }
  }

  if (AGG_RE.test(q)) return { intent: 'aggregation', reason: '含聚合词（一共/总共/多少次…）', recency }
  if (CMP_RE.test(q)) return { intent: 'comparison', reason: '含对比词（对比/区别/哪个更…）', recency }
  // 开放问法优先于实体规则（见 OPEN_ENDED_RE 注释）。
  if (OPEN_ENDED_RE.test(q)) return { intent: 'open_qa', reason: '开放问法（问状态/进展）', recency }

  // 实体查找：命中已知实体 + 属性词，或「某人的<属性>」结构。
  const hasAttr = ENTITY_ATTR_RE.test(q)
  if (hasAttr) {
    const hitEntity = knownEntities.find(e => e && e.length >= 2 && q.includes(e))
    if (hitEntity) return { intent: 'entity_lookup', reason: `命中实体「${hitEntity}」+属性词`, recency }
    // 「谁的号码」这类问法也归实体查找。
    if (WHO_RE.test(q)) return { intent: 'entity_lookup', reason: '「谁的<属性>」问法', recency }
  }
  // 「…是谁」类问法：问的是某个主体是谁（可能是没在联系人里点名的描述性指代，
  // 如「合同差额的那个客户是谁」）。这类问题需要实体/结构化召回，而非泛泛的 BM25。
  if (WHO_RE.test(q)) return { intent: 'entity_lookup', reason: '「是谁」类问法', recency }

  if (TIME_EXPR_RE.test(q)) return { intent: 'time_range', reason: '含显式时间表达', recency }

  // 「李四」单独出现（无属性词）但问题很短，多半是在找与他的往来。
  const bareEntity = knownEntities.find(e => e && e.length >= 2 && q.includes(e))
  if (bareEntity && q.length <= 24) return { intent: 'entity_lookup', reason: `短问题点名「${bareEntity}」`, recency }

  return { intent: 'open_qa', reason: '未命中特定意图规则', recency }
}

/**
 * 用 LLM 结果修正规则分类（仅在规则判为 open_qa 且 LLM 给出更具体意图时采纳）。
 *
 * 保守策略：只有「规则说不确定、模型说具体」才采纳 —— 反向覆盖风险大于收益，
 * 规则已经能高置信识别的问题不需要模型再插一脚。
 * @param base - 规则判定。
 * @param llmIntent - 模型输出的意图字符串（可能是任意文本）。
 * @returns 修正后的判定。
 */
export function refineIntentWithLlm(base: IntentDecision, llmIntent: string): IntentDecision {
  const allowed: IntentKind[] = ['recency_lookup', 'entity_lookup', 'time_range', 'aggregation', 'comparison', 'open_qa']
  const v = String(llmIntent || '').trim() as IntentKind
  if (!allowed.includes(v)) return base
  if (base.intent === 'open_qa' && v !== 'open_qa') {
    return { intent: v, reason: `规则未定 → 模型判为 ${v}`, recency: base.recency }
  }
  return base
}
