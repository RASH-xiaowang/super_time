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
  'streamControlFor(', 'finishStreamJobIn(', 'summaryScheduler().runDue()',
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
  // 第七刀：摘要调度的三件实现细节（拼时刻、记错误日志、并发上限），只该住在 `gateway-scheduler.ts` 里
  "padStart(2, '0')", 'summary_scheduler_error', 'DUE_SUMMARY_CONCURRENCY',
] as const

/** 不在「域 accessor ↔ 槽键」一一映射里的合法槽键（新增要写理由）。 */
const EXTRA_SLOTS: readonly string[] = ['summaryScheduler']

/** 防空转哨兵：清单空了 ⇒ 后面的"逐颗对齐"会一条都不跑。 */
function atLeast(actual: number, min: number): void {
  expect(actual, `实际 ${String(actual)}，下限 ${String(min)}（低于下限说明样本没扫到，这条守卫是空的）`).toBeGreaterThanOrEqual(min)
}

/**
 * 文件系统 token：`GatewayCore` 一个都不许碰（报告 §P2-2 第 2 条）。
 *
 * 2026-09-27 第五刀把最后一颗（`warmDecodedImages`，全类唯一直接读写文件的地方）下沉到
 * `query/image-warm.ts` 之后，core 里连 `node:fs` 的 import 都不剩 —— 于是这一族变成**零容忍**：
 * 类只管装配与编排，读写都在 query 层。为什么连 import 都要钉：留着壳、搬走肉是这类搬迁最常见的半截改法。
 */
const FS_TOKENS = [
  'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync',
  'readdirSync', 'existsSync', 'statSync', 'openSync', 'node:fs',
] as const

/** 每个协作者必须导出的入口（按声明文本查；改名会同时撞坏该模块自己的判据）。 */
const EXPORTS: ReadonlyArray<[string, readonly string[]]> = [
  ['gateway-privacy.ts', ['outboundBlockedAt', 'privacyBlockedAt', 'privacyGateAt']],
  ['gateway-models.ts', ['embedModelNameOf', 'globalModelNameOf', 'kbModelOf']],
  ['gateway-llm-factory.ts', ['makeEmbedFnOf', 'makeChatAskerOf', 'makeRerankFnOf']],
  ['gateway-jobs.ts', ['streamControlFor', 'finishStreamJobIn']],
  ['gateway-scheduler.ts', ['createSummaryScheduler', 'dueSummaryTaskIds']],
  ['query/image-warm.ts', ['warmDecodedImages']],
]

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('#20 的装配面', () => {
  const core = strip(readFileSync(join(SRC, 'gateway-core.ts'), 'utf8'))

  it('哨兵：真读到了网关那份文件（读空 ⇒ 下面两组判据全恒真）', () => {
    expect(core.length, 'gateway-core.ts 读不到或剥没了').toBeGreaterThan(8000)
    expect(FS_TOKENS.length, 'fs 清单被清空 ⇒ 那条零容忍判据就成了装饰').toBeGreaterThanOrEqual(10)
    expect(EXPORTS.length, '协作者清单').toBeGreaterThanOrEqual(5)
  })

  it('每个协作者模块存在，且各自声明了约定的入口', () => {
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

  /**
   * 报告 §P2-2 第 2 条的验收：类**一次文件系统调用都不许有**（原先最后一颗是 `warmDecodedImages`）。
   * 这条之所以值得写成零容忍：搬完之后剩下的不是"少量残留"，而是"根本没有" ——
   * 一旦有人图省事在类里再写一次 `existsSync`，这格立刻红，而他要么下沉、要么写明为什么留。
   */
  it('GatewayCore 不碰文件系统（读写一律在 query 层）', () => {
    for (const t of FS_TOKENS) {
      expect(core, `gateway-core.ts 里又出现了 ${t} —— fs 能力要待在 query 层，类里只做编排`).not.toContain(t)
    }
  })

  it('反例自证：合成一份「把实现长回类里」的源码必须被同一个判据抓住', () => {
    const fake = core + '\n    const assembler = new BlockAssembler()\n'
    const bites = IMPLEMENTATION_MARKS.filter((m) => fake.includes(m))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的（这条守卫是装饰）').toBeGreaterThan(0)
    for (const mark of IMPLEMENTATION_MARKS) {
      expect(core, `现仓的类里本来就命中 ${mark} ⇒ 上面那条"不含实现"是假绿（清单要按实际形状改）`).not.toContain(mark)
    }
    const fakeFs = core + '\n    if (existsSync(p)) writeFileSync(p, buf)\n'
    expect(FS_TOKENS.filter((t) => fakeFs.includes(t)).length, 'fs 那条的合成违例没命中 ⇒ 清单是空的').toBeGreaterThan(0)
    for (const t of FS_TOKENS) {
      expect(core, `现仓的类里本来就命中 ${t} ⇒ 那条零容忍是假绿`).not.toContain(t)
    }
  })

  /**
   * #20 第六刀：十五个域的装配产物统一走一颗 `slot(key, build)`。两条各钉一面 ——
   * ① **实例状态清零**：报告 §P2-2 第 1 条要 core 只剩 `_ctx` / `_dirs` 与装配，
   *    十五个「下划线字段 + `??=`」正是十五格与装配同质的状态；
   * ② **键不许撞**：换成字符串键之后，两域同键不会再有编译错误（`as T` 把类型吞了），
   *    拿到的是**另一个域**的处理器 —— 症状是某些 RPC 报"没有这个成员"，或者静默返回错的东西。
   * 键名按 `<域>Remotes` 的域段算，与 accessor 名字一对一对齐；不在名单里的额外键要写进 `EXTRA_SLOTS`。
   * （这条不是抽象担心：#20 第七刀把调度器拆出来时，我给它起的键就是 `'summary'`，
   * 与 `summaryRemotes` 撞了 —— 编译一片绿，运行期 `runSummaryTask is not a function`，
   * 三个到期判据当场红。那时守在那里的正是这条"slot 数与 accessor 数要相等"，
   * 换成下面的集合式判据之后，同样的撞法会红得更直白：既报重复、也报"这个键不在名单里"。）
   */
  it('十五个装配槽：不许有字段态的 memo，键名一对一对齐且不重复', () => {
    const accessors = [...core.matchAll(/^ {2}protected ([a-zA-Z]+)Remotes\(\): /gm)].map((m) => m[1])
    atLeast(accessors.length, 15)
    const slots = [...core.matchAll(/this\.slot\('([a-zA-Z]+)'/g)].map((m) => m[1])
    const dupes = [...new Set(slots.filter((k, i) => slots.indexOf(k) !== i))]
    expect(dupes, `装配键重复（两域同键时后装配那颗会拿到前一颗的产物）：${dupes.join(',')}`).toEqual([])
    const missing = accessors.filter((n) => !slots.includes(n))
    expect(missing, `这些域没走装配槽：${missing.join(',')}`).toEqual([])
    const extra = slots.filter((k) => !accessors.includes(k))
    expect(extra, `这些槽键不属于任何一颗域 accessor，也不是登记过的额外协作者：${extra.join(',')}`).toEqual([...EXTRA_SLOTS])
    expect(core, '类里又出现了字段态的装配 memo —— 那件事归 `slot()` 一处做').not.toMatch(/^ {2}protected _\w+Remotes\?:/m)
  })

  it('反例自证：两域撞同一个键必须被上面那条分辨出来', () => {
    const fake = core.replace("this.slot('kb'", "this.slot('media'")
    const keys = [...fake.matchAll(/this\.slot\('([a-zA-Z]+)'/g)].map((m) => m[1])
    expect(keys.filter((k, i) => keys.indexOf(k) !== i).length, '合成"两域同键"没被分辨出来 ⇒ 重复那条是空的').toBeGreaterThan(0)
    const real = [...core.matchAll(/this\.slot\('([a-zA-Z]+)'/g)].map((m) => m[1])
    expect(real.filter((k, i) => real.indexOf(k) !== i), '现仓本来就有重复键 ⇒ 上面那条是假绿').toEqual([])
    // 撞法二：一个不在名单里的新键（第七刀真实犯过的那一种 —— 当时给调度器起的键
    // 与 `summaryRemotes` 重了，所以这里用一颗不存在的域名，专打"额外键要登记"这半条）
    const rogue = core.replace("this.slot('voiceLlm'", "this.slot('scheduler'")
    const rogueKeys = [...rogue.matchAll(/this\.slot\('([a-zA-Z]+)'/g)].map((m) => m[1] ?? '')
    const rogueAccessors = [...rogue.matchAll(/^ {2}protected ([a-zA-Z]+)Remotes\(\): /gm)].map((m) => m[1] ?? '')
    expect(rogueKeys.filter((k) => !rogueAccessors.includes(k) && !EXTRA_SLOTS.includes(k)),
      '凭空多一个槽键没被抓住 ⇒ "额外键要登记"那半是空的').toContain('scheduler')
  })

  /**
   * 联合只收 `gateway-*` 那一层协作者；带 `/` 的那几条（如 `query/image-warm.ts`）住在实现层，
   * 不扩这份联合（扩了「实现搬到哪儿都算」就没有边界了）。它们改由下面那条「接线」判据兜住。
   */
  it('联合读法 `gatewaySource()` 真的把网关层的协作者收进来了（否则"实现搬到哪儿都算"的守卫静默失去靶子）', async () => {
    const { gatewaySource } = await import('./gateway-source.ts')
    const union = gatewaySource()
    for (const [f, names] of EXPORTS) {
      if (f.includes('/')) continue
      for (const n of names) {
        expect(union, `读这份联合的守卫看不见 ${n} —— 它现在住在协作者里`).toContain(`export function ${n}(`)
      }
    }
  })

  /**
   * query 层那一条的接线判据：类必须**从那颗叶子 import**，并把它交给域处理器。
   * 为什么不能只靠 typecheck：漏 import 会红在编译上，但"import 了却忘了传进 deps"
   * 是完全合法的代码 —— 而它的症状是"批量取图慢回去"（预热静默不跑）。
   */
  it('下沉到 query 层的那颗仍然被类接上（import + 交给域处理器，两步都要在）', () => {
    for (const [f, names] of EXPORTS) {
      if (!f.includes('/')) continue
      for (const n of names) {
        expect(core, `gateway-core.ts 没有 import ${n}（它住在 ${f}）`).toContain(`import { ${n} } from './${f}'`)
        expect(core, `gateway-core.ts import 了 ${n} 但没交给任何域处理器`).toContain(`${n},`)
      }
    }
  })
})
