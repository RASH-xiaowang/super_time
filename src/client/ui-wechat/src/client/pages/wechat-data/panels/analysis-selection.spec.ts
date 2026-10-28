/**
 * 分析目标选择的口径。
 *
 * 「自动选中最近一条」必须和消息流看到的一致，且绝不能把本人消息、图片、系统提示送进
 * 意图分析。这个口径决定打开面板后的第一条请求，错了会直接让用户看到「自己发的消息」
 * 或一条没有文字可分析的内容。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import {
  findMessageByLocalId, isAnalyzableMessage, latestAnalyzableMessage,
} from './analysis-selection.ts'
import type { MessageRenderItem } from '../utils/message-items.ts'

function message(overrides: Partial<WechatMessage>): WechatMessage {
  return {
    localId: 1,
    type: 1,
    isSender: 0,
    createTime: 1_700_000_000,
    renderType: 'text',
    strContent: '你好',
    ...overrides,
  }
}

function msg(m: WechatMessage): MessageRenderItem {
  return { kind: 'msg', m }
}

describe('分析目标选择', () => {
  it('只接受别人发来的文本或语音', () => {
    expect(isAnalyzableMessage(message({}))).toBe(true)
    expect(isAnalyzableMessage(message({ type: 34, renderType: 'voice' }))).toBe(true)
    expect(isAnalyzableMessage(message({ isSender: 1 }))).toBe(false)
    expect(isAnalyzableMessage(message({ type: 3, renderType: 'image' }))).toBe(false)
    expect(isAnalyzableMessage(message({ type: 10000, renderType: 'system' }))).toBe(false)
  })

  it('自动选中最近一条可分析消息，按渲染顺序而不是另排时间', () => {
    const items: MessageRenderItem[] = [
      msg(message({ localId: 1, createTime: 100 })),
      msg(message({ localId: 2, createTime: 300, renderType: 'image', type: 3 })),
      msg(message({ localId: 3, createTime: 200, type: 34, renderType: 'voice' })),
      msg(message({ localId: 4, createTime: 999, isSender: 1 })),
      msg(message({ localId: 5, createTime: 500, type: 10000, renderType: 'system' })),
    ]
    expect(latestAnalyzableMessage(items)?.localId).toBe(3)
  })

  it('没有可选消息时返回 undefined，不拿自己的消息凑数', () => {
    const items: MessageRenderItem[] = [
      msg(message({ localId: 1, isSender: 1 })),
      { kind: 'day', label: '昨天', key: 'day-1' },
    ]
    expect(latestAnalyzableMessage(items)).toBeUndefined()
  })

  it('按 localId 找当前消息，跨会话同名 id 由调用方清空状态保证不串', () => {
    const items: MessageRenderItem[] = [
      msg(message({ localId: 11, strContent: '第一条' })),
      msg(message({ localId: 12, strContent: '第二条' })),
    ]
    expect(findMessageByLocalId(items, 12)?.strContent).toBe('第二条')
    expect(findMessageByLocalId(items, 99)).toBeUndefined()
  })
})
