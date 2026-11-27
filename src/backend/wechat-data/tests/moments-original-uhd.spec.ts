// @vitest-environment node
/**
 * 独立验收：朋友圈原图解析必须优先 UHD、保留 `/2000`，并能淘汰历史预览档。
 *
 * 这里刻意不复用实现里的私有助手：XML 尺寸判定、UHD 请求顺序、归档替换和
 * 归档合并都从公开入口走一遍，避免“实现和测试一起改”把问题掩盖掉。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  impl: (_bytes: Uint8Array, _seed: string): Uint8Array => {
    throw new Error('测试未设置解密结果')
  },
  calls: [] as string[],
}))

vi.mock('../src/query/sns-keystream.ts', () => ({
  decryptSnsAll: vi.fn(async (bytes: Uint8Array, seed: string) => {
    h.calls.push(seed)
    return { bytes: h.impl(bytes, seed), decrypted: bytes.length }
  }),
}))

const { ensureMomentsArchiveFresh, parseSnsXml } = await import('../src/query/moments.ts')
const { readArchivedPayloads, upsertArchivedMoments } = await import('../src/query/moments-archive.ts')
const { evaluateSnsOriginal } = await import('../src/query/image-dimensions.ts')
const {
  lookupArchivedOriginal,
  saveArchivedOriginal,
} = await import('../src/query/sns-media-store.ts')
const { createMediaRemotes } = await import('../src/remotes/media.ts')

const IMAGE_MD5 = '0123456789abcdef0123456789abcdef'
const UHD_MD5 = 'fedcba9876543210fedcba9876543210'
const TID = '-3412344236794441123'
const PLAIN = 'http://mmsns.qpic.cn/mmsns/normal/0'
const UHD = 'http://mmsns.qpic.cn/mmsns/uhd/2000'
const CIPHERTEXT = Buffer.from([0xce, 0x6c, 0xe7, 0xd1, 1, 2, 3, 4])

const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  h.calls.length = 0
  h.impl = () => {
    throw new Error('测试未设置解密结果')
  }
})

/** 最小可解析 JPEG：SOI + SOF0(width×height) + EOI。 */
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

function dataBytes(dataUrl: string | undefined): Buffer {
  expect(dataUrl, '应当返回 data URL').toBeDefined()
  expect(dataUrl!.startsWith('data:image/')).toBe(true)
  return Buffer.from(dataUrl!.slice(dataUrl!.indexOf(',') + 1), 'base64')
}

function makeRoot(prefix: string): { root: string; decrypted: string; decoded: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return { root, decrypted, decoded: join(root, 'decoded_images') }
}

function remotesFor(decrypted: string, decoded: string) {
  return createMediaRemotes({
    dirs: () => ({ decrypted, decoded }),
    op: () => {},
    rawWechatBase: () => '',
    decryptState: { active: false, op: null } as never,
    warmDecodedImages: async () => {},
  })
}

function originalXml(): string {
  return '<SnsDataItem><TimelineObject>'
    + '<id>tl-original-1</id><createTime>1792240123</createTime>'
    + '<contentDesc><![CDATA[UHD fixture]]></contentDesc>'
    + '<ContentObject><type>54</type><mediaList><media>'
    + '<id>img-uhd-1</id><type>2</type>'
    + `<url md5="${IMAGE_MD5}" key="ordinary-seed" token="ordinary-token">${PLAIN}</url>`
    + '<thumb key="ordinary-seed" token="ordinary-token">http://mmsns.qpic.cn/mmsns/normal/150</thumb>'
    + '<size width="2000" height="1500" totalSize="355403"/>'
    + `<uhd md5="${UHD_MD5}" token="uhd-token" key="uhd-seed">${UHD}?token=uhd-token&amp;idx=1</uhd>`
    + '<LivePhoto><liveMedia><id>0</id><type>6</type>'
    + '<url md5="11111111111111111111111111111111">http://mmsns.qpic.cn/mmsns/video/0</url>'
    + '<size width="316" height="420" totalSize="2042268"/>'
    + '<enc key="video-seed">1</enc></liveMedia></LivePhoto>'
    + '</media></mediaList></ContentObject></TimelineObject></SnsDataItem>'
}

function writeMomentDb(decrypted: string, xml: string): void {
  const dir = join(decrypted, 'sns', 'db_sns')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'sns.db'))
  db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content TEXT)')
  db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(TID, 'wxid_uhd', xml)
  db.close()
}

describe('朋友圈 UHD 原图：优先级、回退与归档', () => {
  it('UHD 成功时只走 /2000 + uhdToken/uhdSeed，不再请求普通 /0', async () => {
    const { decrypted, decoded } = makeRoot('moments-uhd-first-')
    const uhdBytes = jpeg(2400, 1800)
    const ordinaryBytes = jpeg(1200, 900)
    h.impl = (_bytes, seed) => seed === 'uhd-seed' ? uhdBytes : ordinaryBytes
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(CIPHERTEXT, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const got = await remotesFor(decrypted, decoded).getSnsImageDataUrl({
      md5: IMAGE_MD5,
      url: PLAIN,
      token: 'ordinary-token',
      seed: 'ordinary-seed',
      uhdUrl: UHD,
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      originalWidth: 2400,
      originalHeight: 1800,
      offline: false,
    })

    expect(dataBytes(got.url).equals(uhdBytes)).toBe(true)
    expect(h.calls).toEqual(['uhd-seed'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requested = String(fetchMock.mock.calls[0]?.[0] ?? '')
    expect(requested).toContain('/2000?token=uhd-token&idx=1')
    expect(requested).not.toContain('/0?token=uhd-token')
  })

  it('UHD 失败后回退普通 /0，且最多各请求一次', async () => {
    const { decrypted, decoded } = makeRoot('moments-uhd-fallback-')
    const ordinaryBytes = jpeg(1600, 1200)
    h.impl = (_bytes, seed) => {
      expect(seed).toBe('ordinary-seed')
      return ordinaryBytes
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      return String(input).includes('/2000')
        ? new Response('', { status: 400 })
        : new Response(CIPHERTEXT, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const got = await remotesFor(decrypted, decoded).getSnsImageDataUrl({
      md5: IMAGE_MD5,
      url: PLAIN,
      token: 'ordinary-token',
      seed: 'ordinary-seed',
      uhdUrl: UHD,
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      originalWidth: 1600,
      originalHeight: 1200,
      offline: false,
    })

    expect(dataBytes(got.url).equals(ordinaryBytes)).toBe(true)
    expect(h.calls).toEqual(['ordinary-seed'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toContain('/2000?token=uhd-token&idx=1')
    expect(urls[1]).toContain('/0?token=ordinary-token&idx=1')
  })

  it('offline 时 UHD 与普通 /0 都不出网', async () => {
    const { decrypted, decoded } = makeRoot('moments-uhd-offline-')
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(CIPHERTEXT, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const got = await remotesFor(decrypted, decoded).getSnsImageDataUrl({
      md5: IMAGE_MD5,
      url: PLAIN,
      token: 'ordinary-token',
      seed: 'ordinary-seed',
      uhdUrl: UHD,
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      originalWidth: 1600,
      originalHeight: 1200,
      offline: true,
    })

    expect(got.url).toBeUndefined()
    expect(fetchMock, '离线时仍发起了网络请求').not.toHaveBeenCalled()
    expect(h.calls, '离线时仍尝试了解密').toEqual([])
  })

  it('旧 200x300 归档不会短路；UHD 成功后按主图 md5 覆盖归档', async () => {
    const { decrypted, decoded } = makeRoot('moments-uhd-replace-')
    const preview = jpeg(200, 300)
    const uhdBytes = jpeg(2000, 1500)
    expect(saveArchivedOriginal(decoded, IMAGE_MD5, preview)).toBe('jpg')
    h.impl = (_bytes, seed) => {
      expect(seed).toBe('uhd-seed')
      return uhdBytes
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(CIPHERTEXT, { status: 200 })))

    const got = await remotesFor(decrypted, decoded).getSnsImageDataUrl({
      md5: IMAGE_MD5,
      uhdUrl: UHD,
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      originalWidth: 2000,
      originalHeight: 1500,
      originalBytes: 355403,
      offline: false,
    })

    expect(dataBytes(got.url).equals(uhdBytes)).toBe(true)
    expect(lookupArchivedOriginal(decoded, IMAGE_MD5)?.bytes.equals(uhdBytes)).toBe(true)
    expect(lookupArchivedOriginal(decoded, UHD_MD5), 'uhdMd5 不能成为归档主键').toBeNull()
  })
})

describe('XML 原图尺寸：横竖旋转与容差', () => {
  const expected = { width: 2000, height: 1500 }

  it('横图、旋转后的竖图、以及 15% 容差内都接受', () => {
    expect(evaluateSnsOriginal(jpeg(2000, 1500), expected).accepted).toBe(true)
    expect(evaluateSnsOriginal(jpeg(1500, 2000), expected).accepted).toBe(true)
    expect(evaluateSnsOriginal(jpeg(1750, 1300), expected).accepted).toBe(true)
  })

  it('200x300 预览与低于 75% 容差的尺寸都拒绝', () => {
    expect(evaluateSnsOriginal(jpeg(200, 300), expected).accepted).toBe(false)
    // 2026-11-24：容差是 75%（微信「大图」实测正好是 XML 尺寸的 75%，见
    // `SNS_ORIGINAL_DIMENSION_TOLERANCE`）。原样例 1650×1200 落在 75–85% 之间，
    // 按现行口径**应当接受**；这里换成真正低于 75% 的一档来验「超出容差就拒绝」。
    expect(evaluateSnsOriginal(jpeg(1400, 1000), expected).accepted).toBe(false)
    // 反证：75% 那一档确实被接受（否则上面那条只是「越小越拒绝」的恒真判据）。
    expect(evaluateSnsOriginal(jpeg(1500, 1125), expected).accepted).toBe(true)
  })
})

describe('parseSnsXml + 归档合并：original*/uhd* 字段不许丢', () => {
  it('解析外层 size 与 uhd，不被 LivePhoto 的内层 size 覆盖', () => {
    const parsed = parseSnsXml(originalXml())
    expect(parsed.images[0]).toMatchObject({
      originalWidth: 2000,
      originalHeight: 1500,
      originalBytes: 355403,
      uhdUrl: UHD + '?token=uhd-token&idx=1',
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      uhdMd5: UHD_MD5,
    })
  })

  it('旧归档 payload 与新版解析合并时保留全部新字段', () => {
    const { decrypted } = makeRoot('moments-uhd-merge-')
    const xml = originalXml()
    writeMomentDb(decrypted, xml)
    const oldPayload = JSON.stringify({
      tid: TID,
      username: 'wxid_uhd',
      author: 'wxid_uhd',
      text: 'UHD fixture',
      ts: 1792240123,
      time: '',
      media_count: 1,
      media_desc: '图片×1',
      images: [{
        id: 'img-uhd-1',
        timelineId: 'tl-original-1',
        md5: IMAGE_MD5,
        url: PLAIN,
        thumb: 'http://mmsns.qpic.cn/mmsns/normal/150',
        key: 'ordinary-seed',
        token: 'ordinary-token',
      }],
      videos: [],
      location: '',
      link_title: '',
      link_url: '',
      is_self: false,
      likes: [],
      comments: [],
    })
    upsertArchivedMoments(decrypted, [{
      tid: TID,
      username: 'wxid_uhd',
      author: 'wxid_uhd',
      ts: 1792240123,
      content: xml,
      contentHash: 'stale-before-original-resolution',
      payload: oldPayload,
    }])

    expect(ensureMomentsArchiveFresh(decrypted, true)).toBe(1)
    const payload = readArchivedPayloads(decrypted, [TID]).get(TID)
    expect(payload).toBeDefined()
    const images = (JSON.parse(payload!) as { images?: Array<Record<string, unknown>> }).images
    expect(images?.[0]).toMatchObject({
      originalWidth: 2000,
      originalHeight: 1500,
      originalBytes: 355403,
      uhdUrl: UHD + '?token=uhd-token&idx=1',
      uhdToken: 'uhd-token',
      uhdSeed: 'uhd-seed',
      uhdMd5: UHD_MD5,
    })
  })
})
