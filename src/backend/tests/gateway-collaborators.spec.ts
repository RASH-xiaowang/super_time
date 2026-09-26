/**
 * #20 的**装配面**守卫：四个协作者接上了、判断没长回 `GatewayCore`。
 *
 * 报告 §P2-2 的方向是「LLM 工厂 / 隐私闸 / 调度各成协作者（组合而非继承），
 * `GatewayCore` 只保留 `_ctx/_dirs` 与装配」。这一条钉的就是这个形状：
 * ① 四个模块存在，并且各自**声明**了约定的入口（改名或删导出会当场红）；
 * ② `GatewayCore` 的对应方法确实转给它们（十一个委托标记必须在）；
 * ③ 判断本体不许再留在类里（一组"只有实现里才有"的 token 指纹）。
 *
 * 只读文本的部分先剥注释（同 `readStripped` 口径）：类里那几个方法的 JSDoc 提到了
 * `privacyGate` / 出网纪律这些词，按文本匹配会把说明文字当成代码。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-data')
const SRC = join(PKG, 'src')

/** 委托标记：类里的每个包装都必须转给对应协作者。 */
const DELEGATES = [
  'outboundBlockedAt(', 'privacyBlockedAt(', 'privacyGateAt(',
  'embedModelNameOf(', 'globalModelNameOf(', 'kbModelOf(',
  'makeEmbedFnOf(', 'makeChatAskerOf(', 'makeRerankFnOf(',
  'streamControlFor(', 'finishStreamJobIn(',
] as const

/**
 * 实现指纹：这些形状只该出现在协作者里，出现在类里就说明判断又长回去了。
 *
 * 试过把它泛化成 `new \w+\(` / `resolve\w+\(` 这类"形状"匹配 —— **不行**：现仓的类里
 * 本来就有合法的 `new AbortController()`（搜索任务的取消令牌），泛化等于把这条判据写成恒红。
 * 口径只能按具体 token 写，代价是漏掉没写进清单的那一段实现（新搬一族时要往这里加一条）。
 */
const IMPLEMENTATION_MARKS = [
  'new BlockAssembler()', 'maxTokens: 500', 'readPrivacySettings(', 'recordPrivacyAudit(',
  'loadRetrievalConfig(', 'resolveModelRef(', '.llm.stream(',
  'keys().next()', 'this._streamJobs.set(', 'delete job.error',
] as const

/** 每个协作者必须导出的入口（按声明文本查；改名会同时撞坏该模块自己的判据）。 */
const EXPORTS: ReadonlyArray<[string, readonly string[]]> = [
  ['gateway-privacy.ts', ['outboundBlockedAt', 'privacyBlockedAt', 'privacyGateAt']],
  ['gateway-models.ts', ['embedModelNameOf', 'globalModelNameOf', 'kbModelOf']],
  ['gateway-llm-factory.ts', ['makeEmbedFnOf', 'makeChatAskerOf', 'makeRerankFnOf']],
  ['gateway-jobs.ts', ['streamControlFor', 'finishStreamJobIn']],
]

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('#20 的装配面', () => {
  const core = strip(readFileSync(join(SRC, 'gateway-core.ts'), 'utf8'))

  it('哨兵：真读到了网关那份文件（读空 ⇒ 下面两组判据全恒真）', () => {
    expect(core.length, 'gateway-core.ts 读不到或剥没了').toBeGreaterThan(8000)
  })

  it('三个协作者模块存在，且各自声明了约定的入口', () => {
    for (const [f, names] of EXPORTS) {
      const abs = join(SRC, f)
      expect(existsSync(abs), `少了 ${f}`).toBe(true)
      const text = readFileSync(abs, 'utf8')
      for (const n of names) {
        expect(text, `${f} 里没有 export function ${n} —— 委托给类的那一侧会跟着一起塌`).toContain(`export function ${n}(`)
      }
    }
  })

  it('GatewayCore 的十一个包装都还转给协作者', () => {
    for (const mark of DELEGATES) {
      expect(core, `gateway-core.ts 里找不到 ${mark} —— 委托被拆掉，判断就成了第二份`).toContain(mark)
    }
  })

  it('判断本体不许长回 GatewayCore', () => {
    for (const mark of IMPLEMENTATION_MARKS) {
      expect(core, `gateway-core.ts 里又出现了 ${mark} —— 那一段实现要待在协作者模块里`).not.toContain(mark)
    }
  })

  it('反例自证：合成一份「把实现长回类里」的源码必须被同一个判据抓住', () => {
    const fake = core + '\n    const assembler = new BlockAssembler()\n'
    const bites = IMPLEMENTATION_MARKS.filter((m) => fake.includes(m))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的（这条守卫是装饰）').toBeGreaterThan(0)
    for (const mark of IMPLEMENTATION_MARKS) {
      expect(core, `现仓的类里本来就命中 ${mark} ⇒ 上面那条"不含实现"是假绿（清单要按实际形状改）`).not.toContain(mark)
    }
  })

  it('联合读法 `gatewaySource()` 真的把四个协作者收进来了（否则"实现搬到哪儿都算"的守卫静默失去靶子）', async () => {
    const { gatewaySource } = await import('./gateway-source.ts')
    const union = gatewaySource()
    for (const [, names] of EXPORTS) {
      for (const n of names) {
        expect(union, `读这份联合的守卫看不见 ${n} —— 它现在住在协作者里`).toContain(`export function ${n}(`)
      }
    }
  })
})
