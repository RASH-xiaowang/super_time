// @vitest-environment jsdom
/**
 * 朋友圈媒体层（`moments-media.ts`）的行为守卫（第三批 #18 第二步）。
 *
 * ## 为什么这一族最需要行为层
 *
 * 「滚动到哪一格才去本机解密」这件事由**三方约定**凑成：卡片在 render 里把
 * `{md5, timelineId, …}` 登记进 `mediaKeySpec`、把同一个键挂到 DOM 的 `data-sns-key` 上，
 * 面板的观察器再按 DOM 上的键反查那张表。任何一侧单独看都自洽，**断掉任何一条边都不会报错** ——
 * 表现只是「图片永远停在缩略图」。而那张表在改之前**没有一条用例碰过**。
 *
 * 所以这里的判据都是「数 RPC 次数 / 数谁被调用」，而不是读源码：
 *  · 兜底路径（没有 IntersectionObserver 时）必须把登记过的键**逐个**解一遍，且**不重复**；
 *  · 先问 IndexedDB 原图，命中就不许再调解密 RPC（否则进面板就打爆后端）；
 *  · 一批 8 个之外剩下的也必须排空（`while` 而不是只 splice 一次）；
 *  · 封面兜底最多试 3 次（否则一个永久失败的链接会一直打网络）；
 *  · 灯箱那张缺图的按需解析只发生一次。
 * @module moments-media-spec
 */
import { StrictMode, act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'

const mocks = vi.hoisted(() => ({
  apiGetSnsImageDataUrl: vi.fn(),
  apiGetSnsVideoCoverDataUrl: vi.fn(),
  apiGetArticleCovers: vi.fn(),
  snsMediaCacheGet: vi.fn(),
  snsMediaCacheGetMany: vi.fn(),
  snsMediaCacheSet: vi.fn(),
}))
vi.mock('../api.ts', () => mocks)

const {
  BoundedMediaSet,
  MOMENTS_MEDIA_KEY_CACHE_MAX,
  MOMENTS_MEDIA_QUEUE_MAX,
  buildSnsImageRequestOptions,
  collectMediaKeys,
  createCancellableHeavyRpcLane,
  createSnsOriginalResolver,
  enqueueIntersecting,
  momentGridImages,
  momentImageSpec,
  momentLinkCardView,
  pendingCovers,
  requeueAfterDelay,
  useMomentsMedia,
  videoCoverKey,
} = await import('./moments-media.ts')
type Media = ReturnType<typeof useMomentsMedia>

const HERE = dirname(fileURLToPath(import.meta.url))

function mk(over: Partial<MomentItem> & { tid: string }): MomentItem {
  return {
    username: 'wxid_' + over.tid,
    author: '张三',
    text: '',
    ts: 1757000000,
    time: '',
    media_count: 0,
    media_desc: '',
    images: [],
    videos: [],
    location: '',
    link_title: '',
    is_self: false,
    likes: [],
    comments: [],
    ...over,
  }
}

/**
 * 设定「有网 / 无网」。
 *
 * 为什么用例必须能切这个：取图口径是**本地优先**（先 IndexedDB 原图，没有才 RPC；
 * 后端本地也没有才 CDN），有网/无网只决定「本地都没有时能否出网」。jsdom 默认
 * `onLine === true`，所以「无网」那几条用例不显式设成 false 就会全部走有网分支 —— 断言会变成恒真。
 */
function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const fn of Object.values(mocks)) fn.mockReset()
  setOnline(true)
  mocks.snsMediaCacheGet.mockResolvedValue(null)
  mocks.snsMediaCacheGetMany.mockResolvedValue({})
  mocks.snsMediaCacheSet.mockResolvedValue(undefined)
  mocks.apiGetSnsImageDataUrl.mockImplementation(async ({ md5 }: { md5: string }) => ({ url: md5 ? 'data:' + md5 : '' }))
  mocks.apiGetSnsVideoCoverDataUrl.mockImplementation(async ({ md5 }: { md5: string }) => ({ url: md5 ? 'data:' + md5 : '' }))
  // 批量封面：默认「全部失败」（逐条 error），与改前的 `{ url: '' }` 等价；需要命中的用例再 mockResolvedValueOnce。
  mocks.apiGetArticleCovers.mockImplementation(async ({ urls }: { urls: readonly string[] }) => ({
    items: urls.map((url) => ({ url, error: 'no cover' })),
  }))
})

describe('键规则：DOM 契约只能有一份实现', () => {
  it('视频键三种取值（md5 优先；否则 timelineId+id；都没有就是空串）', () => {
    expect(videoCoverKey({ md5: 'abc' })).toBe('v:abc')
    expect(videoCoverKey({ md5: 'abc', timelineId: 't', id: 'i' })).toBe('v:abc')
    expect(videoCoverKey({ timelineId: 't', id: 'i' })).toBe('v:t:i')
    expect(videoCoverKey({ timelineId: 't' })).toBe('')
    expect(videoCoverKey({})).toBe('')
  })

  it('全仓只许 moments-media.ts 一处拼 v: 前缀（三处各写一遍是这张表断线的头号成因）', () => {
    const owners = readdirSync(HERE)
      .filter((f) => /^moments.*\.(ts|tsx)$/.test(f) && !f.includes('.spec.'))
      .filter((f) => readFileSync(join(HERE, f), 'utf8').includes("'v:' +"))
    expect(owners).toEqual(['moments-media.ts'])
  })

  it('collectMediaKeys 把三类媒体的键都收齐且去重', () => {
    const shared = { md5: 'same', url: 'u', thumb: 't', key: 'k' }
    const list = [
      mk({ tid: '1', images: [shared, { ...shared, md5: 'other' }] }),
      mk({ tid: '2', images: [shared], videos: [{ url: 'v', thumb: 't', key: 'vk', md5: 'vm', duration: 1 }] }),
      mk({ tid: '3', comments: [{ username: 'u', nickname: 'n', to_username: '', to_nickname: '', content: '', ts: 1, image: { md5: 'cm' } }] }),
    ]
    const keys = collectMediaKeys(list)
    expect(new Set(keys).size, keys.join(',')).toBe(keys.length)
    // imgKey() 的口径是 md5 优先，所以同一张图在两条动态里只算一个键
    expect(keys.filter((k) => k === 'same')).toHaveLength(1)
    expect(keys).toEqual(expect.arrayContaining(['same', 'other', 'v:vm', 'cm']))
  })

  it('公众号首图没有 md5 时仍按 timelineId+id 登记完整 CDN 元数据', () => {
    const spec = momentImageSpec({
      md5: '',
      timelineId: '15049300464112701979',
      id: '15049300464754102797',
      url: 'http://szmmsns.qpic.cn/cover/0',
      thumb: 'http://szmmsns.qpic.cn/cover/150',
      token: 'token',
      key: 'seed',
      originalWidth: 150,
      originalHeight: 150,
      originalBytes: 1741,
    })

    expect(spec).toEqual({
      md5: '',
      kind: 'img',
      timelineId: '15049300464112701979',
      mediaId: '15049300464754102797',
      url: 'http://szmmsns.qpic.cn/cover/0',
      token: 'token',
      seed: 'seed',
      originalWidth: 150,
      originalHeight: 150,
      originalBytes: 1741,
    })
    expect(momentImageSpec({
      md5: '',
      timelineId: 'only-tid',
      thumb: '',
      url: '',
      key: '',
    })).toBeNull()
  })
})

describe('原图请求：主图与 UHD 元数据各走各的', () => {
  it('完整透传主图三件套、UHD 三件套、尺寸与字节', () => {
    const opts = buildSnsImageRequestOptions({
      md5: 'main-md5',
      timelineId: 'timeline-1',
      id: 'media-1',
      url: 'main-url',
      token: 'main-token',
      key: 'main-seed',
      thumb: 'thumb-url',
      originalWidth: 4032,
      originalHeight: 3024,
      originalBytes: 1_234_567,
      uhdUrl: 'uhd-url',
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      uhdMd5: 'uhd-md5',
    }, true)

    expect(opts).toEqual({
      md5: 'main-md5',
      timelineId: 'timeline-1',
      mediaId: 'media-1',
      url: 'main-url',
      token: 'main-token',
      seed: 'main-seed',
      thumb: 'thumb-url',
      originalWidth: 4032,
      originalHeight: 3024,
      originalBytes: 1_234_567,
      uhdUrl: 'uhd-url',
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      offline: true,
    })
    // UHD 的 token/seed 只能作为独立字段，不能顶替主图那份。
    expect(opts.token).not.toBe(opts.uhdToken)
    expect(opts.seed).not.toBe(opts.uhdSeed)
    // `uhdMd5` 只用于媒体键登记，不是 getSnsImageDataUrl 的入参。
    expect(opts).not.toHaveProperty('uhdMd5')
  })

  it('空值不伪造字段，`key` 仍可作为主图 seed 的别名', () => {
    expect(buildSnsImageRequestOptions({ md5: 'only-md5', key: 'from-key' }, false)).toEqual({
      md5: 'only-md5',
      seed: 'from-key',
      offline: false,
    })
  })
})

describe('pendingCovers：只为本机没有的文章链接去打网络', () => {
  const art = mk({ tid: 'a', contentType: 3, link_url: 'https://x/1', images: [{ md5: 'cover', url: 'u', thumb: 't', key: 'k' }] })

  it('非文章、无 URL、本地已能解出、已经抓到的都不来', () => {
    const attempts = new Map<string, number>()
    expect(pendingCovers([mk({ tid: 'p', contentType: 1, link_url: 'https://x/2' })], {}, {}, attempts)).toEqual([])
    expect(pendingCovers([mk({ tid: 'p', contentType: 3 })], {}, {}, attempts)).toEqual([])
    expect(pendingCovers([art], { cover: 'data:local' }, {}, attempts)).toEqual([])
    expect(pendingCovers([art], {}, { 'https://x/1': 'data:got' }, attempts)).toEqual([])
    expect(pendingCovers([art], {}, {}, attempts)).toEqual(['https://x/1'])
  })

  it('候选筛选不消耗尝试次数；调用方只按已发送次数限制到 3 次', () => {
    const attempts = new Map<string, number>()
    for (let i = 0; i < 4; i += 1) expect(pendingCovers([art], {}, {}, attempts)).toEqual(['https://x/1'])
    expect(attempts.size, 'pendingCovers 不应提前消耗重试预算').toBe(0)
    attempts.set('https://x/1', 2)
    expect(pendingCovers([art], {}, {}, attempts)).toEqual(['https://x/1'])
    attempts.set('https://x/1', 3)
    expect(pendingCovers([art], {}, {}, attempts), '试满 3 次之后还在重试').toEqual([])
  })

  it('已经在飞的文章链接不会在 effect 重跑时重复入队', () => {
    const inflight = new Set(['https://x/1'])
    expect(pendingCovers([art], {}, {}, new Map(), inflight)).toEqual([])
  })
})

describe('媒体元数据上限', () => {
  it('卡片登记过的媒体键只保留最近 4000 条，长列表不会让 spec 表无限增长', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
    class FakeIntersectionObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] { return [] }
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: FakeIntersectionObserver,
    })
    try {
      const specs = Array.from(
        { length: MOMENTS_MEDIA_KEY_CACHE_MAX + 8 },
        (_, i) => img('bounded-' + String(i)),
      )
      render({ specs })
      expect(media?.mediaKeySpec.current.size).toBe(MOMENTS_MEDIA_KEY_CACHE_MAX)
      expect(media?.mediaKeySpec.current.has('bounded-0')).toBe(false)
      expect(media?.mediaKeySpec.current.has('bounded-' + String(MOMENTS_MEDIA_KEY_CACHE_MAX + 7))).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'IntersectionObserver', descriptor)
      else Reflect.deleteProperty(globalThis, 'IntersectionObserver')
    }
  })

  it('待解密队列按视口优先级截断到硬上限，被挤掉的键可以再次入队', () => {
    const specOf = new Map<string, { md5: string; kind: 'img' }>()
    const entries = Array.from({ length: MOMENTS_MEDIA_QUEUE_MAX + 25 }, (_, i) => {
      const key = 'queued-' + String(i)
      specOf.set(key, { md5: key, kind: 'img' })
      return {
        isIntersecting: true,
        target: {
          dataset: { snsKey: key },
          getBoundingClientRect: () => ({ top: 0, bottom: 10 }),
        },
      }
    })
    const active = new Set<string>()
    const fetched = new BoundedMediaSet<string>(MOMENTS_MEDIA_KEY_CACHE_MAX, () => active)
    const queue = { current: [] as Array<{ key: string; md5: string; kind: 'img' }> }

    expect(enqueueIntersecting(
      entries as unknown as IntersectionObserverEntry[],
      specOf,
      fetched,
      active,
      queue,
      null,
    )).toBe(true)
    expect(queue.current.length).toBe(MOMENTS_MEDIA_QUEUE_MAX)
    expect(active.size).toBe(MOMENTS_MEDIA_QUEUE_MAX)
    expect(fetched.size).toBe(MOMENTS_MEDIA_QUEUE_MAX)
    expect(queue.current.every((item) => active.has(item.key) && fetched.has(item.key))).toBe(true)
    expect(fetched.has('queued-' + String(MOMENTS_MEDIA_QUEUE_MAX + 24))).toBe(false)

    const droppedKey = 'queued-' + String(MOMENTS_MEDIA_QUEUE_MAX + 24)
    expect(enqueueIntersecting(
      [{
        isIntersecting: true,
        target: {
          dataset: { snsKey: droppedKey },
          getBoundingClientRect: () => ({ top: 0, bottom: 10 }),
        },
      }] as unknown as IntersectionObserverEntry[],
      specOf,
      fetched,
      active,
      queue,
      null,
    )).toBe(true)
    expect(queue.current.some((item) => item.key === droppedKey), '被挤出队列的键没有再次入队').toBe(true)
    expect(fetched.has(droppedKey)).toBe(true)
  })

})

describe('媒体队列与重活车道恢复', () => {
  it('队列满时淘汰队尾预取项，重试项立即入队且只触发一次 timer', () => {
    vi.useFakeTimers()
    try {
      const queue = {
        current: Array.from(
          { length: MOMENTS_MEDIA_QUEUE_MAX },
          (_, i) => ({ key: 'queued-' + String(i), md5: String(i), kind: 'img' as const }),
        ),
      }
      const active = new Set(queue.current.map((item) => item.key))
      const fetched = new Set(active)
      const timers = { current: new Set<number>() }
      const unmounted = { current: false }
      const drain = vi.fn()
      const retry = { key: 'retry-me', md5: 'retry-me', kind: 'img' as const }
      active.add(retry.key)
      fetched.add(retry.key)
      const droppedKey = queue.current[queue.current.length - 1]!.key

      requeueAfterDelay(retry, queue, active, fetched, unmounted, timers, drain)
      expect(vi.getTimerCount()).toBe(1)
      act(() => { vi.advanceTimersByTime(1500) })
      expect(queue.current.length).toBe(MOMENTS_MEDIA_QUEUE_MAX)
      expect(queue.current[0]?.key).toBe('retry-me')
      expect(queue.current.some((item) => item.key === droppedKey), '队尾预取项没有被淘汰').toBe(false)
      expect(active.has(droppedKey)).toBe(false)
      expect(fetched.has(droppedKey)).toBe(false)
      expect(active.has(retry.key)).toBe(true)
      expect(fetched.has(retry.key)).toBe(true)
      expect(drain).toHaveBeenCalledTimes(1)
      expect(timers.current.size).toBe(0)
      expect(vi.getTimerCount(), '队列满时发生了递归续期').toBe(0)

      act(() => { vi.advanceTimersByTime(5000) })
      expect(drain).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('重活车道取消后跳过已排队但尚未开始的任务', async () => {
    let cancelled = false
    let releaseFirst!: () => void
    let firstStarted = false
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const lane = createCancellableHeavyRpcLane(() => cancelled)
    const first = lane(async () => {
      firstStarted = true
      await firstGate
      return 'first'
    })
    const secondTask = vi.fn(async () => 'second')
    const second = lane(secondTask)

    await Promise.resolve()
    expect(firstStarted).toBe(true)
    cancelled = true
    releaseFirst()

    await expect(first).resolves.toBe('first')
    await expect(second).rejects.toThrow('朋友圈媒体请求已取消')
    expect(secondTask).not.toHaveBeenCalled()
  })
})

/* ── 钩子行为 ──────────────────────────────────────────────────────────── */

let host: HTMLDivElement
let root: Root
let media: Media | null = null

/** 卡片的做法：在 **render 期间**把 spec 登记进那张表（挪进 useEffect 就会错过挂载时的那次兜底）。 */
function Register({ specs }: { specs: Array<[string, { md5: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }]> }): React.JSX.Element {
  if (media) for (const [k, spec] of specs) media.mediaKeySpec.current.set(k, { ...spec })
  return createElement('span', { 'data-registered': String(specs.length) })
}

function Harness(props: {
  moments: readonly MomentItem[]
  viewer: Parameters<typeof useMomentsMedia>[0]['viewer']
  specs: Array<[string, { md5: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }]>
}): React.JSX.Element {
  media = useMomentsMedia({ moments: props.moments, viewer: props.viewer, scrollRef: { current: null }, groups: [1], renderKey: '0-0', detailKey: '' })
  return createElement('div', null, createElement(Register, { specs: props.specs }),
    createElement('span', { 'data-imgs': Object.keys(media.snsImgs).sort().join(',') }),
    createElement('span', { 'data-originals': Array.from(media.snsOriginals).sort().join(',') }))
}

const img = (md5: string): [string, { md5: string; kind: 'img' }] => [md5, { md5, kind: 'img' }]

const render = (
  props: { moments?: readonly MomentItem[]; viewer?: Parameters<typeof useMomentsMedia>[0]['viewer']; specs?: Array<[string, { md5: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }]> } = {},
  strict = false,
): void => {
  act(() => {
    const harness = createElement(Harness, {
      moments: props.moments ?? [],
      viewer: props.viewer ?? null,
      specs: props.specs ?? [],
    })
    root.render(strict ? createElement(StrictMode, null, harness) : harness)
  })
}

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const attrList = (name: string): string[] =>
  (host.querySelector(`[${name}]`)?.getAttribute(name) ?? '').split(',').filter(Boolean)
const imgs = (): string[] => attrList('data-imgs')
const originals = (): string[] => attrList('data-originals')

beforeEach(() => {
  media = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useMomentsMedia：兜底解密路径（jsdom 里没有 IntersectionObserver）', () => {
  it('挂载时那条兜底分支确实跑的是空表 ⇒ 判据得靠 render 期间登记的 spec 才有东西可解', async () => {
    expect(typeof IntersectionObserver, 'jsdom 若哪天支持了 IO，这份判据的口径要跟着改').toBe('undefined')
    render({ specs: [img('k1')] })
    await flush()
    expect(imgs(), '登记的键没有被解密出来').toEqual(['k1'])
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
  })

  it('有网：也先查 IndexedDB 原图，命中就直接显示、不再出网', async () => {
    setOnline(true)
    mocks.snsMediaCacheGet.mockResolvedValue('data:本地原图')
    render({ specs: [img('k1')] })
    await flush()
    expect(mocks.snsMediaCacheGet).toHaveBeenCalledWith('k1', true)
    expect(mocks.apiGetSnsImageDataUrl, '本地已有原图时不该再出网').not.toHaveBeenCalled()
    expect(imgs()).toEqual(['k1'])
  })

  it('有网但本地没有原图：走后端（后端自己按长期归档 → 本机 → CDN）', async () => {
    setOnline(true)
    mocks.snsMediaCacheGet.mockResolvedValue(null)
    render({ specs: [img('k1')] })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    const opts = mocks.apiGetSnsImageDataUrl.mock.calls[0]?.[0] as { offline?: boolean } | undefined
    expect(opts?.offline, '有网时 offline 必须是 false').toBe(false)
  })

  it('无网：先用 IndexedDB 里已下载的那份，命中就不必再问后端', async () => {
    setOnline(false)
    // Once：只让 k1 命中，k2 仍要走后端（离线时后端走「已下载的原图缓存 → 本机」）
    mocks.snsMediaCacheGet.mockResolvedValueOnce('data:from-idb')
    render({ specs: [img('k1'), img('k2')] })
    await flush()
    expect(mocks.snsMediaCacheGet).toHaveBeenCalledWith('k1', true)
    expect(mocks.apiGetSnsImageDataUrl.mock.calls.filter((c) => (c[0] as { md5: string }).md5 === 'k1')).toHaveLength(0)
    expect(mocks.apiGetSnsImageDataUrl.mock.calls.filter((c) => (c[0] as { md5: string }).md5 === 'k2')).toHaveLength(1)
    const opts = mocks.apiGetSnsImageDataUrl.mock.calls[0]?.[0] as { offline?: boolean } | undefined
    expect(opts?.offline, '无网时 offline 必须是 true').toBe(true)
    expect(imgs()).toEqual(expect.arrayContaining(['k1', 'k2']))
  })

  it('批量恢复最多 80 个键，首屏最先的图不许被后面的键挤掉（cap 淘汰顺序的坑）', async () => {
    const moments = Array.from({ length: 120 }, (_, i) => mk({
      tid: String(i),
      images: [{ md5: 'm' + String(i), url: '', thumb: '', key: '' }],
    }))
    mocks.snsMediaCacheGetMany.mockImplementation(async (keys: readonly string[]) => (
      Object.fromEntries(keys.map((k) => [k, 'data:' + k]))
    ))
    render({ moments })
    await flush()
    const keys = mocks.snsMediaCacheGetMany.mock.calls[0]?.[0] as readonly string[] | undefined
    expect(keys?.length, '一次恢复的键数没有上限').toBe(80)
    expect(keys?.[0]).toBe('m0')
    expect(imgs(), '首屏第一张被后面的键挤掉了').toContain('m0')
  })

  it('同批里一张 RPC 卡住时，已命中的本地原图也必须立刻上屏（不能等整批 Promise.all）', async () => {
    let releaseSlow: (() => void) | null = null
    mocks.snsMediaCacheGet.mockImplementation(async (key: string) => (key === 'cached' ? 'data:cached' : null))
    mocks.apiGetSnsImageDataUrl.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSlow = () => { resolve({ url: 'data:slow' }) }
    }))
    render({ specs: [img('cached'), img('slow')] })
    await flush()
    expect(imgs(), '慢图还没回来，缓存图不该一起被压住').toContain('cached')
    releaseSlow!()
    await flush()
    await flush()
  })

  it('缺 CDN 三件套的图片 RPC 串行：同一时刻只发一个，避免后端重活队列 REMOTE_BUSY', async () => {
    let releaseFirst: (() => void) | null = null
    mocks.apiGetSnsImageDataUrl.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirst = () => { resolve({ url: 'data:k1' }) }
    }))
    render({ specs: [img('k1'), img('k2'), img('k3')] })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl.mock.calls.length, '第一张还没回话就发了第二个重活 RPC').toBe(1)
    releaseFirst!()
    await flush()
    await flush()
    await flush()
    expect(mocks.apiGetSnsImageDataUrl.mock.calls.length).toBe(3)
  })

  it('一批 8 个，剩下的一定要排空（把 while 改成一次 splice 就会漏）', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => 'kk' + String(i))
    render({ specs: keys.map(img) })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(10)
    expect(imgs().length).toBe(10)
  })

  it('同一个键不重复解；重渲染也不会（去重集合必须是 ref 而不是 state）', async () => {
    render({ specs: [img('k1')] })
    await flush()
    render({ specs: [img('k1')] })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
  })

  it('解出来要写回 IndexedDB，供下次进面板秒显（并记下「这是不是缩略图」）', async () => {
    render({ specs: [img('k1')] })
    await flush()
    expect(mocks.snsMediaCacheSet).toHaveBeenCalledWith('k1', 'data:k1', false)
  })

  it('后端降级给了缩略图 ⇒ 写回时标成 thumb，好让下一轮去换原图', async () => {
    mocks.apiGetSnsImageDataUrl.mockResolvedValueOnce({ url: 'data:thumb', thumb: true })
    render({ specs: [img('k1')] })
    await flush()
    // thumb=true 必须被记下来 —— 否则这份缩略图会永久遮住后来的原图
    expect(mocks.snsMediaCacheSet).toHaveBeenCalledWith('k1', 'data:thumb', true)
  })

  it('进面板时无论有网无网都先做 IDB 原图批量恢复（本地优先）', async () => {
    setOnline(true)
    const m = mk({ tid: '1', images: [{ md5: 'cached', url: 'u', thumb: 't', key: 'k' }] })
    mocks.snsMediaCacheGetMany.mockResolvedValue({ cached: 'data:cached' })
    render({ moments: [m] })
    await flush()
    expect(mocks.snsMediaCacheGetMany).toHaveBeenCalledWith(['cached'], true)
    expect(imgs()).toContain('cached')
  })

  it('视频键走视频封那个 RPC，而不是图片那个', async () => {
    const v = mk({ tid: 'v1', videos: [{ url: 'u', thumb: 't', key: 'seed1', md5: 'vm', duration: 2 }] })
    render({ moments: [v], specs: [['v:vm', { md5: 'vm', kind: 'video', seed: 'seed1', thumb: 't' }]] })
    await flush()
    expect(mocks.apiGetSnsVideoCoverDataUrl).toHaveBeenCalledTimes(1)
    // `offline` 是新加的字段，原有三件（md5/key/thumb）必须逐字不变
    const vopts = mocks.apiGetSnsVideoCoverDataUrl.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(vopts).toMatchObject({ md5: 'vm', key: 'seed1', thumb: 't' })
    expect(mocks.apiGetSnsImageDataUrl).not.toHaveBeenCalled()
  })

  it('IDB 批量恢复命中后，兜底路径不再重复解同一条（有网/无网都成立）', async () => {
    const m = mk({ tid: '1', images: [{ md5: 'cached', url: 'u', thumb: 't', key: 'k' }] })
    mocks.snsMediaCacheGetMany.mockResolvedValueOnce({ cached: 'data:cached' })
    // 先只给列表、不给 spec：这就是「卡片还没渲染到那一格」时 IDB 恢复要独立起作用的形状
    setOnline(false)
    render({ moments: [m] })
    await flush()
    expect(mocks.snsMediaCacheGetMany).toHaveBeenCalledWith(['cached'], true)
    expect(imgs()).toContain('cached')
    // 已经被 IDB 命中的键，兜底路径不该再去解一遍（这一步同时证明去重集合跨渲染活着）
    render({ moments: [m], specs: [img('cached')] })
    await flush()
    expect(mocks.snsMediaCacheGet).not.toHaveBeenCalled()
    expect(mocks.apiGetSnsImageDataUrl).not.toHaveBeenCalled()
  })

  it('封面兜底：只有文章且本机没有时才抓，且抓过就记进 state', async () => {
    const a = mk({ tid: 'a', contentType: 3, link_url: 'https://x/1' })
    mocks.apiGetArticleCovers.mockResolvedValueOnce({ items: [{ url: 'https://x/1', dataUrl: 'data:cover1' }] })
    render({ moments: [a] })
    await flush()
    expect(mocks.apiGetArticleCovers).toHaveBeenCalledTimes(1)
    expect(mocks.apiGetArticleCovers).toHaveBeenCalledWith({ urls: ['https://x/1'] })
    render({ moments: [a] })
    await flush()
    expect(mocks.apiGetArticleCovers, '同一篇文章被抓了两次').toHaveBeenCalledTimes(1)
  })

  it('A1：一屏多篇文章只发**一个**批量 RPC（改前是每篇一个 RPC）', async () => {
    const arts = ['https://x/1', 'https://x/2', 'https://x/3'].map((u, i) =>
      mk({ tid: 'a' + String(i), contentType: 3, link_url: u }))
    mocks.apiGetArticleCovers.mockImplementation(async ({ urls }: { urls: readonly string[] }) => ({
      items: urls.map((url) => ({ url, dataUrl: 'data:' + url })),
    }))
    render({ moments: arts })
    await flush()
    expect(mocks.apiGetArticleCovers, '一屏 3 篇必须合成 1 个 RPC').toHaveBeenCalledTimes(1)
    expect(mocks.apiGetArticleCovers.mock.calls[0]?.[0]).toEqual({ urls: ['https://x/1', 'https://x/2', 'https://x/3'] })
  })

  it('A2：超过一批（8 条）时分批发出，不会一次全打出去', async () => {
    const arts = Array.from({ length: 10 }, (_, i) => mk({ tid: 'b' + String(i), contentType: 3, link_url: 'https://y/' + String(i) }))
    mocks.apiGetArticleCovers.mockImplementation(async ({ urls }: { urls: readonly string[] }) => ({
      items: urls.map((url) => ({ url, dataUrl: 'data:' + url })),
    }))
    render({ moments: arts })
    await flush()
    const sizes = mocks.apiGetArticleCovers.mock.calls.map((c) => (c[0] as { urls: readonly string[] }).urls.length)
    expect(sizes, '10 篇应当 8 + 2 两批，而不是一次 10').toEqual([8, 2])
  })

  it('灯箱缺图按需解析只发生一次', async () => {
    const viewer = { images: [{ md5: 'lightbox-md5', url: 'u', thumb: 't' }], index: 0, author: '张三' }
    render({ viewer })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledWith({
      md5: 'lightbox-md5',
      url: 'u',
      thumb: 't',
      offline: false,
    })
    render({ viewer })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl, '同一张灯箱图被解了两次').toHaveBeenCalledTimes(1)
  })

  it('网格先写缩略图也不会挡住灯箱回源，原图成功后会覆盖它', async () => {
    mocks.apiGetSnsImageDataUrl
      .mockResolvedValueOnce({ url: 'data:thumb', thumb: true })
      .mockResolvedValueOnce({ url: 'data:original' })
    const viewer = { images: [{ md5: 'thumb-key', url: 'u', thumb: 't' }], index: 0, author: '张三' }

    render({ specs: [img('thumb-key')] })
    await flush()
    expect(media?.snsImgs['thumb-key']).toBe('data:thumb')
    expect(originals(), '缩略图不该被登记成原图').toEqual([])

    render({ specs: [img('thumb-key')], viewer })
    await flush()
    await flush()

    expect(mocks.apiGetSnsImageDataUrl, '网格的 fetched 挡住了灯箱回源').toHaveBeenCalledTimes(2)
    expect(media?.snsImgs['thumb-key']).toBe('data:original')
    expect(originals()).toContain('thumb-key')
    expect(mocks.snsMediaCacheSet).toHaveBeenLastCalledWith('thumb-key', 'data:original', false)
  })

  it('灯箱原图请求失败后回退当前缩略图，第二次不再打后端', async () => {
    mocks.apiGetSnsImageDataUrl.mockRejectedValue(new Error('后端暂时失败'))
    const commit = vi.fn()
    const resolve = createSnsOriginalResolver({
      current: () => ({ url: 'data:current-thumb', original: false }),
      commit,
      alive: () => true,
      runHeavy: <T,>(task: () => Promise<T>): Promise<T> => task(),
    })
    const image = { md5: 'resolver-fail', url: 'u', thumb: 't' }

    await expect(resolve(image)).resolves.toBe('data:current-thumb')
    await expect(resolve(image), '失败后第二次没有回退到当前缩略图').resolves.toBe('data:current-thumb')
    expect(mocks.apiGetSnsImageDataUrl, '失败后仍在反复打后端').toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('没有本地缩略图时失败就报错，不把 CDN 密文地址当兜底', async () => {
    mocks.apiGetSnsImageDataUrl.mockRejectedValue(new Error('原图暂时取不到'))
    const resolve = createSnsOriginalResolver({
      current: () => undefined,
      commit: vi.fn(),
      alive: () => true,
      runHeavy: <T,>(task: () => Promise<T>): Promise<T> => task(),
    })

    await expect(resolve({
      md5: 'no-local-fallback',
      url: 'https://cdn.example/encrypted',
      thumb: 'https://cdn.example/encrypted-thumb',
    })).rejects.toThrow('原图暂时取不到')
  })

  it('同一张图补齐 UHD 元数据后允许再回源，不被上一次缩略图结果挡住', async () => {
    mocks.apiGetSnsImageDataUrl
      .mockResolvedValueOnce({ url: 'data:thumb', thumb: true })
      .mockResolvedValueOnce({ url: 'data:uhd-original' })
    let current: { url: string; original: boolean } | undefined
    const resolve = createSnsOriginalResolver({
      current: () => current,
      commit: (_key, url, original) => { current = { url, original } },
      alive: () => true,
      runHeavy: <T,>(task: () => Promise<T>): Promise<T> => task(),
    })

    await expect(resolve({ md5: 'late-uhd', url: 'main-url', token: 'main-token', key: 'main-seed' }))
      .resolves.toBe('data:thumb')
    expect(current, '缩略图不能登记成原图').toEqual({ url: 'data:thumb', original: false })

    await expect(resolve({
      md5: 'late-uhd',
      url: 'main-url',
      token: 'main-token',
      key: 'main-seed',
      originalWidth: 1440,
      originalHeight: 1920,
      originalBytes: 212083,
      uhdUrl: 'uhd-url/2000',
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
    })).resolves.toBe('data:uhd-original')
    expect(mocks.apiGetSnsImageDataUrl, 'UHD 元数据补齐后仍被旧失败闸门挡住').toHaveBeenCalledTimes(2)
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenLastCalledWith(expect.objectContaining({
      uhdUrl: 'uhd-url/2000',
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
    }))
    expect(current).toEqual({ url: 'data:uhd-original', original: true })
  })

  it('其他图片上屏不会取消并重启正在进行的灯箱请求', async () => {
    let releaseLightbox: ((value: { url: string }) => void) | null = null
    mocks.snsMediaCacheGet.mockResolvedValue(null)
    mocks.apiGetSnsImageDataUrl.mockImplementation(({ md5 }: { md5: string }) => {
      if (md5 === 'lightbox-slow') {
        return new Promise((resolve) => {
          releaseLightbox = resolve
        })
      }
      return Promise.resolve({ url: 'data:' + md5 })
    })
    const viewer = { images: [{ md5: 'lightbox-slow', url: 'u', thumb: 't' }], index: 0, author: '张三' }

    render({ viewer, specs: [img('other-fast')] })
    await flush()
    await flush()
    const lightboxCalls = (): number => mocks.apiGetSnsImageDataUrl.mock.calls
      .filter((call) => (call[0] as { md5: string }).md5 === 'lightbox-slow')
      .length
    expect(imgs()).toContain('other-fast')
    expect(lightboxCalls()).toBe(1)

    releaseLightbox!({ url: 'data:lightbox-slow' })
    await flush()
    await flush()
    expect(lightboxCalls(), '无关图片更新重启了灯箱请求').toBe(1)
    expect(imgs()).toContain('lightbox-slow')
  })
})

describe('useMomentsMedia：失败重试状态的生命周期', () => {
  it('其他图片上屏不会取消正在进行的文章封面请求', async () => {
    let releaseCover!: (value: { items: Array<{ url: string; dataUrl?: string; error?: string }> }) => void
    mocks.apiGetArticleCovers.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCover = resolve
    }))
    const article = mk({ tid: 'cover-while-images', contentType: 3, link_url: 'https://x/article' })
    const moments = [article]

    render({ moments, specs: [img('other-fast')] })
    await flush()
    expect(mocks.apiGetArticleCovers).toHaveBeenCalledTimes(1)
    expect(imgs()).toContain('other-fast')

    releaseCover({ items: [{ url: 'https://x/article', dataUrl: 'data:article-cover' }] })
    await flush()
    await flush()

    expect(media?.articleCovers['https://x/article']).toBe('data:article-cover')
  })

  it('卸载时取消尚未触发的重试 timer，回调不再持有面板或继续请求', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      mocks.snsMediaCacheGet.mockResolvedValue(null)
      mocks.apiGetSnsImageDataUrl.mockRejectedValue(new Error('暂时失败'))

      render({ specs: [img('unmounted-retry')] })
      await flush()
      expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)

      act(() => { root.unmount() })
      expect(vi.getTimerCount(), '卸载后仍有延迟重试 timer 持有面板闭包').toBe(0)
      host.remove()
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      act(() => { vi.advanceTimersByTime(5000) })
      await flush()
      expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('永久失败不留下计数；重新挂载后从头获得完整重试预算', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      mocks.snsMediaCacheGet.mockResolvedValue(null)
      mocks.apiGetSnsImageDataUrl.mockRejectedValue(new Error('永久失败'))

      render({ specs: [img('retry-reset')] })
      await flush()
      for (let i = 0; i < 2; i += 1) {
        act(() => { vi.advanceTimersByTime(1500) })
        await flush()
      }
      expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(3)

      act(() => { root.unmount() })
      host.remove()
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)

      render({ specs: [img('retry-reset')] })
      await flush()
      for (let i = 0; i < 2; i += 1) {
        act(() => { vi.advanceTimersByTime(1500) })
        await flush()
      }
      expect(mocks.apiGetSnsImageDataUrl, '失败计数跨挂载残留，第二次只试了一次').toHaveBeenCalledTimes(6)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('封面 effect 取消后的迟到回包不写 state，也不安排新的 retry timer', async () => {
    vi.useFakeTimers()
    let releaseCover!: (value: { items: Array<{ url: string; dataUrl?: string; error?: string }> }) => void
    mocks.apiGetArticleCovers.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCover = resolve
    }))
    const article = mk({ tid: 'cover-late', contentType: 3, link_url: 'https://x/late' })
    try {
      render({ moments: [article] })
      await flush()
      expect(mocks.apiGetArticleCovers).toHaveBeenCalledTimes(1)

      render({ moments: [] })
      releaseCover({
        items: [
          { url: 'https://x/late', dataUrl: 'data:late-cover' },
          { url: 'https://x/missed', error: 'no cover' },
        ],
      })
      await flush()
      await flush()

      expect(media?.articleCovers['https://x/late'], '已取消 effect 的回包仍写入了封面').toBeUndefined()
      expect(vi.getTimerCount(), '已取消 effect 的迟到回包仍安排了重试 timer').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('封面包被依赖变化取消后，仍会唤醒新 effect 重新认领该 URL', async () => {
    vi.useFakeTimers()
    let releaseFirst!: (value: { items: Array<{ url: string; error?: string }> }) => void
    mocks.apiGetArticleCovers
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce({ items: [{ url: 'https://x/reclaim', dataUrl: 'data:reclaimed' }] })
    const article = mk({ tid: 'cover-reclaim', contentType: 3, link_url: 'https://x/reclaim' })
    try {
      render({ moments: [article] })
      await flush()
      expect(mocks.apiGetArticleCovers).toHaveBeenCalledTimes(1)

      render({ moments: [article] })
      releaseFirst({ items: [{ url: 'https://x/reclaim', error: 'cancelled' }] })
      await flush()
      await flush()
      await flush()

      expect(mocks.apiGetArticleCovers, '取消后的 URL 没有重新被认领').toHaveBeenCalledTimes(2)
      expect(media?.articleCovers['https://x/reclaim']).toBe('data:reclaimed')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('封面 panel retry timer 在卸载时清理', async () => {
    vi.useFakeTimers()
    try {
      render({ moments: [mk({ tid: 'cover-timer', contentType: 3, link_url: 'https://x/timer' })] })
      await flush()
      expect(mocks.apiGetArticleCovers).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)

      act(() => { root.unmount() })
      expect(vi.getTimerCount(), '封面 retry timer 仍持有面板闭包').toBe(0)
      host.remove()
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    } finally {
      vi.useRealTimers()
    }
  })

  it('StrictMode 的 effect 假卸载不会把灯箱请求永久记为已取过', async () => {
    const viewer = { images: [{ md5: 'strict-lightbox', url: 'u', thumb: 't' }], index: 0, author: '张三' }
    render({ viewer }, true)
    await flush()
    await flush()
    expect(imgs(), '第一轮请求被 cleanup 作废后，第二轮没有重新认领这个键').toContain('strict-lightbox')
  })
})

describe('视频号链接卡：不再把 finderFeed 当九宫格图片', () => {
  it('contentType=28 隐藏伪图片格，封面走 link_thumb，标签固定为视频号', () => {
    const view = momentLinkCardView({
      contentType: 28,
      images: [{
        thumb: 'https://wxapp.tc.qq.com/thumb',
        url: 'https://wxapp.tc.qq.com/video',
        key: '',
        md5: '',
        timelineId: 'tl-video',
      }],
      link_url: 'https://support.weixin.qq.com/update/',
      link_thumb: 'https://wxapp.tc.qq.com/cover',
      sourceNickName: '视频号',
    }, {}, {})

    expect(view.showImages).toBe(false)
    expect(view.coverSrc).toBe('https://wxapp.tc.qq.com/cover')
    expect(view.label).toBe('视频号')
    expect(view.title).toBe('视频号内容')
  })

  it('旧归档缺 contentType 时按 sourceNickName 兜底，并过滤无媒体键的伪图片', () => {
    const fake = {
      thumb: 'https://wxapp.tc.qq.com/thumb',
      url: 'https://wxapp.tc.qq.com/video',
      key: '',
      md5: '',
      timelineId: 'tl-video',
    }
    const real = {
      thumb: 'thumb', url: 'url', key: 'seed', md5: 'b'.repeat(32), timelineId: 'tl', id: 'mid',
    }
    const view = momentLinkCardView({
      images: [fake, real],
      link_url: 'https://support.weixin.qq.com/update/',
      sourceNickName: '视频号',
    }, {}, {})

    expect(view.showImages).toBe(false)
    expect(view.label).toBe('视频号')
    expect(view.title).toBe('视频号内容')
    expect(momentGridImages({ images: [fake, real] })).toEqual([real])
  })

  it('已经解析出的真实视频号标题不被前端兜底覆盖', () => {
    const view = momentLinkCardView({
      contentType: 28,
      images: [],
      link_url: 'https://support.weixin.qq.com/update/',
      link_title: '真实视频号标题',
      sourceNickName: '视频号',
    }, {}, {})
    expect(view.title).toBe('真实视频号标题')
  })

  it('普通动态仍显示图片，公众号文章仍隐藏正文图片', () => {
    const image = {
      thumb: 'thumb', url: 'url', key: 'seed', md5: 'a'.repeat(32), timelineId: 'tl',
    }
    expect(momentLinkCardView({ contentType: 1, images: [image] }, {}, {}).showImages).toBe(true)
    expect(momentLinkCardView({ contentType: 3, images: [image], link_url: 'https://mp.weixin.qq.com/s/x' }, {}, {}).showImages).toBe(false)
  })

  it('公众号文章拿到文章页封面后优先显示它，等待期间可用本机 SNS 封面兜底', () => {
    const image = {
      thumb: 'thumb', url: 'url', key: 'seed', md5: '', timelineId: 'tl', id: 'mid',
    }
    const key = 'tl:mid'
    const article = {
      contentType: 3,
      images: [image],
      link_url: 'https://mp.weixin.qq.com/s/x',
      sourceNickName: '人民日报',
    }

    expect(momentLinkCardView(article, { [key]: 'data:local-cover' }, {}).coverSrc).toBe('data:local-cover')
    expect(momentLinkCardView(article, { [key]: 'data:local-cover' }, {
      'https://mp.weixin.qq.com/s/x': 'data:article-cover',
    }).coverSrc).toBe('data:article-cover')
  })
})

describe('接线：面板只从这一层拿媒体状态', () => {
  const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')
  const mediaLayer = readFileSync(join(HERE, 'moments-media.ts'), 'utf8')

  it('面板走 useMomentsMedia，且不再自己持有媒体状态', () => {
    expect(panel).toContain('useMomentsMedia')
    for (const gone of ['setSnsImgs', 'setArticleCovers', 'coverTick', 'mediaQueue', 'drainMedia', 'snsFetched']) {
      expect(panel, `「${gone}」又回到面板里了 ⇒ 媒体层被绕过`).not.toContain(gone)
    }
    // 媒体层现在用带 original 标记的条目状态；「有图」与「原图」不再共用一份字符串表。
    expect(mediaLayer).toContain('const [snsImageEntries, setSnsImageEntries]')
    expect(mediaLayer).toContain('const commitSnsImages = useCallback')
    expect(mediaLayer).toContain('const snsOriginals = useMemo')
    expect(mediaLayer).toContain('function mergeSnsImageEntries')
  })

  it('卡片仍在 render 期间登记 spec（挪进 useEffect 就错过挂载时的兜底）', () => {
    const card = readFileSync(join(HERE, 'moments-card.tsx'), 'utf8')
    const sf = ts.createSourceFile('moments-card.tsx', card.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let total = 0
    let inEffect = 0
    const walk = (node: ts.Node, inside: boolean): void => {
      // 只认「这个调用本身」是 mediaKeySpec.current.set(...)，否则外层 useEffect(...) 的文本也含这段 ⇒ 会误判
      if (ts.isCallExpression(node) && node.expression.getText(sf) === 'mediaKeySpec.current.set') {
        total += 1
        if (inside) inEffect += 1
      }
      const nowInside = inside || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect')
      ts.forEachChild(node, (c) => { walk(c, nowInside) })
    }
    walk(sf, false)
    expect(total, '卡片不再往那张表里登记 ⇒ 观察器永远查不到 spec，图片停在缩略图').toBeGreaterThanOrEqual(3)
    expect(inEffect, '登记被挪进了 useEffect ⇒ 挂载时那次兜底拿到的是空表').toBe(0)
  })

  it('图片 spec 带着尺寸/UHD 元数据，UHD 的 md5 也不丢', () => {
    const card = readFileSync(join(HERE, 'moments-card.tsx'), 'utf8')
    expect(card).toContain('momentImageSpec(im)')
    expect(mediaLayer).toContain('...snsImageMetadata(im)')
    expect(mediaLayer).toContain('im.uhdMd5')
  })
})
