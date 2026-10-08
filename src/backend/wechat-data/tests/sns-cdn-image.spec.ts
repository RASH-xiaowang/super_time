/**
 * `fetchSnsCdnImage` 的行为守卫。
 *
 * 钉住的纪律（每条都对应一次实测或一次踩坑）：
 *   · 请求必须走**实测 200 的那一形态**（https + /0 + token&idx=1）；
 *   · 主机必须过微信 CDN 白名单；
 *   · **没有种子就不请求**（省外发，也避免前端画破图）；
 *   · 解密后不是 JPEG/PNG ⇒ 回错误，**绝不把密文当 data URL 交出去**。
 */
import { describe, expect, it, vi } from 'vitest'

// 解密器换成桩：本用例只验"取图纪律"，不跑 WASM
vi.mock('../src/query/sns-keystream.ts', () => ({
  decryptSnsAll: vi.fn(async (b: Uint8Array, seed: string) => ({
    bytes: seed === 'BADSEED' ? new Uint8Array([1, 2, 3, 4]) :
      (seed === 'TRUNCATED' ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) : new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9])),
  })),
}))

const { fetchSnsCdnImage } = await import('../src/query/sns-cdn-image.ts')
const URL0 = 'http://mmsns.qpic.cn/mmsns/O8n3oVqPCR/0'
const TOK = 'tok-abc'

const okFetch = (bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) =>
  vi.fn(async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch

describe('fetchSnsCdnImage：CDN 取图 + 解密', () => {
  it('成功：请求形态是 https + /0 + token&idx=1，返回 image/jpeg 的 data URL', async () => {
    const f = okFetch()
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', f)
    expect(r.error).toBeUndefined()
    expect(r.dataUrl?.startsWith('data:image/jpeg;base64,')).toBe(true)
    const calls = (f as unknown as { mock: { calls: Array<Array<string | undefined>> } }).mock.calls
    expect(String(calls[0]?.[0] ?? '')).toBe('https://mmsns.qpic.cn/mmsns/O8n3oVqPCR/0?token=' + TOK + '&idx=1')
  })

  it('没有种子 ⇒ 不请求（避免把必然解不开的密文画成破图）', async () => {
    const f = okFetch()
    const r = await fetchSnsCdnImage(URL0, TOK, '', f)
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('种子')
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('非腾讯系主机 ⇒ 拒绝，且不请求', async () => {
    const f = okFetch()
    const r = await fetchSnsCdnImage('http://example.com/a/0', TOK, 'SEED1', f)
    expect(r.error).toContain('清单')
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0)
  })

  it('CDN 4xx ⇒ 回可读原因，不抛异常', async () => {
    const f = vi.fn(async () => new Response('', { status: 400 })) as unknown as typeof fetch
    const r = await fetchSnsCdnImage(URL0, TOK, 'SEED1', f)
    expect(r.error).toContain('400')
  })

  it('解密后不是图片 ⇒ 回错误，绝不把密文当 data URL 返回', async () => {
    const r = await fetchSnsCdnImage(URL0, TOK, 'BADSEED', okFetch())
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('不是图片')
  })
  it('解密后是 JPEG 开头但没有结尾标记（只解了前 128 KB 的典型症状）⇒ 报错，不当图返回', async () => {
    const r = await fetchSnsCdnImage(URL0, TOK, 'TRUNCATED', okFetch())
    expect(r.dataUrl).toBeUndefined()
    expect(r.error).toContain('不完整')
  })
})
