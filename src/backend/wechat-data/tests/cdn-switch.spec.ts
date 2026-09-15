/**
 * N24：`cdn_enabled` / `cdn_local_decrypt` 两个界面开关必须**真的生效**。
 *
 * 这两个键此前只有界面与存储、没有任何消费者：用户关掉「自动获取原图（CDN）」后取图路径
 * 照旧出网。本用例的判据是**行为事实** —— 打桩 `fetch` 并断言「关掉时一次都不调用」，
 * 而不是断言源码里出现过那个键（M12/N19/N20 反复栽过的坑）。
 *
 * 覆盖四类入口：表情远端取图、公众号封面、朋友圈视频、朋友圈封面；
 * 另加「缓存优先不受开关影响」与「默认（不传 opts）行为不变」两个方向。
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CDN_DISABLED_MESSAGE,
  LOCAL_DECRYPT_DISABLED_MESSAGE,
  cdnFetchAllowed,
  localDecryptEnabled,
} from '../src/query/cdn-policy.ts'
import { resolveArticleCoverDataUrl } from '../src/query/article-cover.ts'
import { fetchEmoticonRemote } from '../src/query/media-image.ts'
import { fetchAndDecodeVideo, fetchSnsCoverDataUrl, fetchSnsVideoDataUrl, loadSnsVideoBytes } from '../src/query/sns-video.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.unstubAllGlobals()
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x01, 0x02, 0x03])
/** 明文 MP4（`ftyp` 在第 4 字节起）——代表「服务端已经解密好的字节」。 */
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(24, 0x11)])
/** 非 MP4/非图片：代表微信 CDN 那种客户端加密流。 */
const CIPHERTEXT = Buffer.alloc(64, 0x5a)

/**
 * 打桩全局 fetch，并记录每次请求的 URL。
 * @param payload - 无论请求什么都返回这份字节。
 * @returns 记录调用的数组（长度即请求次数）。
 */
function stubFetch(payload: Buffer): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    calls.push(String(input))
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      text: async () => payload.toString('utf8'),
    }
  })
  return calls
}

describe('N24：CDN 开关的判定（纯函数）', () => {
  it('默认允许：undefined 不等于关闭（与配置默认 true 一致）', () => {
    expect(cdnFetchAllowed()).toBe(true)
    expect(cdnFetchAllowed({})).toBe(true)
    expect(cdnFetchAllowed({ cdnEnabled: undefined })).toBe(true)
    expect(cdnFetchAllowed({ cdnEnabled: true })).toBe(true)
    expect(cdnFetchAllowed({ cdnEnabled: false })).toBe(false)
    expect(localDecryptEnabled()).toBe(true)
    expect(localDecryptEnabled({ localDecrypt: false })).toBe(false)
  })
})

describe('N24：关掉「自动获取原图（CDN）」后不发请求', () => {
  it('表情：cdnEnabled=false → fetch 调用次数为 0，且给出可读原因', async () => {
    const calls = stubFetch(PNG)
    const r = await fetchEmoticonRemote('https://cdn.example/e.gif', tmp('n24-emo-'), 'abc', { cdnEnabled: false })
    expect(calls.length).toBe(0)
    expect(r.url).toBeUndefined()
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })

  it('表情：默认（不传 opts）仍然会取回并落盘缓存', async () => {
    const calls = stubFetch(PNG)
    const dir = tmp('n24-emo2-')
    const r = await fetchEmoticonRemote('https://cdn.example/e.gif', dir, 'abc')
    expect(calls).toEqual(['https://cdn.example/e.gif'])
    expect(r.url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(existsSync(join(dir, 'abc.png'))).toBe(true)
  })

  it('朋友圈视频：cdnEnabled=false → 不发请求', async () => {
    const calls = stubFetch(MP4)
    const r = await fetchSnsVideoDataUrl('https://cdn.example/v.mp4', undefined, { cdnEnabled: false })
    expect(calls.length).toBe(0)
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })

  it('朋友圈封面：cdnEnabled=false → 不发请求', async () => {
    const calls = stubFetch(PNG)
    const r = await fetchSnsCoverDataUrl('https://cdn.example/c.jpg', { cdnEnabled: false })
    expect(calls.length).toBe(0)
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })

  it('导出视频（loadSnsVideoBytes）：无本机缓存时同样被拦住', async () => {
    const calls = stubFetch(MP4)
    const r = await loadSnsVideoBytes({
      base: tmp('n24-base-'),
      md5: 'deadbeef',
      url: 'https://cdn.example/v.mp4',
      cdnEnabled: false,
    })
    expect(calls.length).toBe(0)
    expect(r.bytes).toBeUndefined()
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })

  it('公众号封面：cdnEnabled=false → 不发请求（文章页与图片都不抓）', async () => {
    const calls = stubFetch(PNG)
    const r = await resolveArticleCoverDataUrl('https://mp.weixin.qq.com/s/abc', tmp('n24-cover-'), { cdnEnabled: false })
    expect(calls.length).toBe(0)
    expect(r.error).toBe(CDN_DISABLED_MESSAGE)
  })
})

describe('N24：开关不影响本机缓存（承诺是「不自动取」，不是「已有的也用不了」）', () => {
  it('公众号封面已有落盘缓存时，关掉开关仍返回缓存', async () => {
    const cacheDir = tmp('n24-cover-cache-')
    const url = 'https://mp.weixin.qq.com/s/cached'
    const file = join(cacheDir, 'article-covers', createHash('md5').update(url, 'utf8').digest('hex') + '.img')
    mkdirSync(join(cacheDir, 'article-covers'), { recursive: true })
    writeFileSync(file, PNG)

    const calls = stubFetch(PNG)
    const r = await resolveArticleCoverDataUrl(url, cacheDir, { cdnEnabled: false })
    expect(calls.length).toBe(0)
    expect(r.url?.startsWith('data:image/png;base64,')).toBe(true)
  })
})

describe('N24：「原图解密方式」决定是否本地解密', () => {
  it('服务端解密（localDecrypt=false）遇到加密流给出专门提示，而不是「解密失败」', async () => {
    stubFetch(CIPHERTEXT)
    const r = await fetchAndDecodeVideo('https://cdn.example/enc.mp4', undefined, { seed: '12345', localDecrypt: false })
    expect(r.bytes).toBeUndefined()
    expect(r.error).toBe(LOCAL_DECRYPT_DISABLED_MESSAGE)
  })

  it('本地解密（默认）遇到同一份加密流会走解密分支 —— 报的是解密相关原因，不是开关提示', async () => {
    stubFetch(CIPHERTEXT)
    const r = await fetchAndDecodeVideo('https://cdn.example/enc.mp4', undefined, { seed: '12345' })
    expect(r.bytes).toBeUndefined()
    expect(r.error).toBeTruthy()
    expect(r.error).not.toBe(LOCAL_DECRYPT_DISABLED_MESSAGE)
  })

  it('服务端已解密好的明文 MP4 直接用（两种设置下都能拿到字节）', async () => {
    stubFetch(MP4)
    const plain = await fetchAndDecodeVideo('https://cdn.example/plain.mp4', undefined, { localDecrypt: false })
    expect(plain.bytes?.subarray(4, 8).toString('latin1')).toBe('ftyp')
    stubFetch(MP4)
    const local = await fetchAndDecodeVideo('https://cdn.example/plain.mp4', undefined, { localDecrypt: true })
    expect(local.bytes?.subarray(4, 8).toString('latin1')).toBe('ftyp')
  })

  it('封面同理：服务端解密时对加密流给出同一句说明', async () => {
    stubFetch(CIPHERTEXT)
    const r = await fetchSnsCoverDataUrl('https://cdn.example/enc.jpg', { seed: '1', localDecrypt: false })
    expect(r.error).toBe(LOCAL_DECRYPT_DISABLED_MESSAGE)
  })
})
