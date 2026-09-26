/**
 * 消息日历弹窗（#19 第七刀，自 `chats-view.tsx` 那棵渲染树里切出）。
 *
 * 日历那一族的算术早就在 `chats-calendar.ts` 里逐条钉住了，这一份只负责**那一屏**：
 * ① 点遮罩要判 `e.target === e.currentTarget` —— 在日历里点日期、选字都会冒泡到遮罩，
 *    缺这一判就变成"点哪都关"（导出弹窗那一刀栽过的同一个坑，规矩必须两边一致）；
 * ② 加载中**只给文案**，不画上一月的格子：`useChatsCalendar` 在飞之前先把网格清空，
 *    这里保证那次清空对用户不可见（留着旧计数就是"用上个月的颜色画这个月"）；
 * ③ 每一格的 `title` 是"这天到底有没有消息"唯一的非视觉出口 —— 色块深浅对色盲与
 *    读屏都不成立，所以 title 的两种文案（有消息 / 无消息）都算判据；
 * ④ 星期表头从「一」排到「日」，`calFirstDow` 是**周一为 0** 的前置空格数（与 `Date.getDay()`
 *    差一位，换算在 `deriveCalendar` 里做，这里只按它铺格子）。
 */
import kitCss from '../ui/kit.module.css'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DailyCounts } from './chats-calendar.ts'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'

export interface ChatsCalendarDialogProps {
  calActiveDays: number
  calAvg: number
  calCounts: DailyCounts
  calDays: number
  calFirstDow: number
  calHeat: (cnt: number) => string
  calLoading: boolean
  calMonth: number
  /** 打开位住在消息搜索那一族（弹窗互相排他），所以由调用方传进来。 */
  calOpen: boolean
  calTop: { day: number; count: number } | null
  calTotal: number
  calYear: number
  jumpToDay: (day: number) => void
  setCalOpen: (open: boolean) => void
  switchCalMonth: (delta: number) => Promise<void>
}

/** 消息日历（A8）：热力网格 + 点日深链到当天。 */
export function ChatsCalendarDialog(props: ChatsCalendarDialogProps): React.JSX.Element | null {
  const {
    calActiveDays, calAvg, calCounts, calDays, calFirstDow, calHeat, calLoading, calMonth,
    calOpen, calTop, calTotal, calYear, jumpToDay, setCalOpen, switchCalMonth,
  } = props
  if (!calOpen) return null
  return (
    <div className={csscards.calOverlay} data-st-dialog="chats-cal" onClick={(e) => { if (e.target === e.currentTarget) setCalOpen(false) }} role="dialog" aria-modal="true">
      <div className={csscards.calDialog}>
        <div className={cssshell.calHeader}>
          <span className={csscards.calTitle}>消息日历</span>
          <button type="button" className={csscards.calClose} onClick={() => { setCalOpen(false) }}><IconCloseOutline16 size={15} /></button>
        </div>
        <div className={csscards.calBody}>
          <div className={cssshell.calNav}>
            <button type="button" className={csscards.loadMore} onClick={() => { void switchCalMonth(-1) }} aria-label="上一月">‹</button>
            <span className={csscards.calMonthTitle}>{calYear} 年 {calMonth} 月</span>
            <button type="button" className={csscards.loadMore} onClick={() => { void switchCalMonth(1) }} aria-label="下一月">›</button>
          </div>
          {calLoading ? (
            <div className={kitCss.emptyInline}>加载中…</div>
          ) : (
            <>
              <div className={csscards.calStats}>
                <span className={cssshell.calStat}>本月共 <b>{calTotal}</b> 条消息</span>
                <span className={cssshell.calStat}>活跃 <b>{calActiveDays}</b> 天</span>
                <span className={cssshell.calStat}>日均 <b>{calAvg}</b> 条</span>
                {calTop && <span className={cssshell.calStat}>最活跃：{calMonth}月{calTop.day}日（{calTop.count} 条）</span>}
              </div>
              <div className={cssshell.calGrid}>
                {['一', '二', '三', '四', '五', '六', '日'].map(wd => (
                  <div key={wd} className={cssshell.calWd}>{wd}</div>
                ))}
                {Array.from({ length: calFirstDow }).map((_, i) => <div key={`e${i}`} className={cssshell.calEmpty} />)}
                {Array.from({ length: calDays }).map((_, i) => {
                  const day = i + 1
                  const cnt = calCounts[String(day)] ?? 0
                  return (
                    <button key={day} type="button" className={csscards.calDay} style={{ background: calHeat(cnt) }}
                      title={cnt ? `${calMonth}月${day}日：${cnt} 条消息` : `${calMonth}月${day}日：无消息`}
                      onClick={() => { jumpToDay(day) }}>
                      <span className={cssshell.calDayNum}>{day}</span>
                      {cnt > 0 && <span className={csscards.calDayCnt}>{cnt}</span>}
                    </button>
                  )
                })}
              </div>
              <p className={cssshell.calHint}>点击日期跳转到当天消息（色块深浅表示消息量）</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
