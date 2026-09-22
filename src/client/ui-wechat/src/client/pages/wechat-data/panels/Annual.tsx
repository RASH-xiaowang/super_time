/**
 * 年度总结 · 年度回顾看板。
 *
 * 数据全部来自本机解密库（`getAnnualReview`），口径见后端 `query/annual-review.ts`：
 *   · 人物类指标（发出/排行/搭子/口头禅/回复速度/谁先开口）只算**我发出的**；
 *   · 规模类指标（日历热力/最疯的一天/作息切片）算**全部消息**。
 * 两类口径在看板上分别标注，避免「日均 28 条却有一天 2,218 条」这种无法解释的数字。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCapturePanel, apiGetAnnual, apiGetAnnualReview, apiGetAvatarsLocal, readRenderCache, writeRenderCache } from '../api.ts'
import type { AnnualReviewShape } from '../api.ts'
import { ListSkeleton } from './hooks.tsx'
import { PanelHeader } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './annual.module.css'
import { avatarColors } from '../utils/format.ts'

/** 千分位。 */
const fmt = (n: number): string => (Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0')
/** 秒 → 可读时长。 */
function dur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)}秒`
  if (sec < 3600) return `${Math.round(sec / 60)}分钟`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}小时`
  return `${Math.round(sec / 86400)}天`
}
/** 周一为首的行标签。 */
const DOW = ['一', '二', '三', '四', '五', '六', '日']
/** 数字 → 热力等级（0 不显示底色）。 */
function lv(n: number, t: [number, number, number, number]): string {
  if (n <= 0) return ''
  if (n <= t[0]) return '1'
  if (n <= t[1]) return '2'
  if (n <= t[2]) return '3'
  return '4'
}
/**
 * 按当年峰值自适应分档。
 * 固定阈值不行：总量 20 万条/年时，每一格都远超任何合理常数，热力图会变成一整块同色
 * （实测：日历 376 格里 300+ 是同一档），完全看不出疏密。改为按峰值取比例分档，
 * 不同体量的用户都能看到梯度。
 */
function adaptiveTiers(max: number): [number, number, number, number] {
  const m = Math.max(1, max)
  return [Math.max(1, Math.round(m * 0.1)), Math.round(m * 0.3), Math.round(m * 0.55), Math.round(m * 0.8)]
}

/** 圆形头像（拿不到真头像时用首字 + 稳定色）。 */
function Avatar({ username, name, size = 32, src }: { username: string; name: string; size?: number; src?: string }): React.JSX.Element {
  const c = avatarColors(username || name || '?')
  return (
    <span className={css.av} style={{ width: size, height: size, background: c.background, color: c.color, fontSize: Math.round(size * 0.42) }}>
      {src ? <img src={src} alt="" /> : (name || username || '?').slice(0, 1)}
    </span>
  )
}

/** 卡片外壳。`span` 是 12 列网格里的占列数（退化布局下忽略）。 */
function Card({ title, extra, span = 3, children }: {
  title: string; extra?: React.ReactNode; span?: number; children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={css.card} style={{ gridColumn: `span ${span}` }}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>{title}</span>
        {extra !== undefined && <span className={css.cardExtra}>{extra}</span>}
      </div>
      <div className={css.cardBody}>{children}</div>
    </section>
  )
}

/** ① 全年发出。 */
function HeroCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  return (
    <Card title="全年发出" extra={`发给 ${fmt(r.sentTo)} 个会话`}>
      <div className={css.heroNum}>{fmt(r.sent)}<small>条</small></div>
      <div className={css.heroSub}>平均每天 {r.sentDailyAvg} 条 · 一年就这样过去了。</div>
      <div className={css.heroGrid}>
        <div className={css.heroCell}><span className={css.heroCellK}>活跃</span><span className={css.heroCellV}>{r.activeDaysMine} 天</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>最长连续</span><span className={css.heroCellV}>{r.longestStreak} 天</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>新朋友</span><span className={css.heroCellV}>{r.newFriends} 位</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>图片视频</span><span className={css.heroCellV}>{fmt(r.mediaSent)} 条</span></div>
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
      span={6}
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

/** ③ 最疯的一天（全部消息口径）。 */
function BusiestCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const b = r.busiest
  if (!b) return <Card title="最疯的一天"><div className={css.sub}>这一年还没有消息</div></Card>
  return (
    <Card title="最疯的一天" extra={b.date}>
      <div className={css.bigDay}>
        <span className={css.bigDayNum}>{fmt(b.n)}</span>
        <span className={css.bigDayUnit}>条 · 日均的 {b.ratio} 倍 · 占全年全部消息 {(b.share * 100).toFixed(1)}%</span>
      </div>
      <div className={css.bar}><div className={css.barFill} style={{ width: `${Math.min(100, b.share * 100 * 2)}%` }} /></div>
      <div className={css.kv}><span>{b.topName || '—'}</span><b>{fmt(b.topCount)} 条</b></div>
      <div className={css.kv}><span>首句 → 末句</span><b>{dur(b.spanMin * 60)}</b></div>
      <div className={css.kv}><span>{b.firstAt} · {b.lastAt}</span></div>
      {/* 只留一句原文（两行截断）：卡片高度是固定的，两段引文会被裁掉 */}
      {b.firstText && <div className={css.quote}>{b.firstText.slice(0, 60)}</div>}
    </Card>
  )
}

/** ④ 年度搭子。 */
function BuddyCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element | null {
  const b = r.buddy
  if (!b) return null
  const total = Math.max(1, b.mine + b.theirs)
  return (
    <Card title="年度搭子" extra="今年话最多的一对">
      <div className={css.row}>
        <Avatar username={b.username} name={b.name} size={32} src={av.get(b.username) ?? undefined} />
        <div className={css.rowMain}>
          <div className={css.name}>{b.name}</div>
          <div className={css.sub}>{fmt(b.total)} 条 · 你发 {b.mine} / TA 发 {b.theirs}</div>
        </div>
      </div>
      <div className={css.bar}><div className={css.barFill} style={{ width: `${(b.mine / total) * 100}%` }} /></div>
      <div className={css.kv}><span>连续 / 常在</span><b>{b.streakDays} 天 · {String(b.commonHour).padStart(2, '0')}:00</b></div>
      <div className={css.kv}><span>接话</span><b>{fmt(b.replyBacks)} 次</b></div>
      <div className={css.kv}><span>最快 {dur(b.fastestSec)} 回 · 最慢等了 {dur(b.slowestSec)}</span></div>
    </Card>
  )
}

/** ⑤ 十二个月的主演。 */
function MonthlyStarCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  const byMonth = new Map(r.monthlyStar.map(x => [x.month, x]))
  const hot = r.hottestMonth
  return (
    <Card
      span={6}
      title="十二个月的主演"
      extra={r.starName ? `年度主演 ${r.starName} · ${r.starMonths} 个月` : ''}
    >
      <div className={css.starGrid}>
        {Array.from({ length: 12 }, (_, i) => {
          const m = i + 1
          const s = byMonth.get(m)
          return (
            <div key={m} className={`${css.starCell} ${m === hot ? css.starHot : ''}`}>
              <span className={css.starM}>{m}月</span>
              {s
                ? <Avatar username={s.username} name={s.name} size={30} src={av.get(s.username) ?? undefined} />
                : <span className={css.av} style={{ width: 30, height: 30, background: 'transparent', color: 'var(--nm-text-3)', fontSize: 14 }}>—</span>}
              <span className={css.sub} title={s?.name}>{s ? s.name : '—'}</span>
            </div>
          )
        })}
      </div>
      <div className={css.calFoot}>
        <span className={css.calLegend}>最热 {hot} 月 · {fmt(r.hottestMonthCount)} 条</span>
      </div>
    </Card>
  )
}

/** ⑥ 深夜。 */
function NightCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  const n = r.night
  return (
    <Card title="深夜" span={3} extra={`陪你完成 ${(n.share * 100).toFixed(1)}% 的深夜`}>
      <div className={css.nightTop}>
        <Avatar username={n.topName} name={n.topName} size={34} />
        <div className={css.rowMain}>
          <div className={css.name}>{n.topName || '—'}</div>
          <div className={css.sub}>0-6 点共 {fmt(n.topCount)} 条</div>
        </div>
      </div>
      <div className={css.kv}><span>你发出</span><b>{fmt(n.mine)} 条</b></div>
      <div className={css.kv}><span>对方发出</span><b>{fmt(n.theirs)} 条</b></div>
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
      span={6}
      title="作息切片"
      extra={`一周 168 格 · 共 ${fmt(r.rhythm.heat.reduce((a, n) => a + n, 0))} 条`}
    >
      <div>
        {DOW.map((d, w) => (
          <div key={d} className={css.rhythmRow}>
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
      <div className={css.calFoot}>
        <span className={css.calLegend}>最常亮 周{DOW[r.rhythm.brightestDow]} {String(r.rhythm.brightestHour).padStart(2, '0')}:00</span>
        <span className={css.calLegend}>最安静 {String(r.rhythm.quietestHour).padStart(2, '0')}:00 · 仅 {r.rhythm.quietestCount} 条</span>
        <span className={css.calLegend}>深夜指数 {(r.rhythm.nightShare * 100).toFixed(1)}% · 工作日:周末 {r.rhythm.workWeekendRatio}:1</span>
      </div>
    </Card>
  )
}

/** ⑧ 你说的话。 */
function WordsCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const w = r.words
  return (
    <Card title="你说的话" span={3} extra={`收到 ${fmt(w.receivedChars)} 字`}>
      <div className={css.bigDay}>
        <span className={css.bigDayNum}>{fmt(w.mineChars)}</span>
        <span className={css.bigDayUnit}>字</span>
      </div>
      {/* 最长语音原先是跨 3 列的第 7 格 —— 改成副标题，省下一行高度 */}
      <div className={css.heroSub}>最长一条语音 {w.longestVoiceSec > 0 ? `${w.longestVoiceSec} 秒 · 来自 ${w.longestVoiceFrom}` : '—'}</div>
      <div className={css.heroGrid} style={{ marginTop: 6 }}>
        <div className={css.heroCell}><span className={css.heroCellK}>敲字</span><span className={css.heroCellV}>{fmt(w.keystrokes)} 次</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>语音发出</span><span className={css.heroCellV}>{w.voiceSentCount} 条 · {dur(w.voiceSentSec)}</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>语音收到</span><span className={css.heroCellV}>{w.voiceRecvCount} 条 · {dur(w.voiceRecvSec)}</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>通话</span><span className={css.heroCellV}>{dur(w.callSec)} · {w.callCount} 通</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>接通 / 未接</span><span className={css.heroCellV}>{w.callConnected} · {w.callMissed}</span></div>
        <div className={css.heroCell}><span className={css.heroCellK}>视频 / 语音</span><span className={css.heroCellV}>{w.videoSent} / {w.voiceMsgSent}</span></div>
      </div>
    </Card>
  )
}

/** ⑨ 年度口头禅。 */
function CatchphraseCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const c = r.catchphrase
  return (
    <Card title="年度口头禅" span={3} extra={`${fmt(c.shortTotal)} 句短表达 · ${fmt(c.catchTotal)} 句成了口头禅`}>
      {c.phrase
        ? <div className={css.phraseHero}>“{c.phrase}”<span className={css.sub} style={{ marginLeft: 8 }}>说了 {c.count} 次</span></div>
        : <div className={css.sub}>还没有足够短的重复表达</div>}
      <div className={css.phraseList}>
        {c.top.slice(1).map(p => (
          <span key={p.phrase} className={css.chip}>{p.phrase} <b>{p.count}</b></span>
        ))}
      </div>
    </Card>
  )
}

/** ⑩ 回复速度。 */
function ReplyCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const p = r.reply
  return (
    <Card title="回复速度" span={4} extra="按「对方说 → 我回」的间隔统计">
      <div className={css.kv}><span>一半的消息，你在</span><b>{dur(p.medianSec)}内回了</b></div>
      <div className={css.kv}><span>九成在</span><b>{dur(p.p90Sec)}</b></div>
      {p.avgPartnerName && <div className={css.kv}><span>和 {p.avgPartnerName} 平均</span><b>{dur(p.avgPartnerSec)}</b></div>}
      <div className={css.kv}><span>最快回给 {p.fastestName || '—'}</span><b>{dur(p.fastestSec)}</b></div>
      <div className={css.kv}><span>最慢让 {p.slowestName || '—'} 等了</span><b>{dur(p.slowestSec)}</b></div>
    </Card>
  )
}

/** ⑪ 谁先开口。 */
function OpenerCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const o = r.opener
  return (
    <Card title="谁先开口" span={4} extra={`全年 ${fmt(o.mine + o.theirs)} 次对话`}>
      <div className={css.bigDay}>
        <span className={css.bigDayNum}>{(o.share * 100).toFixed(1)}%</span>
        <span className={css.bigDayUnit}>的对话由你先开口</span>
      </div>
      <div className={css.bar}><div className={css.barFill} style={{ width: `${o.share * 100}%` }} /></div>
      <div className={css.kv}><span>你先</span><b>{fmt(o.mine)} 次</b></div>
      <div className={css.kv}><span>TA 先</span><b>{fmt(o.theirs)} 次</b></div>
      <div className={css.kv}><span>你最主动找</span><b>{o.mostInitiatedByMe.map(x => `${x.name} ${x.count}`).join(' / ') || '—'}</b></div>
      <div className={css.kv}><span>最主动来找你</span><b>{o.mostInitiatedByThem.map(x => `${x.name} ${x.count}`).join(' / ') || '—'}</b></div>
    </Card>
  )
}

/** ⑫ 年度聊天排行。 */
function RankingCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  return (
    <Card title="年度聊天排行" span={4} extra="你发 | TA 发">
      {r.ranking.length === 0 && <div className={css.sub}>暂无单聊记录</div>}
      {/* 一屏只放前 5：卡片行高固定，10 行会撑破并被裁掉 */}
      {r.ranking.slice(0, 5).map((row, i) => (
        <div key={row.username} className={css.rankRow}>
          <span className={css.rankNo}>{i + 1}</span>
          <Avatar username={row.username} name={row.name} size={24} src={av.get(row.username) ?? undefined} />
          <div className={css.rowMain}><div className={css.name}>{row.name}</div></div>
          <span className={css.rankVal} title={`你发 ${row.mine} / TA 发 ${row.theirs}`}>{fmt(row.total)}</span>
        </div>
      ))}
    </Card>
  )
}

/** ⑬ 表情宇宙。 */
function EmojiCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const e = r.emoji
  return (
    <Card title="表情宇宙" span={4} extra={e.threw > 0 ? `出没 ${e.days} 天` : ''}>
      <div className={css.kv}><span>甩出</span><b>{fmt(e.threw)} 张</b></div>
      <div className={css.kv}><span>攒下</span><b>{fmt(e.kept)} 种</b></div>
      <div className={css.kv}><span>均匀</span><b>{e.perDay} 张 / 天</b></div>
      {e.peakCount > 0 && <div className={css.kv}><span>最密集</span><b>周{DOW[e.peakDow]} {String(e.peakHour).padStart(2, '0')}:00</b></div>}
      <div className={css.emojiTop}>
        {e.top.map(x => <span key={x.emoji} className={css.emojiCell}><span style={{ fontSize: 16 }}>{x.emoji}</span>×{x.count}</span>)}
      </div>
    </Card>
  )
}

/** ⑭ 还有这些人。 */
function HighlightsCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element | null {
  if (r.highlights.length === 0) return null
  return (
    <Card title="还有这些人" span={8}>
      {/* 单行 7 格、横向小卡（头像 + 说明列）：一屏内放得下，不用横向滚动 */}
      <div className={css.moreRow}>
        {r.highlights.map((h, i) => (
          <div key={`${h.label}-${i}`} className={css.moreCell}>
            <Avatar username={h.username} name={h.name} size={26} src={av.get(h.username) ?? undefined} />
            <div className={css.moreInfo}>
              <span className={css.moreLabel}>{h.label}</span>
              <span className={css.name} title={h.name}>{h.name}</span>
              <span className={css.moreVal}>{h.value}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/**
 * Render the annual review dashboard.
 * @returns the annual panel element tree.
 */
export function AnnualPanel(): React.JSX.Element {
  const [years, setYears] = useState<readonly number[]>([])
  const [year, setYear] = useState<number | null>(null)
  const [data, setData] = useState<AnnualReviewShape | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [av, setAv] = useState<Map<string, string | null>>(new Map())
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
  /** 面板根节点：导出时量它的矩形做截图（含标题栏/工具栏/页脚，不含左侧导航与顶部栏）。 */
  const shellRef = useRef<HTMLDivElement | null>(null)
  /** 海报区（放 12 列网格的容器）：用它判断"一屏海报"到底装不装得下。 */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /**
   * 是否退化成「瀑布流 + 滚动」。
   *
   * 为什么需要这个状态位：CSS 里的回退条件是 `@media (max-width:1200px), (max-height:779px)`，
   * 而 media query 看的是**视口**高度（本机 900px），真正被压缩的是**面板**高度
   * （1440×900 下只剩约 700px）—— 于是海报模式照常启用，9 张卡片各自
   * `overflow:hidden` 把 20–30% 文字切掉（实测「全年发出」128px 装 160px 的内容）。
   * 这里改成按**卡片是否真的被切**来判定：宁可多一次布局，也不要把内容藏起来。
   */
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !data) return
    const check = (): void => {
      const wrap = el.querySelector('[class*=wrap]')
      if (!wrap) return
      const clipped = [...wrap.querySelectorAll('[class*=card]')]
        .some((c) => c.scrollHeight > c.clientHeight + 8)
      // 进入条件：有卡片被切；退出条件：容器已经高到按设计能一屏装下（留 hysteresis 防抖）
      setCompact((prev) => (clipped ? true : (prev && el.clientHeight < 900)))
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [data])

  const loadYears = useCallback(async (): Promise<void> => {
    try {
      const env = await apiGetAnnual()
      const ys = env.years.filter(n => Number.isFinite(n) && n > 2000)
      setYears(ys)
      setYear(prev => prev ?? ys.at(-1) ?? new Date().getFullYear())
    } catch (e) {
      setError((e as Error).message)
      setYear(prev => prev ?? new Date().getFullYear())
    }
  }, [])

  useEffect(() => { void loadYears() }, [loadYears])

  const load = useCallback(async (y: number): Promise<void> => {
    setLoading(true)
    setError(null)
    // 先出缓存秒开（首次扫描要逐条读一年消息，较慢）
    const cached = readRenderCache<AnnualReviewShape>('annual-review:' + y)
    if (cached) setData(cached)
    try {
      const r = await apiGetAnnualReview(y)
      setData(r)
      writeRenderCache('annual-review:' + y, r)
    } catch (e) {
      if (!cached) setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (year !== null) void load(year) }, [year, load])

  // 头像批量拉取（一次 Remote，避免每张卡片各拉一遍）
  useEffect(() => {
    if (!data) return
    const users = [...new Set([
      ...data.ranking.map(x => x.username),
      ...data.monthlyStar.map(x => x.username),
      ...(data.buddy ? [data.buddy.username] : []),
      ...(data.starUsername ? [data.starUsername] : []),
      ...data.highlights.map(x => x.username),
    ].filter(Boolean))].slice(0, 60)
    if (users.length === 0) return
    void apiGetAvatarsLocal({ usernames: users })
      .then((map) => { setAv(new Map(Object.entries(map).filter(([, v]) => typeof v === 'string'))) })
      .catch(() => { /* 拿不到头像就退回首字占位 */ })
  }, [data])

  const doExport = useCallback(async (): Promise<void> => {
    if (year === null || exporting) return
    const el = shellRef.current
    if (!el) { setExportMsg('导出失败：找不到面板'); return }
    setExporting(true)
    setExportMsg('')
    try {
      // 所见即所存：直接量面板矩形的 CSS 像素坐标交给主进程 capturePage，
      // 不另写报告模板 —— 导出的 PNG 与界面逐像素一致。
      const r = el.getBoundingClientRect()
      const res = await apiCapturePanel({
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        filename: `微信年度报告-${year}.png`,
      })
      if (!res.ok) setExportMsg('导出失败：' + (res.message || '未知错误'))
      else if (res.canceled) setExportMsg('已取消导出')
      else setExportMsg(`已导出 PNG（${res.width}×${res.height}）→ ${res.path}`)
    } catch (e) {
      setExportMsg('导出失败：' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }, [year, exporting])

  return (
    <div className={kitCss.panelShell} ref={shellRef}>
      <PanelHeader
        title="年度报告"
        desc="本机聊天记录的年度回顾 · 人物类指标只统计「我发出的」"
        actions={(
          <div className={css.tools}>
            {years.length > 0 && (
              <select
                className={css.toolSelect}
                value={year ?? ''}
                onChange={(e) => { setYear(Number(e.target.value)) }}
                aria-label="选择年份"
              >
                {years.map(y => <option key={y} value={y}>{y} 年</option>)}
              </select>
            )}
            <button type="button" className={css.toolBtn} onClick={() => { void doExport() }} disabled={exporting || year === null} title="把年度回顾导出为 HTML 文件">
              {exporting ? '导出中…' : '导出报告'}
            </button>
          </div>
        )}
      />
      <div ref={bodyRef} className={`${kitCss.panelBody} ${css.scrollBody}`}>
        {exportMsg && <div className={css.hint}>{exportMsg}</div>}
        {error && <div className={kitCss.error} role="alert">{error}</div>}
        {!data && loading && <ListSkeleton rows={6} />}
        {!data && !loading && !error && <div className={css.empty}>这一年还没有可统计的消息。</div>}
        {data && (
          /* 固定 12 列网格：5 行内容 + 1 行页脚，总高恒等于容器高 → 一屏无滚动。             窄窗/矮窗由 CSS 媒体查询退回「瀑布流 + 滚动」。 */
          <div className={css.wrap} data-loading={loading || undefined} data-compact={compact || undefined}>
            <HeroCard r={data} />
            <CalendarCard r={data} />
            <BusiestCard r={data} />
            <BuddyCard r={data} av={av} />
            <MonthlyStarCard r={data} av={av} />
            <NightCard r={data} av={av} />
            <RhythmCard r={data} />
            <WordsCard r={data} />
            <CatchphraseCard r={data} />
            <ReplyCard r={data} />
            <OpenerCard r={data} />
            <RankingCard r={data} av={av} />
            <EmojiCard r={data} />
            <HighlightsCard r={data} av={av} />
            <div className={css.footer}>
              <span>第一条 · {data.firstAt || '—'}</span>
              <span className={css.footerMid}>好好再说。没有哪种聊法是错的。</span>
              <span>最后一条 · {data.lastAt || '—'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
