/**
 * 「总结三页」紧凑改版的**接线**守卫。
 *
 * 为什么需要：这次改的全是「一行还是三行」「6px 还是 10px」这类**看起来无害**的值。
 * 它们不参与任何单元测试，改回去也不会有任何用例转红 —— 而用户能立刻看出来
 * （一行信息占三行高度、一屏装不下）。所以把三条决策钉成断言：
 *
 *   ① 三页共用**同一套**密度令牌（`--nm-dense-*`），不是各压各的值 ——
 *      这是「三个界面看起来仍像同一个产品」的唯一机制；
 *   ② 三处「纵向堆叠 → 并成一行」的结构（任务行 / 表单卡 / 键值格）不再退回纵向；
 *   ③ 每个 TSX 用到的类名在对应 CSS 里都真实存在 —— CSS 改写的典型事故是
 *      「删了一个看起来没用的类，而它其实还被 className 引用着」，此时
 *      `className={undefined}` 会静默退化成无样式，构建与用例都不报错。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 面板目录往上四层就是 wechat-data 目录（存放主题文件）。 */
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const theme = read('../scifi-theme.css')

const daily = read('daily-summary.module.css')
const period = read('period-summary.module.css')
const annual = read('annual.module.css')
const dailyTsx = read('DailySummary.tsx')
const periodTsx = read('PeriodSummary.tsx')
const annualTsx = read('Annual.tsx')

describe('三页共用同一套紧凑密度刻度', () => {
  it('主题里定义了 --nm-dense-* 令牌', () => {
    for (const t of ['--nm-dense-fs: 12px;', '--nm-dense-fs-sm: 11px;', '--nm-dense-g3: 6px;', '--nm-dense-pad-x: 10px;', '--nm-dense-row-y: 5px;']) {
      expect(theme, `主题缺少 ${t}`).toContain(t)
    }
  })

  it('三页都在用这套令牌（不是各自压各自的值）', () => {
    for (const [name, css] of [['每日', daily], ['周期', period], ['年度', annual]] as const) {
      expect(css, `${name}页没有引用密度令牌`).toContain('var(--nm-dense-')
    }
  })

  it('三页里不再残留 10.5 / 11.5 / 12.5px 这类半档字号', () => {
    // 半档字号是「一页一个样」的根源：三页改完若还各留几个，视觉上仍然不统一。
    for (const [name, css] of [['每日', daily], ['周期', period], ['年度', annual]] as const) {
      expect(css, `${name}页残留半档字号`).not.toMatch(/font-size:\s*1[012]\.5px/)
    }
  })
})

describe('每日总结：任务/记录行从三行压成一行', () => {
  it('.taskInfo 是横向排列（改前是 flex-direction: column 的纵向三行）', () => {
    expect(daily).toMatch(/\.taskInfo \{[^}]*flex-direction: row/)
    expect(daily, '旧的纵向写法回来了').not.toMatch(/\.taskInfo \{ flex: 1; min-width: 0; display: flex; flex-direction: column/)
  })

  it('行内按钮靠 margin-left:auto 推到行尾', () => {
    expect(daily).toMatch(/\.taskActions \{[^}]*margin-left: auto/)
  })

  it('行内边距走 --nm-dense-row-y（行高约 27px，改前约 74px）', () => {
    expect(daily).toMatch(/\.taskRow \{[^}]*padding: var\(--nm-dense-row-y\)/)
  })

  it('被误用成分组标签的 hero 样式（.hd，16px 内边距）已彻底清掉', () => {
    expect(daily).not.toMatch(/^\.hd\s*\{/m)
    expect(dailyTsx).not.toContain('css.hd ')
    expect(dailyTsx).toContain('css.formHd')
  })

  it('行内按钮比表单按钮再紧一档', () => {
    expect(daily).toContain('.taskActions .catBtn { padding: 2px 8px; }')
  })
})

describe('周期总结：表单一行、结果元信息一行', () => {
  it('表单卡是横向 flex（预设 + 起止 + 生成 + 复制 + 当前区间同一行）', () => {
    expect(period).toMatch(/\.formCard \{[^}]*flex-direction: row/)
  })

  it('把 kit 的日期区间掰成横向用**双类名**提权（单类名会随打包顺序翻转）', () => {
    expect(period).toMatch(/\.periodRange\.periodRange \{/)
    expect(periodTsx).toContain('className={css.periodRange}')
  })

  it('结果区的统计 / 类型分布 / Top 会话并进同一行（不再三块各占一行）', () => {
    expect(periodTsx).toContain('css.metaRow')
    expect(period).toMatch(/\.metaRow \{[^}]*flex-wrap: wrap/)
    expect(period, '旧的三块容器样式还在').not.toMatch(/^\.topSessions\s*\{/m)
    expect(period).not.toMatch(/^\.stats\s*\{/m)
  })

  it('「当前区间」推到行尾，窄屏换行时不会把按钮挤走', () => {
    expect(period).toMatch(/\.rangeHint \{[^}]*margin-left: auto/)
  })
})

describe('年度报告：键值格一行、小卡两行', () => {
  it('.heroCell 由上下两行改成同一行', () => {
    expect(annual).toMatch(/\.heroCell \{[^}]*flex-direction: row/)
    expect(annual).toMatch(/\.heroCell \{[^}]*justify-content: space-between/)
  })

  it('「还有这些人」的小卡由三行压成两行（标签+姓名同行，数值独占一行）', () => {
    expect(annual).toMatch(/\.moreInfo \{ display: grid;/)
    expect(annual).toMatch(/\.moreVal \{ grid-column: 1 \/ -1; \}/)
  })

  it('海报的 fr 行高与退化规则没被改动（一屏装下 + 装不下时退回瀑布流）', () => {
    expect(annual).toContain('grid-template-rows: 1.11fr 0.94fr 1.09fr 1.09fr 0.77fr auto;')
    expect(annual).toMatch(/\.wrap\[data-compact\]\s*\{/)
    expect(annual).toMatch(/@media \(max-width: 1200px\), \(max-height: 779px\)/)
  })

  it('热力图仍保持小格与固定列数（放大就会挤爆 24 列 / 7 行）', () => {
    expect(annual).toMatch(/\.rhythmCell \{ height: 7px/)
    expect(annual).toMatch(/\.rhythmGrid \{ display: grid; grid-template-columns: repeat\(24, minmax\(0, 1fr\)\)/)
    expect(annualTsx).toMatch(/gridTemplateColumns: `repeat\(\$\{cols\.n\}, minmax\(0, 1fr\)\)`/)
  })
})

describe('CSS 改写事故守卫：用到的类名必须都存在', () => {
  it('三页的 className 引用的类在对应 CSS 里都有定义', () => {
    for (const [name, tsx, css] of [
      ['每日', dailyTsx, daily],
      ['周期', periodTsx, period],
      ['年度', annualTsx, annual],
    ] as const) {
      const used = [...new Set([...tsx.matchAll(/css\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))]
      const defined = new Set([...css.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]))
      const missing = used.filter((u) => !defined.has(u))
      // className={undefined} 不会报错，只会静默少样式 —— 所以必须在这里拦。
      expect(missing, `${name}页引用了不存在的类：${missing.join(', ')}`).toEqual([])
    }
  })
})
