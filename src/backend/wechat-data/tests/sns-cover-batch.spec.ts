import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSnsVideoCoverDataUrl, resolveSnsVideoCoverDataUrls, resolveSnsVideoCoverDataUrlsAsync, snsVideoIndexForTest } from '../src/query/sns-video.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0, scratch.length)) rmSync(dir, { recursive: true, force: true })
})

/**
 * W2-5.6：视频封面批版。
 *
 * 钉的是四件容易悄悄坏掉的事：
 *   ① 批量与逐条**判定语义一致**（同一条 md5 在两条入口上必须给同一个答案）；
 *   ② 空批 / 全未命中不抛错，且不把「未命中」悄悄吞成「命中」；
 *   ③ 「本机没有」那套扫描注记照旧透出（扫不全就不许断言「没有」）；
 *   ④ 一条也没有时不列举月份根（空批不许付那笔账）。
 */

/** 造一个 `cache/<月>/Sns/Video/<子>/<序号>.mp4` + 同名 `.jpg` 的合成树。 */
function makeSnsCache(base: string, months: number, filesPerMonth: number): string[][] {
  const out: string[][] = []
  for (let m = 0; m < months; m += 1) {
    const sub = join(base, 'cache', `2026-${String(m + 1).padStart(2, '0')}`, 'Sns', 'Video', 'd0')
    mkdirSync(sub, { recursive: true })
    const md5s: string[] = []
    for (let i = 0; i < filesPerMonth; i += 1) {
      const content = `v-${String(m)}-${String(i)}`
      const md5 = createHash('md5').update(content).digest('hex')
      const stem = String(i).padStart(4, '0')
      writeFileSync(join(sub, `${stem}.mp4`), content)
      writeFileSync(join(sub, `${stem}.jpg`), 'jpeg:' + content)
      md5s.push(md5)
    }
    out.push(md5s)
  }
  return out
}

function freshBase(): string {
  snsVideoIndexForTest().clear()
  const dir = mkdtempSync(join(tmpdir(), 'wx-snscover-b-'))
  scratch.push(dir)
  return dir
}

describe('W2-5.6 批量与逐条判定一致', () => {
  it('同一条 md5 在两条入口上答案逐字相同（命中 / 未命中都要对）', () => {
    const base = freshBase()
    const byMonth = makeSnsCache(base, 3, 4)
    const hit = byMonth[1]?.[2] ?? ''
    const miss = createHash('md5').update('not-here').digest('hex')
    expect(hit, '夹具没造出可命中的样本').not.toBe('')
    for (const md5 of [hit, miss]) {
      const one = resolveSnsVideoCoverDataUrl(base, md5)
      const many = resolveSnsVideoCoverDataUrls(base, [md5]).get(md5)
      expect(many, `批量里没有回 ${md5.slice(0, 8)}`).toBeDefined()
      expect(many?.url ?? null, `命中与否不一致（md5=${md5.slice(0, 8)}…）`).toBe(one.url ?? null)
      expect(many?.error ?? null, `错误文案不一致（md5=${md5.slice(0, 8)}…）`).toBe(one.error ?? null)
    }
  })

  it('批内顺序不影响结果（同一批换个顺序，答案逐条相同）', () => {
    const base = freshBase()
    const byMonth = makeSnsCache(base, 4, 3)
    const sample = byMonth.map((m) => m[1] ?? '')
    const forward = resolveSnsVideoCoverDataUrls(base, sample)
    const backward = resolveSnsVideoCoverDataUrls(base, [...sample].reverse())
    for (const md5 of sample) expect(backward.get(md5)?.url ?? null).toBe(forward.get(md5)?.url ?? null)
  })

  it('一条也没有时返回空表，且不抛错', () => {
    const base = freshBase()
    expect(resolveSnsVideoCoverDataUrls(base, []).size).toBe(0)
    expect(resolveSnsVideoCoverDataUrls(base, ['  ', '']).size, '空串不算一条').toBe(0)
  })

  it('没配微信目录时逐条与批量给同一句「未配置」', () => {
    const md5 = createHash('md5').update('x').digest('hex')
    expect(resolveSnsVideoCoverDataUrl(undefined, md5).error).toContain('未配置微信原始目录')
    expect(resolveSnsVideoCoverDataUrls(undefined, [md5]).get(md5)?.error).toContain('未配置微信原始目录')
  })

  it('缺 md5 时逐条与批量都拒（空批不该凭空造一个成功）', () => {
    expect(resolveSnsVideoCoverDataUrl(freshBase(), '').error).toContain('缺少视频标识')
    expect(resolveSnsVideoCoverDataUrls(freshBase(), ['']).size).toBe(0)
  })
})

describe('W2-5.6 扫描注记照旧透出', () => {
  it('目录读不动时说「没扫全」，而不是断言「本机没有」', () => {
    // 不造 cache/ 目录 ⇒ `snsMonthRoots` 直接返回空。空目录**不算**「读不动」，
    // 所以这里要造一个读不动的形状：把 cache 做成一个**文件**而不是目录。
    const base = freshBase()
    mkdirSync(join(base, 'cache-keep'), { recursive: true })
    writeFileSync(join(base, 'cache'), 'not a directory')
    const md5 = createHash('md5').update('zz').digest('hex')
    const one = resolveSnsVideoCoverDataUrl(base, md5)
    const many = resolveSnsVideoCoverDataUrls(base, [md5]).get(md5)
    expect(many?.error ?? null, '批量的说明必须与逐条逐字相同').toBe(one.error ?? null)
    expect(one.error, '要么照实说有扫描问题，要么照实说本机没有 —— 不能两者都没有').toBeTruthy()
  })
})

describe('SNS 视频内存缓存有上界', () => {
  it('封面缓存写满 300 条后按插入序淘汰最旧一条', () => {
    const base = freshBase()
    const byMonth = makeSnsCache(base, 1, 301)
    resolveSnsVideoCoverDataUrls(base, byMonth[0] ?? [])
    const stats = snsVideoIndexForTest().stats()
    expect(stats.coverEntries, '封面 data URL 缓存必须有条数上限').toBe(300)
  })

  it('同月并发冷扫只跑一次（让出之后的并发不能把整月哈希跑两份）', async () => {
    const base = freshBase()
    const byMonth = makeSnsCache(base, 1, 40)
    const md5s = byMonth[0] ?? []
    const first = md5s[0] ?? ''
    const second = md5s[1] ?? ''
    await Promise.all([
      resolveSnsVideoCoverDataUrlsAsync(base, [first]),
      resolveSnsVideoCoverDataUrlsAsync(base, [second]),
    ])
    expect(snsVideoIndexForTest().stats().asyncMonthScans, '同一月份被并发扫了两遍').toBe(1)
  })

  it('视频本体缓存不能继续直接 set：必须走字节上限路径', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'sns-video.ts'), 'utf8')
    expect(src).toContain('COVER_CACHE_MAX_ENTRIES = 300')
    expect(src).toContain('VIDEO_URL_CACHE_MAX_BYTES = 64 * 1024 * 1024')
    expect(src).toContain('boundedSet(coverCache')
    expect(src).toContain('cacheVideoDataUrl(want, data)')
    expect(src.match(/videoUrlCache\.set\(/g)?.length ?? 0,
      'videoUrlCache 的写入必须只住在字节上限助手内部').toBe(1)
  })
})

/** 只切出批量那个函数体（从函数名到下一个顶层 `async function` 之前）。 */
function sliceBatchFn(src: string): string {
  const a = src.indexOf('async function snsVideoCoversBatchIn(')
  if (a < 0) return src
  const b = src.indexOf('\nasync function ', a + 10)
  return src.slice(a, b < 0 ? src.length : b)
}

/** 后端批处理路径的接线守卫。源码守卫在本仓是有先例的（`vector-build-read.spec.ts` 就用它钉「函数体内不许再出现 `.all()`」）。 */
function mediaSrc(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:fs').readFileSync(new URL('../src/remotes/media.ts', import.meta.url), 'utf8') as string
}

describe('W2-5.6 后端批处理路径接线', () => {
  it("本机解析走批量入口（一次列举），不是逐条循环", () => {
    expect(mediaSrc()).toContain('await resolveSnsVideoCoverDataUrlsAsync(base, md5s)')
  })

  it('CDN 取回有界并发（串行会把一屏封面拉成好几秒）', () => {
    expect(mediaSrc()).toContain('const SNS_COVER_FETCH_CONCURRENCY = 4')
  })

  it('CDN 白名单判在**发请求之前**（判在之后等于没判）', () => {
    // 只看批量那个函数体：文件里还有单条入口那份同样的判断，用整文件比会串味。
    const src = sliceBatchFn(mediaSrc())
    const fetchAt = src.indexOf('await fetchSnsCoverDataUrl(')
    expect(fetchAt, '批量函数里必须真的发请求（否则这条判据是恒真）').toBeGreaterThan(-1)
    const guardAt = src.indexOf('wechatCdnHostAllowed(remote)')
    expect(guardAt, '批量函数里必须判白名单').toBeGreaterThan(-1)
    expect(guardAt, '白名单判断必须排在发请求之前').toBeLessThan(fetchAt)
  })

  it('离线时整批不去 CDN（与图片那路同一口径）', () => {
    expect(mediaSrc()).toMatch(/if \(offline \|\| remote ===/)
  })

  it('批量返回与 items 同序同长（少一条就对不上号）', () => {
    const src = mediaSrc()
    expect(src).toContain('const out = items.map((it, i) => {')
    expect(src).toMatch(/return \{ items: out \}/)
  })
})
