// @vitest-environment jsdom
/**
 * 会话列表键盘导航的纯逻辑与最小 DOM 行为。
 *
 * 为什么不是组件测试：ChatsPanel/ChatsView 的夹具极重（会话/消息/虚拟器/十几种弹窗），
 * 为一条 ArrowDown 拉起整棵面板反而测不到重点。这里只钉两件事：
 * - 边界算术（首/末行、从非行元素进入、空列表、非导航键）；
 * - `focusListRow` 真的把焦点移到下一行，并且只对导航键 preventDefault。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { focusListRow, nextListFocusIndex } from './list-keyboard.ts'

describe('nextListFocusIndex', () => {
  it('ArrowDown/ArrowUp 在首尾夹紧，不回绕', () => {
    expect(nextListFocusIndex('ArrowDown', -1, 3)).toBe(0)
    expect(nextListFocusIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextListFocusIndex('ArrowDown', 2, 3)).toBe(2)
    expect(nextListFocusIndex('ArrowUp', -1, 3)).toBe(2)
    expect(nextListFocusIndex('ArrowUp', 2, 3)).toBe(1)
    expect(nextListFocusIndex('ArrowUp', 0, 3)).toBe(0)
  })

  it('Home/End 到首/末行', () => {
    expect(nextListFocusIndex('Home', 1, 5)).toBe(0)
    expect(nextListFocusIndex('End', 1, 5)).toBe(4)
  })

  it('非导航键与空列表返回 -1，交还原生行为', () => {
    expect(nextListFocusIndex('Enter', 1, 5)).toBe(-1)
    expect(nextListFocusIndex('Tab', 1, 5)).toBe(-1)
    expect(nextListFocusIndex('ArrowDown', -1, 0)).toBe(-1)
  })
})

describe('focusListRow', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    document.body.innerHTML = ''
    host = document.createElement('div')
    for (let i = 0; i < 3; i += 1) {
      const row = document.createElement('button')
      row.type = 'button'
      row.dataset.sessionRow = String(i)
      row.textContent = 'row' + String(i)
      host.append(row)
    }
    document.body.append(host)
  })

  const keydown = (key: string): KeyboardEvent => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })

  it('从第一行按 ArrowDown 移动到第二行，并阻止默认滚动', () => {
    const rows = host.querySelectorAll<HTMLButtonElement>('[data-session-row]')
    rows[0]?.focus()
    const event = keydown('ArrowDown')
    expect(focusListRow(event as unknown as Parameters<typeof focusListRow>[0], host)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(rows[1])
  })

  it('Enter/Tab 不被接管', () => {
    const event = keydown('Enter')
    expect(focusListRow(event as unknown as Parameters<typeof focusListRow>[0], host)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('空列表不抛错也不抢焦点', () => {
    host.innerHTML = ''
    expect(focusListRow(keydown('ArrowDown') as unknown as Parameters<typeof focusListRow>[0], host)).toBe(false)
  })
})
