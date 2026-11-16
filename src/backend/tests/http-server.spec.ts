/**
 * 局域网远程访问（手机端）HTTP 服务的**端到端**判据 —— 真的绑端口、真的发请求。
 *
 * ## 为什么要真起服务而不是打桩
 *
 * 这一层的失效方式几乎全在「协议接缝」上：Cookie 属性写错一个字母、SSE 少一个换行、
 * 401 写成 200、`Set-Cookie` 没被浏览器接受 —— 打桩测不出来，因为它们测的是我以为的逻辑，
 * 而不是 node:http 与真实字节流之间的行为。手机在另一台设备上，出问题没法现场调，
 * 所以这里宁可慢一点也要走真链路。
 *
 * 静态资源用**临时夹具目录**而不是真实的 `src/client/ui-dist`：后者要先跑 `build:ui`
 * 才存在，把这条判据绑在构建产物上会让它在 CI 里时有时无。
 *
 * ## 这里钉住的几条「不许静默失效」
 *
 *   ① **默认不监听**：`api_enabled` 与令牌**两个条件都要成立**。老配置里遗留的
 *      `api_enabled: true`（N24 之前界面还暴露这个键时写下的）不能把端口打开。
 *   ② **白名单在闸门之前**：被拒的方法连 `gatedCall` 都不许进 —— 否则远程端的探测
 *      会在后端留下调用痕迹，而「拒绝」也只是拒绝在更后面一层。
 *   ③ **令牌原文永不出现在任何响应里**（逐个端点扫一遍响应体）。
 *   ④ **SSE 的 payload 形状与 IPC 的 `wechat:event` 完全一致** —— 渲染层因此能共用同一套
 *      分发逻辑，WAL 实时刷新链在手机上与桌面端同样即时。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createNodeServer, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupFixtures,
  fixture,
  randomPort,
  rawGet,
  rawRequest,
  scratch,
  servers,
  TOKEN,
  type State,
} from './helpers/http-server-fixture.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const nodeFs = require('node:fs') as typeof import('node:fs')
const { createAuthLimiter, createRemoteAccessServer, REQUEST_TIMEOUT_MS, isHostAllowed, lanAddresses } = require(join(ROOT, 'src', 'backend', 'http-server.js')) as {
  createAuthLimiter: () => {
    ok: (ip: string) => boolean
    fail: (ip: string) => void
    succeed: (ip: string) => void
    reset: () => void
  }
  createRemoteAccessServer: (deps: {
    getDataRoot: () => string
    getUiDistDir: () => string
    gatedCall: (method: string, args: unknown[]) => Promise<unknown>
    nativeCall?: (action: string, payload: Record<string, unknown>) => Promise<unknown>
    getDecodedRoot?: () => string
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
  REQUEST_TIMEOUT_MS: number
  isHostAllowed: (authority: string | undefined, expectedAddress: string, expectedPort: number) => boolean
  lanAddresses: () => Array<{ address: string, family: string, iface: string }>
}
const DEFERRED_MUTATION = require(join(ROOT, 'src', 'backend', 'mutation-gate.js')) as {
  bumpMutationEpoch: (reason: string) => number
  mutationGateStats: () => { lastBumpReason: string }
  resetMutationGate: () => void
  setMutationGateMode: (mode: 'shadow' | 'enforce') => void
}
afterEach(async () => {
  DEFERRED_MUTATION.setMutationGateMode('shadow')
  DEFERRED_MUTATION.resetMutationGate()
  await cleanupFixtures()
})

/** 启动并返回 base URL。 */
async function up(f: ReturnType<typeof fixture>): Promise<string> {
  const st = await f.srv.start()
  expect(st.running, '夹具默认应当能启动（api_enabled + 令牌都给了）').toBe(true)
  return `http://127.0.0.1:${String(st.port)}`
}

/** 用令牌换会话，返回 Cookie 串。 */
async function login(base: string, token: string = TOKEN): Promise<string> {
  const r = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(r.status, '令牌正确时应当换取到会话').toBe(200)
  const setCookie = r.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0] ?? ''
}

/** 轮询等待一个同步条件（连接关闭、队列出队等都不是同一 tick 内完成的）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 发送 JSON 请求；浏览器桥与生产客户端都使用同一媒体类型。 */
function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('默认不监听：两个条件都要成立', () => {
  it('api_enabled=true 但**没有令牌** → 不监听（老配置遗留的 true 不能把端口打开）', async () => {
    const f = fixture({ token: '' })
    const st = await f.srv.start()
    expect(st.running, '没有令牌却开始监听了 —— N24 之前那批用户的端口会被静默打开').toBe(false)
    expect(st.hasToken).toBe(false)
  })

  it('api_enabled=false（即使有令牌）→ 不监听', async () => {
    const f = fixture({ enabled: false })
    const st = await f.srv.start()
    expect(st.running).toBe(false)
  })

  it('停止状态仍返回配置端口，供防火墙指引用（当前监听端口为 0）', () => {
    const f = fixture({ enabled: false, port: 5471 })
    const st = f.srv.getState()
    expect(st.running).toBe(false)
    expect(st.port).toBe(0)
    expect(st.configuredPort).toBe(5471)
  })

  it('两个条件都成立 → 监听，并报出实际端口与地址', async () => {
    const f = fixture()
    const st = await f.srv.start()
    expect(st.running).toBe(true)
    expect(st.port).toBeGreaterThan(0)
    expect(st.address).toBe('127.0.0.1')
    expect(st.tokenMasked, '状态里只该有掩码').not.toContain(TOKEN)
  })

  it('首选端口被占用时，无凭据监听快照记录顺延后的实际端口', async () => {
    const blocker = createNodeServer((_req, res) => res.end())
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    if (address === null || typeof address === 'string') throw new Error('测试占位服务没有拿到 TCP 端口')
    const preferredPort = address.port
    try {
      const f = fixture({ port: preferredPort })
      const st = await f.srv.start()
      expect(st.running).toBe(true)
      expect(st.port).toBe(preferredPort + 1)
      const snapshot = JSON.parse(readFileSync(join(f.dataRoot, 'http-runtime.json'), 'utf8')) as Record<string, unknown>
      expect(snapshot).toMatchObject({
        version: 1,
        pid: process.pid,
        running: true,
        address: '127.0.0.1',
        port: st.port,
        preferredPort,
      })
      expect(JSON.stringify(snapshot)).not.toContain(TOKEN)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('停止监听后快照立即标记为未运行，避免崩溃窗口暴露旧端口', async () => {
    const f = fixture()
    await up(f)
    await f.srv.stop()
    const snapshot = JSON.parse(readFileSync(join(f.dataRoot, 'http-runtime.json'), 'utf8')) as Record<string, unknown>
    expect(snapshot).toMatchObject({ running: false, address: '', port: 0, startedAt: 0 })
  })

  it('syncWithConfig：界面关掉开关后立刻停止监听，再打开又起来', async () => {
    const f = fixture()
    await up(f)
    expect(f.srv.isRunning()).toBe(true)
    writeFileSync(join(f.dataRoot, 'config.json'), JSON.stringify({ api_enabled: false, api_port: 5099 }))
    const off = await f.srv.syncWithConfig()
    expect(off.running, '配置关了还在监听').toBe(false)
    writeFileSync(join(f.dataRoot, 'config.json'), JSON.stringify({ api_enabled: true, api_port: 5099 }))
    writeFileSync(join(f.dataRoot, 'secrets.json'), JSON.stringify({ api_token: TOKEN }))
    const on = await f.srv.syncWithConfig()
    expect(on.running).toBe(true)
  })

  it('并发 start() 只产生一个监听句柄（第二次入队后吃到「已在跑」的状态）', async () => {
    const f = fixture()
    const httpAny = require('node:http') as {
      createServer: (...args: unknown[]) => unknown
    }
    const original = httpAny.createServer
    let created = 0
    httpAny.createServer = (...args: unknown[]) => {
      created += 1
      return original(...args)
    }
    try {
      const [a, b] = await Promise.all([f.srv.start(), f.srv.start()])
      expect(a.running, '第一次并发启动应当成功').toBe(true)
      expect(b.running, '第二次并发启动应当复用第一次的结果').toBe(true)
      expect(a.port, '两次并发启动不该各绑一个端口').toBe(b.port)
      expect(created, '没有串行化时两次 start() 会各自 createServer').toBe(1)
    } finally {
      httpAny.createServer = original
    }
  })

  it('并发 syncWithConfig() 碰到端口变更只重绑一次', async () => {
    const f = fixture()
    await up(f)
    const nextPort = randomPort()
    writeFileSync(join(f.dataRoot, 'config.json'), JSON.stringify({ api_enabled: true, api_port: nextPort }))
    const httpAny = require('node:http') as {
      createServer: (...args: unknown[]) => unknown
    }
    const original = httpAny.createServer
    let created = 0
    httpAny.createServer = (...args: unknown[]) => {
      created += 1
      return original(...args)
    }
    try {
      const [a, b] = await Promise.all([f.srv.syncWithConfig(), f.srv.syncWithConfig()])
      expect(a.running, '第一次配置同步后应当正在监听').toBe(true)
      expect(b.running, '第二次配置同步后应当仍然在监听').toBe(true)
      expect(a.port, '两次并发同步最终必须落在同一个端口').toBe(b.port)
      expect(created, '没有串行化时 stop→start 会被并发执行两次').toBe(1)
    } finally {
      httpAny.createServer = original
    }
  })
})

describe('默认绑定地址：物理网卡优先，虚拟网卡与 APIPA 排后', () => {
  function addressesOf(networkInterfaces: Record<string, Array<Record<string, unknown>>>): Array<{ iface: string, address: string }> {
    const os = require('node:os') as { networkInterfaces: () => Record<string, Array<Record<string, unknown>>> }
    const original = os.networkInterfaces
    os.networkInterfaces = () => networkInterfaces
    try {
      return lanAddresses().map((a) => ({ iface: a.iface, address: a.address }))
    } finally {
      os.networkInterfaces = original
    }
  }

  it('vEthernet 排在前面时，仍优先选 WLAN', () => {
    const out = addressesOf({
      'vEthernet (Default Switch)': [{ address: '172.16.1.10', family: 'IPv4', internal: false, mac: '00:15:5d:00:00:01' }],
      'WLAN': [{ address: '192.168.1.10', family: 'IPv4', internal: false, mac: 'aa:bb:cc:00:00:01' }],
    })
    expect(out[0]?.iface, '默认候选不该落到 Hyper-V 虚拟网卡').toBe('WLAN')
  })

  it('APIPA 地址不抢正常局域网地址', () => {
    const out = addressesOf({
      '以太网 2': [{ address: '169.254.77.1', family: 'IPv4', internal: false, mac: '00:11:22:33:44:01' }],
      '以太网': [{ address: '192.168.50.20', family: 'IPv4', internal: false, mac: '00:11:22:33:44:02' }],
    })
    expect(out[0]?.address).toBe('192.168.50.20')
    expect(out[1]?.address).toBe('169.254.77.1')
  })

  it('只有虚拟网卡时仍保留候选（不因排序把可达性判断藏起来）', () => {
    const out = addressesOf({
      'VMware Network Adapter': [{ address: '172.20.0.5', family: 'IPv4', internal: false, mac: '00:50:56:00:00:01' }],
      'vEthernet (WSL)': [{ address: '172.24.0.5', family: 'IPv4', internal: false, mac: '00:15:5d:00:00:02' }],
    })
    expect(out).toHaveLength(2)
    expect(out.map((a) => a.iface)).toContain('VMware Network Adapter')
    expect(out.map((a) => a.iface)).toContain('vEthernet (WSL)')
  })
})

describe('连接资源上限：长任务响应不能超时，慢请求接收必须有硬时限', () => {
  it('socket 空闲超时保留为 0，但 requestTimeout 有有限值', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})

describe('Host 头校验：挡住 DNS rebinding', () => {
  it('纯函数只认当前监听 IP；回环额外认 localhost，局域网 IP 不接受别名', () => {
    expect(isHostAllowed('127.0.0.1:5032', '127.0.0.1', 5032)).toBe(true)
    expect(isHostAllowed('LOCALHOST:5032', '127.0.0.1', 5032)).toBe(true)
    expect(isHostAllowed('127.0.0.1', '127.0.0.1', 5032), '省略端口时主机名仍要匹配').toBe(true)
    expect(isHostAllowed('attacker.example:5032', '127.0.0.1', 5032), '域名别名不能伪装成监听地址').toBe(false)
    expect(isHostAllowed('127.0.0.1:5033', '127.0.0.1', 5032), '显式端口必须等于实际端口').toBe(false)
    expect(isHostAllowed('127.0.0.1:abc', '127.0.0.1', 5032)).toBe(false)
    expect(isHostAllowed(undefined, '127.0.0.1', 5032)).toBe(false)
    expect(isHostAllowed('localhost:5032', '192.168.1.10', 5032), '局域网地址不接受主机名别名').toBe(false)
  })

  it('带别的域名 Host 的静态与 /api/auth 请求都在路由前拒绝，不进后端', async () => {
    const f = fixture()
    const base = await up(f)
    for (const path of ['/', '/api/auth']) {
      const r = await rawGet(base + path, { Host: 'attacker.example' })
      expect(r.status, `${path} 带错 Host 应当回 421`).toBe(421)
      expect(JSON.parse(r.body).error?.code).toBe('BAD_HOST')
    }
    expect(f.calls, '被 Host 拦下的请求不该碰 gatedCall').toEqual([])
  })

  it('缺失 Host（HTTP/1.1 不允许的裸请求）在进路由前就被协议层拒绝', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await rawGet(base + '/api/status', {})
    expect(r.status).toBe(400)
    expect(f.calls).toEqual([])
  })
})

describe('静态资源：不需要会话，但读不出根目录', () => {
  it('未授权也能拿到 index.html 与产物（数据全在 /api/* 后面）', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(await r.text()).toContain('probe')
    const js = await fetch(`${base}/assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
  })

  it('HTML 响应带框架隔离与 CSP；HEAD 与 GET 的 MIME/长度一致且无响应体', async () => {
    const f = fixture()
    const base = await up(f)
    const html = await fetch(`${base}/`)
    expect(html.headers.get('x-frame-options')).toBe('DENY')
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(html.headers.get('permissions-policy')).toContain('camera=()')

    const get = await fetch(`${base}/assets/app.js`)
    const getBody = await get.text()
    expect(get.headers.get('content-length')).toBe(String(Buffer.byteLength(getBody)))
    const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toContain('javascript')
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(await head.text()).toBe('')
  })

  it('入口 no-cache、带哈希的产物可长缓存（否则升级后手机加载旧 JS → 白屏）', async () => {
    const f = fixture()
    const base = await up(f)
    expect((await fetch(`${base}/`)).headers.get('cache-control')).toBe('no-cache')
    expect((await fetch(`${base}/assets/app.js`)).headers.get('cache-control')).toContain('immutable')
  })

  it('路径穿越一律 404，根目录外的文件读不到', async () => {
    const f = fixture()
    const base = await up(f)
    for (const p of ['/../../outside.txt', '/..%2f..%2foutside.txt', '/%2e%2e/%2e%2e/outside.txt', '/assets/../../outside.txt']) {
      const r = await fetch(base + p)
      const body = await r.text()
      expect(body, `穿越路径 ${p} 竟然读到了根目录外的内容`).not.toContain('SECRET-OUTSIDE')
      expect([404, 400], `穿越路径 ${p} 应当被拒（拿到 ${String(r.status)}）`).toContain(r.status)
    }
  })

  it('不存在的资源 404；PUT/DELETE 405', async () => {
    const f = fixture()
    const base = await up(f)
    expect((await fetch(`${base}/nope.html`)).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'PUT' })).status).toBe(405)
    expect((await fetch(`${base}/`, { method: 'DELETE' })).status).toBe(405)
  })
})

describe('鉴权：令牌换会话', () => {
  it('没有会话时所有 /api/* 都是 401（不是 403 —— 不透露端点存在）', async () => {
    const f = fixture()
    const base = await up(f)
    for (const [path, method] of [['/api/wechat/call', 'POST'], ['/api/capabilities', 'GET'], ['/api/wechat/events', 'GET'], ['/api/status', 'GET']] as const) {
      const r = await fetch(base + path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(r.status, `${path} 未授权应回 401`).toBe(401)
      expect((await r.json()).error?.code).toBe('UNAUTHORIZED')
    }
    expect(f.calls, '未授权的请求不该碰到后端').toEqual([])
  })

  it('错令牌 → 401 BAD_TOKEN，且不下发 Cookie', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await postJson(`${base}/api/auth`, { token: 'wrong' })
    expect(r.status).toBe(401)
    expect((await r.json()).error?.code).toBe('BAD_TOKEN')
    expect(r.headers.get('set-cookie'), '失败的登录不该下发会话').toBeNull()
  })

  it('空令牌 / 缺字段 / 非字符串 → 401（空令牌绝不能匹配成功）', async () => {
    const f = fixture()
    const base = await up(f)
    for (const body of [{ token: '' }, {}, { token: null }, { token: 123 }, { token: [TOKEN] }]) {
      const r = await postJson(`${base}/api/auth`, body)
      expect(r.status, `${JSON.stringify(body)} 竟然登录成功了`).toBe(401)
    }
  })

  it('对令牌 → 200 + HttpOnly/SameSite 会话 Cookie', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await postJson(`${base}/api/auth`, { token: TOKEN })
    expect(r.status).toBe(200)
    const c = r.headers.get('set-cookie') ?? ''
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).not.toContain('Secure') // 明文 HTTP 下加了 Secure 会让 Cookie 完全不生效
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    const value = (await r.json()).value as { version: string, native: Record<string, boolean>, tokenMasked: string }
    expect(value.version).toBe('spec')
    expect(value.native.titlebar).toBe(false)
    expect(value.tokenMasked).not.toContain(TOKEN)
  })

  it('非 JSON Content-Type → 415（即使 body 本身是合法 JSON）', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(r.status).toBe(415)
    expect((await r.json()).error?.code).toBe('BAD_REQUEST')
  })

  it('浏览器 Origin 必须与当前 Host 同源；Origin:null 也拒绝', async () => {
    const f = fixture()
    const base = await up(f)
    const host = new URL(base).host
    const body = JSON.stringify({ token: TOKEN })
    for (const origin of ['http://attacker.example', 'http://127.0.0.1:1', 'null']) {
      const r = await rawRequest(`${base}/api/auth`, {
        method: 'POST',
        headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' },
        body,
      })
      expect(r.status, `Origin=${origin} 不应进入令牌校验`).toBe(403)
      expect(JSON.parse(r.body).error?.code).toBe('ORIGIN_DENIED')
    }
    const sameOrigin = await rawRequest(`${base}/api/auth`, {
      method: 'POST',
      headers: { Host: host, Origin: base, 'Content-Type': 'application/json' },
      body,
    })
    expect(sameOrigin.status).toBe(200)
  })

  it('新配对码能登录且只许用一次，长期令牌仍可登录', async () => {
    const f = fixture()
    const base = await up(f)
    const code = f.srv.issuePairingCode()
    expect(typeof code).toBe('string')
    expect(f.srv.getState().pairingCodes).toBe(1)

    const first = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
    })
    expect(first.status, '新签发的配对码应当能换取会话').toBe(200)
    expect(f.srv.getState().pairingCodes, '配对码成功消费后应当立即消失').toBe(0)

    const second = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
    })
    expect(second.status, '同一个配对码第二次登录必须失败').toBe(401)
    expect((await second.json()).error?.code).toBe('BAD_TOKEN')

    const longToken = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(longToken.status, '长期令牌仍然应该能登录').toBe(200)
  })

  it('登录成功只重置当前 IP 的限速记录（不能清掉其他来源的失败窗口）', async () => {
    const calls: string[] = []
    const authLimiter = {
      ok: () => true,
      fail: () => { calls.push('fail') },
      succeed: (ip: string) => { calls.push(`succeed:${ip}`) },
      reset: () => { calls.push('reset') },
    }
    const f = fixture({ authLimiter })
    const base = await up(f)
    await login(base)
    expect(calls, '登录成功路径应当调用 succeed(ip)').toContain('succeed:127.0.0.1')
    expect(calls, '登录成功路径绝不能调用 reset() —— 那会清掉其他 IP 的失败记录').not.toContain('reset')
  })

  it('stop() 作废未消费的配对码（停服后旧码不能复活）', async () => {
    const f = fixture()
    const base = await up(f)
    const code = f.srv.issuePairingCode()
    await f.srv.stop()
    const st = await f.srv.start()
    const restartedBase = `http://127.0.0.1:${String(st.port)}`
    const r = await fetch(`${restartedBase}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
    })
    expect(r.status, '停服前签发、停服后重启用同一码竟然还能登录').toBe(401)
  })

  it('令牌试错超过上限 → 429（挡掉脚本乱撞）', async () => {
    const f = fixture()
    const base = await up(f)
    let saw429 = false
    for (let i = 0; i < 12; i += 1) {
      const r = await postJson(`${base}/api/auth`, { token: `bad-${String(i)}` })
      if (r.status === 429) { saw429 = true; break }
    }
    expect(saw429, '连续试错 12 次都没被限速').toBe(true)
  })
})

describe('登录限速：成功只清当前 IP，不帮别的 IP 洗白', () => {
  it('succeed(ip) 只删除该 IP 的失败窗口，其他来源的计数必须保留', () => {
    const limiter = createAuthLimiter()
    const attacker = '10.0.0.9'
    const other = '10.0.0.10'
    for (let i = 0; i < 8; i += 1) limiter.fail(attacker)
    for (let i = 0; i < 8; i += 1) limiter.fail(other)
    expect(limiter.ok(attacker), '同一 IP 失败 8 次后应被限速').toBe(false)

    limiter.succeed(attacker)
    expect(limiter.ok(attacker), '成功登录后当前 IP 的失败窗口应当清零').toBe(true)
    expect(limiter.ok(other), '一次成功登录不应清掉其他来源 IP 的失败记录').toBe(false)
  })
})

describe('调用：白名单在闸门之前，信封原样透传', () => {
  it('白名单内的方法 → 进后端，信封原样回给调用方', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const r = await fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getSessions', args: [{ page: 2 }] }),
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, value: { method: 'getSessions', args: [{ page: 2 }] } })
    expect(f.calls).toEqual(['getSessions'])
  })

  it('白名单外的方法 → METHOD_NOT_ALLOWED_REMOTE，且**根本没进后端**', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    for (const m of ['getWechatConfig', 'saveWechatConfig', 'createBackup', 'openPath', 'clearPrivacyAudit']) {
      const r = await fetch(`${base}/api/wechat/call`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: m, args: [] }),
      })
      const j = await r.json() as { ok: boolean, error?: { code?: string, message?: string } }
      expect(j.ok, `${m} 竟然被放行了`).toBe(false)
      expect(j.error?.code).toBe('METHOD_NOT_ALLOWED_REMOTE')
      expect(j.error?.message, '错误信息要能让界面显示「仅桌面端可用」').toContain('不开放远程访问')
    }
    expect(f.calls, '被拒的方法不该碰到后端（否则远程探测会在后端留下调用痕迹）').toEqual([])
  })

  it('HTTP 连接在搜索途中断开 → 按 jobId 发出一次 cancelSearch', async () => {
    let searchStarted!: () => void
    let releaseSearch!: (value: unknown) => void
    let cancelSeen!: (args: unknown[]) => void
    const started = new Promise<void>((resolve) => { searchStarted = resolve })
    const searchDone = new Promise<unknown>((resolve) => { releaseSearch = resolve })
    const canceled = new Promise<unknown[]>((resolve) => { cancelSeen = resolve })
    const f = fixture({
      gatedCall: async (method, args) => {
        if (method === 'searchUnified') {
          searchStarted()
          return searchDone
        }
        if (method === 'cancelSearch') {
          cancelSeen(args)
          return { ok: true, value: { ok: true } }
        }
        return { ok: true, value: { method, args } }
      },
    })
    const base = await up(f)
    const cookie = await login(base)
    const ac = new AbortController()
    const requestOutcome = fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'searchUnified', args: [{ query: 'needle', jobId: 'disconnect-1' }] }),
      signal: ac.signal,
    }).then(() => 'response', () => 'aborted')

    await started
    ac.abort()
    await expect(canceled).resolves.toEqual([{ jobId: 'disconnect-1' }])
    releaseSearch({ ok: true, value: { cancelled: true } })
    await expect(requestOutcome).resolves.toBe('aborted')
    expect(f.calls, '断连取消只能发一次，且必须指向原 search job').toEqual(['searchUnified', 'cancelSearch'])
  })

  it('搜索仍在队列中时断连 → 出队后不再启动 worker 搜索', async () => {
    let releaseQueue!: () => void
    const queued = new Promise<void>((resolve) => { releaseQueue = resolve })
    let enteredQueue!: () => void
    const inQueue = new Promise<void>((resolve) => { enteredQueue = resolve })
    const f = fixture({
      callQueue: {
        run: async (task) => {
          enteredQueue()
          await queued
          return task()
        },
      },
    })
    const base = await up(f)
    const cookie = await login(base)
    const ac = new AbortController()
    const requestOutcome = fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'searchUnified', args: [{ query: 'needle', jobId: 'queued-disconnect-1' }] }),
      signal: ac.signal,
    }).then(() => 'response', () => 'aborted')

    await inQueue
    ac.abort()
    const deadline = Date.now() + 2_000
    while (!f.calls.includes('cancelSearch') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(f.calls, '服务端应先观察到断连并发出取消').toContain('cancelSearch')
    releaseQueue()
    await expect(requestOutcome).resolves.toBe('aborted')
    expect(f.calls, '已断连的排队搜索不应再进入 worker').toEqual(['cancelSearch'])
  })

  it('断连早于 worker job 注册 → 释放闸门后重放取消，且不重复取消已确认的 job', async () => {
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    let enteredGate!: () => void
    const inGate = new Promise<void>((resolve) => { enteredGate = resolve })
    let firstCancelSeen!: () => void
    const firstCancel = new Promise<void>((resolve) => { firstCancelSeen = resolve })
    let retryCancelSeen!: () => void
    const retriedCancel = new Promise<void>((resolve) => { retryCancelSeen = resolve })
    let aborted!: () => void
    const searchAborted = new Promise<void>((resolve) => { aborted = resolve })
    let searchFinished!: () => void
    const searchDone = new Promise<void>((resolve) => { searchFinished = resolve })
    let registered = false
    let expensiveSearchStarted = false
    let cancelAttempts = 0

    const f = fixture({
      gatedCall: async (method, args) => {
        if (method === 'searchUnified') {
          enteredGate()
          await gate
          // 模拟 gatedCall 已返回、worker 此刻才注册 job；真实查询必须等取消信号。
          registered = true
          const cancelledBeforeWork = await Promise.race([
            searchAborted.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
          ])
          if (!cancelledBeforeWork) expensiveSearchStarted = true
          searchFinished()
          return { ok: true, value: { cancelled: true } }
        }
        if (method === 'cancelSearch') {
          cancelAttempts += 1
          if (cancelAttempts === 1) {
            firstCancelSeen()
            expect(args).toEqual([{ jobId: 'gate-disconnect-1' }])
            return { ok: true, value: { ok: false } }
          }
          retryCancelSeen()
          expect(registered, '取消重放应发生在 worker 注册 job 之后').toBe(true)
          aborted()
          return { ok: true, value: { ok: true } }
        }
        return { ok: true, value: { method, args } }
      },
    })
    const base = await up(f)
    const cookie = await login(base)
    const ac = new AbortController()
    const requestOutcome = fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'searchUnified', args: [{ query: 'needle', jobId: 'gate-disconnect-1' }] }),
      signal: ac.signal,
    }).then(() => 'response', () => 'aborted')

    await inGate
    ac.abort()
    await firstCancel
    releaseGate()
    await retriedCancel
    await Promise.race([
      searchDone,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('取消重放未终止搜索')), 2_000)),
    ])
    await expect(requestOutcome).resolves.toBe('aborted')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(expensiveSearchStarted, '真实查询不应在取消确认后继续执行').toBe(false)
    expect(cancelAttempts, '取消成功确认后不得继续重放').toBe(2)
    expect(f.calls).toEqual(['searchUnified', 'cancelSearch', 'cancelSearch'])
  })

  it('未知方法 / 缺 method / args 不是数组 → 一律拒或规整，不抛', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const post = async (body: unknown) => {
      const r = await fetch(`${base}/api/wechat/call`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return r.json() as Promise<{ ok: boolean, error?: { code?: string }, value?: unknown }>
    }
    expect((await post({ method: 'noSuchMethod', args: [] })).error?.code).toBe('METHOD_NOT_ALLOWED_REMOTE')
    expect((await post({ args: [] })).error?.code).toBe('METHOD_NOT_ALLOWED_REMOTE')
    expect((await post({})).error?.code).toBe('METHOD_NOT_ALLOWED_REMOTE')
    // args 不是数组时规整成 []（远程端是不可信输入，不能把非数组塞进后端）
    const j = await post({ method: 'getSessions', args: 'not-an-array' })
    expect(j).toEqual({ ok: true, value: { method: 'getSessions', args: [] } })
    expect(f.calls).toEqual(['getSessions'])
  })

  it('后端返回的错误信封原样透传（界面靠 code 分辨「没就绪」与「被拒」）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ra-spec-err-'))
    scratch.push(dir)
    const dataRoot = join(dir, 'd'); const ui = join(dir, 'u')
    mkdirSync(dataRoot, { recursive: true }); mkdirSync(ui, { recursive: true })
    writeFileSync(join(dataRoot, 'config.json'), JSON.stringify({ api_enabled: true, api_port: randomPort() }))
    writeFileSync(join(dataRoot, 'secrets.json'), JSON.stringify({ api_token: TOKEN }))
    writeFileSync(join(ui, 'index.html'), '<!doctype html>')
    const srv = createRemoteAccessServer({
      getDataRoot: () => dataRoot,
      getUiDistDir: () => ui,
      gatedCall: async () => ({ ok: false, error: { message: '后端仍在启动中', code: 'BACKEND_NOT_READY', details: { method: 'getSessions' } } }),
      appVersion: 'spec', bindHost: '127.0.0.1', log: () => undefined, warn: () => undefined,
    })
    servers.push(srv)
    const st = await srv.start()
    const base = `http://127.0.0.1:${String(st.port)}`
    const cookie = await login(base)
    const r = await fetch(`${base}/api/wechat/call`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'getSessions', args: [] }),
    })
    expect(await r.json()).toEqual({ ok: false, error: { message: '后端仍在启动中', code: 'BACKEND_NOT_READY', details: { method: 'getSessions' } } })
  })

  it('请求体不是合法 JSON → 400，不是 500', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const r = await fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error?.code).toBe('BAD_REQUEST')
  })

  it('非 JSON Content-Type 与错误 Origin 在进后端前被拒', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const host = new URL(base).host
    const body = JSON.stringify({ method: 'getSessions', args: [] })

    const text = await rawRequest(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { Host: host, Cookie: cookie, 'Content-Type': 'text/plain' },
      body,
    })
    expect(text.status).toBe(415)

    const crossOrigin = await rawRequest(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: {
        Host: host,
        Origin: 'http://attacker.example',
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body,
    })
    expect(crossOrigin.status).toBe(403)
    expect(JSON.parse(crossOrigin.body).error?.code).toBe('ORIGIN_DENIED')
    expect(f.calls, '被媒体类型/Origin 守卫拒绝的请求不能进入后端').toEqual([])
  })

  it('没有这个接口 → 404（授权之后才判路由，不透露端点清单）', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const r = await fetch(`${base}/api/nope`, { headers: { cookie } })
    expect(r.status).toBe(404)
    expect((await r.json()).error?.code).toBe('NO_ROUTE')
  })
})

describe('SSE 事件流：形状必须与 IPC 的 wechat:event 一致', () => {
  it('连上先补一帧 ready；pushEvent 的 payload 是 { name, args }', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const ac = new AbortController()
    const res = await fetch(`${base}/api/wechat/events`, { headers: { cookie }, signal: ac.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const reader = res.body?.getReader()
    expect(reader, 'SSE 响应没有 body').toBeTruthy()
    const dec = new TextDecoder()
    let text = ''
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader!.read()
        if (done) return
        text += dec.decode(value, { stream: true })
        if (text.includes('wechat-data/updated')) return
      }
    })()
    await new Promise((r) => setTimeout(r, 100))
    f.srv.pushEvent('wechat-data/updated', [])
    await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))])
    ac.abort()

    expect(text, '连上时应当先收到一帧 ready（渲染层可能在订阅前就错过了状态事件）').toContain('remote-access/ready')
    // 关键：payload 形状与 main.js 的 broadcastToWindows(windowCtx,'wechat:event',{name,args}) 完全一致，
    // 渲染层因此可以共用同一套「事件名 → DOM CustomEvent」的分发逻辑（WAL 实时刷新链不用改）。
    const frames = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string) as { name: string, args: unknown[] })
    const pushed = frames.find((x) => x.name === 'wechat-data/updated')
    expect(pushed, '推送的事件没到达 SSE 客户端').toBeTruthy()
    expect(Object.keys(pushed as object).sort()).toEqual(['args', 'name'])
    expect((pushed as { args: unknown[] }).args).toEqual([])
  })

  it('带 args 的事件原样送达（问答流式增量靠它）', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const ac = new AbortController()
    const res = await fetch(`${base}/api/wechat/events`, { headers: { cookie }, signal: ac.signal })
    const reader = res.body?.getReader()
    const dec = new TextDecoder()
    let text = ''
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader!.read()
        if (done) return
        text += dec.decode(value, { stream: true })
        if (text.includes('wechat-ask/delta')) return
      }
    })()
    await new Promise((r) => setTimeout(r, 100))
    f.srv.pushEvent('wechat-ask/delta', [{ id: 'a1', text: '已生成的全文' }])
    await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))])
    ac.abort()
    const frames = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string) as { name: string, args: unknown[] })
    const delta = frames.find((x) => x.name === 'wechat-ask/delta')
    expect(delta?.args).toEqual([{ id: 'a1', text: '已生成的全文' }])
  })

  it('没有会话时 SSE 也是 401', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await fetch(`${base}/api/wechat/events`)
    expect(r.status).toBe(401)
  })

  it('stop() 之后连接断开、旧会话作废（重启要重新扫码）', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(200)
    await f.srv.stop()
    await expect(fetch(`${base}/api/status`, { headers: { cookie } })).rejects.toThrow()
    // 重新起来之后，旧会话必须失效（会话只在内存里）
    const st2 = await f.srv.start()
    const base2 = `http://127.0.0.1:${String(st2.port)}`
    const r = await fetch(`${base2}/api/status`, { headers: { cookie } })
    expect(r.status, '重启后旧会话仍然有效 —— 会话表不该跨重启存活').toBe(401)
  })

  it('stop() 幂等：交接收尾重复调用不抛错，之后仍可重新启动', async () => {
    const f = fixture()
    await up(f)
    await f.srv.stop()
    await expect(f.srv.stop()).resolves.toBeTruthy()
    expect(f.srv.getState().running).toBe(false)
    const st = await f.srv.start()
    expect(st.running, '重复 stop 之后服务起不来了').toBe(true)
  })
})

describe('资源上限与宿主兜底：连接数、慢客户端、未捕获异常、写代际', () => {
  const EVENT_PATH = '/api/wechat/events'

  it('SSE 全局连接数有上限：超出返回 503 SSE_LIMIT，断开后名额释放', async () => {
    const f = fixture({ maxSseClients: 1 })
    const base = await up(f)
    const cookie = await login(base)
    const ac1 = new AbortController()
    const first = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie }, signal: ac1.signal })
    expect(first.status).toBe(200)
    await waitUntil(() => (f.srv.getState().sseClients ?? 0) === 1)

    const cookieB = await login(base)
    const blocked = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie: cookieB } })
    expect(blocked.status, '连接数已满却仍接受新的 SSE').toBe(503)
    expect((await blocked.json()).error.code).toBe('SSE_LIMIT')

    ac1.abort()
    await waitUntil(() => (f.srv.getState().sseClients ?? 0) === 0)
    const ac2 = new AbortController()
    const again = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie: cookieB }, signal: ac2.signal })
    expect(again.status, '旧连接断开后名额没有释放').toBe(200)
    ac2.abort()
  })

  it('SSE 单会话连接数有上限：同一 Cookie 开第二个被拒，另一个会话不受影响', async () => {
    const f = fixture({ maxSsePerSession: 1, maxSseClients: 8 })
    const base = await up(f)
    const cookieA = await login(base)
    const acA = new AbortController()
    const first = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie: cookieA }, signal: acA.signal })
    expect(first.status).toBe(200)
    await waitUntil(() => (f.srv.getState().sseClients ?? 0) === 1)

    const blocked = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie: cookieA } })
    expect(blocked.status).toBe(503)
    expect((await blocked.json()).error.code).toBe('SSE_LIMIT')

    const cookieB = await login(base)
    const acB = new AbortController()
    const other = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie: cookieB }, signal: acB.signal })
    expect(other.status, '单会话上限误伤了别的会话').toBe(200)
    acA.abort()
    acB.abort()
  })

  it('慢客户端：res.write 返回 false 时立刻摘除连接，不把主进程内存顶上去', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const ac = new AbortController()
    const res = await fetch(`${base}${EVENT_PATH}`, { headers: { cookie }, signal: ac.signal })
    expect(res.status).toBe(200)
    await waitUntil(() => (f.srv.getState().sseClients ?? 0) === 1)

    const originalWrite = ServerResponse.prototype.write
    ServerResponse.prototype.write = (() => false) as unknown as typeof ServerResponse.prototype.write
    try {
      f.srv.pushEvent('slow/client', [])
    } finally {
      ServerResponse.prototype.write = originalWrite
    }
    await waitUntil(() => (f.srv.getState().sseClients ?? 0) === 0)
    ac.abort()
  })

  it('路由处理器抛异常：返回 500 INTERNAL_ERROR，而不是让请求悬挂到超时', async () => {
    const f = fixture({ getUiDistDir: () => { throw new Error('spec: static root unavailable') } })
    const base = await up(f)
    const r = await fetch(`${base}/`)
    expect(r.status).toBe(500)
    expect((await r.json()).error.code).toBe('INTERNAL_ERROR')
  })

  it('排队期间配置换代：旧写请求在出队时被撤销（enforce），不会落到后端', async () => {
    let release!: () => void
    let entered = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = fixture({
      callQueue: {
        run: async (task) => {
          entered = true
          await gate
          return task()
        },
      },
    })
    DEFERRED_MUTATION.setMutationGateMode('enforce')
    const base = await up(f)
    const cookie = await login(base)
    const pending = postJson(`${base}/api/wechat/call`, {
      method: 'saveSummaryTask',
      args: [{ title: 'spec' }],
    }, { cookie })
    await waitUntil(() => entered)
    // 模拟「排队期间配置被保存」：与 ipc-wechat 的 saveWechatConfig 成功后 bump 同一口径。
    DEFERRED_MUTATION.bumpMutationEpoch('spec-config-saved')
    release()
    const r = await pending
    const j = await r.json() as { ok?: boolean, error?: { code?: string } }
    expect(j.ok).toBe(false)
    expect(j.error?.code).toBe('MUTATION_DISPATCH_REVOKED')
    expect(f.calls, '被撤销的写仍然到了后端').toEqual([])
  })

  it('saveWechatConfig 成功后开新代际（HTTP 与桌面 IPC 同一口径）', async () => {
    const f = fixture()
    const base = await up(f)
    // saveWechatConfig 是桌面同权方法：普通手机白名单拒绝它，交接会话（fullAccess）才放行。
    const code = f.srv.issuePairingCode({ fullAccess: true })
    const auth = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
    })
    expect(auth.status).toBe(200)
    const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const r = await postJson(`${base}/api/wechat/call`, {
      method: 'saveWechatConfig',
      args: [{ patch: { api_enabled: true } }],
    }, { cookie })
    expect(r.status).toBe(200)
    expect((await r.json() as { ok?: boolean }).ok).toBe(true)
    expect(DEFERRED_MUTATION.mutationGateStats().lastBumpReason).toBe('wechat-config-saved')
  })
})

describe('令牌原文不出现在任何响应里', () => {
  it('逐个端点扫一遍响应体与响应头', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const checks: Array<Promise<Response>> = [
      Promise.resolve(await fetch(`${base}/api/capabilities`, { headers: { cookie } })),
      Promise.resolve(await fetch(`${base}/api/status`, { headers: { cookie } })),
      Promise.resolve(await fetch(`${base}/api/wechat/call`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'getSessions', args: [] }),
      })),
      Promise.resolve(await fetch(`${base}/`)),
    ]
    for (const p of checks) {
      const r = await p
      const body = await r.text()
      expect(body, `${r.url} 的响应体里出现了令牌原文`).not.toContain(TOKEN)
      for (const [k, v] of r.headers) {
        if (k.toLowerCase() === 'set-cookie') continue // 会话 Cookie 是会话 id，不是令牌
        expect(String(v), `${r.url} 的响应头 ${k} 里出现了令牌原文`).not.toContain(TOKEN)
      }
    }
    // 登录成功那一响应也不许回显令牌（回显就等于把它送进浏览器可读的地方）
    const loginRes = await postJson(`${base}/api/auth`, { token: TOKEN })
    expect(await loginRes.text()).not.toContain(TOKEN)
  })

  it('状态里的掩码只露头尾 4 位', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const st = (await (await fetch(`${base}/api/status`, { headers: { cookie } })).json()).value as State
    expect(st.tokenMasked).toBe(`${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`)
  })
})

describe('「打开网页」交接会话：浏览器与桌面端同权限', () => {
  /** 用交接码换会话（普通登录用的是长期令牌，拿不到 fullAccess）。 */
  async function loginFull(base: string, f: ReturnType<typeof fixture>): Promise<string> {
    const code = f.srv.issuePairingCode({ fullAccess: true })
    const r = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: code }),
    })
    expect(r.status).toBe(200)
    const j = await r.json() as { value?: { fullAccess?: boolean } }
    expect(j.value?.fullAccess, '交接码换来的会话必须带 fullAccess 标记').toBe(true)
    return (r.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  }

  it('交接会话能调用仅桌面端方法；普通手机会话仍然被拒', async () => {
    const f = fixture()
    const base = await up(f)
    const full = await loginFull(base, f)
    const r = await fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: full },
      body: JSON.stringify({ method: 'getWechatConfigFull', args: [] }),
    })
    const j = await r.json() as { ok?: boolean }
    expect(j.ok).toBe(true)
    expect(f.calls).toContain('getWechatConfigFull')

    // 同一台服务上的普通配对码会话不能借这条路由越权
    f.calls.length = 0
    const normal = await login(base)
    const denied = await fetch(`${base}/api/wechat/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: normal },
      body: JSON.stringify({ method: 'getWechatConfigFull', args: [] }),
    })
    expect((await denied.json() as { error?: { code?: string } }).error?.code).toBe('METHOD_NOT_ALLOWED_REMOTE')
    expect(f.calls).toEqual([])
  })

  it('浏览器端聊天图片走同源 HTTP 流式出口，路径穿越被拒', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const ok = await fetch(`${base}/api/media/decoded/wxid_a/x.jpg`, { headers: { cookie } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

    const traversal = await fetch(`${base}/api/media/decoded/../config.json`, { headers: { cookie } })
    expect(traversal.status).toBe(404)
    const outside = await fetch(`${base}/api/media/decoded/wxid_a/../../outside.txt`, { headers: { cookie } })
    expect(outside.status).toBe(404)
  })

  it('媒体响应提前关闭时销毁底层文件流，客户端断连不会继续读完整大文件', async () => {
    const f = fixture()
    const base = await up(f)
    const cookie = await login(base)
    const source = new PassThrough()
    source.write('x')
    const createReadStream = vi.spyOn(nodeFs, 'createReadStream')
      .mockReturnValue(source as unknown as ReturnType<typeof nodeFs.createReadStream>)
    const ac = new AbortController()
    try {
      const response = await fetch(`${base}/api/media/decoded/wxid_a/x.jpg`, {
        headers: { cookie },
        signal: ac.signal
      })
      expect(response.status).toBe(200)
      expect(createReadStream).toHaveBeenCalledTimes(1)
      expect(source.destroyed).toBe(false)

      ac.abort()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(source.destroyed).toBe(true)
    } finally {
      ac.abort()
      createReadStream.mockRestore()
      source.destroy()
    }
  })

  it('原生能力端点：交接会话可用，普通会话 403', async () => {
    const seen: string[] = []
    const f = fixture({ nativeCall: async (action, payload) => { seen.push(`${action}:${String(payload.path ?? '')}`); return { echoed: action } } })
    const base = await up(f)
    const full = await loginFull(base, f)
    const ok = await fetch(`${base}/api/native/show-in-folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: full },
      body: JSON.stringify({ path: 'C:/tmp/a.txt' }),
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, value: { echoed: 'show-in-folder' } })
    expect(seen).toEqual(['show-in-folder:C:/tmp/a.txt'])

    const normal = await login(base)
    const denied = await fetch(`${base}/api/native/show-in-folder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: normal },
      body: JSON.stringify({ path: 'C:/tmp/a.txt' }),
    })
    expect(denied.status).toBe(403)
  })
})
