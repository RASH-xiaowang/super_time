/**
 * 整改台账的**可追溯性**守卫：`docs/CODE-AUDIT-2026-09-26.md` §七 列出的每一条序号，
 * 都必须出现在文档顶部的「先读这里」台账区里。
 *
 * ## 为什么要机检这一条
 *
 * §七 是「要做什么」的清单（25 条序号），「先读这里」是「每条做到哪一步」的账。
 * 两者靠人手工对齐，而失效方式恰好在另一端：**某一条从没进过台账，读的人却以为它被谈过了**
 * —— 那张表看着密密麻麻，谁都看不出少了 1 行。本轮（2026-09-27）逐条核对时真撞出一例：
 * #12（`openPath` / 导出路径限根）其实早就做完了（P2-6 那一行），但那一行只写了「#13 之外的安全项」
 * 而没写 #12 ⇒ 号对不上。修法就是把序号写进那一行的标题里，也就是这条判据要守住的东西。
 *
 * ## 口径
 *
 * - 「有着落」不区分做完 / 判定不做 / 等什么证据 —— 这条判据管的是**有没有被记账**，
 *   不是账目本身好不好（那由 §八 的四件套与人工复核管）。
 * - 两处锚点（`## 先读这里` 与 `## 七、`）读不到就**抛错**而不是返回空集：
 *   章节一旦改名，返回空集会变成「零缺失 ⇒ 全绿」，那正是这条判据要防的那种假绿。
 * - 序号只在 §七 内部的表格首列里找（`| 12 | …`）；报告正文里的 `P0-1` / `P2-6` 这些
 *   条目号不参与 —— 它们各有自己的行，硬拉进同一把尺会误报。
 *
 * ## 第二条尺：过程账不许看着像"还挂着"
 *
 * 这张表是按时间往下长的，同一个条目常常有五行「第 N 刀」，而**第一行永远写着 🟡** ——
 * 扫状态列的人会以为 #18 / #19 / #20 至今没做完（其实早就收口了）。所以：**每一行 🟡 的序号，
 * 要么被后面某一行续上，要么在「剩余」小节里点名**，否则就是断头账。
 * 这与报告 §五 那条 N37（"条目表把未关闭的调查项藏掉"）是同一族的另一面。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const DOC = join(ROOT, 'docs', 'CODE-AUDIT-2026-09-26.md')

/** 找某个二级标题的**行首**位置。必须是行首：文档里会照抄这些标记（本判据自己的说明就在抄），
 *  用 `indexOf('## 七、')` 会先命中正文里那句抄写 —— 第一次写就自缚了。 */
function headingAt(doc: string, prefix: string): number {
  const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').exec(doc)
  return m === null ? -1 : m.index
}

/** 台账区（「## 先读这里」到下一个二级标题）。 */
function ledgerSection(doc: string): string {
  const from = headingAt(doc, '## 先读这里')
  if (from === -1) throw new Error('找不到「## 先读这里」—— 章节改名的话这条判据要跟着改，不能默默变成恒真')
  const rest = doc.slice(from + 1)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

/** 清单区（「## 七、…」到下一个二级标题）。 */
function planSection(doc: string): string {
  const from = headingAt(doc, '## 七、')
  if (from === -1) throw new Error('找不到「## 七、」的改进清单 —— 章节改名的话这条判据要跟着改')
  const rest = doc.slice(from + 1)
  const next = rest.search(/\n## /)
  return next === -1 ? rest : rest.slice(0, next)
}

/** §七 里出现过的序号（表格首列的 `| N |`）。 */
function planNumbers(section: string): number[] {
  const out = new Set<number>()
  for (const line of section.split('\n')) {
    const m = /^\|\s*(\d{1,3})\s*\|/.exec(line)
    const n = m?.[1] === undefined ? Number.NaN : Number.parseInt(m[1], 10)
    if (Number.isFinite(n)) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/** 台账里提到过的序号（`#12` 这种写法，包括「M365–M369」式正文里的 `#19`）。 */
function ledgerNumbers(section: string): Set<number> {
  const out = new Set<number>()
  for (const m of section.matchAll(/#(\d{1,3})/g)) {
    const n = Number.parseInt(m[1] ?? '', 10)
    if (Number.isFinite(n)) out.add(n)
  }
  return out
}

/** 没被记过账的序号。 */
function unaccounted(doc: string): number[] {
  const plan = planNumbers(planSection(doc))
  const ledger = ledgerNumbers(ledgerSection(doc))
  return plan.filter((n) => !ledger.has(n))
}

/** 台账区里的表格行（跳过表头与分隔行）。 */
function ledgerRows(ledger: string): string[] {
  return ledger.split('\n').filter(l => /^\|(?:[^|\n]*\|){3}/.test(l) && !/^\|\s*[-:]+\s*\|/.test(l) && !l.includes('清单项'))
}

/**
 * 过程账（🟡）的续尾检查：一条只做了部分的账，必须**要么被后面某一行续上、要么在「剩余」里点名**。
 * 为什么单独管：这张表是按时间往下长的，同一个条目常常有五行「第 N 刀」，
 * 第一行永远写着 🟡 —— 扫状态列的人会以为 #18/#19/#20 还挂着，而它们其实早就收口了。
 * 这不是格式洁癖：报告 §五 那条 N37 记的就是"条目表把状态藏错"这一族。
 */
function unclosedProgress(ledger: string, leftoverSection: string): string[] {
  const rows = ledgerRows(ledger)
  const bad: string[] = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? ''
    if (!row.includes('🟡')) continue
    const nums = [...row.matchAll(/#(\d{1,3})/g)].map(m => m[1] ?? '')
    if (nums.length === 0) continue // 没对到 §七 序号的行（如「机检：…」）不归这条管
    const pickedUpLater = rows.slice(i + 1).some(later => nums.some(n => later.includes(`#${n}`)))
    const namedInLeftover = nums.some(n => leftoverSection.includes(`#${n}`))
    if (!pickedUpLater && !namedInLeftover) {
      bad.push(`第 ${String(i + 1)} 行标着 🟡，但后面既没有续上的行、「剩余」里也没点名：${row.slice(0, 60)}…`)
    }
  }
  return bad
}

describe('整改台账必须覆盖 §七 的每一条序号（漏一条没人会发现）', () => {
  const doc = existsSync(DOC) ? readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n') : ''

  it('文档在、两处锚点读得到，两边的数都不是空的（防空转）', () => {
    expect(existsSync(DOC), '审查文档不在了 —— 台账判据失去靶子').toBe(true)
    const plan = planNumbers(planSection(doc))
    const ledger = ledgerNumbers(ledgerSection(doc))
    // 2026-09-27 实测：§七 序号 25 条（1–25），台账区里提到过 25 个不同序号。
    expect(plan.length, `§七 只解析到 ${String(plan.length)} 条序号 ⇒ 解析或章节结构漂了`).toBeGreaterThanOrEqual(20)
    expect(Math.min(...plan), '§七 的序号不是从 1 开始 ⇒ 解析吃到了别的表').toBe(1)
    expect(ledger.size, '台账区里一个 #序号 都没解析到 ⇒ 下面那条"零缺失"是假的').toBeGreaterThanOrEqual(20)
  })

  it('每一条序号都在台账里有着落', () => {
    const missing = unaccounted(doc)
    expect(missing, `这些 §七 的序号从没进过「先读这里」那张表（做了就补一行，判定不做也要写清等什么）：${missing.map(n => `#${String(n)}`).join(', ')}`).toEqual([])
  })

  it('反例自证：清单里多出一条没记账的序号，判据必须报', () => {
    // 真实失效方式就是这一种：往 §七 加一行「要做什么」，然后没人把它记进台账。
    const patched = doc.replace('\n| 12 | ', '\n| 26 | ')
    expect(patched, 'replace 没命中 ⇒ 反例是自欺（清单行格式变了，这条判据要跟着改）').not.toBe(doc)
    expect(unaccounted(patched)).toContain(26)
    // 反向对照：把台账里那一处 #12 抹掉，同一条判据也要报 12。
    // 替换串**必须用函数**：这张表的正文里带 `$`（`$&` / `` $` `` 在字符串替换里是特殊序列），
    // 传字符串会让替换变形 —— 本仓的变异跑手踩过同一个坑，理由一模一样。
    const led = ledgerSection(doc)
    expect(led.includes('#12'), '台账里现在并没有 "#12" 这种写法 ⇒ 反向对照构造不出来').toBe(true)
    const stripped = doc.replace(led, () => led.replace(/#12/g, '#??'))
    expect(stripped, '反向对照没改掉文档 ⇒ replace 的锚点形状变了').not.toBe(doc)
    expect(unaccounted(stripped)).toContain(12)
  })

  it('过程账（🟡）都有下文：要么被后面一行续上，要么在「剩余」里点名', () => {
    const ledger = ledgerSection(doc)
    const from = ledger.indexOf('### 剩余')
    expect(from, '台账区里找不到「### 剩余」小节 ⇒ 这条判据的两个出口都断了').toBeGreaterThan(-1)
    const rest = ledger.slice(from + 1)
    const nextHeading = rest.search(/\n(?:## |### )/)
    const leftover = nextHeading === -1 ? rest : rest.slice(0, nextHeading)
    const bad = unclosedProgress(ledger, leftover)
    expect(bad.join('\n'),
      '这些 🟡 行读起来像"还挂着"，而后面既没有续账也没在剩余里点名 —— 扫状态列的人会被误导：\n').toBe('')
    // 反例自证：造一条孤立的 🟡 行（后面没有任何续账、剩余里也不点名），判据必须报。
    const synthetic = [
      '| 清单项 | 状态 | 落点 | 备注 |',
      '|---|---|---|---|',
      '| 第三批 #99 第一步：拆个东西 | 🟡 第一刀做完 | `abc1234` | 举例用的一行 |',
    ].join('\n')
    // （注意：这里当"剩余清单"的字符串**不能含 `#99`** —— 含了就是把这条路自己填上，反例变成假的。）
    expect(unclosedProgress(synthetic, '这一段点名的都是别的条目')).toHaveLength(1)
    // 反向对照：同一个序号被后面一行续上，就不该报。
    expect(unclosedProgress(`${synthetic}\n| 第三批 #99 第二步：拆完 | ✅ 完成 | ` + '`def5678` | 收了尾 |', '这一段点名的都是别的条目'))
      .toEqual([])
  })
})
