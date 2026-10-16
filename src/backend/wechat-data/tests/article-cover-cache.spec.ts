/**
 * M8 复审的 M3：文章封面的**瞬时失败**不能被永久负缓存。
 *
 * 复审实测（副本里给 `fetch` 计数）：同一 URL 连续请求三次，`fetch()` 只被调用 **1** 次 ——
 * `coverCache` 把失败存成 `''`，而 `boundedSet` 只在容量满（300）时淘汰，于是这个链接
 * 「永久坏掉」，上层 `clearStaleResultCache()` 丢掉失败条目之后再调用也被内层拦住。
 *
 * 现在的折中是**短暂**负缓存（60s）：既不会把抖动变成永久坏掉，也不至于让永久 404 的链接
 * 按面板渲染节奏反复抓（每次 20s 超时）。这条用例把两个方向都锁住。
 *
 * N13 之后计数变了：抓取走 `fetchWithRetry`，一次「net down」会重试到 3 次才放弃
 * （这正是「一次抖动不再等于永久坏掉」的那半）。所以下面断言的是**每轮 3 次**，
 * 而且只假 `Date`（负缓存要控时）——退避的 `setTimeout` 必须是真时钟，
 * 否则重试的等待永远不会到期（用例会挂住）。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveArticleCoverDataUrl } from '../src/query/article-cover.ts'

const scratch: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

describe('文章封面：瞬时失败用短暂负缓存（M8/复审 M3）', () => {
  /**
   * ⚠️ 断言已按 2026-09-28 的性能修复**放宽到 5 分钟**（原为 60 秒）。
   *
   * 反转理由：60s 太短 —— 朋友圈一屏 30 篇里有几篇是**永久 404 / 已删除**的，面板每次重渲染
   * （滚动、切回、虚拟化重挂载）都会再把它们抓一遍，每篇 20s 超时。这条用例的**语义没变**
   * （「期内不重抓、过期必须重抓、不永久坏掉」），只是把「期」的长度跟着实现一起改。
   * 反转后仍然双向咬得住：把 TTL 改回 60s ⇒ 第 3 段会抓到 6 次而非 3 次（红）；
   * 改成永久负缓存 ⇒ 第 3 段仍是 3 次（红）。
   */
  it('负缓存期内不重复抓，过期后必须重新抓（既不永久坏掉、也不反复抓）', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wx-cover-'))
    scratch.push(cacheDir)
    // 唯一 URL：coverCache/coverFailUntil 都是模块级，避免与其它用例互相污染
    const url = 'https://mp.weixin.qq.com/s/m8-' + String(Date.now())
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls += 1
      return Promise.reject(new Error('net down'))
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'))

    const first = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(first.error).toBeTruthy()
    expect(calls, 'N13：一次抓取失败会重试到 3 次才放弃').toBe(3)

    // 负缓存期内：直接用负缓存，不再抓（挡掉「永久 404 反复抓」）
    vi.setSystemTime(new Date('2026-09-14T00:00:30Z'))
    const second = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(second.error).toBeTruthy()
    expect(calls, '负缓存期内不该再抓').toBe(3)

    // 逼近期尾（5min 内仍算期内）：还是不许抓
    vi.setSystemTime(new Date('2026-09-14T00:04:59Z'))
    const near = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(near.error).toBeTruthy()
    expect(calls, '5 分钟内的任何一刻都不该重抓').toBe(3)

    // 过期后：必须真的重试（否则一次抖动 = 永久坏掉）
    vi.setSystemTime(new Date('2026-09-14T00:05:01Z'))
    const third = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(third.error).toBeTruthy()
    expect(calls, '负缓存过期后必须重新抓').toBe(6)
  })
})

describe('文章封面：同一条链接**正在抓**时，后来者共享同一次抓取（2026-09-29）', () => {
  /**
   * 为什么需要：`coverCache` 只在**抓完之后**才写。用户快速翻页、或两个面板同时要同一批封面时，
   * 同一条链接会被并发抓两遍（每遍 2 次网络往返）。这条用例用 `fetch` 计数把它钉住：
   * 合并之前是 4 次，合并之后必须是 2 次（HTML + 图各一次）。
   */
  it('并发两次调用只出一轮网络请求，且两边都拿到封面', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wx-cover-dedupe-'))
    scratch.push(cacheDir)
    // 唯一 URL：`coverCache` / `coverFailUntil` / 在途表都是模块级，避免与其它用例互相污染
    const url = 'https://mp.weixin.qq.com/s/dedupe-' + String(Date.now())
    let calls = 0
    vi.stubGlobal('fetch', async (input: unknown) => {
      calls += 1
      const u = String(input)
      if (u.includes('mmbiz.qpic.cn')) {
        // 最小可嗅探的 JPEG 头（只要够 16 字节、魔数对，`sniffImageFormat` 就认）
        const bytes = new Uint8Array(32)
        bytes.set([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01])
        return new Response(bytes, { status: 200 })
      }
      return new Response(
        '<html><head><meta property="og:image" content="https://mmbiz.qpic.cn/dedupe.jpg"></head></html>',
        { status: 200 },
      )
    })

    const [a, b] = await Promise.all([
      resolveArticleCoverDataUrl(url, cacheDir),
      resolveArticleCoverDataUrl(url, cacheDir),
    ])
    expect(a.url, '第一个调用者应当拿到封面').toBeTruthy()
    expect(b.url, '共享同一次抓取的第二个调用者也应当拿到').toBeTruthy()
    expect(calls, '并发两次只该出一轮：HTML 一次 + 图一次').toBe(2)
  })
})
