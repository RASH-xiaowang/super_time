// @vitest-environment jsdom
/**
 * 手写菜单关闭规则的行为判据：Esc 关且还焦点、点外关、点内不关。
 */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useMenuDismiss } from './use-menu-dismiss.ts'

function Fixture(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const { rootRef, triggerRef } = useMenuDismiss(open, () => { setOpen(false) })
  return createElement('div', null,
    createElement('div', { ref: rootRef },
      createElement('button', { ref: triggerRef, type: 'button', onClick: () => { setOpen(value => !value) } }, '更多'),
      open ? createElement('div', { role: 'menu' }, createElement('button', { type: 'button' }, '菜单项')) : null,
    ),
    createElement('button', { type: 'button', id: 'outside' }, '外部按钮'),
  )
}

let host: HTMLDivElement
let root: Root

const menu = (): Element | null => host.querySelector('[role="menu"]')
const trigger = (): HTMLButtonElement => host.querySelector('button') as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Fixture)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useMenuDismiss', () => {
  it('Esc 关闭菜单并把焦点还给触发按钮', () => {
    trigger().focus()
    expect(menu()).not.toBeNull()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('点菜单内部不关闭，点根节点外关闭', () => {
    act(() => {
      host.querySelector('[role="menu"] button')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(menu()).not.toBeNull()

    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    act(() => { outside.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
