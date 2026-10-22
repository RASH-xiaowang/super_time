/**
 * 工具结果到统一证据包的收敛。
 *
 * 工具返回的 `hits` 与 `facts` 形状相同但语义不同：
 *   · hits 是可点击回原文/文件/资源的片段；
 *   · facts 是确定性统计结论。
 *
 * 本模块把它们收敛成同一种 {@link EvidenceItem}，并负责：
 *   · 生成稳定 evidenceId（消息 / 知识库 / 聚合事实）；
 *   · 跨工具去重与合并；
 *   · 可解释排序；
 *   · 按条数与字符预算截断；
 *   · 统计与证据充分性判定。
 *
 * @module query/answer-runtime/evidence
 */
import {
  EVIDENCE_BUDGET_DEFAULTS,
  EVIDENCE_SOURCE_MIN_CHARS,
  EVIDENCE_SOURCE_MIN_SCORE,
  type AnswerStatus,
  type BuildEvidenceOptions,
  type CitationShape,
  type EvidenceAssessment,
  type EvidenceBundle,
  type EvidenceBundleStats,
  type EvidenceItem,
  type EvidenceLocator,
  type EvidenceSource,
  type EvidenceStatus,
  type EvidenceSufficiency,
} from './evidence-types.ts'
import {
  allowsFact,
  boundaryViolation,
  isRecord,
  itemFromHit,
  normalizeHit,
  safeString,
} from './evidence-normalize.ts'

export {
  EVIDENCE_BUDGET_DEFAULTS,
  EVIDENCE_SOURCE_MIN_CHARS,
  EVIDENCE_SOURCE_MIN_SCORE,
}
export type {
  AnswerStatus,
  BuildEvidenceOptions,
  CitationShape,
  EvidenceAssessment,
  EvidenceBundle,
  EvidenceBundleStats,
  EvidenceItem,
  EvidenceLocator,
  EvidenceSource,
  EvidenceStatus,
  EvidenceSufficiency,
}

const MESSAGE_TOOLS = new Set([
  'search_messages',
  'search_semantic',
  'search_hybrid',
  'get_session_messages',
  'get_message_context',
])

function normalizeFactSlug(value: string): string {
  const chars = Array.from(value.trim().toLowerCase().replace(/\s+/g, ' '))
  let slug = ''
  for (const char of chars) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      slug += char
    } else if (slug !== '' && !slug.endsWith('-')) {
      slug += '-'
    }
  }
  return Array.from(slug)
    .slice(0, 64)
    .join('')
    .replace(/-+$/, '')
}

function factBaseSlug(title: string, body: string): string {
  return normalizeFactSlug(title) || normalizeFactSlug(body) || `fact-${stableDigest(body)}`
}

function factContentSignature(title: string, body: string): string {
  const normalizedTitle = title.trim().replace(/\s+/g, ' ')
  return `${normalizedTitle}\u0000${body}`
}

function fitFactSlug(base: string, suffix: string): string {
  if (suffix === '') return base
  const tail = `-${suffix}`
  return Array.from(base).slice(0, 64 - Array.from(tail).length).join('').replace(/-+$/, '') + tail
}

function stableDigest(value: string): string {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function itemFromFact(
  tool: string,
  fact: { title: string; body: string },
  collisionContents: ReadonlySet<string> | undefined,
): EvidenceItem {
  const base = factBaseSlug(fact.title, fact.body)
  const needsContentSuffix = collisionContents !== undefined && collisionContents.size > 1
  const slug = needsContentSuffix
    ? fitFactSlug(base, stableDigest(factContentSignature(fact.title, fact.body)))
    : base
  const key = `fact:${tool}:${slug}`
  return {
    evidenceId: `agg:${tool}:${slug}`,
    kind: 'fact',
    tool,
    tools: [tool],
    source: 'agg',
    name: safeString(fact.title),
    time: '',
    snippet: safeString(fact.body),
    key,
    locator: {
      type: 'fact',
      tool,
      title: fact.title,
      bodyDigest: stableDigest(fact.body),
      key,
    },
    fact: true,
  }
}

function mergedKbCitation(
  base: NonNullable<CitationShape['kb']>,
  incoming: NonNullable<CitationShape['kb']>,
): NonNullable<CitationShape['kb']> {
  const number = (a: number, b: number): number => (a !== 0 ? a : b)
  const text = (a: string, b: string): string => (a !== '' ? a : b)
  return {
    kbId: number(base.kbId, incoming.kbId),
    fileId: number(base.fileId, incoming.fileId),
    fileName: text(base.fileName, incoming.fileName),
    fileExt: text(base.fileExt, incoming.fileExt),
    chunkId: number(base.chunkId, incoming.chunkId),
    ordinal: number(base.ordinal, incoming.ordinal),
    page: number(base.page, incoming.page),
    heading: text(base.heading, incoming.heading),
  }
}

function mergeCitation(
  base: CitationShape | undefined,
  incoming: CitationShape | undefined,
): CitationShape | undefined {
  if (base === undefined) return incoming
  if (incoming === undefined) return base
  if (base.kb !== undefined && incoming.kb !== undefined) {
    return { ...base, kb: mergedKbCitation(base.kb, incoming.kb) }
  }
  return {
    ...base,
    name: base.name || incoming.name,
    time: base.time || incoming.time,
    snippet: charLength(incoming.snippet) > charLength(base.snippet)
      ? incoming.snippet
      : base.snippet,
    username: base.username || incoming.username,
    local_id: base.local_id !== 0 ? base.local_id : incoming.local_id,
    ...(base.sender === undefined && incoming.sender !== undefined
      ? { sender: incoming.sender }
      : {}),
  }
}

function locatorRank(locator: EvidenceLocator): number {
  if (locator.type === 'message') return 2
  if (locator.type === 'kb') {
    return locator.fileId > 0 ? 2 : 1
  }
  return 0
}

function mergeItem(base: EvidenceItem, incoming: EvidenceItem): EvidenceItem {
  const tools = [...new Set([...base.tools, ...incoming.tools])].sort()
  const tool = tools[0] ?? base.tool
  const snippet = charLength(incoming.snippet) > charLength(base.snippet)
    ? incoming.snippet
    : base.snippet
  const time = base.time || incoming.time
  const sender = base.sender || incoming.sender
  const name = base.name || incoming.name
  const key = base.key || incoming.key
  const score = base.score === undefined
    ? incoming.score
    : incoming.score === undefined
      ? base.score
      : Math.max(base.score, incoming.score)
  const locator = locatorRank(incoming.locator) > locatorRank(base.locator)
    ? incoming.locator
    : base.locator
  const citation = mergeCitation(base.citation, incoming.citation)
  return {
    ...base,
    tool,
    tools,
    name,
    time,
    ...(sender === undefined ? {} : { sender }),
    snippet,
    ...(score === undefined ? {} : { score }),
    key,
    locator,
    ...(citation === undefined ? {} : { citation }),
    truncated: Boolean(base.truncated || incoming.truncated),
    fact: Boolean(base.fact || incoming.fact),
  }
}

function compareTextDesc(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? 1 : -1
}

function timeRank(item: EvidenceItem): number {
  if (!item.time) return 0
  const parsed = Date.parse(item.time.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : 0
}

function compareEvidence(a: EvidenceItem, b: EvidenceItem): number {
  const aScore = a.score ?? (a.kind === 'fact' ? 1 : 0)
  const bScore = b.score ?? (b.kind === 'fact' ? 1 : 0)
  if (aScore !== bScore) return bScore - aScore
  const time = timeRank(b) - timeRank(a)
  if (time !== 0) return time
  const byTime = compareTextDesc(a.time, b.time)
  if (byTime !== 0) return byTime
  if (a.evidenceId === b.evidenceId) return 0
  return a.evidenceId < b.evidenceId ? -1 : 1
}

function charLength(value: string): number {
  return Array.from(value).length
}

function clipText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const chars = Array.from(value)
  if (chars.length <= maxChars) return { text: value, truncated: false }
  if (maxChars <= 0) return { text: '', truncated: true }
  if (maxChars === 1) return { text: chars[0] ?? '', truncated: true }
  return { text: chars.slice(0, maxChars - 1).join('') + '…', truncated: true }
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value))
}

/** 判断证据包是否为空。 */
export function isEvidenceMissing(
  evidence: Pick<EvidenceBundle, 'items'> | readonly EvidenceItem[],
  options: Pick<BuildEvidenceOptions, 'minItems' | 'minSnippetChars' | 'aggregateIntent'> = {},
): boolean {
  return assessEvidence(evidence, options).status === 'missing'
}

/**
 * 评估证据是否充分。
 *
 * - 没有任何条目 → missing；
 * - 有条目但可用条目不足 → insufficient；
 * - 否则 sufficient。
 */
export function assessEvidence(
  evidence: Pick<EvidenceBundle, 'items'> | readonly EvidenceItem[],
  options: Pick<BuildEvidenceOptions, 'minItems' | 'minSnippetChars' | 'aggregateIntent'> = {},
): EvidenceAssessment {
  const items: readonly EvidenceItem[] = Array.isArray(evidence)
    ? evidence
    : (evidence as Pick<EvidenceBundle, 'items'>).items
  const minItems = Math.max(1, nonNegativeInt(options.minItems, EVIDENCE_BUDGET_DEFAULTS.minItems))
  const minSnippetChars = Math.max(
    1,
    nonNegativeInt(options.minSnippetChars, EVIDENCE_BUDGET_DEFAULTS.minSnippetChars),
  )
  if (items.length === 0) {
    return {
      status: 'missing',
      sufficient: false,
      usableItems: 0,
      reason: '没有任何证据',
    }
  }
  const usable = items.filter((item: EvidenceItem) => {
    const sourceMin = EVIDENCE_SOURCE_MIN_CHARS[item.source] ?? 1
    return charLength(item.snippet.trim()) >= Math.max(minSnippetChars, sourceMin)
  })
  const usableItems = usable.length
  const hasNonAggregate = usable.some(item => item.source !== 'agg')
  const onlyAggregate = usable.length > 0 && !hasNonAggregate
  if (onlyAggregate && options.aggregateIntent !== true && options.minItems === undefined) {
    return {
      status: 'insufficient',
      sufficient: false,
      usableItems,
      reason: '只有统计事实，缺少可直接核对的原文；请补充消息、知识库或资源证据',
    }
  }
  if (usableItems < minItems) {
    return {
      status: 'insufficient',
      sufficient: false,
      usableItems,
      reason: `可用证据不足（需要 ${minItems} 条，实际 ${usableItems} 条）`,
    }
  }
  return {
    status: 'sufficient',
    sufficient: true,
    usableItems,
    reason: `可用证据 ${usableItems} 条`,
  }
}

interface FactCandidate {
  tool: string
  fact: { title: string; body: string }
}

interface EvidenceAccumulator {
  itemsById: Map<string, EvidenceItem>
  failedTools: string[]
  factCandidates: FactCandidate[]
  attemptedResults: number
  successfulResults: number
  candidateCount: number
  duplicateCount: number
  malformedResults: number
  malformedHits: number
  malformedFacts: number
  scopeBlockedResults: number
  unsupportedScopeResults: number
  partialResults: number
  rejectedCount: number
  partialNotes: string[]
  rejectionNotes: string[]
  normalizationWarnings: string[]
}

interface EvidenceBudgetResult {
  items: EvidenceItem[]
  usedChars: number
  droppedByBudget: number
  truncated: boolean
}

interface EvidenceState {
  status: AnswerStatus
  missing: string[]
  citationGate: boolean
}

const SCOPE_FAILURE_CODES = new Set([
  'scope_violation',
  'tool_not_allowed',
  'data_scope_blocked',
  'scope_required',
])

/**
 * `unsupported_scope` 不是越界：工具明确表示「当前范围在我这个数据域上
 * 无法执行」，且没有返回任何数据。把它当成越界会清空同一轮其他工具的
 * 合法证据（例如固定时间窗下 `list_sessions` 不可用，但目标会话消息已取到）。
 */
const UNSUPPORTED_SCOPE_CODE = 'unsupported_scope'

function createEvidenceAccumulator(): EvidenceAccumulator {
  return {
    itemsById: new Map(),
    failedTools: [],
    factCandidates: [],
    attemptedResults: 0,
    successfulResults: 0,
    candidateCount: 0,
    duplicateCount: 0,
    malformedResults: 0,
    malformedHits: 0,
    malformedFacts: 0,
    scopeBlockedResults: 0,
    unsupportedScopeResults: 0,
    partialResults: 0,
    rejectedCount: 0,
    partialNotes: [],
    rejectionNotes: [],
    normalizationWarnings: [],
  }
}

function noteRejection(acc: EvidenceAccumulator, reason: string): void {
  acc.rejectedCount += 1
  if (acc.rejectionNotes.length < 8) acc.rejectionNotes.push(reason.slice(0, 200))
}

function mergeEvidenceItem(acc: EvidenceAccumulator, item: EvidenceItem): void {
  const existing = acc.itemsById.get(item.evidenceId)
  if (existing === undefined) {
    acc.itemsById.set(item.evidenceId, item)
    return
  }
  acc.duplicateCount += 1
  acc.itemsById.set(item.evidenceId, mergeItem(existing, item))
}

/** 归一单条 hit；返回 true 表示该条形状非法，使所属结果降级。 */
function ingestHit(
  acc: EvidenceAccumulator,
  tool: string,
  rawHit: unknown,
  index: number,
  options: BuildEvidenceOptions,
): boolean {
  const normalized = normalizeHit(tool, rawHit, index)
  acc.normalizationWarnings.push(...normalized.warnings)
  if (normalized.hit === undefined) {
    acc.malformedHits += 1
    return true
  }
  acc.candidateCount += 1
  const item = itemFromHit(tool, normalized.hit, index)
  let malformedReason = ''
  if (tool === 'search_kb' && item.source !== 'kb') {
    malformedReason = `${tool}.hits[${String(index)}] 必须是知识库来源，已拒绝`
  } else if (item.source === 'kb' && item.locator.type !== 'kb') {
    malformedReason = `${tool}.hits[${String(index)}] 知识库命中缺少可验证的 kbId/chunkId，已拒绝`
  } else if (
    item.source === 'msg'
    && MESSAGE_TOOLS.has(tool)
    && item.locator.type !== 'message'
  ) {
    malformedReason = `${tool}.hits[${String(index)}] 消息命中缺少可验证的 username/localId，已拒绝`
  }
  if (malformedReason !== '') {
    acc.malformedHits += 1
    acc.normalizationWarnings.push(malformedReason)
    return true
  }
  const violation = boundaryViolation(tool, item.source, item.locator, options)
  if (violation !== undefined) {
    noteRejection(acc, violation)
    return false
  }
  mergeEvidenceItem(acc, item)
  return false
}

/** 归一单条 fact；返回 true 表示形状非法。 */
function ingestFact(
  acc: EvidenceAccumulator,
  tool: string,
  rawFact: unknown,
  index: number,
  options: BuildEvidenceOptions,
): boolean {
  if (!isRecord(rawFact)
    || typeof rawFact.title !== 'string'
    || typeof rawFact.body !== 'string'
    || rawFact.body.trim() === '') {
    acc.malformedFacts += 1
    acc.normalizationWarnings.push(`${tool}.facts[${String(index)}] 形状非法，已拒绝`)
    return true
  }
  const fact = { title: rawFact.title, body: rawFact.body }
  const violation = allowsFact(tool, { type: 'fact', tool }, options)
  if (violation !== undefined) {
    noteRejection(acc, violation)
    return false
  }
  acc.candidateCount += 1
  acc.factCandidates.push({ tool, fact })
  return false
}

function ingestResult(
  acc: EvidenceAccumulator,
  rawResult: unknown,
  options: BuildEvidenceOptions,
): void {
  acc.attemptedResults += 1
  if (!isRecord(rawResult)) {
    acc.malformedResults += 1
    acc.normalizationWarnings.push('工具结果不是对象，已拒绝')
    return
  }
  const hasValidTool = typeof rawResult.tool === 'string' && rawResult.tool.trim() !== ''
  const tool = hasValidTool ? (rawResult.tool as string).trim() : 'unknown'
  if (rawResult.ok !== true) {
    if (rawResult.ok === false && hasValidTool) {
      acc.failedTools.push(tool)
      const errorCode = safeString(rawResult.errorCode)
      if (SCOPE_FAILURE_CODES.has(errorCode)) {
        acc.scopeBlockedResults += 1
        const message = safeString(rawResult.error).trim()
        if (message !== '' && acc.rejectionNotes.length < 8) {
          acc.rejectionNotes.push(`${tool}：${message}`.slice(0, 200))
        }
      } else if (errorCode === UNSUPPORTED_SCOPE_CODE) {
        acc.unsupportedScopeResults += 1
      }
    } else {
      acc.malformedResults += 1
      acc.normalizationWarnings.push(`${tool}.ok 缺失或类型非法，已拒绝`)
      if (hasValidTool) acc.failedTools.push(tool)
    }
    return
  }
  if (!hasValidTool) {
    acc.malformedResults += 1
    acc.normalizationWarnings.push('成功结果缺少 tool，已拒绝')
    return
  }
  const partialNote = typeof rawResult.note === 'string'
    && /可能不完整|结果不完整|partial/i.test(rawResult.note)
    ? rawResult.note.trim()
    : ''
  if (partialNote !== '') {
    acc.partialResults += 1
    if (acc.partialNotes.length < 8) acc.partialNotes.push(partialNote.slice(0, 200))
  }
  let malformedResult = false
  const hits: unknown[] = Array.isArray(rawResult.hits) ? rawResult.hits : []
  if (!Array.isArray(rawResult.hits)) {
    malformedResult = true
    acc.normalizationWarnings.push(`${tool}.hits 不是数组，已拒绝该容器`)
  }
  const facts: unknown[] = Array.isArray(rawResult.facts) ? rawResult.facts : []
  if (rawResult.facts !== undefined && !Array.isArray(rawResult.facts)) {
    malformedResult = true
    acc.normalizationWarnings.push(`${tool}.facts 不是数组，已拒绝该容器`)
  }
  // 根契约成立即计一次成功；条目级畸形仍可能带回可用证据，只让整包降级。
  if (!malformedResult) acc.successfulResults += 1
  hits.forEach((hit, index) => {
    if (ingestHit(acc, tool, hit, index, options)) malformedResult = true
  })
  facts.forEach((fact, index) => {
    if (ingestFact(acc, tool, fact, index, options)) malformedResult = true
  })
  if (malformedResult) acc.malformedResults += 1
}

function mergeFactCandidates(acc: EvidenceAccumulator): void {
  const collisionContents = new Map<string, Set<string>>()
  for (const { tool, fact } of acc.factCandidates) {
    const group = `${tool}\u0000${factBaseSlug(fact.title, fact.body)}`
    const contents = collisionContents.get(group) ?? new Set<string>()
    contents.add(factContentSignature(fact.title, fact.body))
    collisionContents.set(group, contents)
  }
  for (const { tool, fact } of acc.factCandidates) {
    const group = `${tool}\u0000${factBaseSlug(fact.title, fact.body)}`
    mergeEvidenceItem(acc, itemFromFact(tool, fact, collisionContents.get(group)))
  }
}

function applyEvidenceBudget(
  itemsById: ReadonlyMap<string, EvidenceItem>,
  options: BuildEvidenceOptions,
): EvidenceBudgetResult {
  const sorted = [...itemsById.values()].sort(compareEvidence)
  const maxItems = nonNegativeInt(options.maxItems, EVIDENCE_BUDGET_DEFAULTS.maxItems)
  const maxChars = nonNegativeInt(options.maxChars, EVIDENCE_BUDGET_DEFAULTS.maxChars)
  const kept: EvidenceItem[] = []
  let usedChars = 0
  let droppedByBudget = 0
  let truncated = false
  for (const item of sorted) {
    if (kept.length >= maxItems) {
      droppedByBudget += 1
      continue
    }
    const remaining = maxChars - usedChars
    if (remaining <= 0 && item.snippet !== '') {
      droppedByBudget += 1
      continue
    }
    const clipped = clipText(item.snippet, Math.max(0, remaining))
    if (clipped.truncated) truncated = true
    usedChars += charLength(clipped.text)
    kept.push({
      ...item,
      snippet: clipped.text,
      ...(clipped.truncated ? { truncated: true } : {}),
    })
  }
  return { items: kept, usedChars, droppedByBudget, truncated }
}

function summarizeEvidence(
  acc: EvidenceAccumulator,
  budget: EvidenceBudgetResult,
): EvidenceBundleStats {
  const sourceCounts: Record<EvidenceSource, number> = { msg: 0, kb: 0, agg: 0, resource: 0 }
  const toolCounts: Record<string, number> = {}
  const sessions = new Set<string>()
  let messageCount = 0
  for (const item of budget.items) {
    sourceCounts[item.source] += 1
    if (item.locator.type === 'message') {
      messageCount += 1
      sessions.add(item.locator.username)
    }
    for (const tool of item.tools) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + 1
    }
  }
  return {
    count: budget.items.length,
    messages: messageCount,
    kb: sourceCounts.kb,
    sessions: sessions.size,
    candidateCount: acc.candidateCount,
    total: budget.items.length,
    hitCount: budget.items.filter(item => item.kind === 'hit').length,
    factCount: budget.items.filter(item => item.kind === 'fact').length,
    duplicateCount: acc.duplicateCount,
    droppedByBudget: budget.droppedByBudget,
    truncated: budget.truncated,
    snippetChars: budget.usedChars,
    sourceCounts,
    toolCounts,
    failedTools: acc.failedTools,
    attemptedTools: acc.attemptedResults,
    successfulTools: acc.successfulResults,
    malformedResults: acc.malformedResults,
    malformedHits: acc.malformedHits,
    malformedFacts: acc.malformedFacts,
    partialResults: acc.partialResults,
    partialNotes: acc.partialNotes,
    rejectedCount: acc.rejectedCount,
    rejectionNotes: acc.rejectionNotes,
    scopeBlockedResults: acc.scopeBlockedResults,
    unsupportedScopeResults: acc.unsupportedScopeResults,
    normalizationWarnings: acc.normalizationWarnings,
  }
}

function resolveEvidenceState(
  acc: EvidenceAccumulator,
  assessment: EvidenceAssessment,
  options: BuildEvidenceOptions,
): EvidenceState {
  const hasMalformed = acc.malformedResults > 0
    || acc.malformedHits > 0
    || acc.malformedFacts > 0
  const allRootsFailed = acc.attemptedResults > 0
    && acc.successfulResults === 0
    && !hasMalformed
  const derivedStatus: AnswerStatus = acc.rejectedCount > 0 || acc.scopeBlockedResults > 0
    ? 'blocked'
    : assessment.usableItems === 0
      ? hasMalformed || allRootsFailed ? 'failed' : 'insufficient'
      : hasMalformed
        || acc.failedTools.length > 0
        || acc.unsupportedScopeResults > 0
        || acc.partialResults > 0
        ? 'degraded'
        : assessment.status === 'sufficient'
          ? 'ok'
          : 'insufficient'
  /*
   * 证据充分不等于回答可靠：`ok` 还必须由最终回答实际引用至少一条证据。
   * 未做引用复核时保留 `ok`；明确 `cited:false` 时最高只能是 `degraded`。
   */
  const citationGate = options.cited === false && derivedStatus === 'ok'
  const status = options.status ?? (citationGate ? 'degraded' : derivedStatus)
  const boundaryBlocked = status === 'blocked'
    && (acc.rejectedCount > 0 || acc.scopeBlockedResults > 0)
  const missing = [
    ...(status === 'insufficient' || status === 'failed' ? ['evidence'] : []),
    ...(boundaryBlocked ? ['scope'] : []),
    ...(citationGate ? ['citation'] : []),
    ...new Set(acc.failedTools),
  ]
  return { status, missing, citationGate }
}

function finalizeEvidenceBundle(
  acc: EvidenceAccumulator,
  options: BuildEvidenceOptions,
): EvidenceBundle {
  mergeFactCandidates(acc)
  const budget = applyEvidenceBudget(acc.itemsById, options)
  const assessment = assessEvidence(budget.items, options)
  const state = resolveEvidenceState(acc, assessment, options)
  /*
   * 边界阻断是整包结论：只要有一条越界拒绝，就不能再把同轮其他命中交给
   * 界面或无人值守入口。统计仍保留，便于解释为什么被阻断。
   */
  const blocked = state.status === 'blocked'
  const visibleBudget: EvidenceBudgetResult = blocked
    ? {
      items: [],
      usedChars: 0,
      droppedByBudget: budget.droppedByBudget,
      truncated: false,
    }
    : budget
  const facts = visibleBudget.items
    .filter(item => item.kind === 'fact')
    .map(item => ({ title: item.name, body: item.snippet }))
  return {
    items: visibleBudget.items,
    facts,
    status: state.status,
    missing: state.missing,
    stats: summarizeEvidence(acc, visibleBudget),
    assessment: {
      ...(blocked
        ? {
          status: 'missing',
          sufficient: false,
          usableItems: 0,
          needsCitation: false,
          reason: '证据越过数据边界，整包已阻断',
        }
        : assessment),
      ...(state.citationGate
        ? {
          sufficient: false,
          needsCitation: true,
          reason: `${assessment.reason}；但最终回答没有实际引用任何证据`,
        }
        : {}),
    },
  }
}

/**
 * 把多次工具结果收敛成一个有预算的证据包。
 *
 * 入参按 `unknown` 接收：主运行时可能在工具循环中途拿到未校验对象，
 * 这里只接受形状合法的 `ToolResult`；畸形 hit/fact 会逐条拒绝并计入统计，
 * 同一结果里仍有可用证据时整包降级而不是伪装成成功。
 *
 * @param results - 工具结果（顺序不影响排序与 evidenceId）。
 * @param options - 条数/字符预算与充分性阈值。
 * @returns 去重、排序、截断后的证据包。
 */
export function buildEvidenceBundle(
  results: readonly unknown[],
  options: BuildEvidenceOptions = {},
): EvidenceBundle {
  const acc = createEvidenceAccumulator()
  for (const result of results) ingestResult(acc, result, options)
  return finalizeEvidenceBundle(acc, options)
}
