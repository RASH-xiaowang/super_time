// @vitest-environment jsdom
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import type { SnsImageEntries } from './moments-media.ts'
const api = vi.hoisted(() => ({ apiGetSnsImageDataUrl: vi.fn(), apiGetSnsVideoCoverDataUrl: vi.fn(), apiGetArticleCovers: vi.fn(), snsMediaCacheGet: vi.fn(), snsMediaCacheGetMany: vi.fn(), snsMediaCacheSet: vi.fn() }))
vi.mock('../api.ts', () => api)
const { useMomentsMedia, mergeSnsImageEntries, createSnsOriginalResolver, snsImageQuality } = await import('./moments-media.ts')
const { setDataDirIdentity } = await import('../cache.ts')
const weak = { md5: 'fixture-quality' }
const strong = { ...weak, originalWidth: 2048, originalHeight: 1536, originalBytes: 400000, uhdUrl: 'synthetic://uhd' }
const qWeak = snsImageQuality(weak), qStrong = snsImageQuality(strong)
// Public synthetic 1x1 PNG, never a user's image. Adapters below are entirely mocked.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII='
const weakUrl = png + '#weak', strongUrl = png + '#strong'
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function tick() { for (let i = 0; i < 20; i++) await Promise.resolve() }
function resolver() {
  let entries: SnsImageEntries = {}, epoch = 1
  const resolve = createSnsOriginalResolver({ current: key => entries[key], commit: (key, url, original, quality) => { entries = mergeSnsImageEntries(entries, { [key]: { url, original, quality } }) }, alive: () => true, epoch: () => epoch, runHeavy: task => task() })
  return { resolve, current: () => entries, seed: (value: SnsImageEntries) => { entries = value }, next: () => { epoch++ } }
}
let root: Root | undefined, host: HTMLDivElement | undefined, observer: IntersectionObserverCallback
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.values(api).forEach(m => m.mockReset()); setDataDirIdentity('quality-offline-synthetic-A')
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  api.snsMediaCacheGet.mockResolvedValue(null); api.snsMediaCacheGetMany.mockResolvedValue({}); api.snsMediaCacheSet.mockResolvedValue(undefined)
  api.apiGetSnsImageDataUrl.mockResolvedValue({ url: strongUrl }); api.apiGetArticleCovers.mockResolvedValue({ items: [] })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in quality regression') }))
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { observer = cb } observe() {} disconnect() {} unobserve() {} })
})
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; host?.remove(); host = undefined; expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals() })
describe('SNS quality requirements: validated partial order, never guessed ranking', () => {
  it.each([
    ['weaker original', qStrong, qWeak, false],
    ['equal original', qStrong, qStrong, true],
    ['stronger original', qWeak, qStrong, true],
    ['wider but shorter', snsImageQuality({ originalWidth: 900, originalHeight: 1000 }), snsImageQuality({ originalWidth: 1000, originalHeight: 900 }), false],
    ['more pixels but fewer bytes', snsImageQuality({ originalWidth: 900, originalBytes: 4000 }), snsImageQuality({ originalWidth: 1000, originalBytes: 3000 }), false],
    ['UHD flag does not erase dimensions', snsImageQuality({ originalWidth: 2000 }), snsImageQuality({ originalWidth: 1000, uhdUrl: 'synthetic://uhd' }), false],
    ['unlabelled arrival', qStrong, undefined, false],
    ['malformed arrival', qStrong, '[2048,1536,400000,"true"]', false],
    ['negative arrival', qWeak, '[-1,0,0,false]', false],
    ['unknown provenance upgraded', undefined, qStrong, true],
    ['malformed provenance upgraded', 'bad-json', qStrong, true],
  ] as const)('%s', (_name, previous, incoming, replace) => {
    const current = { x: { url: strongUrl, original: true, quality: previous } }
    const result = mergeSnsImageEntries(current, { x: { url: weakUrl, original: true, quality: incoming } })
    expect(result.x?.url).toBe(replace ? weakUrl : strongUrl)
    if (!replace) expect(result).toBe(current)
  })
  it('normalizes invalid numeric requirements exactly like request metadata', () => {
    expect(snsImageQuality({ originalWidth: NaN, originalHeight: -1, originalBytes: Infinity, uhdUrl: '' })).toBe(qWeak)
    expect(snsImageQuality({ originalWidth: 12.9 })).toBe('[12,0,0,false]')
  })
  it('returns the stronger resident to a weaker request, without relabelling unknown originals', async () => {
    const s = resolver(); s.seed({ [weak.md5]: { url: strongUrl, original: true, quality: qStrong } })
    expect(await s.resolve(weak)).toBe(strongUrl); expect(api.apiGetSnsImageDataUrl).not.toHaveBeenCalled()
    s.seed({ [weak.md5]: { url: weakUrl, original: true } })
    expect(await s.resolve(weak)).toBe(weakUrl); expect(s.current()[weak.md5]?.quality).toBeUndefined()
    await s.resolve(strong); expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
  })
  it('malformed labels do not satisfy a constrained request', async () => {
    const s = resolver(); s.seed({ [weak.md5]: { url: weakUrl, original: true, quality: '[2048,1536,400000,1]' } })
    expect(await s.resolve(strong)).toBe(strongUrl); expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
  })
  it('strong request completes before older weak original: neither resident nor returned URL downgrades', async () => {
    const s = resolver(), old = deferred<{ url: string }>(), fresh = deferred<{ url: string }>()
    api.apiGetSnsImageDataUrl.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const a = s.resolve(weak); await tick(); const b = s.resolve(strong); await tick()
    fresh.resolve({ url: strongUrl }); expect(await b).toBe(strongUrl)
    old.resolve({ url: weakUrl }); expect(await a).toBe(strongUrl)
    expect(s.current()[weak.md5]).toEqual({ url: strongUrl, original: true, quality: qStrong })
  })
  it('late weaker single-IDB read cannot return a downgraded viewer URL', async () => {
    const s = resolver(), old = deferred<string | null>(); api.snsMediaCacheGet.mockReturnValueOnce(old.promise)
    const a = s.resolve(weak); await tick(); expect(await s.resolve(strong, { retry: true })).toBe(strongUrl)
    old.resolve(weakUrl); expect(await a).toBe(strongUrl); expect(s.current()[weak.md5]?.quality).toBe(qStrong)
  })
  it('incomparable requests are fetched separately without replacing the resident by a guessed score', async () => {
    const s = resolver(); s.seed({ [weak.md5]: { url: weakUrl, original: true, quality: snsImageQuality({ originalWidth: 3000 }) } })
    await s.resolve({ ...weak, originalHeight: 3000 }); expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    expect(s.current()[weak.md5]?.url).toBe(weakUrl)
  })
  it('prior account and epoch completions still cannot commit or persist', async () => {
    const s = resolver(), old = deferred<{ url: string }>(); api.apiGetSnsImageDataUrl.mockReturnValueOnce(old.promise)
    const pending = s.resolve(strong); await tick(); s.next(); setDataDirIdentity('quality-offline-synthetic-B')
    old.resolve({ url: strongUrl }); await expect(pending).rejects.toThrow('已取消')
    expect(s.current()).toEqual({}); expect(api.snsMediaCacheSet).not.toHaveBeenCalled()
  })
  it('outer viewer does not join an online pending after going offline', async () => {
    const s = resolver(), old = deferred<{ url: string }>(); api.apiGetSnsImageDataUrl.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ url: weakUrl })
    const a = s.resolve(weak); await tick(); Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const b = s.resolve(weak); await tick(); expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(2)
    expect(api.apiGetSnsImageDataUrl.mock.calls[0]?.[0]?.offline).toBe(false)
    expect(api.apiGetSnsImageDataUrl.mock.calls[1]?.[0]?.offline).toBe(true)
    expect(await b).toBe(weakUrl)
    old.resolve({ url: weakUrl }); await Promise.all([a, b])
  })
})
const moments: MomentItem[] = [{ tid: 'synthetic-quality', username: 'synthetic', author: '', text: '', ts: 0, time: '', media_count: 1, media_desc: '', images: [{ ...weak, url: '', thumb: '', key: '' }], videos: [], location: '', link_title: '', is_self: false, likes: [], comments: [] }]
const groups: never[] = []
let media: ReturnType<typeof useMomentsMedia>
function Harness({ upgraded = false }: { upgraded?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  media = useMomentsMedia({ moments, viewer: null, scrollRef, groups, renderKey: 'quality-fixture', detailKey: '', rows: [], windowEnd: -1 })
  media.mediaKeySpec.current.set(weak.md5, { ...(upgraded ? strong : weak), kind: 'img' })
  return createElement('div', { ref: scrollRef })
}
async function render(upgraded = false) {
  if (!root) { host = document.createElement('div'); document.body.append(host); root = createRoot(host) }
  await act(async () => { root?.render(createElement(Harness, { upgraded })); await tick() })
}
describe('SNS actual-hook bulk hydration captures requirements before await', () => {
  it('upgrade during hydration cannot label old bytes with the new requirements', async () => {
    const old = deferred<Record<string, string>>(); api.snsMediaCacheGetMany.mockReturnValueOnce(old.promise)
    await render(); const name = api.snsMediaCacheGetMany.mock.calls[0]?.[0]?.[0] as string
    expect(name.endsWith(':q' + qWeak)).toBe(true); await render(true)
    await act(async () => { old.resolve({ [name]: weakUrl }); await tick() })
    expect(media.snsImgs[weak.md5]).toBe(weakUrl)
    await act(async () => { expect(await media.resolveSnsOriginal(strong)).toBe(strongUrl) })
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1); expect(media.snsImgs[weak.md5]).toBe(strongUrl)
  })
  it('late old hydration cannot overwrite a stronger result already committed', async () => {
    const old = deferred<Record<string, string>>(); api.snsMediaCacheGetMany.mockReturnValueOnce(old.promise)
    await render(); const name = api.snsMediaCacheGetMany.mock.calls[0]?.[0]?.[0] as string
    await render(true); await act(async () => { await media.resolveSnsOriginal(strong) })
    await act(async () => { old.resolve({ [name]: weakUrl }); await tick() })
    expect(media.snsImgs[weak.md5]).toBe(strongUrl)
    await act(async () => { expect(await media.resolveSnsOriginal(weak)).toBe(strongUrl) })
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
  })
  it('late old-account hydration is rejected even if the image key is identical', async () => {
    const old = deferred<Record<string, string>>(); api.snsMediaCacheGetMany.mockReturnValueOnce(old.promise)
    await render(); const name = api.snsMediaCacheGetMany.mock.calls[0]?.[0]?.[0] as string
    setDataDirIdentity('quality-offline-synthetic-B')
    await act(async () => { old.resolve({ [name]: weakUrl }); await tick() })
    expect(media.snsImgs[weak.md5]).toBeUndefined(); expect(api.apiGetSnsImageDataUrl).not.toHaveBeenCalled()
  })
})

// Actual-hook regressions for a running pool woken by a later IntersectionObserver event.
describe('dynamic enqueue and offline policy in the actual mounted hook', () => {
  it('starts later B before slow A completes using an idle slot', async () => {
    const releases: Array<(value: { url: string }) => void> = []
    api.apiGetSnsImageDataUrl.mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
    await render()
    media.mediaKeySpec.current.set('synthetic-later', { md5: 'synthetic-later', kind: 'img' })
    const enter = async (key: string) => {
      const el = document.createElement('div'); el.dataset.snsKey = key
      await act(async () => { observer([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver); await tick() })
    }
    await enter(weak.md5); expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(1)
    await enter('synthetic-later')
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(2)
    await act(async () => { releases[1]!({ url: strongUrl }); await tick() })
    expect(media.snsImgs['synthetic-later']).toBe(strongUrl)
    expect(media.snsImgs[weak.md5]).toBeUndefined()
    await act(async () => { releases[0]!({ url: weakUrl }); await tick() })
  })
})

describe('additional actual-hook offline dispatch boundaries', () => {
  it('an offline viewer consumer completes independently of the online pending', async () => {
    const online = deferred<{ url: string }>()
    api.apiGetSnsImageDataUrl.mockReturnValueOnce(online.promise).mockResolvedValueOnce({ url: weakUrl })
    await render()
    const a = media.resolveSnsOriginal(weak); await act(tick)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    await act(async () => { expect(await media.resolveSnsOriginal(weak)).toBe(weakUrl) })
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(2)
    expect(api.apiGetSnsImageDataUrl.mock.calls[1]?.[0]?.offline).toBe(true)
    await act(async () => { online.resolve({ url: strongUrl }); await a })
  })
  it('going offline while IDB is pending makes the later dispatch offline too', async () => {
    const s = resolver(), disk = deferred<string | null>(); api.snsMediaCacheGet.mockReturnValueOnce(disk.promise)
    const p = s.resolve(weak); await tick()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    disk.resolve(null); await p
    expect(api.apiGetSnsImageDataUrl.mock.calls[0]?.[0]?.offline).toBe(true)
  })
})


describe('bidirectional outer resolver policy isolation', () => {
  it('an online consumer does not inherit a pending offline-only failure or promise', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const s = resolver(), offline = deferred<{ url: string }>()
    api.apiGetSnsImageDataUrl.mockReturnValueOnce(offline.promise).mockResolvedValueOnce({ url: strongUrl })
    const a = s.resolve(weak); await tick()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    expect(await s.resolve(weak)).toBe(strongUrl)
    expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(2)
    expect(api.apiGetSnsImageDataUrl.mock.calls[0]?.[0]?.offline).toBe(true)
    expect(api.apiGetSnsImageDataUrl.mock.calls[1]?.[0]?.offline).toBe(false)
    offline.resolve({ url: weakUrl }); await a
  })
})


describe('policy tightened during IDB must not pin a recovered online consumer', () => {
  it('online -> pending IDB -> offline dispatch -> online creates a fresh online request', async () => {
    const s = resolver(), disk = deferred<string | null>(), offline = deferred<{ url: string }>()
    api.snsMediaCacheGet.mockReturnValueOnce(disk.promise)
    api.apiGetSnsImageDataUrl.mockReturnValueOnce(offline.promise).mockResolvedValueOnce({ url: strongUrl })
    const a = s.resolve(weak); await tick()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    disk.resolve(null); await tick(); expect(api.apiGetSnsImageDataUrl.mock.calls[0]?.[0]?.offline).toBe(true)
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    const b = s.resolve(weak); await tick()
    try {
      expect(api.apiGetSnsImageDataUrl).toHaveBeenCalledTimes(2)
      expect(api.apiGetSnsImageDataUrl.mock.calls[1]?.[0]?.offline).toBe(false)
      expect(await b).toBe(strongUrl)
    } finally { offline.resolve({ url: weakUrl }); await a }
  })
})
