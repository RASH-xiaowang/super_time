/**
 * 近 30 天热力日历（群活跃监控用）。
 *
 * 为什么单独一个文件：`MonitorPanel` 受函数体棘轮管着（250 行上限），
 * 而热力日历的渲染 + 色阶换算有 40 多行，留在面板里会超。
 *
 * 为什么用**日历网格**而不是 30 根横条：横条要 30 行 × 16px = 480px，左栏放不下；
 * 网格 5 行 × 30px = 166px，而且「哪几天没说话」一眼就能看出来（空格子）。
 */
import css from './monitor.module.css'

/** 一天的热力数据（跨月时 `month` 与 `day` 都要带上，否则 9/30 与 10/30 会撞键）。 */
export interface HeatDay {
  /** `YYYY-MM-DD`，用作 React key 与 title。 */
  key: string
  /** 月（1-12）。 */
  month: number
  /** 日（1-31）。 */
  day: number
  count: number
  isToday: boolean
  /** 是否属于当前自然月（跨月时上月的日子用弱化色）。 */
  inThisMonth: boolean
}

/**
 * 把「按月分组的日计数」摊成近 N 天的连续序列。
 *
 * 为什么不能只取本月：`apiGetDailyCounts` 一次只给**一个自然月**的计数，
 * 而「近 30 天」在月初会跨到上个月（10 月 3 日往前 30 天 = 9 月 4 日）。
 * 所以调用方要取**两个月**的计数，这里按日期把它们拼起来。
 * @param byMonth - `{ 'YYYY-M': { '日': 条数 } }`（键不带前导零，与 `loadGroup` 同口径）。
 * @param days - 窗口长度（含今天）。
 * @param now - 当前时间（测试可注入）。
 * @returns 从最早到今天的连续日序列（长度恒为 `days`）。
 */
export function buildHeatDays(
  byMonth: Readonly<Record<string, Readonly<Record<string, number>>>>,
  days: number,
  now: Date = new Date(),
): HeatDay[] {
  const out: HeatDay[] = []
  const todayKey = `${String(now.getFullYear())}-${String(now.getMonth() + 1)}-${String(now.getDate())}`
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const day = d.getDate()
    const key = `${String(y)}-${String(m)}-${String(day)}`
    out.push({
      key,
      month: m,
      day,
      count: byMonth[`${String(y)}-${String(m)}`]?.[String(day)] ?? 0,
      isToday: key === todayKey,
      inThisMonth: m === now.getMonth() + 1 && y === now.getFullYear(),
    })
  }
  return out
}

/** 星期表头（周一起，与 `buildHeatDays` 的对齐算法一致）。 */
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/**
 * 渲染热力日历。
 * @param props.heat - `buildHeatDays` 的结果。
 * @param props.max - 窗口内的最大条数（用于色阶换算）。
 * @returns 日历网格元素。
 */
export function HeatCalendar({ heat, max }: { heat: readonly HeatDay[]; max: number }): React.JSX.Element {
  const first = heat[0]
  // 首格前的空位：让第一天的星期对齐（周一 = 第 0 列）。
  const pad = first === undefined ? 0 : (new Date(first.key).getDay() + 6) % 7
  return (
    <div className={css.heatGrid}>
      {WEEK_LABELS.map(w => (
        <span key={w} className={css.heatWeek}>{w}</span>
      ))}
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${String(i)}`} className={css.heatPad} />
      ))}
      {heat.map(h => {
        const level = h.count === 0 ? 0 : Math.min(4, Math.ceil((h.count / Math.max(1, max)) * 4))
        return (
          <span
            key={h.key}
            className={css.heatCell}
            data-level={String(level)}
            data-today={h.isToday || undefined}
            data-other-month={h.inThisMonth ? undefined : '1'}
            title={`${String(h.month)} 月 ${String(h.day)} 日：${String(h.count)} 条`}
          >
            <span className={css.heatDay}>{String(h.day)}</span>
            {h.count > 0 && <span className={css.heatNum}>{String(h.count)}</span>}
          </span>
        )
      })}
    </div>
  )
}
