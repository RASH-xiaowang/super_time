/**
 * 变异登记表的**锚点不许腐烂**守卫（登记纪律自己的机检）。
 *
 * 为什么现在补这一条：本仓有三次「改了代码 ⇒ 某条早就登记的变异锚点悄悄失配」的事故
 * （M63/M64 因 `cachedBySig`→`cachedBySigAsync` 改名、M54 因写入侧改动、M124 因空白差异）。
 * 三次都**不是人眼看到的**，而是有人手动跑了全表才报出「锚点失效 / 未执行」——
 * 而全表一次要跑两百多次 vitest，事实上没人每轮都跑。于是「这条守卫到底会不会咬」
 * 这个事实在两轮之间是**没人守着**的：锚点失配 = 那条反证静默失效 = 下一轮以为还防着。
 *
 * 这一条把那个检查变成普通单测里的一环：每条变异的 `from` 必须在目标文件里**恰好命中一次**
 * （命中 0 次 ⇒ 锚点腐烂；命中 ≥2 次 ⇒ 跑手会拒绝执行，因为它无法确定改哪一处）。
 * 顺手把登记表的其他结构性前提一起钉：条目数量级、id 唯一、`spec` 文件存在、`to` 与 `from` 不同。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Mutation = { id: string; why: string; file: string; from: string; to: string; spec: string }
/**
 * 登记表是 `.mjs`（跑手与判据共用一份数据），测试树没开 `allowJs` ⇒ 走**动态导入**，
 * 形状由 `scripts/mutations-registry.d.mts` 声明（静态 `import` 与动态 `import` 都会被
 * tsc 报成「找不到声明文件」）。声明与数据是否对得上，由下面那条「每条的字段都是非空字符串
 * （`to` 允许为空 —— 那是「把这段删掉」型变异）」的运行时断言兜住 —— 写错的声明不会让这条守卫静默变宽。
 */
const { MUTATIONS } = await import('../../../scripts/mutations-registry.mjs')
const rows: readonly Mutation[] = MUTATIONS

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * 表里除 `to` 之外的五个字段都必须是非空字符串（缺一个字段，跑手就会报成"锚点失效"这种误导性结论）。
 * `to` 允许为空：那是「把这段删掉」型变异（实测有七条这么写）。
 */
const FIELDS = ['id', 'why', 'file', 'from', 'spec'] as const

/**
 * 数锚点命中次数，**与跑手 `scripts/mutation-check.mjs#locate` 同口径**：
 * 先按 LF 找，找不到再按 CRLF 找（本仓既有 LF 文件也有 CRLF 文件，锚点一律写 LF）。
 * 两边必须同一套规则，否则这条守卫会报假腐烂 —— 第一次写就踩到了（三条"缺陷"其实都能命中）。
 */
function countHits(haystack: string, needle: string): number {
  const lf = haystack.split(needle).length - 1
  if (lf === 1) return 1
  const crlf = needle.replace(/\n/g, '\r\n')
  if (crlf === needle) return lf
  const cn = haystack.split(crlf).length - 1
  return cn > 0 ? cn : lf
}

/** 一张表里所有锚点问题：`id → 说明`。判据与反例自证共用这一段，保证测的是同一条码路径。 */
function anchorDefects(list: readonly Mutation[]): string[] {
  const bad: string[] = []
  for (const m of list) {
    const abs = join(ROOT, m.file)
    if (!existsSync(abs)) { bad.push(`${m.id} 目标文件不存在：${m.file}`); continue }
    const hits = countHits(readFileSync(abs, 'utf8'), m.from)
    if (hits === 0) bad.push(`${m.id} 锚点命中 0 次（腐烂：那个形状已经从源码里改掉或删了）：${m.file}`)
    else if (hits > 1) bad.push(`${m.id} 锚点命中 ${String(hits)} 次（不唯一，跑手无法确定改哪一处）：${m.file}`)
    if (m.from === m.to) bad.push(`${m.id} 的 from 与 to 相同（这条变异不会改变任何东西）`)
    if (!existsSync(join(ROOT, m.spec))) bad.push(`${m.id} 指定的判据文件不存在：${m.spec}`)
  }
  return bad
}

describe('变异登记表的锚点不许腐烂', () => {
  it('表不是空的，也不是半张表（聚合出问题的话判据会退化成恒真）', () => {
    expect(rows.length, '一条变异都没登记到 —— 聚合是不是坏了').toBeGreaterThan(150)
    // 打的那一刀可以在源码、脚本或文档里（`scripts/panel-audit.mjs`、`docs/PRIVACY.md` 都有），
    // 但**判据**必须在测试树里 —— 不然「这条守卫会不会咬」就没有可跑的东西。
    const offSpec = rows.filter((m) => !m.spec.startsWith('src/')).map((m) => m.id)
    expect(offSpec, '这些条目指定的判据不在 src 测试树里').toEqual([])
  })

  it('每条都有 why（反证不是靠猜：为什么这一刀该咬人必须写在表里）', () => {
    const thin = rows.filter((m) => m.why.trim().length < 12).map((m) => m.id)
    expect(thin, '这些条目没写理由').toEqual([])
  })

  it('id 唯一（重号会让 --only 与结果账本错位）', () => {
    const seen = new Set<string>()
    const dup = rows.filter((m) => (seen.has(m.id) ? true : (seen.add(m.id), false))).map((m) => m.id)
    expect(dup, '这些变异 id 重复了').toEqual([])
  })

  it('每条的字段都是非空字符串（形状与 `mutations-registry.d.mts` 那份声明对得上）', () => {
    const bad: string[] = []
    for (const m of rows) {
      for (const f of FIELDS) {
        const v = m[f]
        if (typeof v !== 'string' || v.trim() === '') bad.push(`${m.id}.${f}`)
      }
    }
    expect(bad, '这些字段缺失或为空 —— 跑手对缺字段的条目会报成「锚点失效」那种误导性结论').toEqual([])
  })

  it('每条锚点在目标文件里恰好命中一次，且指定的判据文件还在', () => {
    expect(anchorDefects(rows), `登记表有 ${String(rows.length)} 条，逐条核对结果：`).toEqual([])
  })

  it('反例自证：四种坏法都能被同一段判据分出来', () => {
    // 锚点拼出来写：**字面量写进本文件就会让它在文件里出现两次**（定义 + 这条用例自己），
    // 于是"恰好命中一次"的对照条目自己把自己判成坏 —— 第一次写就踩到了这个自指坑。
    const sample = ['function ', 'countHits('].join('')
    const dupFrom = ['bad.pu', 'sh('].join('')
    const good: Mutation = { id: 'G-ok', why: '这是一条用来当对照的好条目', file: 'src/backend/tests/mutation-registry-anchors.spec.ts', from: sample, to: 'function countHitsX(', spec: 'src/backend/tests/mutation-registry-anchors.spec.ts' }
    expect(anchorDefects([good]), '连对照条目都报坏 ⇒ 判据本身有问题').toEqual([])
    // ① 锚点腐烂（现仓不存在的一段）
    const rotten: Mutation = { ...good, id: 'R-rotten', from: ['const ', '这段全仓都不存在的锚点 = 1'].join('') }
    expect(anchorDefects([rotten])[0] ?? '').toContain('命中 0 次')
    // ② 锚点不唯一（本文件里这段出现两次以上）
    const dup: Mutation = { ...good, id: 'R-dup', from: dupFrom }
    expect(anchorDefects([dup])[0] ?? '').toContain('命中')
    // ③ from === to（改了等于没改）
    const noop: Mutation = { ...good, id: 'R-noop', to: sample }
    expect(anchorDefects([noop])[0] ?? '').toContain('不会改变任何东西')
    // ④ 判据文件不存在（跑手会把红记到一个不存在的文件上）
    const ghost: Mutation = { ...good, id: 'R-ghost', spec: 'src/backend/tests/这个文件不存在.spec.ts' }
    expect(anchorDefects([ghost])[0] ?? '').toContain('判据文件不存在')
    // ⑤ 目标文件不存在
    const missing: Mutation = { ...good, id: 'R-missing', file: 'src/backend/这个文件不存在.ts' }
    expect(anchorDefects([missing])[0] ?? '').toContain('目标文件不存在')
  })
})
