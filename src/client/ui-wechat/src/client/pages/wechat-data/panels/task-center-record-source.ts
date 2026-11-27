/**
 * 触发记录的源码视图。
 *
 * 普通界面模式会对时间、状态、图片引用做人类可读的格式化和拆解。源码模式展示
 * 同一条记录的完整 JSON，中文和符号保持原字符。这里只做展示转换，不改变记录本身，
 * 也不命中图片解码接口。
 */
import type { TaskTriggerRecord } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * 把一条记录序列化成可直接展示的 JSON。
 * @param record - 一条触发记录快照。
 * @returns 两空格缩进的合法 JSON，非 ASCII 字符保持原样。
 */
export function triggerRecordSource(record: TaskTriggerRecord): string {
  return JSON.stringify(record, null, 2)
}
