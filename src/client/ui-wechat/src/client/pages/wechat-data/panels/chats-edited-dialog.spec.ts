// @vitest-environment jsdom
/**
 * 「本会话已编辑消息」浮层的行为守卫（#19 第七刀：`chats-edited-dialog.tsx`）。
 *
 * 这一族最有价值的一条是**本轮修掉的 bug**：遮罩原先写的是无条件 `setEditedOpen(false)`，
 * 于是列表里任何一次点击都会冒泡到遮罩 —— 点「恢复原文」时浮层一闪就没，
 * 用户既看不到"恢复了哪条"也看不到"还剩几条"；连选中一行文字都会关。
 * 现在与日历/导出弹窗同一口径：只有点遮罩**本身**才关。
 * 另一半规矩是 `editing` 期间锁住「恢复原文」（两次恢复会打架，第二次会盖掉第一次的结果）。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditedMessageRecord } from '@deepseek-ai/dsh-wechat-data/types'
import type { ChatsEditedDialogProps } from './chats-edited-dialog.tsx'
import { ChatsEditedDialog, editedRowLabel } from './chats-edited-dialog.tsx'

const rec = (over: Partial<EditedMessageRecord> = {}): EditedMessageRecord =>
  ({ sessionId: 'wxid_a', localId: 12, editCount: 2, lastEditedAt: 1700000000000, ...over }) as EditedMessageRecord

const sink = {
  doReset: vi.fn((_rec: EditedMessageRecord): Promise<void> => Promise.resolve()),
  setEditedOpen: vi.fn((_open: boolean): void => { void _open }),
}

function props(over: Partial<ChatsEditedDialogProps> = {}): ChatsEditedDialogProps {
  return {
    doReset: sink.doReset,
    editedOpen: true,
    editing: false,
    edits: [rec()],
    setEditedOpen: sink.setEditedOpen,
    ...over,
  }
}

let host: HTMLDivElement
let root: Root

function show(over: Partial<ChatsEditedDialogProps> = {}): void {
  act(() => { root.render(createElement(ChatsEditedDialog, props(over))) })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)]
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}
const click = (el: Element | null | undefined): void => {
  need(el, '要点的元素')
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const textOf = (sel: string): string => q(sel)?.textContent ?? ''
const resetBtns = (): Element[] => qa('button').filter((b) => b.textContent === '恢复原文')

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const k of Object.keys(sink)) (sink as unknown as Record<string, { mockReset: () => void }>)[k]?.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('浮层的开合', () => {
  it('没打开 ⇒ 整块不渲染', () => {
    show({ editedOpen: false })
    expect(q('[data-st-dialog="chats-edited"]')).toBeNull()
  })

  it('点遮罩本身会关', () => {
    show()
    act(() => { need(q('[data-st-dialog="chats-edited"]'), '遮罩').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(sink.setEditedOpen).toHaveBeenCalledTimes(1)
    expect(sink.setEditedOpen).toHaveBeenLastCalledWith(false)
  })

  it('头部「关闭」按钮也关（这一条与遮罩那一判互不干扰）', () => {
    show()
    click(q('button[aria-label="关闭"]'))
    expect(sink.setEditedOpen).toHaveBeenCalledTimes(1)
  })

  it('本轮修的 bug：点「恢复原文」只恢复、不顺手关掉浮层', () => {
    show({ edits: [rec({ localId: 12 }), rec({ localId: 13 })] })
    expect(resetBtns().length).toBe(2)
    click(resetBtns()[1])
    const last = sink.doReset.mock.calls.at(-1)?.[0]
    expect(last?.localId, '恢复的不是被点那条').toBe(13)
    expect(sink.setEditedOpen, '点击冒泡到遮罩 ⇒ 浮层一闪就没，看不到恢复了什么').not.toHaveBeenCalled()
  })

  it('行内文字上的点击同样不该关掉浮层（选字是常事）', () => {
    show()
    click(q('[class*="editRowInfo"]'))
    expect(sink.setEditedOpen).not.toHaveBeenCalled()
  })
})

describe('列表内容', () => {
  it('空清单给的是「只改本地副本」那句说明，不是一片白', () => {
    show({ edits: [] })
    expect(textOf('[class*="emptyInline"]')).toContain('暂无编辑记录')
    expect(resetBtns().length).toBe(0)
  })

  it('每行一个按钮，doReset 收到的是那一行那条记录', () => {
    show({ edits: [rec({ sessionId: 's1', localId: 7 }), rec({ sessionId: 's2', localId: 8 })] })
    click(resetBtns()[0])
    const first = sink.doReset.mock.calls.at(-1)?.[0]
    expect([first?.sessionId, first?.localId]).toEqual(['s1', 7])
  })

  it('写盘进行中（editing）按钮锁住，点下去不做第二次恢复', () => {
    show({ editing: true })
    const btn = resetBtns()[0]
    need(btn, '恢复原文按钮')
    expect(btn?.getAttribute('disabled') ?? null, 'editing 期间还能点 ⇒ 两次恢复互相盖').not.toBeNull()
    click(btn)
    expect(sink.doReset).not.toHaveBeenCalled()
  })

  it('标题说的是「本会话」——清单是按会话过滤的，文案不能写成全部', () => {
    show()
    expect(textOf('[class*="calTitle"]')).toBe('本会话已编辑消息')
  })
})

describe('editedRowLabel：那一行读数', () => {
  it('含消息号与编辑次数，末尾跟着本地时间', () => {
    const label = editedRowLabel(rec({ localId: 12, editCount: 3, lastEditedAt: 1700000000000 }))
    expect(label.startsWith('#12 · 编辑 3 次 · ')).toBe(true)
    expect(label).toContain(new Date(1700000000000).toLocaleString())
  })

  it('编辑 0 次也照实写（不把 0 当"没有"藏掉）', () => {
    expect(editedRowLabel(rec({ editCount: 0 }))).toContain('编辑 0 次')
  })
})
