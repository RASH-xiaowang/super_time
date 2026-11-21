/**
 * 年度总结 · 年度回顾看板。
 *
 * 数据全部来自本机解密库（`getAnnualReview`），口径见后端 `query/annual-review.ts`：
 *   · 人物类指标（发出/排行/搭子/口头禅/回复速度/谁先开口）只算**我发出的**；
 *   · 规模类指标（日历热力/最疯的一天/作息切片）算**全部消息**。
 * 两类口径在看板上分别标注，避免「日均 28 条却有一天 2,218 条」这种无法解释的数字。
 *
 * ## 一屏 8 张卡的排布（2026-11-19 按叙事重排）
 *
 * 改前是 27 张卡片墙；2026-10-19 收敛到 8 张，2026-11-19 再按「读起来顺」重排成四段：
 *
 *   段1 这一年       HeroCard(6)      RhythmCard(6)        我的产出与作息
 *   段2 你和他们     RankingCard(6)   GroupsCard(6)        先跟谁聊、群里怎么样
 *   段3 生活的痕迹   MoneyCard(6)     MomentsCard(3)   MediaCallCard(3)
 *   段4 值得记住     ExtremesCard(12) 年度之最（横贯，小砖块平铺）
 *   页脚            footer(12)
 *
 * **为什么内容最多的资金卡给 6 列**：它要放「总额 + 未计入 + 最大一笔 + 往来 TOP5」，
 * 4 列时每行折成两段、卡片被撑到约 300px，同排的矮卡下方就空出一大片。给 6 列后
 * 名字与金额同行、卡片变矮，三张卡的高度接近（2026-11-19 用户反馈「空白太多」）。
 * 整页严格整除 12（合计 60 列 = 5 行）。
 *
 * **段与段之间不加横贯标题**：那会破坏 12 列网格的整除关系，也把一屏切成碎片。
 * 分区改由每张卡右上角的小药丸承担（`Card` 的 `zone`）。
 *
 * ⚠️ 改顺序或 span 时必须同步 `annual-skeleton.tsx` 的 CELLS 与
 * `annual-more.wiring.spec.ts` —— 两处都会逐行求和。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCapturePanel, apiGetAnnual, apiGetAnnualReview, apiGetAvatarsLocal, readRenderCache, runtimeCapabilities, writeRenderCache } from '../api.ts'
import type { AnnualReviewShape } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import { CardCanvasSkeleton } from './annual-skeleton.tsx'
import { annualReviewCacheKey, defaultAnnualYear, normalizeAnnualYears, normalizeReview, type NormalizedReview } from './annual-normalize.ts'
import { AVATAR_SIZE, Avatar, adaptiveTiers, dur, fmt, lv } from './annual-common.tsx'
import { CardCanvas } from './card-canvas.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import { WordCloudCard } from './WordCloudCard.tsx'
import { IdentityName } from './identity.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask } from './export-task.ts'
import {
  AssetsCard, CatchphraseTopCard, ExtremesCard, GroupsCard, MediaCallCard, MomentsCard,
  MoneyCard, MonthlyTrendCard, RevokeCard, YearPortrait,
} from './annual-more-cards.tsx'
import { EmptyState, PanelHeader } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './annual.module.css'
import { avatarColors, fmtBytes } from '../utils/format.ts'
import { withEnterprise } from './enterprise-identity.ts'


/** 周一为首的行标签。 */
const DOW = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 卡片的**语义色调**（2026-10-17 新增）。
 *
 * ## 为什么按语义分色，而不是随便挑好看的
 *
 * 27 张卡片如果全是同一个底色，用户扫视时只能靠读标题区分 —— 一屏卡片墙里
 * 找「钱在哪」「作息在哪」要逐张读字。按**内容语义**分色之后，颜色本身成了索引：
 * 青=规模、紫=作息、粉=社交、绿=钱、琥珀=极值、蓝=媒体、红=撤回。
 *
 * ## 为什么只有 7 个 tone
 *
 * 再多就分不清了（人眼对色相的短期记忆约 5–7 档）。7 个 tone 覆盖 27 张卡，
 * 每张卡的 tone 由**它回答什么问题**决定，不是由它在网格里的位置决定。
 *
 * ## 背景怎么画
 *
 * 不用纯色块（27 张彩色卡会像调色盘），而是**极淡的径向渐变 + 顶部一道色线**：
 *   · 径向渐变从左上角散开，浓度只有 6–10%，深色主题下几乎看不出是"彩色"，
 *     但扫视时能感到"这一片是暖的/冷的"；
 *   · 顶部 2px 色线是**唯一**明确着色的地方 —— 它足够细，不会抢内容，
 *     又足够长，一眼能看出分组。
 * 两套主题共用同一套 tone 名，具体色值走 `--nm-*` 令牌（浅色主题自动压暗）。
 */
export type CardTone = 'cyan' | 'purple' | 'pink' | 'green' | 'amber' | 'blue' | 'red'

/**
 * 卡片外壳。
 *
 * ## 尺寸口径（2026-10-17 第四次改，参照用户给的参考图）
 *
 * **卡片高度随内容** —— 不再固定行高、不再跨行、不再内部滚动。
 * 参考图的设计语言是「数据报表」：卡片高度跟着内容走，内容多的卡自然更高，
 * 整页像一张报表而不是"积木墙"。
 *
 * 演进过程（每一版都被用户当场否决）：
 *   1. `space-between` 撑满 → 内容被拉散，中间大片空白；
 *   2. 固定行高 230px → 内容少的卡留白、内容多的卡出滚动条；
 *   3. 固定行高 + 跨 2 行 → 滚动条没了，但 2 行卡下方留白 200px；
 *   4. **现在**：高度随内容 + `dense` 补空 —— 参考图的做法，最简单也最好看。
 *
 * ## `zone`：分区标签（2026-11-19 加）
 *
 * 8 张核心卡按**叙事**排成四段（这一年 / 你和他们 / 生活的痕迹 / 值得记住）。
 * 段与段之间不加横贯标题 —— 那会破坏 12 列网格的整除关系（`annual-more.wiring.spec.ts`
 * 逐行求和），也会把一屏切成四块碎片。改成每张卡右上角一枚小药丸，扫视时自然聚成组。
 *
 * @param span 12 列网格里的占列数（退化布局下忽略）。
 */
/**
 * 卡片外壳。
 *
 * `canvasId` **必填**（2026-11-19）。此前它是可选的 —— 没传就退回 12 列网格卡，
 * 而网格卡在**绝对定位的画布**里会留在文档流里撑满整行、压住别的卡。
 * 那次事故的现场就是 `YearPortrait` 没走外壳、`OvSection` 忘了传 id。
 * 可选参数等于把这个坑留给下一个人，所以改成必填：忘传 = 编译错误。
 *
 * @param canvasId 画布里的稳定 id（位置按它存取，改名等于换了一张卡）。
 */
function Card({
  canvasId, title, extra, zone, tone = 'cyan', children,
}: {
  /** 画布里的稳定 id（**必填**，见上面的说明）。 */
  canvasId: string
  title: React.ReactNode
  extra?: React.ReactNode
  /** 分区标签（这一年 / 你和他们 / 生活的痕迹 / 值得记住）。 */
  zone?: string
  tone?: CardTone
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <CanvasCard id={canvasId} title={title} zone={zone} extra={extra} tone={tone}>
      {children}
    </CanvasCard>
  )
}

/** ① 全年发出。 */
function HeroCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  // 活跃率：一年 365 天里有多少天发过消息。原先只显示「活跃 N 天」，
  // 用户得自己换算成比例才知道算不算勤快。
  const activeRate = Math.round((r.activeDaysMine / 365) * 100)
  return (
    <Card canvasId="hero" title="全年发出" tone="cyan" zone="这一年" extra={`发给 ${fmt(r.sentTo)} 个会话`}>
      <div className={css.heroNum}>{fmt(r.sent)}<small>条</small></div>
      <div className={css.heroSub}>平均每天 {r.sentDailyAvg} 条 · 一年就这样过去了。</div>
      {/* 活跃率条：把「活跃 237 天」变成一眼能读的比例。
          ⚠️ 2026-10-17：格子从 8 个减到 6 个 —— 原先「日均」「活跃率」两个格子
          与上面的副标题、这条进度条**重复**，多出来的 2 行把卡片撑出滚动条（溢出 73px）。 */}
      <div className={css.heroRate}>
        <div className={css.heroRateBar}>
          <div className={css.heroRateFill} style={{ width: `${String(activeRate)}%` }} />
        </div>
        <span className={css.heroRateText}>
          一年 365 天里，有 <b>{r.activeDaysMine}</b> 天在说话（{activeRate}%）
        </span>
      </div>
      <div className={css.heroGrid}>
        <div className={css.heroCell}><span className={css.heroCellK}>最长连续</span><span className={css.heroCellV}>{r.longestStreak} 天</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>新朋友</span><span className={css.heroCellV}>{r.newFriends} 位</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>图片视频</span><span className={css.heroCellV}>{fmt(r.mediaSent)} 条</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>会话数</span><span className={css.heroCellV}>{fmt(r.sentTo)} 个</span></div>
        <div className={`${css.heroCell}`} style={{ gridColumn: 'span 2' }}>
          <span className={css.heroCellK}>最长的一段</span>
          <span className={css.heroCellV}>{r.longestSpanFrom ? `${r.longestSpanFrom.slice(5)} – ${r.longestSpanTo.slice(5)}` : '—'}</span>
        </div>
      </div>
    </Card>
  )
}

/** ② 日历热力（全部消息口径）。 */
function CalendarCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const cols = useMemo(() => {
    const first = new Date(r.year, 0, 1)
    const off = (first.getDay() + 6) % 7
    const total = r.calendar.length
    const n = Math.ceil((total + off) / 7)
    const cells: Array<{ col: number; row: number; n: number; d: string } | null> = []
    for (let c = 0; c < n; c += 1) {
      for (let w = 0; w < 7; w += 1) {
        const idx = c * 7 + w - off
        const day = idx >= 0 && idx < total ? r.calendar[idx] : null
        cells.push(day ? { col: c, row: w, n: day.n, d: day.d } : null)
      }
    }
    // 每个月的起始列（放月份标签）
    const monthCols: number[] = []
    for (let m = 0; m < 12; m += 1) {
      const t = new Date(r.year, m, 1)
      const idx = Math.round((t.getTime() - first.getTime()) / 86400000)
      monthCols.push(Math.floor((idx + off) / 7))
    }
    return { cells, n, monthCols }
  }, [r])
  const tiers = useMemo(() => adaptiveTiers(r.maxDayAll), [r.maxDayAll])

  return (
    <Card
      canvasId="more-calendar"
      tone="cyan"
      zone="这一年"
      title={`${r.year} 年的 ${r.calendar.length} 天`}
      extra={`全年活跃 ${r.activeDaysAll} 天 · 最高一天 ${fmt(r.maxDayAll)} 条`}
    >
      <div className={css.calWrap}>
        <div className={css.calMonths} style={{ gridTemplateColumns: `repeat(${cols.n}, minmax(0, 1fr))` }}>
          {cols.monthCols.map((c, m) => (
            <span key={m} style={{ gridColumn: c + 1 }}>{m + 1}月</span>
          ))}
        </div>
        <div className={css.calBody}>
          <div className={css.calDows}>{DOW.map(d => <span key={d}>{d}</span>)}</div>
          <div className={css.calGrid} style={{ gridTemplateColumns: `repeat(${cols.n}, minmax(0, 1fr))` }}>
            {cols.cells.map((c, i) => (
              c
                ? <span key={i} className={css.calCell} data-lv={lv(c.n, tiers) || undefined} title={`${c.d} · ${c.n} 条`} />
                : <span key={i} className={css.calCell} data-empty="1" />
            ))}
          </div>
        </div>
        <div className={css.calFoot}>
          <span className={css.calLegend}>
            少
            <span className={css.calCell} />
            <span className={css.calCell} data-lv="1" />
            <span className={css.calCell} data-lv="2" />
            <span className={css.calCell} data-lv="3" />
            <span className={css.calCell} data-lv="4" />
            多
          </span>
          <span className={css.calLegend}>每格一天的<b>&nbsp;全部消息&nbsp;</b>条数</span>
        </div>
      </div>
    </Card>
  )
}

/** ④ 年度搭子。 */
function BuddyCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element | null {
  const b = r.buddy
  if (!b) return null
  const total = Math.max(1, b.mine + b.theirs)
  return (
    <Card canvasId="more-buddy" title="年度搭子" tone="pink" extra="今年话最多的一对">
      <div className={css.row}>
        <Avatar username={b.username} name={b.name} size={AVATAR_SIZE} src={av.get(b.username) ?? undefined} />
        <div className={css.rowMain}>
          <div className={css.name}>{withEnterprise(b.name, b.enterpriseName)}</div>
          <div className={css.sub}>{fmt(b.total)} 条 · 你发 {b.mine} / TA 发 {b.theirs}</div>
        </div>
      </div>
      {/* 互动比例：单色进度条看不出"不对等"，改成**双段对比条 + 两侧百分比** ——
          123 : 1920 这种一边倒的比例要一眼跳出来（用户点名说这是个有趣的槽点）。 */}
      <div className={css.ratio} title={`你 ${fmt(b.mine)} 条 · TA ${fmt(b.theirs)} 条`}>
        <div className={css.ratioMine} style={{ width: `${(b.mine / total) * 100}%` }} />
        <div className={css.ratioTheirs} />
      </div>
      <div className={css.ratioLegend}>
        <span>你 {fmt(b.mine)} 条 · {((b.mine / total) * 100).toFixed(0)}%</span>
        <span>TA {fmt(b.theirs)} 条 · {((b.theirs / total) * 100).toFixed(0)}%</span>
      </div>
      <div className={css.kv}><span>连续 / 常在</span><b>{b.streakDays} 天 · {String(b.commonHour).padStart(2, '0')}:00</b></div>
      {/* 2026-10-17：从「4 格 + 结论句」精简成「3 格」——
          原先「常在」格子与上面 kv 重复、结论句与比例图例重复，
          多出来的 2 行把卡片撑出滚动条（溢出 128px）。 */}
      <div className={css.heroGrid} style={{ marginTop: 4 }}>
        <div className={css.heroCell}><span className={css.heroCellK}>接话</span><span className={css.heroCellV}>{fmt(b.replyBacks)} 次</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>最快回</span><span className={css.heroCellV}>{dur(b.fastestSec)}</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>最慢等</span><span className={css.heroCellV}>{dur(b.slowestSec)}</span></div>
      </div>
    </Card>
  )
}

/** ⑤ 十二个月的主演。 */
function MonthlyStarCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  const byMonth = new Map(r.monthlyStar.map(x => [x.month, x]))
  const hot = r.hottestMonth
  return (
    <Card
      canvasId="more-monthly-star"
      tone="pink"
      title="十二个月的主演"
      extra={r.starName ? (
        <span className={css.inlineExtra}>
          年度主演
          <IdentityName name={r.starName} username={r.starUsername} size={16}>
            {withEnterprise(r.starName, r.starEnterpriseName)}
          </IdentityName>
          · {r.starMonths} 个月
        </span>
      ) : ''}
    >
      <div className={css.starGrid}>
        {Array.from({ length: 12 }, (_, i) => {
          const m = i + 1
          const s = byMonth.get(m)
          return (
            <div key={m} className={`${css.starCell} ${m === hot ? css.starHot : ''}`}>
              <span className={css.starM}>{m}月</span>
              {s
                ? <Avatar username={s.username} name={s.name} size={AVATAR_SIZE} src={av.get(s.username) ?? undefined} />
                : <span className={css.av} style={{ width: 30, height: 30, background: 'transparent', color: 'var(--nm-text-3)', fontSize: 14 }}>—</span>}
              <span className={css.sub} title={s ? withEnterprise(s.name, s.enterpriseName) : ''}>{s ? withEnterprise(s.name, s.enterpriseName) : '—'}</span>
              {/* 每月条数：原先只画头像，卡片下半截全空（填充率 34%）。
                  后端 `monthlyStar[].count` 一直有值，只是没显示。 */}
              <span className={css.starCount}>{s ? fmt(s.count) : ''}</span>
            </div>
          )
        })}
      </div>
      {/* 图例补三行：最热月 / 最冷月 / 主演覆盖月数 —— 让卡片下半截有信息而不是空白。 */}
      <div className={css.calFoot}>
        <span className={css.calLegend}>最热 {hot} 月 · {fmt(r.hottestMonthCount)} 条</span>
        {r.starName && (
          <span className={`${css.calLegend} ${css.identityLegend}`}>
            年度主演
            <IdentityName name={r.starName} username={r.starUsername} size={16}>
              {withEnterprise(r.starName, r.starEnterpriseName)}
            </IdentityName>
            · 拿下 {r.starMonths} 个月
          </span>
        )}
        <span className={css.calLegend}>
          {r.monthlyStar.length} 个月有单聊记录 · 平均每月 {fmt(Math.round(r.monthlyStar.reduce((a, x) => a + x.count, 0) / Math.max(1, r.monthlyStar.length)))} 条
        </span>
      </div>
    </Card>
  )
}

/** ⑥ 深夜。 */
function NightCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  const n = r.night
  const total = Math.max(1, n.mine + n.theirs)
  return (
    <Card canvasId="more-night" title="深夜" tone="purple" extra={`陪你完成 ${(n.share * 100).toFixed(1)}% 的深夜`}>
      <div className={css.nightTop}>
        <Avatar username={n.topUsername} name={n.topName} size={AVATAR_SIZE} />
        <div className={css.rowMain}>
          <div className={css.name}>{n.topName ? withEnterprise(n.topName, n.topEnterpriseName) : '—'}</div>
          <div className={css.sub}>0-6 点共 {fmt(n.topCount)} 条</div>
        </div>
      </div>
      {/* 深夜占比条：把「陪你完成 12.3% 的深夜」变成可视比例。 */}
      <div className={css.heroRate}>
        <div className={css.heroRateBar}>
          <div className={css.heroRateFill} style={{ width: `${String(Math.min(100, n.share * 100 * 4))}%` }} />
        </div>
        <span className={css.heroRateText}>
          0–6 点占全年 <b>{(n.share * 100).toFixed(1)}%</b> 的消息
        </span>
      </div>
      {/* 2026-10-17：从 4 格减到 2 格 —— 「你占 / TA 占」两个百分比与上面的
          占比条重复，多出来的 1 行把卡片撑出滚动条（溢出 96px）。 */}
      <div className={css.heroGrid} style={{ marginTop: 4 }}>
        <div className={css.heroCell}><span className={css.heroCellK}>你发出</span><span className={css.heroCellV}>{fmt(n.mine)} 条</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>对方发出</span><span className={css.heroCellV}>{fmt(n.theirs)} 条</span></div>
      </div>
      {n.sampleAt && <div className={css.quote}>{n.sampleAt} 你说：{n.sampleText.slice(0, 40) || '（非文字）'}</div>}
    </Card>
  )
}

/** ⑦ 作息切片（全部消息口径）。 */
function RhythmCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const heat = r.rhythm.heat
  const tiers = useMemo(() => adaptiveTiers(heat.reduce((m, x) => Math.max(m, x), 0)), [heat])
  return (
    <Card
      canvasId="rhythm"
      tone="purple"
      title="作息切片"
      extra={`一周 168 格 · 共 ${fmt(r.rhythm.heat.reduce((a, n) => a + n, 0))} 条`}
    >
      <div>
        {DOW.map((d, w) => (
          /* 周末两行（周日/周六）打上标记：热力图上高亮，方便区分工作日与休息日。 */
          <div key={d} className={css.rhythmRow} data-weekend={(w === 0 || w === 6) || undefined}>
            <span className={css.rhythmDow}>{d}</span>
            <div className={css.rhythmGrid}>
              {Array.from({ length: 24 }, (_, h) => {
                const cnt = heat[w * 24 + h] ?? 0
                return <span key={h} className={css.rhythmCell} data-lv={lv(cnt, tiers) || undefined} title={`周${d} ${String(h).padStart(2, '0')}:00 · ${cnt} 条`} />
              })}
            </div>
          </div>
        ))}
        <div className={css.rhythmHours}>
          <span />
          <div className={css.rhythmHourTicks}>
            {Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
          </div>
        </div>
      </div>
      {/* 热力图不能只有色块：给一句**结论**，否则用户得自己数格子（原话："缺少图例和结论"）。 */}
      <div className={css.rhythmConclusion}>
        你的活跃巅峰是<b>周{DOW[r.rhythm.brightestDow]} {String(r.rhythm.brightestHour).padStart(2, '0')}:00</b>，
        那一格收发 <b>{fmt(r.rhythm.brightestCount)}</b> 条；
        {r.rhythm.workWeekendRatio >= 1 ? '周末比工作日更忙。' : '工作日比周末更忙。'}
      </div>
      {/* 图例：色阶从「少」到「多」（`adaptiveTiers` 按本年峰值自适应，所以要写清是相对的）。 */}
      <div className={css.calFoot}>
        <span className={css.calLegend}>色深 = 该时段条数（按全年峰值自适应）</span>
        <span className={css.calLegend}>最安静 {String(r.rhythm.quietestHour).padStart(2, '0')}:00 · 仅 {r.rhythm.quietestCount} 条</span>
        <span className={css.calLegend}>深夜指数 {(r.rhythm.nightShare * 100).toFixed(1)}% · 工作日:周末 {r.rhythm.workWeekendRatio}:1</span>
      </div>
    </Card>
  )
}

/**
 * ⑧ 你说的话（**只讲「文字量」这一件事**）。
 *
 * ## 2026-11-19 去重
 *
 * 这里原来有 6 个格子：敲字、语音发出、语音收到、通话、接通/未接、视频/语音。
 * 后 5 个与「媒体与通话」卡（`MediaCallCard`）**逐字重复** —— 同一份数据在两处画两遍，
 * 用户读到第二条时只会想"我刚不是看过吗"。
 *
 * 现在按**语义**分工：
 *   · 本卡 = 我打了多少字（主值 + 收发对比 + 敲字次数）；
 *   · `MediaCallCard` = 媒体与通话（图片视频 / 语音 / 通话 / 接通率 / 表情）。
 * 一张卡只回答一个问题，这也是「能拆就拆」的前提 —— 拆之前先别把两件事塞在一起。
 */
function WordsCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const w = r.words
  return (
    <Card canvasId="more-words" title="你说的话" tone="blue" extra={`收到 ${fmt(w.receivedChars)} 字`}>
      <div className={css.bigDay}>
        <span className={css.bigDayNum}>{fmt(w.mineChars)}</span>
        <span className={css.bigDayUnit}>字</span>
      </div>
      {/* 收发字数对比条：把「我发 X 字 / 收到 Y 字」变成可视比例。 */}
      <div className={css.ratio} title={`你发 ${fmt(w.mineChars)} 字 · 收到 ${fmt(w.receivedChars)} 字`}>
        <div className={css.ratioMine} style={{ width: `${String((w.mineChars / Math.max(1, w.mineChars + w.receivedChars)) * 100)}%` }} />
        <div className={css.ratioTheirs} />
      </div>
      <div className={css.ratioLegend}>
        <span>你发 {fmt(w.mineChars)} 字</span>
        <span>收到 {fmt(w.receivedChars)} 字</span>
      </div>
      <div className={css.heroGrid} style={{ marginTop: 4 }}>
        <div className={css.heroCell}>
          <span className={css.heroCellK}>敲字</span>
          <span className={css.heroCellV}>{fmt(w.keystrokes)} 次</span>
        </div>
        {w.longestVoiceSec > 0 && (
          <div className={css.heroCell}>
            <span className={css.heroCellK}>最长一条语音</span>
            <span className={css.heroCellV}>{dur(w.longestVoiceSec)}</span>
          </div>
        )}
      </div>
    </Card>
  )
}

/** ⑨ 年度口头禅。 */
function CatchphraseCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const c = r.catchphrase
  // 2026-10-17：从 7 条减到 5 条 —— 每条占一行（短语 + 次数 + 占比条），
  // 7 条 + 主口头禅 + 卡片头 = 超出 230px 行高（溢出 51px）。
  // 完整 TOP10 在「口头禅 TOP10」卡里，这里只给"最像口头禅的几句"。
  const rest = c.top.slice(1, 6)
  const maxCount = Math.max(1, ...rest.map(p => p.count))
  return (
    <Card canvasId="more-catchphrase" title="年度口头禅" tone="pink" extra={`${fmt(c.shortTotal)} 句短表达 · ${fmt(c.catchTotal)} 句成了口头禅`}>
      {c.phrase
        ? <div className={css.phraseHero}>“{c.phrase}”<span className={css.sub} style={{ marginLeft: 8 }}>说了 {c.count} 次</span></div>
        : <div className={css.sub}>还没有足够短的重复表达</div>}
      {/* 芯片 + 占比条：左边短语、右边一条按次数缩放的细条 ——
          一眼能看出"哪句才是真口头禅"，而不是一串等宽药丸。 */}
      <div className={css.phraseList}>
        {rest.map(p => (
          <span key={p.phrase} className={css.chip}>
            {p.phrase}
            <b>{p.count}</b>
            <span className={css.chipBar} style={{ width: `${String(Math.round((p.count / maxCount) * 100))}%` }} />
          </span>
        ))}
      </div>
      {rest.length === 0 && <div className={css.sub}>这一年没有重复 2 次以上的短表达</div>}
    </Card>
  )
}

/** ⑩ 回复速度。 */
function ReplyCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const p = r.reply
  // 中位数 vs 九成：两个数差多少倍，直接决定"你是秒回还是看心情"。
  const spread = p.medianSec > 0 ? p.p90Sec / p.medianSec : 0
  return (
    <Card canvasId="more-reply" title="回复速度" tone="purple" extra="按「对方说 → 我回」的间隔统计">
      <div className={css.bigDay}>
        <span className={css.bigDayNum}>{dur(p.medianSec)}</span>
        <span className={css.bigDayUnit}>一半的消息，你在这个时间内回了</span>
      </div>
      {/* 中位数 → 九成 的跨度条：把"一半"和"九成"两个分位数画成一条轴（2026-10-17 补，
          原先卡片只有 101px 内容 / 230px 高）。 */}
      <div className={css.heroRate}>
        <div className={css.heroRateBar}>
          <div className={css.heroRateFill} style={{ width: `${String(Math.min(100, (p.medianSec / Math.max(1, p.p90Sec)) * 100))}%` }} />
        </div>
        <span className={css.heroRateText}>
          九成在 <b>{dur(p.p90Sec)}</b> 内回完{spread > 0 && <>（是中间值的 <b>{spread.toFixed(1)}</b> 倍）</>}
        </span>
      </div>
      <div className={css.heroGrid} style={{ marginTop: 4 }}>
        {p.avgPartnerName && (
          <div className={css.heroCell}>
            <span className={css.heroCellK}>和</span>
            <span className={css.heroCellV}>
              <IdentityName name={p.avgPartnerName} username={p.avgPartnerUsername} size={16}>
                {withEnterprise(p.avgPartnerName, p.avgPartnerEnterpriseName)}
              </IdentityName>
              {' '}{dur(p.avgPartnerSec)}
            </span>
          </div>
        )}
        <div className={css.heroCell}>
          <span className={css.heroCellK}>最快回给</span>
          <span className={css.heroCellV}>
            {p.fastestName
              ? <IdentityName name={p.fastestName} username={p.fastestUsername} size={16}>{withEnterprise(p.fastestName, p.fastestEnterpriseName)}</IdentityName>
              : '—'}
            {' '}{dur(p.fastestSec)}
          </span>
        </div>
        <div className={css.heroCell}>
          <span className={css.heroCellK}>最慢让</span>
          <span className={css.heroCellV}>
            {p.slowestName
              ? <IdentityName name={p.slowestName} username={p.slowestUsername} size={16}>{withEnterprise(p.slowestName, p.slowestEnterpriseName)}</IdentityName>
              : '—'}
            {' '}等 {dur(p.slowestSec)}
          </span>
        </div>
        <div className={css.heroCell}><span className={css.heroCellK}>中位数</span><span className={css.heroCellV}>{dur(p.medianSec)}</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>九成</span><span className={css.heroCellV}>{dur(p.p90Sec)}</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>快慢差</span><span className={css.heroCellV}>{spread > 0 ? `${spread.toFixed(1)} 倍` : '—'}</span></div>
      </div>
      {/* 结论句：把三个分位数翻译成"你是什么样的人"（2026-10-17 补，
          原先卡片只有 101px 内容 / 230px 高，填充率 31%）。 */}
      <div className={css.heroSub} style={{ marginTop: 4 }}>
        {p.medianSec <= 60
          ? `你基本是秒回型 —— 一半的消息在 ${dur(p.medianSec)} 内就回了。`
          : p.medianSec <= 600
            ? `你回得不急不慢 —— 一半的消息在 ${dur(p.medianSec)} 内回，九成在 ${dur(p.p90Sec)} 内。`
            : `你回消息比较随缘 —— 一半的消息要等 ${dur(p.medianSec)}，九成在 ${dur(p.p90Sec)} 内。`}
      </div>
    </Card>
  )
}

/** ⑪ 谁先开口。 */
function OpenerCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const o = r.opener
  const total = Math.max(1, o.mine + o.theirs)
  return (
    <Card canvasId="more-opener" title="谁先开口" tone="pink" extra={`全年 ${fmt(o.mine + o.theirs)} 次对话`}>
      <div className={css.bigDay}>
        <span className={css.bigDayNum}>{(o.share * 100).toFixed(1)}%</span>
        <span className={css.bigDayUnit}>的对话由你先开口</span>
      </div>
      {/* 双段对比条：把「你先 X 次 / TA 先 Y 次」画成一条轴（2026-10-17 补，
          原先只有单色进度条 + 两行 kv，卡片下半截空着）。 */}
      <div className={css.ratio} title={`你先 ${fmt(o.mine)} 次 · TA 先 ${fmt(o.theirs)} 次`}>
        <div className={css.ratioMine} style={{ width: `${String((o.mine / total) * 100)}%` }} />
        <div className={css.ratioTheirs} />
      </div>
      <div className={css.ratioLegend}>
        <span>你先 {fmt(o.mine)} 次 · {((o.mine / total) * 100).toFixed(0)}%</span>
        <span>TA 先 {fmt(o.theirs)} 次 · {((o.theirs / total) * 100).toFixed(0)}%</span>
      </div>
      <div className={css.kv}>
        <span>你最主动找</span>
        <b className={css.openerValue}>
          {o.mostInitiatedByMe.length > 0
            ? o.mostInitiatedByMe.map(x => (
                <IdentityName key={x.username} name={x.name} username={x.username} size={16}>
                  {withEnterprise(x.name, x.enterpriseName)} {x.count}
                </IdentityName>
              ))
            : '—'}
        </b>
      </div>
      <div className={css.kv}>
        <span>最主动来找你</span>
        <b className={css.openerValue}>
          {o.mostInitiatedByThem.length > 0
            ? o.mostInitiatedByThem.map(x => (
                <IdentityName key={x.username} name={x.name} username={x.username} size={16}>
                  {withEnterprise(x.name, x.enterpriseName)} {x.count}
                </IdentityName>
              ))
            : '—'}
        </b>
      </div>
      {/* 补充格子：把「你先/TA 先」的绝对数也列出来（2026-10-17 补，
          原先卡片只有 112px 内容 / 230px 高，填充率 47%）。 */}
      <div className={css.heroGrid} style={{ marginTop: 4 }}>
        <div className={css.heroCell}><span className={css.heroCellK}>你先</span><span className={css.heroCellV}>{fmt(o.mine)} 次</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>TA 先</span><span className={css.heroCellV}>{fmt(o.theirs)} 次</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>总对话</span><span className={css.heroCellV}>{fmt(o.mine + o.theirs)} 次</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>你占</span><span className={css.heroCellV}>{(o.share * 100).toFixed(0)}%</span></div>
      </div>
      <div className={css.heroSub} style={{ marginTop: 4 }}>
        {o.share > 0.6
          ? `你更常主动开口 —— 每 10 次对话里有 ${Math.round(o.share * 10)} 次是你起的头。`
          : o.share < 0.4
            ? `TA 更常主动开口 —— 你多数时候是"被找"的那一方。`
            : `你俩轮流起头，谁也没比谁更主动。`}
      </div>
    </Card>
  )
}

/** ⑫ 年度聊天排行。 */
function RankingCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  return (
    <Card canvasId="ranking" title="年度聊天排行" tone="pink" zone="你和他们" extra="你发 | TA 发">
      {r.ranking.length === 0 && <div className={css.sub}>暂无单聊记录</div>}
      {/* 一屏只放前 5：卡片行高固定，10 行会撑破并被裁掉 */}
      {r.ranking.slice(0, 5).map((row, i) => (
        <div key={row.username} className={css.rankRow}>
          <span className={css.rankNo}>{i + 1}</span>
          <Avatar username={row.username} name={row.name} size={AVATAR_SIZE} src={av.get(row.username) ?? undefined} />
          <div className={css.rowMain}><div className={css.name}>{withEnterprise(row.name, row.enterpriseName)}</div></div>
          <span className={css.rankVal} title={`你发 ${row.mine} / TA 发 ${row.theirs}`}>{fmt(row.total)}</span>
        </div>
      ))}
    </Card>
  )
}

/** ⑬ 表情宇宙。 */
function EmojiCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const e = r.emoji
  const topMax = Math.max(1, ...e.top.map(x => x.count))
  return (
    <Card canvasId="more-emoji" title="表情宇宙" tone="amber" extra={e.threw > 0 ? `出没 ${e.days} 天` : ''}>
      {/* 2026-10-17：原先 4 行 kv + 一排表情（109px / 230px，填充率 45%）。
          改成 2×2 小格 + 表情榜（带占比条），信息密度上来、空白也填掉了。 */}
      <div className={css.heroGrid}>
        <div className={css.heroCell}><span className={css.heroCellK}>甩出</span><span className={css.heroCellV}>{fmt(e.threw)} 张</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>攒下</span><span className={css.heroCellV}>{fmt(e.kept)} 种</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>均匀</span><span className={css.heroCellV}>{e.perDay} 张/天</span></div>
        {e.peakCount > 0 && <div className={css.heroCell}><span className={css.heroCellK}>最密集</span><span className={css.heroCellV}>周{DOW[e.peakDow]} {String(e.peakHour).padStart(2, '0')}:00</span></div>}
      </div>
      {/* 表情榜：每个表情后面跟一条按次数缩放的细条 —— 一眼看出"哪个才是真爱"。 */}
      <div className={css.emojiTop}>
        {e.top.map(x => (
          <span key={x.emoji} className={css.emojiCell}>
            <span style={{ fontSize: 16 }}>{x.emoji}</span>
            <span className={css.emojiBar} style={{ width: `${String(Math.round((x.count / topMax) * 100))}%` }} />
            <b>{x.count}</b>
          </span>
        ))}
      </div>
      {e.threw === 0 && <div className={css.sub}>这一年没甩过表情</div>}
    </Card>
  )
}

/** ⑭ 还有这些人。 */
function HighlightsCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element | null {
  if (r.highlights.length === 0) return null
  return (
    <Card canvasId="more-highlights" title="还有这些人" tone="pink">
      {/* 横向小卡（头像 + 说明列）：**放不下就换行**。
          原先这里复用 `.moreRow`（"标签 ←→ 数值"的不换行容器），而芯片类名
          （moreCell / moreInfo / moreLabel / moreVal）在当前样式里是缺失的 ⇒
          窄卡下 7 张芯片挤在一起、互相压住（用户 2026-09-30 报「该换行换行」）。

          2026-10-17：7 张芯片挤在一行只占 57px，卡片 230px 高、下方 170px 全空
          （填充率 24%）。改成**两行网格**（每行 4 张），并在下面补一行汇总。 */}
      <div className={css.hlRow}>
        {r.highlights.map((h, i) => (
          <div key={`${h.label}-${i}`} className={css.moreCell}>
            <Avatar username={h.username} name={h.name} size={AVATAR_SIZE} src={av.get(h.username) ?? undefined} />
            <div className={css.moreInfo}>
              <span className={css.moreLabel}>{h.label}</span>
              <span className={css.name} title={withEnterprise(h.name, h.enterpriseName)}>{withEnterprise(h.name, h.enterpriseName)}</span>
              <span className={css.moreVal}>{h.value}</span>
            </div>
          </div>
        ))}
      </div>
      {/* 汇总行：把 7 个"之最"压成一句人话，同时填满卡片下半截。 */}
      <div className={css.hlSummary}>
        <span>
          这一年，<b>{r.highlights.length}</b> 个「之最」落在 <b>{new Set(r.highlights.map(h => h.username)).size}</b> 个人/群身上
        </span>
      </div>
    </Card>
  )
}

/**
 * Render the annual review dashboard.
 * @returns the annual panel element tree.
 */
/** WAL 实时刷新的最小间隔：年报是逐条扫一年消息的重查询（无 api 层缓存），无感 ≠ 每秒重算。 */
const ANNUAL_LIVE_MIN_INTERVAL_MS = 60_000

function avatarUsernamesForReview(data: NormalizedReview): string[] {
  return [...new Set([
    ...data.ranking.map(x => x.username),
    ...data.monthlyStar.map(x => x.username),
    ...(data.buddy ? [data.buddy.username] : []),
    ...(data.starUsername ? [data.starUsername] : []),
    ...data.highlights.map(x => x.username),
  ].filter(Boolean))].slice(0, 60)
}

/**
 * 「更多年度数据」的 17 项（2026-11-19 抽出成组件，压 `AnnualPanel` 的行数）。
 *
 * **不再是一个独立画布**：它只返回一串卡片，由 `AnnualPanel` 放进**同一个** `CardCanvas`。
 * 改前它是 `<details>` 里第二个画布 —— 页面上出现两块分开的瀑布流，中间还夹着一条
 * 折叠标题，读起来像两篇文章（用户 2026-11-19：「不要分为两个分割的画布板块」）。
 *
 * 合并之后整页是**一条连续的瀑布流**：8 张核心卡在前、17 项明细在后，
 * 顺序即阅读顺序，拖拽也在同一块画布里进行（位置共用一个作用域）。
 *
 * @param props.data - 年报数据。
 * @param props.av - 头像表。
 * @returns 这 17 张卡的片段（由外层画布接管排版）。
 */
function MoreCards({ data, av }: { data: NormalizedReview; av: Map<string, string | null> }): React.JSX.Element {
  return (
    <>
      <CalendarCard r={data} />
      <MonthlyTrendCard r={data} />
      <MonthlyStarCard r={data} av={av} />
      <BuddyCard r={data} av={av} />
      <NightCard r={data} av={av} />
      <YearPortrait r={data} />
      <WordsCard r={data} />
      <CatchphraseCard r={data} />
      <ReplyCard r={data} />
      <OpenerCard r={data} />
      <EmojiCard r={data} />
      <CatchphraseTopCard r={data} />
      <RevokeCard r={data} />
      <AssetsCard r={data} />
      <HighlightsCard r={data} av={av} />
      <CanvasCard id="more-wordcloud-global" title={`${String(data.year)} 年度热词`}>
        <WordCloudCard scope="global" year={data.year} title="" limit={56} height={120} />
      </CanvasCard>
      <CanvasCard id="more-wordcloud-moments" title={`${String(data.year)} 朋友圈热词`}>
        <WordCloudCard scope="moments" year={data.year} title="" limit={56} height={120} />
      </CanvasCard>
    </>
  )
}

export function AnnualPanel(): React.JSX.Element {
  const [years, setYears] = useState<readonly number[]>([])
  const [year, setYear] = useState<number | null>(null)
  const [data, setData] = useState<NormalizedReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [av, setAv] = useState<Map<string, string | null>>(new Map())
  const exportTask = useExportTask()
  /** 面板根节点：导出时量它的矩形做截图（含标题栏/工具栏/页脚，不含左侧导航与顶部栏）。 */
  const shellRef = useRef<HTMLDivElement | null>(null)
  /** 年份切换和 WAL 刷新可能重叠：只允许最后发起的一次请求提交状态。 */
  const loadSeqRef = useRef(0)
  /**
   * 2026-09-30 删掉了「一屏海报」那套自适应：`bodyRef` + `compact` 状态 + 被切检测 +
   * 那套被切标记属性 全没了。
   *
   * 2026-11-19 起首屏 8 张卡改用**自由画布**（`CardCanvas`）：宽度按内容分档、
   * 高度随内容、可拖动摆放。折叠区仍是一张 12 列密排网格（`css.board`，默认收起）。
   */

  const loadYears = useCallback(async (): Promise<void> => {
    try {
      const env = await apiGetAnnual()
      /**
       * 年份归一化成降序（最新在前），默认打开**最新**的一年。
       * 原先是 `ys.at(-1)` —— 后端返回降序，`at(-1)` 每次选中最旧的 2020 年。
       * 排序与取值收在 `annual-normalize.ts` 的纯函数里，有行为级测试钉着。
       */
      const ys = normalizeAnnualYears(env.years)
      setYears(ys)
      setYear(prev => prev ?? defaultAnnualYear(ys))
    } catch (e) {
      setError((e as Error).message)
      setYear(prev => prev ?? new Date().getFullYear())
    }
  }, [])

  useEffect(() => { void loadYears() }, [loadYears])

  const load = useCallback(async (y: number): Promise<void> => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError(null)
    // 先出缓存秒开（首次扫描要逐条读一年消息，较慢）。
    // ⚠️ 缓存必须过 `normalizeReview`：旧版本写下的缓存没有底部五个新字段，
    // 直接喂给卡片会在渲染期抛 TypeError（`undefined.count`）⇒ 整窗黑屏。见 `annual-normalize.ts`。
    const cached = readRenderCache<AnnualReviewShape>(annualReviewCacheKey(y))
    if (seq === loadSeqRef.current && cached) setData(normalizeReview(cached))
    try {
      const r = await apiGetAnnualReview(y)
      if (seq !== loadSeqRef.current) return
      setData(normalizeReview(r as AnnualReviewShape))
      writeRenderCache(annualReviewCacheKey(y), r)
    } catch (e) {
      if (seq === loadSeqRef.current && !cached) setError((e as Error).message)
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { if (year !== null) void load(year) }, [year, load])

  // WAL 增量推送：新消息落地后静默重取本年度（缓存先上屏，不闪骨架）。
  // 年报要逐条扫一年消息（重查询且**无 api 层缓存**），推送每秒都可能来 ⇒ 面板级 60s 节流。
  const lastLiveRefreshRef = useRef(0)
  useWechatDataUpdated(() => {
    if (year === null) return
    const now = Date.now()
    if (now - lastLiveRefreshRef.current < ANNUAL_LIVE_MIN_INTERVAL_MS) return
    lastLiveRefreshRef.current = now
    void load(year)
  })

  // 头像批量拉取（一次 Remote，避免每张卡片各拉一遍）
  useEffect(() => {
    if (!data) return
    const users = avatarUsernamesForReview(data)
    if (users.length === 0) return
    void apiGetAvatarsLocal({ usernames: users })
      .then((map) => { setAv(new Map(Object.entries(map).filter(([, v]) => typeof v === 'string'))) })
      .catch(() => { /* 拿不到头像就退回首字占位 */ })
  }, [data])

  const doExport = useCallback(async (): Promise<void> => {
    if (year === null || exportTask.running) return
    const el = shellRef.current
    if (!el) return
    await exportTask.run(async () => {
      // 所见即所存：直接量面板矩形的 CSS 像素坐标交给主进程 capturePage，
      // 不另写报告模板 —— 导出的 PNG 与界面逐像素一致。
      const hidden = Array.from(el.querySelectorAll<HTMLElement>('[data-export-exclude]'))
      const previousDisplay = hidden.map(node => node.style.display)
      hidden.forEach(node => { node.style.display = 'none' })
      try {
        await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
        const r = el.getBoundingClientRect()
        const res = await apiCapturePanel({
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height,
          filename: `微信年度报告-${year}.png`,
        })
        if (res.canceled) throw new Error('已取消导出')
        if (!res.ok) throw new Error(res.message || '未知错误')
        return res
      } finally {
        hidden.forEach((node, index) => { node.style.display = previousDisplay[index] ?? '' })
      }
    }, {
      idPrefix: 'annual-image',
      label: '导出年度报告',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (res) => `已导出 PNG（${res.width}×${res.height}）→ ${res.path}`,
    })
  }, [year, exportTask])

  /**
   * 数据覆盖范围（只在**只有一个年份**时用）。
   *
   * 为什么需要：用户看到「只有 2026 年」的第一反应是"程序漏了其他年份"。
   * 把首末日期写出来（`2026-02-16 起`），用户立刻明白是本机微信只留了这么多 ——
   * 2026-10-17 实测本机 372 张 Msg_ 表最早消息就是 2026-02-16，不是扫描漏了。
   *
   * ⚠️ `calendar` 是**全年逐日**数组（含 0 条的日子），直接取 `[0]` 永远是 1 月 1 日。
   * 必须过滤 `n > 0` 才是"第一条消息那天"。
   */
  const coverageHint = useMemo((): string | null => {
    if (!data || data.calendar.length === 0) return null
    const days = data.calendar.filter(c => c.n > 0 && c.d).map(c => c.d).sort()
    const first = days[0]
    if (!first) return null
    // 只显示「起」：用户关心的是"为什么没有更早的"，末尾日期就是今天，没必要占位。
    return `${first} 起`
  }, [data])

  return (
    <div className={kitCss.panelShell} ref={shellRef}>
      <PanelHeader
        title="年度报告"
        desc={(
          <>
            本机聊天记录的年度回顾
            <span className={css.caliber} title="人物类指标（发出/排行/搭子/口头禅/回复速度/谁先开口）只统计「我发出的」；规模类指标（日历热力/最疯的一天/作息切片）统计全部消息">口径</span>
          </>
        )}
        actions={(
          <div className={css.tools}>
            {/* 只有一个年份时**不渲染下拉框** —— 一个选项的下拉框点开还是它自己，
                用户会以为"其他年份加载失败"（2026-10-17 用户实测反馈："为什么只有 2026 年的？"）。
                改成静态标签，并把**数据覆盖范围**写出来：用户看到「2026-02-16 起」就明白
                不是程序漏了年份，而是本机微信只留了这么多。 */}
            {years.length === 1 && (
              <span
                className={css.toolStatic}
                title={coverageHint ?? '本机已解密的聊天记录只覆盖这一年'}
              >
                {years[0]} 年{coverageHint ? ` · ${coverageHint}` : ' · 仅此一年'}
              </span>
            )}
            {years.length > 1 && (
              <select
                className={css.toolSelect}
                value={year ?? ''}
                onChange={(e) => { setYear(Number(e.target.value)) }}
                aria-label="选择年份"
              >
                {years.map(y => <option key={y} value={y}>{y} 年</option>)}
              </select>
            )}
            <button type="button" className={css.toolBtn} onClick={() => { void doExport() }} disabled={exportTask.running || year === null || !runtimeCapabilities().capturePanel} title="把年度回顾截成 PNG —— 截的是这台电脑上的这块屏">
              {exportTask.running ? '导出中…' : runtimeCapabilities().capturePanel ? '导出报告' : '导出报告（仅电脑）'}
            </button>
          </div>
        )}
      />
      <div className={`${kitCss.panelBody} ${css.scrollBody}`}>
        <ExportProgressStatus state={exportTask.state} />
        {error && <div className={kitCss.error} role="alert">{error}</div>}
        {/* 加载骨架屏：与真实卡片**同构**（同一个 12 列网格 + 同样的 span/rows 分布），
            加载完成时只有内容替换、没有布局跳变。见 `annual-skeleton.tsx` 的说明。 */}
        {!data && loading && <CardCanvasSkeleton year={year ?? 0} />}
        {!data && !loading && !error && (
          <div className={css.empty}>
            <EmptyState
              icon=""
              title={`${year ?? ''} 年没有可统计的消息`}
              desc="年度回顾只统计本机已解密的聊天库。换一个年份看看，或先在「软件设置 → 数据库密钥」完成解密。"
            />
          </div>
        )}
        {data && (
          <>
          {/* **整页只有一块画布**（2026-11-19）。改前是「首屏画布 + 折叠区画布」两块，
              中间夹一条折叠标题 —— 读起来像两篇文章，而用户要的是一条连续的年度回顾。
              现在 8 张核心卡在前、17 项明细在后，**同一条瀑布流**、同一套拖拽。
              顺序即「先放谁」，也是拖动前的阅读顺序。
              ⚠️ 卡片的 `canvasId` 是位置存储的键，**改名等于换了一张卡**（用户摆好的位置会丢）。 */}
          <CardCanvas year={data.year}>
            <HeroCard r={data} />
            <RhythmCard r={data} />
            <RankingCard r={data} av={av} />
            <GroupsCard r={data} av={av} />
            <MoneyCard r={data} />
            <MomentsCard r={data} />
            <MediaCallCard r={data} />
            <ExtremesCard r={data} />
            <MoreCards data={data} av={av} />
          </CardCanvas>
          {/* 页脚不在画布里：它是一整行文字，没有摆放的意义，放在整条瀑布流的收尾处。 */}
          <div className={css.footer}>
            <span>第一条 · {data.firstAt || '—'}</span>
            <span className={css.footerMid}>好好再说。没有哪种聊法是错的。</span>
            <span>最后一条 · {data.lastAt || '—'}</span>
          </div>
          </>
        )}
      </div>
    </div>
  )
}
