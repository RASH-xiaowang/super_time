// @vitest-environment jsdom
/**
 * 消息右键菜单的行为判据（#19 第八刀：从 `chats-view.tsx` 拆出 `chats-msg-menu.tsx`）。
 *
 * 这一族最值得钉的是**顺序**：点菜单项要"先关菜单、再执行动作"。
 * 反过来的时候不报错，但动作里任何一次 `setState`（复制成功的提示、打开详情抽屉）
 * 都会和还挂着的菜单抢位置 —— 用户看到菜单盖在新界面上，关不掉。
 * 所以这里用一条 call log 把先后钉死，而不是只断言"两个都被调用"。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { ChatsMsgMenu, type ChatsMsgMenuProps, type MsgMenuState } from './chats-msg-menu.tsx'
import type { MsgMenuItem } from './chats-support.tsx'

const msg = { localId: 42 } as unknown as WechatMessage
const open = (over: Partial<MsgMenuState> = {}): MsgMenuState => ({ m: msg, kind: 'text', x: 120, y: 240, ...over })
const items: MsgMenuItem[] = [
  { label: '复制', run: () => {} } as unknown as MsgMenuItem,
  { label: '引用', run: () => {} } as unknown as MsgMenuItem,
]

const calls: string[] = []
const onClose = vi.fn((): void => { calls.push('close') })
const onPick = vi.fn((_item: MsgMenuItem, _m: WechatMessage): void => { calls.push('pick') })

let host: HTMLDivElement
let root: Root

function show(over: Partial<ChatsMsgMenuProps> = {}): void {
  act(() => {
    root.render(createElement(ChatsMsgMenu, { msgMenu: open(), items, onClose, onPick, ...over }))
  })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}
const click = (el: Element): void => {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const down = (el: Element): void => {
  act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.length = 0
  onClose.mockClear()
  onPick.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('ChatsMsgMenu', () => {
  it('没打开时什么都不画（不给页面留一个透明的全屏拦截层）', () => {
    show({ msgMenu: null })
    expect(q('[role="menu"]')).toBeNull()
    expect(host.childElementCount).toBe(0)
  })

  it('按位置画每一项，role 是 menu/menuitem（读屏与键盘都靠它）', () => {
    show()
    const menu = need(q('[role="menu"]'), '菜单')
    expect((menu as HTMLElement).style.left).toBe('120px')
    expect((menu as HTMLElement).style.top).toBe('240px')
    const btns = [...host.querySelectorAll('[role="menuitem"]')]
    expect(btns.map((b) => b.textContent)).toEqual(['复制', '引用'])
  })

  it('点菜单项：先关菜单，再执行动作（顺序反了菜单会盖在新界面上）', () => {
    show()
    click(need(host.querySelector('[role="menuitem"]'), '第一项'))
    expect(calls, '两个动作的相对顺序就是这条判据的全部内容').toEqual(['close', 'pick'])
    expect(onPick.mock.calls[0]?.[1]).toBe(msg)
  })

  it('点空白处关掉菜单；点菜单本体不许关（否则第一项都点不到）', () => {
    show()
    down(need(q('[role="menu"]'), '菜单本体'))
    expect(onClose).not.toHaveBeenCalled()
    down(host.firstElementChild as Element)
    expect(onClose, '点遮罩必须关掉菜单').toHaveBeenCalledTimes(1)
  })

  it('菜单项来自传入的 items（菜单内容仍由 buildMsgMenu 决定，这里不自己判类型）', () => {
    show({ items: [{ label: '仅这一项' } as unknown as MsgMenuItem] })
    expect([...host.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual(['仅这一项'])
  })
})
