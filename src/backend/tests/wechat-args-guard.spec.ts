/**
 * `wechat:call` 的入参守卫（CODE-AUDIT-2026-09-26 P2-7，第二批 #13）。
 *
 * ## 守的是哪一句话
 *
 * 旧实现是 `fn.apply(gateway, callArgs)`：**方法名有白名单，参数一个都不看**。
 * 本用例把两档分别钉住 ——
 *   ① 结构/体积（`guardCallArgs`）：任何调用都必须过，越界就拒，且** gateway 一次都不许被叫到**
 *      （判据用「把实现换成计数器」来量，不靠读日志）；
 *   ② 形状（生成的 zod schema）：默认影子，只由宿主层显式白名单硬拒 ——
 *      这一条也钉住「白名单之外绝不自动升级」，因为 stale schema 会在一个尚未见过的
 *      合法变体上误伤真实面板。
 *
 * 顺带钉住 schema 表**真的被加载并接上了**（`info().argGuard.covered > 0`）：
 * 那 114 份 schema 在仓库里躺了很久，一次都没被执行过，接缝本身就是要守的东西。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARG_LIMITS, buildSchemaMap, checkSchema, guardCallArgs, inspect, issueText,
  noteSchema, observe, onlyExtraKeys, resetLedger, snapshot,
} from '../wechat-args-guard.js'
import { createWechatBackend } from '../wechat-host.js'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
  resetLedger()
})

/** 宿主层返回的是无类型的 CJS 对象，这里只声明用例真正碰到的那一小块。 */
interface HostBackend {
  call: (m: string, a: unknown) => Promise<{ ok: boolean, error?: { code?: string, message?: string } }>
  info: () => {
    argGuard?: {
      covered: number
      total: number
      uncovered: number
      enforced: string[]
      mismatched: string[]
      largest: Array<{ method: string, maxBytes: number }>
    }
  }
  gateway: Record<string, unknown>
}

function asHost(raw: unknown): HostBackend {
  return raw as HostBackend
}

/** 起一个真后端（临时数据根），并把某个 Remote 实现换成计数器。 */
async function hostWithProbe(implName: string): Promise<{ backend: HostBackend, calls: () => number }> {
  const ud = mkdtempSync(join(tmpdir(), 'wx-args-'))
  scratch.push(ud)
  mkdirSync(join(ud, 'wechat-data'), { recursive: true })
  const backend = asHost(await createWechatBackend({ userDataPath: ud }))
  let n = 0
  // 测试里把实现换掉，只为量「有没有被叫到」
  backend.gateway[implName] = async (): Promise<{ ok: boolean }> => { n += 1; return { ok: true } }
  return { backend, calls: () => n }
}

describe('① 结构与体积：任何调用都必须过', () => {
  it('合法形状一律放行，且不改变旧语义（非数组当单参数包一层）', () => {
    expect(guardCallArgs([]).ok).toBe(true)
    expect(guardCallArgs(undefined)).toEqual({ ok: true, value: [], bytes: 0 })
    expect(guardCallArgs([{ month: '2026-09', limit: 50 }])).toMatchObject({ ok: true, value: [{ month: '2026-09', limit: 50 }] })
    expect(guardCallArgs('x')).toMatchObject({ ok: true, value: ['x'] })
    expect(guardCallArgs(null)).toMatchObject({ ok: true, value: [] })
  })

  it('拒：参数个数 / 嵌套深度 / 数组项数 / 单串长度 / 累计体积（边界成对，防上界被悄悄调成无限）', () => {
    expect(guardCallArgs(Array.from({ length: ARG_LIMITS.maxArgs + 1 }, (_, i) => i)).ok).toBe(false)
    expect(guardCallArgs(Array.from({ length: ARG_LIMITS.maxArgs }, (_, i) => i)).ok, '刚好在上界内的合法调用被拒 ⇒ 上界收得太紧').toBe(true)

    const root: Record<string, unknown> = {}
    let cursor: Record<string, unknown> = root
    for (let i = 0; i < ARG_LIMITS.maxDepth + 2; i += 1) {
      const next: Record<string, unknown> = {}
      cursor.a = next
      cursor = next
    }
    expect(guardCallArgs([root]).ok).toBe(false)

    expect(guardCallArgs(['x'.repeat(ARG_LIMITS.maxString + 1)]).ok).toBe(false)
    expect(guardCallArgs(['x'.repeat(1000)]).ok).toBe(true)

    const many = new Array(ARG_LIMITS.maxItems + 1).fill(1)
    expect(guardCallArgs([many]).ok).toBe(false)

    // 累计上界：每条都不越界，加起来越界
    const chunk = 'y'.repeat(1_000_000)
    const big = Array.from({ length: Math.ceil(ARG_LIMITS.maxTotalBytes / 1_000_000) + 2 }, () => chunk)
    expect(guardCallArgs([big]).ok).toBe(false)
  })

  it('拒：循环引用 / function / symbol / bigint / NaN / 非纯对象', () => {
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic.self = cyclic
    expect(guardCallArgs([cyclic])).toMatchObject({ ok: false, code: 'ARGS_CYCLE' })
    expect(guardCallArgs([{ f: () => {} }])).toMatchObject({ ok: false, code: 'ARGS_TYPE' })
    expect(guardCallArgs([{ s: Symbol('s') }])).toMatchObject({ ok: false, code: 'ARGS_TYPE' })
    expect(guardCallArgs([{ b: 10n }])).toMatchObject({ ok: false, code: 'ARGS_TYPE' })
    // NaN 是刻意拒的：JSON.stringify 会把它静默写成 null，等于改数据（宁可当场报错）
    expect(guardCallArgs([{ n: Number.NaN }])).toMatchObject({ ok: false, code: 'ARGS_NUMBER' })
    expect(guardCallArgs([{ d: new Date() }])).toMatchObject({ ok: false, code: 'ARGS_TYPE' })
    expect(guardCallArgs([{ m: new Map([['a', 1]]) }])).toMatchObject({ ok: false, code: 'ARGS_TYPE' })
  })

  it('二进制参数按字节记账，绝不逐元素遍历（否则守卫自己就是把事件循环钉死的东西）', () => {
    const buf = new Uint8Array(8_000_000)
    const started = Date.now()
    const res = inspect(buf, 0, new Set(), { bytes: 0, nodes: 0 })
    const ms = Date.now() - started
    expect(res, '8MB 的 buffer 被拒了 ⇒ 记账口径写错').toBeNull()
    expect(ms, `遍历了 ${String(buf.length)} 项（${String(ms)}ms）—— 必须按 byteLength 记账`).toBeLessThan(100)
    expect(guardCallArgs([new Uint8Array(ARG_LIMITS.maxTotalBytes + 1)]).ok).toBe(false)
  })

  it('真后端里：被拒的调用一次都不许碰到 gateway，而合法调用照常执行', async () => {
    const { backend, calls } = await hostWithProbe('getPrivacyState')
    const bad = await backend.call('getPrivacyState', [{ evil: () => {} }])
    expect(bad.ok, '带 function 的参数被放行了').toBe(false)
    expect(bad.error?.code).toBe('ARGS_TYPE')
    expect(calls(), 'gateway 仍然被叫到了 ⇒ 闸门不在执行之前').toBe(0)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect((await backend.call('getPrivacyState', [cyclic])).ok).toBe(false)
    expect((await backend.call('getPrivacyState', ['x'.repeat(ARG_LIMITS.maxString + 1)])).ok).toBe(false)
    expect(calls(), '三条越界调用之后 gateway 仍是 0 次').toBe(0)

    expect((await backend.call('getPrivacyState', [{}])).ok).toBe(true)
    expect(calls(), '合法调用被闸门挡住了 ⇒ 这是误伤真实面板的形状').toBe(1)
  })

  it('未知方法名仍然走原来的「未知方法」分支（闸门不许抢它的语义）', async () => {
    const ud = mkdtempSync(join(tmpdir(), 'wx-args-'))
    scratch.push(ud)
    mkdirSync(join(ud, 'wechat-data'), { recursive: true })
    const backend = asHost(await createWechatBackend({ userDataPath: ud }))
    const res = await backend.call('nonexistentMethod', [{}])
    expect(res.ok).toBe(false)
    expect(res.error?.message ?? '').toContain('未知')
  })
})

describe('② 形状：生成的 zod schema 必须真的接上（默认影子，进了名单才拒）', () => {
  /** 读仓库里那份生成的调用表（宿主层用的就是它）。 */
  async function realSchemas(): Promise<Map<string, unknown[]>> {
    // `typert.host.d.ts` 把 TYPERT 声明成 `unknown`（生成物不给类型），所以这里显式过 unknown 收窄
    const mod = await import('../wechat-data/lib/typert.host.js') as unknown as {
      TYPERT?: { invocations?: Parameters<typeof buildSchemaMap>[0] }
    }
    return buildSchemaMap(mod.TYPERT?.invocations ?? [])
  }

  it('schema 表非空，且 `addTask` 这种必填项缺失的形状判定会报出**哪个字段**', async () => {
    const schemas = await realSchemas()
    // 下界只抓「文件被截断/换格式」这类失效，不是精确数
    expect(schemas.size, 'typert.host.js 里没有可用的 invocations').toBeGreaterThanOrEqual(100)
    expect(schemas.has('addTask'), 'addTask 不在表里 ⇒ 判据要跟着生成口径改').toBe(true)

    const shadow = checkSchema(schemas, 'addTask', [{}], new Set())
    expect(shadow.verdict).toBe('mismatch')
    expect(shadow.code, '没进名单却拒了 ⇒ 影子档与硬拒档的分工被破坏').toBeUndefined()
    expect(shadow.message ?? '', '报错没指出字段 ⇒ 影子账本没法用来收 schema').toContain('title')

    const hard = checkSchema(schemas, 'addTask', [{ title: 1, kind: 'a', payload: {} }], new Set(['addTask']))
    expect(hard.verdict).toBe('mismatch')
    expect(hard.code, '进了名单还只记账 ⇒ ②档永远升级不上去').toBe('ARGS_SCHEMA')
  })

  it('多余字段不算失败（面板可以先发后端还没认的字段），无 schema 的方法不算覆盖', async () => {
    const schemas = await realSchemas()
    expect(checkSchema(schemas, 'whateverNotARemoteMethod', [{}], new Set(['whateverNotARemoteMethod'])).verdict).toBe('no-schema')
    expect(checkSchema(null, 'addTask', [{}], new Set()).verdict, '表没加载时要能被看出来').toBe('unloaded')

    // 「只多给了键」不算失败：这条判据单独钉，因为它决定了 ② 档能不能开硬拒
    expect(onlyExtraKeys([{ code: 'unrecognized_keys' }])).toBe(true)
    expect(onlyExtraKeys([{ code: 'unrecognized_keys' }, { code: 'invalid_type' }]), '类型错混在多余键里也放行 ⇒ 硬拒会漏掉真正的问题').toBe(false)
    expect(onlyExtraKeys([])).toBe(false)
    expect(issueText([{ code: 'unrecognized_keys', path: ['a'] }])).toContain('a')

    // 零参数的方法：形状档必须回 ok（不许把「没有参数」当成失败）
    const zeroParam = [...schemas.entries()].find(([, list]) => list.length === 0)?.[0]
    expect(zeroParam, '表里一个无参方法都没有 ⇒ ok 分支没法验').toBeTruthy()
    expect(checkSchema(schemas, zeroParam as string, [], new Set([zeroParam as string])).verdict).toBe('ok')
  })

  it('宿主层真的把两档都接上了（source 级接线判据）', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, join: j } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const host = readFileSync(j(here, '..', 'wechat-host.js'), 'utf8')
    expect(host).toContain("require('./wechat-args-guard')")
    expect(host.indexOf('guardCallArgs(args)'), '闸门根本没被调用', ).toBeGreaterThan(host.indexOf('const fn = gateway[implName]'))
    expect(host.indexOf('guardCallArgs(args)'), '闸门排在执行之后等于没设').toBeLessThan(host.indexOf('fn.apply(gateway, callArgs)'))
    expect(host, 'callArgs 必须只由守卫归一化结果 + fallback jobId 注入构成，否则缓存键与执行用的是两份数据')
      .toMatch(/const callArgs = injectFallbackJobId\(method, guard\.value, callHandle\)/)
    expect(host).toContain('ENFORCED_SCHEMA_METHODS = new Set([')
    expect(host).toContain("  'deleteTask',")
    expect(host).toContain('checkSchema(argSchemas, implName, callArgs, ENFORCED_SCHEMA_METHODS)')
    expect(host).toContain('argsGuard.snapshot(argSchemas ? argSchemas.size : 0, methodMap.size, ENFORCED_SCHEMA_METHODS)')
    expect(host, '守卫自己不得再保留自动升级状态').not.toContain('schemaPasses')
    expect(host, '宿主层不得调用守卫内部的自动升级接口').not.toContain('argsGuard.enforcedSchemas()')
    expect(host, '影子账本没进 info() 的话，②档的诊断依据就会丢失').toContain('argsGuard.snapshot(')
  })

  it('真后端里白名单外的 addTask 仍只做影子记账，坏形状仍会到达 gateway', async () => {
    const { backend, calls } = await hostWithProbe('addTask')
    const valid = [{ title: 'task' }]
    for (let i = 0; i < 5; i += 1) {
      const result = await backend.call('addTask', valid)
      expect(result.ok, `第 ${String(i + 1)} 次合法调用被拒 ⇒ 影子阶段不能误伤`).toBe(true)
    }

    const bad = await backend.call('addTask', [{ title: 1 }])
    expect(bad.ok, '影子档不得在自动升级后误拒合法面板形状').toBe(true)
    expect(calls(), '白名单为空时，形状 mismatch 不能阻止 gateway 执行').toBe(6)

    const ag = (await backend.info()).argGuard
    expect(ag?.enforced).toEqual(['deleteTask'])
    expect(ag?.enforced, 'addTask 不得因为见过合法调用就自动升级').not.toContain('addTask')
    expect(ag?.mismatched).toContain('addTask')
  })

  it('真后端里 deleteTask 试点：合法形状执行，类型/必填错配在进 gateway 前被拒', async () => {
    const { backend, calls } = await hostWithProbe('deleteTask')

    expect((await backend.call('deleteTask', [{ id: 1 }])).ok).toBe(true)
    expect(calls(), '合法形状被试点名单误伤').toBe(1)

    for (const bad of [{ id: '1' }, {}]) {
      const result = await backend.call('deleteTask', [bad])
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('ARGS_SCHEMA')
    }
    expect(calls(), '坏形状到达 gateway ⇒ 试点名单没接上').toBe(1)

    const ag = (await backend.info()).argGuard
    expect(ag?.enforced).toEqual(['deleteTask'])
    expect(ag?.mismatched).toContain('deleteTask')
  })

  it('真后端把影子账本暴露在 info().argGuard 里，覆盖数来自真加载的表（不是硬编码）', async () => {
    const ud = mkdtempSync(join(tmpdir(), 'wx-args-info-'))
    scratch.push(ud)
    mkdirSync(join(ud, 'wechat-data'), { recursive: true })
    const backend = await createWechatBackend({ userDataPath: ud })
    const info = await backend.info()
    const ag = info.argGuard
    expect(ag, 'info() 里没有 argGuard ⇒ 影子账本拿不到').toBeTruthy()
    expect(ag!.covered).toBeGreaterThanOrEqual(100)
    expect(ag!.total, '方法总数应当来自 @Remote 标记而不是写死的数').toBeGreaterThan(ag!.covered)
    expect(ag!.uncovered).toBe(ag!.total - ag!.covered)
    console.log(`[算料] @Remote 方法 ${String(ag!.total)} 个，生成的 schema 覆盖 ${String(ag!.covered)} 个，未覆盖 ${String(ag!.uncovered)} 个`)
    /**
     * **只能变小**：`typert.host.js` 是随包签进来的生成物，它落后于今天的 `@Remote` 多少个
     * 方法，就是「schema 从未被执行过」（P2-7）与「生成物无溯源」（P1-5）交汇的那笔账。
     * 新加一个 `@Remote` 方法而没跟着生成 schema ⇒ 这里红，而不是安静地多一个不受校验的入口。
     *
     * W2-8.6 把 58 抬到 59，理由与边界写在这里（下一个人不必重新查）：
     *   · 新增的 `@Remote('generateAnnualNarrative')` 的 schema 没能跟着生成 ——
     *     `typert.host.js` 的生成器（`@deepseek-ai/dsh-typert-generator`）**不在这个仓库里**，
     *     也没有任何 npm script 调它；它读的输入路径是 `packages/host/wechat-data/src/gateway.ts`，
     *     那是生成器自己的工作树布局，本仓库对应的是拆分后的 `gateway-*.ts`。
     *   · 因此这个数字**不是**「该修没修」，而是「本仓库无法自动修」。取值范围是
     *     58 ≤ 未覆盖 ≤ 59；再涨（>59）说明又有新方法没被记进来，仍然会红。
     *   · 遗留证据：文件里 `exportCsv` 的参数 schema 还停在 `{kind, recordsKind}`，
     *     而 W2-8.2 已经给它加了 `dest` / `category` / `jobId` —— 同一个漂移。
     *
     * 2026-10-13 把 59 抬到 **61**（同一条成因又落在一对新方法上，边界与核对方式写在这里）：
     *   · 新方法：`@Remote('checkDbIntegrity')` 与 `@Remote('repairCorruptDbs')`
     *     （`gateway-db-health.ts`，「损坏库修复链路」W3-11.7）。
     * 2026-10-14 把 61 抬到 **62**（地图 GeoJSON 后端代理新增 `@Remote('getMapGeoJson')`）：
     *   · 核对方式（可重跑）：`lib/typert.host.js` 的 133 份 schema 里这三个名字**都不在**
     *     ⇒ 未覆盖 = 195 − 133 = **62**，一分不多一分不少。
     *   · 为什么不是「修好它」：生成器不在本仓（见上一条）。而这三个方法**不是新开的口子** ——
     *     它们与另外 133 个方法走**同一个** `guardCallArgs` 闸门（①档结构/体积照常拦），
     *     ②档（形状）对它们只是「影子」，进 `ENFORCED_SCHEMA_METHODS` 之前不拒任何调用。
     *   · 取值范围是 62 ≤ 未覆盖 ≤ 62；再涨（>62）说明又有新方法没被记进来，仍然会红。
     */
    expect(ag!.uncovered, '未覆盖数变大了 ⇒ 新加的 @Remote 方法没有跟着生成 schema（②档对它永久失明）')
      .toBeLessThanOrEqual(62)
  })
})

describe('影子账本自己（收上界与升级 ② 档都靠它）', () => {
  it('通过/失败只记账，硬拒名单必须由调用方显式传入，连续通过不会自动升级', () => {
    for (let i = 0; i < 20; i += 1) noteSchema('autoPromoted', null)
    expect(snapshot(0, 0).enforced, '只凭通过次数就升级 ⇒ stale schema 会误拒未见过的合法变体').toEqual([])

    noteSchema('blockedMethod', 'title: expected string')
    for (let i = 0; i < 20; i += 1) noteSchema('blockedMethod', null)
    expect(snapshot(0, 0).enforced).toEqual([])
    expect(snapshot(0, 0).mismatched).toEqual(['blockedMethod'])

    const allowlist = new Set(['curatedMethod'])
    expect(snapshot(0, 0, allowlist).enforced).toEqual(['curatedMethod'])
  })

  it('每条方法留住历史最大体积，快照给出前 10 名；schema 通过/失败分开记', () => {
    observe('queryMessages', 120)
    observe('queryMessages', 5_000)
    observe('getAvatar', 7)
    noteSchema('queryMessages', null)
    noteSchema('getContacts', 'title: expected string')
    const snap = snapshot(3, 10)
    expect(snap.largest[0]?.method).toBe('queryMessages')
    expect(snap.largest[0]?.maxBytes).toBe(5_000)
    expect(snap.mismatched).toEqual(['getContacts'])
    expect(snap.enforced, '没有显式白名单时，快照不得宣称任何方法已硬拒').toEqual([])
    expect(snap.uncovered).toBe(7)
  })

  it('账本有界：超过容量按 FIFO 淘汰，不无界增长', () => {
    for (let i = 0; i < ARG_LIMITS.maxLedgerEntries + 50; i += 1) observe(`m${String(i)}`, i)
    // 最大体积是最后写入的那几条 ⇒ 早期条目已经被挤掉，说明表没有无界增长
    const largest = snapshot(0, 0).largest
    expect(largest.length).toBe(10)
    expect(largest[0]?.method, '留下的该是最大的一条').toBe(`m${String(ARG_LIMITS.maxLedgerEntries + 49)}`)
    expect(snapshot(0, 0).enforced.length).toBe(0)
    expect(snapshot(0, 0).mismatched.length).toBe(0)
  })
})
