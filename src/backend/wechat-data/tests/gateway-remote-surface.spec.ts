// @vitest-environment node
/**
 * 「方法面」枚举守卫 —— 用**真实的** `WechatDataGateway` 实例来验（M21 结构刀的安全网）。
 *
 * 为什么需要：`gateway.ts` 里的一个类被拆成继承链（`GatewayCore` ← `WechatDataGateway`）之后，
 * 界面上少一个接口不会有任何编译错误 —— 协议层是按「实例原型上的标记集」枚举方法的，
 * 只要那份标记集丢了，接口就**静默消失**（渲染层表现为某几个方法突然 not found）。
 * `remote-inheritance.spec.ts` 证的是语义前提（标记落在最派生原型），本用例证的是**这个类本身**：
 *   ① 枚举到的方法集合 == 源码里 `@Remote('…')` 声明的集合（漏装饰器 / 丢标记都会红）；
 *   ② 每个方法在实例上都真的可调用（继承链没把实现弄丢）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { WechatDataGateway } from '../src/gateway.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
let root = ''
let disposers: Array<() => void> = []

/** 网关构造期只用到 reflect/effect/emit 三件（见 `gateway-operation-log.spec.ts` 的同款夹具）。 */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wechat-surface-'))
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', join(root, 'decrypted'))
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded_images'))
})

afterEach(async () => {
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('@Remote 方法面：真实的 WechatDataGateway', () => {
  it('枚举到的集合与源码声明的集合逐名相同（拆分继承链不许丢接口）', () => {
    const declared = [...readFileSync(join(SRC, 'gateway.ts'), 'utf8').matchAll(/@Remote\('([A-Za-z0-9]+)'/g)]
      .map((m) => m[1]).sort()
    expect(declared.length, '源码里一个 @Remote 都没找到 —— 抓取口径失效').toBeGreaterThan(100)
    const markers = remoteMethods(new WechatDataGateway(fakeCtx())).map((m) => m.method).sort()
    expect(markers).toEqual(declared)
  })

  it('每个方法在实例上都可调用（方法实现没在继承链上丢掉）', () => {
    const gw = new WechatDataGateway(fakeCtx()) as unknown as Record<string, unknown>
    const missing = remoteMethods(new WechatDataGateway(fakeCtx()))
      .map((m) => m.method)
      .filter((name) => typeof gw[name] !== 'function')
    expect(missing, '这些 @Remote 方法在实例上取不到').toEqual([])
  })
})
