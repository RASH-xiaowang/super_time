// @vitest-environment jsdom
/**
 * 确认框的键盘可达性（Phase 3c）：
 * - 打开时把焦点送到主按钮；
 * - Tab/Shift+Tab 在 alertdialog 内循环，不跑到背后的页面；
 * - 关闭后焦点归还触发元素，键盘用户不会“掉到 body”。
 *
 * 这里不测样式，只测 DOM 焦点事实；样式/ARIA 属性由现有 `confirm.pointer.spec.ts`
 * 与源码中的 `role=alertdialog` 判据覆盖。
 */
import React, { createElement as h, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { ConfirmProvider, useConfirm } from './confirm.tsx'

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  document.body.innerHTML = ''
})

describe('确认框 a11y：焦点进入、循环、归还', () => {
  it('打开后焦点在主按钮，Tab 在弹窗内循环，关闭后回到触发按钮', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开确认'
    document.body.append(trigger)
    trigger.focus()

    const host = document.createElement('div')
    document.body.append(host)
    let confirmFn: ReturnType<typeof useConfirm> | null = null
    function Probe(): React.JSX.Element {
      const c = useConfirm()
      useEffect(() => { confirmFn = c }, [c])
      return h('div', null, 'probe')
    }
    const root = createRoot(host)
    root.render(h(ConfirmProvider, null, h(Probe)))
    cleanups.push(() => { root.unmount() })
    await flush()

    let resolved: boolean | null = null
    void confirmFn!({ title: '删除？', message: '不可恢复', tone: 'danger', confirmText: '删除' })
      .then((value) => { resolved = value })
    await flush()

    const primary = document.querySelector<HTMLButtonElement>('[data-confirm-primary]')
    expect(primary, '找不到确认按钮').not.toBeNull()
    expect(document.activeElement, '打开后没有把焦点送到主按钮').toBe(primary)

    // 主按钮是 Tab 序列最后一个：再 Tab 应回到第一个（取消）。
    primary!.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    const cancel = buttons.find((b) => b.textContent?.includes('取消'))
    expect(cancel, '找不到取消按钮').toBeTruthy()
    expect(document.activeElement, 'Tab 跑出了确认框').toBe(cancel)

    // 第一个是取消：Shift+Tab 应回到最后一个（主按钮）。
    cancel!.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement, 'Shift+Tab 没有回绕到主按钮').toBe(primary)

    cancel!.click()
    await flush()
    expect(resolved).toBe(false)
    expect(document.activeElement, '关闭后焦点没有还给触发元素').toBe(trigger)
  })
})
