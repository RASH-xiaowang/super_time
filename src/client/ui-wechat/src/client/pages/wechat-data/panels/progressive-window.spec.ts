// @vitest-environment jsdom
/**
 * useProgressiveList 的有界窗口行为。
 *
 * IntersectionObserver 用可手动触发的假实现；每个条目按原始索引伪造 20px 的
 * `getBoundingClientRect().top`，因此可同时验证「头窗回收」和「等高占位」。
 */
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProgressiveListSpacer, useProgressiveList } from './hooks.tsx'
import { KeepAliveActiveProvider } from './keep-alive.tsx'

class FakeIO {
  static instances: FakeIO[] = []
  private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void
  private target: Element | null = null
  private connected = false

  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.callback = callback
    FakeIO.instances.push(this)
  }

  observe(target: Element): void { this.target = target; this.connected = true }
  disconnect(): void { this.connected = false }
  unobserve(): void {}
  takeRecords(): [] { return [] }
  emit(isIntersecting: boolean): void { this.callback([{ isIntersecting }]) }
  observes(target: Element): boolean { return this.connected && this.target === target }
}

function Probe({ len, step, maxCount, resetKey, sentinelVisible = true }: {
  len: number
  step: number
  maxCount: number
  resetKey?: string
  sentinelVisible?: boolean
}): ReactElement {
  const window = useProgressiveList(len, step, {
    maxCount,
    ...(resetKey === undefined ? {} : { resetKey }),
  })
  return createElement(
    'div',
    {
      ref: window.listRef,
      'data-window': `${window.start}-${window.end}`,
    },
    createElement(ProgressiveListSpacer, {
      key: 'spacer',
      height: window.beforeHeight,
      topSentinelRef: window.topSentinelRef,
    }),
    ...Array.from({ length: window.end - window.start }, (_, offset) => {
      const index = window.start + offset
      return createElement('div', { key: index, 'data-progressive-item': index }, String(index))
    }),
    sentinelVisible
      ? createElement('div', { key: 'sentinel', ref: window.sentinelRef, 'data-sentinel': '1' })
      : null,
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  FakeIO.instances = []
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
})

function render(props: {
  len: number
  step: number
  maxCount: number
  resetKey?: string
  sentinelVisible?: boolean
}, active = true): void {
  act(() => {
    root.render(createElement(
      KeepAliveActiveProvider,
      { active },
      createElement(Probe, props),
    ))
  })
}

function emitSentinel(kind: 'top' | 'bottom'): void {
  const selector = kind === 'top' ? '[data-progressive-top-sentinel]' : '[data-sentinel="1"]'
  const sentinel = host.querySelector<HTMLElement>(selector)
  expect(sentinel, `找不到 ${kind} 哨兵`).not.toBeNull()
  const observer = FakeIO.instances.find(item => sentinel !== null && item.observes(sentinel))
  expect(observer, `${kind} 哨兵没有挂上 IntersectionObserver`).toBeDefined()
  act(() => { observer?.emit(true) })
}

function grow(): void {
  emitSentinel('bottom')
}

function mockItemTops(): void {
  for (const item of host.querySelectorAll<HTMLElement>('[data-progressive-item]')) {
    const index = Number(item.dataset.progressiveItem)
    item.getBoundingClientRect = () => ({
      x: 0,
      y: index * 20,
      top: index * 20,
      left: 0,
      right: 100,
      bottom: index * 20 + 20,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    })
  }
}

function windowRange(): string {
  return host.firstElementChild?.getAttribute('data-window') ?? ''
}

function mountedIndexes(): number[] {
  return [...host.querySelectorAll<HTMLElement>('[data-progressive-item]')]
    .map(item => Number(item.dataset.progressiveItem))
}

describe('useProgressiveList 有界窗口', () => {
  it('超过 maxCount 后从头部回收，DOM 数量保持硬上界', () => {
    render({ len: 1000, step: 100, maxCount: 250 })
    expect(windowRange()).toBe('0-100')
    expect(mountedIndexes()).toHaveLength(100)

    grow()
    expect(windowRange()).toBe('0-200')
    mockItemTops()
    grow()

    expect(windowRange()).toBe('50-300')
    expect(mountedIndexes()).toHaveLength(250)
    expect(mountedIndexes()[0]).toBe(50)
    expect(mountedIndexes().at(-1)).toBe(299)
    expect(host.querySelector('[data-progressive-spacer]')?.getAttribute('data-progressive-spacer')).toBe('1000')

    mockItemTops()
    grow()
    expect(windowRange()).toBe('150-400')
    expect(mountedIndexes()).toHaveLength(250)
    expect(host.querySelector('[data-progressive-spacer]')?.getAttribute('data-progressive-spacer')).toBe('3000')
  })

  it('向上滚回顶部哨兵时按回收区间恢复历史条目，不留下不可见空洞', () => {
    render({ len: 1000, step: 100, maxCount: 250 })
    grow()
    mockItemTops()
    grow()
    mockItemTops()
    grow()
    expect(windowRange()).toBe('150-400')

    emitSentinel('top')
    expect(windowRange()).toBe('50-300')
    expect(host.querySelector('[data-progressive-spacer]')?.getAttribute('data-progressive-spacer')).toBe('1000')

    emitSentinel('top')
    expect(windowRange()).toBe('0-250')
    expect(host.querySelector('[data-progressive-spacer]')).toBeNull()
  })

  it('数据缩短只裁尾部，保留已回收区间与滚动占位', () => {
    render({ len: 1000, step: 100, maxCount: 250 })
    grow()
    mockItemTops()
    grow()
    expect(windowRange()).toBe('50-300')
    expect(host.querySelector('[data-progressive-spacer]')?.getAttribute('data-progressive-spacer')).toBe('1000')

    render({ len: 180, step: 100, maxCount: 250 })
    expect(windowRange()).toBe('50-180')
    expect(host.querySelector('[data-progressive-spacer]')?.getAttribute('data-progressive-spacer')).toBe('1000')
  })

  it('数据晚到时仍从首段开始，不会停在空窗口', () => {
    render({ len: 0, step: 120, maxCount: 360 })
    expect(windowRange()).toBe('0-0')
    render({ len: 500, step: 120, maxCount: 360 })
    expect(windowRange()).toBe('0-120')
    expect(mountedIndexes()[0]).toBe(0)
  })

  it('同一窗口范围下哨兵重新挂载时，会重新接上 IntersectionObserver', () => {
    render({ len: 1000, step: 100, maxCount: 250, sentinelVisible: false })
    expect(windowRange()).toBe('0-100')
    expect(FakeIO.instances).toHaveLength(0)

    render({ len: 1000, step: 100, maxCount: 250 })
    grow()
    expect(windowRange()).toBe('0-200')
  })

  it('resetKey 变化回到第一段并清空头部占位', () => {
    render({ len: 1000, step: 100, maxCount: 250, resetKey: 'query-a' })
    grow()
    mockItemTops()
    grow()
    expect(windowRange()).toBe('50-300')

    render({ len: 1000, step: 100, maxCount: 250, resetKey: 'query-b' })
    expect(windowRange()).toBe('0-100')
    expect(host.querySelector('[data-progressive-spacer]')).toBeNull()
  })

  it('追加数据后仍从头部回收，DOM 窗口不随总数据量增长', () => {
    render({ len: 1000, step: 100, maxCount: 250 })
    grow()
    mockItemTops()
    grow()
    expect(windowRange()).toBe('50-300')

    render({ len: 1200, step: 100, maxCount: 250 })
    expect(windowRange()).toBe('50-300')
    mockItemTops()
    grow()

    expect(windowRange()).toBe('150-400')
    expect(mountedIndexes()).toHaveLength(250)
    expect(host.querySelector('[data-progressive-spacer]')?.getAttribute('data-progressive-spacer')).toBe('3000')
  })

  it('隐藏期间不增长也不提前应用筛选重置，恢复后只重置一次', () => {
    render({ len: 1000, step: 100, maxCount: 250 })
    grow()
    expect(windowRange()).toBe('0-200')

    const oldSentinel = host.querySelector('[data-sentinel="1"]')
    const oldObserver = FakeIO.instances.find(item => oldSentinel !== null && item.observes(oldSentinel))
    expect(oldObserver).toBeDefined()

    render({ len: 1000, step: 100, maxCount: 250, resetKey: 'hidden-filter' }, false)
    expect(windowRange(), '隐藏态提前把筛选重置写进了窗口').toBe('0-200')
    act(() => { oldObserver?.emit(true) })
    expect(windowRange(), '隐藏态仍在响应旧滚动哨兵').toBe('0-200')

    render({ len: 1000, step: 100, maxCount: 250, resetKey: 'hidden-filter' }, true)
    expect(windowRange()).toBe('0-100')
  })

  it('maxCount 缩小时立即裁到新上界（含数据窗口与 DOM 占位）', () => {
    render({ len: 1000, step: 100, maxCount: 250 })
    grow()
    mockItemTops()
    grow()
    expect(windowRange()).toBe('50-300')

    render({ len: 1000, step: 100, maxCount: 100 })
    expect(windowRange()).toBe('200-300')
    expect(mountedIndexes()).toHaveLength(100)
    expect(host.querySelector('[data-progressive-spacer]'), '旧占位已不对应新窗口').toBeNull()
  })

  it('没有 IntersectionObserver 时也只挂载 maxCount，不退化成全量 DOM', () => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver
    render({ len: 10_000, step: 100, maxCount: 250 })

    expect(windowRange()).toBe('0-250')
    expect(mountedIndexes()).toHaveLength(250)
  })
})
