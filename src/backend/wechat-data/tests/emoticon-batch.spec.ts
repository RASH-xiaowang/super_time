// @vitest-environment node
/**
 * E1「批量取表情」守卫（2026-09-28 性能修复）。
 *
 * ## 为什么必须有这份 spec
 *
 * 现场日志里 `getEmoticonDataUrl` 13 次、**均 27,253ms、峰值 71,909ms**。批量化的收益
 * 全部来自身兼两职的一条设计：**先纯本地全过一遍，再只对剩下的并发出网**。
 * 这条设计最容易被后续改动悄悄破坏，而破坏了**界面上看不出来**（图还是慢慢出来，
 * 只是又变回 N 个网络往返）：
 *   · 把两趟合成一趟 for 循环「逐条走完整链」 ⇒ 功能完全正确，开销回到 27s 量级；
 *   · 本地命中的也塞进 needRemote ⇒ 白出一趟网，还可能被 CDN 限流；
 *   · 分号去重丢了 ⇒ 同一张表情在屏上出现三次就查三次。
 *
 * ## 判据怎么取
 *
 * 不用计时（CI 机器慢 20 倍就废），而是**数 `globalThis.fetch` 的调用次数**：
 * 「本地全命中 ⇒ 0 次请求」「2 条待远端 ⇒ 2 次请求」。这是可判定的事实，
 * 与机器快慢、网络环境都无关（fetch 被打桩成确定性的假实现，一次真网都不出）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { forgetEmoticonIndex } from '../src/query/media-image.ts'

/** 2×2 PNG 魔数（`decodeDatBytes` 认它）。 */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const xorWith = (bytes: Buffer, key: number): Buffer => Buffer.from(bytes.map(b => b ^ key))
const M1 = '11111111111111111111111111111111'
const M2 = '22222222222222222222222222222222'
const M3 = '33333333333333333333333333333333'
/** `msg/attach/<hash>/<月>/Img/` —— 表情的真实布局（深度 3，索引必须下探到这一层）。 */
const ATTACH_HASH = 'dddddddddddddddddddddddddddddddd'
const ATTACH_MONTH = '2024-03'

let scratch = ''
let decrypted = ''
let decoded = ''
let base = ''
let disposers: Array<() => void> = []
let fetchCalls: string[] = []

/** 与 `gateway-image-batch.spec.ts` 同款的最小 Cordis Context 面。 */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

/**
 * 造最小夹具：`decrypted` 目录 + `base/msg/attach/...` 里的表情 `.dat`。
 *
 * 为什么不塞 `hardlink.db`：表情链**不走** hardlink 表 —— md5 由消息 XML 直接给出，
 * 路径靠扫 `msg/attach` 找（这正是 E2 索引扫描的那棵树）。所以这里只造目录树就够。
 * @param files - 文件名 → 字节（名字形如 `<md5>.dat` / `<md5>_t.dat`）。
 */
function setup(files: Record<string, Buffer>): void {
  scratch = mkdtempSync(join(tmpdir(), 'wx-emoticon-batch-'))
  decrypted = join(scratch, 'decrypted')
  decoded = join(scratch, 'decoded')
  base = join(scratch, 'wechat-base')
  const imgDir = join(base, 'msg', 'attach', ATTACH_HASH, ATTACH_MONTH, 'Img')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
  mkdirSync(imgDir, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(imgDir, name), bytes)
}

function gatewayFor(): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  vi.stubEnv('DSH_WECHAT_BASE_DIR', base)
  return new WechatDataGateway(fakeCtx())
}

/** 假 fetch：任何请求返回一份 PNG，并记下 URL（一次真网都不出）。 */
function stubFetch(reply: { ok: boolean; status: number; bytes?: Buffer }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    fetchCalls.push(String(input))
    const body = reply.bytes ?? PNG
    return {
      ok: reply.ok,
      status: reply.status,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response
  }))
}

beforeEach(() => {
  disposers = []
  fetchCalls = []
  stubFetch({ ok: true, status: 200 })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const d of disposers) d()
  disposers = []
  // E2 索引 / E3 负缓存是**跨调用共享的模块级状态**，不清会串味到别的文件。
  forgetEmoticonIndex()
  if (scratch) { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* 下一条自己报 */ } }
  scratch = ''
})

describe('E1 getEmoticonDataUrls：两趟设计', () => {
  it('本地全命中 ⇒ 一次网络都不发（这是批量化的全部意义）', async () => {
    setup({
      [M1 + '.dat']: xorWith(PNG, 0xff),
      [M2 + '.dat']: xorWith(PNG, 0xff),
    })
    const gw = gatewayFor()
    const r = await gw.getEmoticonDataUrls({
      items: [{ md5: M1, emojiUrl: 'https://mmbiz.qpic.cn/a.gif' }, { md5: M2, emojiUrl: 'https://mmbiz.qpic.cn/b.gif' }],
    })
    expect(r.items.map(i => i.md5)).toEqual([M1, M2])
    expect(r.items.every(i => typeof i.dataUrl === 'string'), '本地有图却没解出来').toBe(true)
    expect(fetchCalls, '本地全命中还发了请求 ⇒ 两趟设计被合成一趟了').toEqual([])
  })

  it('本地没有 + 有远端链接 ⇒ 才出网；每条一个往返，结果回填 dataUrl', async () => {
    setup({})
    const gw = gatewayFor()
    const r = await gw.getEmoticonDataUrls({
      items: [
        { md5: M1, emojiUrl: 'https://mmbiz.qpic.cn/1.gif' },
        { md5: M2, emojiUrl: 'https://mmbiz.qpic.cn/2.gif' },
      ],
    })
    expect(fetchCalls.length, '2 条待远端就该是 2 次请求（每条一个网络往返）').toBe(2)
    expect(r.items.every(i => typeof i.dataUrl === 'string'), '远端成功却没回填 dataUrl').toBe(true)
  })

  it('本地没有且没有远端链接 ⇒ 不出网，如实报错（不静默给空 dataUrl）', async () => {
    setup({})
    const gw = gatewayFor()
    const r = await gw.getEmoticonDataUrls({ items: [{ md5: M3 }] })
    expect(fetchCalls).toEqual([])
    expect(r.items[0]?.dataUrl).toBeUndefined()
    expect(r.items[0]?.error ?? '', '没链接时必须说清是"本机没有"').toContain('未找到表情文件')
  })

  it('去重：同一个 md5 出现多次只算一条，结果顺序 = 去重后的入参顺序', async () => {
    setup({ [M2 + '.dat']: xorWith(PNG, 0xff) })
    const gw = gatewayFor()
    const r = await gw.getEmoticonDataUrls({
      items: [{ md5: M1 }, { md5: M2, emojiUrl: 'https://mmbiz.qpic.cn/x.gif' }, { md5: M1 }, { md5: M2 }],
    })
    expect(r.items.map(i => i.md5), '去重后的顺序应当是入参的首次出现顺序').toEqual([M1, M2])
    expect(fetchCalls, 'M1 没有远端链接、M2 本地命中 ⇒ 一次网都不该出').toEqual([])
  })

  it('远端失败时把「本地」与「远端」两条原因都带上（排查时才分得清是哪一段坏了）', async () => {
    stubFetch({ ok: false, status: 500 })
    setup({})
    const gw = gatewayFor()
    const r = await gw.getEmoticonDataUrls({ items: [{ md5: M1, emojiUrl: 'https://mmbiz.qpic.cn/y.gif' }] })
    const err = r.items[0]?.error ?? ''
    expect(err, '只有一条原因 ⇒ 分不清本地没解出来还是远端挂了').toContain('未找到表情文件')
    expect(err).toContain('；')
  })

  it('空入参 / 空白 md5 不炸，也不发请求', async () => {
    setup({})
    const gw = gatewayFor()
    expect((await gw.getEmoticonDataUrls({ items: [] })).items).toEqual([])
    expect((await gw.getEmoticonDataUrls({ items: [{ md5: '  ' }] })).items).toEqual([])
    expect(fetchCalls).toEqual([])
  })
})

describe('E1 批次上限：没退化成串行，也没一口气打满', () => {
  /** 剥注释后再扫源码（注释里出现常量名会让计数偏大，本仓历史踩过三次）。 */
  const src = (() => {
    // 算法搬在 `query/emoticon-batch.ts`（`remotes/media.ts` 只留一行转发），
    // 所以这两条判据要扫那个文件 —— 扫错文件会恒绿（"改一处漏一处"的典型）。
    const raw = readFileSync(join(import.meta.dirname, '..', 'src', 'query', 'emoticon-batch.ts'), 'utf8')
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  })()

  it('并发上限是 8（与封面 COVER_CONCURRENCY 同一个数），且有明确来源可查', () => {
    expect(src, '并发常量没了').toContain('const EMOTICON_FETCH_CONCURRENCY = 8')
  })

  it('并发取远端那一步是 Promise.all，不是 for-await 串行（后者会退化成 N 个串行往返）', () => {
    expect(src, '并发取远端那一步退化成了串行').toContain('await Promise.all(batch.map(')
  })

  it('remotes/media.ts 只留一行转发（算法搬走了，别再长回去）', () => {
    const media = readFileSync(join(import.meta.dirname, '..', 'src', 'remotes', 'media.ts'), 'utf8')
      .replace(/\r\n/g, '\n')
    expect(media, '算法又回填进 remotes/media.ts 了').not.toContain('EMOTICON_FETCH_CONCURRENCY')
    expect(media, '转发没了').toContain('fetchEmoticonDataUrlsBatch(')
  })
})
