// @vitest-environment jsdom
/** Behaviour guards for the five new right-click actions and poster geometry. */
import { describe, expect, it } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { buildMsgMenu } from './chats-support.tsx'
import { posterCaptureRect, posterFilename } from './chats-message-tools.tsx'
import {
  posterItemLocalId,
  posterItemsForSelection,
  posterMessageCount,
  togglePosterSelection,
} from './chats-poster.tsx'

const text = {
  localId: 7,
  type: 1,
  isSender: 0,
  createTime: 1700000000,
  displayText: '你好',
  strContent: '你好',
} as WechatMessage

describe('message tool menu', () => {
  it('plain text exposes all five new actions in the requested order', () => {
    const actions = buildMsgMenu(text, 'text').map(item => item.action)
    expect(actions.slice(-5)).toEqual(['poster', 'viewSource', 'messageInfo', 'editMessage', 'editSource'])
    expect(buildMsgMenu(text, 'text').map(item => item.label).slice(-5)).toEqual([
      '生成聊天海报...',
      '查看源码',
      '查看消息信息',
      '修改消息',
      '修改源码',
    ])
  })

  it('structured messages never expose destructive plain-text editing', () => {
    const actions = buildMsgMenu({ ...text, type: 3, displayText: '[图片]' }, 'image').map(item => item.action)
    expect(actions).not.toContain('editMessage')
    expect(actions).toContain('poster')
    expect(actions).toContain('viewSource')
    expect(actions).toContain('messageInfo')
    expect(actions).toContain('editSource')
  })
})

describe('poster geometry', () => {
  it('uses the avatar + message column union with padding, not the full row', () => {
    const rect = posterCaptureRect([
      { left: 120, top: 100, right: 160, bottom: 140, width: 40, height: 40 },
      { left: 170, top: 96, right: 480, bottom: 150, width: 310, height: 54 },
    ], 14)
    expect(rect).toEqual({ left: 106, top: 82, right: 494, bottom: 164, width: 388, height: 82 })
  })

  it('drops empty rectangles and sanitizes the default filename', () => {
    expect(posterCaptureRect([{ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }])).toBeNull()
    const name = posterFilename('客户:A/B?*', 42, Date.UTC(2026, 9, 22, 8, 30, 0))
    expect(name).toBe('聊天海报-客户_A_B__-42-2026-10-22-08-30-00.png')
  })
})

describe('multi-message poster selection', () => {
  const second = { ...text, localId: 9, createTime: 1700000300, displayText: '第二条' } as WechatMessage
  const third = { ...text, localId: 12, createTime: 1700000600, displayText: '第三条' } as WechatMessage
  const items: MessageRenderItem[] = [
    { kind: 'msg', m: text },
    { kind: 'day', label: '今天', key: 'day-9' },
    { kind: 'msg', m: second },
    { kind: 'group', gid: 'g1', items: [third, { ...third, localId: 13 }] },
  ]

  it('toggles ids immutably and ignores invalid ids', () => {
    const first = togglePosterSelection(new Set(), 7)
    expect([...first]).toEqual([7])
    const twice = togglePosterSelection(first, 7)
    expect([...twice]).toEqual([])
    expect([...first]).toEqual([7])
    expect([...togglePosterSelection(first, -1)]).toEqual([7])
  })

  it('keeps chronological stream order for non-contiguous selections', () => {
    const selected = new Set([12, 7, 99])
    const picked = posterItemsForSelection(items, selected)
    expect(picked.map(posterItemLocalId)).toEqual([7, 12])
    expect(picked[1]?.kind).toBe('group')
  })

  it('counts every underlying message in an image group', () => {
    const selected = new Set([7, 12])
    expect(posterMessageCount(posterItemsForSelection(items, selected))).toBe(3)
  })
})
