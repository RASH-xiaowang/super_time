// @vitest-environment node
/**
 * 网关层 RPA 图片直链判据（2026-10-23）。
 *
 * 这里不重复验签算法本身，而是钉住装配层真正决定「参数里出现什么 URL」的几条规则：
 *   ① 局域网访问未启用 / 没有令牌时返回 undefined，让图片项如实写 error；
 *   ② 配置了 `rpa_media_base_url` 时优先用它，并规范化主机、路径与末尾斜杠；
 *   ③ 没配时使用宿主最可能绑定的局域网 IPv4 + `api_port`；
 *   ④ 令牌载荷绑定本次触发记录 id，且有效期不超过默认值；
 *   ⑤ 非法公网基址（非 http(s) / 带账号密码、query、hash）不生成看似可用的链接。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import {
  RPA_MEDIA_DEFAULT_TTL_MS,
  RPA_MEDIA_PATH_PREFIX,
  rpaMediaTokenKey,
  verifyRpaMediaToken,
} from '../src/net/rpa-media.ts'
import type { RpaMediaLinkFactory } from '../src/query/rpa/media-links.ts'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    networkInterfaces: vi.fn(() => ({
      'Wi-Fi': [{
        address: '192.168.50.23',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
      }],
    })),
  }
})

interface GatewayInternals {
  rpaMediaLinks: (recordId: number) => RpaMediaLinkFactory | undefined
}

let scratch = ''
let root = ''
let decrypted = ''
let decoded = ''
let disposers: Array<() => void> = []

function fakeCtx(): Context {
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    emit: () => {},
  } as unknown as Context
}

/** 写宿主真正读取的 config.json / secrets.json，然后按环境变量构造最小网关。 */
function gatewayWith(cfg: Record<string, unknown>, secrets: Record<string, unknown>): GatewayInternals {
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg))
  writeFileSync(join(root, 'secrets.json'), JSON.stringify(secrets))
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  vi.stubEnv('DSH_WECHAT_BASE_DIR', '')
  return new WechatDataGateway(fakeCtx()) as unknown as GatewayInternals
}

/** 从生成 URL 里取令牌并验回载荷。 */
function verifyUrl(url: string, apiToken: string, now: number) {
  const marker = RPA_MEDIA_PATH_PREFIX
  const at = url.indexOf(marker)
  expect(at, url).toBeGreaterThanOrEqual(0)
  return verifyRpaMediaToken(rpaMediaTokenKey(apiToken), url.slice(at + marker.length), now)
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gateway-rpa-media-'))
  root = scratch
  decrypted = join(root, 'decrypted')
  decoded = join(root, 'decoded_images')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(decoded, { recursive: true })
  disposers = []
  vi.mocked(networkInterfaces).mockClear()
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

describe('GatewayTaskCenter#rpaMediaLinks', () => {
  it('局域网访问关闭或没有令牌时不生成链接工厂', () => {
    const disabled = gatewayWith({ api_enabled: false, api_port: 5032 }, { api_token: 'token-a' })
    expect(disabled.rpaMediaLinks(1)).toBeUndefined()

    const noToken = gatewayWith({ api_enabled: true, api_port: 5032 }, { api_token: '' })
    expect(noToken.rpaMediaLinks(2)).toBeUndefined()
  })

  it('优先使用配置的公网基址，URL 规范化且令牌绑定记录 id / 默认有效期', () => {
    const gw = gatewayWith({
      api_enabled: true,
      api_port: 5032,
      rpa_media_base_url: '  https://RPA.Example.Test:8443/proxy/  ',
    }, { api_token: 'token-public' })
    const factory = gw.rpaMediaLinks(42)
    expect(factory).toBeDefined()
    const link = factory?.('wxid_a/x.jpg')
    expect(link !== undefined && 'url' in link).toBe(true)
    if (link === undefined || !('url' in link)) return
    expect(link.url.startsWith('https://rpa.example.test:8443/proxy' + RPA_MEDIA_PATH_PREFIX)).toBe(true)

    const now = Date.now()
    const payload = verifyUrl(link.url, 'token-public', now)
    expect(payload).toMatchObject({ recordId: 42, rel: 'wxid_a/x.jpg' })
    expect(payload?.expiresAt).toBeGreaterThan(now)
    expect(payload?.expiresAt).toBeLessThanOrEqual(now + RPA_MEDIA_DEFAULT_TTL_MS + 5_000)
  })

  it('未配置公网基址时用本机局域网 IPv4 + api_port', () => {
    const gw = gatewayWith({ api_enabled: true, api_port: 5060 }, { api_token: 'token-lan' })
    const link = gw.rpaMediaLinks(7)?.('wxid_a/x.jpg')
    expect(link !== undefined && 'url' in link).toBe(true)
    if (link === undefined || !('url' in link)) return
    expect(link.url.startsWith('http://192.168.50.23:5060' + RPA_MEDIA_PATH_PREFIX)).toBe(true)
    expect(verifyUrl(link.url, 'token-lan', Date.now())?.recordId).toBe(7)
  })

  it('没有可用局域网 IPv4 时明确写 error，而不是生成本机回环链接', () => {
    vi.mocked(networkInterfaces).mockReturnValueOnce({})
    const gw = gatewayWith({ api_enabled: true, api_port: 5032 }, { api_token: 'token-no-ip' })
    expect(gw.rpaMediaLinks(8)?.('wxid_a/x.jpg')).toEqual({
      error: expect.stringContaining('未找到可用的局域网 IPv4'),
    })
  })

  it('非法公网基址只返回可读 error，不生成半成品链接', () => {
    for (const bad of [
      'ftp://rpa.example.test',
      'https://user:pass@rpa.example.test',
      'https://rpa.example.test/?x=1',
      'https://rpa.example.test/#fragment',
    ]) {
      const gw = gatewayWith({
        api_enabled: true,
        api_port: 5032,
        rpa_media_base_url: bad,
      }, { api_token: 'token-bad' })
      const link = gw.rpaMediaLinks(9)?.('wxid_a/x.jpg')
      expect(link, bad).toEqual({ error: expect.stringContaining('rpa_media_base_url') })
    }
  })
})
