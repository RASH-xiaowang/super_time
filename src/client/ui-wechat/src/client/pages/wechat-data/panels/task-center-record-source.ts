/**
 * 触发记录的源码视图。
 *
 * 普通界面模式会对时间、状态、图片引用做人类可读的格式化和拆解；排查 RPA /
 * Webhook 编码问题时，需要看到原始字段与转义后的字节形态。这里只做展示转换，
 * 不改变记录本身，也不命中图片解码接口。
 */
import type { TaskTriggerRecord } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * 把一条记录序列化成可直接展示的 JSON。
 * @param record - 一条触发记录快照。
 * @returns 两空格缩进、非 ASCII 字符转为 `\\uXXXX` 的合法 JSON。
 */
export function triggerRecordSource(record: TaskTriggerRecord): string {
  return JSON.stringify(record, null, 2)
    .replace(/[^\x00-\x7F]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
