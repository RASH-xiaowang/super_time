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
 * 登记表条数下限（**只许涨**）。2026-09-27 实测 344 条，留 4 条退号的余量。
 *
 * 为什么要有这个数：表按闸门容量切成多份之后，"新的一份忘了聚合进来"不报任何错 ——
 * 那天切完 `batch3c` 就漏接过一次，`MUTATIONS` 从 344 悄悄掉到 306，
 * 而当时唯一的数量判据是「>150」，全绿。号段连续性也拦不住（缺号才 4 个）。
 * 加一条变异就把这个数抬上去；掉下来就是有人把某份表弄丢了。
 */
const REGISTRY_MIN = 340

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
    /**
     * 条目数下限 = 实测条数。由来：把表按容量切成多份之后，"新份忘了聚合进来"是
     * **一条错都不报**的 —— 实测切完 `batch3c` 就漏接过一次，表从 344 悄悄掉到 306，
     * 上面那条 >150 与号段连续性都拦不住（缺口才 4 个号）。所以这里放一个**只许涨**的数：
     * 每登记一条就把 `REGISTRY_MIN` 抬上去；掉下来说明有整份表没接进来或被删了。
     */
    expect(rows.length, `登记表只剩 ${String(rows.length)} 条（下限 ${String(REGISTRY_MIN)}）—— 多半是某一份表没被聚合进 MUTATIONS`).toBeGreaterThanOrEqual(REGISTRY_MIN)
    // 反例自证：丢 38 条（那天真实漏接的量）必须被这个数拦住，否则它只是个装饰。
    expect(rows.length - 38 >= REGISTRY_MIN, `少 38 条仍然过 ⇒ 下限 ${String(REGISTRY_MIN)} 比实测 ${String(rows.length)} 松太多`).toBe(false)
    const nums = rows.map((m) => Number(/^M(\d+)-/.exec(m.id)?.[1] ?? 0)).filter((n) => n > 0)
    expect(new Set(nums).size, '有重号（两份表装了同一条）').toBe(nums.length)
    expect(Math.max(...nums), '读不到号段').toBeGreaterThan(300)
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

  /**
   * 登记表三份文件的每个字段值都写成**一行双引号串** ⇒ 值里出现裸 `"` 就把字符串提前闭合，
   * 整张表加载失败，报出来的是 `Unexpected identifier` 这种看不出根因的错（本仓已撞三次，
   * 每次都是新加一条变异时把中文引号打成 ASCII 引号）。这里按文本扫，是为了让下一次得到
   * 「哪份文件第几行」的精确红，而不是全表 26 条用例一起崩。要在值里引用一段话，用「」。
   */
  it('登记表文本里没有会提前闭合字符串的裸引号', () => {
    const files = [
      'scripts/mutations-registry.mjs',
      'scripts/mutations-registry.batch3.mjs',
      'scripts/mutations-registry.batch3b.mjs',
      'scripts/mutations-registry.batch3c.mjs',
    ]
    const FIELD_LINE = /^(\s*)(id|why|file|from|to|spec): "/
    const CLEAN_LINE = /^\s*(?:id|why|file|from|to|spec): "(?:[^"\\]|\\.)*",?$/
    const bad: string[] = []
    let scanned = 0
    for (const f of files) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!FIELD_LINE.test(line)) return
        scanned += 1
        if (!CLEAN_LINE.test(line)) bad.push(`${f}:${String(i + 1)}`)
      })
    }
    expect(scanned, '一个字段行都没扫到 ⇒ 路径或写法判错，这条是恒真').toBeGreaterThan(100)
    expect(bad, `这些行的值里有裸引号（改用「」引用）：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('每条的字段都是非空字符串（形状与 `mutations-registry.d.mts` 那份声明对得上）', () => {    const bad: string[] = []
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
