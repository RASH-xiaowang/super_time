/**
 * 问答工具参数的统一归一化与校验。
 *
 * 模型给出的工具参数不可信：可能是 `null`、数字、对象，日期可能是「上周」，
 * 枚举可能写成「按消息数」，会话参数可能填显示名而不是 username。
 * 这些错误如果直接交给工具，最常见的表现不是报错，而是**静默查空**。
 *
 * 本模块只做纯逻辑：不读数据库、不调用模型。会话/联系人解析通过
 * {@link ArgumentNormalizationContext} 的目录或 resolver 注入，便于 runtime 装配。
 *
 * @module query/answer-runtime/arguments
 */
import type { ToolContext } from '../tools/types.ts'
import { allTools } from '../tools/registry.ts'
import { findTool } from '../tools/types.ts'
import { normalizeDateInput, parseDateExpression } from './date-expression.ts'

export { parseDateExpression, type ParsedDateExpression } from './date-expression.ts'

/** 需要解析成 username 的实体类型。 */
export type ArgumentEntityKind = 'session' | 'contact'

/** 参数归一化失败的稳定分类。 */
export type ArgumentIssueCode =
  | 'invalid_arguments_root'
  | 'missing_required'
  | 'invalid_type'
  | 'invalid_enum'
  | 'invalid_date'
  | 'invalid_format'
  | 'unresolved_entity'
  | 'ambiguous_entity'

/** 参数修复类型（用于过程展示与测试断言）。 */
export type ArgumentFixCode =
  | 'arguments_coerced'
  | 'trimmed'
  | 'null_omitted'
  | 'array_normalized'
  | 'number_coerced'
  | 'integer_truncated'
  | 'range_clamped'
  | 'enum_alias'
  | 'date_normalized'
  | 'date_range_expanded'
  | 'date_swapped'
  | 'entity_resolved'

/** 一条结构化参数错误。 */
export interface ArgumentValidationIssue {
  code: ArgumentIssueCode
  field: string
  message: string
  value?: unknown
  expected?: string
}

/** 一条可读的参数修复说明。 */
export interface ArgumentFix {
  code: ArgumentFixCode
  field: string
  message: string
  from?: unknown
  to?: unknown
}

/** 会话或联系人目录项。 */
export interface ArgumentEntity {
  username: string
  name?: string
  aliases?: readonly string[]
}

/** 实体解析结果。 */
export type ArgumentEntityResolution =
  | { status: 'resolved'; entity: ArgumentEntity }
  | { status: 'ambiguous'; candidates: readonly ArgumentEntity[] }
  | { status: 'not_found' }

/**
 * 参数归一化可用的扩展上下文。
 *
 * 这里不修改既有 `ToolContext`，而是用可选字段做结构化扩展；
 * 普通工具上下文传进来仍然合法。
 */
export interface ArgumentNormalizationContext extends ToolContext {
  sessionCatalog?: readonly ArgumentEntity[]
  contactCatalog?: readonly ArgumentEntity[]
  resolveArgumentEntity?: (
    value: string,
    kind: ArgumentEntityKind,
    context: ToolContext,
  ) => ArgumentEntityResolution | undefined
}

/** 单个数值参数的安全范围。 */
export interface NumericArgumentPolicy {
  min?: number
  max?: number
  integer?: boolean
}

/** 归一化入口的可选覆盖项（默认值来自工具名与 schema）。 */
export interface NormalizeToolArgumentsOptions {
  now?: Date
  /** 显式指定某个字段解析成会话/联系人。 */
  entityFields?: Readonly<Record<string, ArgumentEntityKind>>
  /** 覆盖工具默认的数值范围。 */
  numeric?: Readonly<Record<string, NumericArgumentPolicy>>
  /** 覆盖工具默认的枚举别名。 */
  enumAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/** 归一化成功结果。 */
export interface ArgumentNormalizationSuccess {
  ok: true
  args: Record<string, unknown>
  fixes: ArgumentFix[]
  preservedUnknownFields: string[]
}

/** 归一化失败结果；`args` 是已经成功修复的部分，调用方不要拿它直接执行。 */
export interface ArgumentNormalizationFailure {
  ok: false
  args: Record<string, unknown>
  errors: ArgumentValidationIssue[]
  fixes: ArgumentFix[]
  preservedUnknownFields: string[]
}

export type ArgumentNormalizationResult =
  | ArgumentNormalizationSuccess
  | ArgumentNormalizationFailure

/**
 * 主运行时直接使用的参数修复结果（保持字段名稳定）。
 */
export type ToolArgumentRepair = {
  ok: boolean
  args: Record<string, unknown>
  repairs: string[]
  error?: string
  field?: string
}

/** `repairToolArguments` 的选项。 */
export interface RepairToolArgumentsOptions {
  now?: Date
  knownSessions?: string[]
  /** 结构化会话目录：把显示名/别名确定性解析成真实 username。 */
  knownSessionCatalog?: readonly ArgumentEntity[]
  knownContacts?: string[]
  /** 服务端强制范围；工具 schema 有 `username` 时无条件覆盖模型输入。 */
  forcedScope?: { username?: string }
}

type JsonSchema = Record<string, unknown>

interface DateState {
  from?: string
  to?: string
  haveFrom?: boolean
  haveTo?: boolean
  /** `from: 上周` 这类整段表达可用于补齐缺失的 to。 */
  fromExpandedTo?: string
  /** `to: 上个月` 这类整段表达可用于补齐缺失的 from。 */
  toExpandedFrom?: string
}

interface EntityLookup {
  configured: boolean
  resolution?: ArgumentEntityResolution
}

interface FieldNormalizationContext {
  args: Record<string, unknown>
  field: string
  schema: JsonSchema
  value: unknown
  required: boolean
  toolName: string
  options: NormalizeToolArgumentsOptions
  context: ToolContext
  now: Date
  fixes: ArgumentFix[]
  errors: ArgumentValidationIssue[]
  entityFields: Readonly<Record<string, ArgumentEntityKind>>
  dateState: DateState
}

const DATE_FIELDS = new Set(['from', 'to'])
const ARRAY_STRING_MAX = 6

/**
 * 已知工具的数值策略。
 *
 * schema 里目前只写了文字描述，没有 `minimum` / `maximum`，所以把范围放在这里，
 * 避免「模型填 1000 条」直接把上下文撑爆。
 */
const TOOL_NUMERIC_POLICIES: Readonly<Record<string, Readonly<Record<string, NumericArgumentPolicy>>>> = {
  search_messages: { limit: { min: 1, max: 60, integer: true } },
  get_session_messages: { limit: { min: 1, max: 200, integer: true } },
  get_message_context: {
    spanMinutes: { min: 1, max: 120, integer: true },
    maxMessages: { min: 1, max: 60, integer: true },
  },
  list_sessions: { limit: { min: 1, max: 100, integer: true } },
  search_contacts: { limit: { min: 1, max: 100, integer: true } },
  search_moments: { limit: { min: 1, max: 12, integer: true } },
  search_favorites: { limit: { min: 1, max: 12, integer: true } },
  search_files: { limit: { min: 1, max: 12, integer: true } },
  search_records: { limit: { min: 1, max: 12, integer: true } },
  search_kb: { limit: { min: 1, max: 60, integer: true } },
  search_semantic: { limit: { min: 1, max: 60, integer: true } },
  search_hybrid: { limit: { min: 1, max: 60, integer: true } },
}

const TOOL_ENUM_ALIASES: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  list_sessions: {
    orderBy: {
      '消息数': 'count',
      '按消息数': 'count',
      '数量': 'count',
      '数量最多': 'count',
      '最多': 'count',
      'msgcount': 'count',
      'bycount': 'count',
      '最近': 'recent',
      '最近活跃': 'recent',
      '时间': 'recent',
      '最新': 'recent',
      'recently': 'recent',
      'latest': 'recent',
    },
    kind: {
      '全部': 'all',
      '所有': 'all',
      '全部会话': 'all',
      '群聊': 'group',
      '群': 'group',
      '群组': 'group',
      'groups': 'group',
      'groupchat': 'group',
      '单聊': 'single',
      '私聊': 'single',
      '私信': 'single',
      '好友': 'single',
      'singlechat': 'single',
      'private': 'single',
    },
  },
  aggregate_messages: {
    dimension: {
      '关键词': 'keyword',
      '关键字': 'keyword',
      '按关键词': 'keyword',
      '按关键字': 'keyword',
      '条数': 'keyword',
      '数量': 'keyword',
      '会话': 'session',
      '按会话': 'session',
      '群': 'session',
      '排名': 'session',
      '排行': 'session',
      '日期': 'day',
      '按天': 'day',
      '按日': 'day',
      '天': 'day',
      '去重': 'distinct',
      '去重人数': 'distinct',
      '人数': 'distinct',
      '多少人': 'distinct',
    },
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeEnumKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function enumAliasesFor(
  toolName: string,
  field: string,
  options: NormalizeToolArgumentsOptions,
): Readonly<Record<string, string>> {
  const base = TOOL_ENUM_ALIASES[toolName]?.[field] ?? {}
  const override = options.enumAliases?.[field] ?? {}
  return { ...base, ...override }
}

function numericPolicyFor(
  toolName: string,
  field: string,
  schema: JsonSchema,
  options: NormalizeToolArgumentsOptions,
): NumericArgumentPolicy {
  const base = TOOL_NUMERIC_POLICIES[toolName]?.[field] ?? {}
  const override = options.numeric?.[field] ?? {}
  const minimum = typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined
  const maximum = typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined
  return {
    ...base,
    ...(minimum === undefined ? {} : { min: minimum }),
    ...(maximum === undefined ? {} : { max: maximum }),
    ...(schema['type'] === 'integer' ? { integer: true } : {}),
    ...override,
  }
}

function defaultEntityKind(toolName: string, field: string): ArgumentEntityKind | undefined {
  if (field !== 'username') return undefined
  return toolName === 'get_contact_detail' ? 'contact' : 'session'
}

function lookupCatalog(
  value: string,
  catalog: readonly ArgumentEntity[],
): ArgumentEntityResolution {
  const exactUsername = catalog.find(item => item.username === value)
  if (exactUsername) return { status: 'resolved', entity: exactUsername }

  const lookup = value.toLowerCase()
  const candidates = catalog.filter((item) => {
    const names = [item.name ?? '', ...(item.aliases ?? [])]
    return names.some(name => name.trim().toLowerCase() === lookup)
  })
  const usernames = new Set(candidates.map(item => item.username))
  if (usernames.size === 1) {
    const entity = candidates[0]
    return entity ? { status: 'resolved', entity } : { status: 'not_found' }
  }
  if (usernames.size > 1) {
    return { status: 'ambiguous', candidates }
  }
  return { status: 'not_found' }
}

function lookupEntity(
  value: string,
  kind: ArgumentEntityKind,
  context: ToolContext,
): EntityLookup {
  const extended = context as ArgumentNormalizationContext
  const catalog = kind === 'session' ? extended.sessionCatalog : extended.contactCatalog
  const resolver = extended.resolveArgumentEntity
  if ((!catalog || catalog.length === 0) && !resolver) return { configured: false }

  if (catalog && catalog.length > 0) {
    const fromCatalog = lookupCatalog(value, catalog)
    if (fromCatalog.status !== 'not_found') {
      return { configured: true, resolution: fromCatalog }
    }
  }
  if (resolver) {
    try {
      const resolved = resolver(value, kind, context)
      if (resolved) return { configured: true, resolution: resolved }
    } catch {
      return {
        configured: true,
        resolution: {
          status: 'not_found',
        },
      }
    }
  }
  return { configured: true, resolution: { status: 'not_found' } }
}

function looksLikeUsername(value: string): boolean {
  return /^(?:wxid_[A-Za-z0-9_-]+|gh_[A-Za-z0-9_-]+|[A-Za-z0-9._-]+@chatroom|[A-Za-z][A-Za-z0-9._-]{4,})$/.test(value)
}

function trimString(
  field: string,
  value: string,
  fixes: ArgumentFix[],
): string {
  const trimmed = value.trim()
  if (trimmed !== value) {
    fixes.push({
      code: 'trimmed',
      field,
      message: `${field}: 已去除首尾空白`,
      from: value,
      to: trimmed,
    })
  }
  return trimmed
}

function normalizeStringArray(
  field: string,
  value: unknown,
  maxItems: number,
  fixes: ArgumentFix[],
): string[] | undefined {
  let rows: unknown[] | undefined
  if (typeof value === 'string') {
    rows = value.split(/[,，、;；\s]+/)
    fixes.push({
      code: 'array_normalized',
      field,
      message: `${field}: 字符串已拆成关键词数组`,
      from: value,
    })
  } else if (Array.isArray(value)) {
    rows = value
  } else {
    return undefined
  }

  const out: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const row of rows) {
    if (typeof row !== 'string') {
      dropped += 1
      continue
    }
    const item = row.trim()
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  if (dropped > 0) {
    fixes.push({
      code: 'array_normalized',
      field,
      message: `${field}: 已忽略 ${dropped} 个非字符串项`,
      from: value,
    })
  }
  if (out.length > maxItems) {
    const clipped = out.slice(0, maxItems)
    fixes.push({
      code: 'array_normalized',
      field,
      message: `${field}: 数组已截断到 ${maxItems} 项`,
      from: value,
      to: clipped,
    })
    return clipped
  }
  return out
}

function normalizeDateField(
  field: 'from' | 'to',
  value: string,
  now: Date,
  fixes: ArgumentFix[],
  errors: ArgumentValidationIssue[],
  state: DateState,
): void {
  const parsed = parseDateExpression(value, now)
  if (!parsed) {
    errors.push({
      code: 'invalid_date',
      field,
      message: `${field}: 无法识别日期「${value}」`,
      value,
      expected: '今天/昨天/本周/上周/上个月/YYYY-MM-DD/中文日期',
    })
    return
  }
  if (parsed.from !== value) {
    fixes.push({
      code: 'date_normalized',
      field,
      message: `${field}: 「${value}」→ ${parsed.from}${parsed.to !== parsed.from ? ` ~ ${parsed.to}` : ''}`,
      from: value,
      to: parsed.relative ? { from: parsed.from, to: parsed.to } : parsed.from,
    })
  }
  if (parsed.relative) {
    if (field === 'from') {
      state.from = parsed.from
      state.haveFrom = true
      if (parsed.startOnly) {
        state.to = parsed.to
      } else if (parsed.from === parsed.to) {
        // 「昨天」这类单日相对表达同时充当起止日，避免只传 from 后把时间窗无限放大。
        state.to = parsed.to
      } else if (parsed.from !== parsed.to) {
        state.fromExpandedTo = parsed.to
      }
    } else {
      state.to = parsed.to
      state.haveTo = true
      if (parsed.endOnly || parsed.from === '') {
        // 「截至本周」只给出结束日，起始日保持不限。
      } else if (parsed.from !== parsed.to) {
        state.toExpandedFrom = parsed.from
      }
    }
    if (parsed.from !== parsed.to) {
      fixes.push({
        code: 'date_range_expanded',
        field,
        message: `${field}: 相对日期「${value}」展开为 ${parsed.from} ~ ${parsed.to}`,
        from: value,
        to: { from: parsed.from, to: parsed.to },
      })
    }
    return
  }
  if (field === 'from') {
    state.from = parsed.from
    state.haveFrom = true
  } else {
    state.to = parsed.to
    state.haveTo = true
  }
}

function addIssue(
  errors: ArgumentValidationIssue[],
  code: ArgumentIssueCode,
  field: string,
  message: string,
  value: unknown,
  expected?: string,
): void {
  errors.push({
    code,
    field,
    message,
    ...(value === undefined ? {} : { value }),
    ...(expected === undefined ? {} : { expected }),
  })
}

/** 校验根参数形状，并把 null/undefined 归一为空对象。 */
function argumentSource(
  rawArgs: unknown,
  fixes: ArgumentFix[],
  errors: ArgumentValidationIssue[],
): Record<string, unknown> | undefined {
  if (rawArgs !== null && rawArgs !== undefined && !isPlainRecord(rawArgs)) {
    addIssue(
      errors,
      'invalid_arguments_root',
      '$',
      '工具参数必须是一个对象',
      rawArgs,
      'object',
    )
    return undefined
  }
  if (rawArgs === null || rawArgs === undefined) {
    fixes.push({
      code: 'arguments_coerced',
      field: '$',
      message: '未提供参数，已按空对象处理',
      from: rawArgs,
      to: {},
    })
  }
  return rawArgs ?? {}
}

/** 处理未提供、undefined 或 null 的声明字段。 */
function normalizeMissingArgument(input: FieldNormalizationContext): void {
  const { args, field, schema, value, required, fixes, errors } = input
  delete args[field]
  if (required) {
    addIssue(
      errors,
      'missing_required',
      field,
      `缺少必填参数 ${field}`,
      value,
      String(schema['type'] ?? 'value'),
    )
  } else if (value === null) {
    fixes.push({
      code: 'null_omitted',
      field,
      message: `${field}: null 已按未提供处理`,
      from: null,
    })
  }
}

/** 返回 true 表示该字段是枚举，已由本函数处理。 */
function normalizeEnumArgument(input: FieldNormalizationContext): boolean {
  const { args, field, schema, value, toolName, options, fixes, errors } = input
  const enumValues = Array.isArray(schema['enum'])
    ? schema['enum'].filter((x): x is string => typeof x === 'string')
    : []
  if (enumValues.length === 0) return false

  if (typeof value !== 'string') {
    delete args[field]
    addIssue(
      errors,
      'invalid_type',
      field,
      `${field}: 枚举参数必须是字符串`,
      value,
      enumValues.join(' | '),
    )
    return true
  }
  const cleaned = trimString(field, value, fixes)
  const key = normalizeEnumKey(cleaned)
  const canonical = enumValues.find(item => normalizeEnumKey(item) === key)
  const aliases = enumAliasesFor(toolName, field, options)
  const alias = Object.entries(aliases).find(([from]) => normalizeEnumKey(from) === key)?.[1]
  const target = canonical ?? (alias && enumValues.includes(alias) ? alias : undefined)
  if (!target) {
    delete args[field]
    addIssue(
      errors,
      'invalid_enum',
      field,
      `${field}: 不支持「${cleaned}」`,
      value,
      enumValues.join(' | '),
    )
    return true
  }
  if (target !== cleaned) {
    fixes.push({
      code: 'enum_alias',
      field,
      message: `${field}: 「${cleaned}」→ ${target}`,
      from: value,
      to: target,
    })
  }
  args[field] = target
  return true
}

/** 返回 true 表示该字段是数字或整数，已由本函数处理。 */
function normalizeNumericArgument(input: FieldNormalizationContext): boolean {
  const { args, field, schema, value, toolName, options, fixes, errors } = input
  const schemaType = schema['type']
  if (schemaType !== 'number' && schemaType !== 'integer') return false

  if (typeof value !== 'number' && typeof value !== 'string') {
    delete args[field]
    addIssue(
      errors,
      'invalid_type',
      field,
      `${field}: 必须是数字`,
      value,
      'number',
    )
    return true
  }
  const text = typeof value === 'string' ? value.trim() : ''
  const parsed = typeof value === 'number' ? value : (text === '' ? Number.NaN : Number(text))
  if (!Number.isFinite(parsed)) {
    delete args[field]
    addIssue(
      errors,
      'invalid_type',
      field,
      `${field}: 不是有效数字`,
      value,
      'number',
    )
    return true
  }
  if (typeof value === 'string') {
    fixes.push({
      code: 'number_coerced',
      field,
      message: `${field}: 数字字符串「${value}」→ ${parsed}`,
      from: value,
      to: parsed,
    })
  }
  const policy = numericPolicyFor(toolName, field, schema, options)
  let next = parsed
  if (policy.integer === true && !Number.isInteger(next)) {
    const truncated = Math.trunc(next)
    fixes.push({
      code: 'integer_truncated',
      field,
      message: `${field}: 小数 ${next} 已取整为 ${truncated}`,
      from: next,
      to: truncated,
    })
    next = truncated
  }
  const min = policy.min
  const max = policy.max
  if (min !== undefined && next < min) {
    fixes.push({
      code: 'range_clamped',
      field,
      message: `${field}: ${next} 小于下限，已钳制为 ${min}`,
      from: next,
      to: min,
    })
    next = min
  }
  if (max !== undefined && next > max) {
    fixes.push({
      code: 'range_clamped',
      field,
      message: `${field}: ${next} 超过上限，已钳制为 ${max}`,
      from: next,
      to: max,
    })
    next = max
  }
  args[field] = next
  return true
}

/** 返回 true 表示该字段是数组，已由本函数处理。 */
function normalizeArrayArgument(input: FieldNormalizationContext): boolean {
  const { args, field, schema, value, required, fixes, errors } = input
  if (schema['type'] !== 'array') return false

  const maxItems = typeof schema['maxItems'] === 'number'
    ? Math.max(1, Math.trunc(schema['maxItems']))
    : ARRAY_STRING_MAX
  const normalized = normalizeStringArray(field, value, maxItems, fixes)
  if (!normalized) {
    delete args[field]
    addIssue(
      errors,
      'invalid_type',
      field,
      `${field}: 必须是字符串数组`,
      value,
      'string[]',
    )
    return true
  }
  if (normalized.length === 0) {
    delete args[field]
    if (required) {
      addIssue(
        errors,
        'missing_required',
        field,
        `缺少必填参数 ${field}`,
        value,
        'string[]',
      )
    }
    return true
  }
  args[field] = normalized
  return true
}

function resolveEntityArgument(
  field: string,
  value: string,
  kind: ArgumentEntityKind,
  context: ToolContext,
  fixes: ArgumentFix[],
  errors: ArgumentValidationIssue[],
): string | undefined {
  // 模型常把显示名连同引号一起填进 username（例如「z_卖酒」）。
  // 先剥掉包裹引号再查目录；只在整串被一对引号包裹时处理，避免误伤正文。
  const unquoted = value.length >= 2
    && /^[“"「『']/.test(value)
    && /[”"」』']$/.test(value)
    ? value.slice(1, -1).trim()
    : value
  const lookupValue = unquoted === '' ? value : unquoted
  if (lookupValue !== value) {
    fixes.push({
      code: 'trimmed',
      field,
      message: `${field}: 已去除包裹引号`,
      from: value,
      to: lookupValue,
    })
  }
  const lookup = lookupEntity(lookupValue, kind, context)
  if (!lookup.configured || !lookup.resolution) return lookupValue

  if (lookup.resolution.status === 'ambiguous') {
    const names = lookup.resolution.candidates.map(item => item.name || item.username)
    addIssue(
      errors,
      'ambiguous_entity',
      field,
      `${field}: 「${value}」匹配到多个${kind === 'session' ? '会话' : '联系人'}${names.length > 0 ? `：${names.join('、')}` : ''}`,
      value,
      '更完整的 username',
    )
    return undefined
  }
  if (lookup.resolution.status === 'resolved') {
    const next = lookup.resolution.entity.username
    if (next !== lookupValue) {
      fixes.push({
        code: 'entity_resolved',
        field,
        message: `${field}: ${kind === 'session' ? '会话' : '联系人'}名「${lookupValue}」→ ${next}`,
        from: lookupValue,
        to: next,
      })
    }
    return next
  }
  if (!looksLikeUsername(lookupValue)) {
    addIssue(
      errors,
      'unresolved_entity',
      field,
      `${field}: 找不到${kind === 'session' ? '会话' : '联系人'}「${lookupValue}」`,
      lookupValue,
      'username 或可解析的显示名',
    )
    return undefined
  }
  return lookupValue
}

/** 返回 true 表示命中了日期字段，调用方需要执行日期范围收尾。 */
function normalizeStringArgument(input: FieldNormalizationContext): boolean {
  const {
    args,
    field,
    value,
    required,
    toolName,
    context,
    now,
    fixes,
    errors,
    entityFields,
    dateState,
  } = input
  if (typeof value !== 'string') {
    delete args[field]
    addIssue(
      errors,
      'invalid_type',
      field,
      `${field}: 必须是字符串`,
      value,
      'string',
    )
    return false
  }
  const cleaned = trimString(field, value, fixes)
  if (cleaned === '') {
    delete args[field]
    if (required) {
      addIssue(
        errors,
        'missing_required',
        field,
        `缺少必填参数 ${field}`,
        value,
        'string',
      )
    }
    return false
  }
  if (DATE_FIELDS.has(field)) {
    normalizeDateField(field as 'from' | 'to', cleaned, now, fixes, errors, dateState)
    return true
  }
  if (toolName === 'get_message_context' && field === 'key') {
    const keyMatch = /^(.+):(\d+)$/.exec(cleaned)
    if (!keyMatch) {
      delete args[field]
      addIssue(
        errors,
        'invalid_format',
        field,
        'key: 形状应为 username:local_id',
        value,
        'username:local_id',
      )
      return false
    }
  }

  const kind = entityFields[field] ?? defaultEntityKind(toolName, field)
  if (kind) {
    const next = resolveEntityArgument(field, cleaned, kind, context, fixes, errors)
    if (next === undefined) {
      delete args[field]
      return false
    }
    args[field] = next
    return false
  }
  args[field] = cleaned
  return false
}

/** 返回 true 表示该字段是布尔值，已由本函数处理。 */
function normalizeBooleanArgument(input: FieldNormalizationContext): boolean {
  const { args, field, schema, value, errors } = input
  if (schema['type'] !== 'boolean') return false
  if (typeof value !== 'boolean') {
    delete args[field]
    addIssue(
      errors,
      'invalid_type',
      field,
      `${field}: 必须是布尔值`,
      value,
      'boolean',
    )
    return true
  }
  args[field] = value
  return true
}

function finalizeDateArguments(
  args: Record<string, unknown>,
  fixes: ArgumentFix[],
  dateState: DateState,
): void {
  const hasFrom = Boolean(dateState.from)
  const hasTo = Boolean(dateState.to)
  if (hasFrom && !hasTo && dateState.fromExpandedTo) {
    dateState.to = dateState.fromExpandedTo
    fixes.push({
      code: 'date_range_expanded',
      field: 'to',
      message: `to: 未提供，按相对日期范围补齐为 ${dateState.to}`,
      to: dateState.to,
    })
  }
  if (hasTo && !hasFrom && dateState.toExpandedFrom) {
    dateState.from = dateState.toExpandedFrom
    fixes.push({
      code: 'date_range_expanded',
      field: 'from',
      message: `from: 未提供，按相对日期范围补齐为 ${dateState.from}`,
      to: dateState.from,
    })
  }
  if (dateState.from && dateState.to && dateState.from > dateState.to) {
    const from = dateState.from
    const to = dateState.to
    dateState.from = to
    dateState.to = from
    fixes.push({
      code: 'date_swapped',
      field: 'from/to',
      message: `日期范围起止颠倒，已交换为 ${to} ~ ${from}`,
      from: { from, to },
      to: { from: to, to: from },
    })
  }
  if (dateState.from) args['from'] = dateState.from
  else delete args['from']
  if (dateState.to) args['to'] = dateState.to
  else delete args['to']
}

function preservedUnknownFields(
  source: Record<string, unknown>,
  properties: Record<string, unknown>,
): string[] {
  return Object.keys(source)
    .filter(field => !Object.prototype.hasOwnProperty.call(properties, field))
    .sort()
}

/**
 * 按工具的 JSON Schema 归一化参数。
 *
 * 约定：
 *   · 只校验 schema 中声明的字段；未知字段原样保留（兼容 runtime 注入的内部字段）；
 *   · 失败不抛异常，返回结构化错误；
 *   · 失败结果里的 `args` 只用于诊断，调用方不应执行。
 *
 * @param tool - 至少包含 `name` 与 `parameters` 的工具定义。
 * @param rawArgs - 模型给的不可信参数。
 * @param context - 工具上下文（含可选的目录/resolver 扩展）。
 * @param options - 可选覆盖项。
 * @returns 归一化结果。
 */
export function normalizeToolArguments(
  tool: { name: string; parameters: Record<string, unknown> },
  rawArgs: unknown,
  context: ToolContext,
  options: NormalizeToolArgumentsOptions = {},
): ArgumentNormalizationResult {
  const fixes: ArgumentFix[] = []
  const errors: ArgumentValidationIssue[] = []
  const now = normalizeDateInput(options.now ?? context.now)
  const source = argumentSource(rawArgs, fixes, errors)
  if (!source) {
    return { ok: false, args: {}, errors, fixes, preservedUnknownFields: [] }
  }

  const args: Record<string, unknown> = { ...source }
  const properties = isRecord(tool.parameters['properties'])
    ? tool.parameters['properties']
    : {}
  const requiredValues = Array.isArray(tool.parameters['required'])
    ? tool.parameters['required'].filter((x): x is string => typeof x === 'string')
    : []
  const required = new Set(requiredValues)
  const entityFields: Record<string, ArgumentEntityKind> = { ...(options.entityFields ?? {}) }
  const dateState: DateState = {}
  let sawDateField = false

  for (const [field, rawSchema] of Object.entries(properties)) {
    const schema = isRecord(rawSchema) ? rawSchema : {}
    const supplied = Object.prototype.hasOwnProperty.call(source, field)
    const value = supplied ? source[field] : undefined
    const input: FieldNormalizationContext = {
      args,
      field,
      schema,
      value,
      required: required.has(field),
      toolName: tool.name,
      options,
      context,
      now,
      fixes,
      errors,
      entityFields,
      dateState,
    }
    if (!supplied || value === undefined || value === null) {
      normalizeMissingArgument(input)
      continue
    }
    if (normalizeEnumArgument(input)) continue
    if (normalizeNumericArgument(input)) continue
    if (normalizeArrayArgument(input)) continue
    if (schema['type'] === 'string') {
      if (normalizeStringArgument(input)) sawDateField = true
      continue
    }
    if (normalizeBooleanArgument(input)) continue

    // 未知 schema 类型原样保留：这里不做猜测，工具自己会按契约处理。
    args[field] = value
  }

  if (sawDateField) finalizeDateArguments(args, fixes, dateState)
  const unknownFields = preservedUnknownFields(source, properties)

  if (errors.length > 0) {
    return { ok: false, args, errors, fixes, preservedUnknownFields: unknownFields }
  }
  return { ok: true, args, fixes, preservedUnknownFields: unknownFields }
}

function catalogFrom(values: readonly string[] | undefined): ArgumentEntity[] {
  if (!values) return []
  return values
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .map(value => ({ username: value.trim(), name: value.trim() }))
}

/**
 * 主运行时入口：按工具名修复参数。
 *
 * 与 {@link normalizeToolArguments} 的关系：
 *   · 本函数负责查找注册表中的工具 schema、注入已知会话/联系人并应用强制范围；
 *   · 具体校验仍走同一套归一化实现，避免两条路径行为分叉。
 *
 * @param name - 工具名。
 * @param raw - 模型给出的不可信参数。
 * @param opts - 当前时刻、已知实体、强制范围。
 * @returns 可直接给工具执行的参数与可读修复说明。
 */
export function repairToolArguments(
  name: string,
  raw: unknown,
  opts: RepairToolArgumentsOptions = {},
): ToolArgumentRepair {
  const tool = findTool(allTools, name)
  if (!tool) {
    return {
      ok: false,
      args: {},
      repairs: [],
      error: `没有这个工具：${name}`,
    }
  }

  const properties = isRecord(tool.parameters['properties'])
    ? tool.parameters['properties']
    : {}
  const forcedUsername = opts.forcedScope?.username?.trim() ?? ''
  let source = raw
  const preRepairs: string[] = []
  if (
    forcedUsername !== ''
    && Object.prototype.hasOwnProperty.call(properties, 'username')
  ) {
    const base = raw === null || raw === undefined
      ? {}
      : isPlainRecord(raw)
        ? raw
        : undefined
    if (!base) {
      return {
        ok: false,
        args: {},
        repairs: [],
        error: '工具参数必须是一个对象',
        field: '$',
      }
    }
    const previous = base['username']
    source = { ...base, username: forcedUsername }
    if (previous !== forcedUsername) {
      preRepairs.push(
        previous === undefined || previous === null || previous === ''
          ? `username: 已应用强制会话范围 ${forcedUsername}`
          : `username: 「${String(previous)}」已覆盖为强制会话 ${forcedUsername}`,
      )
    }
  }

  const sessionCatalog = opts.knownSessionCatalog && opts.knownSessionCatalog.length > 0
    ? [...opts.knownSessionCatalog]
    : catalogFrom(opts.knownSessions)
  const contactCatalog = catalogFrom(opts.knownContacts)
  const context: ArgumentNormalizationContext = {
    decryptedDir: '',
    ...(opts.now ? { now: opts.now } : {}),
    ...(forcedUsername === '' ? {} : { scope: { username: forcedUsername } }),
    ...(sessionCatalog.length > 0 ? { sessionCatalog } : {}),
    ...(contactCatalog.length > 0 ? { contactCatalog } : {}),
  }
  const normalized = normalizeToolArguments(
    { name: tool.name, parameters: tool.parameters },
    source,
    context,
    opts.now ? { now: opts.now } : {},
  )
  const repairs = [...preRepairs, ...normalized.fixes.map(fix => fix.message)]
  if (normalized.ok) {
    return { ok: true, args: normalized.args, repairs }
  }
  const first = normalized.errors[0]
  return {
    ok: false,
    args: normalized.args,
    repairs,
    ...(first ? { error: first.message, field: first.field } : { error: '参数校验失败' }),
  }
}
