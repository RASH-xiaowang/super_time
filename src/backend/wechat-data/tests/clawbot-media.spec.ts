/**
 * ClawBot 媒体取数守卫（`query/clawbot/clawbot-media.ts`）—— 假 fetch，零出网。
 *
 * 这条链的失效几乎全是**静默**的：URL 少一层 `encodeURIComponent`（参数里带 `&` 就拼坏）、
 * 密钥少一步解析（base64→hex）、密文没去 PKCS7、缓存每次都重下、越域地址照发 ——
 * 每一条都表现为「图片打不开」或「悄悄多发请求」，不报错。
 * @vitest-environment node
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClawbotMediaRef } from '../src/query/clawbot/clawbot-message.ts'
import { insertClawbotMessage } from '../src/query/clawbot/clawbot-message.ts'
import {
  CLAWBOT_CDN_BASE,
  CLAWBOT_MEDIA_MAX_BYTES,
  clawbotMediaDir,
  decryptMediaBytes,
  ensureClawbotMedia,
  imageMimeOf,
  type FetchLike,
} from '../src/query/clawbot/clawbot-media.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-media-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 测试侧加密：AES-128-ECB + PKCS7（与取数端的解密互逆）。 */
function encryptEcb(plain: Buffer): { cipher: Buffer, keyBase64: string, keyHex: string } {
  const key = randomBytes(16)
  const cipher = createCipheriv('aes-128-ecb', key, null) // 默认 PKCS7
  const out = Buffer.concat([cipher.update(plain), cipher.final()])
  const keyHex = key.toString('hex')
  return { cipher: out, keyBase64: Buffer.from(keyHex, 'utf8').toString('base64'), keyHex }
}

/** 一段带 PNG 魔数的「图片」明文字节（扩展名嗅探靠头几个字节）。 */
function pngBytes(payload: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(payload, 'utf8')])
}

interface FakeNet {
  fetchImpl: FetchLike
  urls: string[]
}

/** 假 fetch：固定返回给定字节；`contentLength` 可伪造超限头。 */
function fakeNet(body: Buffer, opts: { contentLength?: string } = {}): FakeNet {
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? (opts.contentLength ?? String(body.byteLength)) : null) },
      arrayBuffer: async () => Uint8Array.from(body).buffer,
    }
  }
  return { fetchImpl, urls }
}

/** 落库一条带附件的消息，返回行 id。 */
function seedMedia(dir: string, media: ClawbotMediaRef): number {
  const id = insertClawbotMessage(dir, { ts: 1, direction: 'in', msgType: media.kind, content: '[附件]', media })
  if (id === null) throw new Error('seed 落库失败')
  return id
}

describe('clawbot-media：下载 / 解密 / 缓存', () => {
  it('加密图片：URL 带转义参数、解出明文、按魔数存成 .png（缓存命中不再联网）', async () => {
    const dir = root()
    const plain = pngBytes('hello-image')
    const { cipher, keyBase64 } = encryptEcb(plain)
    const id = seedMedia(dir, { kind: 'image', ref: 'a&b=c', key: keyBase64, name: null, size: cipher.byteLength })
    const net = fakeNet(cipher)

    const r = await ensureClawbotMedia(dir, id, { fetchImpl: net.fetchImpl })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(net.urls[0]).toBe(CLAWBOT_CDN_BASE + '/download?encrypted_query_param=a%26b%3Dc')
    expect(r.path.endsWith('-image.png')).toBe(true)
    expect(readFileSync(r.path).equals(plain)).toBe(true)

    // 第二次：缓存命中，不再联网。
    const again = await ensureClawbotMedia(dir, id, { fetchImpl: net.fetchImpl })
    expect(again.ok).toBe(true)
    expect(net.urls).toHaveLength(1)
  })

  it('明文 URL（key 为空）：直接 GET、不解密；越域地址拒发且零请求', async () => {
    const dir = root()
    const plain = pngBytes('plain-url')
    const id = seedMedia(dir, { kind: 'image', ref: 'https://novac2c.cdn.weixin.qq.com/c2c/x.png', key: '', name: null, size: null })
    const net = fakeNet(plain)
    const r = await ensureClawbotMedia(dir, id, { fetchImpl: net.fetchImpl })
    expect(r.ok).toBe(true)
    expect(net.urls[0]).toBe('https://novac2c.cdn.weixin.qq.com/c2c/x.png')

    const evilDir = root()
    const evil = seedMedia(evilDir, { kind: 'image', ref: 'https://evil.example.com/x.png', key: '', name: null, size: null })
    const net2 = fakeNet(plain)
    const bad = await ensureClawbotMedia(evilDir, evil, { fetchImpl: net2.fetchImpl })
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error('unreachable')
    expect(bad.error).toContain('白名单')
    expect(bad.error).toContain('evil.example.com')
    expect(bad.permanent, '白名单拒绝是永久性错误').toBe(true)
    expect(net2.urls).toHaveLength(0)
  })

  it('解密失败与超限都给可读错误（超限在 Content-Length 处就拦；体积提示可预判）', async () => {
    const dir = root()
    // aes_key 不是「base64(hex)」形状。
    const id1 = seedMedia(dir, { kind: 'image', ref: 'p', key: Buffer.from('not-hex').toString('base64'), name: null, size: null })
    const badKey = await ensureClawbotMedia(dir, id1, { fetchImpl: fakeNet(pngBytes('x')).fetchImpl })
    expect(badKey.ok).toBe(false)
    if (badKey.ok) throw new Error('unreachable')
    expect(badKey.error).toContain('解密失败')
    expect(badKey.permanent, '解密失败是永久性错误（重试无意义）').toBe(true)

    const id2 = seedMedia(dir, { kind: 'file', ref: 'https://novac2c.cdn.weixin.qq.com/c2c/big', key: '', name: '大包.zip', size: null })
    const over = await ensureClawbotMedia(dir, id2, { fetchImpl: fakeNet(Buffer.alloc(8), { contentLength: String(CLAWBOT_MEDIA_MAX_BYTES + 1) }).fetchImpl })
    expect(over.ok).toBe(false)
    if (over.ok) throw new Error('unreachable')
    expect(over.error).toContain('超过上限')
    expect(over.permanent).toBe(true)

    // 体积提示已超限：**连请求都不发**（不必先下载 32MB+ 再丢），直接判永久失败。
    const id3 = seedMedia(dir, { kind: 'file', ref: 'https://novac2c.cdn.weixin.qq.com/c2c/huge', key: '', name: '超大.bin', size: CLAWBOT_MEDIA_MAX_BYTES + 1 })
    const net3 = fakeNet(Buffer.alloc(8))
    const hinted = await ensureClawbotMedia(dir, id3, { fetchImpl: net3.fetchImpl })
    expect(hinted.ok).toBe(false)
    if (hinted.ok) throw new Error('unreachable')
    expect(hinted.error).toContain('超过上限')
    expect(hinted.permanent).toBe(true)
    expect(net3.urls, '体积提示超限时不许发请求').toHaveLength(0)
  })

  it('没有附件的消息 / 不存在的行：给可读错误，不打上游', async () => {
    const dir = root()
    const textId = insertClawbotMessage(dir, { ts: 1, direction: 'in', msgType: 'text', content: '你好' })
    if (textId === null) throw new Error('seed 落库失败')
    const net = fakeNet(Buffer.alloc(0))
    const noMedia = await ensureClawbotMedia(dir, textId, { fetchImpl: net.fetchImpl })
    expect(noMedia.ok).toBe(false)
    if (noMedia.ok) throw new Error('unreachable')
    expect(noMedia.error).toContain('没有可取的附件')

    const missing = await ensureClawbotMedia(dir, 999, { fetchImpl: net.fetchImpl })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('unreachable')
    expect(missing.error).toContain('找不到这条消息')
    expect(net.urls).toHaveLength(0)
  })

  it('语音：解密后交给解码器转 wav；解码失败要如实报（不落半截缓存）', async () => {
    const dir = root()
    const { cipher, keyBase64 } = encryptEcb(Buffer.from('silk-ish'))
    const id = seedMedia(dir, { kind: 'voice', ref: 'p', key: keyBase64, name: null, size: null })
    const okDecode = await ensureClawbotMedia(dir, id, {
      fetchImpl: fakeNet(cipher).fetchImpl,
      toWav: (silk, wavPath) => { expect(silk.toString('utf8')).toBe('silk-ish'); writeFileSync(wavPath, 'WAVDATA'); return { ok: true } },
    })
    expect(okDecode.ok).toBe(true)
    if (!okDecode.ok) throw new Error('unreachable')
    expect(okDecode.path.endsWith('-voice.wav')).toBe(true)
    expect(readFileSync(okDecode.path, 'utf8')).toBe('WAVDATA')

    const dir2 = root()
    const second = encryptEcb(Buffer.from('broken'))
    const id2 = seedMedia(dir2, { kind: 'voice', ref: 'p', key: second.keyBase64, name: null, size: null })
    const failDecode = await ensureClawbotMedia(dir2, id2, {
      fetchImpl: fakeNet(second.cipher).fetchImpl,
      toWav: () => ({ ok: false, error: '解码器退出码 1' }),
    })
    expect(failDecode.ok).toBe(false)
    if (failDecode.ok) throw new Error('unreachable')
    expect(failDecode.error).toContain('语音解码失败')
    expect(existsSync(join(clawbotMediaDir(dir2), `${String(id2)}-voice.wav`))).toBe(false)
  })

  it('文件：按原文件名取扩展名（拒绝路径成分）', async () => {
    const dir = root()
    const bytes = Buffer.from('zip-ish')
    const id = seedMedia(dir, { kind: 'file', ref: 'https://novac2c.cdn.weixin.qq.com/c2c/f', key: '', name: '报表.XLSX', size: null })
    const r = await ensureClawbotMedia(dir, id, { fetchImpl: fakeNet(bytes).fetchImpl })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.path.endsWith('-file.xlsx')).toBe(true)

    const evil = seedMedia(dir, { kind: 'file', ref: 'https://novac2c.cdn.weixin.qq.com/c2c/f', key: '', name: '../../evil.exe', size: null })
    const r2 = await ensureClawbotMedia(dir, evil, { fetchImpl: fakeNet(bytes).fetchImpl })
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error('unreachable')
    // 扩展名只取最后一段的字母数字（`exe`），路径成分不会被带进文件名。
    expect(r2.path).toContain(`-file.exe`)
    expect(r2.path).not.toContain('..')
  })
})

describe('clawbot-media：解密与 MIME', () => {
  it('decryptMediaBytes 两步解析密钥（base64→hex）并能去 PKCS7', () => {
    const plain = Buffer.from('round-trip 数据', 'utf8')
    const { cipher, keyBase64 } = encryptEcb(plain)
    expect(decryptMediaBytes(cipher, keyBase64).equals(plain)).toBe(true)
    // 坏形状：密文不是 16 的倍数 / 填充不合法。
    expect(() => decryptMediaBytes(Buffer.from('12345'), keyBase64)).toThrow('16 的倍数')
  })

  it('imageMimeOf：按魔数给 MIME（认不出来给 octet-stream）', () => {
    expect(imageMimeOf(pngBytes('x'))).toBe('image/png')
    expect(imageMimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMimeOf(Buffer.from('plain-text'))).toBe('application/octet-stream')
  })
})
