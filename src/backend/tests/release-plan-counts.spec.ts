/**
 * 「还剩多少任务」这个问题本身要有守卫 —— 台账与进度总览会各自腐烂。
 *
 * ## 为什么登记这条（2026-09-24 实测到的三处漂移）
 *
 * 本条是在给 N32 收尾时顺手发现的：`docs/RELEASE-PLAN.md` 是「剩余任务」的唯一来源，
 * 而它的三处计数都已经和文档自己对不上了 ——
 *
 *   ① 阶段 5 的条目表实际有 53 条，进度总览写着 51；
 *   ② `### 工作流 D ·（7 项）`下面有 9 行、`### 工作流 F ·（19 项）`下面有 24 行；
 *   ③ 更要紧的是：**N33 / N34 / N35 / N36 只登记了台账行，没进条目表**，
 *      于是「条目表里没写 = 不存在」，两条还没关闭的 CI 偶发问题（N33、N36）
 *      在总览里根本看不见 —— 一个声称「0 未开始」的表格，就是这么把未开始的工作藏掉的。
 *
 * 这类漂移没有功能后果，所以永远不会有人主动去修；它的后果是**让「已达成上线标准」这句话
 * 变得不可信**。既然本文件的存在意义就是回答「还差什么」，那它的数字就得有机检。
 *
 * ## 口径（与 `scripts/` 里那两个计数脚本无关，只认本文档）
 *
 * 条目两种写法都认：阶段 0–4 用 `### \`[x]\` H3 · 标题`（勾上即已完成），阶段 5/6 用条目表里
 * 以 `| ID |` 打头的行，状态取该行的**最后一个字段**开头匹配。ID 按「字母+数字」认 ——
 * 阶段 6 是 `L` 前缀，写死 `[MHNC]` 会把那 23 条整段漏掉（第一版就漏了，报出「阶段 6 只有 3 条」）。
 *
 * 防空转：所有断言都建立在「解析出来的东西非空」上（阶段数、条目总数、每个阶段条目数），
 * 解析口径一坏就是红，而不是「两边都空所以相等」。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { at, grp } from './helpers/strict-index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN = join(HERE, '..', '..', '..', 'docs', 'RELEASE-PLAN.md')
const LINES = readFileSync(PLAN, 'utf8').split(/\r?\n/)

const PHASE_RE = /^##+\s*[一二三四五六七八九十]+、(阶段 \d+)/
const ID_HEAD = /^###\s+`\[( |x)\]`\s+([A-Za-z]+\d+)\s*·/
const ID_ROW = /^\|\s*([A-Za-z]+\d+)\s*\|/
const WF_HEAD = /^###\s+工作流\s+([A-Z])\s+·\s+(.*)（(\d+)\s*项）/
const OVERVIEW = /^\|\s*阶段 (\d)\s*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/
const TOTAL_ROW = /^\|\s*\*\*合计\*\*\s*\|[^|]*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/

type Tally = { 未开始: number, 进行中: number, 待验收: number, 已完成: number }

const empty = (): Tally => ({ 未开始: 0, 进行中: 0, 待验收: 0, 已完成: 0 })

/**
 * 拆表格行的字段：只认**没被反斜杠转义**的竖线。
 *
 * 为什么要专门写这个而不是 `split('|')`：条目正文里合法地会出现竖线（类型 `string | undefined`、
 * 绝对值记法 `mean|d|`），而那些在 markdown 里必须转义成 `\|` 才不换列 —— 转义以后普通的
 * `split('|')` 又会把它当成换列。两种错法各红一半，所以这里统一按「未转义的竖线」切。
 */
function cellsOf (line: string): string[] {
  return line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim())
}

/** 状态取表格行最后一个字段；认不出的一律算「未开始」—— 宁可虚报未做，不可虚报已做。 */
function statusOf(line: string): keyof Tally {
  const cells = cellsOf(line)
  const last = at(cells, cells.length - 1, '表格字段')
  if (/^已完成/.test(last)) return '已完成'
  if (/^待验收/.test(last)) return '待验收'
  if (/^进行中/.test(last)) return '进行中'
  return '未开始'
}

/** 阶段边界：从它的标题行到下一个阶段标题（或第一个非阶段的一级章节）。 */
function phaseRanges(): Array<{ phase: string, start: number, end: number }> {
  const marks: Array<{ phase: string, start: number }> = []
  LINES.forEach((l, i) => {
    const m = PHASE_RE.exec(l)
    if (m) marks.push({ phase: grp(m, 1, '阶段标题'), start: i })
  })
  const last = at(marks, marks.length - 1, '阶段标记').start
  let tail = LINES.length
  for (let i = last + 1; i < LINES.length; i += 1) {
    const l = at(LINES, i, '行')
    if (/^##+\s*(十[一二三四五六七八九]?|附录|变更)/.test(l) && !PHASE_RE.test(l)) { tail = i; break }
  }
  return marks.map((b, k) => ({
    phase: b.phase,
    start: b.start,
    end: k + 1 < marks.length ? at(marks, k + 1, '阶段标记').start : tail,
  }))
}

const RANGES = phaseRanges()

/** 数一个片段里的条目（两种写法都认），返回 id → 状态。 */
function countItems(start: number, end: number): Map<string, keyof Tally> {
  const ids = new Map<string, keyof Tally>()
  for (let i = start; i < end; i += 1) {
    const line = at(LINES, i, '行')
    const h = ID_HEAD.exec(line)
    if (h) { ids.set(grp(h, 2, '条目标题'), grp(h, 1, '条目标题') === 'x' ? '已完成' : '未开始'); continue }
    const t = ID_ROW.exec(line)
    if (t) ids.set(grp(t, 1, '条目行'), statusOf(line))
  }
  return ids
}

const PHASES = RANGES.map((r) => {
  const tally = empty()
  let unknown = 0
  for (const st of countItems(r.start, r.end).values()) {
    if (st in tally) tally[st] += 1
    else unknown += 1
  }
  return { phase: r.phase, n: tally.未开始 + tally.进行中 + tally.待验收 + tally.已完成, tally, unknown, range: r }
})

/**
 * 条目行的**列数**（形状）。
 *
 * 表格行的列数必须等于它所属表头的列数，否则渲染出来是错位的：少一列 ⇒ 最后那格（状态）
 * 显示在「验收标准」那一列上；多一列 ⇒ 正文里有一根没转义的竖线（类型 `string | undefined`、
 * 绝对值 `mean|d|` 这类），一句话被劈成两格。两种都不会让任何**内容**变错，所以肉眼读原文
 * 看不出来，只有数得出来。
 */
function rowShapes(): Array<{ id: string, line: number, cells: number, header: number }> {
  const out: Array<{ id: string, line: number, cells: number, header: number }> = []
  let header = 0
  for (let i = 0; i < LINES.length; i += 1) {
    const l = at(LINES, i, '行')
    if (/^\|\s*ID\s*\|/.test(l)) { header = cellsOf(l).length; continue }
    const m = ID_ROW.exec(l)
    if (!m) { if (!l.startsWith('|')) header = 0; continue }
    out.push({ id: grp(m, 1, '条目行'), line: i + 1, cells: cellsOf(l).length, header })
  }
  return out
}

const SHAPES = rowShapes().filter((s) => s.header > 0)

/**
 * 今天的既有欠账（**只许变短**）：这几行与本表表头列数不符。
 * 列进来不是为了放行，是为了「修一行必须同时把名单改短」—— 与 M21 那个白名单同一种棘轮。
 * 每一项都记在 N38 里，需要人判断的是「证据位置到哪里为止、验收标准从哪里开始」。
 */
const WIDE_DEBT = ['M12', 'M18', 'M19', 'N31']
const SHORT_DEBT = ['M1', 'M8', 'M9', 'M10', 'M11', 'M13', 'M14', 'M15', 'M16', 'M17',
  'N14', 'N15', 'N16', 'N17', 'N18', 'N19', 'N20', 'N21', 'N22']

describe('RELEASE-PLAN 的计数与文档内容一致（「还剩什么」这个问题本身要能信）', () => {
  it('阶段标题都解析到了，且条目表不是空的（解析口径坏了要红，而不是「两边都空所以相等」）', () => {
    expect(PHASES.length, '一个阶段标题都没解析到，八成是标题格式改了').toBeGreaterThanOrEqual(7)
    const total = PHASES.reduce((a, p) => a + p.n, 0)
    expect(total, '条目总数低得可疑 —— 数条目的口径失效了').toBeGreaterThanOrEqual(90)
    for (const p of PHASES) expect(p.n, `${p.phase} 一条目都没数到`).toBeGreaterThan(0)
    for (const p of PHASES) expect(p.unknown, `${p.phase} 有认不出的状态词`).toBe(0)
  })

  it('进度总览里每个阶段的四个计数与条目状态相加一致', () => {
    const seen = new Set<string>()
    for (const line of LINES) {
      const m = OVERVIEW.exec(line)
      if (!m) continue
      const phase = '阶段 ' + grp(m, 1, '进度总览行')
      const found = PHASES.find((p) => p.phase === phase)
      expect(found, `进度总览写了「${phase}」，正文里却没有这个阶段`).toBeTruthy()
      // 上面那条 expect 不改变类型，所以这里按 phase 重新取一次（取不到就直接抛，不咽掉）
      const t = at(PHASES.filter((p) => p.phase === phase), 0, '阶段统计').tally
      const declared = Number(grp(m, 2, '进度总览行'))
      expect(declared, `${phase}：总览写 ${declared} 条，条目表实际 ${t.未开始 + t.进行中 + t.待验收 + t.已完成} 条`)
        .toBe(t.未开始 + t.进行中 + t.待验收 + t.已完成)
      expect(Number(grp(m, 3, '进度总览行')), `${phase}：未开始 对不上`).toBe(t.未开始)
      expect(Number(grp(m, 4, '进度总览行')), `${phase}：进行中 对不上`).toBe(t.进行中)
      expect(Number(grp(m, 5, '进度总览行')), `${phase}：待验收 对不上`).toBe(t.待验收)
      expect(Number(grp(m, 6, '进度总览行')), `${phase}：已完成 对不上`).toBe(t.已完成)
      seen.add(phase)
    }
    expect(seen.size, '进度总览那张表没解析到任何阶段行').toBeGreaterThanOrEqual(7)
  })

  it('合计行等于各阶段相加（不是抄来的）', () => {
    const line = LINES.find((l) => TOTAL_ROW.test(l))
    if (line === undefined) throw new Error('找不到「**合计**」那一行 —— 那张表的格式变了')
    const m = TOTAL_ROW.exec(line)
    if (m === null) throw new Error('找到了合计那一行却没匹配上正则 —— TOTAL_ROW 要跟着改')
    const sum = (k: '未开始' | '进行中' | '待验收' | '已完成') =>
      PHASES.reduce((a, p) => a + p.tally[k], 0)
    expect(Number(grp(m, 1, '合计行')), '合计·条目数 对不上')
      .toBe(sum('未开始') + sum('进行中') + sum('待验收') + sum('已完成'))
    expect(Number(grp(m, 2, '合计行')), '合计·未开始 对不上').toBe(sum('未开始'))
    expect(Number(grp(m, 3, '合计行')), '合计·进行中 对不上').toBe(sum('进行中'))
    expect(Number(grp(m, 4, '合计行')), '合计·待验收 对不上').toBe(sum('待验收'))
    expect(Number(grp(m, 5, '合计行')), '合计·已完成 对不上').toBe(sum('已完成'))
  })

  it('每个工作流标题写的「（N 项）」等于它表格里的行数', () => {
    let checked = 0
    for (const p of PHASES) {
      for (let i = p.range.start; i < p.range.end; i += 1) {
        const h = WF_HEAD.exec(at(LINES, i, '行'))
        if (!h) continue
        // 子段终点 = 下一个工作流标题，没有就到阶段末尾
        let end = p.range.end
        for (let k = i + 1; k < p.range.end; k += 1) {
          if (WF_HEAD.test(at(LINES, k, '行'))) { end = k; break }
        }
        const ids = countItems(i + 1, end)
        expect(ids.size, `工作流 ${grp(h, 1, '工作流标题')} 标题写 ${grp(h, 3, '工作流标题')} 项，条目表实际 ${ids.size} 行`)
          .toBe(Number(grp(h, 3, '工作流标题')))
        checked += 1
      }
    }
    expect(checked, '一条工作流标题都没匹配上 —— 标题格式或正则变了').toBeGreaterThanOrEqual(6)
  })

  it('条目表里出现过的 ID 不重复（重复会让总数虚高，也会让「谁在做」说不清）', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const p of PHASES) {
      for (const id of countItems(p.range.start, p.range.end).keys()) {
        const prior = seen.get(id)
        if (prior) dupes.push(`${id}（${prior} 与 ${p.phase}）`)
        seen.set(id, p.phase)
      }
    }
    expect(dupes, '同一个 ID 出现在两处').toEqual([])
  })

  it('条目行的列数与本表表头一致（既有欠账按棘轮冻结，只许变短）', () => {
    expect(SHAPES.length, '一条条目行都没解析到 —— 表头或行格式变了').toBeGreaterThanOrEqual(90)
    const wide = SHAPES.filter((s) => s.cells > s.header).map((s) => s.id).sort()
    const short = SHAPES.filter((s) => s.cells < s.header).map((s) => s.id).sort()
    expect(wide, '多列的条目行（正文里有没转义的竖线，或把「实施结果」当成了额外一列）')
      .toEqual([...WIDE_DEBT].sort())
    expect(short, '缺列的条目行（状态那一格因此显示在「验收标准」列上）')
      .toEqual([...SHORT_DEBT].sort())
    // 上面两条只比集合；万一某行从「多列」变成「缺列」互相抵消，这里兜住总量
    expect(wide.length + short.length, '形状不符表头的条目行总数与名单对不上')
      .toBe(WIDE_DEBT.length + SHORT_DEBT.length)
  })
})
