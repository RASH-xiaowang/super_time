// @vitest-environment node
/**
 * RPA 图片直链的**投递前**判据（2026-10-23）。
 *
 * 覆盖三块：
 *  ① 签名令牌：有效 / 过期 / 篡改 / 非图片或穿越路径一律验不过；
 *  ② 链接清单：解码失败、路径越界、文件不在、未启用局域网访问都只影响那一张；
 *  ③ 参数解析：`imagesJson` / `imageCount` / `firstImageUrl` 真的从 `ctx.imageLinks` 取值，
 *     且 JSON 里不会出现 data URL（那等于又回到 base64）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRpaImageLinks,
  firstImageUrlOf,
  imagesJsonOf,
  usesImageParamSources,
} from '../src/query/rpa/media-links.ts'
import { renderRequest } from '../src/query/rpa/template.ts'
import { adapter as bazhuayu } from '../src/query/rpa/vendors/bazhuayu.ts'
import { lanAddressScore, pickLanIPv4 } from '../src/net/lan-ipv4.ts'
import {
  isSafeRpaMediaRel,
  RPA_MEDIA_DEFAULT_TTL_MS,
  RPA_MEDIA_MAX_TTL_MS,
  rpaMediaTokenKey,
  signRpaMediaToken,
  verifyRpaMediaToken,
} from '../src/net/rpa-media.ts'
import type {
  RpaImageLink,
  RpaInvocationContext,
  RpaRecordContext,
} from '../src/query/rpa/types.ts'

const scratch: string[] = []

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** 临时 decoded 根 + 一张真实图片。 */
function decodedFixture(): { dir: string; rel: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rpa-media-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'wxid_a'), { recursive: true })
  writeFileSync(join(dir, 'wxid_a', 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  return { dir, rel: 'wxid_a/x.jpg' }
}

/** 一条带两张图片的触发记录快照。 */
function recordOf(over: Partial<RpaRecordContext> = {}): RpaRecordContext {
  return {
    username: 'wxid_a',
    chatName: '测试群',
    chatType: 'group',
    targetName: '',
    targetUsername: '',
    text: '你好',
    keyword: '你好',
    triggeredAt: 1_760_000_000_000,
    images: [
      { localId: 1, createTime: 1_760_000_000_000, sender: '张三', md5: 'm1' },
      { localId: 2, createTime: 1_760_000_000_100, sender: '张三' },
    ],
    ...over,
  }
}

/** 投递上下文（只填参数解析要用的字段）。 */
function ctxOf(imageLinks: RpaImageLink[]): RpaInvocationContext {
  return {
    taskId: 7,
    recordId: 11,
    idempotencyKey: '7:11',
    taskName: '测试任务',
    record: recordOf({
      images: imageLinks.map((link) => ({
        localId: link.localId,
        createTime: link.createTime,
        sender: link.sender,
        ...(link.md5 === undefined ? {} : { md5: link.md5 }),
      })),
    }),
    imageLinks,
    config: {},
    secrets: { apiKey: 'k' },
  }
}

describe('签名令牌：格式 / 过期 / 篡改 / 路径白名单', () => {
  const key = rpaMediaTokenKey('spec-token')

  it('有效令牌可以验回原载荷', () => {
    const expiresAt = Date.now() + RPA_MEDIA_DEFAULT_TTL_MS
    const token = signRpaMediaToken(key, { recordId: 42, rel: 'wxid_a/x.jpg', expiresAt })
    expect(verifyRpaMediaToken(key, token, Date.now())).toEqual({ recordId: 42, rel: 'wxid_a/x.jpg', expiresAt })
  })

  it('过期、改载荷、改签名、换密钥都验不过', () => {
    const expiresAt = Date.now() + 60_000
    const token = signRpaMediaToken(key, { recordId: 42, rel: 'wxid_a/x.jpg', expiresAt })
    expect(verifyRpaMediaToken(key, token, expiresAt + 1)).toBeNull()
    const tooLongNow = Date.now()
    const tooLong = signRpaMediaToken(key, {
      recordId: 42,
      rel: 'wxid_a/x.jpg',
      expiresAt: tooLongNow + RPA_MEDIA_MAX_TTL_MS + 1,
    })
    expect(verifyRpaMediaToken(key, tooLong, tooLongNow)).toBeNull()
    const [version = '', encoded = '', mac = ''] = token.split('.')
    const flip = (s: string): string => (s.startsWith('A') ? 'B' : 'A') + s.slice(1)
    expect(verifyRpaMediaToken(key, version + '.' + flip(encoded) + '.' + mac, Date.now())).toBeNull()
    expect(verifyRpaMediaToken(key, version + '.' + encoded + '.' + flip(mac), Date.now())).toBeNull()
    expect(verifyRpaMediaToken(rpaMediaTokenKey('other-token'), token, Date.now())).toBeNull()
    expect(verifyRpaMediaToken(key, 'not-a-token', Date.now())).toBeNull()
  })

  it('只接受 decoded 根内的图片相对路径', () => {
    for (const rel of ['wxid_a/x.jpg', 'a/b/c.PNG', 'x.webp']) expect(isSafeRpaMediaRel(rel)).toBe(true)
    for (const rel of ['', '../x.jpg', 'a/../../x.jpg', '/etc/x.jpg', 'C:/x.jpg', 'a\\x.jpg', 'a/x.txt', 'a//x.jpg']) {
      expect(isSafeRpaMediaRel(rel), rel).toBe(false)
    }
    // 即便绕过签发侧直接构造令牌，验签也会拒绝非图片路径。
    const expiresAt = Date.now() + 60_000
    const bad = signRpaMediaToken(key, { recordId: 42, rel: '../outside.jpg', expiresAt })
    expect(verifyRpaMediaToken(key, bad, Date.now())).toBeNull()
  })
})

describe('链接清单：单张失败不拖垮整条投递', () => {
  it('成功项给 URL；解码失败/路径越界/文件缺失各自写 error', async () => {
    const fx = decodedFixture()
    const record = recordOf({
      images: [
        { localId: 1, createTime: 1, sender: '张三' },
        { localId: 2, createTime: 2, sender: '张三' },
        { localId: 3, createTime: 3, sender: '张三' },
        { localId: 4, createTime: 4, sender: '张三' },
      ],
    })
    const links = await buildRpaImageLinks(
      record,
      {
        decodedDir: fx.dir,
        decodeImage: async (_username, localId) => {
          if (localId === 1) return { file: fx.rel }
          if (localId === 2) return { file: '../outside.jpg' }
          if (localId === 3) return { file: 'wxid_a/missing.jpg' }
          return {}
        },
      },
      (rel) => ({ url: 'http://192.168.1.10:5032/api/rpa-media/' + rel }),
    )
    expect(links).toHaveLength(4)
    expect(links[0]).toMatchObject({ localId: 1, url: expect.stringContaining('/api/rpa-media/') })
    expect(links[1]?.error).toContain('超出解码目录')
    expect(links[2]?.error).toContain('不在解码目录')
    expect(links[3]?.error).toBe('图片解码失败')
    for (const link of links) expect(link.url ?? '').not.toContain('data:image')
  })

  it('没有链接工厂时如实写「未打开局域网访问」', async () => {
    const fx = decodedFixture()
    const links = await buildRpaImageLinks(
      recordOf({ images: [{ localId: 1, createTime: 1, sender: '张三' }] }),
      { decodedDir: fx.dir, decodeImage: async () => ({ file: fx.rel }) },
    )
    expect(links[0]?.url).toBeUndefined()
    expect(links[0]?.error).toContain('未打开局域网访问')
  })

  it('JSON 清单与首图 URL：空清单 / 首张失败时取第一张成功项', () => {
    const links: RpaImageLink[] = [
      { localId: 1, createTime: 1, sender: '张三', error: '图片解码失败' },
      { localId: 2, createTime: 2, sender: '张三', url: 'http://host/api/rpa-media/t2' },
    ]
    expect(imagesJsonOf([])).toBe('[]')
    expect(imagesJsonOf(links)).toContain('"url":"http://host/api/rpa-media/t2"')
    expect(firstImageUrlOf([])).toBe('')
    expect(firstImageUrlOf(links)).toBe('http://host/api/rpa-media/t2')
  })
})

describe('参数解析：三种图片来源真的读 ctx.imageLinks', () => {
  it('usesImageParamSources 只在配置用图片来源时为 true', () => {
    const descriptor = bazhuayu.descriptor
    expect(usesImageParamSources(descriptor, { extraParams: [{ name: 'a', source: 'content' }] })).toBe(false)
    expect(usesImageParamSources(descriptor, { extraParams: [{ name: 'a', source: 'imagesJson' }] })).toBe(true)
    // 数量只数记录里的引用，不解码、不依赖局域网签名直链。
    expect(usesImageParamSources(descriptor, { extraParams: [{ name: 'a', source: 'imageCount' }] })).toBe(false)
    expect(usesImageParamSources(descriptor, { extraParams: [{ name: 'a', source: 'firstImageUrl' }] })).toBe(true)
    expect(usesImageParamSources(descriptor, {})).toBe(false)
  })

  it('renderRequest 把 JSON / 数量 / 首图地址放进厂商参数', () => {
    const ctx = ctxOf([
      { localId: 1, createTime: 1, sender: '张三', error: '图片解码失败' },
      { localId: 2, createTime: 2, sender: '张三', url: 'http://192.168.1.10:5032/api/rpa-media/t2' },
    ])
    ctx.config = {
      flowId: 'flow-1',
      extraParams: [
        { name: 'images', source: 'imagesJson' },
        { name: 'count', source: 'imageCount' },
        { name: 'first', source: 'firstImageUrl' },
      ],
    }
    const body = JSON.parse(renderRequest(bazhuayu.descriptor, ctx).body) as { params: Record<string, string> }
    expect(body.params['count']).toBe('2')
    expect(body.params['first']).toBe('http://192.168.1.10:5032/api/rpa-media/t2')
    expect(body.params['images']).toContain('"localId":1')
    expect(body.params['images']).not.toContain('data:image')
  })
})

describe('局域网地址：与宿主绑定的选择口径一致', () => {
  it('忽略回环；物理网卡排在虚拟机之前', () => {
    expect(pickLanIPv4({
      'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', mac: '00:15:5d:00:00:01', internal: false }],
      'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false }],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }],
    })).toBe('192.168.1.20')
  })

  it('没有可用网卡时返回空串；分数对虚拟网卡与 APIPA 扣分', () => {
    expect(pickLanIPv4({})).toBe('')
    expect(lanAddressScore('VMware Network Adapter', { address: '192.168.1.2', mac: 'aa' }))
      .toBeLessThan(lanAddressScore('Wi-Fi', { address: '192.168.1.2', mac: 'aa' }))
    expect(lanAddressScore('Ethernet', { address: '169.254.1.2', mac: 'aa' }))
      .toBeLessThan(lanAddressScore('Ethernet', { address: '192.168.1.2', mac: 'aa' }))
  })
})
