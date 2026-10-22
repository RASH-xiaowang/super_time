/**
 * 按问题所需的「数据域」判断证据是否缺项，并给出至多一个专用补查工具。
 *
 * 泛化消息/混合检索命中后，模型经常直接结束，导致文件、账单、收藏等
 * 明确数据域一次都没查。这里只做确定性判断，不读库、不执行工具；执行仍由
 * runtime 走同一套 profile 白名单、参数修复、deadline 与重试。
 *
 * @module query/answer-runtime/required-domains
 */
import type { AnswerIntentDecision } from './intent.ts'
import type { EvidenceBundle } from './evidence.ts'
import { getAnswerProfile, type AnswerProfile, type AnswerProfileId } from '../tools/profiles.ts'
import type { ToolName, ToolResult } from '../tools/types.ts'

/** 可被问题独立要求的检索数据域。 */
export type AnswerDataDomain =
  | 'messages'
  | 'kb'
  | 'files'
  | 'favorites'
  | 'moments'
  | 'records'
  | 'contacts'

/** 数据域 → 专用工具。messages/kb 的兜底优先级最低。 */
export const DOMAIN_TOOL: Readonly<Record<AnswerDataDomain, ToolName>> = {
  files: 'search_files',
  favorites: 'search_favorites',
  moments: 'search_moments',
  records: 'search_records',
  contacts: 'search_contacts',
  kb: 'search_kb',
  messages: 'search_messages',
}

/** 补查优先级：先专用资源域，再知识库，最后泛化消息。 */
const DOMAIN_PRIORITY: readonly AnswerDataDomain[] = [
  'files',
  'favorites',
  'moments',
  'records',
  'contacts',
  'kb',
  'messages',
]

const QUESTION_DOMAIN_RULES: ReadonlyArray<readonly [AnswerDataDomain, RegExp]> = [
  ['files', /文件|文档|附件|表格|pdf|excel|word|ppt|压缩包|安装包|合同(?:书|文件)|资料/i],
  ['favorites', /收藏|书签/i],
  ['moments', /朋友圈|动态|说说|sns/i],
  ['records', /转账|红包|收款|付款|账单|交易记录|消费|支出|收入/i],
  ['contacts', /联系人|好友|通讯录|微信号|电话号码|手机号|是谁/i],
  ['kb', /知识库|文档库|资料库|产品手册|规范|faq|sop/i],
]

const TOOL_DOMAIN: Readonly<Record<string, AnswerDataDomain>> = {
  search_messages: 'messages',
  search_semantic: 'messages',
  get_session_messages: 'messages',
  get_message_context: 'messages',
  aggregate_messages: 'messages',
  list_sessions: 'messages',
  search_kb: 'kb',
  search_files: 'files',
  search_favorites: 'favorites',
  search_moments: 'moments',
  search_records: 'records',
  search_contacts: 'contacts',
  get_contact_detail: 'contacts',
}

const RESOURCE_DOMAIN: Readonly<Record<string, AnswerDataDomain>> = {
  file: 'files',
  favorite: 'favorites',
  moment: 'moments',
  record: 'records',
}

function profileOf(profile: AnswerProfile | AnswerProfileId): AnswerProfile {
  return typeof profile === 'string' ? getAnswerProfile(profile) : profile
}

function allowsDomain(profile: AnswerProfile, domain: AnswerDataDomain): boolean {
  return (profile.allowedTools as readonly string[]).includes(DOMAIN_TOOL[domain])
}

/**
 * 计算本轮问题必须覆盖的数据域。
 *
 * 明确的资源词优先；意图只负责补上消息/知识库等基础域。profile 会在此处
 * 先裁剪一次，session-ask 不会因为问题里写了「文件」就产生跨边界补查。
 */
export function requiredDomainsFor(
  question: string,
  intent: AnswerIntentDecision,
  profile: AnswerProfile | AnswerProfileId,
  options: { hasKb?: boolean; allowedTools?: ReadonlySet<string> } = {},
): AnswerDataDomain[] {
  const p = profileOf(profile)
  const q = String(question ?? '').trim()
  if (p.kbOnly) return p.allowKnowledgeBase ? ['kb'] : []
  if (q === '' || intent.kind === 'clarify') return []

  const out: AnswerDataDomain[] = []
  const add = (domain: AnswerDataDomain): void => {
    if (out.includes(domain)) return
    if (!allowsDomain(p, domain)) return
    if (options.allowedTools !== undefined && !options.allowedTools.has(DOMAIN_TOOL[domain])) return
    out.push(domain)
  }

  for (const [domain, re] of QUESTION_DOMAIN_RULES) {
    if (!re.test(q)) continue
    if (domain === 'kb' && options.hasKb === false) continue
    add(domain)
  }
  if (intent.kind === 'content_media' && intent.scopeHints?.mediaTypes?.includes('file')) add('files')
  if (intent.kind === 'aggregate' || intent.kind === 'relation') add('messages')
  if (intent.kind === 'relation') add('contacts')
  if (intent.kind === 'open_qa') {
    if (options.hasKb === true) add('kb')
    else if (out.length === 0) add('messages')
  } else if (out.length === 0) {
    add('messages')
  }
  return out
}

function addToolDomain(out: Set<AnswerDataDomain>, tool: string): void {
  if (tool === 'search_hybrid') return
  const domain = TOOL_DOMAIN[tool]
  if (domain !== undefined) out.add(domain)
}

function addResultDomains(out: Set<AnswerDataDomain>, result: ToolResult): void {
  if (!result.ok || (result.hits.length === 0 && (result.facts?.length ?? 0) === 0)) return
  if (result.tool === 'search_hybrid') {
    for (const hit of result.hits) {
      if (hit.source === 'kb') out.add('kb')
      else if (hit.source === 'msg' || hit.source === 'agg') out.add('messages')
    }
    return
  }
  addToolDomain(out, result.tool)
}

/** 从证据包与原始工具结果统计已覆盖的数据域。 */
export function evidenceDomains(
  evidence: EvidenceBundle,
  results: readonly ToolResult[] = [],
): Set<AnswerDataDomain> {
  const out = new Set<AnswerDataDomain>()
  for (const item of evidence.items) {
    addToolDomain(out, item.tool)
    for (const tool of item.tools) addToolDomain(out, tool)
    if (item.source === 'kb') out.add('kb')
    else if (item.source === 'msg') out.add('messages')
    if (item.locator.type === 'resource' && item.locator.resourceKind !== undefined) {
      const domain = RESOURCE_DOMAIN[item.locator.resourceKind]
      if (domain !== undefined) out.add(domain)
    }
  }
  for (const tool of Object.keys(evidence.stats.toolCounts)) addToolDomain(out, tool)
  if (evidence.stats.sourceCounts.kb > 0) out.add('kb')
  if (evidence.stats.sourceCounts.msg > 0) out.add('messages')
  for (const result of results) addResultDomains(out, result)
  return out
}

/** 返回尚未被证据或工具结果覆盖的必需域（保持必需域原顺序）。 */
export function missingDomains(
  required: readonly AnswerDataDomain[],
  evidence: EvidenceBundle,
  results: readonly ToolResult[] = [],
): AnswerDataDomain[] {
  const covered = evidenceDomains(evidence, results)
  return required.filter(domain => !covered.has(domain))
}

/** 至多选择一个缺失域及其专用工具；已尝试过的工具不重复补。 */
export function supplementCandidate(
  missing: readonly AnswerDataDomain[],
  availableTools: ReadonlySet<string>,
  attemptedTools: ReadonlySet<string> = new Set(),
): { domain: AnswerDataDomain; tool: ToolName } | undefined {
  for (const domain of DOMAIN_PRIORITY) {
    if (!missing.includes(domain)) continue
    const tool = DOMAIN_TOOL[domain]
    if (!availableTools.has(tool) || attemptedTools.has(tool)) continue
    return { domain, tool }
  }
  return undefined
}
