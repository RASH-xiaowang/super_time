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
 *  · 先问 IndexedDB，命中就不许再调解密 RPC（否则进面板就打爆后端）；
 *  · 一批 8 个之外剩下的也必须排空（`while` 而不是只 splice 一次）；
 *  · 封面兜底最多试 3 次（否则一个永久失败的链接会一直打网络）；
 *  · 灯箱那张缺图的按需解析只发生一次。
 * @module moments-media-spec
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
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

const { collectMediaKeys, pendingCovers, useMomentsMedia, videoCoverKey } = await import('./moments-media.ts')
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
 * 为什么用例必须能切这个：取图口径是**先网后本**（有网直接取 CDN 原图、无网才用本地缓存），
 * 而这个判据来自 `navigator.onLine`。jsdom 默认 `onLine === true`，所以「无网」那几条
 * 用例不显式设成 false 就会全部走有网分支 —— 断言会变成恒真。
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

  it('最多试 3 次，第 4 轮就不许再打（否则一个永久失败的链接会一直出网）', () => {
    const attempts = new Map<string, number>()
    for (let i = 0; i < 3; i += 1) expect(pendingCovers([art], {}, {}, attempts)).toEqual(['https://x/1'])
    expect(pendingCovers([art], {}, {}, attempts), '试满 3 次之后还在重试').toEqual([])
    expect(attempts.get('https://x/1')).toBe(3)
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
  media = useMomentsMedia({ moments: props.moments, viewer: props.viewer, scrollRef: { current: null }, groups: [1], renderKey: '0-0' })
  return createElement('div', null, createElement(Register, { specs: props.specs }),
    createElement('span', { 'data-imgs': Object.keys(media.snsImgs).sort().join(',') }))
}

const img = (md5: string): [string, { md5: string; kind: 'img' }] => [md5, { md5, kind: 'img' }]

const render = (props: { moments?: readonly MomentItem[]; viewer?: Parameters<typeof useMomentsMedia>[0]['viewer']; specs?: Array<[string, { md5: string; kind: 'img' | 'video' | 'comment'; seed?: string; thumb?: string }]> } = {}): void => {
  act(() => {
    root.render(createElement(Harness, {
      moments: props.moments ?? [],
      viewer: props.viewer ?? null,
      specs: props.specs ?? [],
    }))
  })
}

const flush = async (): Promise<void> => {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

const imgs = (): string[] => (host.firstElementChild?.lastElementChild?.getAttribute('data-imgs') ?? '').split(',').filter(Boolean)

beforeEach(() => {
  media = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  root.unmount()
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

  it('有网：不查 IndexedDB，直接走后端（原图由后端从 CDN 取并落盘）', async () => {
    setOnline(true)
    mocks.snsMediaCacheGet.mockResolvedValue('data:旧的缩略图')
    render({ specs: [img('k1')] })
    await flush()
    expect(mocks.snsMediaCacheGet, '有网时不许先查本地缓存').not.toHaveBeenCalled()
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    // 网络状态要传给后端，由它决定走网络还是走本地
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

  it('有网时不走 IDB 批量恢复（否则用户看到的还是上一次那张）', async () => {
    setOnline(true)
    const m = mk({ tid: '1', images: [{ md5: 'cached', url: 'u', thumb: 't', key: 'k' }] })
    mocks.snsMediaCacheGetMany.mockResolvedValue({ cached: 'data:cached' })
    render({ moments: [m] })
    await flush()
    expect(mocks.snsMediaCacheGetMany).not.toHaveBeenCalled()
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

  it('IDB 批量恢复**只在无网时**做（有网时不该先拿旧缓存顶上）', async () => {
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
    expect(mocks.apiGetSnsImageDataUrl).toHaveBeenCalledWith({ md5: 'lightbox-md5', timelineId: undefined, mediaId: undefined })
    render({ viewer })
    await flush()
    expect(mocks.apiGetSnsImageDataUrl, '同一张灯箱图被解了两次').toHaveBeenCalledTimes(1)
  })
})

describe('接线：面板只从这一层拿媒体状态', () => {
  const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')

  it('面板走 useMomentsMedia，且不再自己持有那三份状态', () => {
    expect(panel).toContain('useMomentsMedia')
    for (const gone of ['setSnsImgs', 'setArticleCovers', 'coverTick', 'mediaQueue', 'drainMedia', 'snsFetched']) {
      expect(panel, `「${gone}」又回到面板里了 ⇒ 媒体层被绕过`).not.toContain(gone)
      expect(readFileSync(join(HERE, 'moments-media.ts'), 'utf8'), `本层里也没有「${gone}」，上面那条判据的对象是编的`)
        .toContain(gone)
    }
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
})
