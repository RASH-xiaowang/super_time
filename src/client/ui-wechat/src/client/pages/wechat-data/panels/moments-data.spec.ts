// @vitest-environment jsdom
/**
 * `moments-data.ts` 的行为守卫（第三批 #18 第五步）。
 *
 * ## 为什么这一族要有测试
 *
 * 它决定「屏幕上到底有没有东西」，而里面几条约定一旦被顺手合并就会静默变坏，
 * 且都**不会报错**：
 *  · **渲染缓存按上下文分键**（`'moments:' + (author || 'all')`）——
 *    共用一个键的话，从某人资料页点进「TA 的朋友圈」会把上一个人的列表当缓存秒开：
 *    首屏画的是别人的动态，后台回来才换成对的。
 *  · **增量刷新只前插新 tid** —— 整表替换会把用户滚动位置甩回顶部，而数据事件约每 10 秒就来一次。
 *  · **全量月度分布只在（重）载入时取一次** —— 每翻一页都取一遍等于把最贵的那次查询乘上页数。
 *  · **月度分布失败要留 `readError`**（P1-1 那条契约）—— 空数组会被读成「这个人一条动态都没有」。
 * @module moments-data-spec
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  apiGetMoments: vi.fn(),
  apiGetMomentsMonthly: vi.fn(),
  apiGetMomentsAuthors: vi.fn(),
  apiGetSelfUsername: vi.fn(),
  readRenderCache: vi.fn(),
  writeRenderCache: vi.fn(),
}))
vi.mock('../api.ts', () => mocks)

const { useMomentsData } = await import('./moments-data.ts')
const HERE = dirname(fileURLToPath(import.meta.url))

type Data = ReturnType<typeof useMomentsData>

function mk(tid: string): MomentItem {
  return {
    tid, username: 'wxid_' + tid, author: '张三', text: tid, ts: 1757000000, time: '',
    media_count: 0, media_desc: '', images: [], videos: [], location: '', link_title: '',
    is_self: false, likes: [], comments: [],
  }
}

let host: HTMLDivElement
let root: Root
let data: Data | null = null
let lastProps: { author?: string | null; authorFilter: string | null } = { authorFilter: null }

function Harness(): React.JSX.Element {
  data = useMomentsData(lastProps)
  return createElement('div', {
    'data-tids': data.moments.map((m) => m.tid).join(','),
    'data-total': String(data.total),
    'data-loading-all': String(data.loadingAll),
    'data-error': data.error ?? '',
    'data-monthly-err': data.monthlySnap.readError ?? '',
    'data-author-monthly-err': data.monthlySnapForAuthor.readError ?? '',
    'data-count': String(data.countRef.current),
  })
}

const attr = (name: string): string => host.firstElementChild?.getAttribute(name) ?? ''
const render = (): void => { act(() => { root.render(createElement(Harness)) }) }
const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.apiGetMoments.mockResolvedValue({ moments: [mk('a'), mk('b')], total: 2 })
  mocks.apiGetMomentsMonthly.mockResolvedValue({ months: [{ month: '2026-09', count: 2 }] })
  mocks.apiGetMomentsAuthors.mockResolvedValue([])
  mocks.apiGetSelfUsername.mockResolvedValue('wxid_me')
  mocks.readRenderCache.mockReturnValue(null)
  mocks.writeRenderCache.mockReturnValue(undefined)
  data = null
  lastProps = { authorFilter: null }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.useRealTimers()
})

describe('载入', () => {
  it('挂载即取一页，不带 author 就不筛人', async () => {
    render()
    await flush()
    expect(mocks.apiGetMoments).toHaveBeenCalledWith({ limit: 500 })
    expect(attr('data-tids')).toBe('a,b')
    expect(attr('data-total')).toBe('2')
  })

  it('带 author 时既筛人、也用**属于这个人**的缓存键（共用键会秒开出上一个人的列表）', async () => {
    lastProps = { author: 'wxid_zhang', authorFilter: null }
    render()
    await flush()
    expect(mocks.apiGetMoments).toHaveBeenCalledWith({ limit: 500, author: 'wxid_zhang' })
    expect(mocks.readRenderCache).toHaveBeenCalledWith('moments:wxid_zhang')
    expect(mocks.writeRenderCache.mock.calls[0]?.[0]).toBe('moments:wxid_zhang')
    lastProps = { author: null, authorFilter: null }
    render()
    await flush()
    expect(mocks.readRenderCache).toHaveBeenCalledWith('moments:all')
  })

  it('有渲染缓存就先画缓存（秒开），后台仍去取新的', async () => {
    mocks.readRenderCache.mockReturnValue([mk('cached')])
    render()
    expect(attr('data-tids')).toBe('cached')
    await flush()
    expect(mocks.apiGetMoments).toHaveBeenCalled()
    expect(attr('data-tids')).toBe('a,b')
  })

  it('全量月度分布只在重载入时取一次；翻页不许再取', async () => {
    render()
    await flush()
    expect(mocks.apiGetMomentsMonthly).toHaveBeenCalledTimes(1)
    await act(async () => { await data?.load(false) })
    await flush()
    expect(mocks.apiGetMomentsMonthly, '翻一页就把最贵的那次查询再做一遍').toHaveBeenCalledTimes(1)
  })

  it('月度分布失败要留 `readError`（空数组会被读成「这个人一条都没有」）', async () => {
    mocks.apiGetMomentsMonthly.mockRejectedValue(new Error('后端忙'))
    render()
    await flush()
    expect(attr('data-monthly-err')).toContain('月度分布请求失败')
  })

  it('列表读失败要说出来，而不是画成「没有动态」', async () => {
    mocks.apiGetMoments.mockRejectedValue(new Error('库打不开'))
    render()
    await flush()
    expect(attr('data-error')).toBe('库打不开')
    expect(attr('data-tids')).toBe('')
  })
})

describe('翻页与全量', () => {
  it('load(false) 按游标续取并**追加**，不整表替换', async () => {
    render()
    await flush()
    mocks.apiGetMoments.mockResolvedValue({ moments: [mk('c')], total: 3 })
    await act(async () => { await data?.load(false) })
    await flush()
    expect(mocks.apiGetMoments).toHaveBeenLastCalledWith({ limit: 500, offset: 2 })
    expect(attr('data-tids')).toBe('a,b,c')
    expect(attr('data-count')).toBe('3')
  })

  it('loadAll 串行取到游标追上总数为止，并会自己收尾（loadingAll 归 false）', async () => {
    mocks.apiGetMoments
      .mockResolvedValueOnce({ moments: [mk('a'), mk('b')], total: 6 })
      .mockResolvedValueOnce({ moments: [mk('c'), mk('d')], total: 6 })
      .mockResolvedValueOnce({ moments: [mk('e'), mk('f')], total: 6 })
    render()
    await flush()
    await act(async () => { await data?.loadAll() })
    await flush()
    expect(attr('data-tids')).toBe('a,b,c,d,e,f')
    expect(attr('data-loading-all')).toBe('false')
    expect(mocks.apiGetMoments.mock.calls.map((c) => (c[0] as { offset?: number }).offset)).toEqual([undefined, 2, 4])
  })

  it('后端回一页空 ⇒ 立刻停（总数说还有但拿不到，不能原地打转）', async () => {
    mocks.apiGetMoments
      .mockResolvedValueOnce({ moments: [mk('a')], total: 99 })
      .mockResolvedValue({ moments: [], total: 99 })
    render()
    await flush()
    await act(async () => { await data?.loadAll() })
    await flush()
    expect(mocks.apiGetMoments).toHaveBeenCalledTimes(2)
    expect(attr('data-loading-all')).toBe('false')
  })

  it('loadAll 失败也要落回非加载态（否则按钮永远「加载中」）', async () => {
    // 先让首屏只拿到 2/6，`loadAll` 才有活可干 —— 游标已经追上总数时它是直接返回的（那是正确行为）
    mocks.apiGetMoments.mockResolvedValue({ moments: [mk('a'), mk('b')], total: 6 })
    render()
    await flush()
    mocks.apiGetMoments.mockRejectedValue(new Error('断'))
    await act(async () => { await data?.loadAll() })
    await flush()
    expect(attr('data-loading-all')).toBe('false')
    expect(attr('data-error')).toBe('断')
  })
})

describe('数据落地后的静默增量刷新', () => {
  const fire = async (): Promise<void> => {
    vi.useFakeTimers()
    act(() => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
    // `useWechatDataUpdated` 有 300ms 合并窗（高频同步事件合并成一次刷新）
    await act(async () => { vi.advanceTimersByTime(320) })
    vi.useRealTimers()
    await flush()
  }

  it('已有列表时只取小页、只前插新 tid（整表替换会把滚动位置甩回顶部）', async () => {
    render()
    await flush()
    expect(attr('data-tids')).toBe('a,b')
    mocks.apiGetMoments.mockResolvedValue({ moments: [mk('b'), mk('new')], total: 3 })
    await fire()
    expect(mocks.apiGetMoments).toHaveBeenLastCalledWith({ limit: 200, author: undefined })
    expect(attr('data-tids'), 'b 被重复插进去了').toBe('new,a,b')
    expect(attr('data-total')).toBe('3')
  })

  it('空列表时直接走全量载入', async () => {
    mocks.apiGetMoments.mockResolvedValue({ moments: [], total: 0 })
    render()
    await flush()
    expect(attr('data-tids')).toBe('')
    mocks.apiGetMoments.mockResolvedValue({ moments: [mk('x')], total: 1 })
    await fire()
    expect(mocks.apiGetMoments).toHaveBeenLastCalledWith({ limit: 500 })
    expect(attr('data-tids')).toBe('x')
  })

  it('刷新失败保持当前列表，也不报错吓人', async () => {
    render()
    await flush()
    mocks.apiGetMoments.mockRejectedValueOnce(new Error('抖动'))
    await fire()
    expect(attr('data-tids')).toBe('a,b')
    expect(attr('data-error')).toBe('')
  })
})

describe('作者牌的月度分布', () => {
  it('选中作者 ⇒ 取该作者那份；清掉 ⇒ 回退到空（画的是全量那份）', async () => {
    render()
    await flush()
    lastProps = { authorFilter: '李四' }
    render()
    await flush()
    expect(mocks.apiGetMomentsMonthly).toHaveBeenLastCalledWith({ authorName: '李四' })
    lastProps = { authorFilter: null }
    render()
    await flush()
    expect(attr('data-author-monthly-err')).toBe('')
  })

  it('取失败要留原因：空数组会被读成「这个人一条动态都没有」', async () => {
    mocks.apiGetMomentsMonthly.mockRejectedValue(new Error('后端忙'))
    lastProps = { authorFilter: '李四' }
    render()
    await flush()
    expect(attr('data-author-monthly-err')).toContain('该作者的月度分布请求失败')
  })
})

describe('接线：面板不再自己取数', () => {
  it('取数只在 moments-data.ts 这一层', () => {
    const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')
    expect(panel).toContain('useMomentsData')
    for (const gone of ['apiGetMoments', 'readRenderCache', 'writeRenderCache', 'useWechatDataUpdated', 'const [moments', 'countRef = useRef']) {
      expect(panel, `「${gone}」又回到面板里了`).not.toContain(gone)
      expect(readFileSync(join(HERE, 'moments-data.ts'), 'utf8'), `本层里找不到「${gone}」⇒ 判据的对象是编的`).toContain(gone)
    }
  })
})
