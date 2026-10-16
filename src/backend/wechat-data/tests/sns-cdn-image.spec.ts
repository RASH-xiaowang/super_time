/**
 * `fetchSnsCdnImage` 的行为守卫。
 *
 * 钉住的纪律（每条都对应一次实测或一次踩坑）：
 *   · 请求必须走**实测 200 的那一形态**（https + /0 + token&idx=1）；
 *   · 主机必须过微信 CDN 白名单；
 *   · **没有种子就不请求**（省外发，也避免前端画破图）；
 *   · 解密后不是图片 ⇒ 回错误，**绝不把密文当 data URL 交出去**。
 *
 * ## fixture 为什么长这样（2026-10-08 真机实测）
 *
 *   · CDN 响应体是**密文**：头四字节 `ce 6c e7 d1`，不是 `ff d8`。第一版 fixture 让
 *     mock 直接返回「看起来像 JPEG」的响应体，于是「要不要解密」这件事根本触发不了，
 *     测试通过而线上是坏的 —— fixture 必须照抄真机形状。
 *   · 解密结果是**合法 JPEG，但 EOI 之后挂着恒定 24 字节的 CDN 签名块**
 *     （`75 f0 d3 3c 00 00 00 00 …`）。旧判据要求「最后两字节必须是 ff d9」，
 *     于是把真机上 9/9 张好图全判成失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 解密器的行为由每个用例自己定 —— 这里只留一个可变钩子（`vi.mock` 工厂会被提升，不能直接引用外层变量）。 */
const h = vi.hoisted(() => ({
  impl: (_b: Uint8Array, _seed: string): Uint8Array => new Uint8Array([1, 2, 3, 4]),
  calls: [] as string[],
}))

vi.mock('../src/query/sns-keystream.ts', () => ({
  decryptSnsAll: vi.fn(async (b: Uint8Array, seed: string) => {
    h.calls.push(seed)
    return { bytes: h.impl(b, seed), decrypted: b.length }
  }),
}))

const { fetchSnsCdnImage } = await import('../src/query/sns-cdn-image.ts')
const { decryptSnsAll } = await import('../src/query/sns-keystream.ts')

const URL0 = 'http://mmsns.qpic.cn/mmsns/O8n3oVqPCR/0'
const TOK = 'tok-abc'

/** 真机实测：CDN 响应体头四字节（密文，不是图片魔数）。 */
const CIPHERTEXT = new Uint8Array([0xce, 0x6c, 0xe7, 0xd1, 0x01, 0x02, 0x03, 0x04])
/** 真机实测：EOI 之后恒定 24 字节的签名块（前 9 字节逐张相同）。 */
const TRAILER = Buffer.from([
  0x75, 0xf0, 0xd3, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x04, 0xfc, 0xb5, 0x80,
  0xa1, 0xe2, 0x91, 0x9d, 0x43, 0xd6, 0x58, 0x7c, 0x92, 0x54, 0x13, 0xc3,
])
const JPEG_BODY = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 1, 2, 3, 4, 5])

const jpegWithTrailer = (): Uint8Array => Buffer.concat([JPEG_BODY, Buffer.from([0xff, 0xd9]), TRAILER])
const jpegPlain = (): Uint8Array => Buffer.concat([JPEG_BODY, Buffer.from([0xff, 0xd9])])
/** 被截断：头对，但整段里根本没有 EOI（真机上「只解前 128KB」的形状）。 */
const jpegTruncated = (): Uint8Array => Buffer.concat([JPEG_BODY, Buffer.alloc(4096, 7)])
const avif = (): Uint8Array => Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypavif'), Buffer.alloc(16, 0)])
const pngWithTrailer = (): Uint8Array => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  TRAILER,
])

const okFetch = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(bytes, { status: 200, headers })) as unknown as typeof fetch

/** 把 data URL 还原成字节，供「尾块真的被裁掉了」这种字节级断言用。 */
function decodeDataUrl(u: string | undefined): Buffer {
  expect(u, '本该拿到 data URL').toBeDefined()
  expect(u!.startsWith('data:image/')).toBe(true)
  return Buffer.from(u!.slice(u!.indexOf(',') + 1), 'base64')
}

describe('fetchSnsCdnImage：CDN 取图 + 解密', () => {
  // 计数必须逐用例复位：解密器桩是模块级的，不清就会把上一个用例的调用也算进来。
  beforeEach(() => {
    h.calls.length = 0
    vi.mocked(decryptSnsAll).mockClear()
  })

  it('成功：请求形态是 https + /0 + token&idx=1，返回 image/jpeg 的 data URL', async () => {
    h.impl = () => jpegPlain()
    const f = okFetch(CIPHERTEXT)
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', f)
    expect(r.error).toBeUndefined()
    expect(r.dataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const calls = (f as unknown as { mock: { calls: Array<Array<string | undefined>> } }).mock.calls
    expect(String(calls[0]?.[0] ?? '')).toBe('https://mmsns.qpic.cn/mmsns/O8n3oVqPCR/0?token=' + TOK + '&idx=1')
  })

  it('没有种子 ⇒ 不请求（避免把必然解不开的密文画成破图）', async () => {
    const f = okFetch(CIPHERTEXT)
    const r = await fetchSnsCdnImage(URL0, TOK, '', f)
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('种子')
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('非腾讯系主机 ⇒ 拒绝，且不请求', async () => {
    const f = okFetch(CIPHERTEXT)
    const r = await fetchSnsCdnImage('http://example.com/a/0', TOK, 'SEED1', f)
    expect(r.error).toContain('清单')
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('CDN 4xx ⇒ 回可读原因，不抛异常', async () => {
    const f = vi.fn(async () => new Response('', { status: 400 })) as unknown as typeof fetch
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', f)
    expect(r.error).toContain('400')
  })

  it('解密结果不是图片 ⇒ 回错误，绝不把密文当 data URL 返回', async () => {
    h.impl = () => new Uint8Array([1, 2, 3, 4])
    const r = await fetchSnsCdnImage(URL0, TOK, 'BADSEED', okFetch(CIPHERTEXT))
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('不是图片')
  })

  it('CDN 挂在 EOI 之后的签名尾块被裁掉（真机 24 字节恒定）⇒ 好图不再被判失败', async () => {
    h.impl = () => jpegWithTrailer()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(CIPHERTEXT))
    expect(r.error).toBeUndefined()
    const out = decodeDataUrl(r.dataUrl)
    // 字节级断言：裁尾后必须**紧贴** EOI，且长度正好等于「到 EOI 为止」
    expect(out.length).toBe(JPEG_BODY.length + 2)
    expect([...out.subarray(-2)]).toEqual([0xff, 0xd9])
  })

  it('PNG 的 IEND 之后的尾块同样裁掉', async () => {
    h.impl = () => pngWithTrailer()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(CIPHERTEXT))
    expect(r.error).toBeUndefined()
    expect(decodeDataUrl(r.dataUrl).length).toBe(20)
  })

  it('尾部窗口内没有结束标记 ⇒ 报错，且只报实测数字（不断言成因）', async () => {
    h.impl = () => jpegTruncated()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(CIPHERTEXT))
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('结尾标记缺失')
    // 实测值必须出现在文案里：长度、x-enc、有没有解密过
    expect(r.error).toContain(String(jpegTruncated().length))
    expect(r.error).toContain('x-enc=无')
    expect(r.error).toContain('已整份解密')
    // 上一版那句「可能只解密了前 128 KB」是个猜测，必须从文案里消失
    expect(r.error).not.toContain('128 KB')
  })

  it('原始响应本来已是图片且没有 x-enc ⇒ 不解密，直接用原始（部分端点给的是已解码图）', async () => {
    h.calls.length = 0
    h.impl = () => new Uint8Array([0xff, 0x00]) // 若被调用就会毁掉这张图
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(jpegPlain()))
    expect(r.error).toBeUndefined()
    expect(decodeDataUrl(r.dataUrl).length).toBe(jpegPlain().length)
    expect(h.calls, '不该调用解密器').toEqual([])
  })

  it('x-enc 表明加密 ⇒ 即使原始看着像图片也走解密（对齐参考项目）', async () => {
    h.calls.length = 0
    h.impl = () => jpegWithTrailer()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(jpegPlain(), { 'x-enc': '1' }))
    expect(r.error).toBeUndefined()
    expect(h.calls).toEqual(['SEED1'])
    // 用的是解密版（尾块被裁掉 ⇒ 长度等于「到 EOI 为止」）
    expect(decodeDataUrl(r.dataUrl).length).toBe(JPEG_BODY.length + 2)
  })

  it('x-enc: 0 ⇒ 不解密（原始就是图片时）', async () => {
    h.calls.length = 0
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(jpegPlain(), { 'x-enc': '0' }))
    expect(r.error).toBeUndefined()
    expect(h.calls).toEqual([])
  })

  it('解密失败但原始本来就是图片 ⇒ 用原始交付，不把好图丢掉', async () => {
    h.calls.length = 0
    h.impl = () => new Uint8Array([1, 2, 3, 4]) // 解出来是垃圾
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(jpegPlain(), { 'x-enc': '1' }))
    expect(r.error).toBeUndefined()
    expect(decodeDataUrl(r.dataUrl).length).toBe(jpegPlain().length)
    expect(h.calls).toEqual(['SEED1'])
  })

  it('解密抛异常但原始本来就是图片 ⇒ 同样用原始交付', async () => {
    h.impl = () => { throw new Error('WASM 炸了') }
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(jpegPlain(), { 'x-enc': '1' }))
    expect(r.error).toBeUndefined()
    expect(decodeDataUrl(r.dataUrl).length).toBe(jpegPlain().length)
    h.impl = () => new Uint8Array([1, 2, 3, 4])
  })

  it('AVIF/HEIC 也认（只认 JPEG/PNG 会把它们一律判成「不是图片」）', async () => {
    h.impl = () => avif()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(CIPHERTEXT))
    expect(r.error).toBeUndefined()
    expect(r.dataUrl?.startsWith('data:image/avif;base64,')).toBe(true)
  })

  it('没有可搜结束标记的类型（AVIF）不因「找不到 EOI」而被判失败', async () => {
    h.impl = () => avif()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', okFetch(CIPHERTEXT))
    expect(r.error).toBeUndefined()
    // 原样交付：字节数一个不少
    expect(decodeDataUrl(r.dataUrl).length).toBe(avif().length)
  })

  it('解密器只在拿到种子后被调用一次，且种子原样透传', async () => {
    h.calls.length = 0
    h.impl = () => jpegPlain()
    await fetchSnsCdnImage(URL0, TOK, '  7789788357417345129  ', okFetch(CIPHERTEXT))
    expect(h.calls).toEqual(['7789788357417345129'])
    expect(vi.mocked(decryptSnsAll)).toHaveBeenCalledTimes(1)
  })
})
