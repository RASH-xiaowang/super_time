/**
 * 「每一处性能修复都被守卫管到」的对账门禁（2026-09-29）。
 *
 * ## 为什么需要它
 *
 * 上一轮我手工对了一次账，发现 **2 处"修过但没人管"**：
 * `query/moments-monthly.ts` 与 `remotes/keysdec.ts` 都**直接调 `yieldToLoop`**，
 * 却不在 P1-2 零容忍清单里 —— 也就是说随时能退回到"从头钉到尾"的同步形状而无人报警。
 * 手工对账只解决那一次；下次再漏登记仍然只能靠人想起来。
 *
 * 所以把对账**变成常驻判据**：
 *   ① 下面 {@link REPAIRED_MODULES} 里逐个钉住的修复模块（这份名单原先是从一份
 *      已删除的性能台账表格里现场抽取的，见文件头「2026-10-08」那一节）；
 *   ② 每个模块必须**要么**直接调 `yieldToLoop()`，**要么**在下面的委派白名单里；
 *   ③ 白名单里的"被委派方"必须自己受守卫（在 P1-2 清单里且真的含 `yieldToLoop`），
 *      否则白名单就是一句空话；
 *   ④ **双向**：白名单里不许留已经不需要的条目（模块改名/改回直接让出时要来删），
 *      免得它悄悄腐烂成"永远为真的豁免"。
 *
 * ## 判据边界（写清楚，免得被当成万能）
 *
 * 它管的是「**这个模块有没有让出机制**」，**不是**「让出的粒度对不对」——
 * 粒度问题由 `query-yield-discipline.spec.ts` 里那些 tick 下界探针管。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 本文件在 src/backend/wechat-data/tests/ ⇒ 到仓库根是**四级**上溯。
const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const BACKEND_SRC = join(ROOT, 'src', 'backend', 'wechat-data', 'src')
const YIELD_SPEC = join(ROOT, 'src', 'backend', 'wechat-data', 'tests', 'query-yield-discipline.spec.ts')

/**
 * 逐条对过账的「修过性能、必须受让出守卫」的模块（相对 `src/backend/wechat-data/src`）。
 *
 * **2026-10-08：这份名单从台账文档内联进本文件。** 原来 ① 是从那份台账的表格里现场抽取的，
 * 台账随文档精简删除后输入就没了 —— 而判据本身必须留着：它守的是
 * 「这些模块随时能退回到从头钉到尾的同步形状而无人报警」，与台账无关。
 * 这里是按原正则抽出来的**同一批 18 个**，未重新挑选（复核命令见文件头）。
 * 名单现在是本文件的单一真源：又修了一个模块的让出问题就往这里加一行。
 *
 * ⚠️ 别把这一步"顺手简化"成扫目录：原来那张表是**逐条人工对账**的结果，
 * 按目录扫会把没修过的模块也拉进来 —— 那是对账口径的改变，不是等价重构。
 */
const REPAIRED_MODULES = [
  'keys/image-key-resolver.ts',
  'query/annual-report.ts',
  'query/annual-review.ts',
  'query/asset-insights.ts',
  'query/backup.ts',
  'query/calls.ts',
  'query/daily-summary.ts',
  'query/export-flows.ts',
  'query/image-original-batch.ts',
  'query/image-upgrade.ts',
  'query/messages.ts',
  'query/moments-insights.ts',
  'query/moments-monthly.ts',
  'query/official-assets.ts',
  'query/overview.ts',
  'query/sessions.ts',
  'query/sns-video.ts',
  'query/wordcloud.ts',
  'remotes/tasks.ts',
] as const

/**
 * 委派让出的白名单：模块本身**连 `yieldToLoop` 这个词都不出现**，纯粹靠调用受守卫的函数让出。
 *
 * ⚠️ 分档要精确（我一开始搞混过）：把 `yieldToLoop` 作为**回调传出去**的模块
 * （`remotes/tasks.ts`、`remotes/summaryrec.ts`）文件里**含**这个词，因此走"直接让出"那一档，
 * **不需要**挂在这里 —— 挂上来会让白名单显得比实际更必要。
 *
 * `target` 必须是一个**受守卫的模块**（在 P1-2 清单里、且含 `yieldToLoop`）——
 * 第 ③ 条断言会验这一点，所以这里不许写"因为历史原因"这类空话。
 */
const DELEGATED: Record<string, { target: string; why: string }> = {
  'keys/image-key-resolver.ts': {
    target: 'remotes/keysdec.ts',
    why: '扫描做成生成器（`scanV2TemplatesSteps`），让出节流由调用方 `keysdec.ts` 注入的 `onStep` 决定',
  },
  'remotes/export.ts': {
    target: 'query/export-flows.ts',
    why: '导出壳只做转发，真正扫描在 `export-flows.ts`',
  },
}

/** 修复模块名单（去重后的拷贝）。 */
function ledgerModules(): string[] {
  return [...new Set(REPAIRED_MODULES)]
}

/**
 * 该文件是否满足「直接让出」这一档。
 *
 * 口径**刻意与 P1-2 守卫一致**（`includes('yieldToLoop')`）：两边口径不同的话，
 * 会出现"这条说它有让出、那条说它没有"的分裂结论。
 * 注意这比"真的调用了"宽 —— `query/image-original-batch.ts` / `daily-summary.ts`
 * 是把 `yieldToLoop` 作为 `onStep` **传出去**，也算直接让出档（它们确实在 P1-2 清单里）。
 */
function mentionsYieldToLoop (src: string): boolean {
  return src.includes('yieldToLoop')
}

/** 真的**调用**了（`await yieldToLoop()`），用于第 ④ 条"白名单是否过期"。 */
function callsYieldToLoop (src: string): boolean {
  return src
    .split('\n')
    .some((l) => !/^\s*import\b/.test(l) && /await\s+yieldToLoop\(/.test(l))
}

/** P1-2 清单里的模块名（只到 basename）。 */
function guardedBasenames (): Set<string> {
  const t = readFileSync(YIELD_SPEC, 'utf8')
  const m = /P1_2_MODULES[^=]*=\s*\[([\s\S]*?)\]/.exec(t)
  return new Set([...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] ?? ''))
}

/**
 * 把"哪些模块没被管住"抽成**纯函数**，这样反例可以用合成输入直接演，
 * 不必真去改仓库文件（改文件的反例会在失败时留下垃圾）。
 * @param mods - 待检查的模块相对路径。
 * @param readSrc - 读源码的注入点（测试里可给假实现）。
 * @param whitelist - 委派白名单。
 * @returns 既不让出、也不在白名单里的模块。
 */
function findUnguarded (
  mods: string[],
  readSrc: (rel: string) => string | null,
  whitelist: Record<string, unknown>,
): string[] {
  const out: string[] = []
  for (const rel of mods) {
    const src = readSrc(rel)
    if (src === null) continue // 文件不存在由另一条断言负责
    if (mentionsYieldToLoop(src)) continue
    if (whitelist[rel] !== undefined) continue
    out.push(rel)
  }
  return out
}

describe('账本里每一处性能修复都必须有让出守卫（含委派白名单）', () => {
  const modules = ledgerModules()
  const guarded = guardedBasenames()
  /** 读一个账本模块的源码；不存在返回 null。 */
  const readModule = (rel: string): string | null => {
    const p = join(BACKEND_SRC, ...rel.split('/'))
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  it('哨兵：账本抽出了 20 行、且清单非空（否则下面几条是空转）', () => {
    expect(modules.length, '账本没抽出模块 ⇒ 表格格式变了或文件被删').toBeGreaterThanOrEqual(15)
    expect(guarded.size, 'P1-2 清单为空 ⇒ 判据空转').toBeGreaterThanOrEqual(20)
  })

  it('每个修复模块：要么直接让出，要么在委派白名单里', () => {
    for (const rel of modules) {
      expect(existsSync(join(BACKEND_SRC, ...rel.split('/'))), `账本里写的模块不存在：${rel}（改了名就要同步账本）`).toBe(true)
    }
    const unguarded = findUnguarded(modules, readModule, DELEGATED)
    expect(
      unguarded,
      '这些模块既没有直接让出、也不在委派白名单里 ⇒ 上一次的性能修复没有被任何守卫管住：\n  ' + unguarded.join('\n  '),
    ).toEqual([])
  })

  it('委派白名单里的每个"被委派方"自己都受守卫（否则白名单是空话）', () => {
    const bad: string[] = []
    for (const [rel, info] of Object.entries(DELEGATED)) {
      const targetPath = join(BACKEND_SRC, ...info.target.split('/'))
      if (!existsSync(targetPath)) { bad.push(`${rel}: 被委派方不存在 ${info.target}`); continue }
      const base = info.target.split('/').pop() ?? ''
      if (!guarded.has(base)) { bad.push(`${rel}: 被委派方 ${info.target} 不在 P1-2 清单里`); continue }
      if (!readFileSync(targetPath, 'utf8').includes('yieldToLoop')) {
        bad.push(`${rel}: 被委派方 ${info.target} 不含 yieldToLoop`)
      }
    }
    expect(bad, '委派白名单指向了不受守卫的目标：\n  ' + bad.join('\n  ')).toEqual([])
  })

  it('双向：白名单里不许留已经不需要的条目（模块改回直接让出时要来删）', () => {
    const stale: string[] = []
    for (const [rel, info] of Object.entries(DELEGATED)) {
      const p = join(BACKEND_SRC, ...rel.split('/'))
      if (!existsSync(p)) { stale.push(`${rel}: 文件已不存在（被委派方 ${info.target}）`); continue }
      // 真正的腐烂信号：它现在**已经**自己直接调 `yieldToLoop()` ⇒ 不该再挂在白名单上。
      // ⚠️ 这里**不能**要求"必须出现在账本表格里"：账本那张表只列被优化的**接口**，
      // 而白名单里有些是纯转发壳（如 `remotes/export.ts`），本来就不占一行。
      // 第一版这么写，把两个合法条目误判成过期。
      if (callsYieldToLoop(readFileSync(p, 'utf8'))) {
        stale.push(`${rel}: 现在已直接调 yieldToLoop ⇒ 应从白名单删掉（并考虑进 P1-2 清单）`)
      }
    }
    expect(stale, '委派白名单里有过期条目：\n  ' + stale.join('\n  ')).toEqual([])
  })

  it('反例自证：用合成输入演"修复被退回"与"漏登记"，两种都必须被咬住', () => {
    // 上面几条断言的价值全在于"漏了会红"。这里用**注入的假源码**把两种真实事故各演一遍，
    // 不落盘、不改仓库文件（改文件的反例在失败时会留下垃圾）。
    const fake: Record<string, string> = {
      // 被退回同步形状：不含 yieldToLoop
      'query/annual-report.ts': 'export function queryAnnualReport(): void { /* 同步跑完 */ }',
      // 正常让出
      'query/calls.ts': "import { yieldToLoop } from './search-build.ts'\nawait yieldToLoop()\n",
      // **纯转发**：连 `yieldToLoop` 这个词都不出现 ⇒ 才会走到白名单那一档。
      'remotes/export.ts': "import { exportMoments } from '../query/export-flows.ts'\nreturn exportMoments(dir, opts)",
      // 把 yieldToLoop 当回调**传出去**：含这个词 ⇒ 归"直接让出"档，不靠白名单。
      'remotes/tasks.ts': 'await collectPeriodMessagesAsync(d, f, t, 50, yieldToLoop)',
    }
    const readFake = (rel: string): string | null => fake[rel] ?? null

    // ① 被退回 + 不在白名单 ⇒ 必须被找出来（且只找出它一个）。
    const onlyReverted = findUnguarded(
      ['query/annual-report.ts', 'query/calls.ts'],
      readFake,
      DELEGATED,
    )
    expect(onlyReverted, '退回同步形状却没被咬住 ⇒ 判据是空转').toEqual(['query/annual-report.ts'])

    // ② 纯转发模块靠白名单豁免；把白名单拿掉就必须被咬住
    expect(mentionsYieldToLoop(fake['remotes/export.ts'] ?? ''), '反例前提不成立：它不该含 yieldToLoop').toBe(false)
    expect(findUnguarded(['remotes/export.ts'], readFake, DELEGATED), '白名单豁免失效').toEqual([])
    expect(findUnguarded(['remotes/export.ts'], readFake, {}), '去掉白名单后仍放行 ⇒ 豁免不是白名单在起作用')
      .toEqual(['remotes/export.ts'])

    // ③ 传回调那一档：含 `yieldToLoop` 就该直接放行，**不需要**白名单
    //    （这正是我一开始搞混的地方：`remotes/tasks.ts` 其实走这一档）。
    expect(findUnguarded(['remotes/tasks.ts'], readFake, {}), '传回调的模块不该需要白名单').toEqual([])

    // ④ "漏登记"这一侧：`callsYieldToLoop` 必须能区分"真的调用"与"只 import"。
    expect(callsYieldToLoop(fake['query/calls.ts'] ?? ''), '真的 `await yieldToLoop()` 应判为调用').toBe(true)
    expect(callsYieldToLoop("import { yieldToLoop } from './search-build.ts'\n"), '只 import 不该判为调用').toBe(false)
  })
})
