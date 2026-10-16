// @vitest-environment node
/**
 * 公众号封面出网域名闸门（2026-10-15 补上）。
 *
 * 判据是「打桩后的 `fetch` 有没有被调用」，而不是源码里有没有某个函数名：
 * 文章页域名收窄为 mp.weixin.qq.com，`og:image` 提出来之后还要过 CDN 白名单，
 * 任何一站外地址都必须被拦在第一次发请求之前。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wechatArticleUrlAllowed } from '../src/query/cdn-hosts.ts'
import { resolveArticleCoverDataUrl } from '../src/query/article-cover.ts'

const scratch: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wx-cover-host-'))
  scratch.push(dir)
  return dir
}

/** 每次运行都换一条地址，避免模块级 coverCache / coverFailUntil 相互污染。 */
const freshArticle = (host = 'mp.weixin.qq.com', scheme = 'https'): string =>
  `${scheme}://${host}/s/host-gate-${String(Date.now())}-${String(Math.random()).slice(2)}`

const html = (cover: string): string =>
  `<html><head><meta property="og:image" content="${cover}"></head></html>`

const tinyPng = (): Uint8Array => {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

describe('wechatArticleUrlAllowed：文章页域名判据', () => {
  it('放行 http(s) 的 mp.weixin.qq.com，拒绝伪装后缀、站外、凭据与非 http(s)', () => {
    expect(wechatArticleUrlAllowed('https://mp.weixin.qq.com/s/x')).toBe(true)
    expect(wechatArticleUrlAllowed('http://mp.weixin.qq.com/s/x')).toBe(true)
    expect(wechatArticleUrlAllowed('https://a.mp.weixin.qq.com/s/x')).toBe(true)
    expect(wechatArticleUrlAllowed('https://mp.weixin.qq.com.evil.com/s/x')).toBe(false)
    expect(wechatArticleUrlAllowed('https://evil.com/s/x')).toBe(false)
    expect(wechatArticleUrlAllowed('https://user:pass@mp.weixin.qq.com/s/x')).toBe(false)
    expect(wechatArticleUrlAllowed('file://mp.weixin.qq.com/s/x')).toBe(false)
    expect(wechatArticleUrlAllowed('')).toBe(false)
  })
})

describe('resolveArticleCoverDataUrl：文章页地址闸门', () => {
  it('站外文章地址被拦在发请求之前，且错误里点名主机', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(html('https://mmbiz.qpic.cn/x.png'), { status: 200 })
    }))
    const r = await resolveArticleCoverDataUrl(freshArticle('evil.com'), tempDir())
    expect(r.error).toContain('微信白名单')
    expect(r.error).toContain('evil.com')
    expect(calls).toEqual([])
  })

  it('mp.weixin.qq.com.evil.com 这类后缀伪装同样拒绝且不出网', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(html('https://mmbiz.qpic.cn/x.png'), { status: 200 })
    }))
    const r = await resolveArticleCoverDataUrl(freshArticle('mp.weixin.qq.com.evil.com'), tempDir())
    expect(r.error).toContain('微信白名单')
    expect(calls).toEqual([])
  })

  it('带凭据或 file: 形状的文章地址拒绝且不出网', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(html('https://mmbiz.qpic.cn/x.png'), { status: 200 })
    }))
    for (const url of [
      `https://user:pass@mp.weixin.qq.com/s/gate-${String(Date.now())}`,
      `file://mp.weixin.qq.com/s/gate-${String(Date.now())}`,
    ]) {
      const r = await resolveArticleCoverDataUrl(url, tempDir())
      expect(r.error, url).toContain('微信白名单')
    }
    expect(calls).toEqual([])
  })

  it('http 文章地址被升级为 https 后才发出', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      return url.startsWith('https://mp.weixin.qq.com/')
        ? new Response(html('https://mmbiz.qpic.cn/x.png'), { status: 200 })
        : new Response(tinyPng(), { status: 200 })
    }))
    const r = await resolveArticleCoverDataUrl(freshArticle('mp.weixin.qq.com', 'http'), tempDir())
    expect(r.url, r.error).toBeTruthy()
    expect(calls[0]).toMatch(/^https:\/\/mp\.weixin\.qq\.com\//)
  })
})

describe('resolveArticleCoverDataUrl：og:image 地址闸门', () => {
  it('站外封面只允许抓文章页，不允许再抓站外图', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(html('https://evil.com/cover.png'), { status: 200 })
    }))
    const r = await resolveArticleCoverDataUrl(freshArticle(), tempDir())
    expect(r.error).toContain('微信 CDN 清单')
    expect(r.error).toContain('evil.com')
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('mp.weixin.qq.com')
  })

  it('qq.com.evil.io 这类后缀伪装封面地址拒绝且不抓图', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(html('https://qq.com.evil.io/cover.png'), { status: 200 })
    }))
    const r = await resolveArticleCoverDataUrl(freshArticle(), tempDir())
    expect(r.error).toContain('微信 CDN 清单')
    expect(calls.length).toBe(1)
  })

  it('协议相对与不带协议的白名单封面地址都能归一成 https 并取回', async () => {
    for (const cover of ['//mmbiz.qpic.cn/relative.png', 'mmbiz.qpic.cn/bare.png']) {
      const calls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
        const url = String(input)
        calls.push(url)
        return url.startsWith('https://mp.weixin.qq.com/')
          ? new Response(html(cover), { status: 200 })
          : new Response(tinyPng(), { status: 200 })
      }))
      const r = await resolveArticleCoverDataUrl(freshArticle(), tempDir())
      expect(r.url, r.error).toBeTruthy()
      expect(calls[1], cover).toMatch(/^https:\/\/mmbiz\.qpic\.cn\//)
    }
  })

  it('非 https 形状（blob:）的封面地址拒绝且不抓图', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(html('blob:https://mmbiz.qpic.cn/x.png'), { status: 200 })
    }))
    const r = await resolveArticleCoverDataUrl(freshArticle(), tempDir())
    expect(r.error).toContain('微信 CDN 清单')
    expect(calls.length).toBe(1)
  })
})
