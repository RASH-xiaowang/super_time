/**
 * M8 复审的 M3：文章封面的**瞬时失败**不能被负缓存。
 *
 * 复审实测（在副本里给 `fetch` 计数）：同一 URL 连续请求三次，`fetch()` 只被调用 **1** 次 ——
 * `coverCache` 把失败存成 `''`，而 `boundedSet` 只在容量满（300）时淘汰，于是这个链接
 * 「永久坏掉」，上层 `clearStaleResultCache()` 丢掉失败条目之后再调用也被内层拦住，
 * 不会重新抓。这条用例把这个反例锁住。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveArticleCoverDataUrl } from '../src/query/article-cover.ts'

const scratch: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

describe('文章封面：瞬时失败不落负缓存（M8/复审 M3）', () => {
  it('抓取失败后再次请求必须重新抓，而不是永久返回缓存里的失败', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wx-cover-'))
    scratch.push(cacheDir)
    // 用唯一 URL：coverCache 是模块级的，避免与其它用例/本用例之前的调用互相污染
    const url = 'https://mp.weixin.qq.com/s/m8-' + String(Date.now())
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls += 1
      return Promise.reject(new Error('net down'))
    })

    const first = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(first.error).toBeTruthy()
    expect(calls).toBe(1)

    const second = await resolveArticleCoverDataUrl(url, cacheDir)
    expect(second.error).toBeTruthy()
    expect(calls, '瞬时失败被负缓存了：第二次没有再抓').toBe(2)
  })
})
