/**
 * M8 复审的 M3：文章封面的**瞬时失败**不能被永久负缓存。
 *
 * 复审实测（副本里给 `fetch` 计数）：同一 URL 连续请求三次，`fetch()` 只被调用 **1** 次 ——
 * `coverCache` 把失败存成 `''`，而 `boundedSet` 只在容量满（300）时淘汰，于是这个链接
 * 「永久坏掉」，上层 `clearStaleResultCache()` 丢掉失败条目之后再调用也被内层拦住。
 *
 * 现在的折中是**短暂**负缓存（60s）：既不会把抖动变成永久坏掉，也不至于让永久 404 的链接
 * 按面板渲染节奏反复抓（每次 20s 超时）。这条用例把两个方向都锁住。
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
  it('60s 内不重复抓，过期后必须重新抓（既不永久坏掉、也不反复抓）', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wx-cover-'))
    scratch.push(cacheDir)
    // 唯一 URL：coverCache/coverFailUntil 都是模块级，避免与其它用例互相污染
    const url = 'https://mp.weixin.qq.com/s/m8-' + String(Date.now())
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls += 1
      return Promise.reject(new Error('net down'))
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'))

    const first = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(first.error).toBeTruthy()
    expect(calls).toBe(1)

    // 60s 内：直接用负缓存，不再抓（挡掉「永久 404 反复抓」）
    vi.setSystemTime(new Date('2026-09-14T00:00:30Z'))
    const second = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(second.error).toBeTruthy()
    expect(calls, '负缓存期内不该再抓').toBe(1)

    // 过期后：必须真的重试（否则一次抖动 = 永久坏掉）
    vi.setSystemTime(new Date('2026-09-14T00:01:01Z'))
    const third = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(third.error).toBeTruthy()
    expect(calls, '负缓存过期后必须重新抓').toBe(2)
  })
})
