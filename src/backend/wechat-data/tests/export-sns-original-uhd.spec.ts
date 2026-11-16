/**
 * 朋友圈原图导出：与在线取图共用 UHD 优先 + 尺寸校验纪律。
 *
 * 这里直接桩掉 `fetchSnsCdnImage`，只验证编排：
 *   · UHD 的 `/2000` 与原三件套先到；
 *   · UHD 尺寸不合格时回退普通 CDN；
 *   · 普通 CDN 的 200x300 预览图同样被拒绝，不能写进导出文件。
 *
 * UHD 路径本身（含 `snsCdnUrl` 保留 `/2000`）由 `moments-original-uhd.spec.ts`
 * 走真实网络桩与解密桩覆盖。
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; token: string; seed: string }>,
  results: new Map<string, { dataUrl?: string; error?: string }>(),
}))

vi.mock('../src/query/sns-cdn-image.ts', () => ({
  fetchSnsCdnImage: vi.fn(async (url: string, token?: string, seed?: string) => {
    h.calls.push({ url, token: token ?? '', seed: seed ?? '' })
    return h.results.get(url) ?? { error: '测试未设置该地址的响应：' + url }
  }),
}))

const { loadSnsImageOriginalBytes } = await import('../src/query/export-sns-media.ts')

const MD5 = '0123456789abcdef0123456789abcdef'
const UHD = 'http://mmsns.qpic.cn/mmsns/uhd/2000'
const NORMAL = 'http://mmsns.qpic.cn/mmsns/normal/0'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  h.calls.length = 0
  h.results.clear()
})

/** 最小可解析 JPEG：SOI + SOF0(width×height) + 填充 + EOI。 */
function jpeg(width: number, height: number, body = 64): Buffer {
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.alloc(body, 0x33),
    Buffer.from([0xff, 0xd9]),
  ])
}

function dataUrl(bytes: Buffer): string {
  return 'data:image/jpeg;base64,' + bytes.toString('base64')
}

function context(): { decodedDir: string; xorKey: number } {
  const root = mkdtempSync(join(tmpdir(), 'sns-export-uhd-'))
  roots.push(root)
  return { decodedDir: join(root, 'decoded_images'), xorKey: 0xff }
}

const expected = {
  originalWidth: 1440,
  originalHeight: 1920,
  originalBytes: 212_083,
}

describe('loadSnsImageOriginalBytes：UHD 优先与尺寸闸门', () => {
  it('UHD 尺寸不合格时回退普通 CDN，且两次请求按 UHD → /0 排序', async () => {
    const high = jpeg(1440, 1920, 256)
    h.results.set(UHD, { dataUrl: dataUrl(jpeg(200, 300)) })
    h.results.set(NORMAL, { dataUrl: dataUrl(high) })

    const got = await loadSnsImageOriginalBytes(context(), {
      md5: MD5,
      url: NORMAL,
      token: 'normal-token',
      seed: 'normal-seed',
      uhdUrl: UHD,
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      ...expected,
    })

    expect(got.bytes?.equals(high), '没有回退到合格普通原图').toBe(true)
    expect(got.source).toBe('cdn')
    expect(got.format).toBe('jpg')
    expect(h.calls.map((call) => call.url)).toEqual([UHD, NORMAL])
    expect(h.calls[0]).toEqual({ url: UHD, token: 'uhd-token', seed: 'uhd-seed' })
    expect(h.calls[1]).toEqual({ url: NORMAL, token: 'normal-token', seed: 'normal-seed' })
  })

  it('UHD 合格时不再请求普通 CDN', async () => {
    const uhd = jpeg(1440, 1920, 256)
    h.results.set(UHD, { dataUrl: dataUrl(uhd) })

    const got = await loadSnsImageOriginalBytes(context(), {
      md5: MD5,
      url: NORMAL,
      token: 'normal-token',
      seed: 'normal-seed',
      uhdUrl: UHD,
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      ...expected,
    })

    expect(got.bytes?.equals(uhd)).toBe(true)
    expect(h.calls).toEqual([{ url: UHD, token: 'uhd-token', seed: 'uhd-seed' }])
  })

  it('普通 CDN 只有 200x300 预览图时拒绝导出', async () => {
    h.results.set(NORMAL, { dataUrl: dataUrl(jpeg(200, 300)) })

    const got = await loadSnsImageOriginalBytes(context(), {
      md5: MD5,
      url: NORMAL,
      token: 'normal-token',
      seed: 'normal-seed',
      ...expected,
    })

    expect(got.bytes).toBeUndefined()
    expect(got.error).toContain('拒绝写入')
    expect(got.error).toContain('200x300')
    expect(h.calls.map((call) => call.url)).toEqual([NORMAL])
  })
})
