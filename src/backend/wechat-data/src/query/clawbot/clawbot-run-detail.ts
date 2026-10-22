/**
 * ClawBot 自动回复运行详情的落库摘要。
 *
 * 这一层只负责把 {@link ClawbotReplyRunDetail} 压成字段白名单 JSON、解析旧行，
 * 以及合并少量终态字段。所有函数都必须容错：调用方在自动回复主循环和消息列表里，
 * 诊断信息不可写或不可读不能反过来中断回复/列表。
 *
 * @module query/clawbot/clawbot-run-detail
 */
import type {
  ClawbotReplyAskResult,
  ClawbotReplyRunDetail,
  ClawbotReplySendDecision,
} from './clawbot-reply-types.ts'

/** 运行详情落库预算：字段白名单 + 条数/字符串/总字节上限。 */
const RUN_DETAIL_MAX_BYTES = 64 * 1024
const RUN_DETAIL_MAX_ITEMS = 40
const RUN_DETAIL_TEXT = 500
const RUN_DETAIL_SHORT = 160

function detailText(value: unknown, limit: number = RUN_DETAIL_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

function detailNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function detailBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function detailRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function detailArray(value: unknown, limit: number = RUN_DETAIL_MAX_ITEMS): unknown[] {
  return Array.isArray(value) ? value.slice(0, limit) : []
}

/**
 * 受限深拷贝：只用于统计/线程状态这类无需逐字段手写的对象。
 * 丢弃函数、Symbol、BigInt（会破坏 JSON）、超深对象与循环引用。
 */
function boundedValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.length <= RUN_DETAIL_TEXT ? value : value.slice(0, RUN_DETAIL_TEXT) + '…'
  if (typeof value !== 'object' || depth <= 0 || seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    return value.slice(0, RUN_DETAIL_MAX_ITEMS)
      .map(item => boundedValue(item, depth - 1, seen))
      .filter(item => item !== undefined)
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    if (key === 'answer' || key === 'content' || key === 'url' || key === 'token' || key === 'seed') continue
    const safe = boundedValue(item, depth - 1, seen)
    if (safe !== undefined) out[key] = safe
  }
  return out
}

function boundedRecord(value: unknown, depth: number = 4): Record<string, unknown> | undefined {
  const record = detailRecord(value)
  if (record === undefined) return undefined
  const safe = boundedValue(record, depth, new WeakSet<object>())
  return detailRecord(safe)
}

/** 资源定位只保留展示/回查字段；URL、token、seed 永不落库。 */
function sanitizeLocator(value: unknown): Record<string, unknown> | undefined {
  const locator = detailRecord(value)
  if (locator === undefined) return undefined
  const type = detailText(locator['type'], RUN_DETAIL_SHORT)
  if (type === 'message') {
    return {
      type,
      username: detailText(locator['username'], RUN_DETAIL_SHORT),
      localId: detailNumber(locator['localId']),
      key: detailText(locator['key'], RUN_DETAIL_SHORT),
    }
  }
  if (type === 'kb') {
    return {
      type,
      kbId: detailNumber(locator['kbId']),
      fileId: detailNumber(locator['fileId']),
      chunkId: detailNumber(locator['chunkId']),
      key: detailText(locator['key'], RUN_DETAIL_SHORT),
      fileName: detailText(locator['fileName'], RUN_DETAIL_SHORT),
      fileExt: detailText(locator['fileExt'], 20),
      ordinal: detailNumber(locator['ordinal']),
      page: detailNumber(locator['page']),
      heading: detailText(locator['heading'], RUN_DETAIL_SHORT),
    }
  }
  if (type === 'fact') {
    return {
      type,
      tool: detailText(locator['tool'], RUN_DETAIL_SHORT),
      index: detailNumber(locator['index']),
      title: detailText(locator['title'], RUN_DETAIL_SHORT),
      bodyDigest: detailText(locator['bodyDigest'], RUN_DETAIL_SHORT),
      key: detailText(locator['key'], RUN_DETAIL_SHORT),
    }
  }
  if (type === 'resource') {
    const out: Record<string, unknown> = {
      type,
      tool: detailText(locator['tool'], RUN_DETAIL_SHORT),
      key: detailText(locator['key'], RUN_DETAIL_SHORT),
      stableKey: detailText(locator['stableKey'], RUN_DETAIL_SHORT),
      resourceKind: detailText(locator['resourceKind'], 20),
      time: detailText(locator['time'], 40),
      session: detailText(locator['session'], RUN_DETAIL_SHORT),
      sourceId: detailText(locator['sourceId'], RUN_DETAIL_SHORT),
      fileName: detailText(locator['fileName'], RUN_DETAIL_SHORT),
      size: detailNumber(locator['size']),
      category: detailText(locator['category'], 40),
      md5: detailText(locator['md5'], 64),
      thumbMd5: detailText(locator['thumbMd5'], 64),
      fullMd5: detailText(locator['fullMd5'], 64),
      favoriteId: detailNumber(locator['favoriteId']),
      serverId: detailText(locator['serverId'], RUN_DETAIL_SHORT),
      transferId: detailText(locator['transferId'], RUN_DETAIL_SHORT),
      messageServerId: detailText(locator['messageServerId'], RUN_DETAIL_SHORT),
      timelineId: detailText(locator['timelineId'], RUN_DETAIL_SHORT),
      username: detailText(locator['username'], RUN_DETAIL_SHORT),
      mediaId: detailText(locator['mediaId'], RUN_DETAIL_SHORT),
      mediaKind: detailText(locator['mediaKind'], 20),
      recordType: detailText(locator['recordType'], 20),
    }
    for (const [key, item] of Object.entries(out)) if (item === undefined) delete out[key]
    return out
  }
  return undefined
}

function sanitizeToolCall(value: unknown): Record<string, unknown> | undefined {
  const call = detailRecord(value)
  if (call === undefined) return undefined
  const name = detailText(call['name'], RUN_DETAIL_SHORT)
  if (name === undefined) return undefined
  return {
    index: detailNumber(call['index']),
    round: detailNumber(call['round']),
    callId: detailText(call['callId'], RUN_DETAIL_SHORT),
    name,
    argumentsSummary: detailText(call['argumentsSummary']),
    ok: detailBool(call['ok']) ?? false,
    deduplicated: detailBool(call['deduplicated']) ?? false,
    attempts: detailNumber(call['attempts']),
    retries: detailNumber(call['retries']),
    elapsedMs: detailNumber(call['elapsedMs']),
    errorClass: detailText(call['errorClass'], 40),
    errorCode: detailText(call['errorCode'], 80),
    errorMessage: detailText(call['errorMessage'], RUN_DETAIL_SHORT),
    hits: detailNumber(call['hits']),
    facts: detailNumber(call['facts']),
    deadlineExceeded: detailBool(call['deadlineExceeded']),
    skipped: detailBool(call['skipped']),
    note: detailText(call['note'], RUN_DETAIL_SHORT),
  }
}

function sanitizeEvidenceItem(value: unknown): Record<string, unknown> | undefined {
  const item = detailRecord(value)
  if (item === undefined) return undefined
  const evidenceId = detailText(item['evidenceId'], RUN_DETAIL_SHORT)
  if (evidenceId === undefined) return undefined
  const citation = detailRecord(item['citation'])
  return {
    evidenceId,
    kind: detailText(item['kind'], 20),
    tool: detailText(item['tool'], 80),
    tools: detailArray(item['tools'], 12)
      .map(tool => detailText(tool, 80))
      .filter((tool): tool is string => tool !== undefined),
    source: detailText(item['source'], 20),
    name: detailText(item['name'], RUN_DETAIL_SHORT),
    time: detailText(item['time'], 40),
    sender: detailText(item['sender'], RUN_DETAIL_SHORT),
    snippet: detailText(item['snippet']),
    score: detailNumber(item['score']),
    key: detailText(item['key'], RUN_DETAIL_SHORT),
    locator: sanitizeLocator(item['locator']),
    citation: citation === undefined
      ? undefined
      : {
          name: detailText(citation['name'], RUN_DETAIL_SHORT),
          time: detailText(citation['time'], 40),
          snippet: detailText(citation['snippet']),
          username: detailText(citation['username'], RUN_DETAIL_SHORT),
          local_id: detailNumber(citation['local_id']),
          sender: detailText(citation['sender'], RUN_DETAIL_SHORT),
          source: detailText(citation['source'], 20),
          kb: boundedRecord(citation['kb'], 2),
        },
    truncated: detailBool(item['truncated']),
    fact: detailBool(item['fact']),
  }
}

function sanitizeEvidence(value: unknown): Record<string, unknown> | undefined {
  const evidence = detailRecord(value)
  if (evidence === undefined) return undefined
  return {
    items: detailArray(evidence['items']).map(sanitizeEvidenceItem)
      .filter((item): item is Record<string, unknown> => item !== undefined),
    facts: detailArray(evidence['facts'], 20).map((value) => {
      const fact = detailRecord(value)
      return fact === undefined
        ? undefined
        : { title: detailText(fact['title'], RUN_DETAIL_SHORT), body: detailText(fact['body']) }
    }).filter(fact => fact !== undefined),
    status: detailText(evidence['status'], 40),
    missing: detailArray(evidence['missing'], 20)
      .map(item => detailText(item, RUN_DETAIL_SHORT))
      .filter((item): item is string => item !== undefined),
    stats: boundedRecord(evidence['stats'], 4),
    assessment: boundedRecord(evidence['assessment'], 3),
  }
}

function sanitizeCitation(value: unknown): Record<string, unknown> | undefined {
  const citation = detailRecord(value)
  if (citation === undefined) return undefined
  return {
    name: detailText(citation['name'], RUN_DETAIL_SHORT),
    time: detailText(citation['time'], 40),
    snippet: detailText(citation['snippet']),
    username: detailText(citation['username'], RUN_DETAIL_SHORT),
    local_id: detailNumber(citation['local_id']),
    index: detailNumber(citation['index']),
    evidenceId: detailText(citation['evidenceId'], RUN_DETAIL_SHORT),
    locator: sanitizeLocator(citation['locator']),
    sender: detailText(citation['sender'], RUN_DETAIL_SHORT),
    source: detailText(citation['source'], 20),
    kb: boundedRecord(citation['kb'], 2),
  }
}

function sanitizeResource(value: unknown): Record<string, unknown> | undefined {
  const resource = detailRecord(value)
  if (resource === undefined) return undefined
  return {
    evidenceId: detailText(resource['evidenceId'], RUN_DETAIL_SHORT),
    tool: detailText(resource['tool'], 80),
    key: detailText(resource['key'], RUN_DETAIL_SHORT),
    name: detailText(resource['name'], RUN_DETAIL_SHORT),
    time: detailText(resource['time'], 40),
    snippet: detailText(resource['snippet']),
    locator: sanitizeLocator(resource['locator']),
  }
}

function compactDetail(detail: ClawbotReplyRunDetail): Record<string, unknown> {
  const sendDecision: ClawbotReplySendDecision | undefined = detail.sendDecision
  const grounding = detail.grounding
  return {
    runId: detail.runId,
    status: detail.status,
    answerStatus: detail.answerStatus,
    statusReason: detailText(detail.statusReason),
    synthesisError: detailText(detail.synthesisError),
    toolCalls: detailArray(detail.toolCalls).map(sanitizeToolCall)
      .filter((call): call is Record<string, unknown> => call !== undefined),
    evidence: sanitizeEvidence(detail.evidence),
    citations: detailArray(detail.citations).map(sanitizeCitation)
      .filter((citation): citation is Record<string, unknown> => citation !== undefined),
    resources: detailArray(detail.resources).map(sanitizeResource)
      .filter((resource): resource is Record<string, unknown> => resource !== undefined),
    grounding: grounding === undefined
      ? undefined
      : {
          checked: detailNumber(grounding.checked) ?? 0,
          unsupported: detailArray(grounding.unsupported, 20)
            .map(item => detailText(item, RUN_DETAIL_SHORT))
            .filter((item): item is string => item !== undefined),
          cited: detailNumber(grounding.cited) ?? 0,
          repaired: grounding.repaired === true,
        },
    sendDecision: sendDecision === undefined
      ? undefined
      : {
          send: sendDecision.send === true,
          detail: detailText(sendDecision.detail),
          error: detailText(sendDecision.error),
          errorCode: detailText(sendDecision.errorCode, 80),
          reason: detailText(sendDecision.reason),
        },
    errorCode: detailText(detail.errorCode, 80),
    error: detailText(detail.error),
    appliedThreadState: boundedRecord(detail.appliedThreadState, 3),
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 把运行详情压成可落库白名单 JSON。
 *
 * 失败（循环引用、BigInt、超长）时逐级降级，最终只保留最小诊断字段；
 * 本函数保证不抛异常，因为调用方在自动回复主循环里。
 */
export function serializeReplyRunDetail(detail: ClawbotReplyRunDetail): string {
  let compact: Record<string, unknown>
  try {
    compact = compactDetail(detail)
  } catch {
    compact = {
      runId: detail.runId,
      status: detail.status,
      errorCode: detailText(detail.errorCode, 80),
      error: detailText(detail.error),
    }
  }
  let json = JSON.stringify(compact)
  if (byteLength(json) > RUN_DETAIL_MAX_BYTES) {
    compact['toolCalls'] = []
    compact['evidence'] = undefined
    compact['citations'] = []
    compact['resources'] = []
    json = JSON.stringify(compact)
  }
  if (byteLength(json) > RUN_DETAIL_MAX_BYTES) {
    compact = {
      runId: detail.runId,
      status: detail.status,
      statusReason: detailText(detail.statusReason),
      synthesisError: detailText(detail.synthesisError),
      sendDecision: compact['sendDecision'],
      errorCode: detailText(detail.errorCode, 80),
      error: detailText(detail.error),
    }
    json = JSON.stringify(compact)
  }
  return byteLength(json) > RUN_DETAIL_MAX_BYTES
    ? JSON.stringify({ runId: detail.runId, status: detail.status, errorCode: 'run_detail_too_large' })
    : json
}

/** 解析旧行/坏 JSON/超范围字段；失败返回 null，绝不把异常抛给消息列表。 */
export function parseReplyRunDetail(json: string | null): ClawbotReplyRunDetail | null {
  if (json === null || json === '') return null
  try {
    const parsed = JSON.parse(json) as unknown
    const record = detailRecord(parsed)
    if (record === undefined) return null
    const runId = detailNumber(record['runId'])
    const status = detailText(record['status'], 40)
    if (runId === undefined || runId <= 0 || status === undefined) return null
    return compactDetail(parsed as ClawbotReplyRunDetail) as unknown as ClawbotReplyRunDetail
  } catch {
    return null
  }
}

/** 以旧摘要为底覆盖少数终态字段（例如发送失败覆盖 sendDecision）。 */
export function mergeReplyRunDetail(
  json: string | null,
  runId: number,
  patch: Partial<ClawbotReplyRunDetail>,
): string {
  const base = parseReplyRunDetail(json)
  return serializeReplyRunDetail({
    status: base?.status ?? 'failed',
    ...base,
    ...patch,
    runId,
  })
}

/** 从注入的 ask 结果构造落库摘要；成功/降级/拒绝发送共用同一口径。 */
export function replyRunDetailJson(
  runId: number,
  result: ClawbotReplyAskResult,
  patch: Partial<ClawbotReplyRunDetail> = {},
): string {
  return serializeReplyRunDetail({
    status: result.status ?? (result.ok ? 'ok' : 'failed'),
    answerStatus: result.status,
    statusReason: result.statusReason,
    synthesisError: result.synthesisError,
    toolCalls: result.toolCalls,
    evidence: result.evidence,
    citations: result.citations,
    resources: result.resources,
    grounding: result.grounding,
    sendDecision: result.sendDecision ?? { send: result.ok },
    errorCode: result.errorCode,
    error: result.error,
    appliedThreadState: result.appliedThreadState,
    ...patch,
    runId,
  })
}
