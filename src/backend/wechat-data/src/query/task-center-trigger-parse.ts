/**
 * 触发记录里 `images` / `texts` 两列的 JSON 解析。
 *
 * 为什么单独一个文件（2026-11-24）：`query/task-center.ts` 已贴着 M21 的 1000 行上限，
 * 而这两段是**纯解析**（读一列 JSON、逐项校验形状、坏项丢弃），与 CRUD/校验无关。
 * 搬出来之后主文件回到上限以内，解析规则也集中在一处 —— 图片与文本的容错口径
 * 本来就该并排看（两者都是「坏一条不影响其余」）。
 *
 * 两个函数都**不抛错**：任务配置坏掉不等于整个任务不可用，坏项直接丢。
 *
 * @module query/task-center-trigger-parse
 */
import type { TaskTriggerImage, TaskTriggerText } from '../types.ts'

/** 单元格 → 字符串（null/undefined → 空串）。 */
function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') return String(raw)
  return ''
}

/** 单元格 → 非负整数（非法值归 0）。 */
function numOf(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 触发图片数组解析（逐项校验形状，坏项丢弃）。 */
export function parseTriggerImages(raw: unknown): TaskTriggerImage[] {
  const text = textOf(raw)
  if (text === '') return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    const out: TaskTriggerImage[] = []
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const localId = numOf(row['localId'])
      if (localId <= 0) continue
      const image: TaskTriggerImage = {
        localId,
        createTime: numOf(row['createTime']),
        sender: textOf(row['sender']),
      }
      const senderUsername = textOf(row['senderUsername'])
      if (senderUsername !== '') image.senderUsername = senderUsername
      const senderEnterpriseName = textOf(row['senderEnterpriseName'])
      if (senderEnterpriseName !== '') image.senderEnterpriseName = senderEnterpriseName
      const md5 = textOf(row['md5'])
      if (md5 !== '') image.md5 = md5
      const url = textOf(row['url'])
      if (url.startsWith('http://') || url.startsWith('https://')) image.url = url
      out.push(image)
    }
    return out
  } catch {
    return []
  }
}

/** 触发文本数组解析（逐项校验形状，坏项丢弃）。只接受有正文的条目。 */
export function parseTriggerTexts(raw: unknown): TaskTriggerText[] {
  const text = textOf(raw)
  if (text === '') return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    const out: TaskTriggerText[] = []
    for (const item of value) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>
      const body = textOf(row['text']).trim()
      if (body === '') continue
      out.push({
        localId: numOf(row['localId']),
        createTime: numOf(row['createTime']),
        sender: textOf(row['sender']),
        text: body,
      })
    }
    return out
  } catch {
    return []
  }
}
