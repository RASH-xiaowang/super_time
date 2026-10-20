/**
 * 年度看板「更多」段的卡片（2026-09-30 从 `Annual.tsx` 拆出）。
 *
 * 拆的理由是**行数棘轮**：`Annual.tsx` 涨过 1000 行、`AnnualPanel` 涨过 250 行，
 * 两条闸门同时红。这一段的卡片加起来约 400 行，且与海报卡完全独立（它们用 `MoreCard`，
 * 不受一屏预算约束），所以整体搬出来最划算。
 */
import { useMemo } from 'react'
import type { AnnualReviewShape } from '../api.ts'
import type { NormalizedReview } from './annual-normalize.ts'
import type { CardTone } from './Annual.tsx'
import { fmtBytes } from '../utils/format.ts'
import { AVATAR_SIZE, Avatar, dur, fmt } from './annual-common.tsx'
import css from './annual.module.css'

/**
 * 第二段（「更多」长页）用的小卡片外壳。
 *
 * 与第一段海报的 `Card` 分开：海报卡在 12 列网格里、按 fr 行高压缩、`overflow:hidden` 兜底；
 * 这里按**自然高度**排布、不裁切（长页本来就滚动）。两块视觉语言一致（同标题 + 右上角附注）。
 *
 * `tone` 与海报卡的 `CardTone` 是**同一套语义色**（见 `Annual.tsx` 里 `CardTone` 的说明）：
 * 青=规模、紫=作息、粉=社交、绿=钱、琥珀=极值、蓝=媒体、红=撤回。
 * 两段共用一套 tone 名，用户扫视时颜色索引是连续的。
 *
 * 2026-10-17 第四次改：**高度随内容**（与海报卡同口径），不再有 `rows` 参数。
 */
export function MoreCard({ title, extra, zone, span = 4, tone = 'cyan', children }: {
  title: string
  /** 分区标签（社交互动 / 作息与习惯 / 财务与资产）—— 分区不再用横贯标题，改挂在卡上。 */
  zone?: string
  /** 跨列数（12 列基准）。默认 4 = 1/3 行；宽内容给 6，小卡给 3 —— 这些卡已在 `AnnualPanel` 里与海报卡交错混排，跨度要让整段**整除 12**。 */
  span?: number
  /** 语义色调（与海报卡同一套）。 */
  tone?: CardTone
  extra?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={css.moreCard}
      data-tone={tone}
      style={{ gridColumn: `span ${String(span)}` }}
    >
      <div className={css.moreCardHead}>
        <span className={css.moreCardTitle}>{title}</span>
        {zone ? <span className={css.zoneTag}>{zone}</span> : null}
        {extra ? <span className={css.moreCardExtra}>{extra}</span> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * 年度资金：全年转账 / 红包的笔数、总额、最大一笔与往来 TOP。
 *
 * 口径写清了两件事，避免被误读：**读不出金额的那笔不计入**（不许用 0 冒充一笔），
 * 以及"不是账单"——它只统计聊天里的转账/红包消息，不含支付账单或群收款之外的流水。
 */
export function MoneyCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const m = r.money
  return (
    <MoreCard span={3} tone="green" zone="财务与资产" title="年度资金" extra={m.count > 0 ? `${String(m.count)} 笔` : undefined}>
      {m.count === 0 ? (
        <div className={css.moreEmpty}>这一年聊天里没有可识别的转账 / 红包</div>
      ) : (
        <>
          <div className={css.moreRow}>
            <span>合计</span>
            <span className={css.moreNum}>¥{m.total.toFixed(2)}</span>
          </div>
          <div className={css.moreList}>
            <div className={css.moreRow}>
              <span>最大一笔</span>
              <span>¥{m.topAmount.toFixed(2)}{m.topPeerName ? ` · ${m.topPeerName}` : ''}</span>
            </div>
            {m.byPeer.slice(0, 5).map((p) => (
              <div key={p.username} className={css.moreRow}>
                <span>{p.name || p.username}</span>
                <span>¥{p.amount.toFixed(2)} · {String(p.count)} 笔</span>
              </div>
            ))}
          </div>
          <div className={css.moreSub}>口径：只统计聊天里的转账与红包，**不含理财、零钱通、提现与银行卡流水**；金额读不出来的那笔不计入，也不会当成 0 元。</div>
        </>
      )}
    </MoreCard>
  )
}

/**
 * 年度撤回：撤回条数、撤回最多的会话、最常撤回的时段。
 *
 * 时段用 24 桶的峰值表示，而不是画整张热力图 —— 这一块本来就是"看个大概"。
 */
export function RevokeCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const v = r.revoke
  const peak = v.byHour.reduce((best, n, h) => (n > v.byHour[best]! ? h : best), 0)
  return (
    <MoreCard span={4} tone="red" zone="作息与习惯" title="撤回与删除" extra={v.count > 0 ? `${String(v.count)} 条` : undefined}>
      {v.count === 0 ? (
        <div className={css.moreEmpty}>这一年没有识别到撤回</div>
      ) : (
        <div className={css.moreList}>
          <div className={css.moreRow}>
            <span>全年撤回</span>
            <span className={css.moreNum}>{String(v.count)}</span>
          </div>
          {v.topPeerName && (
            <div className={css.moreRow}>
              <span>撤回最多</span>
              <span>{v.topPeerName}</span>
            </div>
          )}
          <div className={css.moreRow}>
            <span>最常撤回的时段</span>
            <span>{String(peak)}:00 前后 · {String(v.byHour[peak] ?? 0)} 条</span>
          </div>
        </div>
      )}
    </MoreCard>
  )
}

/** 群聊年度：群消息总量、占全年比例、最活跃的群 TOP5。 */
export function GroupsCard({ r, av }: { r: AnnualReviewShape; av: Map<string, string | null> }): React.JSX.Element {
  const g = r.groups
  return (
    <MoreCard span={6} tone="pink" zone="社交互动" title="群聊年度" extra={g.messages > 0 ? `占全年 ${(g.share * 100).toFixed(1)}%` : undefined}>
      {g.top.length === 0 ? (
        <div className={css.moreEmpty}>这一年没有群聊消息</div>
      ) : (
        <>
          <div className={css.moreRow}>
            <span>群消息总量</span>
            <span className={css.moreNum}>{String(g.messages)}</span>
          </div>
          <div className={css.moreSub}>口径：**群里所有人**发出的消息都算（不只你发的）；「你发出」的占比见下方榜单。</div>
          <div className={css.moreList}>
            {g.top.slice(0, 5).map((c) => (
              <div key={c.username} className={css.moreRow}>
                <span className={css.moreRowName}>
                  <Avatar username={c.username} name={c.name} size={AVATAR_SIZE} src={av.get(c.username) ?? undefined} />
                  {c.name || c.username}
                </span>
                <span>{String(c.count)} 条</span>
              </div>
            ))}
          </div>
        </>
      )}
    </MoreCard>
  )
}

/**
 * 年度画像：把整年的数字压成**一两句人话**，放在「更多」段最前面。
 *
 * 为什么放最前：这一段其余全是数据卡，用户要先看结论、再看依据（网易云 / Spotify 年报的路子）。
 * **全部由已有字段推导**，不调用任何模型 —— 所以不会有"编出来的性格"，每句都能指到具体数字：
 *   · 深夜型 ← `rhythm.nightShare`（0–6 点占比）
 *   · 业务型 ← `money.total`（聊天里的转账/红包合计）
 *   · 话痨   ← `sentDailyAvg`（日均发出）
 *   · 口头禅 ← `catchphrase.phrase`
 * 指标不够就少说一句，不硬凑（凑出来就是假的人格）。
 */
export function YearPortrait({ r }: { r: NormalizedReview }): React.JSX.Element {
  const bits: string[] = []
  if (r.rhythm.nightShare >= 0.2) bits.push(`你是「深夜型选手」：${(r.rhythm.nightShare * 100).toFixed(1)}% 的消息发生在 0–6 点`)
  else if (r.rhythm.nightShare > 0 && r.rhythm.nightShare < 0.05) bits.push('你几乎不熬夜：0–6 点只占不到 5% 的消息')
  if (r.sentDailyAvg >= 80) bits.push(`日均发出 ${String(r.sentDailyAvg)} 条，是个话痨`)
  if (r.money.total >= 100000) bits.push(`聊天里的转账/红包合计 ¥${r.money.total.toFixed(0)} —— 这里头有大半是生意`)
  if (r.catchphrase.phrase) bits.push(`口头禅是「${r.catchphrase.phrase}」，说了 ${fmt(r.catchphrase.count)} 次`)
  if (r.buddy) bits.push(`今年最常聊的是 ${r.buddy.name}`)

  // 右侧关键指标：把画像里提到的数字**单独列出来**，让 6 列宽的卡片右侧不再空着
  // （2026-10-17：原先只有一段文字，右侧 60% 面积全空）。
  const stats: Array<{ k: string; v: string }> = [
    { k: '全年发出', v: `${fmt(r.sent)} 条` },
    { k: '日均', v: `${String(r.sentDailyAvg)} 条` },
    { k: '活跃天数', v: `${String(r.activeDaysMine)} 天` },
    { k: '最长连续', v: `${String(r.longestStreak)} 天` },
    { k: '深夜占比', v: `${(r.rhythm.nightShare * 100).toFixed(1)}%` },
    { k: '最常聊', v: r.buddy?.name ?? '—' },
  ]

  return (
    <div className={`${css.moreCard} ${css.portrait}`} data-tone="cyan" data-annual-portrait="">
      <div className={css.moreCardHead}>
        <span className={css.moreCardTitle}>{String(r.year)} 年度画像</span>
        <span className={css.moreCardExtra}>按本机数据推导 · 不含推测</span>
      </div>
      {bits.length === 0 ? (
        <div className={css.moreEmpty}>这一年数据太少，还画不出画像</div>
      ) : (
        <div className={css.portraitBody}>
          <p className={css.portraitText}>{bits.join('；')}。</p>
          <div className={css.portraitStats}>
            {stats.map((s) => (
              <div key={s.k} className={css.portraitStat}>
                <span className={css.portraitStatK}>{s.k}</span>
                <span className={css.portraitStatV} title={s.v}>{s.v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 月度趋势：把 `calendar`（逐日条数）就地聚合成 12 个月，画成柱状图。
 *
 * 为什么在前端聚合：`calendar` 本来就是后端已经发过来的全年逐日数据，
 * 再让后端为"月份合计"多跑一趟查询是白费（这一年逐日数据全在手上）。
 */
export function MonthlyTrendCard({ r }: { r: NormalizedReview }): React.JSX.Element {
  const months = useMemo(() => {
    const out = new Array<number>(12).fill(0)
    for (const c of r.calendar) {
      const m = Number(c.d.slice(5, 7)) - 1
      if (m >= 0 && m < 12) out[m] = (out[m] ?? 0) + c.n
    }
    return out
  }, [r.calendar])
  const max = Math.max(1, ...months)
  const total = months.reduce((a, b) => a + b, 0)
  const hottest = months.reduce((best, n, i) => (n > (months[best] ?? 0) ? i : best), 0)
  // 最低月只在**有消息的月份**里取：全 0 的月份（还没开始用/换号）不算"最低"。
  const active = months.map((n, i) => ({ n, i })).filter((m) => m.n > 0)
  const coldest = active.length > 0 ? active.reduce((best, m) => (m.n < best.n ? m : best)).i : 0
  return (
    <MoreCard span={6} tone="purple" zone="作息与习惯" title="月度趋势" extra={total > 0 ? `全年 ${fmt(total)} 条` : undefined}>
      {total === 0 ? (
        <div className={css.moreEmpty}>这一年还没有可统计的消息</div>
      ) : (
        <>
          <div className={css.moreBars}>
            {months.map((n, i) => (
              <div key={i} className={css.moreBarCol} title={`${String(i + 1)} 月 · ${fmt(n)} 条`}>
                <span className={`${css.moreBarFill}`} data-peak={(i === r.hottestMonth - 1) || undefined} style={{ height: `${String(Math.round((n / max) * 100))}%` }} />
                <span className={css.moreBarLabel}>{String(i + 1)}</span>
              </div>
            ))}
          </div>
          <div className={css.moreList}>
            <div className={css.moreRow}>
              <span>最热的一个月</span>
              <span>{String(r.hottestMonth)} 月 · {fmt(r.hottestMonthCount)} 条</span>
            </div>
            <div className={css.moreRow}>
              <span>最高 / 最低</span>
              <span>{String(hottest + 1)} 月 · {fmt(months[hottest] ?? 0)} / {String(coldest + 1)} 月 · {fmt(months[coldest] ?? 0)}</span>
            </div>
            <div className={css.moreSub}>柱子高度＝当月条数占全年最高月的比例；悬停任意一根看具体条数。</div>
          </div>
        </>
      )}
    </MoreCard>
  )
}

/**
 * 年度之最：把散在五张海报卡里的"极值"集中成一张速查卡。
 *
 * 这些数在后端都已经算好（`busiest` / `longestStreak` / `words` / `reply` / `rhythm`），
 * 只是原先藏在各自卡片的小字里 —— 汇总一处能一眼看完，不用来回找。
 */
export function ExtremesCard({ r }: { r: NormalizedReview }): React.JSX.Element {
  const items: Array<{ k: string; v: string }> = []
  if (r.busiest) items.push({ k: '消息最多的一天', v: `${r.busiest.date} · ${fmt(r.busiest.n)} 条` })
  if (r.longestStreak > 0) items.push({ k: '最长连续聊天', v: `${String(r.longestStreak)} 天` })
  if (r.longestSpanFrom && r.longestSpanTo) items.push({ k: '最长的一段', v: `${r.longestSpanFrom} → ${r.longestSpanTo}` })
  if (r.words.longestVoiceSec > 0) items.push({ k: '最长的一条语音', v: `${dur(r.words.longestVoiceSec)}${r.words.longestVoiceFrom ? ` · ${r.words.longestVoiceFrom}` : ''}` })
  if (r.reply.fastestName) items.push({ k: '回得最快', v: `${r.reply.fastestName} · ${dur(r.reply.fastestSec)}` })
  if (r.reply.slowestName) items.push({ k: '让 TA 等最久', v: `${r.reply.slowestName} · ${dur(r.reply.slowestSec)}` })
  items.push({ k: '最安静的时段', v: `${String(r.rhythm.quietestHour)}:00 · ${fmt(r.rhythm.quietestCount)} 条` })
  items.push({ k: '深夜占比', v: `${(r.rhythm.nightShare * 100).toFixed(1)}%` })
  if (r.lastText) items.push({ k: '最后一句', v: `${r.lastAt} · ${r.lastText}` })
  return (
    <MoreCard span={6} tone="amber" zone="作息与习惯" title="年度之最">
      <div className={css.moreList}>
        {items.map((it) => (
          <div key={it.k} className={css.moreRow}>
            <span>{it.k}</span>
            <span>{it.v}</span>
          </div>
        ))}
      </div>
    </MoreCard>
  )
}

/** 媒体与通话：把海报里挤在「你说的话」小字里的语音/通话/图片拆出来单独看。 */
export function MediaCallCard({ r }: { r: NormalizedReview }): React.JSX.Element {
  const w = r.words
  return (
    <MoreCard span={3} tone="blue" zone="社交互动" title="媒体与通话" extra={r.mediaSent > 0 ? `发出 ${fmt(r.mediaSent)} 条图片/视频` : undefined}>
      <div className={css.moreList}>
        <div className={css.moreRow}><span>图片 / 视频</span><span>{fmt(r.mediaSent)} 条（视频 {fmt(w.videoSent)}）</span></div>
        <div className={css.moreRow}><span>语音</span><span>发出 {fmt(w.voiceSentCount)} 条 · {dur(w.voiceSentSec)}</span></div>
        <div className={css.moreRow}><span>收到语音</span><span>{fmt(w.voiceRecvCount)} 条 · {dur(w.voiceRecvSec)}</span></div>
        <div className={css.moreRow}><span>通话</span><span>{fmt(w.callCount)} 通 · {dur(w.callSec)}</span></div>
        <div className={css.moreRow}><span>接通 / 未接</span><span>{fmt(w.callConnected)} / {fmt(w.callMissed)}</span></div>
        <div className={css.moreRow}><span>表情</span><span>甩出 {fmt(r.emoji.threw)} · 攒下 {fmt(r.emoji.kept)} 种</span></div>
      </div>
    </MoreCard>
  )
}

/** 口头禅 TOP10：海报上只有一排芯片，这里给出完整榜单与次数。 */
export function CatchphraseTopCard({ r }: { r: NormalizedReview }): React.JSX.Element {
  const top = r.catchphrase.top.slice(0, 10)
  return (
    <MoreCard span={4} tone="pink" zone="社交互动" title="口头禅 TOP10" extra={r.catchphrase.catchTotal > 0 ? `${fmt(r.catchphrase.catchTotal)} 句成了口头禅` : undefined}>
      {top.length === 0 ? (
        <div className={css.moreEmpty}>这一年还没有 2–8 字的整句口头禅</div>
      ) : (
        <div className={css.moreList}>
          {top.map((p) => (
            <div key={p.phrase} className={css.moreRow}>
              <span>{p.phrase}</span>
              <span>{fmt(p.count)} 次</span>
            </div>
          ))}
          <div className={css.moreSub}>统计口径：我发出的、2–8 字的**整句**（{fmt(r.catchphrase.shortTotal)} 句短表达里挑出来的）。</div>
        </div>
      )}
    </MoreCard>
  )
}

/**
 * 朋友圈年度（数据来自 sns.db，与聊天库不是同一个库）。
 *
 * `available === false` 时**必须**说"未读取到"，不能把 0 当真实值显示 ——
 * 那会让人以为"今年一条朋友圈都没发"，而实际只是这个库没解出来。
 */
export function MomentsCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const m = r.moments
  return (
    <MoreCard span={3} tone="pink" zone="社交互动" title="朋友圈年度" extra={m.available ? `${String(m.count)} 条` : undefined}>
      {!m.available ? (
        <div className={css.moreEmpty}>未读取到朋友圈数据（本机没有 sns.db 或尚未解密）</div>
      ) : m.count === 0 ? (
        <div className={css.moreEmpty}>这一年没有发过朋友圈</div>
      ) : (
        <>
          <div className={css.moreRow}>
            <span>全年条数</span>
            <span className={css.moreNum}>{String(m.count)}</span>
          </div>
          {m.topPost && (
            <div className={css.moreList}>
              <div className={css.moreRow}>
                <span>最热一条 · {m.topPost.at}</span>
                <span>赞 {String(m.topPost.likes)} · 评 {String(m.topPost.comments)}</span>
              </div>
              <div className={css.moreSub}>{m.topPost.excerpt}</div>
            </div>
          )}
          <div className={css.moreList}>
            {m.topMonth && (
              <div className={css.moreRow}>
                <span>发得最多的月份</span>
                <span>{String(m.topMonth.month)} 月 · {String(m.topMonth.count)} 条</span>
              </div>
            )}
            <div className={css.moreRow}>
              <span>深夜（0–6 点）发的</span>
              <span>{String(m.lateNight)} 条</span>
            </div>
          </div>
        </>
      )}
    </MoreCard>
  )
}

/**
 * 收藏与文件**总量盘点**。
 *
 * 标题就叫"总量盘点"：收藏表没有时间列、文件也不按年切，所以这两项**不能**说成年度数字
 * （说了就是编）。库没读到同样显示"未读取到"。
 */
export function AssetsCard({ r }: { r: AnnualReviewShape }): React.JSX.Element {
  const a = r.assets
  return (
    <MoreCard span={4} tone="green" zone="财务与资产" title="收藏与文件 · 总量盘点" extra={a.available ? undefined : '未读取到'}>
      {!a.available ? (
        <div className={css.moreEmpty}>未读取到收藏/文件数据（本机没有对应的库）</div>
      ) : (
        <div className={css.moreList}>
          <div className={css.moreRow}>
            <span>收藏</span>
            <span>{String(a.favorites)} 条</span>
          </div>
          <div className={css.moreRow}>
            <span>文件消息</span>
            <span>{String(a.files)} 条 · {fmtBytes(a.bytes)}</span>
          </div>
          <div className={css.moreRow}>
            <span>其中我发出</span>
            <span>{String(a.sentFiles)} 条</span>
          </div>
          <div className={css.moreSub}>收藏与文件没有可靠的按年时间列，所以这里给的是**至今总量**盘点，不随年份变化。</div>
        </div>
      )}
    </MoreCard>
  )
}


