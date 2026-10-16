/**
 * 朋友圈**视频封面**的完整性行为（2026-10-09）。
 *
 * ## 要钉住的是什么
 *
 * 原来 `fetchSnsCoverDataUrl` 用 `decryptSnsHead`（**只解前 128 KB**）之后，只用 `imageMimeOf`
 * 看**头 3 个字节**就放行，全程没有任何结尾校验 ⇒ 一张尾部仍是密文的坏图会被当成好图交给渲染层。
 * 光靠改代码看不出这个缺陷被修掉了，所以这里用**真 WASM 往返**造出真密文来钉行为：
 *
 *   · `decryptSnsHead` / `decryptSnsAll` 都是 `明文 XOR 密钥流`，而 `wxIsaac64Keystream` 是
 *     前缀一致的（分块与一次性生成逐字节相同，2026-10-08 实测）⇒ 用同一个种子把明文 XOR 一下
 *     就得到**真密文**，解密回去应当逐字节等于原明文。造的不是「假装加密」的假数据。
 *
 * 这几个用例对**旧实现**是咬红的：旧的会把尾部密文的封面原样交出去。
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSnsCoverDataUrl } from '../src/query/sns-video.ts'
import { wxIsaac64Keystream, SNS_HEAD_ENCRYPTED_BYTES } from '../src/query/sns-keystream.ts'

const SEED = '3418657749'

/** 真密文：明文 XOR 密钥流。解密回去必须逐字节相同。 */
const encrypt = async (plain: Buffer, seed = SEED): Promise<Buffer> => {
  const ks = await wxIsaac64Keystream(seed, plain.length)
  const out = Buffer.from(plain)
  // `(out[i] ?? 0)` 与生产 `sns-keystream.ts` 同一写法：测试目录开着 `noUncheckedIndexedAccess`，
  // 裸读下标会被判成「可能是 undefined」。
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) ^ (ks[i] ?? 0)
  return out
}

/** 造一张「头是 JPEG 魔数、结尾按要求」的字节。 */
const fakeJpeg = (size: number, opts: { eoi?: boolean; trailer?: number } = {}): Buffer => {
  // 用 set/fill 而不是 `b[0] = …`：测试目录开着 `noUncheckedIndexedAccess`，
  // 逐字节下标写会被判成「可能是 undefined」（`backend-tests-typecheck-ratchet.spec.ts` 盯零类型错）。
  const b = Buffer.alloc(size, 0x41)
  b.set([0xff, 0xd8, 0xff, 0xe0], 0)
  if (opts.trailer) b.fill(0x5a, size - opts.trailer)
  if (opts.eoi !== false) b.set([0xff, 0xd9], size - 2)
  return b
}

/** 让 `fetchSnsMediaBytes` 取回指定字节（带微信 UA 才能 200 这件事由生产代码保证，这里不测）。 */
const stubCdn = (bytes: Buffer, status = 200): void => {
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(bytes), {
    status,
    headers: { 'content-type': 'application/octet-stream' },
  }))
}

/** 把 data URL 还原成字节 —— 断言要落在**字节**上，不能只断言「有 url」。 */
const bytesOf = (dataUrl: string): Buffer => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')

afterEach(() => { vi.unstubAllGlobals() })

describe('视频封面：解密与结尾完整性', () => {
  it('小封面（≤128 KB 密文）：解密后逐字节等于原明文', async () => {
    const plain = fakeJpeg(3000)
    stubCdn(await encrypt(plain))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1', { seed: SEED })
    expect(got.error).toBeUndefined()
    expect(bytesOf(got.url ?? '')).toEqual(plain)
  })

  it('大封面（>128 KB 密文）：也必须整份解 —— 旧的只解头会把尾部密文交出去', async () => {
    // 这条是本 PR 的核心：只解头时尾部仍是密文，结尾标记根本不在末尾。
    const plain = fakeJpeg(SNS_HEAD_ENCRYPTED_BYTES + 68_928)
    expect(plain.length).toBeGreaterThan(SNS_HEAD_ENCRYPTED_BYTES)
    stubCdn(await encrypt(plain))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1', { seed: SEED })
    expect(got.error).toBeUndefined()
    expect(bytesOf(got.url ?? '')).toEqual(plain)
  })

  it('整份解完仍找不到结尾标记 ⇒ 报错，**不**交付一张画不出来的图', async () => {
    // 旧实现在这里会返回 data URL（头合法就放行），这就是「坏图照样交付」的那条路。
    const broken = fakeJpeg(4000, { eoi: false })
    stubCdn(await encrypt(broken))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1', { seed: SEED })
    expect(got.url).toBeUndefined()
    expect(String(got.error)).toContain('结尾')
  })

  it('EOI 之后挂 24 字节尾块仍算完整（微信 CDN 恒定这么干）', async () => {
    const plain = fakeJpeg(3000, { trailer: 24 })
    stubCdn(await encrypt(plain))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1', { seed: SEED })
    expect(got.error).toBeUndefined()
    // 校验而不裁剪：多出来的 24 字节对 JPEG 解码无害，保持字节原样交出去。
    expect(bytesOf(got.url ?? '')).toEqual(plain)
  })

  it('未加密的响应体也要过结尾校验', async () => {
    stubCdn(fakeJpeg(2000, { eoi: false }))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1')
    expect(got.url).toBeUndefined()
    expect(String(got.error)).toContain('结尾')
  })

  it('未加密的完整响应体原样交出（不做多余解密）', async () => {
    const plain = fakeJpeg(2000)
    stubCdn(plain)
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1')
    expect(got.error).toBeUndefined()
    expect(bytesOf(got.url ?? '')).toEqual(plain)
  })

  it('密文但没有 seed ⇒ 说清是缺 <enc key>', async () => {
    stubCdn(await encrypt(fakeJpeg(2000)))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1')
    expect(got.url).toBeUndefined()
    expect(String(got.error)).toContain('<enc key>')
  })

  it('seed 不匹配 ⇒ 报错而不是交一张乱图', async () => {
    stubCdn(await encrypt(fakeJpeg(2000), '1111111111'))
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1', { seed: '2222222222' })
    expect(got.url).toBeUndefined()
    expect(String(got.error)).toContain('不是图片')
  })

  it('CDN 非 200 ⇒ 透传错误，不产出 data URL', async () => {
    stubCdn(Buffer.alloc(0), 400)
    const got = await fetchSnsCoverDataUrl('http://szzjwxsns.video.qq.com/102/20250/snsvideodownload?idx=1', { seed: SEED })
    expect(got.url).toBeUndefined()
    expect(String(got.error)).toContain('400')
  })
})
