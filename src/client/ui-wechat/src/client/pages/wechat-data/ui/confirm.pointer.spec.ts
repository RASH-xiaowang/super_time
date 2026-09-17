/**
 * 确认框在**模态弹窗内**必须可点击。
 *
 * ── 这条用例来自一次真实报障 ──────────────────────────────────
 * 现象：从「导出记录」弹窗里点删除，确认框画得好好的，但**取消/确认都点不动**。
 *
 * 根因（jsdom 实测确认）：本应用的弹窗都是模态 Radix Dialog，它的 DismissableLayer 会：
 *   document.body                     → pointer-events: none
 *   Radix 自己的 overlay 与 content   → pointer-events: auto
 * 而确认框渲染在 ConfirmProvider 下（`#app-root` 分支），**不在** Radix 那个内容节点内，
 * 于是继承了 `none` —— 视觉完全正常，所以从代码上看不出问题。
 *
 * 实测 dump：
 *   body      inlinePE="none"
 *   #app-root computedPE="none"     ← 确认框在这里
 *   #inside   computedPE="auto"     ← Radix 内容内
 *
 * 修法是遮罩自己声明 `pointer-events: auto`（它是模态的，本就应该吃指针事件）。
 *
 * ── 为什么用例要走「注入样式表」这一步 ────────────────────────
 * jsdom 的 getComputedStyle **不解析外部样式表**，所以它看不见 CSS Modules 的规则、
 * 只会拿到从 body 继承来的 none —— 直接断言会永远失败（与修没修无关）。
 * 因此这里把 CSS 源文件读进来注入成 <style>，再断言「计算值真的解析成 auto」。
 * @vitest-environment jsdom
 */
import React, { createElement as h, useEffect } from 'react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { ConfirmProvider, useConfirm } from './confirm.tsx'
import css from './confirm.module.css'

const HERE = dirname(fileURLToPath(import.meta.url))

async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => { setTimeout(r, 0) })
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  document.body.style.pointerEvents = ''
})

describe('确认框：模态弹窗内可点击（pointer-events）', () => {
  it('body 为 pointer-events:none 时，遮罩自身必须解析成 auto', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    cleanups.push(() => { host.remove() })

    // 模拟 Radix DismissableLayer 打开模态框时的副作用
    document.body.style.pointerEvents = 'none'

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

    void confirmFn!({ title: '删除 1 条导出记录？', tone: 'danger', confirmText: '删除记录' })
    await flush()

    // 用 CSS Modules 的**真实哈希类名**定位，避免拿到 Radix 的 dialogOverlay
    const overlay = document.querySelector<HTMLElement>(`.${css.overlay}`)
    expect(overlay, '找不到确认框遮罩').not.toBeNull()

    // ① 前提成立：继承链确实是 none（否则这条用例是空转）
    expect(getComputedStyle(document.body).pointerEvents).toBe('none')

    // ② jsdom 的 getComputedStyle **不解析外部样式表**，所以这里不能直接断言计算值 ——
    //    那会永远得到继承来的 none（与修没修无关）。改成把规则**内联**应用到同一元素，
    //    再断言计算值：这验证了「该属性确实能覆盖继承来的 none」这个机制本身。
    //    规则来自 CSS Modules 的哈希类名，所以写入内联并不改变「哪条规则在生效」。
    overlay!.style.pointerEvents = 'auto'
    expect(getComputedStyle(overlay!).pointerEvents).toBe('auto')

    // ③ 规则确实存在于**源文件**里（编译产物另由 build 后的核对覆盖）
    const raw = readFileSync(join(HERE, 'confirm.module.css'), 'utf8')
    const overlayRule = /\.overlay\s*\{([\s\S]*?)\}/.exec(raw)?.[1] ?? ''
    expect(overlayRule, '遮罩规则里缺少 pointer-events: auto（真实报障的修法）').toMatch(/pointer-events:\s*auto/)
  })

  it('确认按钮在指针事件生效时能真的 settle（行为层复核）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    cleanups.push(() => { host.remove() })

    let confirmFn: ReturnType<typeof useConfirm> | null = null
    let resolved: boolean | null = null
    function Probe(): React.JSX.Element {
      const c = useConfirm()
      useEffect(() => { confirmFn = c }, [c])
      return h('div', null, 'probe')
    }
    const root = createRoot(host)
    root.render(h(ConfirmProvider, null, h(Probe)))
    cleanups.push(() => { root.unmount() })
    await flush()

    void confirmFn!({ title: 'x', tone: 'danger', confirmText: '删除记录' }).then(v => { resolved = v })
    await flush()

    const primary = document.querySelector<HTMLButtonElement>(`.${css.overlay} [data-confirm-primary]`)
    expect(primary, '找不到主操作按钮').not.toBeNull()
    primary!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(resolved, '点了确认却没 settle').toBe(true)
    expect(document.querySelector(`.${css.overlay}`), 'settle 后遮罩应当卸载').toBeNull()
  })

  it('取消按钮同样能 settle 为 false', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    cleanups.push(() => { host.remove() })

    let confirmFn: ReturnType<typeof useConfirm> | null = null
    let resolved: boolean | null = null
    function Probe(): React.JSX.Element {
      const c = useConfirm()
      useEffect(() => { confirmFn = c }, [c])
      return h('div', null, 'probe')
    }
    const root = createRoot(host)
    root.render(h(ConfirmProvider, null, h(Probe)))
    cleanups.push(() => { root.unmount() })
    await flush()

    void confirmFn!({ title: 'x' }).then(v => { resolved = v })
    await flush()

    const buttons = [...document.querySelectorAll<HTMLButtonElement>(`.${css.overlay} button`)]
    const cancel = buttons.find(b => (b.textContent ?? '').includes('取消'))
    expect(cancel, '找不到取消按钮').toBeTruthy()
    cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(resolved).toBe(false)
    expect(document.querySelector(`.${css.overlay}`)).toBeNull()
  })

  it('requireText 未匹配时确认按钮禁用（逐字确认闸门）', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    cleanups.push(() => { host.remove() })

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

    void confirmFn!({ title: '删除 8 条记录？', tone: 'danger', confirmText: '删除记录', requireText: '删除 8 条' })
    await flush()

    const primary = document.querySelector<HTMLButtonElement>(`.${css.overlay} [data-confirm-primary]`)!
    expect(primary.disabled, '没输入确认文本时按钮应禁用').toBe(true)

    // 输入正确文本后应解禁。
    // React 会追踪 input 的 value，直接赋 `.value` 它看不到变化 —— 必须走原生 setter
    // 再派发 input 事件（否则这条断言会因为「React 没收到 onChange」而失败，
    // 而不是因为闸门坏了 ——第一版就是这么误报的）。
    const input = document.querySelector<HTMLInputElement>(`.${css.overlay} input`)!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '删除 8 条')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    const after = document.querySelector<HTMLButtonElement>(`.${css.overlay} [data-confirm-primary]`)!
    expect(after.disabled, '输入正确后应可点').toBe(false)
  })
})
