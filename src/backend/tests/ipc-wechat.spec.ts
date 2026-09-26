/**
 * `src/backend/ipc-wechat.js` 的注册守卫（M21 第二十一刀）。
 *
 * 与 `ipc-misc.spec.ts` 同一套路：假 `ipcMain` 跑一遍注册，逐条点名缺哪个频道。
 * 另外**真的调用两个 handler**（`wechat:info` / `wechat:llm-get`）—— 注册只是把闭包挂上去，
 * 「handler 体内引用了没传进来的东西」只有调用才暴露（本刀就是靠标识符审计逮到
 * `BACKEND_CALL_READY_WAIT_MS` 与 6 个 LLM 助手漏传的）。
 *
 * 2026-09-26（P0-2）加了 `wechat:llm-models` 的**出网行为**用例：这个频道在主进程里 fetch，
 * 还带着用户的 `Authorization: Bearer <API Key>`，而它既不经过后端的 `@Remote` 方法面、
 * 也不在 license 的 `METHOD_FEATURE` 清单里 ⇒ 「按 privacy 接缝扫描」的守卫天生看不见它。
 * 只有真的调一次 handler、并数 `fetch` 被调了几次，才量得到「开关到底管不管它」。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { registerWechatIpc } = require(join(HERE, '..', 'ipc-wechat.js'))

const CHANNELS = [
  'wechat:list-methods', 'wechat:info', 'wechat:call', 'wechat:backend-state',
  'wechat:llm-get', 'wechat:llm-save', 'wechat:llm-profiles', 'wechat:llm-models',
]

/** 后端 `call()` 的回包（成功时是 `{ ok: true, value }`，见 wechat-host.js）。 */
type BackendStub = { call: (method: string, args?: unknown) => Promise<unknown> } | null

function makeCtx(backend: BackendStub = null) {
  const handled = new Map<string, (...a: unknown[]) => unknown>()
  const ctx = {
    ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handled.set(ch, fn) } },
    app: { getVersion: () => '0.0.0', getPath: () => '/tmp' },
    licenseService: { status: () => ({ state: 'ok' }), verify: async () => ({ ok: true }), METHOD_FEATURE: {} },
    debugGates: () => ({ packaged: false, skipGates: true }),
    awaitBackendReady: async () => true,
    findModelCatalog: (url: string) => (/deepseek/i.test(String(url))
      ? { vendor: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }
      : null),
    APP_VERSION: '0.0.0',
    // 三个运行期会变的量：本刀特意让它们「先空后有」，用来证明 handler 读的是 getter 而不是快照
    getWechatBackend: () => backend,
    getWechatBoot: () => null,
    getBackendStatus: () => ({ state: 'running', restarts: 0, lastError: null }),
    BACKEND_CALL_READY_WAIT_MS: 20_000,
    loadLlmConfig: () => ({ ok: true, value: { provider: 'stub', model: 'stub-model' } }),
    saveLlmConfig: () => ({ ok: true }),
    loadLlmStore: () => ({ ok: true, value: { profiles: [] } }),
    upsertLlmProfile: () => ({ ok: true }),
    activateLlmProfile: () => ({ ok: true }),
    deleteLlmProfile: () => ({ ok: true }),
  }
  return { ctx, handled }
}

/** 假的 `getPrivacyState` 后端：只回答总闸是开还是关。 */
function backendWithOutboundBlock(blocked: boolean): { stub: BackendStub; called: string[] } {
  const called: string[] = []
  return {
    called,
    stub: {
      call: async (method: string) => {
        called.push(method)
        return { ok: true, value: { redactSensitive: false, blockOutbound: blocked, blockMapTiles: false } }
      },
    },
  }
}

/** 把 `globalThis.fetch` 换成探针；404 不在重试清单里 ⇒ 立刻返回。 */
function fetchProbe(): { called: Array<{ url: string; auth: string }> } {
  const called: Array<{ url: string; auth: string }> = []
  vi.stubGlobal('fetch', async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
    called.push({ url: String(url), auth: String(init?.headers?.authorization ?? '') })
    return {
      ok: false, status: 404, statusText: 'Not Found',
      headers: { get: () => null }, text: async () => '', json: async () => ({}),
    }
  })
  return { called }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('ipc-wechat：8 个频道都要注册上，且 handler 体内引用的东西真的能取到', () => {
  it('注册全部频道且不重复', () => {
    const { ctx, handled } = makeCtx()
    registerWechatIpc(ctx)
    expect(handled.size, '一个频道都没注册上').toBeGreaterThan(5)
    for (const ch of CHANNELS) expect([...handled.keys()], `缺频道 ${ch}`).toContain(ch)
  })

  it('真调一次 wechat:info / wechat:llm-get：漏传 ctx 字段会在这里炸（注册期看不出来）', async () => {
    const { ctx, handled } = makeCtx()
    registerWechatIpc(ctx)
    const info = await handled.get('wechat:info')?.({}, undefined)
    expect(info, 'wechat:info 返回了 undefined').toBeTruthy()
    const llm = await handled.get('wechat:llm-get')?.({}, undefined)
    expect(llm, 'wechat:llm-get 返回了 undefined').toBeTruthy()
  })
})

describe('wechat:llm-models 受「禁止 AI 出网」总闸管（P0-2）', () => {
  const handler = (ctx: unknown, handled: Map<string, (...a: unknown[]) => unknown>) => {
    registerWechatIpc(ctx as { ipcMain: unknown })
    const fn = handled.get('wechat:llm-models')
    expect(fn, 'wechat:llm-models 没注册').toBeTruthy()
    return fn as (e: unknown, o: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string; code?: string } }>
  }

  it('开关打开 ⇒ 不发请求、不把 API Key 交给远端', async () => {
    const { stub, called } = backendWithOutboundBlock(true)
    const { ctx, handled } = makeCtx(stub)
    const probe = fetchProbe()
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-SECRET-DO-NOT-SEND' })
    expect(called, '没去后端读过隐私开关 ⇒ 那个「闸门」是假的').toContain('getPrivacyState')
    expect(probe.called, `开关打开仍然发了请求：${JSON.stringify(probe.called)}`).toEqual([])
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('禁止 AI 出网')
    expect(r.error?.code).toBe('PRIVACY_BLOCKED')
  })

  it('开关关闭 ⇒ 同一条路真的发请求并带上 Key（反例：证明上一条不是恒真）', async () => {
    const { stub } = backendWithOutboundBlock(false)
    const { ctx, handled } = makeCtx(stub)
    const probe = fetchProbe()
    const run = handler(ctx, handled)
    await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-real' })
    expect(probe.called.map(c => c.url), '开关关闭时也没有发出请求').toEqual(['https://api.deepseek.com/v1/models'])
    expect(probe.called[0]?.auth).toBe('Bearer sk-real')
  })

  it('拿不到隐私开关 ⇒ fail-closed（宁可拦错也不放行凭据）', async () => {
    const { ctx, handled } = makeCtx(null)
    const probe = fetchProbe()
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    expect(probe.called, '后端不可用时仍然向远端发了请求').toEqual([])
    expect(r.ok).toBe(false)
  })

  it('被拦时命中内置清单就直接用清单（用户仍然拿得到模型名）', async () => {
    const { stub } = backendWithOutboundBlock(true)
    const { ctx, handled } = makeCtx(stub)
    const probe = fetchProbe()
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: '' })
    expect(probe.called).toEqual([])
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.value)).toContain('catalog')
  })
})
