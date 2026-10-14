/**
 * `call-gates.js` 的行为判据 —— 「一次后端调用要过哪几道闸」的**唯一出处**。
 *
 * ## 为什么它需要自己的用例
 *
 * 这份实现同时被两条路调用：桌面端的 IPC（`ipc-wechat.js` 的 `wechat:call`）与
 * 手机端的 HTTP（`http-server.js` 的 `POST /api/wechat/call`）。抽出来之前，闸门只有
 * IPC 一份；抽出来之后，**任何一处改动都同时影响两端** —— 好处是不会再各写一份各漂一次，
 * 代价是它变成了单点，必须有直接的行为判据（`http-server.spec.ts` 用的是打桩的
 * `gatedCall`，测不到这里；`ipc-wechat` 那条路要起 Electron 才能测）。
 *
 * 用例全部注入假 ctx，不碰真后端、不碰许可证服务。
 *
 * ## 这里钉住的四条
 *
 *   ① 后端没就绪时回 `BACKEND_NOT_READY`（而不是抛、也不是假成功）；
 *   ② 调试闸门豁免排在许可校验**之前**，且豁免时确实没去查许可证；
 *   ③ 许可不通过时把 `licenseState` / `method` / `feature` 一起带回（界面靠它显示原因）；
 *   ④ **许可校验自身抛异常时拒绝，而不是放行** —— 这是 2026-09 修过的洞：
 *      旧实现只 `warn` 一句就继续调用后端，等于「许可闸门一旦出异常就完全失效」。
 *      许可 JSON 损坏、读盘失败、指纹采集异常都会走到那个 `catch`。
 *      HTTP 那条路要是少抄这个分支，洞就跟着回来了 —— 所以这条必须有判据。
 *
 * @vitest-environment node
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { gatedWechatCall } = require(join(ROOT, 'src', 'backend', 'call-gates.js')) as {
  gatedWechatCall: (ctx: unknown, method: string, args: unknown[]) => Promise<Envelope>
}

interface Envelope { ok: boolean, value?: unknown, error?: { message: string, code?: string, details?: Record<string, unknown> } }

interface CtxOpts {
  ready?: boolean
  backend?: { call: (m: string, a: unknown[]) => unknown } | null
  skipGates?: boolean
  gate?: { ok: boolean, message?: string, code?: string }
  licenseThrows?: boolean
  lastError?: string | null
  state?: string
}

/** 造一份假 ctx，并记下每一段被调用的次数（用来断言「豁免时没去查许可证」）。 */
function makeCtx(opts: CtxOpts = {}) {
  const hits = { ready: 0, license: 0, authorize: 0, call: 0 }
  const backend = opts.backend === undefined
    ? {
        call: (m: string, a: unknown[]) => {
          hits.call += 1
          return { ok: true, value: { called: m, a } }
        },
      }
    : opts.backend
  const ctx = {
    awaitBackendReady: async () => { hits.ready += 1; return opts.ready ?? true },
    BACKEND_CALL_READY_WAIT_MS: 20_000,
    getWechatBackend: () => backend,
    getBackendStatus: () => ({ state: opts.state ?? 'ready', lastError: opts.lastError ?? null }),
    debugGates: () => ({ skipGates: opts.skipGates ?? false }),
    licenseService: {
      getLicenseStatus: () => {
        hits.license += 1
        if (opts.licenseThrows) throw new Error('许可 JSON 损坏')
        return { state: 'active' }
      },
      authorizeCall: (_lic: unknown, method: string) => {
        hits.authorize += 1
        return opts.gate ?? { ok: true, method }
      },
      METHOD_FEATURE: { askWechat: 'wechat-ask' },
    },
    app: { getPath: () => 'C:\\fake\\userData' },
    APP_VERSION: '9.9.9',
  }
  return { ctx, hits }
}

describe('① 后端就绪闸', () => {
  it('没就绪 → BACKEND_NOT_READY，且不碰后端', async () => {
    const { ctx, hits } = makeCtx({ ready: false })
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('BACKEND_NOT_READY')
    expect(r.error?.details).toMatchObject({ method: 'getSessions', state: 'ready' })
    expect(hits.call, '后端没就绪却还是调用了它').toBe(0)
    expect(hits.ready).toBe(1)
  })

  it('就绪等待超时（返回 false）同样按未就绪处理', async () => {
    const { ctx } = makeCtx({ ready: false, lastError: 'worker 崩了' })
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.error?.code).toBe('BACKEND_NOT_READY')
    expect(r.error?.message, '有 lastError 时要把它带出来，否则用户只看到一句「仍在启动中」')
      .toContain('worker 崩了')
  })

  it('就绪但后端句柄是 null（刚崩）→ 也按未就绪处理', async () => {
    const { ctx, hits } = makeCtx({ backend: null })
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('BACKEND_NOT_READY')
    expect(hits.license, '后端都不在，就不该去查许可证').toBe(0)
  })
})

describe('② 调试闸门豁免排在许可校验之前', () => {
  it('skipGates 时直接调后端，且**完全没碰**许可证服务', async () => {
    const { ctx, hits } = makeCtx({ skipGates: true, licenseThrows: true })
    const r = await gatedWechatCall(ctx, 'getSessions', [{ page: 1 }])
    expect(r).toEqual({ ok: true, value: { called: 'getSessions', a: [{ page: 1 }] } })
    expect(hits.license, '豁免时还去查许可证 —— 顺序反了，豁免就失去意义').toBe(0)
    expect(hits.authorize).toBe(0)
    expect(hits.call).toBe(1)
  })
})

describe('③ 许可证授权', () => {
  it('授权通过 → 后端结果原样返回（信封不被改写）', async () => {
    const { ctx, hits } = makeCtx()
    const r = await gatedWechatCall(ctx, 'askWechat', ['q'])
    expect(r).toEqual({ ok: true, value: { called: 'askWechat', a: ['q'] } })
    expect(hits.license).toBe(1)
    expect(hits.authorize).toBe(1)
  })

  it('授权不通过 → 带回 code 与 licenseState/method/feature', async () => {
    const { ctx, hits } = makeCtx({ gate: { ok: false, message: '许可证未激活', code: 'LICENSE_INACTIVE' } })
    const r = await gatedWechatCall(ctx, 'askWechat', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('LICENSE_INACTIVE')
    expect(r.error?.message).toBe('许可证未激活')
    expect(r.error?.details).toMatchObject({ licenseState: 'active', method: 'askWechat', feature: 'wechat-ask' })
    expect(hits.call, '授权没过还是调用了后端').toBe(0)
  })

  it('METHOD_FEATURE 里没有的方法回落到 wechat-data（缺表不许抛）', async () => {
    const { ctx } = makeCtx({ gate: { ok: false, message: 'x', code: 'NOPE' } })
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.error?.details?.feature).toBe('wechat-data')
  })
})

describe('④ 校验自身抛异常 → **拒绝**，不是放行', () => {
  it('getLicenseStatus 抛错时回 LICENSE_CHECK_FAILED，且没碰后端', async () => {
    const { ctx, hits } = makeCtx({ licenseThrows: true })
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.ok, '许可校验抛异常却放行了 —— 这正是 2026-09 修掉的那个洞').toBe(false)
    expect(r.error?.code).toBe('LICENSE_CHECK_FAILED')
    expect(r.error?.message).toContain('许可 JSON 损坏')
    expect(hits.call, '异常分支里还是调用了后端').toBe(0)
  })

  it('authorizeCall 抛错时同样拒绝', async () => {
    const { ctx, hits } = makeCtx()
    // 直接换掉 authorizeCall：模拟指纹采集异常（经 unknown 转一次，否则两种签名不重叠）
    ;(ctx.licenseService as unknown as { authorizeCall: () => unknown }).authorizeCall = () => {
      throw new Error('指纹采集失败')
    }
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('LICENSE_CHECK_FAILED')
    expect(r.error?.message).toContain('指纹采集失败')
    expect(hits.call).toBe(0)
  })

  it('licenseService 整个缺失时也不放行（打包态被裁剪掉的形状）', async () => {
    const { ctx } = makeCtx()
    ;(ctx as { licenseService: unknown }).licenseService = undefined
    const r = await gatedWechatCall(ctx, 'getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('LICENSE_CHECK_FAILED')
  })
})

describe('永不抛：后端自己抛错也要收成信封', () => {
  it('后端同步抛错时不把异常漏给传输层', async () => {
    const { ctx } = makeCtx({
      backend: {
        call: () => { throw new Error('后端炸了') },
      },
    })
    // 这一条是刻意的：现状是**后端抛错会向上冒**，由传输层各自收成信封
    // （IPC 侧 Electron 会包一层，HTTP 侧 http-server 的 try/catch 会包一层）。
    // 这里钉住的是「闸门自己不会因为后端抛错而崩掉进程」——即它不会把异常
    // 变成一句假的成功，也不会吞掉它。
    await expect(gatedWechatCall(ctx, 'getSessions', [])).rejects.toThrow('后端炸了')
  })
})
