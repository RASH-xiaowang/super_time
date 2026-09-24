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
 * 条目形状欠账名单 —— **必须是空的**（N38 已收口）。
 *
 * 这里曾经是 23 行冻结的既有欠账（19 行缺一格、4 行多一格），口径与 M21 那个白名单一样是
 * 「只许变短」。2026-09-24 那 23 行全部修完：19 行沿正文里本来就有的 `**已完成` / `验收：` /
 * `**处理` 边界切成两列，3 行把正文里的竖线转义（`string \| undefined`、`a \|\| b`、
 * `mean\|d\|=max\|d\|=0` —— 代码片段里的竖线在表格单元里照样换列），1 行把多出来的「实施结果」
 * 并回验收列。**从这一刻起这两份名单是硬约束**：再写进一行列数不对的条目，本条立刻红，
 * 而不是又攒一份「今天的欠账」。
 */
const WIDE_DEBT: string[] = []
const SHORT_DEBT: string[] = []

/** 文档开头那句「（97 个条目：94 已完成 / …）」—— 与总览表是两处独立的手写数字。 */
const HEADER_COUNTS = /（(\d+) 个条目：(\d+) 已完成 \/ (\d+) 进行中 \/ (\d+) 未开始/

/** 台账（`## 十五、变更记录`）的行以日期开头，与条目表的 `| ID |` 一眼区分。 */
const LEDGER_ROW = /^\|\s*20\d\d-\d\d-\d\d\s*\|/

/**
 * 台账里「同一件事写了两遍」的行。
 *
 * 合并两个分支时，两边各写的一版同一行会**都被留下**（2026-09-24 实测：N36 第 4 步那行留了两版，
 * 靠后那版还带着本轮已被变异实验推翻的结论 —— 读到旧的人不会知道自己读的是旧版）。判据用
 * 「日期 + 类型 + 条目 + 摘要」四格全同：同一天的同一条目、连一句话摘要都一字不差，就是同一件事。
 * 摘要写成占位符 `—` 的「教训」行是本项目故意的分组写法（同一天多条教训），因此排除 —— 它们本来
 * 就靠第五格互相区分。
 */
function ledgerDuplicates(): string[] {
  const seen = new Map<string, number>()
  const out: string[] = []
  LINES.forEach((line, i) => {
    if (!LEDGER_ROW.test(line)) return
    const c = cellsOf(line)
    const summary = at(c, 3, '台账摘要')
    if (summary === '—') return
    const key = [at(c, 0, '台账日期'), at(c, 1, '台账类型'), at(c, 2, '台账条目'), summary].join('§')
    const prior = seen.get(key)
    if (prior !== undefined) out.push(`第 ${String(prior)} 行与第 ${String(i + 1)} 行：${at(c, 2, '台账条目')}`)
    else seen.set(key, i + 1)
  })
  return out
}
/** 台账表的列数 —— 从它**自己的表头行**取，不写死：写死的话表头一改，守卫就跟着说谎。 */
function ledgerColumns (): number {
  const h = LINES.find((l) => /^\|\s*日期\s*\|\s*操作者\s*\|/.test(l))
  if (h === undefined) throw new Error('找不到台账表头「| 日期 | 操作者 | … |」—— 那张表的表头改了，守卫要跟着改')
  return cellsOf(h).length
}

const LEDGER_COLS = ledgerColumns()

/**
 * 台账行的**形状**缺陷名单：列数与表头不符、或行尾竖线缺失。
 *
 * 为什么单独立一条（N38 那条只管条目表）：台账是「一件事怎么走到今天」的唯一记录，行一被劈开，
 * 后半句就显示到不存在的列上 —— 而 2026-09-24 实测到台账里恰恰有 10 行是坏的，此前**没有任何**
 * 机检看着它。坏法两种，且第二种会骗过「只数列数」的判据：
 *   ① 正文里有没转义的竖线（代码片段 `` `a | b` ``、绝对值记法 `mean|d|`）⇒ 多一列；
 *   ② 行尾那根竖线整个没写 ⇒ 正文里那根裸竖线**顶替了它的位置**，列数正好等于表头、数不出来，
 *      但最后一格的内容被截断到那一根竖线为止（实测 3 行是这一种）。
 */
function ledgerShapeDefects (lines: readonly string[] = LINES): string[] {
  const out: string[] = []
  const wholeDoc = lines === LINES
  lines.forEach((line, i) => {
    if (!LEDGER_ROW.test(line)) return
    const where = wholeDoc ? `第 ${String(i + 1)} 行` : `合成第 ${String(i + 1)} 行`
    if (!line.endsWith('|')) {
      out.push(`${where}：行尾没有竖线 —— 正文里那根没转义的竖线会顶替它的位置，列数看着正好，最后一格却被截断`)
    }
    const n = cellsOf(line).length
    if (n !== LEDGER_COLS) out.push(`${where}：${String(n)} 格，而表头是 ${String(LEDGER_COLS)} 列（正文里有没转义的竖线，或少了一格）`)
  })
  return out
}

/** 中文数字里能当个位的九个；`十` 单独处理，`十一`/`二十一` 走下面的乘式。 */
const CN_DIGITS = new Map<string, number>([
  ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5],
  ['六', 6], ['七', 7], ['八', 8], ['九', 9],
])

/** 「九」「十三」「二十一」以及写阿拉伯数字的「13」都翻译成数；认不出来给 NaN（NaN 参与比较恒为假 ⇒ 会红）。 */
function cnNumber (raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  if (raw === '十') return 10
  const m = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(raw)
  if (m !== null) {
    const tens = m[1] === undefined ? 1 : (CN_DIGITS.get(m[1]) ?? NaN)
    const ones = m[2] === undefined ? 0 : (CN_DIGITS.get(m[2]) ?? NaN)
    return tens * 10 + ones
  }
  return CN_DIGITS.get(raw) ?? NaN
}

/** 圈号 ①→1 … ⑳→20。收码点而不是收字符：调用点已经在按 UTF-16 单元走。 */
function circledNumber (cp: number): number {
  return cp - 0x245f
}

/**
 * 条目行里「已经落地的 N 步」与**同一格**里最大的那个圈号对不对得上。
 *
 * 为什么只比「最大序号」而不数圈号个数：那一格里除了 ①②③… 的编号，正文里还会引用
 * 「配合第 ⑪ 步」「（见 ⑬）」之类的 —— 数个数必然虚高（实测数出 14/28 个，而真步骤是 13 个）。
 * 反过来，子清单再怎么写也造不出比榜首更大的序号，所以「声明的步数 == 最大圈号」既严格又稳。
 */
function stepLabelMismatches (lines: readonly string[] = LINES): string[] {
  const out: string[] = []
  lines.forEach((line, i) => {
    if (!ID_ROW.test(line)) return
    cellsOf(line).forEach((cell) => {
      const m = /已经?落地的([一二三四五六七八九十\d]+)步/.exec(cell)
      if (m === null) return
      const declared = cnNumber(grp(m, 1, '自报步数'))
      let top = 0
      // 圈号都在 BMP 内（U+2460…），所以按 UTF-16 单元逐个走 + 直接切片看上下文是准的。
      for (let k = 0; k < cell.length; k += 1) {
        const v = circledNumber(cell.codePointAt(k) ?? -1)
        if (!(v >= 1 && v <= 20)) continue
        // 排掉两种「引用」形态：`第 ⑪ 步`（回指）与 `第 ⑭ 步`（**前向**引用还没做的那一步）。
        // 前向引用正是这版守卫第一次自红的原因：本行写了「（第 ⑭ 步）」指下一步，而编号只到 ⑬。
        if (cell.slice(Math.max(0, k - 2), k) === '第 ') continue
        if (cell.slice(k + 1, k + 3) === ' 步') continue
        if (v > top) top = v
      }
      if (declared !== top) {
        out.push(`第 ${String(i + 1)} 行：写着「落地的${grp(m, 1, '自报步数')}步」（=${String(declared)}），那一格里最大的编号却是 ${String(top)}（比的是排除「第 X 步」引用之后的最大编号）`)
      }
    })
  })
  return out
}

/**
 * 「结论基线」那段（第一个 `## ` 之前）不许抄的四类会过期的数。
 *
 * 这几样每接一步、每多一次运行就变：假红发生率、自报的落地步数、点名到第几步、榜首中位读数。2026-09-24 实测到的正是这个 ——
 * 开头写着「累计 10 次 / 已经落地的九步」，而同一天条目行里已经是 12 次 / 十三步。
 * 规矩：**要引用就写「见 Nxx 条目行」**，别在开头复述。
 */
const STALE_IN_OPENING: Array<{ what: string, source: string }> = [
  { what: '假红发生率', source: '累计 \\*\\*\\d+ 次\\*\\*' },
  { what: '自报的落地步数', source: '落地的[一二三四五六七八九十\\d]+步' },
  { what: '点名的第 N 步', source: '第 \\d+ 步' },
  // 榜历史的中位**每多一次运行就变**：2026-09-24 一个钟头里从 22.1 秒跳到 24.3 秒，
  // 全是因为窗口里进来了两次新运行。写在开头就是埋一句明天就假的话。
  { what: '榜首中位读数', source: '中位 [0-9.]+ ?秒' },
]

/** 开头那段的终点：第一个二级标题所在行号（找不到就抛，不许静默返回 0 让检查变空转）。 */
function openingEnd (): number {
  const end = LINES.findIndex((l) => /^##\s/.test(l))
  if (end < 0) throw new Error('找不到第一个二级标题 —— 开头「结论基线」那段与正文的分界没了')
  return end
}

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

  it('条目行的列数与本表表头一致（N38 收口之后，这两份名单必须一直为空）', () => {
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

  it('台账里没有「同一件事写了两遍」的行（合并分支时两边各留一版）', () => {
    const rows = LINES.filter((l) => LEDGER_ROW.test(l))
    expect(rows.length, '一行台账都没解析到 —— 台账表的行格式或正则变了').toBeGreaterThanOrEqual(250)
    // 比 `toEqual([])`：数组为空时 vitest 把实际值折成 `Array(1)`，读日志的人看不到撞车的是哪两行
    expect(ledgerDuplicates().join('\n'), '同一天、同一条目、摘要一字不差的台账行（后写的那版会盖住前一版的结论）')
      .toBe('')
  })

  it('台账**每一行**的形状与表头一致：列数对、行尾竖线不缺（N38 只看了条目表，台账是同族缺陷却没被看着）', () => {
    const rows = LINES.filter((l) => LEDGER_ROW.test(l))
    expect(rows.length, '一行台账都没解析到 —— 行格式或 LEDGER_ROW 变了，本条就成了空的').toBeGreaterThanOrEqual(250)
    expect(LEDGER_COLS, '台账表头列数解析成了 ' + String(LEDGER_COLS) + ' —— 那张表不是 5 列的话守卫要跟着改').toBe(5)
    // 比 `toEqual([])`：数组为空时 vitest 把实际值折成 `Array(1)`，读日志的人看不到坏在第几行
    expect(ledgerShapeDefects().join('\n'), '台账里有被劈开的行：某一格会显示到不存在的列上，合并分支时留下的那两版也就读不到了').toBe('')
  })

  it('台账形状判据自己有判别力（一根裸竖线、一次缺行尾竖线、少一格都必须红）', () => {
    const ok = '| 2026-09-24 | 实施 | N99 | 已完成 | 正文里有 `a \\| b` 与 mean\\|d\\|=max\\|d\\|=0 这种**已转义**的竖线 |'
    expect(ledgerShapeDefects([ok]).join('\n'), '合规的行不该被报 —— 报了就是判据太宽，下一次没人愿意看它红').toBe('')
    expect(ledgerShapeDefects(['| 2026-09-24 | 实施 | N99 | 已完成 | 正文里有 `a | b` 没转义 |']).join('\n'),
      '一根裸竖线就该红（实测 7 行是这一种）').not.toBe('')
    expect(ledgerShapeDefects(['| 2026-09-24 | 实施 | N99 | 已完成 | 行尾没有竖线，而正文里有 `a | b`']).join('\n'),
      '缺行尾竖线是实测的另一种坏法：它把裸竖线顶成了列边界，只数列数看不出来').not.toBe('')
    expect(ledgerShapeDefects(['| 2026-09-24 | 实施 | 已完成 | 少了一格 |']).join('\n'),
      '少一格同样要红 —— 状态那一格因此显示在备注列上').not.toBe('')
  })

  it('文档开头那句手写计数与条目表相加一致（它与总览表是两处独立的手写数字）', () => {
    const line = LINES.find((l) => HEADER_COUNTS.test(l))
    if (line === undefined) throw new Error('找不到开头那句「（N 个条目：…）」—— 那句话被改写了，正则要跟着改')
    const m = HEADER_COUNTS.exec(line)
    if (m === null) throw new Error('匹配到了行却取不到捕获组 —— HEADER_COUNTS 本身要复查')
    const sum = (k: keyof Tally) => PHASES.reduce((a, p) => a + p.tally[k], 0)
    const total = sum('未开始') + sum('进行中') + sum('待验收') + sum('已完成')
    expect(Number(grp(m, 1, '开头计数')), `开头写 ${grp(m, 1, '开头计数')} 个条目，条目表实际 ${String(total)} 个`)
      .toBe(total)
    expect(Number(grp(m, 2, '开头计数')), '开头写的「已完成」与条目表对不上').toBe(sum('已完成'))
    expect(Number(grp(m, 3, '开头计数')), '开头写的「进行中」与条目表对不上').toBe(sum('进行中'))
    expect(Number(grp(m, 4, '开头计数')), '开头写的「未开始」与条目表对不上').toBe(sum('未开始'))
  })

  it('开头「结论基线」那段不复述会过期的数（发生率、步数、榜首读数只写在条目行与台账里）', () => {
    const end = openingEnd()
    const opening = LINES.slice(0, end).join('\n')
    const body = LINES.slice(end).join('\n')
    const hits: string[] = []
    for (const { what, source } of STALE_IN_OPENING) {
      // 防空转：这类写法在正文里必须真的存在，否则「开头没有」只是正则坏了造成的假绿
      expect(new RegExp(source).test(body), `正文里一次都没有「${what}」这种写法 —— 这条正则已失效，开头的检查是空的`).toBe(true)
      for (const m of opening.matchAll(new RegExp(source, 'g'))) hits.push(`${what}：「${grp(m, 0, '开头复述')}」`)
    }
    expect(hits.join('\n'), '开头那段抄了每接一步就会变的数（改成「见对应条目行」，或把数字更新到与条目行一致）').toBe('')
  })

  it('条目行自报的「已经落地的 N 步」与那一格里最大的圈号一致（第 13 步加进去时这个数还写着九）', () => {
    const labeled = LINES.filter((l) => ID_ROW.test(l) && /已经?落地的[一二三四五六七八九十\d]+步/.test(l))
    expect(labeled.length, '一条自报步数的条目行都没找到 —— 写法或正则变了，本条就成了空的').toBeGreaterThanOrEqual(1)
    expect(stepLabelMismatches().join('\n'), '自报的步数与那一格最大的 ①②… 序号对不上（要么漏标了一步，要么步数忘了改）').toBe('')
  })

  it('「第 ⑭ 步」这种前向引用不算一步，但「；⑭ 真编号」必须算（排引用的规则本身要有判别力）', () => {
    const row = (cell: string): string => `| N99 | 标题 | 验收 | ${cell} | 已完成 |`
    // 编号只到 ⑬：回指（第 ⑪ 步）与前向（第 ⑭ 步）都不该被当成「又多了一步」
    const refs = row('已经落地的十三步：① 一；② 二；⑬ 三。配合第 ⑪ 步；下一步（第 ⑭ 步）见台账。')
    expect(stepLabelMismatches([refs]).join('\n'), '「第 ⑭ 步」是引用不是编号 —— 排掉它的规则失效了').toBe('')
    // 真的多出一步（`；⑭ ` 是编号的写法）却忘了改自报数 ⇒ 必须红
    const real = row('已经落地的十三步：① 一；② 二；⑬ 三；⑭ **又做了一步**。')
    expect(stepLabelMismatches([real]).join('\n'), '多出一个真编号却没改自报步数，这条判据必须红').not.toBe('')
    // 中文数字要真解析：写「九」而编号到 ⑬ ⇒ 红
    expect(stepLabelMismatches([row('已经落地的九步：① 一；② 二；⑬ 三。')]).join('\n')).not.toBe('')
    // 认不出来的写法不许静默通过（解析成 NaN ⇒ 与任何编号都不等 ⇒ 红）
    expect(stepLabelMismatches([row('已经落地的一二三步：① 一。')]).join('\n'), '「一二三」不是能解析的数，不能被当成对得上').not.toBe('')
  })
})
