// @vitest-environment jsdom
/**
 * 手写浮层的两条**全局**副作用：
 *  ① keep-alive 把面板 `display:none` 之后，`useDialogFocus` 仍持有 Tab 拦截 ——
 *     可聚焦列表为空，原实现无条件 `preventDefault`，切到别的页签后全应用 Tab 失效；
 *  ② 更高层的 Radix alertdialog 已经处理 Escape（`defaultPrevented`）时，
 *     下面那层手写浮层不能再跟着关。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDialogFocus, useEscapeToClose } from './kit-overlay.tsx'

let host: HTMLDivElement
let root: Root

function Probe({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  useDialogFocus(open, '[data-st-dialog="probe"]')
  useEscapeToClose(open, onClose)
  return createElement('div')
}

function mount(onClose: () => void = () => undefined): void {
  act(() => { root.render(createElement(Probe, { open: true, onClose })) })
}

/** jsdom 不做布局：显式把容器和按钮伪装成「可见」。 */
function markVisible(): void {
  const dialog = document.querySelector<HTMLElement>('[data-st-dialog="probe"]')
  if (!dialog) throw new Error('浮层容器不存在')
  dialog.getClientRects = (() => ({ length: 1 })) as unknown as typeof dialog.getClientRects
  for (const el of dialog.querySelectorAll<HTMLElement>('button')) {
    Object.defineProperty(el, 'offsetParent', { get: () => dialog, configurable: true })
  }
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { document.dispatchEvent(event) })
  return event
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
})

describe('useDialogFocus：面板被 keep-alive 隐藏后不能再接管 Tab', () => {
  it('容器不可见（display:none）⇒ 不 preventDefault，全局 Tab 保持可用', () => {
    document.body.insertAdjacentHTML('beforeend',
      '<div data-st-dialog="probe"><button>一</button><button>二</button></div><button id="outside">外面</button>')
    const outside = document.getElementById('outside')!
    mount()

    const event = keydown({ key: 'Tab' })

    expect(event.defaultPrevented, '不可见的浮层还在吞 Tab').toBe(false)
    expect(document.activeElement).not.toBeInstanceOf(HTMLButtonElement)
    expect(outside.isConnected).toBe(true)
  })

  it('容器可见 ⇒ 仍然把 Tab 锁在浮层内（首尾循环）', () => {
    document.body.insertAdjacentHTML('beforeend',
      '<div data-st-dialog="probe"><button id="first">一</button><button id="last">二</button></div>')
    markVisible()
    mount()
    const last = document.getElementById('last')!
    last.focus()

    const event = keydown({ key: 'Tab' })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('first'))
  })
})

describe('useEscapeToClose：更高层弹窗已处理时不再连坐', () => {
  beforeEach(() => {
    document.body.insertAdjacentHTML('beforeend', '<div data-st-dialog="probe"><button>一</button></div>')
  })

  it('Escape 未被处理 ⇒ 关闭当前浮层', () => {
    const onClose = vi.fn()
    mount(onClose)

    keydown({ key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape 已被 Radix alertdialog 在捕获阶段 preventDefault ⇒ 不再关闭下面这层', () => {
    const onClose = vi.fn()
    mount(onClose)
    const swallow = (event: Event): void => { event.preventDefault() }
    document.addEventListener('keydown', swallow, true)

    keydown({ key: 'Escape' })

    document.removeEventListener('keydown', swallow, true)
    expect(onClose).not.toHaveBeenCalled()
  })
})
