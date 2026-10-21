// @vitest-environment jsdom
/**
 * FoldableBar 的媒体查询监听必须与组件生命周期成对：
 * 页面反复切走再切回时，未摘掉的 change 监听会一直持有组件闭包。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FoldableBar } from './kit-foldable.tsx'

interface MatchMediaSpy {
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function stubMatchMedia(): MatchMediaSpy {
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()
  const mq = {
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList
  ;(window as unknown as { matchMedia: (query: string) => MediaQueryList }).matchMedia = () => mq
  return { addEventListener, removeEventListener }
}

let root: Root | null = null
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) {
    act(() => { root?.unmount() })
    root = null
  }
  host.remove()
})

describe('FoldableBar 生命周期', () => {
  it('卸载时用同一个 handler 摘掉 reduced-motion change 监听', () => {
    const mq = stubMatchMedia()
    root = createRoot(host)
    const mounted = root

    act(() => {
      mounted.render(createElement(FoldableBar, null, createElement('div', null, '内容')))
    })

    expect(mq.addEventListener).toHaveBeenCalledTimes(1)
    expect(mq.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    const handler = mq.addEventListener.mock.calls[0]?.[1]

    act(() => { mounted.unmount() })
    root = null

    expect(mq.removeEventListener).toHaveBeenCalledTimes(1)
    expect(mq.removeEventListener).toHaveBeenCalledWith('change', handler)
  })
})
