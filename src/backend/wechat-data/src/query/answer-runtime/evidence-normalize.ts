/**
 * 证据结果的上游归一化与定位映射。
 *
 * 工具结果来自模型选择的工具与插件，形状不可信。本模块只处理单条结果：
 * 校验命中、生成稳定定位与引用形状，并复核 profile 的输出边界。证据包级别的
 * 去重、预算与状态判定仍由 `evidence.ts` 负责。
 *
 * @module query/answer-runtime/evidence-normalize
 */
import type { ToolHit } from '../tools/types.ts'
import type {
  BuildEvidenceOptions,
  CitationShape,
  EvidenceItem,
  EvidenceLocator,
  EvidenceSource,
} from './evidence-types.ts'

const MESSAGE_TOOLS = new Set([
  'search_messages',
  'search_semantic',
  'search_hybrid',
  'get_session_messages',
  'get_message_context',
])

export function safeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sourceOf(value: unknown): EvidenceSource {
  return value === 'kb' || value === 'agg' || value === 'resource' ? value : 'msg'
}

function parseMessageKey(key: string): { username: string; localId: number } | undefined {
  const m = /^(.+):(-?\d+)$/.exec(key)
  if (!m) return undefined
  const localId = Number(m[2])
  if (!Number.isSafeInteger(localId)) return undefined
  return { username: m[1] ?? '', localId }
}

function parseKbKey(key: string): { kbId: number; chunkId: number } | undefined {
  const m = /^kb:(\d+):(\d+)$/.exec(key)
  if (!m) return undefined
  const kbId = Number(m[1])
  const chunkId = Number(m[2])
  if (
    !Number.isSafeInteger(kbId)
    || !Number.isSafeInteger(chunkId)
    || kbId <= 0
    || chunkId <= 0
  ) {
    return undefined
  }
  return { kbId, chunkId }
}

function nonNegativeSafeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function positiveSafeInt(value: unknown): number | undefined {
  const n = nonNegativeSafeInt(value)
  return n !== undefined && n > 0 ? n : undefined
}

function fileExtFromName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

function kbLocator(hit: ToolHit, key: string, name: string): EvidenceLocator | undefined {
  const parsed = parseKbKey(key)
  const trace = hit.trace?.kind === 'kb' ? hit.trace : undefined
  const kbId = positiveSafeInt(trace?.kbId) ?? parsed?.kbId
  const chunkId = positiveSafeInt(trace?.chunkId) ?? parsed?.chunkId
  if (kbId === undefined || chunkId === undefined) return undefined
  // key 与 trace 同时存在时必须一致，否则无法证明这条引用指向真实块。
  if (
    parsed !== undefined
    && trace !== undefined
    && (parsed.kbId !== kbId || parsed.chunkId !== chunkId)
  ) {
    return undefined
  }
  return {
    type: 'kb',
    kbId,
    fileId: nonNegativeSafeInt(trace?.fileId) ?? 0,
    chunkId,
    key,
    fileName: name,
    fileExt: fileExtFromName(name),
    ordinal: nonNegativeSafeInt(trace?.ordinal) ?? 0,
    page: nonNegativeSafeInt(trace?.page) ?? 0,
    heading: safeString(trace?.heading),
  }
}

function messageLocator(hit: ToolHit, tool: string, key: string): EvidenceLocator | undefined {
  if (!MESSAGE_TOOLS.has(tool)) return undefined
  const parsed = parseMessageKey(key)
  if (parsed) {
    const trace = hit.trace?.kind === 'msg' ? hit.trace : undefined
    const traceLocalId = nonNegativeSafeInt(trace?.localId)
    if (
      trace !== undefined
      && (
        (safeString(trace.username) !== '' && safeString(trace.username) !== parsed.username)
        || (traceLocalId !== undefined && traceLocalId !== parsed.localId)
      )
    ) {
      return undefined
    }
    return {
      type: 'message',
      username: parsed.username,
      localId: parsed.localId,
      key,
    }
  }
  const trace = hit.trace?.kind === 'msg' ? hit.trace : undefined
  const username = safeString(trace?.username)
  const localId = nonNegativeSafeInt(trace?.localId)
  if (username !== '' && localId !== undefined) {
    return { type: 'message', username, localId, key }
  }
  return undefined
}

function hitLocator(
  tool: string,
  source: EvidenceSource,
  key: string,
  name: string,
  hit: ToolHit,
): EvidenceLocator {
  if (source === 'kb') {
    const kb = kbLocator(hit, key, name)
    if (kb) return kb
  }
  if (source === 'msg') {
    const message = messageLocator(hit, tool, key)
    if (message) return message
  }
  if (source === 'resource') {
    return resourceLocator(tool, key, hit)
  }
  return { type: 'resource', tool, key }
}

/**
 * 输出侧边界复核。
 *
 * 工具参数校验发生在执行前，但工具实现、旧插件或上游缓存仍可能返回越界结果。
 * 这里只返回拒绝原因，不改写命中；调用方把它计为边界拒绝并整包阻断。
 */
export function boundaryViolation(
  tool: string,
  source: EvidenceSource,
  locator: EvidenceLocator,
  options: BuildEvidenceOptions,
): string | undefined {
  const allowedUsername = options.allowedUsername?.trim() ?? ''
  if (allowedUsername !== '') {
    if (source !== 'msg') {
      return `${tool} 返回了非消息来源（${source}），当前会话问答只接受消息证据`
    }
    if (locator.type !== 'message' || locator.username !== allowedUsername) {
      return `${tool} 返回了其他会话的消息，已拒绝进入当前会话证据包`
    }
  }
  if (options.kbOnly === true) {
    if (source !== 'kb') {
      return `${tool} 返回了非知识库来源（${source}），kb-only 入口只接受知识库证据`
    }
    if (locator.type !== 'kb') {
      return `${tool} 的知识库命中缺少可验证定位，已拒绝`
    }
    if (
      options.allowedKbId !== undefined
      && Number.isSafeInteger(options.allowedKbId)
      && options.allowedKbId > 0
      && locator.kbId !== options.allowedKbId
    ) {
      return `${tool} 返回了知识库 ${String(locator.kbId)}，与本次选中的 ${String(options.allowedKbId)} 不一致`
    }
    return undefined
  }
  if (
    options.allowedKbId !== undefined
    && Number.isSafeInteger(options.allowedKbId)
    && options.allowedKbId > 0
  ) {
    if (source !== 'kb' || locator.type !== 'kb') {
      return `${tool} 返回了非知识库来源，当前知识库会话只接受 kb:${String(options.allowedKbId)}:*`
    }
    if (locator.kbId !== options.allowedKbId) {
      return `${tool} 返回了知识库 ${String(locator.kbId)}，与本次选中的 ${String(options.allowedKbId)} 不一致`
    }
  }
  return undefined
}

export function allowsFact(
  tool: string,
  locator: EvidenceLocator,
  options: BuildEvidenceOptions,
): string | undefined {
  if (options.kbOnly === true) {
    return `${tool} 返回了统计事实，kb-only 入口只接受知识库证据`
  }
  if (
    options.allowedKbId !== undefined
    && Number.isSafeInteger(options.allowedKbId)
    && options.allowedKbId > 0
  ) {
    return `${tool} 返回了统计事实，当前知识库会话只接受知识库证据`
  }
  const allowedUsername = options.allowedUsername?.trim() ?? ''
  if (allowedUsername !== '' && (tool !== 'aggregate_messages' || locator.type !== 'fact')) {
    return `${tool} 返回了无法验证会话归属的统计事实，已拒绝`
  }
  return undefined
}

function resourceText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function resourceNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function resourceLocator(tool: string, key: string, hit: ToolHit): EvidenceLocator {
  const trace = hit.trace?.kind === 'resource' ? hit.trace.resource : undefined
  const stableKey = resourceText(trace?.stableKey) ?? key
  const kind = trace?.resourceKind
  return {
    type: 'resource',
    tool,
    key,
    stableKey,
    ...(kind !== undefined ? { resourceKind: kind } : {}),
    ...(resourceText(trace?.time) !== undefined ? { time: trace?.time } : {}),
    ...(resourceText(trace?.session) !== undefined ? { session: trace?.session } : {}),
    ...(resourceText(trace?.sourceId) !== undefined ? { sourceId: trace?.sourceId } : {}),
    ...(resourceText(trace?.fileName) !== undefined ? { fileName: trace?.fileName } : {}),
    ...(resourceNumber(trace?.size) !== undefined ? { size: trace?.size } : {}),
    ...(resourceText(trace?.category) !== undefined ? { category: trace?.category } : {}),
    ...(resourceText(trace?.md5) !== undefined ? { md5: trace?.md5 } : {}),
    ...(resourceText(trace?.thumbMd5) !== undefined ? { thumbMd5: trace?.thumbMd5 } : {}),
    ...(resourceText(trace?.fullMd5) !== undefined ? { fullMd5: trace?.fullMd5 } : {}),
    ...(resourceNumber(trace?.favoriteId) !== undefined ? { favoriteId: trace?.favoriteId } : {}),
    ...(resourceText(trace?.serverId) !== undefined ? { serverId: trace?.serverId } : {}),
    ...(resourceText(trace?.transferId) !== undefined ? { transferId: trace?.transferId } : {}),
    ...(resourceText(trace?.messageServerId) !== undefined ? { messageServerId: trace?.messageServerId } : {}),
    ...(resourceText(trace?.timelineId) !== undefined ? { timelineId: trace?.timelineId } : {}),
    ...(resourceText(trace?.username) !== undefined ? { username: trace?.username } : {}),
    ...(resourceText(trace?.mediaId) !== undefined ? { mediaId: trace?.mediaId } : {}),
    ...(resourceText(trace?.mediaKind) !== undefined ? { mediaKind: trace?.mediaKind } : {}),
    ...(resourceText(trace?.url) !== undefined ? { url: trace?.url } : {}),
    ...(resourceText(trace?.token) !== undefined ? { token: trace?.token } : {}),
    ...(resourceText(trace?.seed) !== undefined ? { seed: trace?.seed } : {}),
    ...(trace?.recordType !== undefined ? { recordType: trace.recordType } : {}),
  }
}

function hitEvidenceId(
  tool: string,
  source: EvidenceSource,
  key: string,
  ordinal: number,
  locator: EvidenceLocator,
): string {
  if (source === 'msg') {
    if (locator.type === 'message') return `msg:${locator.username}:${locator.localId}`
    return key !== '' ? `hit:${tool}:${key}` : `hit:${tool}:${ordinal}`
  }
  if (source === 'kb') {
    if (locator.type === 'kb') return `kb:${locator.kbId}:${locator.chunkId}`
    return key !== '' ? `kb:${key}` : `kb:${tool}:${ordinal}`
  }
  if (source === 'agg') return key !== '' ? `agg:${tool}:${key}` : `agg:${tool}:${ordinal}`
  if (source === 'resource') return `res:${tool}:${key || ordinal}`
  return `hit:${tool}:${key || ordinal}`
}

function citationFromHit(
  source: EvidenceSource,
  hit: ToolHit,
  locator: EvidenceLocator,
): CitationShape | undefined {
  const sender = safeString(hit.sender)
  const base: CitationShape = {
    name: safeString(hit.name),
    time: safeString(hit.time),
    snippet: safeString(hit.snippet),
    username: '',
    local_id: 0,
    source,
  }
  if (locator.type === 'message') {
    return {
      ...base,
      username: locator.username,
      local_id: locator.localId,
      ...(sender === '' ? {} : { sender }),
    }
  }
  if (locator.type === 'kb') {
    return {
      ...base,
      kb: {
        kbId: locator.kbId,
        fileId: locator.fileId,
        fileName: locator.fileName,
        fileExt: locator.fileExt,
        chunkId: locator.chunkId,
        ordinal: locator.ordinal,
        page: locator.page,
        heading: locator.heading,
      },
    }
  }
  // 文件 / 收藏 / 朋友圈 / 联系人等资源没有 AskCitation 的 username/local_id，
  // 这里不伪造一个「看起来可点击」的引用；定位信息保留在 evidence.locator。
  return undefined
}

export function itemFromHit(tool: string, hit: ToolHit, ordinal: number): EvidenceItem {
  const source = sourceOf(hit.source)
  const key = safeString(hit.key)
  const name = safeString(hit.name)
  const score = safeScore(hit.score)
  const sender = safeString(hit.sender)
  const locator = hitLocator(tool, source, key, name, hit)
  const citation = citationFromHit(source, hit, locator)
  return {
    evidenceId: hitEvidenceId(tool, source, key, ordinal, locator),
    kind: 'hit',
    tool,
    tools: [tool],
    source,
    name,
    time: safeString(hit.time),
    ...(sender === '' ? {} : { sender }),
    snippet: safeString(hit.snippet),
    ...(score === undefined ? {} : { score }),
    key,
    locator,
    ...(citation === undefined ? {} : { citation }),
  }
}

export interface NormalizedHit {
  hit?: ToolHit
  warnings: string[]
}

export function normalizeHit(tool: string, raw: unknown, index: number): NormalizedHit {
  if (!isRecord(raw)) {
    return { warnings: [`${tool}.hits[${String(index)}] 不是对象，已拒绝`] }
  }
  const key = typeof raw.key === 'string' ? raw.key.trim() : ''
  const snippet = typeof raw.snippet === 'string' ? raw.snippet : ''
  const name = raw.name === undefined ? '' : raw.name
  const time = raw.time === undefined ? '' : raw.time
  if (key === '' || snippet.trim() === '' || typeof name !== 'string' || typeof time !== 'string') {
    return { warnings: [`${tool}.hits[${String(index)}] 缺少非空 key/snippet 或 name/time 类型非法，已拒绝`] }
  }

  const warnings: string[] = []
  const rawSource = raw.source
  const source = rawSource === 'msg' || rawSource === 'kb' || rawSource === 'agg' || rawSource === 'resource'
    ? rawSource
    : 'msg'
  if (
    rawSource !== undefined
    && (rawSource !== 'msg' && rawSource !== 'kb' && rawSource !== 'agg' && rawSource !== 'resource')
  ) {
    warnings.push(`${tool}.hits[${String(index)}].source 非法，已按 msg 归一`)
  }
  const sender = safeString(raw.sender)
  const score = safeScore(raw.score)
  const trace = isRecord(raw.trace) ? raw.trace as ToolHit['trace'] : undefined
  return {
    hit: {
      key,
      name,
      time,
      snippet,
      source,
      ...(sender === '' ? {} : { sender }),
      ...(score === undefined ? {} : { score }),
      ...(trace === undefined ? {} : { trace }),
    },
    warnings,
  }
}
