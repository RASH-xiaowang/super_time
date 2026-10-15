// @vitest-environment node
/**
 * W3-9.2：insights 一族的 TTL 必须**显式分层**，不许悄悄落在默认值上。
 *
 * ## 这笔账为什么值得单立一条
 *
 * `cachedBySigAsync(key, sig, loader, maxAgeMs = MAX_AGE_MS)` 的默认是 **5 秒**。
 * 那个默认值是为**交互类**查询定的（列表页翻一下就刷新）。insights 不是这一类：
 * 它一次要扫几个分片、做聚合，5 秒内重复算一遍纯属浪费 —— 用户在两块面板之间
 * 来回切一次，就把省下的又吐回去。
 *
 * 所以本条目要求：insights 一族**显式**写自己的 TTL（30s），并且写成一个具名常量
 * 而不是散落的魔法数字 —— 散落数字没人对账，改一处漏三处正是这个仓库反复踩的坑。
 *
 * ## 判据怎么量
 *
 * 从源码读每个 insights 入口的调用行，断言第 4 个实参是**具名常量**
 * （`INSIGHTS_TTL_MS` / `ANNUAL_TTL_MS`），而不是裸数字、也不是缺省。
 * 反向哨兵：把某个调用点的常量换成裸 5000，必须转红（证明判据真的在看这个参数）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUERY = join(HERE, '..', 'src', 'query')
const read = (f: string): string => readFileSync(join(QUERY, f), 'utf8')

/** insights 一族：文件 → 该文件里那一个 `cachedBySigAsync` 调用的缓存键前缀。 */
const INSIGHTS_ENTRIES: ReadonlyArray<{ file: string; key: string }> = [
  { file: 'overview-insights.ts', key: 'overview-insights:' },
  { file: 'moments-insights.ts', key: 'moments-insights:' },
  { file: 'moments-monthly.ts', key: 'moments-monthly:' },
  { file: 'asset-insights.ts', key: 'asset-insights:' },
  { file: 'official-assets.ts', key: 'official-assets:' },
]

/** 年度族：本来就不常变，TTL 更长。 */
const ANNUAL_ENTRIES: ReadonlyArray<{ file: string; key: string }> = [
  { file: 'annual.ts', key: 'annual:' },
]

/** 可接受的 TTL 实参形状：具名常量，不是裸数字、也不是缺省。 */
const TTL_ARG = /,\s*(INSIGHTS_TTL_MS|ANNUAL_TTL_MS)\s*\)\s*$/

describe('W3-9.2：insights 一族的 TTL 必须显式', () => {
  it('每个入口都带具名 TTL 常量（不是裸数字、不是缺省）', () => {
    const bad: string[] = []
    for (const e of [...INSIGHTS_ENTRIES, ...ANNUAL_ENTRIES]) {
      const src = read(e.file)
      const at = src.indexOf(`'${e.key}'`)
      expect(at, `${e.file} 里找不到缓存键 ${e.key}（入口被改名/搬走了？）`).toBeGreaterThan(-1)
      // 取到这条调用的右括号为止（缓存键之后就是调用尾部）。
      const call = src.slice(at, src.indexOf('\n', at))
      if (!TTL_ARG.test(call.trimEnd())) bad.push(`${e.file}（${e.key}）→ ${call.trim().slice(-60)}`)
    }
    expect(bad, '这些 insights 入口没有显式 TTL ⇒ 悄悄落在 5 秒默认值上').toEqual([])
  })

    it('常量本身有定义且取值分层（insights 30s / 年度更长）', () => {
    const meta = read('meta.ts')
    expect(meta, 'INSIGHTS_TTL_MS 没定义').toMatch(/export const INSIGHTS_TTL_MS = \d+/)
    expect(meta, 'ANNUAL_TTL_MS 没定义（annual 一族仍在用裸数字）').toMatch(/export const ANNUAL_TTL_MS = \d+/)
    // 直接从定义行取数，不用「第一个 const」那种近似匹配。
    const num = (re: RegExp): number => {
      const m = re.exec(meta)
      return m === null ? 0 : Number(m[1])
    }
    const insights = num(/export const INSIGHTS_TTL_MS = (\d+)/)
    const annual = num(/export const ANNUAL_TTL_MS = (\d+)/)
    const def = num(/const MAX_AGE_MS = (\d+)/)
    // 反向哨兵：三项都必须是正数，且年度 >= insights > 默认。
    expect(def, '默认 TTL 读不出来').toBeGreaterThan(0)
    expect(insights, 'INSIGHTS_TTL_MS 不是正数').toBeGreaterThan(0)
    expect(annual, 'ANNUAL_TTL_MS 不是正数').toBeGreaterThan(0)
    expect(insights, 'insights 的 TTL 居然不超过默认值 ⇒ 这条改动白做').toBeGreaterThan(def)
    expect(annual, '年度的 TTL 不该比 insights 短（分层反了）').toBeGreaterThanOrEqual(insights)
  })
})