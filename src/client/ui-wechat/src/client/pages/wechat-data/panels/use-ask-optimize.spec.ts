// @vitest-environment jsdom
/**
 * 提问优化的范围隔离：旧范围迟到的优化结果既不能显示，也不能被一键采用。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskOptimizeState, AskOptimizeScope } from './use-ask-optimize.ts'

const mocks = vi.hoisted(() => ({ apiOptimizeAskQuestion: vi.fn() }))

vi.mock('../api.ts', () => ({ apiOptimizeAskQuestion: mocks.apiOptimizeAskQuestion }))

const { useAskOptimize } = await import('./use-ask-optimize.ts')

let host: HTMLDivElement
let root: Root
let hook: AskOptimizeState | null = null
let scope: AskOptimizeScope = { scopeKey: 'a' }

function Harness(): React.JSX.Element {
  hook = useAskOptimize(scope)
  return createElement('div')
}

function setScope(next: AskOptimizeScope): void {
  scope = next
  act(() => { root.render(createElement(Harness)) })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiOptimizeAskQuestion.mockReset()
  scope = { scopeKey: 'a' }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  hook = null
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useAskOptimize：范围隔离', () => {
  it('切换范围后旧请求迟到的结果不写回新范围', async () => {
    let resolveOld: ((value: unknown) => void) | null = null
    mocks.apiOptimizeAskQuestion.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))

    let pending: Promise<void> | undefined
    act(() => { pending = hook?.optimize('旧问题', []) })
    expect(hook?.loading).toBe(true)

    setScope({ scopeKey: 'b', username: 'wxid_b' })
    expect(hook?.result).toBeNull()
    expect(hook?.error).toBeNull()
    expect(hook?.loading).toBe(false)

    await act(async () => {
      resolveOld?.({ optimized: '旧范围的优化结果', suggestions: ['旧建议'] })
      await pending
    })
    expect(hook?.result).toBeNull()
    expect(hook?.error).toBeNull()
  })

  it('范围切换后旧结果立刻消失，清空会让在途请求失效', async () => {
    mocks.apiOptimizeAskQuestion.mockResolvedValueOnce({ optimized: 'A 的优化结果', suggestions: [] })
    await act(async () => { await hook?.optimize('A 问题', []) })
    expect(hook?.result?.optimized).toBe('A 的优化结果')
    setScope({ scopeKey: 'b' })
    expect(hook?.result).toBeNull()

    let resolvePending: ((value: unknown) => void) | null = null
    mocks.apiOptimizeAskQuestion.mockImplementationOnce(() => new Promise(resolve => { resolvePending = resolve }))
    let pending: Promise<void> | undefined
    act(() => { pending = hook?.optimize('B 问题', []) })
    act(() => { hook?.dismiss() })
    expect(hook?.loading).toBe(false)
    await act(async () => {
      resolvePending?.({ optimized: '不应出现的优化结果', suggestions: [] })
      await pending
    })
    expect(hook?.result).toBeNull()
  })

  it('请求带上当前会话与历史，空问题不发请求', async () => {
    mocks.apiOptimizeAskQuestion.mockResolvedValueOnce({ optimized: '优化后', suggestions: ['补时间'] })
    setScope({ scopeKey: 's1', username: 'wxid_a', from: '2026-10-01', to: '2026-10-07' })
    await act(async () => {
      await hook?.optimize('  报价  ', [
        { role: 'user', text: '第一问' },
        { role: 'assistant', text: '第一答' },
      ])
    })
    expect(mocks.apiOptimizeAskQuestion).toHaveBeenCalledWith({
      question: '报价',
      username: 'wxid_a',
      from: '2026-10-01',
      to: '2026-10-07',
      history: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答' },
      ],
    })
    expect(hook?.result?.optimized).toBe('优化后')

    mocks.apiOptimizeAskQuestion.mockClear()
    await act(async () => { await hook?.optimize('   ', []) })
    expect(mocks.apiOptimizeAskQuestion).not.toHaveBeenCalled()
  })
})
