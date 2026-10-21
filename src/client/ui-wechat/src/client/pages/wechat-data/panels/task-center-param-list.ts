/**
 * 「附加参数」（描述符 `type: 'paramList'` 字段）的**纯逻辑**：值来源、默认值、归一化、
 * 校验与搜索扁平化。供 `task-center.ts`（草稿/保存/搜索）和 `task-center-param-list-field.tsx`
 * （控件）共用。
 *
 * 为什么单开一份：
 *  · `task-center.ts` 已到 M21 的 1000 行硬上限，paramList 的规则（11 种来源、模板白名单、
 *    与参数映射键重名、maxItems）体积不小；
 *  · 这些规则与后端 `rpa/template.ts#validateParamListField` 同口径，前端提前拦能给出
 *    行内中文错误（后端只回一条 error 字符串）；
 *  · 本文件**不 import react**，纯函数可直接单测。
 *
 * 与后端的对应关系（前端错误文案独立可读，但判定顺序保持一致）：
 *  ① 参数名 trim 后非空、≤64、不区分大小写去重；
 *  ② `source` 必须在 `field.paramSources`（缺省 = 全部 11 种）里；
 *  ③ `fixed` 必填值（trim 后非空、≤2048）；`template` 必填（trim 后非空、≤512），
 *    且占位符只许 `${record.<白名单>}` / `${task.<白名单>}`；
 *  ④ 仅当厂商声明了 `mapping.mapField`（= 仍有「三个内置参数」）时，才校验参数名不得与
 *     map 字段的三个最终键重名；八爪鱼 v1.2.0 已删除内置参数（`targets: []`、无 `mapField`），
 *     此时所有参数都在本列表里显式添加，自然没有保留键；
 *  ⑤ 超过 `field.maxItems`（缺省 50）报错，多出的条目不再逐条校验（与后端一致）。
 */
import type {
  RpaConfigValue,
  RpaField,
  RpaParamEntry,
  RpaParamSource,
  RpaTriggerConfig,
  RpaVendorDescriptor,
} from '@deepseek-ai/dsh-wechat-data/types'

/** 附加参数的全部值来源（描述符可用 `field.paramSources` 收窄子集）。 */
export const ALL_PARAM_SOURCES: readonly RpaParamSource[] = [
  'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
  'taskId', 'recordId', 'fixed', 'template',
]

/** 值来源的中文名（下拉选项、行内错误、文档共用同一套字面量）。 */
export const PARAM_SOURCE_LABELS: Record<RpaParamSource, string> = {
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

/** 参数名最大长度（与后端 `PARAM_NAME_MAX` 同口径）。 */
export const PARAM_NAME_MAX = 64
/** 固定值最大长度。 */
export const PARAM_VALUE_MAX = 2048
/** 自定义模板最大长度。 */
export const PARAM_TEMPLATE_MAX = 512
/** 未声明 `maxItems` 时的缺省上限（与后端 `default 50` 同口径）。 */
export const DEFAULT_PARAM_LIST_MAX = 50

/**
 * 自定义模板允许引用的字段（与后端白名单逐字一致；凭据/任意上下文不得进模板）。
 */
export const TEMPLATE_ALLOWED_PATHS: Readonly<Record<'record' | 'task', readonly string[]>> = {
  record: [
    'chatName', 'targetName', 'targetUsername', 'username', 'keyword', 'text',
    'chatType', 'triggeredAt',
  ],
  task: ['name', 'id'],
}

/** 模板输入框的 placeholder 示例（给人看的，不参与校验）。 */
export const TEMPLATE_PLACEHOLDER = '${record.chatName}'

/** 是否为普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 下拉选项：描述符 `paramSources` 收窄时只列收窄后的集合（顺序保持全量顺序）。
 * @param field - paramList 字段描述符。
 * @returns `{value,label}` 列表。
 */
export function paramSourceOptions(field: RpaField): readonly { value: RpaParamSource; label: string }[] {
  const allowed = field.paramSources === undefined ? ALL_PARAM_SOURCES : ALL_PARAM_SOURCES.filter((source) => field.paramSources?.includes(source))
  return allowed.map((source) => ({ value: source, label: PARAM_SOURCE_LABELS[source] }))
}

/**
 * 该字段允许的最大条目数（`field.maxItems` 缺省 50）。
 * @param field - paramList 字段描述符。
 * @returns 正整数上限。
 */
export function maxParamItems(field: RpaField): number {
  const raw = field.maxItems
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PARAM_LIST_MAX
}

/**
 * 新任务的默认值：空列表（不是 undefined，保存时「整体带数组」语义更稳定）。
 * @returns 新的空数组。
 */
export function defaultParamListValue(): RpaParamEntry[] {
  return []
}

/**
 * 从任务配置读入附加参数（保留数组；非数组/脏条目丢弃，字符串 trim 留给保存归一）。
 * @param config - `triggerConfig`。
 * @param key - 字段 key（`mapping.extrasField`）。
 * @returns 条目浅拷贝（编辑时不会改到任务快照）。
 */
export function paramEntriesOf(config: RpaTriggerConfig, key: string): RpaParamEntry[] {
  const raw = config[key]
  if (!Array.isArray(raw)) return []
  const out: RpaParamEntry[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    if (typeof item['name'] !== 'string' || typeof item['source'] !== 'string') continue
    const entry: RpaParamEntry = { name: item['name'], source: item['source'] as RpaParamSource }
    if (typeof item['fixedValue'] === 'string') entry.fixedValue = item['fixedValue']
    if (typeof item['template'] === 'string') entry.template = item['template']
    out.push(entry)
  }
  return out
}

/**
 * 「添加参数」的新行：参数名留空，值来源默认取描述符允许的第一个来源。
 * @param field - paramList 字段描述符。
 * @returns 新条目。
 */
export function newParamEntry(field: RpaField): RpaParamEntry {
  return { name: '', source: paramSourceOptions(field)[0]?.value ?? 'room' }
}

/**
 * 追加一条（达到 maxItems 时返回原数组，避免无意义重渲染）。
 * @param entries - 现有条目。
 * @param field - paramList 字段描述符。
 * @returns 新数组或原数组。
 */
export function appendParamEntry(entries: readonly RpaParamEntry[], field: RpaField): RpaParamEntry[] {
  if (entries.length >= maxParamItems(field)) return entries as RpaParamEntry[]
  return [...entries, newParamEntry(field)]
}

/**
 * 就地更新某一行（只合并非 undefined 的键；切来源时保留另一分支的旧值也没关系，
 * 保存归一化只写当前来源需要的字段）。
 * @param entries - 现有条目。
 * @param index - 行下标。
 * @param patch - 要覆盖的字段。
 * @returns 新数组。
 */
export function updateParamEntry(
  entries: readonly RpaParamEntry[],
  index: number,
  patch: Partial<RpaParamEntry>,
): RpaParamEntry[] {
  return entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry))
}

/**
 * 删除某一行。
 * @param entries - 现有条目。
 * @param index - 行下标。
 * @returns 新数组（越界时保持原内容的新数组）。
 */
export function removeParamEntry(entries: readonly RpaParamEntry[], index: number): RpaParamEntry[] {
  return entries.filter((_, i) => i !== index)
}

/**
 * 保存归一化：只保留当前来源需要的字段并 trim（与后端 `sanitizeParamEntries` 同口径）。
 *
 *  · 缺 `name`/`source` 的条目丢弃（UI 每行都带这两个字段，出现即脏数据）；
 *  · `fixed` 只带 `fixedValue`，`template` 只带 `template`，其余来源两个都不带；
 *  · 空数组原样返回新数组（保存时 `triggerConfig` 要整体带）。
 * @param raw - 草稿里的配置值（类型未知）。
 * @returns 归一后的条目数组。
 */
export function normalizeParamListEntries(raw: unknown): RpaParamEntry[] {
  if (!Array.isArray(raw)) return []
  const out: RpaParamEntry[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = typeof item['name'] === 'string' ? item['name'].trim() : ''
    const source = typeof item['source'] === 'string' ? item['source'] as RpaParamSource : undefined
    if (name === '' || source === undefined) continue
    const entry: RpaParamEntry = { name, source }
    if (source === 'fixed') {
      const fixed = typeof item['fixedValue'] === 'string' ? item['fixedValue'].trim() : ''
      if (fixed !== '') entry.fixedValue = fixed
    } else if (source === 'template') {
      const template = typeof item['template'] === 'string' ? item['template'].trim() : ''
      if (template !== '') entry.template = template
    }
    out.push(entry)
  }
  return out
}

/** 模板校验结果：非法时返回可读错误。 */
function templateError(value: string, label: string): string | undefined {
  if (value === '') return `${label}选择自定义模板时必须填写模板`
  if (value.length > PARAM_TEMPLATE_MAX) return `${label}自定义模板过长（最多 ${String(PARAM_TEMPLATE_MAX)} 字符）`
  for (const match of value.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = (match[1] ?? '').trim()
    const dot = expr.indexOf('.')
    const root = dot === -1 ? expr : expr.slice(0, dot)
    const rest = dot === -1 ? '' : expr.slice(dot + 1)
    if (root !== 'record' && root !== 'task') {
      return `${label}自定义模板只支持 record / task 字段（不支持：${expr}）`
    }
    const allowed = TEMPLATE_ALLOWED_PATHS[root]
    if (!allowed.includes(rest)) return `${label}自定义模板字段不在允许清单：${expr}`
  }
  return undefined
}

/** 单行校验结果（`row` 有值 = 该行第一条错误）。 */
interface ParamRowResult {
  entry?: RpaParamEntry
  rowError?: string
}

/**
 * 校验一行（顺序与后端 validateParamListField 一致：参数名 → 来源 → 值与模板）。
 * @param field - paramList 字段描述符。
 * @param item - 行原始数据。
 * @param index - 行号（0 基，用于文案）。
 * @param seen - 已出现参数名（小写）。
 * @param reserved - 参数映射保留键（小写）。
 * @returns 通过时 normalized entry；失败时 rowError。
 */
function validateParamRow(
  field: RpaField,
  item: unknown,
  index: number,
  seen: Set<string>,
  reserved: ReadonlySet<string>,
): ParamRowResult {
  const label = `${field.label} 第 ${String(index + 1)} 项`
  if (!isRecord(item)) return { rowError: `${label}格式不正确` }
  const name = typeof item['name'] === 'string' ? item['name'].trim() : ''
  if (name === '') return { rowError: `${label}缺少参数名` }
  if (name.length > PARAM_NAME_MAX) return { rowError: `${label}参数名过长（最多 ${String(PARAM_NAME_MAX)} 字符）` }
  const lower = name.toLowerCase()
  if (seen.has(lower)) return { rowError: `${label}参数名重复：${name}` }
  if (reserved.has(lower)) return { rowError: `${label}参数名「${name}」与参数映射的键重名（会给厂商发两个同名参数）` }
  const source = typeof item['source'] === 'string' ? item['source'] as RpaParamSource : undefined
  if (source === undefined || !ALL_PARAM_SOURCES.includes(source)) return { rowError: `${label}值来源无效` }
  const allowed = field.paramSources
  if (allowed !== undefined && !allowed.includes(source)) {
    return { rowError: `${label}不支持的值来源：${PARAM_SOURCE_LABELS[source]}` }
  }
  const entry: RpaParamEntry = { name, source }
  if (source === 'fixed') {
    const fixed = typeof item['fixedValue'] === 'string' ? item['fixedValue'].trim() : ''
    if (fixed === '') return { rowError: `${label}选择固定值时必须填写值` }
    if (fixed.length > PARAM_VALUE_MAX) return { rowError: `${label}固定值过长（最多 ${String(PARAM_VALUE_MAX)} 字符）` }
    entry.fixedValue = fixed
  } else if (source === 'template') {
    const template = typeof item['template'] === 'string' ? item['template'].trim() : ''
    const message = templateError(template, label)
    if (message !== undefined) return { rowError: message }
    entry.template = template
  }
  seen.add(lower)
  return { entry }
}

/**
 * 校验一个 paramList 字段（行内错误 + 列表级错误，均与后端同口径）。
 *
 * 错误 key 约定：行内 = `${field.key}:${index}`（0 基；控件按行展示），
 * 列表级（超 maxItems / 值不是数组）= `${field.key}`。
 * @param field - paramList 字段描述符。
 * @param raw - 草稿里的值。
 * @param reservedKeys - 参数映射最终键（大小写不敏感）。
 * @returns 错误字典（空对象 = 合法）。
 */
export function validateParamList(field: RpaField, raw: RpaConfigValue | undefined, reservedKeys: readonly string[]): Record<string, string> {
  const errors: Record<string, string> = {}
  if (raw === undefined) return errors
  if (!Array.isArray(raw)) {
    errors[field.key] = `${field.label}必须是参数列表`
    return errors
  }
  const max = maxParamItems(field)
  if (raw.length > max) errors[field.key] = `${field.label}最多 ${String(max)} 条`
  const seen = new Set<string>()
  const reserved = new Set(reservedKeys.map((key) => key.toLowerCase()))
  const limit = Math.min(raw.length, max)
  for (let index = 0; index < limit; index += 1) {
    const result = validateParamRow(field, raw[index], index, seen, reserved)
    if (result.rowError !== undefined) errors[`${field.key}:${String(index)}`] = result.rowError
  }
  return errors
}

/**
 * 参数映射的最终键（用户改过的值优先，缺省用 `mapping.targets[].defaultKey`）。
 *
 * 厂商没有内置语义参数时（`mapping.mapField` 未声明 / `targets` 为空，如八爪鱼 v1.2.0）
 * 返回空数组：此时不存在保留键，附加参数可以自由使用任意参数名。
 * @param descriptor - 厂商描述符。
 * @param config - 当前配置。
 * @returns 保留键（保留原大小写，供展示/比较）；没有内置映射时为空数组。
 */
export function resolvedMapKeys(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig): string[] {
  const mapField = descriptor.mapping.mapField
  if (mapField === undefined) return []
  const raw = config[mapField]
  const map = isRecord(raw) ? raw : {}
  return descriptor.mapping.targets.map((target) => {
    const value = typeof map[target.semantic] === 'string' ? String(map[target.semantic]).trim() : ''
    return value === '' ? target.defaultKey : value
  })
}

/**
 * 按描述符校验整份配置里的所有 paramList 字段（`validateTaskDraft` 的合并入口）。
 * @param descriptor - 厂商描述符。
 * @param config - 草稿配置。
 * @returns 错误字典（key 规则见 {@link validateParamList}）。
 */
export function validateParamListConfig(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig): Record<string, string> {
  const out: Record<string, string> = {}
  const reserved = resolvedMapKeys(descriptor, config)
  for (const field of descriptor.fields) {
    if (field.type !== 'paramList' || field.secret === true) continue
    Object.assign(out, validateParamList(field, config[field.key], reserved))
  }
  return out
}

/**
 * 配置扁平化（任务搜索用；与后端「flatten config 字符串值」同口径）。
 *
 * map 的值、附加参数的参数名/固定值/模板都会参与搜索——用户可能记得的是自己起的参数名。
 * @param config - `triggerConfig`。
 * @returns 扁平后的字符串列表。
 */
export function flattenConfigValues(config: RpaTriggerConfig): string[] {
  const out: string[] = []
  const walk = (value: RpaConfigValue): void => {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value))
    else if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry.name !== '') out.push(entry.name)
        if (entry.fixedValue !== undefined && entry.fixedValue !== '') out.push(entry.fixedValue)
        if (entry.template !== undefined && entry.template !== '') out.push(entry.template)
      }
    } else if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) walk(inner)
    }
  }
  for (const value of Object.values(config)) walk(value)
  return out
}
