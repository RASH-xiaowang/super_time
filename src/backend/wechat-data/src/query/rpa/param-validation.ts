/**
 * 「附加参数」列表的服务端校验。
 *
 * 与前端 `task-center-param-list.ts` 保持同一套规则：参数名唯一、值来源白名单、
 * 固定值非空、自定义模板只引用 record/task 白名单字段。拆出本文件是为了让
 * `template.ts` 继续满足单文件行数约束。
 */
import type { RpaField, RpaParamEntry, RpaParamSource } from '../../types-rpa.ts'
import { RPA_PARAM_SOURCES } from './param-sources.ts'

/** 附加参数名最大长度。 */
const PARAM_NAME_MAX = 64
/** 固定值最大长度。 */
const PARAM_VALUE_MAX = 2048
/** 自定义模板最大长度。 */
const PARAM_TEMPLATE_MAX = 512

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
  imagesJson: '触发图片（JSON 链接清单）',
  imageCount: '触发图片数量',
  firstImageUrl: '首张图片链接',
  fixed: '固定值',
  template: '自定义模板',
}

/** 自定义模板允许引用的字段（凭据/无关上下文不得进入参数）。 */
const TEMPLATE_ALLOWED_PATHS: Readonly<Record<'record' | 'task', readonly string[]>> = {
  record: [
    'chatName', 'targetName', 'targetUsername', 'username', 'keyword', 'text',
    'chatType', 'triggeredAt',
  ],
  task: ['name', 'id'],
}

/** 是否为普通 JSON 对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验并归一化「附加参数」列表。
 *
 * 规则：参数名非空/去重；`source` 必须在描述符允许集合内；`fixed` 必须有固定值；
 * `template` 必须非空且只引用白名单字段。空列表合法。
 */
export function validateParamListField(
  field: RpaField,
  raw: unknown,
  errors: string[],
): RpaParamEntry[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push(field.label + ' 必须是参数列表')
    return undefined
  }
  const max = field.maxItems ?? 50
  if (raw.length > max) errors.push(field.label + ' 最多 ' + String(max) + ' 条')
  const allowed = new Set<RpaParamSource>(field.paramSources ?? RPA_PARAM_SOURCES)
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
    if (source === undefined || !RPA_PARAM_SOURCES.includes(source)) {
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
