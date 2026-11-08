// @vitest-environment jsdom
/**
 * keep-alive 隐藏期间的宿主数据推送。
 *
 * 已访问分段切走后仍保持挂载；如果仍执行 `useWechatDataUpdated` 回调，就会在
 * 后台重复取数。这里验证两点：隐藏时只记“脏”，不调用；恢复时合并成一次补刷。
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWechatDataUpdated } from './hooks.tsx'
import { KeepAliveActiveProvider } from './keep-alive.tsx'

const EVENT = 'test-keep-alive-live-update'

function Probe({ onUpdate }: { onUpdate: () => void }): ReactElement {
  useWechatDataUpdated(onUpdate, EVENT, 50)
  return createElement('div', { 'data-probe': '' })
}

let host: HTMLDivElement
let root: Root
let updates = 0

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  updates = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

function render(active: boolean): void {
  act(() => {
    root.render(createElement(
      KeepAliveActiveProvider,
      { active },
      createElement(Probe, { onUpdate: () => { updates += 1 } }),
    ))
  })
}

function push(): void {
  act(() => { window.dispatchEvent(new Event(EVENT)) })
  act(() => { vi.advanceTimersByTime(80) })
}

describe('useWechatDataUpdated × keep-alive', () => {
  it('隐藏时推送不执行回调，恢复后只合并补跑一次', () => {
    render(true)
    push()
    expect(updates).toBe(1)

    render(false)
    push()
    push()
    expect(updates, '隐藏分段在后台重复取数').toBe(1)

    render(true)
    act(() => { vi.advanceTimersByTime(80) })
    expect(updates, '恢复后没有补上隐藏期间的变更').toBe(2)
  })

  it('合并窗内被隐藏也不在后台落地，恢复后再补跑', () => {
    render(true)
    act(() => { window.dispatchEvent(new Event(EVENT)) })
    render(false)
    act(() => { vi.advanceTimersByTime(80) })
    expect(updates, '隐藏后才到期的合并窗仍在后台执行回调').toBe(0)

    render(true)
    act(() => { vi.advanceTimersByTime(80) })
    expect(updates).toBe(1)
  })
})
