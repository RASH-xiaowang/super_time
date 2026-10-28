/**
 * RPA 图片**签名直链**的宿主侧判据（2026-10-23）。
 *
 * 这些用例真的绑端口、真的发 HTTP：验的是「机器人不带 Cookie 也能取到那一张图」，
 * 以及失败方向（坏令牌必须 404 而不是 401，避免探测者区分出端点存在）。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const {
  RPA_MEDIA_PATH_PREFIX,
  createRpaMediaHandler,
  hostnameOfBaseUrl,
  localIPv4Addresses,
} = require(join(ROOT, 'src', 'backend', 'rpa-media.js')) as {
  RPA_MEDIA_PATH_PREFIX: string
  createRpaMediaHandler: (
    deps: { getDecodedRoot: () => string; getMediaConfig: () => { token: string; mediaBaseUrl?: string } },
    options?: { loadTokenModule?: () => Promise<object> },
  ) => { handleRpaMedia: (res: object, token: string) => Promise<void>; allowedHosts: () => string[] }
  hostnameOfBaseUrl: (baseUrl: string) => string
  localIPv4Addresses: () => string[]
}
const { createRemoteAccessServer } = require(join(ROOT, 'src', 'backend', 'http-server.js')) as {
  createRemoteAccessServer: (deps: {
    getDataRoot: () => string
    getUiDistDir: () => string
    getDecodedRoot: () => string
    gatedCall: (method: string, args: unknown[]) => Promise<unknown>
    appVersion: string
    bindHost?: string
    log?: (...a: unknown[]) => void
    warn?: (...a: unknown[]) => void
  }) => {
    start: () => Promise<{ running: boolean; port: number; address: string }>
    stop: () => Promise<unknown>
  }
}

const TOKEN = 'rpa-media-spec-token'
const scratch: string[] = []
const servers: Array<{ stop: () => Promise<unknown> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()
    try { await s?.stop() } catch { /* 已经停了 */ }
  }
  while (scratch.length > 0) {
    const dir = scratch.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** 动态加载宿主层那份独立小 bundle（与后端同一份源码产出）。 */
async function tokenModule(): Promise<{
  RPA_MEDIA_PATH_PREFIX: string
  RPA_MEDIA_DEFAULT_TTL_MS: number
  rpaMediaTokenKey: (apiToken: string) => Buffer
  signRpaMediaToken: (key: Buffer, payload: { recordId: number; rel: string; expiresAt: number }) => string
  isSafeRpaMediaRel: (rel: unknown) => boolean
}> {
  const file = join(ROOT, 'src', 'backend', 'wechat-data', 'lib', 'net', 'rpa-media.js')
  return import(pathToFileURL(file).href) as Promise<never>
}

let nextPortSeed = 34000
function randomPort(): number {
  nextPortSeed += 1
  return nextPortSeed
}

/** 数据根 + decoded 图片 + 一份原始字节。 */
function fixture(baseUrl = '') {
  const dir = mkdtempSync(join(tmpdir(), 'rpa-media-host-'))
  scratch.push(dir)
  const dataRoot = join(dir, 'wechat-data')
  const uiDist = join(dir, 'ui-dist')
  const decoded = join(dataRoot, 'decoded_images')
  mkdirSync(join(decoded, 'wxid_a'), { recursive: true })
  mkdirSync(uiDist, { recursive: true })
  writeFileSync(join(uiDist, 'index.html'), '<!doctype html>')
  writeFileSync(join(decoded, 'wxid_a', 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  writeFileSync(join(dataRoot, 'config.json'), JSON.stringify({
    api_enabled: true,
    api_port: randomPort(),
    ...(baseUrl === '' ? {} : { rpa_media_base_url: baseUrl }),
  }))
  writeFileSync(join(dataRoot, 'secrets.json'), JSON.stringify({ api_token: TOKEN }))
  return { dir, dataRoot, uiDist, decoded }
}

async function serve(f: ReturnType<typeof fixture>): Promise<string> {
  const srv = createRemoteAccessServer({
    getDataRoot: () => f.dataRoot,
    getUiDistDir: () => f.uiDist,
    getDecodedRoot: () => f.decoded,
    gatedCall: async () => ({ ok: true }),
    appVersion: 'spec',
    bindHost: '127.0.0.1',
    log: () => undefined,
    warn: () => undefined,
  })
  servers.push(srv)
  const state = await srv.start()
  expect(state.running).toBe(true)
  return 'http://127.0.0.1:' + String(state.port)
}

/** 用指定 Host 头请求本地服务器（fetch/undici 对 Host 有额外限制，这里走 node:http）。 */
function requestWithHost(base: string, path: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: 'GET',
      headers: { Host: host },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/rpa-media/<token>：凭据在 URL 里，不要求会话', () => {
  it('有效令牌直接返回图片字节（无 Cookie）', async () => {
    const f = fixture()
    const base = await serve(f)
    const mod = await tokenModule()
    const token = mod.signRpaMediaToken(mod.rpaMediaTokenKey(TOKEN), {
      recordId: 9,
      rel: 'wxid_a/x.jpg',
      expiresAt: Date.now() + mod.RPA_MEDIA_DEFAULT_TTL_MS,
    })
    const res = await fetch(base + RPA_MEDIA_PATH_PREFIX + token)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/jpeg')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  })

  it('坏令牌 / 过期 / 篡改 / 文件不在 / 路径越界一律 404（不是 401）', async () => {
    const f = fixture()
    const base = await serve(f)
    const mod = await tokenModule()
    const key = mod.rpaMediaTokenKey(TOKEN)
    const now = Date.now()
    const valid = mod.signRpaMediaToken(key, { recordId: 9, rel: 'wxid_a/x.jpg', expiresAt: now + 60_000 })
    const expired = mod.signRpaMediaToken(key, { recordId: 9, rel: 'wxid_a/x.jpg', expiresAt: now - 1 })
    const missing = mod.signRpaMediaToken(key, { recordId: 9, rel: 'wxid_a/missing.jpg', expiresAt: now + 60_000 })
    const traversal = mod.signRpaMediaToken(key, { recordId: 9, rel: '../outside.jpg', expiresAt: now + 60_000 })
    const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A')
    for (const token of ['bad-token', expired, missing, traversal, tampered]) {
      const res = await fetch(base + RPA_MEDIA_PATH_PREFIX + encodeURIComponent(token))
      expect(res.status, token.slice(0, 24)).toBe(404)
      expect((await res.json()).error.code).toBe('MEDIA_NOT_FOUND')
    }
  })

  it('非 GET 返回 405（直链只读）', async () => {
    const f = fixture()
    const base = await serve(f)
    const res = await fetch(base + RPA_MEDIA_PATH_PREFIX + 'whatever', { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('配置的公网 Host 只放行图片直链，不放行普通 API', async () => {
    const f = fixture('https://wechat.example.test/proxy')
    const base = await serve(f)
    const mod = await tokenModule()
    const token = mod.signRpaMediaToken(mod.rpaMediaTokenKey(TOKEN), {
      recordId: 9,
      rel: 'wxid_a/x.jpg',
      expiresAt: Date.now() + mod.RPA_MEDIA_DEFAULT_TTL_MS,
    })
    const media = await requestWithHost(base, RPA_MEDIA_PATH_PREFIX + token, 'wechat.example.test')
    expect(media.status).toBe(200)
    const api = await requestWithHost(base, '/api/status', 'wechat.example.test')
    expect(api.status).toBe(421)
    expect(JSON.parse(api.body).error.code).toBe('BAD_HOST')
  })

  it('未配置 api_token 时整条路由等于不存在（直接调用处理器也是 404）', async () => {
    const handler = createRpaMediaHandler({
      getDecodedRoot: () => '',
      getMediaConfig: () => ({ token: '' }),
    })
    let status = 0
    const res = {
      writeHead(code: number) { status = code },
      end() { /* noop */ },
    }
    await handler.handleRpaMedia(res, 'whatever')
    expect(status).toBe(404)
  })
})

describe('Host 例外名单与常量对齐', () => {
  it('两处 RPA_MEDIA_PATH_PREFIX 完全一致', async () => {
    const mod = await tokenModule()
    expect(RPA_MEDIA_PATH_PREFIX).toBe(mod.RPA_MEDIA_PATH_PREFIX)
    expect(RPA_MEDIA_PATH_PREFIX).toBe('/api/rpa-media/')
  })

  it('名单含本机 IPv4 与配置的公网主机名（不含端口/路径）', () => {
    const handler = createRpaMediaHandler({
      getDecodedRoot: () => '',
      getMediaConfig: () => ({ token: TOKEN, mediaBaseUrl: 'https://Wechat.Example.test:8443/base/' }),
    })
    const hosts = handler.allowedHosts()
    expect(hosts).toContain('wechat.example.test')
    for (const ip of localIPv4Addresses()) expect(hosts).toContain(ip)
  })

  it('只接受 http/https 绝对地址作为公网入口', () => {
    expect(hostnameOfBaseUrl('https://wechat.example.test/a')).toBe('wechat.example.test')
    expect(hostnameOfBaseUrl('http://10.0.0.5:8080')).toBe('10.0.0.5')
    expect(hostnameOfBaseUrl('ftp://wechat.example.test')).toBe('')
    expect(hostnameOfBaseUrl('not a url')).toBe('')
    expect(hostnameOfBaseUrl('')).toBe('')
  })
})
