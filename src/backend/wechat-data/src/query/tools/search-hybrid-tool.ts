/**
 * `search_hybrid` 复合检索工具（2026-10-22 新增）。
 *
 * ## 为什么需要它
 *
 * 单一工具各有明确边界：`search_messages` 只做词法召回、`search_semantic` 只做
 * 向量召回、`aggregate_messages` 只做统计……模型在「不确定该选哪个」时常常选错，
 * 而选错的表现是**静默空结果**，不是报错。
 *
 * 这个工具把问答既有的混合检索流水线（稀疏 + 稠密 + 结构化 + 聚合 + 精排）
 * 暴露成一个稳定的兜底入口：模型只需要给问题与范围，不需要理解通道细节。
 *
 * ## 为什么不在这里 import `ask-retrieval`
 *
 * `ask-retrieval.ts` 会依赖 `tools/registry.ts`（装配工具集），若工具层再反向
 * import 它，就形成 `tools -> remotes -> tools` 的循环。这里只定义**执行器接口**，
 * 由装配层把 `runAskRetrieval` 包装后注入。这样：
 *   · 工具层零知识库/问答依赖，可单独测试；
 *   · 默认工具集仍包含该工具（未注入执行器时如实报「未配置」，而不是消失）。
 *
 * @module query/tools/search-hybrid-tool
 */
import {
  argInt, argString,
  type RetrievalTool, type ToolContext, type ToolErrorCode, type ToolHit, type ToolResult,
} from './types.ts'

/** 混合检索模式。 */
export type HybridSearchMode = 'auto' | 'messages' | 'kb'

/** 混合检索请求（已经过工具层校验与范围归一）。 */
export interface HybridSearchRequest {
  /** 用户问题（自然语言）。 */
  query: string
  /** 有效范围：会话与日期都已是「硬过滤」。 */
  scope: { username?: string; from?: string; to?: string }
  /** 最多返回多少条证据。 */
  limit: number
  /** auto = 消息 + 当前知识库；messages = 只查本机消息；kb = 只查知识库。 */
  mode: HybridSearchMode
  /** 是否要求附带确定性聚合事实。 */
  aggregate: boolean
}

/** 与 `AskCitation` 同形的引用（刻意结构化声明，避免工具层依赖 remotes）。 */
export interface HybridSearchCitation {
  name: string
  time: string
  snippet: string
  username: string
  local_id: number
  sender?: string
  source?: 'msg' | 'kb' | 'agg' | 'resource'
  kb?: {
    kbId: number
    fileId: number
    fileName: string
    fileExt: string
    chunkId: number
    ordinal: number
    page: number
    heading: string
  }
}

/** 与 `AskChunk` 同形的上下文窗口（只声明工具映射用到的字段）。 */
export interface HybridSearchChunk {
  name: string
  anchor: HybridSearchCitation
  lines: Array<{ time: string; day?: string; sender: string; text: string }>
}

/** 确定性统计事实。 */
export interface HybridSearchFact {
  title: string
  body: string
}

/** 执行器返回的结构化错误。 */
export interface HybridSearchExecutionError {
  code: ToolErrorCode
  message: string
  details?: Record<string, unknown>
}

/**
 * 执行器返回。
 *
 * 错误也放在返回值里而不是抛异常：工具层要把「范围错误」「未配置」等稳定类别
 * 原样回给运行时，不能靠解析异常消息。
 */
export interface HybridSearchExecution {
  citations: HybridSearchCitation[]
  chunks?: HybridSearchChunk[]
  terms?: string[]
  facts?: HybridSearchFact[]
  rerankLine?: string
  error?: HybridSearchExecutionError
}

/**
 * 混合检索执行器。
 *
 * 由装配层实现（通常是 `runAskRetrieval` 的薄包装）。工具层不关心它内部用了
 * 哪些通道，只要求返回统一证据形状。
 */
export type HybridSearchExecutor = (
  request: HybridSearchRequest,
  ctx: ToolContext,
) => Promise<HybridSearchExecution> | HybridSearchExecution

const MODES: readonly HybridSearchMode[] = ['auto', 'messages', 'kb']

/** 日期必须是 `YYYY-MM-DD`（与其余工具/水线一致）。 */
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 失败结果（统一补 `tool` 与空 `hits`）。 */
function fail(code: ToolErrorCode, error: string, details?: Record<string, unknown>): ToolResult {
  return {
    tool: 'search_hybrid',
    ok: false,
    error,
    errorCode: code,
    ...(details ? { errorDetails: details } : {}),
    hits: [],
  }
}

/** 解析可选日期并校验格式；返回空串表示未提供。 */
function readDay(args: Record<string, unknown>, key: 'from' | 'to'): { ok: true; value: string } | { ok: false; error: ToolResult } {
  if (args[key] !== undefined && typeof args[key] !== 'string') {
    return {
      ok: false,
      error: fail('invalid_arguments', `${key} 必须是字符串`, { argument: key }),
    }
  }
  const raw = argString(args[key]).trim()
  if (raw === '') return { ok: true, value: '' }
  const m = DAY_RE.exec(raw)
  const year = Number(m?.[1] ?? NaN)
  const month = Number(m?.[2] ?? NaN)
  const day = Number(m?.[3] ?? NaN)
  // 正则只保证形状；`2026-99-99` 同样能匹配，但它会被 `new Date` 滚到下一年，
  // 于是一个手滑的日期会静默变成另一个时间窗。这里校验日历合法性。
  const probe = new Date(year, month - 1, day)
  const valid = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
    && probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
  if (!valid) {
    return {
      ok: false,
      error: fail('invalid_arguments', `${key} 必须是 YYYY-MM-DD`, { argument: key, value: raw }),
    }
  }
  return { ok: true, value: raw }
}

/**
 * 会话是身份边界，必须硬拒绝；日期是执行范围，可以收敛。
 *
 * 模型常按用户原文传入完整区间，而本轮上下文可能只锁定了其中一天。此时把
 * 请求日期收敛到锁定范围并记录修复即可；直接判 `scope_violation` 会让同一轮
 * 其他工具的合法证据一起被清空（表现为“这次没法开始检索”）。
 */
function conflict(locked: string | undefined, requested: string, key: 'username'): ToolResult | undefined {
  const hard = (locked ?? '').trim()
  if (hard === '' || requested === '') return undefined
  if (hard === requested) return undefined
  return fail('scope_violation', `${key} 与本次固定范围不一致`, {
    argument: key,
    locked: hard,
    requested,
  })
}

/** 记录一个被收敛到固定范围的日期参数。 */
function dateAdjustment(
  locked: string | undefined,
  requested: string,
  key: 'from' | 'to',
): string | undefined {
  const hard = (locked ?? '').trim()
  if (hard === '' || requested === '' || hard === requested) return undefined
  return `${key}: 「${requested}」已按本轮固定范围收敛为 ${hard}`
}

/**
 * 把引用映射成可溯源命中；聚合事实单独进 `facts`。
 *
 * 混合检索流水线已经完成了融合与重排，`citations` 的顺序就是最终名次。
 * 这里必须把名次写成显式 `score`：证据层对无分命中会退回「时间倒序」，
 * 于是最新但无关的消息会顶掉真正排第一的引用，接地回炉也会拿错原文。
 */
function citationsToHits(citations: readonly HybridSearchCitation[]): ToolHit[] {
  const seen = new Set<string>()
  const hits: ToolHit[] = []
  for (const [rank, c] of citations.entries()) {
    const source = c.source ?? 'msg'
    if (source === 'agg') continue
    // 名次越靠前分越高；只为保留相对顺序，不把内部融合分暴露给模型。
    const score = 1 / (rank + 1)
    if (source === 'kb') {
      const kbId = c.kb?.kbId
      const chunkId = c.kb?.chunkId
      const key = kbId !== undefined && chunkId !== undefined
        ? `kb:${String(kbId)}:${String(chunkId)}`
        : (c.username || `kb:unknown:${String(c.local_id)}`)
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({
        key,
        name: c.kb?.fileName || c.name,
        time: '',
        snippet: c.snippet,
        source: 'kb',
        score,
        trace: {
          kind: 'kb',
          ...(c.kb ? {
            kbId: c.kb.kbId,
            fileId: c.kb.fileId,
            chunkId: c.kb.chunkId,
            ordinal: c.kb.ordinal,
            page: c.kb.page,
            heading: c.kb.heading,
          } : {}),
        },
      })
      continue
    }
    const key = `${c.username}:${String(c.local_id)}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({
      key,
      name: c.name,
      time: c.time,
      snippet: c.snippet,
      ...(c.sender ? { sender: c.sender } : {}),
      source: 'msg',
      score,
      trace: { kind: 'msg', username: c.username, localId: c.local_id },
    })
  }
  return hits
}

/** 从聚合块里回收事实（执行器没单独给 facts 时的兜底）。 */
function factsFromChunks(chunks: readonly HybridSearchChunk[] | undefined): HybridSearchFact[] {
  if (!chunks) return []
  return chunks
    .filter(c => c.anchor.source === 'agg')
    .map(c => ({
      title: c.anchor.name || '统计结果',
      body: c.lines.map(l => l.text).filter(Boolean).join('\n') || c.anchor.snippet,
    }))
    .filter(f => f.body !== '')
}

/** 从聚合引用里回收事实（执行器可能只给 citations）。 */
function factsFromCitations(citations: readonly HybridSearchCitation[]): HybridSearchFact[] {
  return citations
    .filter(c => c.source === 'agg')
    .map(c => ({ title: c.name || '统计结果', body: c.snippet }))
    .filter(f => f.body !== '')
}

/** 事实去重（同一标题+正文只留一条）。 */
function dedupeFacts(facts: readonly HybridSearchFact[]): HybridSearchFact[] {
  const out: HybridSearchFact[] = []
  const seen = new Set<string>()
  for (const f of facts) {
    const key = `${f.title}\u0000${f.body}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title: f.title, body: f.body })
  }
  return out
}

/**
 * 创建 `search_hybrid` 工具。
 *
 * @param executor - 混合检索执行器；缺省时工具仍出现在清单里，但执行会如实报
 *   `not_configured`（与 `search_semantic` 未注入 embedding 时的策略一致）。
 * @returns 工具描述。
 */
export function makeSearchHybridTool(executor?: HybridSearchExecutor): RetrievalTool {
  return {
    name: 'search_hybrid',
    category: 'message',
    description:
      '混合检索兜底工具：当你不确定该用哪个检索工具时用它。'
      + '它会同时尝试关键词、语义、结构化时间/实体、聚合与知识库，并返回去重后的证据。'
      + '适用于「先帮我找找看」「综合查一下」「既可能在聊天里也可能在文件里」这类问题。'
      + '已知只需要精确关键词时优先 search_messages；明确只要统计时优先 aggregate_messages；'
      + '明确只要知识库时用 search_kb 或设置 mode="kb"。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用自然语言描述要找什么（必填）' },
        username: { type: 'string', description: '限定会话标识（不填 = 全部会话；会话内问答由服务端强制）' },
        from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
        to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
        limit: { type: 'number', description: '最多返回几条证据（默认 24，上限 60）' },
        mode: {
          type: 'string',
          enum: ['auto', 'messages', 'kb'],
          description: 'auto = 消息 + 当前知识库（默认）；messages = 只查本机消息；kb = 只查知识库',
        },
        aggregate: { type: 'boolean', description: '是否同时返回确定性统计事实（知识库模式不支持）' },
      },
      required: ['query'],
    },
    run: async (args, ctx): Promise<ToolResult> => {
      const started = Date.now()
      const query = argString(args['query']).trim()
      if (query === '') return fail('invalid_arguments', '缺少 query', { argument: 'query' })

      if (args['mode'] !== undefined && typeof args['mode'] !== 'string') {
        return fail('invalid_arguments', 'mode 必须是字符串', { argument: 'mode' })
      }
      const modeRaw = argString(args['mode']).trim()
      if (modeRaw !== '' && !MODES.includes(modeRaw as HybridSearchMode)) {
        return fail('invalid_arguments', 'mode 只能是 auto / messages / kb', { argument: 'mode', value: modeRaw })
      }
      const mode = (modeRaw || 'auto') as HybridSearchMode

      const from = readDay(args, 'from')
      if (!from.ok) return from.error
      const to = readDay(args, 'to')
      if (!to.ok) return to.error
      if (from.value !== '' && to.value !== '' && from.value > to.value) {
        return fail('invalid_arguments', 'from 不能晚于 to', { from: from.value, to: to.value })
      }

      if (args['username'] !== undefined && typeof args['username'] !== 'string') {
        return fail('invalid_arguments', 'username 必须是字符串', { argument: 'username' })
      }
      const requestedUser = argString(args['username']).trim()
      const userConflict = conflict(ctx.scope?.username, requestedUser, 'username')
      if (userConflict) return userConflict
      const adjustments = [
        dateAdjustment(ctx.scope?.from, from.value, 'from'),
        dateAdjustment(ctx.scope?.to, to.value, 'to'),
      ].filter((item): item is string => item !== undefined)

      const username = (ctx.scope?.username || requestedUser).trim()
      const effectiveFrom = (ctx.scope?.from || from.value).trim()
      const effectiveTo = (ctx.scope?.to || to.value).trim()
      if (args['aggregate'] !== undefined && typeof args['aggregate'] !== 'boolean') {
        return fail('invalid_arguments', 'aggregate 必须是布尔值', { argument: 'aggregate' })
      }
      const aggregate = args['aggregate'] === true

      if (mode === 'kb' && username !== '') {
        return fail('scope_violation', '知识库模式不接受会话范围', { argument: 'username', requested: username })
      }
      if (mode === 'kb' && aggregate) {
        return fail('invalid_arguments', '知识库模式不支持聚合统计', { argument: 'aggregate' })
      }
      /*
       * 只有显式 `mode='kb'` 才要求知识库；`auto` 没选库时是合法的
       * （用户本来就可能只问聊天记录），执行器只查本机消息即可。
       * 在这里就报「未配置」会把一个本可回答的问题挡掉。
       */
      if (mode === 'kb' && (ctx.kbId === undefined || ctx.kbId <= 0)) {
        return fail('not_configured', '当前没有选中知识库', { mode })
      }
      /*
       * 数据面闸门：`ctx` 上的 `wechatDataEnabled` 由运行时写入。
       *
       * `ToolContext` 是共享契约，这里用结构化读取而不是改它的必填字段：旧调用方
       * 不传时默认允许（保持既有行为），只有明确 `false` 才阻断。
       */
      const wechatAllowed = ctx.wechatDataEnabled !== false
      if (mode !== 'kb' && !wechatAllowed) {
        return fail('data_scope_blocked', '当前问答禁止访问本机微信数据', { mode })
      }
      if (aggregate && !wechatAllowed) {
        return fail('data_scope_blocked', '当前问答禁止访问本机微信数据', { mode, argument: 'aggregate' })
      }

      if (!executor) {
        return fail('not_configured', '混合检索执行器未配置', { mode })
      }

      const limit = argInt(args['limit'], 24, 1, 60)
      const request: HybridSearchRequest = {
        query,
        scope: {
          ...(username !== '' ? { username } : {}),
          ...(effectiveFrom !== '' ? { from: effectiveFrom } : {}),
          ...(effectiveTo !== '' ? { to: effectiveTo } : {}),
        },
        limit,
        mode,
        aggregate,
      }

      let result: HybridSearchExecution
      try {
        result = await executor(request, ctx)
      } catch (e) {
        const msg = (e as { message?: unknown } | null | undefined)?.message
        return fail('upstream_failure', typeof msg === 'string' && msg !== '' ? msg : String(e), { mode })
      }
      if (result.error) {
        return fail(result.error.code, result.error.message, result.error.details)
      }

      // 执行器理应按 limit 返回；这里再截一次，防止某个装配实现漏了上限，
      // 把超出模型请求的证据塞进上下文（既费预算也改变排序语义）。
      const citations = Array.isArray(result.citations) ? result.citations : []
      const chunks = Array.isArray(result.chunks) ? result.chunks : []
      const executorFacts = Array.isArray(result.facts) ? result.facts : []
      const hits = citationsToHits(citations).slice(0, limit)
      // 三个来源都收：执行器可能只给 facts，也可能只给带 source='agg' 的 chunks/citations。
      // 去重避免同一统计既在 facts 又在聚合引用里出现两遍。
      const facts = dedupeFacts([
        ...executorFacts,
        ...factsFromCitations(citations),
        ...factsFromChunks(chunks),
      ])
      const modeLabel = mode === 'kb' ? '仅知识库' : mode === 'messages' ? '仅本机消息' : '消息 + 知识库'
      const notes = [
        `「${query}」`,
        modeLabel,
        `${hits.length} 条证据`,
        ...(facts.length > 0 ? [`${facts.length} 条统计`] : []),
        ...(Array.isArray(result.terms) && result.terms.length > 0
          ? [`词项 ${result.terms.slice(0, 6).join('/')}`]
          : []),
        ...adjustments,
      ]
      return {
        tool: 'search_hybrid',
        ok: true,
        hits,
        ...(facts.length > 0 ? { facts } : {}),
        note: notes.join(' · '),
        elapsedMs: Date.now() - started,
      }
    },
  }
}
