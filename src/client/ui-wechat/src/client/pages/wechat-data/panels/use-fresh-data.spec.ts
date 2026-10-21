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

let lastState: {
  override: (n: unknown) => void
  reload: () => Promise<void>
  reloadSilent: () => Promise<void>
} | null = null

function Probe({ k, fetcher, opts, n }: { k: string; fetcher: () => Promise<unknown>; opts?: { shouldCache?: (d: never) => boolean; liveRefresh?: boolean }; n?: number }): React.JSX.Element {
  const st = useFreshData(k, fetcher, opts as never)
  lastState = st as never
  return createElement('div', {
    'data-probe': '',
    'data-loading': String(st.loading),
    'data-stale': String(st.stale),
    'data-err': st.error ?? '',
    'data-refreshing': String(st.refreshing),
    'data-v': st.data === null ? '' : JSON.stringify(st.data),
    'data-n': String(n ?? 0),
  })
}

function render(k: string, fetcher: () => Promise<unknown>, opts?: { shouldCache?: (d: never) => boolean; liveRefresh?: boolean }): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root?.render(createElement(Probe, { k, fetcher, opts })) })
}

/** 再渲染一次（换 `n`：强制走渲染，模拟父组件无关状态变化）。 */
function rerender(k: string, fetcher: () => Promise<unknown>, opts?: { shouldCache?: (d: never) => boolean; liveRefresh?: boolean }, n = 1): void {
  act(() => { root?.render(createElement(Probe, { k, fetcher, opts, n })) })
}

/** 派发一条 WAL 推送并串行越过 useWechatDataUpdated 的 300ms 合并窗。 */
async function firePush(): Promise<void> {
  vi.useFakeTimers()
  act(() => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
  await act(async () => { vi.advanceTimersByTime(320) })
  vi.useRealTimers()
  await flush()
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

describe('useFreshData：opts 稳定性与 WAL 实时刷新（2026-10-13）', () => {
  it('内联 opts 对象不引发重查循环（旧实现 8 次 flush 后 fetcher 被调 3,166,897 次）', async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 'fresh' })
    mocks.readRenderCache.mockReturnValue(null)
    // 照抄 Tasks 的形态：内联 opts（每次渲染都是新对象/新箭头函数）——
    // 旧实现只在「传了内联 opts」时才循环（不传 opts 时依赖恒 undefined，稳定）。
    render('L1', fetcher, { shouldCache: (d: never) => Boolean(d) })
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    rerender('L1', fetcher, { shouldCache: (d: never) => Boolean(d) }, 1)
    await flush()
    rerender('L1', fetcher, { shouldCache: (d: never) => Boolean(d) }, 2)
    await flush()
    expect(fetcher, '无关重渲染不许引发重查').toHaveBeenCalledTimes(1)
  })

  it('liveRefresh 缺省为关：WAL 推送不触发重查（已自行订阅的面板不会双查）', async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 'fresh' })
    mocks.readRenderCache.mockReturnValue(null)
    render('L2', fetcher)
    await flush()
    await firePush()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('liveRefresh 开：WAL 推送 ⇒ 静默重查——不翻 loading、新值上屏', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 'first' })
      .mockResolvedValueOnce({ v: 'second' })
    mocks.readRenderCache.mockReturnValue(null)
    render('L3', fetcher, { liveRefresh: true })
    await flush()
    expect(attr('data-v')).toBe('{"v":"first"}')
    await firePush()
    expect(fetcher, '推送后必须重查').toHaveBeenCalledTimes(2)
    expect(attr('data-v'), '新值必须上屏').toBe('{"v":"second"}')
    expect(attr('data-loading'), '静默重查不许翻 loading（按钮/骨架会闪）').toBe('false')
  })

  it('liveRefresh 开但静默重查失败 ⇒ 保留旧值、不端出错误（与缓存后台复验同一降级口径）', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 'first' })
      .mockRejectedValueOnce(new Error('抖动'))
    mocks.readRenderCache.mockReturnValue(null)
    render('L4', fetcher, { liveRefresh: true })
    await flush()
    await firePush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(attr('data-v'), '一次失败就把旧值丢了').toBe('{"v":"first"}')
    expect(attr('data-err'), '静默失败不许端出错误').toBe('')
    expect(attr('data-stale')).toBe('false')
  })

  it('liveRefresh 开但还没有数据（首查失败/在途）⇒ 推送走非静默路径（照常回退缓存/报错）', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('首查失败'))
      .mockRejectedValueOnce(new Error('又失败'))
    mocks.readRenderCache.mockReturnValue({ v: 'cached' })
    render('L5', fetcher, { liveRefresh: true })
    await flush()
    expect(attr('data-v'), '首查失败应回退缓存').toBe('{"v":"cached"}')
    await firePush()
    expect(attr('data-err'), '无数据时的失败仍要报').toContain('本地缓存')
  })

  it('reloadSilent：已有数据时保留内容、不翻 loading，刷新态单独可见', async () => {
    let resolveSecond: ((value: { v: string }) => void) | null = null
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 'first' })
      .mockImplementationOnce(() => new Promise<{ v: string }>((resolve) => { resolveSecond = resolve }))
    mocks.readRenderCache.mockReturnValue(null)
    render('L6', fetcher)
    await flush()
    expect(attr('data-v')).toBe('{"v":"first"}')

    let done: Promise<void> | null = null
    act(() => { done = lastState?.reloadSilent() ?? Promise.resolve() })
    await flush()
    expect(attr('data-v'), '静默刷新期间必须保留当前内容').toBe('{"v":"first"}')
    expect(attr('data-loading'), '静默刷新不许翻 loading').toBe('false')
    expect(attr('data-refreshing'), '刷新态应单独可见').toBe('true')

    const finishSecond = resolveSecond as ((value: { v: string }) => void) | null
    finishSecond?.({ v: 'second' })
    await act(async () => { await done })
    await flush()
    expect(attr('data-v')).toBe('{"v":"second"}')
    expect(attr('data-refreshing')).toBe('false')
  })

  it('reloadSilent：失败保留旧值、不端出错误、不显示缓存告警', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 'first' })
      .mockRejectedValueOnce(new Error('抖动'))
    mocks.readRenderCache.mockReturnValue(null)
    render('L7', fetcher)
    await flush()
    await act(async () => { await lastState?.reloadSilent() })
    expect(attr('data-v'), '静默刷新失败不能丢旧值').toBe('{"v":"first"}')
    expect(attr('data-err')).toBe('')
    expect(attr('data-stale')).toBe('false')
    expect(attr('data-refreshing')).toBe('false')
  })

  it('并发请求只允许最新一轮提交：慢旧响应不得覆盖后发的新结果', async () => {
    let resolveOld: ((value: { v: string }) => void) | null = null
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 'first' })
      .mockImplementationOnce(() => new Promise<{ v: string }>((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({ v: 'new' })
    mocks.readRenderCache.mockReturnValue(null)
    render('L8', fetcher)
    await flush()
    expect(attr('data-v')).toBe('{"v":"first"}')

    let oldDone: Promise<void> | null = null
    act(() => { oldDone = lastState?.reloadSilent() ?? Promise.resolve() })
    await flush()
    await act(async () => { await lastState?.reloadSilent() })
    expect(attr('data-v')).toBe('{"v":"new"}')

    const finishOld = resolveOld as ((value: { v: string }) => void) | null
    await act(async () => {
      finishOld?.({ v: 'old' })
      await oldDone
    })
    await flush()
    expect(attr('data-v'), '慢的旧请求后回来时覆盖了新快照').toBe('{"v":"new"}')
  })
})
