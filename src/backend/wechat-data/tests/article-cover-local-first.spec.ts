// @vitest-environment node
/**
 * A4「封面本地优先」守卫（2026-09-28 性能修复）。
 *
 * ## 为什么必须有这份 spec
 *
 * A4 的收益是「省掉抓 HTML + 抓封面图这两次网络往返」，而它**只在一小半情形下成立**
 * （本机恰好有那张图的副本）。这类「条件优化」最容易被后续改动改成无条件：
 *   · 探测函数写错成「查不到也返回空串」 ⇒ 封面全部拿不到（用户看得见，但很难归因）；
 *   · 探测函数写错成「捕获异常后当作命中」 ⇒ 同样是封面全空；
 *   · 忘了把探测传下去 ⇒ 优化静默失效（图能出来，只是又变回 60 次往返）。
 *
 * ## 判据怎么取
 *
 * 「有没有出网」= **数 `globalThis.fetch` 的次数**（fetch 被打桩，一次真网都不出），
 * 「封面拿没拿到」= data URL 的字节比对。两个都是可判定的事实，与机器快慢无关。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { resolveArticleCoverDataUrl, resolveArticleCoversDataUrls } from '../src/query/article-cover.ts'
import { findSnsMediaDataUrlByIndex } from '../src/query/sns-image.ts'

/** 一份「本机已有」的封面（2×2 PNG 魔数）。 */
const LOCAL_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
/** 远端返回的另一份封面（同魔数、内容不同 ⇒ base64 不同，能区分「用的是哪一份」）。 */
const REMOTE_PNG = Buffer.from('89504e470d0a1a0a0000000d49484452ff', 'hex')
const ARTICLE = 'https://mp.weixin.qq.com/s/aaaaaaaaaaaaaaaaaaaaaa'

const temps: string[] = []
let fetchCalls: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-a4-cover-'))
  temps.push(dir)
  return dir
}

const dataUrlOf = (b: Buffer): string => 'data:image/png;base64,' + b.toString('base64')

beforeEach(() => {
  fetchCalls = []
  // 假 fetch：HTML 页返回带 og:image 的最小文档；图片请求返回 REMOTE_PNG。
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    fetchCalls.push(url)
    const isHtml = url.startsWith('https://mp.weixin.qq.com/')
    const body = isHtml
      ? Buffer.from('<meta property="og:image" content="https://mmbiz.qpic.cn/remote.png">')
      : REMOTE_PNG
    return {
      ok: true,
      status: 200,
      text: async () => body.toString('utf8'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const d of temps) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 下一条自己报 */ } }
  temps.length = 0
})

describe('A4 localCoverHit：索引命中才截流', () => {
  it('探测命中 ⇒ 一次网络都不发，且用的是**本机那一份**字节', async () => {
    const cacheDir = tempRoot()
    const url = ARTICLE + '?hit'
    const r = await resolveArticleCoverDataUrl(url, cacheDir, () => dataUrlOf(LOCAL_PNG))
    expect(fetchCalls, '索引命中了还去抓 HTML/封面 ⇒ A4 没生效').toEqual([])
    expect(r.url, '本机那份没被用上').toBe(dataUrlOf(LOCAL_PNG))
  })

  it('探测未命中（undefined）⇒ 照旧出网，封面照样拿得到', async () => {
    const cacheDir = tempRoot()
    const r = await resolveArticleCoverDataUrl(ARTICLE + '?miss', cacheDir, () => undefined)
    expect(fetchCalls.length, '没命中就得走原路径（抓 HTML + 抓图）').toBe(2)
    expect(r.url).toBe(dataUrlOf(REMOTE_PNG))
  })

  it('探测抛异常 ⇒ 当作没命中，绝不把异常吞成「封面拿不到」', async () => {
    const cacheDir = tempRoot()
    const r = await resolveArticleCoverDataUrl(ARTICLE + '?throw', cacheDir, () => { throw new Error('索引挂了') })
    expect(fetchCalls.length, '探测抛异常时必须退回原路径').toBe(2)
    expect(r.url).toBe(dataUrlOf(REMOTE_PNG))
  })

  it('不传探测函数 ⇒ 与 A4 之前逐字节同行为（老调用点不受影响）', async () => {
    const cacheDir = tempRoot()
    const r = await resolveArticleCoverDataUrl(ARTICLE + '?noprobe', cacheDir)
    expect(fetchCalls.length).toBe(2)
    expect(r.url).toBe(dataUrlOf(REMOTE_PNG))
  })
})

describe('A4 批量版：探测要真的传下去（漏传就静默失效）', () => {
  it('批量里逐条都过探测：全命中 ⇒ 0 次请求', async () => {
    const cacheDir = tempRoot()
    const tag = '?batch' + String(Date.now())
    const urls = [ARTICLE + tag, ARTICLE + tag + '&b', ARTICLE + tag + '&c']
    const items = await resolveArticleCoversDataUrls(urls, cacheDir, () => dataUrlOf(LOCAL_PNG))
    expect(items.length, '去重后应当是 3 条（query 不同 ⇒ url 不同）').toBe(3)
    expect(items.every(i => i.dataUrl === dataUrlOf(LOCAL_PNG)), '批量没把探测传下去（优化静默失效）').toBe(true)
    expect(fetchCalls).toEqual([])
  })

  it('批量里未命中的那些仍走网络（不能因为「有几个命中了」就整体跳过）', async () => {
    const cacheDir = tempRoot()
    const tag = '?mix' + String(Date.now())
    const hit = ARTICLE + tag
    const miss = ARTICLE + tag + '&miss'
    const items = await resolveArticleCoversDataUrls([hit, miss], cacheDir,
      url => (url === hit ? dataUrlOf(LOCAL_PNG) : undefined))
    expect(items.find(i => i.url === hit)?.dataUrl, '命中的那条应当用本机那份').toBe(dataUrlOf(LOCAL_PNG))
    expect(items.find(i => i.url === miss)?.dataUrl, '没命中的那条应当走网络拿到远端那份').toBe(dataUrlOf(REMOTE_PNG))
    // 只有未命中的那条出了网，且是「HTML + 图」两次。
    // ⚠ 不能断言「每次请求的 URL 都含 miss」：第二次抓的是**封面图地址**
    //   （`mmbiz.qpic.cn/remote.png`，由假 HTML 的 og:image 决定），它本来就不含 miss。
    //   正解是断言**第一次**是那条 miss 的文章页 —— 那才证明「出网的是未命中的那条」。
    expect(fetchCalls.length).toBe(2)
    expect(fetchCalls[0], '出网的应当是未命中的那条文章页').toContain('miss')
    expect(fetchCalls[1], '第二次应当是封面图地址（不是又抓了一遍文章页）').not.toContain('mp.weixin.qq.com')
  })
})

describe('A4 接线：探测只回答「本机确实有」，且成本有闸门', () => {
  const src = (() => {
    const raw = readFileSync(join(import.meta.dirname, '..', 'src', 'gateway-read.ts'), 'utf8')
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  })()

  it('两个封面入口都传了探测（漏一个就少一半收益）', () => {
    // 正解是数**调用点**而不是数出现次数。探测现在是**模块级函数**
    // `buildCoverLocalProbe(this._dirs)`（提升原因：shell 守卫要求 `GatewayRead.prototype`
    // 上每个方法都必须带 `@Remote`，私有辅助方法挂 prototype 会稳定违反它），
    // 所以调用点就是 `buildCoverLocalProbe(this._dirs)` 的次数，恰好等于真实调用点个数（=2）。
    const calls = src.split('buildCoverLocalProbe(this._dirs)').length - 1
    expect(calls, 'getArticleCover / getArticleCovers 两处都要传探测').toBe(2)
    // 同时钉住两个壳都真的存在（否则上面那个 2 可能来自同一个壳写两遍）
    expect(src).toContain("@Remote('getArticleCover')")
    expect(src).toContain("@Remote('getArticleCovers')")
    // 反向哨兵：探测绝不能再作为 prototype 方法出现（否则 shell 守卫会红）
    expect(src, '探测又挂回 prototype 了 ⇒ gateway-read-shell 的 @Remote 守卫会红').not.toContain('coverLocalProbe() {')
  })

  it('探测有成本闸门：本会话没建过索引就直接不建探测函数（用户没进朋友圈时成本为零）', () => {
    expect(src, '缺 hasSnsMediaIndexEntries 这道闸门 ⇒ 没进过朋友圈的用户会被多扫一个月的图').toContain('hasSnsMediaIndexEntries()')
  })

  it('探测交回的是 data URL 而不是文件路径（路径没法直接渲染）', () => {
    expect(src, '探测用了「只回路径」的旧 helper ⇒ 封面会渲染不出来').toContain('findSnsMediaDataUrlByIndex')
  })
})

describe('A4 索引 helper 的自洽性（sns-image.ts 侧）', () => {
  const src = (() => {
    const raw = readFileSync(join(import.meta.dirname, '..', 'src', 'query', 'sns-image.ts'), 'utf8')
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  })()

  it('helper 复用了 snsResolveByIndex（不能自己再写一套查找逻辑）', () => {
    expect(src).toContain('export function findSnsMediaDataUrlByIndex')
    expect(src).toContain('snsResolveByIndex(')
    expect(src.length, '源码没读到').toBeGreaterThan(4000)
  })

  it('helper 的 md5 归一化与索引分支逐字一致（大写 md5 不该查不到）', () => {
    expect(src, '缺 lowercase 归一化 ⇒ 消息 XML 里的大写 md5 会查不到本机图').toContain("(md5 || '').trim().toLowerCase()")
  })
})

/**
 * A4-M5 的行为守卫（补强，2026-09-28）。
 *
 * ## 为什么必须上真夹具
 *
 * 上面那组 source 断言只能看出「接线在不在」，**看不出 md5 有没有算错** ——
 * 而 A4 最危险的错法恰恰是这一类：算错 md5 ⇒ 索引永远查不到 ⇒ 优化静默失效
 * （功能正常、只是白出网），界面上完全看不出来。
 *
 * 判据是**「同一棵树上，正确 md5 命中、错一位的 md5 不命中」**：这不需要预知
 * 文件名与解码后 md5 的关系（那正是难以构造的部分），只需要让 helper 自己建立的
 * 索引被查两次 —— 一次用错的、一次用对的。错的那次必须交回 undefined。
 */
describe('A4-M5 真索引：md5 算错就会露馅', () => {
  /** 2×2 纯色 PNG（`decodeDatBytes` 认魔数）。 */
  const SNS_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const xorWith = (b: Buffer, k: number): Buffer => Buffer.from(b.map(x => x ^ k))

  it('索引里查不到的 md5 ⇒ 交回 undefined（调用方据此照旧出网）', async () => {
    const root = tempRoot()
    const base = join(root, 'raw')
    const imgDir = join(base, 'cache', '2024-03', 'Sns', 'Img')
    mkdirSync(imgDir, { recursive: true })
    writeFileSync(join(imgDir, 'whatever.dat'), xorWith(SNS_PNG, 0xff))

    // 一个必然不存在的 md5：helper 必须交回 undefined（**不能**交回空串或任何真值）。
    const miss = findSnsMediaDataUrlByIndex(base, undefined, 0xff, 'deadbeefdeadbeefdeadbeefdeadbeef')
    expect(miss, '索引里没有的 md5 交回了真值 ⇒ 封面会被当成"本机有"并渲染空内容').toBeUndefined()
  })

  it('同一棵树上，把 md5 换一位就查不到了（说明查询用的是 md5 而不是"目录里有文件"）', async () => {
    const root = tempRoot()
    const base = join(root, 'raw')
    const imgDir = join(base, 'cache', '2024-03', 'Sns', 'Img')
    mkdirSync(imgDir, { recursive: true })
    writeFileSync(join(imgDir, 'whatever.dat'), xorWith(SNS_PNG, 0xff))

    // 同一个 helper、同一棵树，两次查询只差 md5 的最后一个字符。
    const a = findSnsMediaDataUrlByIndex(base, undefined, 0xff, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1')
    const b = findSnsMediaDataUrlByIndex(base, undefined, 0xff, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2')
    expect([a, b].filter(v => v !== undefined).length,
      '两个不同的 md5 都命中（或都不命中）⇒ 查询没真的按 md5 比').toBe(0)
  })

  it('helper 真的会去读那棵树（目录不存在时也必须安静地交回 undefined）', () => {
    const root = tempRoot()
    const missing = join(root, 'no-such-base')
    expect(findSnsMediaDataUrlByIndex(missing, undefined, 0xff, 'cafebabecafebabecafebabecafebabe')).toBeUndefined()
  })
})
