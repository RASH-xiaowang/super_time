// @vitest-environment node
/**
 * 消息列表 Webhook 必须展示宿主真正监听的地址与端口。
 *
 * `api_port` 只是首选值，端口冲突时宿主导出会顺延；worker 与宿主是不同进程，
 * 因此这里钉住无凭据 runtime 快照的消费与失效回退。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    networkInterfaces: vi.fn(() => ({
      Ethernet: [{
        address: '192.168.50.23',
        family: 'IPv4',
        mac: 'aa:bb:cc:dd:ee:ff',
        internal: false,
      }],
    })),
  }
})

interface WebhookInfo {
  enabled: boolean
  url: string
  error?: string
}

interface GatewayInternals {
  getMessageListWebhookInfo(): WebhookInfo
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

function gatewayWith(
  cfg: Record<string, unknown>,
  runtime?: Record<string, unknown>,
): GatewayInternals {
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg))
  writeFileSync(join(root, 'secrets.json'), JSON.stringify({ api_token: 'token-runtime' }))
  if (runtime !== undefined) writeFileSync(join(root, 'http-runtime.json'), JSON.stringify(runtime))
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  vi.stubEnv('DSH_WECHAT_BASE_DIR', '')
  return new WechatDataGateway(fakeCtx()) as unknown as GatewayInternals
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gateway-webhook-runtime-'))
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

describe('消息列表 Webhook 运行期地址', () => {
  it('优先使用宿主实际监听的地址与顺延端口', () => {
    const gw = gatewayWith(
      { api_enabled: true, api_port: 5032 },
      {
        version: 1,
        pid: process.pid,
        running: true,
        address: '192.168.50.88',
        port: 5033,
        preferredPort: 5032,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    )
    const info = gw.getMessageListWebhookInfo()
    expect(info.enabled).toBe(true)
    expect(info.url).toMatch(/^http:\/\/192\.168\.50\.88:5033\/api\/message-webhook\//)
  })

  it('停机或宿主进程已退出时回退到配置端口，不广告陈旧快照', () => {
    const stopped = gatewayWith(
      { api_enabled: true, api_port: 5060 },
      {
        version: 1,
        pid: process.pid,
        running: false,
        address: '192.168.50.88',
        port: 5061,
        preferredPort: 5060,
        startedAt: 0,
        updatedAt: Date.now(),
      },
    )
    expect(stopped.getMessageListWebhookInfo().url).toContain('http://192.168.50.23:5060/')

    const crashed = gatewayWith(
      { api_enabled: true, api_port: 5070 },
      {
        version: 1,
        pid: 2_147_483_647,
        running: true,
        address: '192.168.50.88',
        port: 5071,
        preferredPort: 5070,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    )
    expect(crashed.getMessageListWebhookInfo().url).toContain('http://192.168.50.23:5070/')
  })

  it('显式配置的媒体/反代基址仍优先于本机运行期快照', () => {
    const gw = gatewayWith(
      {
        api_enabled: true,
        api_port: 5032,
        rpa_media_base_url: 'https://wechat.example.test/proxy',
      },
      {
        version: 1,
        pid: process.pid,
        running: true,
        address: '192.168.50.88',
        port: 5033,
        preferredPort: 5032,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    )
    expect(gw.getMessageListWebhookInfo().url).toContain('https://wechat.example.test/proxy/api/message-webhook/')
  })
})
