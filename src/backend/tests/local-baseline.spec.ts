/**
 * 「本机基线」这份产物与它的分类口径 —— N36 口径 ① 能不能算，全押在这里。
 *
 * ## 为什么这条要有用例
 *
 * ① 说的是「**(A) 类**榜首中位 ≤15 秒」。CI 只给得出「谁最慢」，给不出「谁在算东西」；
 * 后者要靠**同一份代码在本机跑多久**。这份基线一旦坏掉（半份、并行口径、路径改名后没人管），
 * 分类就会静默错：所有文件都看着像「本机零秒」，于是全被判成 B 类，
 * 而 B 类的处置是「允许带记录重跑一次」——**一条会放过真回归的错法**。
 * 所以产物本身要有守卫，不是「生成一次就信」。
 *
 * ## 分类口径里最反直觉的一条
 *
 * 单看倍率分不开两类。2026-09-24 实测：`kb-files-store` 本机 834 毫秒、CI 10.0 秒（×12）；
 * `gateway-export-stream-progress` 本机 711 毫秒、CI 8.6~35.8 秒（×12~50）。
 * 同一个数量级里既有真活也有停顿 —— 所以那条线是**工程选择**（见 `B_RATIO` 的注释），
 * 而且故意画得偏保守：宁可把一个停顿误留在 A 侧（它照样要减），也不把真代码的慢推到 B 侧。
 *
 * @module tests/local-baseline
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  A_LOCAL_MS,
  B_RATIO,
  baselineCount,
  baselineMs,
  baselineProblems,
  classifyFile,
  type LocalBaseline,
} from './helpers/local-baseline.ts'
import { at } from './helpers/strict-index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'fixtures', 'ci', 'local-baseline.json')
const RAW = JSON.parse(readFileSync(FILE, 'utf8')) as unknown
const BASELINE = RAW as LocalBaseline

describe('提交进来的那份本机基线要自洽（它是一句判据的输入，坏了会静默放行）', () => {
  it('量法是串行、有时间戳、有 head sha，且问题清单是空的', () => {
    expect(baselineProblems(RAW).join('\n'), '产物不自洽 —— 重新 `npm run ci:baseline`，别手改 JSON').toBe('')
    expect(BASELINE.mode).toBe('serial')
    expect(BASELINE.headSha).toMatch(/^[0-9a-f]{7,40}$/)
  })

  it('基线里的每一条路径都还在仓库里（改名/删文件要一起重采，不许留旧账）', () => {
    const gone = Object.keys(BASELINE.files).filter((p) => !existsSync(join(HERE, '..', '..', '..', p)))
    expect(gone.join('\n'), '这些文件已经不在了，但基线还记着它们的毫秒数').toEqual('')
  })

  it('不是半份产物：文件数与套件规模同量级，而且确实量到了慢文件', () => {
    expect(baselineCount(BASELINE), '全量套件有 230 多个文件；只有一百来个说明中途断过').toBeGreaterThanOrEqual(200)
    const slow = Object.entries(BASELINE.files).filter(([, ms]) => ms >= 1000)
    expect(slow.length, '一个 ≥1 秒的文件都没有 ⇒ 八成读错了字段（全 0 的基线会让每个文件都看着像本机很快）').toBeGreaterThanOrEqual(3)
  })

  it('今天那几个当事文件都得在基线里（分类要靠它们，缺一条 ① 就算不出来）', () => {
    const need = [
      'src/backend/wechat-data/tests/search-cursor.spec.ts',
      'src/backend/wechat-data/tests/gateway-export-stream-progress.spec.ts',
      'src/backend/wechat-data/tests/kb-vector-index.spec.ts',
      'src/backend/wechat-data/tests/kb-files-store.spec.ts',
    ]
    const missing = need.filter((p) => typeof BASELINE.files[p] !== 'number')
    expect(missing.join('\n'), '基线里没有它们 ⇒ 重新采一次').toEqual('')
  })
})

describe('baselineMs：量不到是 null，不是 0', () => {
  const b = (files: Record<string, number>): LocalBaseline => ({ headSha: 'aaa1111', measuredAt: '2026-09-24T00:00:00.000Z', mode: 'serial', files })

  it('精确命中优先；只对同一文件名、且只有一条时才认宽松匹配', () => {
    const m = b({ 'src/a/x.spec.ts': 1200, 'src/b/y.spec.ts': 300 })
    expect(baselineMs(m, 'src/a/x.spec.ts')).toBe(1200)
    expect(baselineMs(m, 'src/renamed/y.spec.ts'), '目录改了名但同名只有一条 ⇒ 认').toBe(300)
    expect(baselineMs(m, 'src/nope.spec.ts'), '完全没有这条 ⇒ null（不许退成 0）').toBeNull()
    const dup = b({ 'src/a/x.spec.ts': 100, 'src/b/x.spec.ts': 900 })
    expect(baselineMs(dup, 'src/c/x.spec.ts'), '同名两条就没法选 ⇒ 宁可 null').toBeNull()
  })

  it('坏值也当没量到（0 是合法读数吗？这里选择：负数与非有限值都不认）', () => {
    expect(baselineMs(b({ 'a.spec.ts': -5 }), 'a.spec.ts')).toBeNull()
    expect(baselineMs(b({ 'a.spec.ts': Number.NaN }), 'a.spec.ts')).toBeNull()
  })
})

describe('classifyFile：A/B 的分界与它明知不够的地方', () => {
  it('本机就要 ≥1 秒的，不论倍率先归 A（时间确有出处）', () => {
    expect(classifyFile(A_LOCAL_MS, 10 * A_LOCAL_MS)).toBe('A')
    expect(classifyFile(3700, 15500), 'search-cursor：本机 3.7 秒、CI 15.5 秒 ⇒ 真活').toBe('A')
    // 边界含等于：本机刚好一秒、CI 六十倍 —— 仍然算 A。这条钉住的是「本机有真活就先归 A」这条优先级，
    // 写成 `> A_LOCAL_MS` 的话这个点会掉进倍率分支，被判成 B 类（然后被「允许重跑」放过）。
    expect(classifyFile(A_LOCAL_MS, 60 * A_LOCAL_MS), '本机 1.0 秒整 ⇒ 即使 CI ×60 也还是 A').toBe('A')
  })

  it('本机几乎不花时间、CI 慢过线 ⇒ B；没过线仍然算 A', () => {
    expect(classifyFile(711, 35800), 'gateway-export-stream-progress 最差那次：本机 711 毫秒 / CI 35.8 秒 ⇒ 停顿').toBe('B')
    expect(classifyFile(834, 10000), 'kb-files-store：834 毫秒 / 10.0 秒 = ×12，还没到 B_RATIO ⇒ 留在 A').toBe('A')
    expect(classifyFile(100, 100 * B_RATIO), '刚好到 20 倍 ⇒ B（边界含）').toBe('B')
    expect(classifyFile(100, 100 * B_RATIO - 1), '差一点点 ⇒ 还不算 B').toBe('A')
  })

  it('没有基线就是 unknown —— 不猜', () => {
    expect(classifyFile(null, 90000)).toBe('unknown')
    expect(classifyFile(-1, 90000)).toBe('unknown')
    expect(classifyFile(Number.NaN, 90000)).toBe('unknown')
  })

  it('真实那份产物算出来的类别要能对上今天的实测（这条会在重采之后仍然成立）', () => {
    const cls = (p: string, ciMs: number): string => classifyFile(baselineMs(BASELINE, p), ciMs)
    expect(cls('src/backend/wechat-data/tests/search-cursor.spec.ts', 15500)).toBe('A')
    expect(cls('src/backend/wechat-data/tests/kb-vector-index.spec.ts', 26000), '本机一千毫秒级、CI 二十几秒 ⇒ ×20 以上才叫停顿；这一条看实际采到的数').not.toBe('unknown')
    expect(cls('src/backend/tests/no-such-file-here.spec.ts', 5000), '基线里没有 ⇒ unknown').toBe('unknown')
  })
})

describe('baselineProblems 认得出坏产物（不能让半份、并行口径的产物静默通过）', () => {
  const good: LocalBaseline = { headSha: 'abc1234', measuredAt: '2026-09-24T00:00:00.000Z', mode: 'serial', files: {} }
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/a/f${String(i)}.spec.ts`, i >= 3 ? 1200 : 5]))

  it('一份好的产物问题清单是空的（先证明这条判据不是恒红）', () => {
    expect(baselineProblems({ ...good, files: many }).join('\n')).toBe('')
  })

  it('并行口径 / 半份 / 全 0 / 键不是 spec 路径 —— 四种坏法各喊一声', () => {
    expect(baselineProblems({ ...good, files: many, mode: 'parallel' }).join('\n')).toContain('只有串行口径可比')
    expect(baselineProblems({ ...good, files: { 'src/a/x.spec.ts': 1200 } }).join('\n')).toContain('多半是中途失败')
    const zeros = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/a/f${String(i)}.spec.ts`, 0]))
    expect(baselineProblems({ ...good, files: zeros }).join('\n')).toContain('全 0 的基线')
    expect(baselineProblems({ ...good, files: { ...many, 'src/a/not-a-test.ts': 9000 } }).join('\n')).toContain('不像测试文件路径')
    expect(baselineProblems(null).length, '非对象要有一条，不能返回空清单').toBeGreaterThan(0)
  })

  it('时间戳读不出来也要喊（否则没人知道这份基线旧到什么程度）', () => {
    const bad = at(baselineProblems({ ...good, files: many, measuredAt: '昨天' }), 0, '时间戳那条')
    expect(bad).toContain('measuredAt')
  })
})
