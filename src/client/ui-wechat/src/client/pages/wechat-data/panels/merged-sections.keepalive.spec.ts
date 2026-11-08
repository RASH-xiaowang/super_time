// @vitest-environment jsdom
/**
 * MergedSections 分段保活行为。
 *
 * 这里直接驱动 React DOM，而不是只读源码：切换分段后旧面板必须仍在 DOM 中
 * （只是隐藏），并且它的局部 state 与 keep-alive 上下文不能被重置。
 */
import { act, createElement, useEffect, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MergedSections } from './MergedSections.tsx'
import { KeepAliveActiveProvider, useKeepAliveActive } from './keep-alive.tsx'

function Probe({ label }: { label: string }): ReactElement {
  const active = useKeepAliveActive()
  const [clicks, setClicks] = useState(0)
  useEffect(() => {
    document.body.dataset.mounts = String(Number(document.body.dataset.mounts ?? '0') + 1)
    return () => {
      document.body.dataset.unmounts = String(Number(document.body.dataset.unmounts ?? '0') + 1)
    }
  }, [])
  return createElement(
    'button',
    {
      type: 'button',
      'data-probe': label,
      'data-active': active || undefined,
      onClick: () => { setClicks(value => value + 1) },
    },
    `${label}:${clicks}`,
  )
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  document.body.dataset.mounts = '0'
  document.body.dataset.unmounts = '0'
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  delete document.body.dataset.mounts
  delete document.body.dataset.unmounts
})

function panel(): ReactElement {
  return createElement(MergedSections, {
    ariaLabel: '测试分段',
    initial: 'a',
    sections: [
      { key: 'a', label: '甲', render: () => createElement(Probe, { label: 'a' }) },
      { key: 'b', label: '乙', render: () => createElement(Probe, { label: 'b' }) },
    ],
  })
}

function section(key: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-merged-section="${key}"]`)
}

function clickButton(text: string): void {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => (item.textContent ?? '').trim() === text)
  expect(button, `找不到按钮：${text}`).toBeDefined()
  act(() => { button?.click() })
}

describe('MergedSections 分段保活', () => {
  it('未访问分段不提前挂载，访问后隐藏而不卸载', () => {
    act(() => { root.render(panel()) })
    expect(section('a')?.hasAttribute('data-active')).toBe(true)
    expect(section('b')).toBeNull()

    clickButton('乙')
    expect(section('a')).not.toBeNull()
    expect(section('a')?.hasAttribute('data-active')).toBe(false)
    expect(section('b')?.hasAttribute('data-active')).toBe(true)
    expect(host.querySelector<HTMLElement>('[data-probe="a"]')?.hasAttribute('data-active')).toBe(false)
    expect(host.querySelector<HTMLElement>('[data-probe="b"]')?.hasAttribute('data-active')).toBe(true)
  })

  it('来回切换保留分段内部 state，不会重新挂载', () => {
    act(() => { root.render(panel()) })
    const a = host.querySelector<HTMLButtonElement>('[data-probe="a"]')
    act(() => { a?.click() })
    expect(a?.textContent).toBe('a:1')

    clickButton('乙')
    clickButton('甲')

    expect(host.querySelector('[data-probe="a"]')?.textContent).toBe('a:1')
    expect(document.body.dataset.mounts).toBe('2')
    expect(document.body.dataset.unmounts ?? '0').toBe('0')
  })

  it('initial 深链变化会切段，并把目标加入已访问集合', () => {
    act(() => { root.render(panel()) })
    expect(section('b')).toBeNull()

    act(() => {
      root.render(createElement(MergedSections, {
        ariaLabel: '测试分段',
        initial: 'b',
        sections: [
          { key: 'a', label: '甲', render: () => createElement(Probe, { label: 'a' }) },
          { key: 'b', label: '乙', render: () => createElement(Probe, { label: 'b' }) },
        ],
      }))
    })

    expect(section('b')?.hasAttribute('data-active')).toBe(true)
    expect(section('a')).not.toBeNull()
  })

  it('切换到另一组合并视图时不沿用上一组 visited', () => {
    act(() => { root.render(panel()) })
    clickButton('乙')
    expect(section('b')).not.toBeNull()

    act(() => {
      root.render(createElement(MergedSections, {
        ariaLabel: '另一组',
        initial: 'c',
        sections: [
          { key: 'c', label: '丙', render: () => createElement(Probe, { label: 'c' }) },
          { key: 'd', label: '丁', render: () => createElement(Probe, { label: 'd' }) },
        ],
      }))
    })

    expect(section('a')).toBeNull()
    expect(section('b')).toBeNull()
    expect(section('c')?.hasAttribute('data-active')).toBe(true)
    expect(section('d')).toBeNull()
  })

  it('父级 keep-alive 隐藏时，当前分段也收到 active=false', () => {
    act(() => {
      root.render(createElement(
        KeepAliveActiveProvider,
        { active: false },
        panel(),
      ))
    })
    expect(host.querySelector<HTMLElement>('[data-probe="a"]')?.hasAttribute('data-active')).toBe(false)
  })

  it('重型分段显式关闭 keepAlive 后，切走会卸载并释放 DOM 与观察器', () => {
    act(() => {
      root.render(createElement(MergedSections, {
        ariaLabel: '测试分段',
        initial: 'a',
        sections: [
          { key: 'a', label: '甲', keepAlive: false, render: () => createElement(Probe, { label: 'a' }) },
          { key: 'b', label: '乙', keepAlive: false, render: () => createElement(Probe, { label: 'b' }) },
        ],
      }))
    })

    clickButton('乙')

    expect(section('a')).toBeNull()
    expect(document.body.dataset.mounts).toBe('2')
    expect(document.body.dataset.unmounts).toBe('1')
  })
})
