/**
 * 自定义工具：**用数据定义、由模板执行**（2026-11-24）。
 *
 * ## 为什么只有两种执行方式
 *
 * 前端不可能凭空造出「新的数据查询逻辑」—— 那需要 SQL、索引、解码、权限闸门，都是代码。
 * 所以自定义工具只提供两种**不需要写代码**的配方，而且它们的执行体是**同一个模板**：
 *
 *   · `alias`  —— 把某个内置工具包一层，固定若干参数。
 *                 例：「最近三个月的转账」= `search_records` + 固定 `from`/`to`。
 *                 价值是让模型拿到一个**窄而正确**的工具，而不是自己去猜参数。
 *   · `answer` —— 返回一段固定文本（团队约定、术语表、口径说明）。
 *                 零 I/O、零副作用，模型可以拿它对齐称呼与定义。
 *
 * 这两种都是**本地**的（不发请求、不读新数据面），所以可以安全地进入工具循环；
 * 真正出网的自定义通道走的是另一条路（RPA 厂商描述符），那里有独立的主机白名单与
 * 凭据闸门，不在本模块。
 *
 * ## 为什么在这里做校验而不是在网关
 *
 * 校验规则（名字形状、目标必须存在、固定参数必须在目标 schema 里、答案长度…）与
 * 「怎么执行」是同一件事的两面：写出一个执行不了的 alias 比拒绝保存更糟，
 * 因为它会在模型调用时才失败，而且用户看不到原因。
 *
 * @module query/custom-tools
 */
import { allTools } from './tools/registry.ts'
import { LOCKED_SCOPE_UNSUPPORTED_TOOLS } from './tools/profiles.ts'
import { REPLY_TOOL_SCHEMAS } from './reply-tools/registry.ts'
import { listVendorDescriptors } from './rpa/registry.ts'
import type { RetrievalTool, ToolHit, ToolName, ToolResult } from './tools/types.ts'
import type { CustomToolRecord } from './tool-config-store.ts'
import type { LocalToolFixedValue, LocalToolInput, LocalToolItem } from '../types-local-tools.ts'

/** 自定义工具名：小写字母开头，允许数字与下划线（模型按它调用，必须稳定）。 */
const NAME_RE = /^[a-z][a-z0-9_]{2,48}$/
/** 标题/说明/答案的长度上限（说明会随 schema 发给模型，过长只是白占上下文）。 */
const TITLE_MAX = 40
const DESCRIPTION_MAX = 400
const ANSWER_MAX = 2000

/**
 * 内置工具名集合（自定义工具不许与之重名）。
 *
 * 除了问答检索工具，还收进**回复工具**（`weather` / `calculate` …）与**出网通道 id**：
 * 它们各自出现在不同的链路里，但同名会让「日志里那个 weather 到底是哪个」变成猜谜，
 * 也会让卡片列表读起来像重复条目。
 */
const BUILTIN_NAMES = new Set<string>([
  ...allTools.map((tool) => tool.name),
  ...REPLY_TOOL_SCHEMAS.map((schema) => schema.name),
  ...listVendorDescriptors().map((descriptor) => descriptor.id),
])

/** 参与工具循环的自定义工具名（`alias`/`answer` 都在内）。 */
export interface CustomToolValidation {
  ok: boolean
  record?: CustomToolRecord
  item?: LocalToolItem
  error?: string
}

/** 目标工具的参数 schema（找不到返回 null）。 */
function targetTool(name: string): RetrievalTool | undefined {
  return allTools.find((tool) => tool.name === name)
}

/** 目标工具可暴露的参数名（按声明顺序）。 */
function targetParams(tool: RetrievalTool): string[] {
  const props = tool.parameters['properties']
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return []
  return Object.keys(props as Record<string, unknown>)
}

/**
 * 校验并归一一条工具输入。
 *
 * 校验顺序刻意按「先便宜后昂贵」：名字形状 → 是否撞内置 → 类型分支。
 * `existing` 只在更新时传，用于区分「改自己」与「撞别人」。
 * @param input - 前端提交的原始字段（不可信）。
 * @param existing - 正在更新的自定义工具（新增时缺省）。
 * @returns 校验结果；成功时带上整行记录与投影后的卡片。
 */
export function validateCustomTool(
  input: LocalToolInput | undefined,
  existing?: CustomToolRecord,
): CustomToolValidation {
  if (input === undefined || input === null || typeof input !== 'object') {
    return { ok: false, error: '缺少工具配置' }
  }
  const name = (typeof input.name === 'string' ? input.name : existing?.name ?? '').trim()
  if (!NAME_RE.test(name)) {
    return { ok: false, error: '工具名需为小写字母开头、3–49 位的小写字母/数字/下划线（模型按它调用）' }
  }
  if (BUILTIN_NAMES.has(name)) {
    return { ok: false, error: `「${name}」是内置工具的调用名；默认工具不可覆盖，请换一个名字` }
  }
  // 新建时不许占用一个已存在的自定义工具名：那会静默覆盖（用户以为建了第二个）。
  if (input.isNew === true && existing !== undefined) {
    return { ok: false, error: `已经有一个叫「${name}」的工具了；改个名字，或直接编辑它` }
  }
  const title = (typeof input.title === 'string' ? input.title : '').trim()
  if (title === '') return { ok: false, error: '名称不能为空' }
  if (title.length > TITLE_MAX) return { ok: false, error: `名称不超过 ${String(TITLE_MAX)} 个字符` }
  const description = (typeof input.description === 'string' ? input.description : '').trim()
  if (description === '') return { ok: false, error: '说明不能为空（模型靠它决定什么时候用这个工具）' }
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `说明不超过 ${String(DESCRIPTION_MAX)} 个字符` }
  }
  const enabled = input.enabled !== false
  const kind = input.kind === 'alias' ? 'alias' : 'answer'

  if (kind === 'answer') {
    const answer = (typeof input.answer === 'string' ? input.answer : '').trim()
    if (answer === '') return { ok: false, error: '固定回答不能为空' }
    if (answer.length > ANSWER_MAX) return { ok: false, error: `固定回答不超过 ${String(ANSWER_MAX)} 个字符` }
    return finish({
      name, title, description, kind, target: '', fixed: {}, answer, expose: [], enabled,
      updatedAt: Date.now(),
    })
  }

  const targetName = (typeof input.target === 'string' ? input.target : '').trim()
  const tool = targetTool(targetName)
  if (tool === undefined) return { ok: false, error: `被封装的内置工具不存在：${targetName || '（未选择）'}` }
  if (LOCKED_SCOPE_UNSUPPORTED_TOOLS.has(tool.name)) {
    return { ok: false, error: `「${targetName}」不支持按会话锁定范围，不能作为预设封装的目标` }
  }
  const allowed = new Set(targetParams(tool))
  const rules = (tool.parameters['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const fixed: Record<string, LocalToolFixedValue> = {}
  for (const [key, value] of Object.entries(isPlainMap(input.fixed) ? input.fixed : {})) {
    if (!allowed.has(key)) return { ok: false, error: `固定参数「${key}」不在 ${targetName} 的参数里` }
    const coerced = coerceFixedValue(rules[key] ?? {}, value)
    if (!coerced.ok) return { ok: false, error: `固定参数「${key}」：${coerced.error}` }
    fixed[key] = coerced.value
  }
  const pinned = Object.keys(fixed)
  if (pinned.length === 0) return { ok: false, error: '至少要固定一个参数（否则直接给内置工具起个别名没有意义）' }
  const exposeInput = Array.isArray(input.expose)
    ? input.expose.filter((item): item is string => typeof item === 'string')
    : []
  const expose = exposeInput.length > 0
    ? exposeInput.filter((key) => allowed.has(key) && !pinned.includes(key))
    : [...allowed].filter((key) => !pinned.includes(key))
  if (expose.length === 0) {
    return { ok: false, error: '固定参数过多：模型没有可填的参数，这个工具就退化成固定调用' }
  }
  return finish({
    name, title, description, kind, target: tool.name, fixed, answer: '', expose, enabled,
    updatedAt: Date.now(),
  })
}

/** 是否为「键 → 原始值」的普通对象（拒绝数组与嵌套）。 */
function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 布尔字面量（中文也收：「是/否」是用户会真的敲进来的东西）。 */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', '是', '开'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', '否', '关'])

/**
 * 按目标工具的 schema 把「界面上的文本」转成真正的参数值。
 *
 * 这一步不能省：目标工具的 run 里布尔是 `args[x] === true`、数组是 `Array.isArray`，
 * 直接把字符串塞进去会被**静默当成 false / 空数组** —— 预设看起来配好了，
 * 实际每次调用都少带那个参数，而界面上没有任何错误提示。
 * @param rule - 该参数在目标工具 schema 里的规则。
 * @param raw - 界面提交的原始值（不可信）。
 * @returns 转换后的值，或可读的拒绝原因。
 */
function coerceFixedValue(
  rule: Record<string, unknown>,
  raw: unknown,
): { ok: true; value: LocalToolFixedValue } | { ok: false; error: string } {
  const type = typeof rule['type'] === 'string' ? rule['type'] : 'string'
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw }
    const text = String(raw ?? '').trim().toLowerCase()
    if (TRUE_WORDS.has(text)) return { ok: true, value: true }
    if (FALSE_WORDS.has(text)) return { ok: true, value: false }
    return { ok: false, error: '要填 true 或 false' }
  }
  if (type === 'number' || type === 'integer') {
    const text = String(raw ?? '').trim()
    if (text === '') return { ok: false, error: '要填一个数字' }
    const n = Number(text)
    if (!Number.isFinite(n)) return { ok: false, error: `「${text}」不是数字` }
    const min = typeof rule['minimum'] === 'number' ? rule['minimum'] : undefined
    const max = typeof rule['maximum'] === 'number' ? rule['maximum'] : undefined
    const value = type === 'integer' ? Math.trunc(n) : n
    if (min !== undefined && value < min) return { ok: false, error: `不能小于 ${String(min)}` }
    if (max !== undefined && value > max) return { ok: false, error: `不能大于 ${String(max)}` }
    return { ok: true, value }
  }
  if (type === 'array') {
    const list = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string')
      : String(raw ?? '').split(/[,，、\s]+/)
    const items = list.map((item) => item.trim()).filter((item) => item !== '')
    if (items.length === 0) return { ok: false, error: '要填至少一个值（多个用逗号分隔）' }
    return { ok: true, value: items }
  }
  const text = String(raw ?? '').trim()
  if (text === '') return { ok: false, error: '要填一个值' }
  const pattern = typeof rule['pattern'] === 'string' ? rule['pattern'] : ''
  if (pattern !== '') {
    try {
      if (!new RegExp(pattern).test(text)) return { ok: false, error: '格式不符合这个参数的要求' }
    } catch { /* 正则本身写坏了不该拦住保存 */ }
  }
  return { ok: true, value: text }
}

/** 收尾：算卡片投影（标题/说明来自记录本身）。 */
function finish(record: CustomToolRecord): CustomToolValidation {
  return { ok: true, record, item: customItem(record) }
}

/**
 * 把一条记录投影成卡片（列表与保存回执共用）。
 * @param record - 已校验的记录。
 * @returns 界面用的卡片。
 */
export function customItem(record: CustomToolRecord): LocalToolItem {
  const isAlias = record.kind === 'alias'
  return {
    id: `custom:${record.name}`,
    group: 'retrieval',
    name: record.title,
    callName: record.name,
    summary: isAlias
      ? `封装 ${record.target}${Object.keys(record.fixed).length > 0 ? '（已固定 ' + Object.keys(record.fixed).join('/') + '）' : ''}`
      : '固定回答（不查数据、不出网）',
    description: record.description,
    params: isAlias ? aliasParams(record) : [],
    status: record.enabled ? 'ready' : 'needs-config',
    ...(record.enabled ? {} : { statusNote: '已停用：不会出现在任何链路的工具集里。' }),
    source: '本机工具注册表（tool_custom）',
    online: false,
    builtin: false,
    kind: record.kind,
    participation: ['ask'],
    enabled: record.enabled,
    ...(isAlias ? { target: record.target, fixed: { ...record.fixed } } : { answer: record.answer }),
  }
}

/** alias 的参数摘要（只列暴露给模型的那部分）。 */
function aliasParams(record: CustomToolRecord): LocalToolItem['params'] {
  const tool = targetTool(record.target)
  if (tool === undefined) return []
  const props = tool.parameters['properties']
  const rules = (typeof props === 'object' && props !== null ? props : {}) as Record<string, Record<string, unknown>>
  const required = Array.isArray(tool.parameters['required'])
    ? new Set(tool.parameters['required'].filter((item): item is string => typeof item === 'string'))
    : new Set<string>()
  return record.expose.map((key) => {
    const rule = rules[key] ?? {}
    const type = typeof rule['type'] === 'string' ? rule['type'] : 'any'
    const enumValues = Array.isArray(rule['enum']) ? rule['enum'].map((item) => String(item)) : []
    const note = enumValues.length > 0 ? enumValues.slice(0, 8).join(' / ') : ''
    return { name: key, required: required.has(key), type, ...(note === '' ? {} : { note }) }
  })
}

/**
 * 把启用的自定义工具装成真正的 `RetrievalTool`。
 *
 * 约定与内置工具一致：`run` **不抛错**，失败返回 `{ ok:false, error }`。
 * @param records - 注册表里的自定义工具（停用的会被跳过）。
 * @returns 可直接并入 `buildTools()` 结果数组的工具集。
 */
export function buildCustomTools(records: readonly CustomToolRecord[]): RetrievalTool[] {
  const out: RetrievalTool[] = []
  for (const record of records) {
    if (!record.enabled) continue
    if (record.kind === 'alias') {
      const built = aliasTool(record)
      if (built !== undefined) out.push(built)
      continue
    }
    out.push(answerTool(record))
  }
  return out
}

/**
 * 按入口的数据边界裁剪自定义工具。
 *
 * 「禁用微信数据」的入口（无人值守自动回复）里，只有 `answer`（固定文本、不读任何数据）
 * 可以保留；`alias` 可能读到消息，必须一起裁掉 —— 只裁内置工具不裁自定义工具，
 * 等于给数据边界开了一个只有自定义工具能走的旁门。
 * @param tools - 已装配的自定义工具。
 * @param wechatDataEnabled - 本入口是否允许读本机微信数据。
 * @returns 允许出现的工具（保持原顺序）。
 */
export function keepCustomToolsForDataBoundary(
  tools: readonly RetrievalTool[],
  wechatDataEnabled: boolean,
): RetrievalTool[] {
  if (wechatDataEnabled) return [...tools]
  return tools.filter((tool) => tool.customKind === 'answer')
}

/** `alias` 的执行体：合并固定参数后转发给内置工具。 */
function aliasTool(record: CustomToolRecord): RetrievalTool | undefined {
  const target = targetTool(record.target)
  if (target === undefined) return undefined
  const properties: Record<string, unknown> = {}
  const allProps = (target.parameters['properties'] ?? {}) as Record<string, unknown>
  for (const key of record.expose) {
    if (key in allProps) properties[key] = allProps[key]
  }
  const required = (Array.isArray(target.parameters['required']) ? target.parameters['required'] : [])
    .filter((item): item is string => typeof item === 'string' && record.expose.includes(item))
  return {
    name: record.name as ToolName,
    category: target.category,
    description: record.description,
    parameters: { type: 'object', properties, required },
    custom: true,
    customKind: 'alias',
    run: async (args, ctx): Promise<ToolResult> => {
      const locked = (ctx.scope?.username ?? '').trim()
      if (locked !== '' && LOCKED_SCOPE_UNSUPPORTED_TOOLS.has(target.name)) {
        return {
          tool: record.name as ToolName,
          ok: false,
          errorCode: 'unsupported_scope',
          error: `当前会话范围已锁定，「${target.name}」不支持按会话过滤，这个预设暂不可用`,
          hits: [],
        }
      }
      const merged: Record<string, unknown> = { ...record.fixed }
      for (const [key, value] of Object.entries(args ?? {})) {
        if (value !== undefined && value !== null && value !== '') merged[key] = value
      }
      if (locked !== '') {
        /*
         * 锁定会话时必须自己再过一遍范围检查：这个 alias 是以**自己的名字**通过
         * profile 白名单的，profile 的守卫认不出它内部转发给了哪个工具 —— 不在这里挡，
         * 固定（或模型传）另一个会话就等于绕过了「只能问当前会话」这条边界。
         * 两个参数名都要看：消息类用 `username`，通话记录用 `peer`。
         */
        for (const key of ['username', 'peer'] as const) {
          const requested = typeof merged[key] === 'string' ? String(merged[key]).trim() : ''
          if (requested !== '' && requested !== locked) {
            return {
              tool: record.name as ToolName,
              ok: false,
              errorCode: 'scope_violation',
              error: `这个预设固定了另一个会话（${requested}），与当前会话范围不一致`,
              errorDetails: { argument: key, locked, requested },
              hits: [],
            }
          }
        }
        // 没传就注入锁定值：与内置工具走守卫时的行为保持一致（否则 alias 会查全库）。
        if (targetAccepts(target, 'username') && merged['username'] === undefined) merged['username'] = locked
        if (targetAccepts(target, 'peer') && merged['peer'] === undefined) merged['peer'] = locked
      }
      try {
        const result = await target.run(merged, ctx)
        // 结果里的 `tool` 换成自定义名：过程时间线与错误文案要能对上用户看到的卡片，
        // 否则界面上会出现一个「用户没见过的工具名」。
        return { ...result, tool: record.name as ToolName }
      } catch (e) {
        return {
          tool: record.name as ToolName,
          ok: false,
          errorCode: 'upstream_failure',
          error: (e as Error)?.message ?? String(e),
          hits: [],
        }
      }
    },
  }
}

/** 目标工具是否声明了某个参数（注入锁定范围前要确认，否则等于凭空多传一个字段）。 */
function targetAccepts(tool: RetrievalTool, name: string): boolean {
  const props = tool.parameters['properties']
  return typeof props === 'object' && props !== null && name in (props as Record<string, unknown>)
}

/** `answer` 的执行体：把固定文本作为一条命中返回（零 I/O）。 */
function answerTool(record: CustomToolRecord): RetrievalTool {
  return {
    name: record.name as ToolName,
    category: 'kb',
    description: record.description,
    parameters: { type: 'object', properties: {}, required: [] },
    custom: true,
    customKind: 'answer',
    run: (): ToolResult => {
      const hit: ToolHit = {
        key: 'custom:' + record.name,
        name: record.title,
        time: '',
        snippet: record.answer,
        source: 'agg',
      }
      return {
        tool: record.name as ToolName,
        ok: true,
        hits: [hit],
        note: '本机固定回答（不查数据、不出网）',
        elapsedMs: 0,
      }
    },
  }
}
