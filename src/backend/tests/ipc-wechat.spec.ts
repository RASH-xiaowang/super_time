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
 * 只有真的调一次 handler、并数 `fetch` 被调了几次，才量得到它到底发了什么。
 *
 * 2026-09-30：出网开关**全部移除**，这个频道不再读任何隐私闸门、也不再被拦 ——
 * 它照常按用户填的 `base_url` 请求 `/models`。下面这批用例随之从「开关管不管它」
 * 改成「请求本身对不对」（URL / 请求头 / 错误映射 / 内置清单回退），并留一条
 * 「不再读隐私开关」的防回归判据。
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
  'wechat:llm-test', 'wechat:llm-balance',
]

/** 后端 `call()` 的回包（成功时是 `{ ok: true, value }`，见 wechat-host.js）。 */
type BackendStub = { call: (method: string, args?: unknown) => Promise<unknown> } | null

function makeCtx(backend: BackendStub = null) {
  const handled = new Map<string, (...a: unknown[]) => unknown>()
  const scheduled: Array<{ channel?: string, method?: string }> = []
  const ctx = {
    ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handled.set(ch, fn) } },
    // Existing behavior tests exercise the registrar and handler logic, not the
    // Electron window boundary. The real guard has its own spec below.
    ipcTrust: {
      wrap: (_ch: string, fn: (...a: unknown[]) => unknown) => fn,
      wrapOn: (_ch: string, fn: (...a: unknown[]) => unknown) => fn,
    },
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
    scheduleWechatCall: (task: () => unknown, meta?: { channel?: string, method?: string }) => {
      scheduled.push(meta ?? {})
      return task()
    },
    getCallQueueStats: () => ({ active: 0, queued: 0, rejected: 0 }),
    getRpcStats: () => ({ pending: 0, timedOut: 1, orphanCompletions: 0 }),
    BACKEND_CALL_READY_WAIT_MS: 20_000,
    loadLlmConfig: () => ({ ok: true, value: { provider: 'stub', model: 'stub-model' } }),
    saveLlmConfig: () => ({ ok: true }),
    loadLlmStore: () => ({ ok: true, value: { profiles: [] } }),
    upsertLlmProfile: () => ({ ok: true }),
    activateLlmProfile: () => ({ ok: true }),
    deleteLlmProfile: () => ({ ok: true }),
  }
  return { ctx, handled, scheduled }
}

/** 记账用的假后端：证明 `wechat:llm-models` 不再读任何隐私开关。 */
function backendProbe(): { stub: BackendStub; called: string[] } {
  const called: string[] = []
  return {
    called,
    stub: {
      call: async (method: string) => {
        called.push(method)
        return { ok: true, value: { redactSensitive: false } }
      },
    },
  }
}

/** 把 `globalThis.fetch` 换成探针：记录 URL 与请求头，并按给定响应作答。 */
function fetchProbe(reply: {
  ok?: boolean
  status?: number
  statusText?: string
  json?: unknown
  text?: string
  fail?: Error
} = {}): { called: Array<{ url: string; headers: Record<string, string> }> } {
  const called: Array<{ url: string; headers: Record<string, string> }> = []
  vi.stubGlobal('fetch', async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
    called.push({ url: String(url), headers: init?.headers ?? {} })
    if (reply.fail) throw reply.fail
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      statusText: reply.statusText ?? 'OK',
      headers: { get: () => null },
      text: async () => reply.text ?? '',
      json: async () => reply.json ?? { data: [{ id: 'deepseek-chat' }] },
    }
  })
  return { called }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('ipc-wechat：频道都要注册上，且 handler 体内引用的东西真的能取到', () => {
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
    const backendState = await handled.get('wechat:backend-state')?.({}, undefined) as
      { ok: boolean, value: { callQueue: { active: number, queued: number }, rpc: { timedOut: number } } }
    expect(backendState.value.callQueue).toMatchObject({ active: 0, queued: 0 })
    expect(backendState.value.rpc).toMatchObject({ timedOut: 1 })
  })

  it('wechat:call 走共享调度器，并把 desktop/method 交给诊断记账', async () => {
    const probe = backendProbe()
    const { ctx, handled, scheduled } = makeCtx(probe.stub)
    registerWechatIpc(ctx)
    const fn = handled.get('wechat:call')
    expect(fn, 'wechat:call 没注册').toBeTruthy()
    const r = await (fn as (e: unknown, method: string, args: unknown[]) => Promise<unknown>)(
      {}, 'getSessions', [],
    )
    expect(r).toEqual({ ok: true, value: { redactSensitive: false } })
    expect(probe.called).toEqual(['getSessions'])
    expect(scheduled).toEqual([{ channel: 'desktop', method: 'getSessions' }])
  })
})

/**
 * 「连接测试 / 余额查询」两条新频道（2026-09-30）。
 *
 * 为什么在这里测而不是只测 `llm-balance.js`：**包装层也有它自己的错法** ——
 * 参数名对不上（`baseUrl` vs `apiUrl`）、错误没有包成 `{ok:false,error}`、
 * 或者忘了 register。这些在纯函数用例里全绿。
 */
describe('wechat:llm-test / wechat:llm-balance：包装层与出网行为', () => {
  const run = async (channel: string, opts: unknown) => {
    const { ctx, handled } = makeCtx()
    registerWechatIpc(ctx)
    const fn = handled.get(channel)
    expect(fn, `${channel} 没注册`).toBeTruthy()
    return (fn as (e: unknown, o: unknown) => Promise<{ ok: boolean; value?: any; error?: { message: string } }>)({}, opts)
  }

  it('llm-test：请求 {base}/models，返回耗时与可见模型数；参数名是 baseUrl', async () => {
    const probe = fetchProbe({ json: { data: [{ id: 'a' }, { id: 'b' }] } })
    const r = await run('wechat:llm-test', { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    expect(probe.called.map(c => c.url)).toEqual(['https://api.deepseek.com/v1/models'])
    expect(probe.called[0]?.headers.authorization).toBe('Bearer sk-x')
    expect(r.ok).toBe(true)
    expect(r.value.models).toBe(2)
    expect(typeof r.value.ms).toBe('number')
  })

  it('llm-test：kind/path/model 要透传到端点（向量与精排是另外两套地址·路径）', async () => {
    const calls: Array<{ url: string; method: string; body: string }> = []
    vi.stubGlobal('fetch', async (url: unknown, init: { method?: string; body?: string } = {}) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [{ embedding: [1, 2] }] }), text: async () => '' }
    })
    const r = await run('wechat:llm-test', {
      baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-vec', kind: 'embed', path: '/embeddings', model: 'Qwen/Qwen3-Embedding',
    })
    expect(calls[0]?.url, 'kind/path 没透传 ⇒ 会打到 /models 上').toBe('https://api.siliconflow.cn/v1/embeddings')
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(calls[0]!.body).model).toBe('Qwen/Qwen3-Embedding')
    expect(r.ok).toBe(true)
    expect(r.value.detail).toBe('向量维度 2')
  })

  it('llm-test：失败也包成 {ok:false,error.message}（渲染端只认这个形状）', async () => {
    fetchProbe({ ok: false, status: 401, statusText: 'Unauthorized' })
    const r = await run('wechat:llm-test', { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-bad' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/无效或无权限/)
  })

  it('llm-balance：DeepSeek 走 origin 的 /user/balance（**不带 /v1**）并返回归一化余额', async () => {
    const probe = fetchProbe({ json: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.80' }] } })
    const r = await run('wechat:llm-balance', { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    expect(probe.called.map(c => c.url)).toEqual(['https://api.deepseek.com/user/balance'])
    expect(r.ok).toBe(true)
    expect(r.value.total).toBe(8.8)
    expect(r.value.currency).toBe('CNY')
  })

  it('llm-balance：没有 Key 直接给出可照做的错误（不白跑一趟网络）', async () => {
    const probe = fetchProbe({ json: {} })
    const r = await run('wechat:llm-balance', { baseUrl: 'https://api.deepseek.com/v1', apiKey: '' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toMatch(/API Key/)
    expect(probe.called.length, '没 Key 就不该发请求').toBe(0)
  })

  it('不读任何隐私开关（与 llm-models 同一口径：出网开关已于 2026-09-30 全部移除）', async () => {
    const { stub, called } = backendProbe()
    const { ctx, handled } = makeCtx(stub)
    registerWechatIpc(ctx)
    fetchProbe({ json: { data: [{ id: 'a' }], balance_infos: [{ currency: 'CNY', total_balance: '1' }] } })
    await handled.get('wechat:llm-test')?.({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    await handled.get('wechat:llm-balance')?.({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    expect(called).not.toContain('getPrivacyState')
  })
})

describe('wechat:llm-models：按 base_url 请求 /models（应用内已无出网开关）', () => {
  const handler = (ctx: unknown, handled: Map<string, (...a: unknown[]) => unknown>) => {
    registerWechatIpc(ctx as { ipcMain: unknown })
    const fn = handled.get('wechat:llm-models')
    expect(fn, 'wechat:llm-models 没注册').toBeTruthy()
    return fn as (e: unknown, o: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string; code?: string } }>
  }

  it('正常请求 {base_url}/models，并带上用户填的 API Key', async () => {
    const { ctx, handled } = makeCtx()
    const probe = fetchProbe({ json: { data: [{ id: 'deepseek-chat' }] } })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-real' })
    expect(probe.called.map(c => c.url), '请求地址不是 base_url + /models（尾斜杠应被去掉）')
      .toEqual(['https://api.deepseek.com/v1/models'])
    expect(probe.called[0]?.headers.authorization).toBe('Bearer sk-real')
    expect(probe.called[0]?.headers.accept).toBe('application/json')
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.value)).toContain('deepseek-chat')
    expect(JSON.stringify(r.value)).toContain('live')
  })

  it('没填 Key 时不发 Authorization 头（别把空凭据送出去）', async () => {
    const { ctx, handled } = makeCtx()
    const probe = fetchProbe({ json: { data: [{ id: 'qwen-plus' }] } })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '' })
    expect(probe.called).toHaveLength(1)
    expect('authorization' in (probe.called[0]?.headers ?? {}), '没填 Key 却带了 Authorization').toBe(false)
    expect(r.ok).toBe(true)
  })

  it('网络失败时把底层错误码翻成能照做的中文提示', async () => {
    const { ctx, handled } = makeCtx()
    const probe = fetchProbe({ fail: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x' })
    expect(probe.called).toHaveLength(1)
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('域名解析失败')
  })

  it('未填 Key 且命中内置清单 ⇒ 直接用清单（用户仍然拿得到模型名）', async () => {
    const { ctx, handled } = makeCtx()
    const probe = fetchProbe({ fail: Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: '' })
    expect(probe.called).toHaveLength(1)
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.value)).toContain('catalog')
    expect(JSON.stringify(r.value)).toContain('deepseek-chat')
  })

  it('404 ⇒ 提示可能缺 /v1 后缀（错误映射没被开关移除顺手删掉）', async () => {
    const { ctx, handled } = makeCtx()
    fetchProbe({ ok: false, status: 404, statusText: 'Not Found' })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('404')
    expect(r.error?.message).toContain('/v1')
  })

  it('401 且填了 Key ⇒ 直说 Key 无效，而不是回退清单', async () => {
    const { ctx, handled } = makeCtx()
    fetchProbe({ ok: false, status: 401, statusText: 'Unauthorized' })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-bad' })
    expect(r.ok).toBe(false)
    expect(r.error?.message).toContain('API Key')
    expect(JSON.stringify(r.value ?? null)).not.toContain('catalog')
  })

  it('不再读任何隐私开关（防回归：llm-models 不依赖后端 getPrivacyState）', async () => {
    const { stub, called } = backendProbe()
    const { ctx, handled } = makeCtx(stub)
    const probe = fetchProbe({ json: { data: [{ id: 'deepseek-chat' }] } })
    const run = handler(ctx, handled)
    const r = await run({}, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' })
    expect(called, 'llm-models 又去读隐私开关了 —— 出网开关已于 2026-09-30 全部移除').not.toContain('getPrivacyState')
    expect(probe.called, '照常出网，不该被任何闸门拦下').toHaveLength(1)
    expect(r.ok).toBe(true)
  })
})
