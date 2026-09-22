/**
 * `src/backend/ipc-wechat.js` 的注册守卫（M21 第二十一刀）。
 *
 * 与 `ipc-misc.spec.ts` 同一套路：假 `ipcMain` 跑一遍注册，逐条点名缺哪个频道。
 * 另外**真的调用两个 handler**（`wechat:info` / `wechat:llm-get`）—— 注册只是把闭包挂上去，
 * 「handler 体内引用了没传进来的东西」只有调用才暴露（本刀就是靠标识符审计逮到
 * `BACKEND_CALL_READY_WAIT_MS` 与 6 个 LLM 助手漏传的）。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { registerWechatIpc } = require(join(HERE, '..', 'ipc-wechat.js'))

const CHANNELS = [
  'wechat:list-methods', 'wechat:info', 'wechat:call', 'wechat:backend-state',
  'wechat:llm-get', 'wechat:llm-save', 'wechat:llm-profiles', 'wechat:llm-models',
]

function makeCtx() {
  const handled = new Map<string, (...a: unknown[]) => unknown>()
  const ctx = {
    ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handled.set(ch, fn) } },
    app: { getVersion: () => '0.0.0', getPath: () => '/tmp' },
    licenseService: { status: () => ({ state: 'ok' }), verify: async () => ({ ok: true }), METHOD_FEATURE: {} },
    debugGates: () => ({ packaged: false, skipGates: true }),
    awaitBackendReady: async () => true,
    findModelCatalog: () => null,
    APP_VERSION: '0.0.0',
    // 三个运行期会变的量：本刀特意让它们「先空后有」，用来证明 handler 读的是 getter 而不是快照
    getWechatBackend: () => null,
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
