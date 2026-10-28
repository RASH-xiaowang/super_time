// @vitest-environment jsdom
/**
 * 客户 360 共享加载器的行为守卫：实时刷新、失败降级和切人时丢弃旧响应。
 * 页面与聊天侧画像抽屉都消费这个 hook，因此这里失败会同时影响两个入口。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact360Snapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { useCustomer360 } from './use-customer-360.ts'

const mocks = vi.hoisted(() => ({ apiGetContact360: vi.fn() }))
vi.mock('../api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api.ts')>()
  return { ...mod, apiGetContact360: mocks.apiGetContact360 }
})

const snap = (username: string, count: number): Contact360Snapshot => ({
  username,
  displayName: username,
  messages: { count, firstTime: 1000, lastTime: 2000 },
  moments: { count: 0 },
  funds: { transfers: 0, redpackets: 0 },
  commonGroups: [],
  updatedAt: 0,
})

function Probe({ username }: { username: string | null }): React.JSX.Element {
  const { snapshot, loading, error, reload } = useCustomer360(username)
  return createElement(
    'div',
    {
      'data-loading': String(loading),
      'data-error': error ?? '',
      'data-count': String(snapshot?.messages.count ?? ''),
    },
    createElement('button', { type: 'button', onClick: reload }, '重新加载'),
  )
}

let host: HTMLDivElement
let root: Root
const render = (username: string | null): void => {
  act(() => { root.render(createElement(Probe, { username })) })
}
const flush = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve() })
}
const fireUpdated = async (): Promise<void> => {
  vi.useFakeTimers()
  act(() => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
  await act(async () => { vi.advanceTimersByTime(320) })
  vi.useRealTimers()
  await flush()
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiGetContact360.mockReset()
  mocks.apiGetContact360.mockResolvedValue(snap('wxid_a', 5))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.useRealTimers()
})

describe('useCustomer360', () => {
  it('宿主同步新数据后重取当前客户', async () => {
    render('wxid_a')
    await flush()
    expect(host.firstElementChild?.getAttribute('data-count')).toBe('5')

    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_a', 8))
    await fireUpdated()
    expect(mocks.apiGetContact360).toHaveBeenCalledTimes(2)
    expect(mocks.apiGetContact360).toHaveBeenLastCalledWith('wxid_a')
    expect(host.firstElementChild?.getAttribute('data-count')).toBe('8')
  })

  it('后台刷新失败时保留旧快照，不把画像变成错误页', async () => {
    render('wxid_a')
    await flush()
    mocks.apiGetContact360.mockRejectedValueOnce(new Error('同步抖动'))
    await fireUpdated()
    expect(host.firstElementChild?.getAttribute('data-count')).toBe('5')
    expect(host.firstElementChild?.getAttribute('data-error')).toBe('')
  })

  it('切到另一个客户后，旧客户的迟到响应不会覆盖新画像', async () => {
    let resolveA: ((value: Contact360Snapshot) => void) | null = null
    mocks.apiGetContact360.mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve }))
    render('wxid_a')
    await flush(1)

    mocks.apiGetContact360.mockResolvedValueOnce(snap('wxid_b', 42))
    render('wxid_b')
    await flush()
    expect(host.firstElementChild?.getAttribute('data-count')).toBe('42')

    await act(async () => {
      resolveA?.(snap('wxid_a', 99))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.firstElementChild?.getAttribute('data-count')).toBe('42')
  })
})
