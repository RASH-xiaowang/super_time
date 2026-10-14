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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { createRemoteAccessServer } = require(join(ROOT, 'src', 'backend', 'http-server.js')) as {
  createRemoteAccessServer: (deps: {
    getDataRoot: () => string
    getUiDistDir: () => string
    gatedCall: (method: string, args: unknown[]) => Promise<unknown>
    appVersion: string
    bindHost?: string
    log?: (...a: unknown[]) => void
    warn?: (...a: unknown[]) => void
  }) => {
    start: () => Promise<State>
    stop: () => Promise<State>
    getState: () => State
    syncWithConfig: () => Promise<State>
    pushEvent: (name: string, args: unknown[]) => void
    isRunning: () => boolean
  }
}
interface State { running: boolean, port: number, address: string, enabled: boolean, hasToken: boolean, tokenMasked: string }

const TOKEN = 'spec-token-0123456789abcdef'
const scratch: string[] = []
const servers: Array<{ stop: () => Promise<unknown> }> = []

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()
    try { await s?.stop() } catch { /* 已经停了 */ }
  }
  while (scratch.length > 0) {
    const p = scratch.pop()
    if (p) { try { rmSync(p, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  }
})

/** 搭一份「数据根 + 静态目录」的夹具。@returns 建服务所需的 deps 与目录。 */
function fixture(opts: { enabled?: boolean, token?: string, port?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ra-spec-'))
  scratch.push(dir)
  const dataRoot = join(dir, 'wechat-data')
  const uiDist = join(dir, 'ui-dist')
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
  // 根目录**外**放一个文件，用来证明穿越读不到它
  writeFileSync(join(dir, 'outside.txt'), 'SECRET-OUTSIDE')

  const calls: string[] = []
  const srv = createRemoteAccessServer({
    getDataRoot: () => dataRoot,
    getUiDistDir: () => uiDist,
    gatedCall: async (method, args) => { calls.push(method); return { ok: true, value: { method, args } } },
    appVersion: 'spec',
    bindHost: '127.0.0.1',
    log: () => undefined,
    warn: () => undefined,
  })
  servers.push(srv)
  return { srv, calls, dataRoot, uiDist, outside: join(dir, 'outside.txt') }
}

/** 取一个大概率空闲的高位端口（服务自身还有 11 个顺移位，冲突也不至于红）。 */
function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000)
}

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

  it('两个条件都成立 → 监听，并报出实际端口与地址', async () => {
    const f = fixture()
    const st = await f.srv.start()
    expect(st.running).toBe(true)
    expect(st.port).toBeGreaterThan(0)
    expect(st.address).toBe('127.0.0.1')
    expect(st.tokenMasked, '状态里只该有掩码').not.toContain(TOKEN)
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
    const r = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ token: 'wrong' }) })
    expect(r.status).toBe(401)
    expect((await r.json()).error?.code).toBe('BAD_TOKEN')
    expect(r.headers.get('set-cookie'), '失败的登录不该下发会话').toBeNull()
  })

  it('空令牌 / 缺字段 / 非字符串 → 401（空令牌绝不能匹配成功）', async () => {
    const f = fixture()
    const base = await up(f)
    for (const body of [{ token: '' }, {}, { token: null }, { token: 123 }, { token: [TOKEN] }]) {
      const r = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify(body) })
      expect(r.status, `${JSON.stringify(body)} 竟然登录成功了`).toBe(401)
    }
  })

  it('对令牌 → 200 + HttpOnly/SameSite 会话 Cookie', async () => {
    const f = fixture()
    const base = await up(f)
    const r = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) })
    expect(r.status).toBe(200)
    const c = r.headers.get('set-cookie') ?? ''
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Lax')
    expect(c).not.toContain('Secure') // 明文 HTTP 下加了 Secure 会让 Cookie 完全不生效
    const value = (await r.json()).value as { version: string, native: Record<string, boolean>, tokenMasked: string }
    expect(value.version).toBe('spec')
    expect(value.native.titlebar).toBe(false)
    expect(value.tokenMasked).not.toContain(TOKEN)
  })

  it('令牌试错超过上限 → 429（挡掉脚本乱撞）', async () => {
    const f = fixture()
    const base = await up(f)
    let saw429 = false
    for (let i = 0; i < 12; i += 1) {
      const r = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ token: `bad-${String(i)}` }) })
      if (r.status === 429) { saw429 = true; break }
    }
    expect(saw429, '连续试错 12 次都没被限速').toBe(true)
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
    for (const m of ['getWechatConfig', 'saveWechatConfig', 'sendClawbotMessage', 'createBackup', 'openPath', 'clearPrivacyAudit']) {
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
    const r = await fetch(`${base}/api/wechat/call`, { method: 'POST', headers: { cookie }, body: '{not json' })
    expect(r.status).toBe(400)
    expect((await r.json()).error?.code).toBe('BAD_REQUEST')
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
    const loginRes = await fetch(`${base}/api/auth`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) })
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
