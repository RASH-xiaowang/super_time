/**
 * `http-server.spec.ts` 的共享真端口夹具。
 *
 * 夹具必须在每个用例里生成独立数据根和静态目录；把生命周期数组放在这里，
 * 用例文件只保留断言，避免夹具与端到端断言继续挤在同一个千行文件里。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const require = createRequire(import.meta.url)
const { createRemoteAccessServer } = require(join(ROOT, 'src', 'backend', 'http-server.js')) as {
  createRemoteAccessServer: (deps: {
    getDataRoot: () => string
    getUiDistDir: () => string
    gatedCall: (method: string, args: unknown[]) => Promise<unknown>
    nativeCall?: (action: string, payload: Record<string, unknown>) => Promise<unknown>
    getDecodedRoot?: () => string
    maxSseClients?: number
    maxSsePerSession?: number
    appVersion: string
    bindHost?: string
    callQueue?: {
      run: (task: () => Promise<unknown>, meta?: Record<string, unknown>) => Promise<unknown>
      stats: () => unknown
      drain: (reason: string, channel?: string) => number
    }
    authLimiter?: {
      ok: (ip: string) => boolean
      fail: (ip: string) => void
      succeed: (ip: string) => void
      reset: () => void
    }
    log?: (...a: unknown[]) => void
    warn?: (...a: unknown[]) => void
  }) => {
    start: () => Promise<State>
    stop: () => Promise<State>
    getState: () => State
    syncWithConfig: () => Promise<State>
    pushEvent: (name: string, args: unknown[]) => void
    isRunning: () => boolean
    issuePairingCode: (options?: { fullAccess?: boolean }) => string
  }
}

export interface State {
  running: boolean
  port: number
  configuredPort: number
  address: string
  enabled: boolean
  hasToken: boolean
  tokenMasked: string
  pairingCodes?: number
  sseClients?: number
}

export const TOKEN = 'spec-token-0123456789abcdef'
export const scratch: string[] = []
export const servers: Array<{ stop: () => Promise<unknown> }> = []

export async function cleanupFixtures(): Promise<void> {
  while (servers.length > 0) {
    const s = servers.pop()
    try { await s?.stop() } catch { /* 已经停了 */ }
  }
  while (scratch.length > 0) {
    const p = scratch.pop()
    if (p) { try { rmSync(p, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  }
}

/**
 * 取一个**本进程内不重复**的高位端口。
 *
 * 端口只负责减少本进程内碰撞；被其他进程占用时仍由服务自身的 11 次顺移兜底。
 * 不使用同步子进程或随机猜测，避免 CI 上的结构性抖动。
 */
let nextPortSeed = 30000
export function randomPort(): number {
  nextPortSeed += 1
  return nextPortSeed
}

/** 搭一份「数据根 + 静态目录」的夹具。 */
export function fixture(opts: {
  enabled?: boolean
  token?: string
  port?: number
  maxSseClients?: number
  maxSsePerSession?: number
  getUiDistDir?: () => string
  callQueue?: {
    run: (task: () => Promise<unknown>, meta?: Record<string, unknown>) => Promise<unknown>
  }
  nativeCall?: (action: string, payload: Record<string, unknown>) => Promise<unknown>
  gatedCall?: (method: string, args: unknown[]) => Promise<unknown>
  authLimiter?: {
    ok: (ip: string) => boolean
    fail: (ip: string) => void
    succeed: (ip: string) => void
    reset: () => void
  }
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ra-spec-'))
  scratch.push(dir)
  const dataRoot = join(dir, 'wechat-data')
  const uiDist = join(dir, 'ui-dist')
  const decodedDir = join(dataRoot, 'decoded_images')
  mkdirSync(join(decodedDir, 'wxid_a'), { recursive: true })
  writeFileSync(join(decodedDir, 'wxid_a', 'x.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(join(uiDist, 'assets'), { recursive: true })
  writeFileSync(join(dataRoot, 'config.json'), JSON.stringify({
    api_enabled: opts.enabled ?? true,
    api_port: opts.port ?? randomPort(),
  }))
  const token = opts.token === undefined ? TOKEN : opts.token
  if (token !== '') writeFileSync(join(dataRoot, 'secrets.json'), JSON.stringify({ api_token: token }))
  writeFileSync(join(uiDist, 'index.html'), '<!doctype html><title>probe</title>')
  writeFileSync(join(uiDist, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'outside.txt'), 'SECRET-OUTSIDE')

  const calls: string[] = []
  const srv = createRemoteAccessServer({
    getDataRoot: () => dataRoot,
    getUiDistDir: opts.getUiDistDir ?? (() => uiDist),
    getDecodedRoot: () => decodedDir,
    ...(opts.maxSseClients === undefined ? {} : { maxSseClients: opts.maxSseClients }),
    ...(opts.maxSsePerSession === undefined ? {} : { maxSsePerSession: opts.maxSsePerSession }),
    ...(opts.callQueue
      ? {
          callQueue: {
            ...opts.callQueue,
            stats: () => ({ active: 0, queued: 0 }),
            drain: () => 0,
          },
        }
      : {}),
    gatedCall: async (method, args) => {
      calls.push(method)
      return opts.gatedCall
        ? opts.gatedCall(method, args)
        : { ok: true, value: { method, args } }
    },
    ...(opts.nativeCall ? { nativeCall: opts.nativeCall } : {}),
    appVersion: 'spec',
    bindHost: '127.0.0.1',
    authLimiter: opts.authLimiter,
    log: () => undefined,
    warn: () => undefined,
  })
  servers.push(srv)
  return { srv, calls, dataRoot, uiDist, outside: join(dir, 'outside.txt') }
}

/** 手工发 GET，让用例可以控制 Host 头（浏览器 fetch 不允许伪造这一项）。 */
export function rawGet(
  base: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return rawRequest(base, { method: 'GET', headers })
}

/** 手工发请求，让用例可以控制 Host/Origin 与不可由 fetch 设置的头部。 */
export function rawRequest(
  base: string,
  options: {
    method: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const body = options.body ?? ''
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method,
      setHost: false,
      headers: {
        Connection: 'close',
        ...(body === '' ? {} : { 'Content-Length': String(Buffer.byteLength(body)) }),
        ...options.headers,
      },
    }, (res) => {
      res.setEncoding('utf8')
      let responseBody = ''
      res.on('data', (chunk) => { responseBody += String(chunk) })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: responseBody,
        headers: res.headers,
      }))
    })
    req.on('error', reject)
    if (body !== '') req.write(body)
    req.end()
  })
}
