/**
 * 朋友圈洞察 — 月度发布热力图（按年分组）。
 *
 * 为什么单独一个文件：`MomentsInsightsPanel` 受函数体棘轮管着（250 行上限），
 * 而「按年分组 + 12 个月格子」的渲染有 40 多行，留在面板里会超。
 *
 * ## 为什么是热力图而不是柱状图（2026-10-17 用户要求）
 *
 * 改前是「一年一行、12 根竖柱」。本机数据 2026 年 2,518 条、2016 年 1 条，
 * 差 2,500 倍 —— 对数刻度下往年柱子只有 10px 高、宽度 6px，看起来像「一排小方块」，
 * 既不像柱状图也读不出量级（用户截图）。热力图用**颜色**编码数量，
 * 不依赖高度差，1 条和 2,518 条都能落在同一个格子里被看见。
 *
 * ## 为什么按年分组
 *
 * 改前是「一个月一行横条」，本机 40+ 个月 ⇒ 单这一张卡就 1,700px 高，
 * 把整页撑到 3,873px（可视区 713px），用户一进来就落在中间、看不到顶部统计。
 * 改成「一年一行、12 个格子」后，40 个月压成 4 行，整卡约 200px。
 */
import css from './moments-insights.module.css'

/** 一个月的数据点。 */
export interface MonthPoint {
  /** `YYYY-MM`。 */
  month: string
  count: number
}

/** 按年聚合后的一组。 */
interface YearGroup {
  year: string
  /** 12 个元素，下标 0 = 1 月；缺月为 0。 */
  months: number[]
  total: number
}

/**
 * 把 `YYYY-MM` 序列按年分组。
 * @param monthly - 后端给的月度序列（可能跨多年）。
 * @returns 按年份**倒序**（最近的年在最上面）的分组。
 */
export function groupByYear(monthly: readonly MonthPoint[]): YearGroup[] {
  const map = new Map<string, number[]>()
  for (const m of monthly) {
    const [y, mm] = m.month.split('-')
    if (y === undefined || mm === undefined) continue
    const idx = Number(mm) - 1
    if (!Number.isFinite(idx) || idx < 0 || idx > 11) continue
    const arr = map.get(y) ?? new Array<number>(12).fill(0)
    arr[idx] = (arr[idx] ?? 0) + m.count
    map.set(y, arr)
  }
  return [...map.entries()]
    .map(([year, months]) => ({ year, months, total: months.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.year.localeCompare(a.year))
}

/**
 * 把数量映射到 0~4 的色阶档位（0 = 空月，4 = 最深）。
 *
 * 为什么用**分位数**而不是对数：本机 2026 年 2,518 条、2016 年 1 条，
 * 对数分档下 2022~2025 年的月发布量（1~20 条）全部落在同一档，
 * 整张图只有两种颜色（真机截图）。分位数按「有数据的月份」的实际分布切四刀，
 * 每档约 25% 的月份，颜色差异才看得出来。
 *
 * 空月（0 条）单独一档，不参与分位计算 —— 否则本机 45 个空月会把分位点拉低。
 * @param count - 该月发布条数。
 * @param thresholds - 由 `heatThresholds` 算出的三个分位点（升序）。
 * @returns 0（空）到 4（最深）的档位。
 */
export function heatLevel(count: number, thresholds: readonly [number, number, number]): number {
  if (count <= 0) return 0
  if (count <= thresholds[0]) return 1
  if (count <= thresholds[1]) return 2
  if (count <= thresholds[2]) return 3
  return 4
}

/**
 * 从全部月份里算出三个分位点（25% / 50% / 75%），供 `heatLevel` 分档。
 *
 * 只统计**有数据**的月份：本机 143 个月里 45 个是 0 条，把它们算进去会让
 * 25% 分位点落在 0 上，第 1 档就空了。
 * @param groups - 按年分组后的数据。
 * @returns 三个升序分位点；没有非零月份时返回 `[1, 2, 3]`（退化成「有数据就最深」）。
 */
export function heatThresholds(groups: readonly YearGroup[]): [number, number, number] {
  const values = groups.flatMap(g => g.months).filter(c => c > 0).sort((a, b) => a - b)
  if (values.length === 0) return [1, 2, 3]
  const at = (q: number): number => values[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 1
  return [at(0.25), at(0.5), at(0.75)]
}

/**
 * 渲染按年分组的月度发布热力图。
 * @param props.monthly - 后端给的月度序列。
 * @returns 年份 × 12 月的格子矩阵；无数据时给空态。
 */
export function MonthlyByYear({ monthly }: { monthly: readonly MonthPoint[] }): React.JSX.Element {
  const groups = groupByYear(monthly)
  if (groups.length === 0) {
    return <div className={css.empty}>暂无发布数据</div>
  }
  const thresholds = heatThresholds(groups)
  return (
    <div className={css.heat}>
      {groups.map(g => (
        <div key={g.year} className={css.heatRow}>
          <span className={css.heatYear}>{g.year}</span>
          <div className={css.heatCells}>
            {g.months.map((c, i) => (
              <span
                key={`${g.year}-${String(i)}`}
                className={css.heatCell}
                data-level={heatLevel(c, thresholds)}
                title={`${g.year} 年 ${String(i + 1)} 月：${String(c)} 条`}
              />
            ))}
          </div>
          <span className={css.heatTotal}>{String(g.total)}</span>
        </div>
      ))}
      <div className={css.heatAxis}>
        <span className={css.heatAxisPad} />
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map(m => (
          <span key={m} className={css.heatTick}>{m}</span>
        ))}
        <span className={css.heatAxisPad} />
      </div>
      {/* 图例：让「颜色深浅 = 发布多少」这件事对用户可见，不是靠猜。 */}
      <div className={css.heatLegend}>
        <span className={css.heatLegendLabel}>少</span>
        {[0, 1, 2, 3, 4].map(l => (
          <span key={l} className={css.heatCell} data-level={l} />
        ))}
        <span className={css.heatLegendLabel}>多</span>
      </div>
    </div>
  )
}
