
/**
 * 朋友圈左侧栏：筛选面板 + 月份直方图 + 洞察统计（M21 第二十六刀自 moments-panel.tsx 拆出）。
 *
 * 整段 `<aside>` 原样搬过来，JSX 一字未改（逐行等价 + 闭包审计自证）。
 * 两个月度/统计量的派生值（`monthly` / `monthMax` / `insight`）仍由面板算：
 * 它们依赖 `monthlyData` 等调用方状态，且面板别处（如空态文案）也用 `moments.length`。
*/
import { clickableKey, DateRangeField, Segmented } from '../ui/kit.tsx'
import { MEDIA_LABELS, type MediaFilter } from './moments-support.tsx'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'

/** 月份直方图的一根柱。 */
export interface MonthBar { key: string; label: string; count: number }

/** 洞察统计（`moments` 已加载子集上的计数）。 */
export interface MomentsInsight { withImages: number; withVideos: number; withLocation: number; withLink: number }

export interface MomentsSidebarProps {
  search: string
  clearFilters: () => void
  topAuthors: ReadonlyArray<[string, number]>
  showAllAuthors: boolean
  setShowAllAuthors: React.Dispatch<React.SetStateAction<boolean>>
  authorFilter: string | null
  setAuthorFilter: React.Dispatch<React.SetStateAction<string | null>>
  mediaFilter: MediaFilter
  setMediaFilter: React.Dispatch<React.SetStateAction<MediaFilter>>
  mineFilter: 'all' | 'mine' | 'others'
  setMineFilter: React.Dispatch<React.SetStateAction<'all' | 'mine' | 'others'>>
  sortOrder: 'desc' | 'asc'
  setSortOrder: React.Dispatch<React.SetStateAction<'desc' | 'asc'>>
  dateFrom: string
  setDateFrom: React.Dispatch<React.SetStateAction<string>>
  dateTo: string
  setDateTo: React.Dispatch<React.SetStateAction<string>>
  monthFilter: string | null
  setMonthFilter: React.Dispatch<React.SetStateAction<string | null>>
  monthly: ReadonlyArray<MonthBar>
  monthMax: number
  loadedCount: number
  total: number
  insight: MomentsInsight
}

export function MomentsSidebar({
  search, clearFilters, topAuthors,
  showAllAuthors, setShowAllAuthors, authorFilter,
  setAuthorFilter, mediaFilter, setMediaFilter,
  mineFilter, setMineFilter, sortOrder,
  setSortOrder, dateFrom, setDateFrom,
  dateTo, setDateTo, monthFilter,
  setMonthFilter, monthly, monthMax,
  loadedCount, total, insight,
}: MomentsSidebarProps): React.JSX.Element {
  return (
    <aside className={css.sidebar}>

      {/* 筛选面板：分组布局（作者 / 类型 / 范围 / 排序 / 月份），作者名截断 */}
      <div className={css.filterPanel}>
        {topAuthors.length > 0 && (
          <div className={css.filterGroup}>
            <span className={css.filterLabel}>作者</span>
            <div className={css.filterChips}>
              {(showAllAuthors ? topAuthors : topAuthors.slice(0, 8)).map(([name, count]) => (
                <button key={name} type="button" className={css.authorChip} data-on={authorFilter === name || undefined} title={authorFilter === name ? '清除 ' + name : '只看 ' + name} onClick={() => { setAuthorFilter(authorFilter === name ? null : name) }}>
                  <span className={css.chipName}>{name}</span>
                  <span className={css.chipCount}>{String(count)}</span>
                </button>
              ))}
              {topAuthors.length > 8 && (
                <button type="button" className={css.authorChip} onClick={() => { setShowAllAuthors(v => !v) }} title={showAllAuthors ? '收起作者' : '更多作者'}>{showAllAuthors ? '↑ 收起' : '… 更多作者'}</button>
              )}
              {authorFilter && <button type="button" className={css.authorChip} data-on="" onClick={() => { setAuthorFilter(null) }} title="清除作者筛选">✕ {authorFilter}</button>}
            </div>
          </div>
        )}
        <div className={css.filterGroup}>
          <span className={css.filterLabel}>类型</span>
          <Segmented
            options={(Object.keys(MEDIA_LABELS) as MediaFilter[]).map(f => ({ value: f, label: MEDIA_LABELS[f] }))}
            value={mediaFilter}
            onChange={(v) => { setMediaFilter(v as MediaFilter) }}
            ariaLabel="媒体类型筛选"
          />
        </div>
        <div className={css.filterGroup}>
          <span className={css.filterLabel}>范围</span>
          <Segmented
            options={[
              { value: 'all', label: '全部' },
              { value: 'mine', label: '我' },
              { value: 'others', label: '他人' },
            ]}
            value={mineFilter}
            onChange={(v) => { setMineFilter(v as 'all' | 'mine' | 'others') }}
            ariaLabel="范围筛选"
          />
        </div>
        <div className={css.filterGroup}>
          <span className={css.filterLabel}>排序</span>
          <Segmented
            options={[
              { value: 'desc', label: '最新在前' },
              { value: 'asc', label: '最早在前' },
            ]}
            value={sortOrder}
            onChange={(v) => { setSortOrder(v as 'asc' | 'desc') }}
            ariaLabel="排序方向"
          />
        </div>
        <div className={css.filterGroup}>
          <span className={css.filterLabel}>时间</span>
          <DateRangeField
            from={dateFrom}
            to={dateTo}
            onFrom={setDateFrom}
            onTo={setDateTo}
            onClear={() => { setDateFrom(''); setDateTo('') }}
            presets={['today', 'week', 'month', 'last-7', 'last-30']}
            ariaLabel="朋友圈时间筛选"
          />
        </div>
        {monthFilter && (
          <div className={css.filterGroup}>
            <span className={css.filterLabel}>月份</span>
            <div className={css.segTrack}>
              <button type="button" className={css.segChip} data-on="" onClick={() => { setMonthFilter(null) }} title="清除月份筛选">✕ {monthFilter}</button>
            </div>
          </div>
        )}
        {(search || mediaFilter !== 'all' || monthFilter !== null || mineFilter !== 'all' || authorFilter !== null) && (
          <button type="button" className={css.clearBtn} onClick={clearFilters} title="清除所有筛选">✕ 清除</button>
        )}
      </div>

      {/* monthly histogram (click a bar to filter that month) */}
      <div className={css.monthCard}>
        <div className={css.monthTitle}>
          <span>全部月份动态{authorFilter ? '（作者：' + authorFilter + '）' : ''}（{monthly.length} 个月）</span>
          <span className={css.monthHint}>点击柱条按月份筛选</span>
          {monthFilter && <span className={css.monthHint}>{loadedCount < total ? '（结果仅覆盖已加载部分）' : null}</span>}
          {monthFilter && <button type="button" className={css.textToggle} onClick={() => { setMonthFilter(null) }}>✕ 清除 {monthFilter}</button>}
        </div>
        <div className={css.monthBars}>
          {monthly.map(m => (
            // 点击目标放在**整列**而非柱子：柱高正比于数量，低数量的月份只有 2px 高，
            // 实测（WCAG 2.2 SC 2.5.8 目标尺寸）该面板 105 个控件里有 80 个小于 24×24，
            // 全部来自这里。整列高度始终包含「数值 + 柱 + 月份标签」，是稳定的目标。
            <div
              key={m.key}
              className={[css.monthCol, m.key === monthFilter ? css.monthColActive : ''].filter(Boolean).join(' ')}
              title={m.key + ' ' + String(m.count) + ' 条'}
              {...clickableKey(() => { setMonthFilter(m.key === monthFilter ? null : m.key) })}
            >
              <span className={css.monthValue}>{m.count > 0 ? String(m.count) : ''}</span>
              <div className={css.monthFill} data-peak={m.count === monthMax || undefined} data-on={m.key === monthFilter || undefined} style={{ height: String(Math.max(2, Math.round((m.count / monthMax) * 30))) + 'px' }} />
              <span className={css.monthLabel}>{m.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* insight stats */}
      <div className={css.insight}>
        <div className={css.stat}>
          <span className={css.statIcon}>📊</span>
          <span className={css.statNum} title="服务端全量动态数">{String(total)}</span>
          <span className={kitCss.textCaption}>总动态</span>
        </div>
        <div className={css.stat}>
          <span className={css.statIcon}>🖼</span>
          <span className={css.statNum}>{insight.withImages}</span>
          <span className={kitCss.textCaption}>含图片</span>
        </div>
        <div className={css.stat}>
          <span className={css.statIcon}>🎬</span>
          <span className={css.statNum}>{insight.withVideos}</span>
          <span className={kitCss.textCaption}>含视频</span>
        </div>
        <div className={css.stat}>
          <span className={css.statIcon}>📍</span>
          <span className={css.statNum}>{insight.withLocation}</span>
          <span className={kitCss.textCaption}>带位置</span>
        </div>
        <div className={css.stat}>
          <span className={css.statIcon}>🔗</span>
          <span className={css.statNum}>{insight.withLink}</span>
          <span className={kitCss.textCaption}>分享链接</span>
        </div>
      </div>
    </aside>
  )
}
