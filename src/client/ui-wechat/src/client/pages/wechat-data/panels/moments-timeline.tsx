/**
 * 朋友圈时间线的骨架（#22 虚拟化：把"列表怎么摆"从面板本体里分出来）。
 *
 * 为什么单独一份：虚拟化之后这一屏的形状是"外层撑总高度 + 行按偏移绝对定位 + 日期标签也算一行"，
 * 而面板本体管的是取数、筛选、灯箱与导出。两件事混在一个 380 行的函数里，
 * 改任何一边都要在另一边的小心翼翼里过 —— 分开之后各自能单独测。
 *
 * 卡片本身怎么渲染由 `renderCard` 交回面板：那 28 个 props 是面板的状态与回调，
 * 搬进这里只会变成一层没有意义的转发。
 */
import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { ListSkeleton } from './hooks.tsx'
import type { MomentRow } from './moments-rows.ts'
import css from './moments.module.css'
import kitCss from '../ui/kit.module.css'

export interface MomentsTimelineProps {
  rows: readonly MomentRow[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  loading: boolean
  error: string | null
  loaded: number
  total: number
  searching: boolean
  loadingAll: boolean
  emptyText: string
  onLoadAll: () => void
  renderCard: (m: MomentItem) => React.JSX.Element
}

/**
 * 渲染时间线（含滚动容器、空态、加载提示与「回到顶部」）。
 * @returns 时间线元素。
 */
export function MomentsTimeline(p: MomentsTimelineProps): React.JSX.Element {
  const items = p.virtualizer.getVirtualItems()
  /**
   * 悬浮日期头。原先标签是 `.dayGroup` 里的 `position: sticky` —— 虚拟化之后每一行是绝对定位的，
   * "在自己的分组里粘住"这件事自然失效（不报错，只是滚起来再也看不到当前是哪一天）。
   * 这里换成"按窗口顶端算出当前那一天，粘在滚动容器顶部"，与微信自己的时间线一致。
   * 窗口顶端本来就是那一天的标签行时**不显示**悬浮头 —— 否则同一行日期会上下出现两次。
   */
  const firstRow = items[0] ? p.rows[items[0].index] : undefined
  const floatingDay = useMemo(() => {
    const firstIdx = items[0]?.index ?? 0
    for (let i = Math.min(firstIdx, p.rows.length - 1); i >= 0; i -= 1) {
      const row = p.rows[i]
      if (row?.kind === 'day') return row.day
    }
    return ''
  }, [items, p.rows])
  const showFloatingDay = floatingDay !== '' && firstRow?.kind !== 'day'
  return (
    <div className={css.main}>
      <div ref={p.scrollRef} className={css.scroll}>
        {showFloatingDay && !p.loading && !p.error && (
          <div className={css.dayLabel} data-moment-float-day={floatingDay}>{floatingDay}</div>
        )}
        {p.loaded < p.total && (
          <div className={css.insightNote}>统计中的图片/视频/位置/链接为已加载部分；全量 {p.total} 条。</div>
        )}
        {p.searching && p.loaded < p.total && !p.loading && !p.error && (
          <div className={css.searchBanner}>
            <span>搜索仅覆盖已加载 {p.loaded} / {p.total} 条</span>
            <button type="button" className={css.btn} onClick={p.onLoadAll} disabled={p.loadingAll}>
              {p.loadingAll ? '加载中…' : '加载全部以覆盖全量'}
            </button>
          </div>
        )}
        {p.loading && p.loaded === 0 && <ListSkeleton rows={10} />}
        {p.error && <div className={kitCss.error} role="alert">⚠️ 朋友圈数据加载失败（{p.error}）</div>}
        {!p.loading && !p.error && p.rows.length === 0 && <div className={kitCss.emptyInline}>{p.emptyText}</div>}
        {/*
         * 虚拟化：外层撑出总高度，行按各自偏移绝对定位（与消息流/收藏/文件同一形状）。
         * 日期标签也是一行 —— 所以"滚到某一天"与"滚到某一条"共用同一套下标。
         */}
        {!p.loading && !p.error && p.rows.length > 0 && (
          /*
           * `flex: 0 0 auto` 不是可有可无：`.scroll` 是 flex 纵向容器，不给这一句，
           * 撑高度的占位块会被 flex-shrink 压回容器高度 —— 表现是"滚到底也只挂前十几行、
           * 后面的永远滚不到"（真窗口量过一次才知道）。消息流那侧同一形状早就带着这句。
           */
          <div data-moment-rows={p.rows.length} style={{ position: 'relative', height: p.virtualizer.getTotalSize(), flex: '0 0 auto' }}>
            {items.map((vi) => {
              const row = p.rows[vi.index]
              if (!row) return null
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  data-moment-row={row.kind === 'day' ? row.day : String(row.m.tid)}
                  ref={p.virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  {row.kind === 'day' ? <div className={css.dayLabel}>{row.day}</div> : p.renderCard(row.m)}
                </div>
              )
            })}
          </div>
        )}
        {!p.loading && !p.error && p.loaded > 0 && p.loaded < p.total && (
          <div className={css.moreRow}>
            <button type="button" className={css.moreBtn} onClick={p.onLoadAll} disabled={p.loadingAll}>
              {p.loadingAll ? '加载中…' : `加载全部（剩余 ${p.total - p.loaded} 条）`}
            </button>
          </div>
        )}
      </div>
      {typeof document !== 'undefined' && createPortal(
        <button
          type="button"
          className={css.backTop}
          onClick={() => { p.scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' }) }}
          title="回到顶部"
          aria-label="回到顶部"
        >↑</button>,
        document.body,
      )}
    </div>
  )
}

