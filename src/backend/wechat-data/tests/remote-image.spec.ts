/**
 * M23 第一刀：远程图片代理 + 「哪些主机可以被后端代取」的唯一判据。
 *
 * 这里钉住的是**行为**，不是源码里出现过某个函数名：
 *   · 关掉「自动获取原图（CDN）」⇒ 一次 `fetch` 都不许发（本机缓存除外）；
 *   · 主机不在微信 CDN 清单 ⇒ 也是在**发请求之前**被拒（`evilqq.com` 这类前缀伪装必须拦得住）；
 *   · 取回的东西落盘 ⇒ 第二次渲染不再联网；
 *   · 批量入口去重、限单次数量、限并发（CDN 对突发并发回 400）。
 * 判据全部走打桩的 `globalThis.fetch` 计数 —— 与 `cdn-switch.spec.ts` 同一套做法：
 * 「断言源码里有 `cdnFetchAllowed(`」骗不过一次漏改，调用次数能。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wechatCdnHostAllowed } from '../src/query/cdn-hosts.ts'
import { fetchRemoteImage, fetchRemoteImages, REMOTE_IMAGE_CACHE_DIRNAME } from '../src/query/remote-image.ts'
import { CDN_DISABLED_MESSAGE } from '../src/query/cdn-policy.ts'

/**
 * 每次运行都换一个地址。
 *
 * 失败冷却表（`failUntil`）是模块级的，而 `beforeEach` 换的是临时目录 —— 若各用例共用同一个
 * URL，前面那条「HTTP 403」就会把后面所有用例打进 60 秒冷却，报出「刚才取失败过」这种与
 * 被测行为无关的错。地址按用例递增，才是各自独立的前提。
 */
let urlSeq = 0
let OK_URL = ''
/** 最小可识别 PNG 头（`detectImageFormat` 只看前几个字节）。 */
function pngBytes(extra = 0): Uint8Array {
  const b = new Uint8Array(24 + extra)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return b
}

let root = ''
const savedFetch = globalThis.fetch
let calls: string[] = []
let inflight = 0
let maxInflight = 0
let respond: (url: string) => { ok: boolean; status: number; bytes: Uint8Array } = () => ({ ok: true, status: 200, bytes: pngBytes() })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'st-remote-image-'))
  urlSeq += 1
  OK_URL = `https://mmbiz.qpic.cn/mmbiz_jpg/case-${String(urlSeq)}/0`
  calls = []
  inflight = 0
  maxInflight = 0
  respond = () => ({ ok: true, status: 200, bytes: pngBytes() })
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    inflight += 1
    maxInflight = Math.max(maxInflight, inflight)
    const r = respond(url)
    await Promise.resolve()
    inflight -= 1
    return {
      ok: r.ok,
      status: r.status,
      arrayBuffer: async () => r.bytes.buffer,
    }
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
  rmSync(root, { recursive: true, force: true })
})

/** 缓存文件路径：与实现同口径（md5(url) + 嗅到的扩展名），但不复用实现里的拼接。 */
function cachedFile(url: string, fmt = 'png'): string {
  return join(root, REMOTE_IMAGE_CACHE_DIRNAME, `${createHash('md5').update(url, 'utf8').digest('hex')}.${fmt}`)
}

describe('cdn-hosts：主机白名单的判据', () => {
  it('微信系主机放行；前缀伪装与站外一律拒绝', () => {
    for (const ok of ['https://mmbiz.qpic.cn/a', 'https://p.qpic.cn/x', 'https://wx.qq.com/y',
      'https://mmweb.wechat.com/z', 'https://weixin.qq.com/w', 'https://www.qq.com/v']) {
      expect(wechatCdnHostAllowed(ok), ok).toBe(true)
    }
    for (const bad of ['https://evilqq.com/a', 'https://notqpic.cn/x', 'https://qq.com.evil.io/y',
      'https://example.com/z', 'not a url', 'https:///x', '']) {
      expect(wechatCdnHostAllowed(bad), bad).toBe(false)
    }
  })

  it('带凭据的 URL 一律拒绝（不该由我们的后端带着出门）', () => {
    expect(wechatCdnHostAllowed('https://user:pass@mmbiz.qpic.cn/a')).toBe(false)
  })
})

describe('远程图片代理：发不发请求', () => {
  it('取回成功 → data URL + 落盘，第二次渲染不再联网', async () => {
    const first = await fetchRemoteImage(OK_URL, root, {})
    expect(first.dataUrl, first.error).toMatch(/^data:image\/png;base64,/)
    expect(first.fromCache).toBe(false)
    expect(calls).toEqual([OK_URL])
    expect(existsSync(cachedFile(OK_URL))).toBe(true)

    const second = await fetchRemoteImage(OK_URL, root, {})
    expect(second.fromCache).toBe(true)
    expect(second.dataUrl).toBe(first.dataUrl)
    expect(calls.length, '第二次不该再发请求').toBe(1)
  })

  it('关掉「自动获取原图（CDN）」→ 一次请求都不发，但本机缓存照常返回', async () => {
    const off = await fetchRemoteImage(OK_URL, root, { cdnEnabled: false })
    expect(off.dataUrl).toBeUndefined()
    expect(off.error).toBe(CDN_DISABLED_MESSAGE)
    expect(calls).toEqual([])
    // 同一条地址在开关开着时取回过 → 关掉之后仍然能显示（缓存优先于开关）
    await fetchRemoteImage(OK_URL, root, {})
    const cached = await fetchRemoteImage(OK_URL, root, { cdnEnabled: false })
    expect(cached.fromCache).toBe(true)
    expect(calls.length, '缓存命中不该发请求').toBe(1)
  })

  it('主机不在清单内 → 拦在发请求之前，错误点名白名单', async () => {
    for (const url of ['https://evilqq.com/a.png', 'https://example.com/cover.png']) {
      const r = await fetchRemoteImage(url, root, {})
      expect(r.dataUrl, url).toBeUndefined()
      expect(r.error, url).toContain('微信 CDN 清单')
    }
    expect(calls, '被白名单拦下时不许有任何请求').toEqual([])
  })

  it('非 https 形状（http: / file: / 协议相对 / blob:）一律拒绝且不发请求', async () => {
    for (const url of ['http://mmbiz.qpic.cn/a', 'file:///C:/x/y.png', 'blob:https://mmbiz.qpic.cn/x', '//mmbiz.qpic.cn/a']) {
      const r = await fetchRemoteImage(url, root, {})
      expect(r.dataUrl, url).toBeUndefined()
      expect(r.error, url).toContain('https')
    }
    expect(calls).toEqual([])
  })

  it('取回的不是可渲染图片 → 不落盘、回错误，并说明是什么格式', async () => {
    respond = () => ({ ok: true, status: 200, bytes: new TextEncoder().encode('<html>不是图</html>') })
    const r = await fetchRemoteImage(OK_URL, root, {})
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('不是可渲染的图片格式')
    expect(existsSync(cachedFile(OK_URL))).toBe(false)
  })

  it('HTTP 失败与空响应都要给出可读原因，且不落盘', async () => {
    respond = () => ({ ok: false, status: 403, bytes: new Uint8Array(0) })
    const denied = await fetchRemoteImage(OK_URL, root, {})
    expect(denied.error).toContain('403')
    respond = () => ({ ok: true, status: 200, bytes: new Uint8Array(0) })
    const empty = await fetchRemoteImage(`${OK_URL}-empty`, root, {})
    expect(empty.error).toContain('空文件')
    expect(existsSync(join(root, REMOTE_IMAGE_CACHE_DIRNAME))).toBe(false)
  })

  it('超过 8MB 的响应直接丢弃（渲染层扛不住，也不该占盘）', async () => {
    respond = () => ({ ok: true, status: 200, bytes: pngBytes(8 * 1024 * 1024) })
    const r = await fetchRemoteImage(OK_URL, root, {})
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('8MB')
  })

  it('刚才失败过的地址有 60 秒冷却：不再反复敲 CDN，但也不会永久坏掉', async () => {
    const url = 'https://p.qpic.cn/cooldown/1'
    respond = () => ({ ok: false, status: 503, bytes: new Uint8Array(0) })
    expect((await fetchRemoteImage(url, root, {})).error).toContain('503')
    const afterFirst = calls.length
    expect(afterFirst, '失败应当重试过（`fetchWithRetry` 的口径）').toBeGreaterThan(1)
    const cooled = await fetchRemoteImage(url, root, {})
    expect(cooled.error).toContain('稍后会自动重试')
    expect(calls.length, '冷却期内一次都不许再发').toBe(afterFirst)
    // 另一个地址不受影响（冷却是按 URL 记的，不是一把全局闸）
    await fetchRemoteImage('https://p.qpic.cn/cooldown/2', root, {})
    expect(calls.length).toBeGreaterThan(afterFirst)
  })
})

describe('远程图片代理：批量入口', () => {
  it('去重、跳过空串，并按原地址回键', async () => {
    const a = 'https://p.qpic.cn/batch-dedupe/a'
    const b = 'https://p.qpic.cn/batch-dedupe/b'
    const items = await fetchRemoteImages([a, `  ${a}  `, '', b], root, {})
    expect(items.map((i) => i.url).sort()).toEqual([a, b].sort())
    expect(items.every((i) => i.dataUrl !== undefined)).toBe(true)
    expect(calls.length).toBe(2)
  })

  it('单次上限之外的条目回错误，不发请求', async () => {
    const urls = Array.from({ length: 45 }, (_, i) => `https://p.qpic.cn/cap/${String(i)}`)
    const items = await fetchRemoteImages(urls, root, {})
    expect(items.length).toBe(45)
    expect(items.filter((i) => i.error?.includes('分批'))).toHaveLength(5)
    expect(calls.length).toBe(40)
  })

  it('并发不超过 6（CDN 对突发并发回 400）', async () => {
    const urls = Array.from({ length: 18 }, (_, i) => `https://p.qpic.cn/conc/${String(i)}`)
    const items = await fetchRemoteImages(urls, root, {})
    expect(items.every((i) => i.dataUrl !== undefined)).toBe(true)
    expect(maxInflight).toBeLessThanOrEqual(6)
    expect(maxInflight, '并发度为 1 说明实现退化成串行，也要报出来').toBeGreaterThan(1)
  })
})

describe('M23：白名单判在发请求之前（两处既有的 SNS 取回入口）', () => {
  /** 读 `remotes/media.ts`，剥掉注释后按处理函数体比对顺序 —— 注释里写一遍骗不过它。 */
  const src = readFileSync(join(__dirname, '..', 'src', 'remotes', 'media.ts'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')

  for (const [handler, fetchFn] of [
    ['getSnsVideoCoverDataUrl', 'fetchSnsCoverDataUrl'],
    ['getSnsVideoDataUrl', 'fetchSnsVideoDataUrl'],
  ] as const) {
    it(`${handler} 在白名单判过之后才去取`, () => {
      const start = src.indexOf(`${handler}(options`)
      expect(start, `找不到 ${handler} 的处理函数`).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n    },', start))
      const guard = body.indexOf('wechatCdnHostAllowed(')
      const taken = body.indexOf(`${fetchFn}(`)
      expect(guard, `${handler} 没有判主机白名单`).toBeGreaterThan(-1)
      expect(taken, `${handler} 里没有取回调用，前提不成立`).toBeGreaterThan(-1)
      expect(guard, `${handler}：白名单必须判在发请求之前`).toBeLessThan(taken)
    })
  }
})
