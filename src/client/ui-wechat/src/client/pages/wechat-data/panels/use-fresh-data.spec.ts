// @vitest-environment jsdom
/**
 * `use-fresh-data` 的行为守卫（2026-10-03 推广第 1 步）。
 *
 * 这三条就是"打开即查最新、失败才回退缓存"的全部语义，任何一条被改动都必须先改这里：
 *   ① 不预填（打开时绝不先画旧缓存）；
 *   ② 成功写回（把最新资源保存好）；
 *   ③ 失败回退 + `stale` 标注（不许把缓存当最新）。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readRenderCache: vi.fn(), writeRenderCache: vi.fn() }))
vi.mock('../api.ts', () => ({ readRenderCache: mocks.readRenderCache, writeRenderCache: mocks.writeRenderCache }))

// eslint-disable-next-line import/first -- mock 必须先于被测模块
import { useFreshData } from './use-fresh-data.ts'

let container: HTMLDivElement | null = null
let root: Root | null = null

const attr = (name: string): string => container?.querySelector('[data-probe]')?.getAttribute(name) ?? ''
const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

let lastState: { override: (n: unknown) => void } | null = null

function Probe({ k, fetcher, opts }: { k: string; fetcher: () => Promise<unknown>; opts?: { shouldCache?: (d: never) => boolean } }): React.JSX.Element {
  const st = useFreshData(k, fetcher, opts as never)
  lastState = st as never
  return createElement('div', {
    'data-probe': '',
    'data-loading': String(st.loading),
    'data-stale': String(st.stale),
    'data-err': st.error ?? '',
    'data-v': st.data === null ? '' : JSON.stringify(st.data),
  })
}

function render(k: string, fetcher: () => Promise<unknown>, opts?: { shouldCache?: (d: never) => boolean }): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root?.render(createElement(Probe, { k, fetcher, opts })) })
}

beforeEach(() => {
  mocks.readRenderCache.mockReset()
  mocks.writeRenderCache.mockReset()
})
afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
})

describe('useFreshData：打开即查最新、失败才回退缓存', () => {
  it('① 不预填：打开时即便有缓存也不先画出来（只进 loading）', async () => {
    mocks.readRenderCache.mockReturnValue({ v: 'cached' })
    render('k1', () => new Promise(() => { /* 永不 resolve */ }))
    expect(attr('data-v'), '打开就先画了缓存').toBe('')
    expect(attr('data-loading')).toBe('true')
  })

  it('② 成功：写出最新值并写回缓存，stale=false', async () => {
    mocks.readRenderCache.mockReturnValue({ v: 'cached' })
    render('k2', () => Promise.resolve({ v: 'fresh' }))
    await flush()
    expect(attr('data-v')).toBe('{"v":"fresh"}')
    expect(attr('data-stale')).toBe('false')
    expect(attr('data-loading')).toBe('false')
    expect(mocks.writeRenderCache).toHaveBeenCalledWith('k2', { v: 'fresh' })
  })

  it('③ 失败 + 有缓存：回退缓存、stale=true、错误里写明"本地缓存"', async () => {
    mocks.readRenderCache.mockReturnValue({ v: 'cached' })
    render('k3', () => Promise.reject(new Error('后端不可用')))
    await flush()
    expect(attr('data-v')).toBe('{"v":"cached"}')
    expect(attr('data-stale'), '回退缓存必须标注').toBe('true')
    expect(attr('data-err')).toContain('本地缓存')
    expect(attr('data-err')).toContain('后端不可用')
  })

  it('③ 失败 + 无缓存：只留错误，不假装有数据', async () => {
    mocks.readRenderCache.mockReturnValue(null)
    render('k4', () => Promise.reject(new Error('后端不可用')))
    await flush()
    expect(attr('data-v')).toBe('')
    expect(attr('data-stale')).toBe('false')
    expect(attr('data-err')).toContain('后端不可用')
  })

  it('override：本地动作改写的数据能进 state，且 stale 复位', async () => {
    mocks.readRenderCache.mockReturnValue(null)
    render('k7', () => Promise.resolve({ v: 'server' }))
    await flush()
    expect(attr('data-v')).toBe('{"v":"server"}')
    act(() => { lastState?.override({ v: 'local' }) })
    expect(attr('data-v'), '覆写后应显示本地值').toBe('{"v":"local"}')
    expect(attr('data-stale')).toBe('false')
  })

  it('键变化即清空 data：不得残留上一个键的值（WordCloudCard 的 scope 切换）', async () => {
    mocks.readRenderCache.mockReturnValue(null)
    render('k6a', () => Promise.resolve({ v: 'A' }))
    await flush()
    expect(attr('data-v')).toBe('{"v":"A"}')
    // 换键：新取数永不 resolve —— 若 data 没被清空，就会看到上一个键的 {v:'A'}
    act(() => { root?.render(createElement(Probe, { k: 'k6b', fetcher: () => new Promise(() => { /* 永不 resolve */ }) })) })
    expect(attr('data-v'), '换键后仍残留上一个键的数据').toBe('')
    expect(attr('data-loading')).toBe('true')
  })

  it('② 不该缓存的结果不写缓存（Tasks：读失败的空列表写进去会伪装成"暂无待办"）', async () => {
    render('k5', () => Promise.resolve({ items: [], readError: '库被占用' }), { shouldCache: (d) => !(d as { readError?: string }).readError })
    await flush()
    expect(attr('data-v')).toBe('{"items":[],"readError":"库被占用"}')
    expect(mocks.writeRenderCache, '读失败的结果不许进缓存').not.toHaveBeenCalled()
  })
})
