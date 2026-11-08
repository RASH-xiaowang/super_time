// @vitest-environment jsdom
/**
 * 真实 DOM 事件级别的滚动跟随守卫。
 *
 * 纯函数单测只能证明判定公式正确，无法证明 Hook 真的监听了用户滚动。
 * 这里用 jsdom 挂载 Hook，分别验证滚轮上翻、向上滚动和重新回到底部，
 * 防止后续重构又把「用户上翻后仍被流式内容拉回底部」带回来。
 */
import { act, createElement, useRef, type MutableRefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAskThreadAutoScroll } from './use-ask-thread-scroll.ts'

let host: HTMLDivElement
let body: HTMLDivElement
let root: Root
let atBottomRef: MutableRefObject<boolean> | null = null
let scrollHeight = 1_000
const viewportHeight = 400

function Probe({ revision }: { revision: string }): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(body)
  const followRef = useRef(true)
  atBottomRef = followRef
  useAskThreadAutoScroll({
    bodyRef,
    atBottomRef: followRef,
    asking: true,
    turns: [],
    contentRevision: revision,
  })
  return createElement('div')
}

function render(revision = '1'): void {
  act(() => {
    root.render(createElement(Probe, { revision }))
  })
}

function dispatchScroll(top: number): void {
  act(() => {
    body.scrollTop = top
    body.dispatchEvent(new Event('scroll'))
  })
}

beforeEach(() => {
  scrollHeight = 1_000
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())

  host = document.createElement('div')
  body = document.createElement('div')
  document.body.append(host, body)
  Object.defineProperty(body, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  Object.defineProperty(body, 'clientHeight', {
    configurable: true,
    get: () => viewportHeight,
  })
  let scrollTop = 0
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(Math.max(0, value), scrollHeight - viewportHeight)
    },
  })
  body.scrollTop = scrollHeight - viewportHeight
  root = createRoot(host)
  atBottomRef = null
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  body.remove()
  atBottomRef = null
  vi.unstubAllGlobals()
})

describe('useAskThreadAutoScroll：用户滚动优先', () => {
  it('向上滚动后新的流式内容不得把视图拉回底部，回到底部后恢复跟随', () => {
    render()
    expect(atBottomRef?.current).toBe(true)

    dispatchScroll(560)
    expect(atBottomRef?.current).toBe(false)

    scrollHeight = 1_500
    render('2')
    expect(body.scrollTop).toBe(560)

    dispatchScroll(1_100)
    expect(atBottomRef?.current).toBe(true)

    scrollHeight = 1_700
    render('3')
    expect(body.scrollTop).toBe(scrollHeight - viewportHeight)
  })

  it('滚轮上翻即使尚未产生位移，也立即暂停自动跟随', () => {
    render()

    const wheel = new Event('wheel', { bubbles: true })
    Object.defineProperty(wheel, 'deltaY', { value: -1 })
    act(() => { body.dispatchEvent(wheel) })

    expect(atBottomRef?.current).toBe(false)
  })

  it('键盘向上翻阅会暂停，重新回到底部仍可恢复', () => {
    render()

    act(() => {
      body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))
    })
    expect(atBottomRef?.current).toBe(false)

    expect(body.scrollTop).toBe(600)
    dispatchScroll(600)
    expect(body.scrollTop).toBe(600)
    expect(atBottomRef?.current).toBe(true)
  })
})
