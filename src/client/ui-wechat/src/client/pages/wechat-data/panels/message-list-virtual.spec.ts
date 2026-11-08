import { describe, expect, it } from 'vitest'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  MESSAGE_LIST_DOM_MAX,
  MESSAGE_LIST_ROW_OVERSCAN,
  MESSAGE_LIST_ROW_PX,
  messageListRowsForRender,
  visibleMessageListRows,
} from './message-list-virtual.ts'

function record(id: number): MessageListRecord {
  return {
    id,
    replyId: 'reply-' + String(id),
    chatName: '会话',
    targetName: '对象',
    text: '正文',
    images: [],
    triggeredAt: 1_700_000_000_000 - id,
    source: 'manual',
    status: 'pending',
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: '',
    error: '',
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function virtualizer(indices: number[], totalSize = 2_000 * MESSAGE_LIST_ROW_PX) {
  return {
    getVirtualItems: () => indices.map((index) => ({
      index,
      start: index * MESSAGE_LIST_ROW_PX,
      end: (index + 1) * MESSAGE_LIST_ROW_PX,
      size: MESSAGE_LIST_ROW_PX,
    })),
    getTotalSize: () => totalSize,
  }
}

describe('消息列表行虚拟化', () => {
  it('只返回虚拟器给出的视口行，并过滤越界下标', () => {
    const items = Array.from({ length: MESSAGE_LIST_DOM_MAX + 20 }, (_value, index) => (
      record(index + 1)
    ))
    const rows = visibleMessageListRows(
      virtualizer([0, 3, 7, 2_500]),
      items,
    )
    expect(rows.map((row) => row.index)).toEqual([0, 3, 7])
    expect(rows.every((row) => items[row.index] === row.record)).toBe(true)
  })

  it('即使虚拟器异常返回超多行，DOM 数据行仍有 120 行硬上界', () => {
    const items = Array.from({ length: 2_000 }, (_value, index) => record(index + 1))
    const rows = visibleMessageListRows(
      virtualizer(Array.from({ length: 2_000 }, (_value, index) => index)),
      items,
    )
    expect(rows).toHaveLength(MESSAGE_LIST_DOM_MAX)
    expect(MESSAGE_LIST_ROW_OVERSCAN).toBeLessThanOrEqual(50)
  })

  it('没有滚动尺寸的 SSR/首帧只渲染固定首段，仍不超过 DOM 上界', () => {
    const items = Array.from({ length: 2_000 }, (_value, index) => record(index + 1))
    const rendered = messageListRowsForRender(virtualizer([]), items)
    expect(rendered.virtualized).toBe(false)
    expect(rendered.rows).toHaveLength(30)
    expect(rendered.rows[0]?.record.id).toBe(1)
    expect(rendered.rows.at(-1)?.index).toBe(29)
    expect(rendered.pads).toEqual({ top: 0, bottom: 0 })
  })

  it('首尾撑杆使用虚拟器总高度，滚动条不会因回收行而缩水', () => {
    const items = Array.from({ length: 2_000 }, (_value, index) => record(index + 1))
    const rendered = messageListRowsForRender(
      virtualizer([10, 11, 12, 13], 2_000 * MESSAGE_LIST_ROW_PX),
      items,
    )
    expect(rendered.virtualized).toBe(true)
    expect(rendered.pads.top).toBe(10 * MESSAGE_LIST_ROW_PX)
    expect(rendered.pads.bottom).toBe(
      2_000 * MESSAGE_LIST_ROW_PX - 14 * MESSAGE_LIST_ROW_PX,
    )
  })
})
