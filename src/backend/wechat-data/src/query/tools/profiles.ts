/**
 * 问答工具 profile（2026-10-22 新增）。
 *
 * ## 为什么要有 profile
 *
 * 同一套工具会被三个入口复用，但它们的数据边界不同：
 *   · 微信问答：可以查本机微信数据与当前知识库；
 *   · 会话内 AI 问答：**只能**查当前会话，跨会话结果就是泄漏；
 *   · ClawBot 自动回复：`kb-only`，禁止碰任何本机微信数据。
 *
 * 只在提示词里写「不要查别的会话」不够：模型可能选错工具、填错 username，
 * 甚至被外部消息诱导。所以白名单与范围必须落在**执行层**，而不是只过滤 schema。
 *
 * 本模块提供三组纯函数：
 *   · {@link filterToolsForProfile}：只保留白名单内的工具；
 *   · {@link enforceProfileScope}：校验工具、范围与 hybrid 模式（不执行数据访问）；
 *   · {@link buildProfileTools}：过滤并包一层执行守卫（即使直接调 `.run` 也绕不过）；
 * 以及 {@link runProfileTool}：按名字执行，越界工具返回 `tool_not_allowed`。
 *
 * @module query/tools/profiles
 */
import { runTool } from './registry.ts'
import {
  argString,
  type RetrievalTool,
  type ToolContext,
  type ToolErrorCode,
  type ToolName,
  type ToolResult,
} from './types.ts'
import type { HybridSearchMode } from './search-hybrid-tool.ts'

/** profile 标识（调用方用稳定字符串选择边界）。 */
export type AnswerProfileId = 'wechat-ask' | 'session-ask' | 'clawbot-auto'

/** 一个问答入口的工具与数据边界。 */
export interface AnswerProfile {
  id: AnswerProfileId
  /** 面向人与日志的名称。 */
  label: string
  /** 允许模型看到的工具白名单。 */
  allowedTools: readonly ToolName[]
  /** 是否允许访问本机微信数据（消息/联系人/朋友圈/收藏/文件/账单）。 */
  allowWechatData: boolean
  /** 是否允许访问知识库。 */
  allowKnowledgeBase: boolean
  /** `true` = 整个入口就是 kb-only（ClawBot）。 */
  kbOnly: boolean
  /** 是否要求执行上下文里必须有 kbId。 */
  requireKb: boolean
  /** 是否强制使用 `ctx.scope.username`（会话内问答）。 */
  forceUsername: boolean
  /** `search_hybrid` 允许的模式；缺省 = 不限制。 */
  hybridModes?: readonly HybridSearchMode[]
  /** 工具是否只读；未来若加入有副作用工具，重试器据此禁止自动重放。 */
  sideEffectTools?: readonly ToolName[]
}

/** 会话内问答可用的工具：只覆盖「消息检索 + 上下文 + 聚合 + 混合兜底」。 */
const SESSION_TOOLS: readonly ToolName[] = [
  'search_messages',
  'search_semantic',
  'get_session_messages',
  'get_message_context',
  'aggregate_messages',
  'search_hybrid',
]

/** ClawBot 唯一允许的工具。 */
const CLAWBOT_TOOLS: readonly ToolName[] = ['search_kb']

/** 微信问答的完整工具集：现有 13 个工具 + search_hybrid。 */
const WECHAT_TOOLS: readonly ToolName[] = [
  'search_messages',
  'search_semantic',
  'search_hybrid',
  'aggregate_messages',
  'list_sessions',
  'get_session_messages',
  'get_message_context',
  'search_contacts',
  'get_contact_detail',
  'search_moments',
  'search_favorites',
  'search_files',
  'search_records',
  'search_kb',
]

/** 三个入口的边界定义。 */
export const ANSWER_PROFILES: Readonly<Record<AnswerProfileId, AnswerProfile>> = {
  'wechat-ask': {
    id: 'wechat-ask',
    label: '微信问答',
    allowedTools: WECHAT_TOOLS,
    allowWechatData: true,
    allowKnowledgeBase: true,
    kbOnly: false,
    requireKb: false,
    forceUsername: false,
  },
  'session-ask': {
    id: 'session-ask',
    label: '会话内 AI 问答',
    allowedTools: SESSION_TOOLS,
    allowWechatData: true,
    allowKnowledgeBase: false,
    kbOnly: false,
    requireKb: false,
    forceUsername: true,
    hybridModes: ['messages'],
  },
  'clawbot-auto': {
    id: 'clawbot-auto',
    label: 'ClawBot 集群 AI 自动回复',
    allowedTools: CLAWBOT_TOOLS,
    allowWechatData: false,
    allowKnowledgeBase: true,
    kbOnly: true,
    requireKb: true,
    forceUsername: false,
  },
}

/** 全部 profile（按固定顺序，便于界面与测试）。 */
export const ALL_ANSWER_PROFILES: readonly AnswerProfile[] = [
  ANSWER_PROFILES['wechat-ask'],
  ANSWER_PROFILES['session-ask'],
  ANSWER_PROFILES['clawbot-auto'],
]

/** 取 profile（不存在时回退到权限最小的 clawbot-auto，而不是全量权限）。 */
export function getAnswerProfile(id: string): AnswerProfile {
  const found = (ANSWER_PROFILES as Record<string, AnswerProfile | undefined>)[id]
  return found ?? ANSWER_PROFILES['clawbot-auto']
}

/** 工具是否在该 profile 的白名单内（纯判断，不执行）。 */
export function isToolAllowed(profile: AnswerProfile | AnswerProfileId, name: string): boolean {
  const p = typeof profile === 'string' ? getAnswerProfile(profile) : profile
  return (p.allowedTools as readonly string[]).includes(name)
}

/** 只保留 profile 白名单内的工具（保持传入顺序）。 */
export function filterToolsForProfile(
  profile: AnswerProfile | AnswerProfileId,
  tools: readonly RetrievalTool[],
): RetrievalTool[] {
  const p = typeof profile === 'string' ? getAnswerProfile(profile) : profile
  const allowed = new Set<string>(p.allowedTools)
  return tools.filter(t => allowed.has(t.name))
}

/**
 * 按本轮执行上下文过滤工具。
 *
 * `list_sessions` 是“先确定范围”的发现类工具，无法应用固定会话/日期范围。
 * 在范围已锁定的轮次继续把它暴露给模型，只会得到一个 `unsupported_scope`，
 * 既浪费一次调用预算，也会诱导模型反复换排序参数重试。
 *
 * @param profileRef - profile 或 id。
 * @param tools - 已按 profile 过滤的工具集。
 * @param ctx - 本轮执行上下文（范围是硬过滤）。
 * @returns 可在本轮安全调用的工具集。
 */
export function filterToolsForScope(
  profileRef: AnswerProfile | AnswerProfileId,
  tools: readonly RetrievalTool[],
  ctx: ToolContext,
): RetrievalTool[] {
  const profile = typeof profileRef === 'string' ? getAnswerProfile(profileRef) : profileRef
  const scoped = filterToolsForProfile(profile, tools)
  const locked = (ctx.scope?.username ?? '').trim() !== ''
    || (ctx.scope?.from ?? '').trim() !== ''
    || (ctx.scope?.to ?? '').trim() !== ''
  if (!locked) return scoped
  return scoped.filter(t => t.name !== 'list_sessions')
}

/** 失败结果。 */
function fail(
  tool: string,
  code: ToolErrorCode,
  error: string,
  details?: Record<string, unknown>,
): ToolResult {
  return {
    tool: tool as ToolName,
    ok: false,
    error,
    errorCode: code,
    ...(details ? { errorDetails: details } : {}),
    hits: [],
  }
}

/** 范围校验结果。 */
export interface ProfileScopeAdjustment {
  field: 'from' | 'to'
  locked: string
  requested: string
  message: string
}

export type ProfileScopeDecision =
  | {
    ok: true
    args: Record<string, unknown>
    ctx: ToolContext
    /** 执行前对可收敛参数的修复记录；真实越权不会出现在这里。 */
    adjustments: ProfileScopeAdjustment[]
  }
  | { ok: false; error: ToolResult }

/** 哪些工具接受 `username` 参数（会话锁定时需要注入/校验）。 */
const USERNAME_ARG_TOOLS = new Set<ToolName>([
  'search_messages',
  'search_semantic',
  'get_session_messages',
  'aggregate_messages',
  'search_hybrid',
  'search_moments',
  'search_favorites',
  'search_files',
  'search_records',
])

/**
 * 哪些工具声明了 `from` / `to` 参数。
 *
 * profile 的日期锁必须作用在**所有**这类工具上：只校验会话、
 * 让日期由模型自由覆盖，会让「本周」这类服务端固定范围在第二跳悄悄失效。
 */
const DATE_ARG_TOOLS = new Set<ToolName>([
  'search_messages',
  'search_semantic',
  'search_hybrid',
  'aggregate_messages',
  'get_session_messages',
  'search_moments',
  'search_favorites',
  'search_files',
  'search_records',
])

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 严格校验 `YYYY-MM-DD`，拒绝 `2026-02-30` 这类会被 Date 滚动的日期。 */
function validDay(value: string): boolean {
  const match = DAY_RE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(year, month - 1, day)
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
}

/** 读取一个可能来自模型或锁定上下文的日期参数。 */
function readDay(
  toolName: string,
  args: Record<string, unknown>,
  key: 'from' | 'to',
): { ok: true; value: string } | { ok: false; error: ToolResult } {
  const raw = args[key]
  if (raw !== undefined && typeof raw !== 'string') {
    return {
      ok: false,
      error: fail(toolName, 'invalid_arguments', `${key} 必须是 YYYY-MM-DD`, {
        argument: key,
      }),
    }
  }
  const value = argString(raw).trim()
  if (value !== '' && !validDay(value)) {
    return {
      ok: false,
      error: fail(toolName, 'invalid_arguments', `${key} 必须是合法的 YYYY-MM-DD`, {
        argument: key,
        value,
      }),
    }
  }
  return { ok: true, value }
}

/**
 * 校验并归一执行范围。
 *
 * 这是**纯函数**：不读库、不执行工具，便于运行时与单测复用。
 *
 * 规则：
 *   · 工具不在白名单 → `tool_not_allowed`；
 *   · profile 要求 kbId 而上下文没有 → `not_configured`；
 *   · `forceUsername` 而上下文没有当前会话 → `scope_required`；
 *   · 模型参数里的 username 与锁定值冲突 → `scope_violation`（不静默改写）；
 *   · 工具接受 username 但模型没填 → 注入锁定值；
 *   · `get_message_context` 的 key 必须属于锁定会话；
 *   · 声明了 `from` / `to` 的工具：模型日期参数收敛到固定范围并记录修复；
 *   · 日期格式非法或 `from > to` → `invalid_arguments`；
 *   · `search_hybrid` 的 mode 必须落在 profile 允许的模式内。
 *
 * @param profileRef - profile 或 id。
 * @param toolName - 模型请求的工具名（不可信）。
 * @param args - 模型参数（不可信；只读，不修改原对象）。
 * @param ctx - 执行上下文（只读，不修改原对象）。
 * @returns 归一后的参数与上下文，或结构化错误。
 */
export function enforceProfileScope(
  profileRef: AnswerProfile | AnswerProfileId,
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ProfileScopeDecision {
  const profile = typeof profileRef === 'string' ? getAnswerProfile(profileRef) : profileRef
  if (!isToolAllowed(profile, toolName)) {
    return {
      ok: false,
      error: fail(toolName, 'tool_not_allowed', `工具 ${toolName} 不在 ${profile.label} 的允许范围内`, {
        profile: profile.id,
        tool: toolName,
      }),
    }
  }

  if (profile.requireKb && (ctx.kbId === undefined || ctx.kbId <= 0)) {
    return {
      ok: false,
      error: fail(toolName, 'not_configured', `${profile.label} 需要先选择知识库`, {
        profile: profile.id,
      }),
    }
  }

  const nextArgs: Record<string, unknown> = { ...args }
  const nextCtx: ToolContext = { ...ctx }
  const adjustments: ProfileScopeAdjustment[] = []

  const lockedUsername = (ctx.scope?.username ?? '').trim()
  if (profile.forceUsername && lockedUsername === '') {
    return {
      ok: false,
      error: fail(toolName, 'scope_required', `${profile.label} 缺少当前会话范围`, {
        profile: profile.id,
      }),
    }
  }

  if (lockedUsername !== '') {
    const requested = argString(nextArgs['username']).trim()
    if (requested !== '' && requested !== lockedUsername) {
      return {
        ok: false,
        error: fail(toolName, 'scope_violation', '请求的会话与当前会话不一致', {
          argument: 'username',
          locked: lockedUsername,
          requested,
        }),
      }
    }
    if (requested === '' && USERNAME_ARG_TOOLS.has(toolName as ToolName)) {
      nextArgs['username'] = lockedUsername
    }
    nextCtx.scope = { ...(ctx.scope ?? {}), username: lockedUsername }

    if (toolName === 'get_message_context') {
      const key = argString(nextArgs['key']).trim()
      if (key !== '' && !key.startsWith(`${lockedUsername}:`)) {
        return {
          ok: false,
          error: fail(toolName, 'scope_violation', '消息 key 不属于当前会话', {
            argument: 'key',
            locked: lockedUsername,
          }),
        }
      }
    }
  }

  if (toolName === 'search_hybrid' && profile.hybridModes) {
    if (nextArgs['mode'] !== undefined && typeof nextArgs['mode'] !== 'string') {
      return {
        ok: false,
        error: fail(toolName, 'invalid_arguments', 'mode 必须是字符串', { argument: 'mode' }),
      }
    }
    const requested = argString(nextArgs['mode']).trim()
    const allowed = profile.hybridModes
    if (requested === '') {
      if (allowed.length === 1) nextArgs['mode'] = allowed[0]
    } else if (!(allowed as readonly string[]).includes(requested)) {
      return {
        ok: false,
        error: fail(toolName, 'scope_violation', `混合检索模式 ${requested} 不在 ${profile.label} 的允许范围内`, {
          profile: profile.id,
          argument: 'mode',
          allowed: [...allowed],
          requested,
        }),
      }
    }
  }

  if (toolName === 'list_sessions') {
    const lockedFrom = (ctx.scope?.from ?? '').trim()
    const lockedTo = (ctx.scope?.to ?? '').trim()
    const lockedUsername = (ctx.scope?.username ?? '').trim()
    if (lockedFrom !== '' || lockedTo !== '' || lockedUsername !== '') {
      return {
        ok: false,
        error: fail(toolName, 'unsupported_scope', '会话列表不支持当前固定会话或日期范围', {
          ...(lockedUsername !== '' ? { username: lockedUsername } : {}),
          ...(lockedFrom !== '' ? { from: lockedFrom } : {}),
          ...(lockedTo !== '' ? { to: lockedTo } : {}),
        }),
      }
    }
  }

  if (DATE_ARG_TOOLS.has(toolName as ToolName)) {
    const parsedFrom = readDay(toolName, nextArgs, 'from')
    if (!parsedFrom.ok) return parsedFrom
    const parsedTo = readDay(toolName, nextArgs, 'to')
    if (!parsedTo.ok) return parsedTo

    const lockedFrom = (ctx.scope?.from ?? '').trim()
    const lockedTo = (ctx.scope?.to ?? '').trim()
    if (lockedFrom !== '' && !validDay(lockedFrom)) {
      return {
        ok: false,
        error: fail(toolName, 'scope_required', '执行上下文的 from 不是合法日期', {
          argument: 'from',
          locked: lockedFrom,
        }),
      }
    }
    if (lockedTo !== '' && !validDay(lockedTo)) {
      return {
        ok: false,
        error: fail(toolName, 'scope_required', '执行上下文的 to 不是合法日期', {
          argument: 'to',
          locked: lockedTo,
        }),
      }
    }

    if (lockedFrom !== '' && parsedFrom.value !== '' && parsedFrom.value !== lockedFrom) {
      adjustments.push({
        field: 'from',
        locked: lockedFrom,
        requested: parsedFrom.value,
        message: `from: 「${parsedFrom.value}」已按本轮固定范围收敛为 ${lockedFrom}`,
      })
    }
    if (lockedTo !== '' && parsedTo.value !== '' && parsedTo.value !== lockedTo) {
      adjustments.push({
        field: 'to',
        locked: lockedTo,
        requested: parsedTo.value,
        message: `to: 「${parsedTo.value}」已按本轮固定范围收敛为 ${lockedTo}`,
      })
    }

    const effectiveFrom = lockedFrom || parsedFrom.value
    const effectiveTo = lockedTo || parsedTo.value
    if (effectiveFrom !== '' && effectiveTo !== '' && effectiveFrom > effectiveTo) {
      return {
        ok: false,
        error: fail(toolName, 'invalid_arguments', 'from 不能晚于 to', {
          from: effectiveFrom,
          to: effectiveTo,
        }),
      }
    }
    // 固定范围必须写回参数：不能只靠工具实现里「模型参数优先、ctx 兜底」，
    // 否则某个工具漏了兜底就会悄悄查全历史。
    if (effectiveFrom !== '') nextArgs['from'] = effectiveFrom
    if (effectiveTo !== '') nextArgs['to'] = effectiveTo
    if (effectiveFrom !== '' || effectiveTo !== '') {
      nextCtx.scope = {
        ...(nextCtx.scope ?? {}),
        ...(effectiveFrom !== '' ? { from: effectiveFrom } : {}),
        ...(effectiveTo !== '' ? { to: effectiveTo } : {}),
      }
    }
  }

  return { ok: true, args: nextArgs, ctx: nextCtx, adjustments }
}

/** 包一层执行守卫：参数与上下文先过 {@link enforceProfileScope}。 */
function guardTool(profile: AnswerProfile, tool: RetrievalTool): RetrievalTool {
  return {
    ...tool,
    run: async (args, ctx): Promise<ToolResult> => {
      const decision = enforceProfileScope(profile, tool.name, args ?? {}, ctx)
      if (!decision.ok) return decision.error
      const result = await tool.run(decision.args, decision.ctx)
      if (decision.adjustments.length === 0) return result
      const fixes = decision.adjustments.map(item => item.message).join('；')
      return {
        ...result,
        note: result.note ? `${result.note}；${fixes}` : fixes,
      }
    },
  }
}

/**
 * 按 profile 构建**可执行**工具集。
 *
 * 返回的工具 `.run` 已带范围守卫；同时白名单外的工具根本不会出现。
 * 工具集由调用方传入（通常是 `buildTools` 组装的那份）—— 刻意不让本模块
 * import `registry.allTools`，避免 `registry -> profiles -> registry` 的静态环。
 *
 * @param profileRef - profile 或 id。
 * @param tools - 完整工具集（调用方用 `buildTools` 组装的那份；必填）。
 * @returns 过滤并守卫后的工具集。
 */
export function buildProfileTools(
  profileRef: AnswerProfile | AnswerProfileId,
  tools: readonly RetrievalTool[],
): RetrievalTool[] {
  const profile = typeof profileRef === 'string' ? getAnswerProfile(profileRef) : profileRef
  return filterToolsForProfile(profile, tools).map(t => guardTool(profile, t))
}

/**
 * 按名字执行 profile 工具。
 *
 * 与 `buildProfileTools` 的分工：调用方若只持有「完整工具集 + profile id」，
 * 用这个入口即可；它先判白名单，再走注册表的统一异常兜底。
 *
 * @param profileRef - profile 或 id。
 * @param tools - 完整工具集。
 * @param name - 模型请求的工具名（不可信）。
 * @param args - 模型参数（不可信）。
 * @param ctx - 执行上下文。
 * @returns 结构化结果；越界/未知/异常都不会抛。
 */
export async function runProfileTool(
  profileRef: AnswerProfile | AnswerProfileId,
  tools: readonly RetrievalTool[],
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const profile = typeof profileRef === 'string' ? getAnswerProfile(profileRef) : profileRef
  if (!isToolAllowed(profile, name)) {
    return fail(name, 'tool_not_allowed', `工具 ${name} 不在 ${profile.label} 的允许范围内`, {
      profile: profile.id,
      tool: name,
    })
  }
  return runTool(buildProfileTools(profile, tools), name, args ?? {}, ctx)
}

/** profile 的数据面描述（写进日志/依据行，避免把 kb-only 说成全库）。 */
export function profileDataScope(profileRef: AnswerProfile | AnswerProfileId): {
  wechatDataEnabled: boolean
  kbOnly: boolean
  allowKnowledgeBase: boolean
} {
  const profile = typeof profileRef === 'string' ? getAnswerProfile(profileRef) : profileRef
  return {
    wechatDataEnabled: profile.allowWechatData,
    kbOnly: profile.kbOnly,
    allowKnowledgeBase: profile.allowKnowledgeBase,
  }
}
