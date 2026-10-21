/**
 * 多厂商触发的**模板 / 校验 / 参数映射**层（2026-10-21）。
 *
 * 核心管道（`dispatch.ts`）只认描述符，不认识任何具体厂商；厂商差异全部落在
 * `RpaVendorDescriptor` 里（字段、鉴权、映射、请求模板、响应规则）。本文件负责把这些
 * 声明式数据翻译成一次可发出的请求，并提供**保存/标记已完善**两处共用的校验：
 *
 *  · `defaultConfigFor` / `defaultSecretsFor` —— 新任务的默认配置 / 凭据占位；
 *  · `validateVendorConfig` —— 按字段类型 / select 选项 / pattern / URL 校验并补默认值；
 *  · `missingReadyFields` —— 「标记已完善」还缺哪些必填项（返回中文字段名）；
 *  · `renderRequest` —— 占位符渲染 + 三种语义参数按 `mapping.style` 装进厂商容器。
 *
 * 安全边界：占位符只允许 `config` / `secret` / `record` / `invocation` / `mapped` 五个根，
 * **只做字符串插值与整值替换，禁止 eval/任意表达式**；未知占位符或缺值抛可读错误，
 * 不静默留空（否则会把空参数发给厂商）。`${auth.token}` 在渲染阶段原样保留，交给
 * `auth.ts` 统一替换（凭据不进模板上下文之外的任何地方）。
 */
import type {
  RpaConfigValue,
  RpaField,
  RpaParamEntry,
  RpaParamSource,
  RpaParamStyle,
  RpaSemantic,
  RpaTriggerConfig,
  RpaTriggerSecretInput,
  RpaTriggerSecretSet,
  RpaVendorDescriptor,
} from '../../types-rpa.ts'
import type { RpaHttpRequest, RpaInvocationContext, RpaRecordContext } from './types.ts'

/** 三个语义参数位的中文名（缺映射值时的错误文案）。 */
const SEMANTIC_LABELS: Record<RpaSemantic, string> = {
  room: '会话名',
  content: '触发文本',
  at: '触发对象',
}

/** 附加参数的全部值来源（描述符可用 `field.paramSources` 收窄子集）。 */
const ALL_PARAM_SOURCES: readonly RpaParamSource[] = [
  'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
  'taskId', 'recordId', 'fixed', 'template',
]

/** 附加参数「值来源」的中文名（校验错误与文档共用同一套字面量）。 */
const PARAM_SOURCE_LABELS: Record<RpaParamSource, string> = {
  room: '会话名',
  content: '触发文本',
  at: '触发对象',
  taskName: '任务名',
  keyword: '触发关键词',
  triggeredAt: '触发时间',
  chatType: '会话类型',
  taskId: '任务 id',
  recordId: '触发记录 id',
  fixed: '固定值',
  template: '自定义模板',
}

/**
 * 自定义模板允许引用的字段（白名单，防止把凭据/无关上下文带进参数）。
 * 只允许 `${record.<字段>}` 与 `${task.<字段>}`，未知字段在保存时报错。
 */
const TEMPLATE_ALLOWED_PATHS: Readonly<Record<'record' | 'task', readonly string[]>> = {
  record: [
    'chatName', 'targetName', 'targetUsername', 'username', 'keyword', 'text',
    'chatType', 'triggeredAt',
  ],
  task: ['name', 'id'],
}

/** 地址类字段的最大长度（与旧 Webhook 回调地址口径一致）。 */
const URL_FIELD_MAX = 2048
/** 附加参数名最大长度。 */
const PARAM_NAME_MAX = 64
/** 固定值最大长度。 */
const PARAM_VALUE_MAX = 2048
/** 自定义模板最大长度。 */
const PARAM_TEMPLATE_MAX = 512
/** 整值占位符：模板值恰好等于一个 `${root.path}` 时整体替换（保留对象/数组/数字）。 */
const WHOLE_PLACEHOLDER = /^\$\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$/
/** 字符串中间的占位符。 */
const INLINE_PLACEHOLDER = /\$\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}/g

/** 是否为普通 JSON 对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 安全编译描述符里的 pattern（坏正则按"不校验"处理，不让它炸掉保存流程）。 */
function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 字段集合

/** 非敏感配置字段（写 `trigger_config`；`secret` 字段不算）。 */
export function configFieldList(descriptor: RpaVendorDescriptor): RpaField[] {
  return descriptor.fields.filter((field) => field.secret !== true)
}

/**
 * 全部凭据字段：描述符顶层 `fields` 里标了 `secret` 的，加上每个鉴权模式声明的凭据字段。
 *
 * 两种写法都是契约允许的（内置 webhook/八爪鱼把 secret 写在 `fields`，其余厂商多写在
 * `auth.modes[].fields`），这里合并去重，保存/投递/UI 从此只有一份口径。
 * @param descriptor - 厂商描述符。
 * @returns 凭据字段列表（按出现顺序，key 唯一）。
 */
export function secretFieldList(descriptor: RpaVendorDescriptor): RpaField[] {
  const out: RpaField[] = []
  const seen = new Set<string>()
  const add = (field: RpaField): void => {
    if (field.secret !== true || seen.has(field.key)) return
    seen.add(field.key)
    out.push(field)
  }
  for (const field of descriptor.fields) add(field)
  for (const mode of descriptor.auth.modes) {
    for (const field of mode.fields) add(field)
  }
  return out
}

/** 输入框的可访问名（E2E/SSR 依赖）：`ariaLabel` 优先，缺省用 label。 */
export function fieldAriaLabel(field: RpaField): string {
  return field.ariaLabel !== undefined && field.ariaLabel !== '' ? field.ariaLabel : field.label
}

// ---------------------------------------------------------------- 存储 JSON

/**
 * 解析库里的 `trigger_config` JSON（坏数据按空对象容错，不影响任务可读）。
 * @param raw - SQLite 列值（可能是 undefined / 非字符串）。
 * @returns 只保留 string/number/boolean/字符串字典的值。
 */
export function parseConfigJson(raw: unknown): RpaTriggerConfig {
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return {}
  }
  return normalizeConfigInput(value)
}

/**
 * 把运行时入参（可能不是对象 / 值类型不对）规整成配置对象：只保留白名单值。
 *
 * 用于「保存任务」把 `triggerConfig` 入参与旧字段合并：非法值丢弃后交给
 * {@link validateVendorConfig} 按描述符重新校验。
 * @param raw - 运行时入参。
 * @returns 白名单化后的配置对象。
 */
export function normalizeConfigInput(raw: unknown): RpaTriggerConfig {
  if (!isRecord(raw)) return {}
  const out: RpaTriggerConfig = {}
  for (const [key, item] of Object.entries(raw)) {
    const sanitized = sanitizeConfigValue(item)
    if (sanitized !== undefined) out[key] = sanitized
  }
  return out
}

/** 单个配置值的白名单化（对象只保留字符串值，即 map 字段；数组按附加参数条目过滤）。 */
function sanitizeConfigValue(value: unknown): RpaConfigValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) return sanitizeParamEntries(value)
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 附加参数数组的粗筛（保留 name/source/固定值/模板字符串，细校验交给 validateVendorConfig）。 */
function sanitizeParamEntries(value: unknown[]): RpaParamEntry[] {
  const out: RpaParamEntry[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['source'] !== 'string') continue
    const entry: RpaParamEntry = { name: item['name'], source: item['source'] as RpaParamSource }
    if (typeof item['fixedValue'] === 'string') entry.fixedValue = item['fixedValue']
    if (typeof item['template'] === 'string') entry.template = item['template']
    out.push(entry)
  }
  return out
}

/** 解析库里的 `trigger_secret` JSON（只保留非空字符串值；原文永不返回调用方快照）。 */
export function parseSecretJson(raw: unknown): Record<string, string> {
  const text = typeof raw === 'string' ? raw : ''
  if (text === '') return {}
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return {}
  }
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item !== '') out[key] = item
  }
  return out
}

/** 凭据原文 → 「是否已配置」快照（值非空即 true；这是唯一能出库的凭据信息）。 */
export function secretSetOf(secrets: Record<string, string>): RpaTriggerSecretSet {
  const out: RpaTriggerSecretSet = {}
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== '') out[key] = true
  }
  return out
}

// ---------------------------------------------------------------- 默认值

/** 按 `mapping.targets` 生成三个语义位的默认 key。 */
function defaultMapValue(descriptor: RpaVendorDescriptor): Record<string, string> {
  const out: Record<string, string> = {}
  for (const target of descriptor.mapping.targets) out[target.semantic] = target.defaultKey
  return out
}

/**
 * 规整 map 字段值：只保留三个语义位的字符串覆盖，缺的用 `mapping.targets` 的默认 key 补齐。
 * @param descriptor - 厂商描述符。
 * @param raw - 用户/库里的 map 值（可能不是对象）。
 * @returns 完整的 `{ room, content, at }` key 映射。
 */
function normalizeMapValue(descriptor: RpaVendorDescriptor, raw: unknown): Record<string, string> {
  const out = defaultMapValue(descriptor)
  if (!isRecord(raw)) return out
  for (const target of descriptor.mapping.targets) {
    const item = raw[target.semantic]
    if (typeof item === 'string' && item.trim() !== '') out[target.semantic] = item.trim()
  }
  return out
}

/**
 * 新任务的默认配置：描述符 `defaultValue` 存在的字段填默认；map 字段生成三键。
 * @param descriptor - 厂商描述符。
 * @returns 只含非敏感字段的初始配置。
 */
export function defaultConfigFor(descriptor: RpaVendorDescriptor): RpaTriggerConfig {
  const out: RpaTriggerConfig = {}
  for (const field of configFieldList(descriptor)) {
    if (field.type === 'map') {
      out[field.key] = normalizeMapValue(descriptor, field.defaultValue)
      continue
    }
    if (field.type === 'paramList') {
      out[field.key] = []
      continue
    }
    if (field.defaultValue !== undefined) out[field.key] = field.defaultValue
  }
  return out
}

/**
 * 凭据输入草稿：所有凭据字段都以空串出现（编辑表单从不回读原文）。
 *
 * `existing` 是已保存的「是否已配置」快照，供 UI 决定 placeholder（「已保存，留空保持不变」）；
 * 本函数刻意不把它变成值，避免任何路径把凭据口径混淆成字符串。
 * @param descriptor - 厂商描述符。
 * @param existing - 已保存凭据的布尔快照（只影响调用方展示）。
 * @returns key → 空串。
 */
export function defaultSecretsFor(
  descriptor: RpaVendorDescriptor,
  existing: RpaTriggerSecretSet,
): Record<string, string> {
  void existing
  const out: Record<string, string> = {}
  for (const field of secretFieldList(descriptor)) out[field.key] = ''
  return out
}

/**
 * 合并「本次输入的凭据」与「已保存凭据」。
 *
 * 语义（与存储层一致）：缺省（未出现的键）= 保留旧值；`''` = 清空该键；非空 = 覆盖。
 * 未知键忽略（切换厂商后旧凭据不会混进新厂商）。
 * @param descriptor - 厂商描述符。
 * @param saved - 已保存凭据原文（只在后端内存里出现）。
 * @param input - 本次输入的凭据（可能 undefined）。
 * @returns 合并后的凭据、布尔快照与校验错误。
 */
export function applySecretInput(
  descriptor: RpaVendorDescriptor,
  saved: Record<string, string>,
  input: RpaTriggerSecretInput | undefined,
): { secrets: Record<string, string>; set: RpaTriggerSecretSet; errors: string[] } {
  const secrets: Record<string, string> = {}
  for (const field of secretFieldList(descriptor)) {
    const value = saved[field.key]
    if (value !== undefined && value !== '') secrets[field.key] = value
  }
  const errors: string[] = []
  if (input !== undefined) {
    if (!isRecord(input)) {
      errors.push('凭据配置格式不正确')
    } else {
      applySecretOverrides(descriptor, secrets, input, errors)
    }
  }
  return { secrets, set: secretSetOf(secrets), errors }
}

/** `applySecretInput` 的覆盖步骤（拆出来让主函数保持简单）。 */
function applySecretOverrides(
  descriptor: RpaVendorDescriptor,
  secrets: Record<string, string>,
  input: Record<string, unknown>,
  errors: string[],
): void {
  for (const field of secretFieldList(descriptor)) {
    if (!(field.key in input)) continue
    const raw = input[field.key]
    if (typeof raw !== 'string') {
      errors.push(field.label + ' 必须是字符串')
      continue
    }
    const value = raw.trim()
    if (value === '') {
      delete secrets[field.key]
      continue
    }
    const pattern = field.pattern !== undefined ? safeRegExp(field.pattern) : null
    if (pattern !== null && !pattern.test(value)) {
      errors.push(field.label + ' 格式不正确')
      continue
    }
    secrets[field.key] = value
  }
}

// ---------------------------------------------------------------- 校验

/**
 * 校验并归一化一个非敏感配置对象（新任务/更新任务保存时调用）。
 *
 * 规则：类型按 `field.type`；`select` 必须在 `options` 内；`pattern` 只校验非空值；
 * `url` / `baseUrl` 非空时必须是 http/https 绝对地址（Webhook 兼容旧文案）。未知键丢弃。
 * @param descriptor - 厂商描述符。
 * @param config - 入参配置（运行时未受类型保护）。
 * @returns 归一化后的配置（含默认值）与中文错误列表；errors 非空 = 整单保存失败。
 */
export function validateVendorConfig(
  descriptor: RpaVendorDescriptor,
  config: RpaTriggerConfig,
): { config: RpaTriggerConfig; errors: string[] } {
  const out = defaultConfigFor(descriptor)
  const errors: string[] = []
  const raw: Record<string, unknown> = isRecord(config) ? config : {}
  for (const field of configFieldList(descriptor)) {
    const provided = raw[field.key]
    if (provided === undefined) continue
    const value = validateFieldValue(descriptor, field, provided, errors)
    if (value !== undefined) out[field.key] = value
  }
  dropExtrasCollidingWithMapping(descriptor, out, errors)
  return { config: out, errors }
}

/** 单字段校验（返回 undefined = 该字段无效，错误已写进 errors）。 */
function validateFieldValue(
  descriptor: RpaVendorDescriptor,
  field: RpaField,
  raw: unknown,
  errors: string[],
): RpaConfigValue | undefined {
  if (field.type === 'map') return normalizeMapValue(descriptor, raw)
  if (field.type === 'paramList') return validateParamListField(field, raw, errors)
  if (field.type === 'number') return validateNumberField(field, raw, errors)
  if (field.type === 'boolean') return validateBooleanField(field, raw, errors)
  if (field.type === 'select') return validateSelectField(field, raw, errors)
  return validateTextField(field, raw, errors)
}

/**
 * 附加参数与三个语义映射键重名时丢弃该条并报错。
 *
 * 为什么不在渲染时决定：重名会让「到底谁覆盖谁」取决于拼接顺序，用户看不出来；
 * 保存时就明确拒绝，比到厂商那边参数被悄悄改写更容易排查。
 */
function dropExtrasCollidingWithMapping(
  descriptor: RpaVendorDescriptor,
  config: RpaTriggerConfig,
  errors: string[],
): void {
  const extrasField = descriptor.mapping.extrasField
  if (extrasField === undefined) return
  const extras = config[extrasField]
  if (!Array.isArray(extras) || extras.length === 0) return
  const reserved = new Set(
    Object.values(normalizeMapValue(descriptor, config[descriptor.mapping.mapField]))
      .map((key) => key.toLowerCase()),
  )
  const kept = extras.filter((entry) => {
    if (!reserved.has(entry.name.toLowerCase())) return true
    errors.push('附加参数「' + entry.name + '」与参数映射的键重名（会给厂商发两个同名参数）')
    return false
  })
  config[extrasField] = kept
}

/**
 * 校验并归一化「附加参数」列表。
 *
 * 规则：参数名非空/去重/不得与语义映射键重名（后者见 {@link dropExtrasCollidingWithMapping}）；
 * `source` 必须在描述符允许集合内；`fixed` 必须有固定值；`template` 必须非空且只引用
 * 白名单字段（`${record.…}` / `${task.…}`）。空列表合法。
 */
function validateParamListField(field: RpaField, raw: unknown, errors: string[]): RpaParamEntry[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(field.label + ' 必须是参数列表')
    return undefined
  }
  const max = field.maxItems ?? 50
  if (raw.length > max) errors.push(field.label + ' 最多 ' + String(max) + ' 条')
  const allowed = new Set<RpaParamSource>(field.paramSources ?? ALL_PARAM_SOURCES)
  const out: RpaParamEntry[] = []
  const seen = new Set<string>()
  raw.forEach((item, index) => {
    const label = field.label + ' 第 ' + String(index + 1) + ' 项'
    if (out.length >= max) return
    if (!isRecord(item)) {
      errors.push(label + '格式不正确')
      return
    }
    const name = typeof item['name'] === 'string' ? item['name'].trim() : ''
    const source = typeof item['source'] === 'string' ? item['source'] as RpaParamSource : undefined
    if (name === '') {
      errors.push(label + '缺少参数名')
      return
    }
    if (name.length > PARAM_NAME_MAX) {
      errors.push(label + '参数名过长（最多 ' + String(PARAM_NAME_MAX) + ' 字符）')
      return
    }
    const lower = name.toLowerCase()
    if (seen.has(lower)) {
      errors.push(label + '参数名重复：' + name)
      return
    }
    if (source === undefined || !ALL_PARAM_SOURCES.includes(source)) {
      errors.push(label + '值来源无效')
      return
    }
    if (!allowed.has(source)) {
      errors.push(label + '不支持的值来源：' + PARAM_SOURCE_LABELS[source])
      return
    }
    const entry: RpaParamEntry = { name, source }
    if (source === 'fixed') {
      const fixed = typeof item['fixedValue'] === 'string' ? item['fixedValue'].trim() : ''
      if (fixed === '') {
        errors.push(label + '选择固定值时必须填写值')
        return
      }
      if (fixed.length > PARAM_VALUE_MAX) {
        errors.push(label + '固定值过长（最多 ' + String(PARAM_VALUE_MAX) + ' 字符）')
        return
      }
      entry.fixedValue = fixed
    } else if (source === 'template') {
      const template = typeof item['template'] === 'string' ? item['template'].trim() : ''
      const valid = validateParamTemplate(template, label, errors)
      if (valid === undefined) return
      entry.template = valid
    }
    seen.add(lower)
    out.push(entry)
  })
  return out
}

/** 自定义模板校验：只允许 `${record.<白名单字段>}` / `${task.<白名单字段>}`。 */
function validateParamTemplate(value: string, label: string, errors: string[]): string | undefined {
  if (value === '') {
    errors.push(label + '选择自定义模板时必须填写模板')
    return undefined
  }
  if (value.length > PARAM_TEMPLATE_MAX) {
    errors.push(label + '自定义模板过长（最多 ' + String(PARAM_TEMPLATE_MAX) + ' 字符）')
    return undefined
  }
  for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = (match[1] ?? '').trim()
    const dot = expr.indexOf('.')
    const root = dot === -1 ? expr : expr.slice(0, dot)
    const rest = dot === -1 ? '' : expr.slice(dot + 1)
    if (root !== 'record' && root !== 'task') {
      errors.push(label + '自定义模板只支持 record / task 字段（不支持：' + expr + '）')
      return undefined
    }
    const allowedPath = TEMPLATE_ALLOWED_PATHS[root]
    if (!(allowedPath as readonly string[]).includes(rest)) {
      errors.push(label + '自定义模板字段不在允许清单：' + expr)
      return undefined
    }
  }
  return value
}

/** 数字字段：接受 number 或数字字符串；NaN/空串报错。 */
function validateNumberField(field: RpaField, raw: unknown, errors: string[]): number | undefined {
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN)
  if (!Number.isFinite(value)) {
    errors.push(field.label + ' 必须是数字')
    return undefined
  }
  return value
}

/** 布尔字段：接受 boolean 或 'true'/'false' 字符串。 */
function validateBooleanField(field: RpaField, raw: unknown, errors: string[]): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  errors.push(field.label + ' 必须是布尔值')
  return undefined
}

/** 下拉字段：空串合法（由「必填」判定拦截），非空必须在 options 内。 */
function validateSelectField(field: RpaField, raw: unknown, errors: string[]): string | undefined {
  if (typeof raw !== 'string') {
    errors.push(field.label + ' 必须是文本')
    return undefined
  }
  const value = raw.trim()
  if (value === '') return ''
  const options = field.options ?? []
  if (!options.some((option) => option.value === value)) {
    errors.push(field.label + ' 不是可选值')
    return undefined
  }
  return value
}

/** 文本/密码字段：trim、pattern 校验、地址类字段额外校验 http(s)。 */
function validateTextField(field: RpaField, raw: unknown, errors: string[]): string | undefined {
  if (typeof raw !== 'string') {
    errors.push(field.label + ' 必须是文本')
    return undefined
  }
  const value = raw.trim()
  if (value !== '') {
    const pattern = field.pattern !== undefined ? safeRegExp(field.pattern) : null
    if (pattern !== null && !pattern.test(value)) {
      errors.push(field.label + ' 格式不正确')
      return undefined
    }
  }
  if (field.key === 'url' || field.key === 'baseUrl') return validateAddressField(field, value, errors)
  return value
}

/** 地址类字段（Webhook 回调地址 / 厂商服务地址）：空串合法，非空必须是 http/https。 */
function validateAddressField(field: RpaField, value: string, errors: string[]): string {
  if (value === '') return ''
  if (field.key === 'url' && value.length > URL_FIELD_MAX) {
    errors.push('回调地址过长（最多 ' + String(URL_FIELD_MAX) + ' 个字符）')
    return ''
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    errors.push(addressErrorText(field))
    return ''
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
    errors.push(addressErrorText(field))
    return ''
  }
  return value
}

/** 地址错误文案：Webhook 的 url 字段沿用旧「回调地址」措辞（兼容旧 spec/文案）。 */
function addressErrorText(field: RpaField): string {
  if (field.key === 'url') return '回调地址必须是合法的 http/https 地址'
  return field.label + ' 必须是合法的 http/https 地址'
}

/**
 * 「标记已完善」还缺哪些字段（空数组 = 可以标记已完善）。
 *
 * `required` 只在这里生效（保存待完善任务允许留空）。secret 字段看已保存快照
 * `secretSet[key]`；调用方若刚输入了新凭据，先合并进快照再调本函数。
 * @param descriptor - 厂商描述符。
 * @param config - 当前配置（缺省字段按默认值补齐）。
 * @param secretSet - 已配置凭据布尔快照。
 * @returns 缺失字段的中文名（按字段声明顺序）。
 */
export function missingReadyFields(
  descriptor: RpaVendorDescriptor,
  config: RpaTriggerConfig,
  secretSet: RpaTriggerSecretSet,
): string[] {
  const merged: RpaTriggerConfig = { ...defaultConfigFor(descriptor), ...config }
  const missing: string[] = []
  for (const field of configFieldList(descriptor)) {
    if (!field.required) continue
    if (isConfigFieldMissing(field, merged[field.key])) missing.push(field.label)
  }
  for (const field of secretFieldList(descriptor)) {
    if (field.required && secretSet[field.key] !== true) missing.push(field.label)
  }
  return missing
}

/** 单个非敏感字段是否算"没填"。 */
function isConfigFieldMissing(field: RpaField, value: RpaConfigValue | undefined): boolean {
  if (value === undefined) return true
  if (field.type === 'boolean') return false
  if (field.type === 'map') {
    if (!isRecord(value)) return true
    return Object.keys(value).length === 0
  }
  if (field.type === 'paramList') return !Array.isArray(value) || value.length === 0
  return String(value).trim() === ''
}

// ---------------------------------------------------------------- 迁移 / 双写

/** 旧列（2026-10-21 前的专用字段）→ 通用配置的迁移输入。 */
export interface RpaLegacyConfigColumns {
  callbackUrl?: string
  bazhuayuFlowId?: string
}

/** 读旧任务时把专用列迁移成通用配置（通用列已经有值时不要调用）。 */
export function migrateLegacyConfig(method: string, legacy: RpaLegacyConfigColumns): RpaTriggerConfig {
  const callbackUrl = typeof legacy.callbackUrl === 'string' ? legacy.callbackUrl.trim() : ''
  const flowId = typeof legacy.bazhuayuFlowId === 'string' ? legacy.bazhuayuFlowId.trim() : ''
  if (method === 'webhook' && callbackUrl !== '') return { url: callbackUrl }
  if (method === 'bazhuayu' && flowId !== '') return { flowId }
  return {}
}

/** 读旧任务时把 `bazhuayu_api_key` 迁移成通用凭据（只对 bazhuayu 有意义）。 */
export function migrateLegacySecrets(method: string, apiKey: string): Record<string, string> {
  const text = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (method !== 'bazhuayu' || text === '') return {}
  return { apiKey: text }
}

/**
 * 写库时的**双写**旧列（降级可读：旧版本应用仍能按 webhook/八爪鱼读取）。
 *
 * 新厂商没有旧列可写，三个旧列一律空串（旧版本应用会显示"待完善"，符合降级预期）。
 * @param method - 触发方式 id。
 * @param config - 通用配置。
 * @param secrets - 通用凭据原文（只取旧列认识的 `apiKey`）。
 * @returns 三个旧列的值。
 */
export function legacyColumnsFor(
  method: string,
  config: RpaTriggerConfig,
  secrets: Record<string, string>,
): { callbackUrl: string; bazhuayuFlowId: string; bazhuayuApiKey: string } {
  const url = configValueText(config['url'])
  const flowId = configValueText(config['flowId'])
  const apiKey = secrets['apiKey'] ?? ''
  return {
    callbackUrl: method === 'webhook' ? url : '',
    bazhuayuFlowId: method === 'bazhuayu' ? flowId : '',
    bazhuayuApiKey: method === 'bazhuayu' ? apiKey : '',
  }
}

/** 配置值 → 文本（非字符串返回空串，双写旧列只接受字符串）。 */
function configValueText(value: RpaConfigValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 触发方式 id 归一：空/非字符串 → 缺省值；字符串原样保留（未知 id 由注册表判定）。
 * 旧库 `trigger_method` 只有 `webhook`/`bazhuayu`；厂商 id 原样透传。
 * @param raw - 列值或入参。
 * @param fallback - 缺省值（新建 = webhook、更新 = 旧行值）。
 * @returns 触发方式 id。
 */
export function normalizeTriggerMethod(raw: unknown, fallback = 'webhook'): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text !== '') return text
  return fallback
}

// ---------------------------------------------------------------- JSON 路径 / 占位符

/**
 * 按点分路径取值，支持数组下标：`data.jobUuid`、`value[0].Key`。
 * @param root - 已解析 JSON。
 * @param path - 路径；空串返回 root。
 * @returns 取到的值；路径不存在返回 undefined。
 */
export function readJsonPath(root: unknown, path: string): unknown {
  const trimmed = path.trim()
  if (trimmed === '') return root
  const segments = trimmed.replace(/\[(\d+)\]/g, '.$1').split('.').filter((segment) => segment !== '')
  let current: unknown = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[segment]
    if (current === undefined) return undefined
  }
  return current
}

/**
 * 通用占位符渲染（`auth.ts` 的换 token 请求也复用它）。
 *
 * 字符串：整值占位符 → 原值（对象/数组/数字保留类型）；内联 → 字符串插值。
 * 数组/对象：递归。`${auth.token}` 原样保留（由 applyAuth 统一替换）。
 * @param template - 模板值。
 * @param roots - 允许的占位符根。
 * @returns 渲染后的值。
 * @throws 未知占位符 / 缺值 / 内联对象时抛可读错误。
 */
export function renderTemplate(template: unknown, roots: Record<string, unknown>): unknown {
  if (typeof template === 'string') return renderString(template, roots)
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, roots))
  if (!isRecord(template)) return template
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(template)) out[key] = renderTemplate(value, roots)
  return out
}

/** 字符串模板渲染（整值替换优先于插值）。 */
function renderString(template: string, roots: Record<string, unknown>): unknown {
  const whole = WHOLE_PLACEHOLDER.exec(template)
  if (whole !== null && whole[1] !== undefined) {
    const value = resolvePlaceholder(whole[1], roots)
    return value === undefined ? template : value
  }
  return template.replace(INLINE_PLACEHOLDER, (match: string, expr: string) => {
    if (placeholderRoot(expr) === 'auth') return match
    const value = resolvePlaceholder(expr, roots)
    if (value === undefined) return match
    if (typeof value === 'object' && value !== null) {
      throw new Error('模板占位符只能整值替换：${' + expr + '}')
    }
    return String(value)
  })
}

/** 占位符根的解析（`a.b.c` → `a`）。 */
function placeholderRoot(expr: string): string {
  const index = expr.indexOf('.')
  return index === -1 ? expr : expr.slice(0, index)
}

/** 参数容器形态名：也允许写成 `${mapped.object}` 这类「风格名后缀」（见 resolvePlaceholder）。 */
const MAPPED_STYLE_KEYS: ReadonlySet<string> = new Set([
  'object',
  'nameValueArray',
  'nameValueTypeArray',
  'jsonStringObject',
  'formParams',
])

/** 解析 `${root.path}`：`auth.token` 返回 undefined（交给 applyAuth）；其余未知/缺值抛错。 */
function resolvePlaceholder(expr: string, roots: Record<string, unknown>): unknown {
  const root = placeholderRoot(expr)
  if (root === 'auth') return undefined
  const container = roots[root]
  if (container === undefined) throw new Error('未知占位符：${' + expr + '}')
  const rest = expr.slice(root.length + 1)
  // `mapped` 根本身就是按 mapping.style 生成的容器：`${mapped}` 与其风格名后缀
  // （`${mapped.object}` / `${mapped.jsonStringObject}` …）都解析到同一个值，
  // 两种写法都能在描述符里安全使用。
  if (root === 'mapped' && rest !== '' && MAPPED_STYLE_KEYS.has(rest)) return container
  const value = rest === '' || expr === root ? container : readJsonPath(container, rest)
  if (value === undefined) throw new Error('模板占位符缺少值：${' + expr + '}')
  return value
}

// ---------------------------------------------------------------- 参数映射

/**
 * 三个语义参数位 → 厂商参数名的映射（`config.mapField` 可逐项覆盖，缺省取 targets）。
 * @param descriptor - 厂商描述符。
 * @param config - 已归一化配置。
 * @returns 语义位 → 厂商参数名。
 */
function mappingKeys(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig): Record<RpaSemantic, string> {
  const raw = config[descriptor.mapping.mapField]
  const overrides: Record<string, unknown> = isRecord(raw) ? raw : {}
  const out = {} as Record<RpaSemantic, string>
  for (const target of descriptor.mapping.targets) {
    const custom = overrides[target.semantic]
    out[target.semantic] = typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : target.defaultKey
  }
  return out
}

/**
 * 语义参数位取值：会话名 / 触发文本 / 触发对象。
 *
 * `at`（触发对象）在单聊里没有独立显示名（创建弹窗不填 targetName），回落会话名，
 * 与 2026-10-21 首版八爪鱼 `at_name` 口径一致；群聊用目标成员显示名。
 * @param record - 触发记录快照。
 * @param semantic - 语义位。
 * @returns 参数值。
 */
function semanticValue(record: RpaRecordContext, semantic: RpaSemantic): string {
  if (semantic === 'room') return record.chatName
  if (semantic === 'content') return record.text
  return record.targetName !== '' ? record.targetName : record.chatName
}

/** 按 `mapping.style` 把 key→value 字典装进厂商容器。 */
function formatMapped(entries: Array<{ name: string; value: string }>, style: RpaParamStyle): unknown {
  if (style === 'object') {
    const out: Record<string, string> = {}
    for (const entry of entries) out[entry.name] = entry.value
    return out
  }
  if (style === 'nameValueArray') {
    return entries.map((entry) => ({ name: entry.name, value: entry.value }))
  }
  if (style === 'nameValueTypeArray') {
    return entries.map((entry) => ({ name: entry.name, value: entry.value, type: 'str' }))
  }
  if (style === 'formParams') {
    return entries.map((entry) => encodeURIComponent(entry.name) + '=' + encodeURIComponent(entry.value)).join('&')
  }
  const object: Record<string, string> = {}
  for (const entry of entries) object[entry.name] = entry.value
  return JSON.stringify(object)
}

/**
 * 生成 `mapped` 根：三个语义值按映射 key 装进厂商容器（`mapping.style` 五种形态），
 * 再把「附加参数」（`mapping.extrasField`，若有）按值来源解析后追加进去。
 * @param descriptor - 厂商描述符。
 * @param ctx - 投递上下文（含配置 / 触发记录 / 任务名）。
 * @returns `object` / 数组 / JSON 字符串 / form 串（视 style）。
 * @throws 语义值缺失或附加参数模板无法解析时抛可读错误。
 */
export function resolveMapped(descriptor: RpaVendorDescriptor, ctx: RpaInvocationContext): unknown {
  const config: RpaTriggerConfig = { ...defaultConfigFor(descriptor), ...ctx.config }
  const keys = mappingKeys(descriptor, config)
  const entries: Array<{ name: string; value: string }> = []
  for (const target of descriptor.mapping.targets) {
    const value = semanticValue(ctx.record, target.semantic).trim()
    if (value === '' && target.semantic !== 'content') {
      throw new Error('缺少映射值：' + SEMANTIC_LABELS[target.semantic])
    }
    entries.push({ name: keys[target.semantic], value })
  }
  entries.push(...resolveExtraEntries(descriptor, config, ctx))
  return formatMapped(entries, descriptor.mapping.style)
}

/**
 * 解析附加参数列表（值来源 → 实际字符串）。
 *
 * 顺序即用户在表单里排列的顺序；空名字/未知来源属于非法状态（保存时已拦截），
 * 这里仍防御性跳过空名字并让未知来源抛错，避免发出半截参数。
 */
function resolveExtraEntries(
  descriptor: RpaVendorDescriptor,
  config: RpaTriggerConfig,
  ctx: RpaInvocationContext,
): Array<{ name: string; value: string }> {
  const extrasField = descriptor.mapping.extrasField
  if (extrasField === undefined) return []
  const raw = config[extrasField]
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; value: string }> = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || entry['name'].trim() === '') continue
    out.push({ name: entry['name'].trim(), value: resolveParamSourceValue(entry, ctx) })
  }
  return out
}

/**
 * 单条附加参数的「值来源」解析。
 * @param entry - 已通过保存校验的附加参数条目。
 * @param ctx - 投递上下文。
 * @returns 参数字符串（`fixed` / `template` 也在这里解析）。
 */
function resolveParamSourceValue(entry: Record<string, unknown>, ctx: RpaInvocationContext): string {
  const source = entry['source']
  if (source === 'room') return ctx.record.chatName
  if (source === 'content') return ctx.record.text
  if (source === 'at') return semanticValue(ctx.record, 'at')
  if (source === 'taskName') return ctx.taskName
  if (source === 'keyword') return ctx.record.keyword
  if (source === 'triggeredAt') return new Date(ctx.record.triggeredAt).toLocaleString('zh-CN', { hour12: false })
  if (source === 'chatType') return ctx.record.chatType === 'group' ? '群聊' : '单聊'
  if (source === 'taskId') return String(ctx.taskId)
  if (source === 'recordId') return String(ctx.recordId)
  if (source === 'fixed') return typeof entry['fixedValue'] === 'string' ? entry['fixedValue'] : ''
  if (source === 'template') {
    const rendered = renderTemplate(entry['template'] ?? '', {
      record: ctx.record,
      task: { name: ctx.taskName, id: ctx.taskId },
    })
    if (typeof rendered === 'string') return rendered
    if (typeof rendered === 'number') return String(rendered)
    if (typeof rendered === 'boolean') return rendered ? 'true' : 'false'
    throw new Error('附加参数「' + String(entry['name']) + '」的自定义模板没有解析出字符串')
  }
  throw new Error('未知附加参数来源：' + String(source))
}

/**
 * 按描述符渲染一次请求（`buildRequest` 钩子存在时由适配器覆盖，不会走到这里）。
 * @param descriptor - 厂商描述符。
 * @param ctx - 投递上下文。
 * @returns 可鉴权、可发送的 HTTP 请求。
 */
export function renderRequest(descriptor: RpaVendorDescriptor, ctx: RpaInvocationContext): RpaHttpRequest {
  const config: RpaTriggerConfig = { ...defaultConfigFor(descriptor), ...ctx.config }
  const roots: Record<string, unknown> = {
    config,
    secret: ctx.secrets,
    record: ctx.record,
    task: { name: ctx.taskName, id: ctx.taskId },
    invocation: {
      taskId: ctx.taskId,
      recordId: ctx.recordId,
      idempotencyKey: ctx.idempotencyKey,
    },
    mapped: resolveMapped(descriptor, ctx),
  }
  const url = renderTemplate(descriptor.request.url, roots)
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error(descriptor.name + ' 的请求地址模板为空')
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(descriptor.request.headers ?? {})) {
    const rendered = renderTemplate(value, roots)
    headers[key] = typeof rendered === 'string' ? rendered : String(rendered)
  }
  const renderedBody = renderTemplate(descriptor.request.body, roots)
  const contentType = descriptor.request.contentType
    ?? findHeaderValue(headers, 'content-type')
    ?? 'application/json'
  return {
    method: descriptor.request.method,
    url: url.trim(),
    headers,
    body: typeof renderedBody === 'string' ? renderedBody : JSON.stringify(renderedBody ?? {}),
    contentType,
  }
}

/** 大小写不敏感地取 header 值。 */
function findHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}
