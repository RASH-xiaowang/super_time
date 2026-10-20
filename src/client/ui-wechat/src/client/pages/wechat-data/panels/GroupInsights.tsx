/**
 * 群聊分析 · 洞察 — 选择群聊后展示总量/活跃天数/人均/群公告/成员发言排行。
 * 全部基于本机解密库离线统计。
 *
 * 2026-10-19 微信化：不再单独画页头，与「监控」视图共用 36px 工具行（群选择器 + 刷新）；
 * 指标带改中性色、排行条改微信绿单色；去掉 emoji 与重复的跳转动作。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetGroupInsights, apiGetSessions, readRenderCache, writeRenderCache } from '../api.ts'
import type { GroupInsightsSnapshot, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, Select } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './group-insights.module.css'
import { fmtDateTimeSec } from '../utils/format.ts'
import { ListSkeleton, useElapsedSeconds, useWechatDataUpdated } from './hooks.tsx'
import { WordCloudCard } from './WordCloudCard.tsx'

function fmtTs(ts?: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Render the offline group insights panel.
 * @param props - optional chat navigation callback (kept for parity with the monitor view).
 * @returns the insights element tree.
 */
export function GroupInsightsPanel({
  onOpenChat: _onOpenChat,
  onNavigate: _onNavigate,
}: { onOpenChat?: (username: string) => void; onNavigate?: (tab: string) => void } = {}): React.JSX.Element {
  const [groups, setGroups] = useState<readonly WechatSession[]>([])
  const [username, setUsername] = useState('')
  const [data, setData] = useState<GroupInsightsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 刷新计数：和选择群一起作为取数 effect 的依赖。 */
  const [reloadNonce, setReloadNonce] = useState(0)
  // 首次统计走秒（口径见 hooks.tsx#useElapsedSeconds）
  const elapsed = useElapsedSeconds(loading && data === null)

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      const env = await apiGetSessions({ limit: 500 })
      const gs = env.sessions.filter(s => s.username.endsWith('@chatroom') || s.type === 'group')
      setGroups(gs)
      /*
       * 默认选中：上次看过的群 → 否则第一个群（第 61 轮恢复自动选中）。
       *
       * 这里原本写着「由用户点选后才按需计算」—— 那是当时的选择，理由是「全量统计很贵」。
       * 第 61 轮实测单群 `getGroupInsights` 只要 **8–18ms**（在 52 个群里抽第 0/4/19 个：
       * 14ms / 8ms / 18ms，各自返回 968 / 474 / 2080 条消息的统计），
       * 于是「打开面板一片空白、要用户先猜着点一个群」反而是更差的选择。
       * 用 `prev || …` 而不是直接赋值：重载群列表时不能把用户已经选的群顶掉。
       */
      setUsername(prev => prev || readRenderCache<string>('group-insights:selected') || (gs[0]?.username ?? ''))
    } catch {
      /* keep */
    }
  }, [])

  useEffect(() => { void loadGroups() }, [loadGroups])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费。
  useWechatDataUpdated(() => { if (groups.length === 0) void loadGroups() })

  useEffect(() => {
    if (!username) return
    let alive = true
    setLoading(true)
    setError(null)
    const cached = readRenderCache<GroupInsightsSnapshot>('group-insights:' + username)
    if (cached) { setData(cached); setLoading(false) }
    void apiGetGroupInsights(username)
      .then((r) => {
        if (!alive) return
        setData(r)
        writeRenderCache('group-insights:' + username, r)
      })
      .catch((e: unknown) => { if (alive && !cached) setError((e as Error).message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [username, reloadNonce])

  /** 第一名条数（条宽按它归一，让「相对差距」看得出来）。 */
  const maxCount = data && data.topMembers.length > 0 ? Math.max(...data.topMembers.map(m => m.count)) : 1

  return (
    <div className={kitCss.panelShell}>
      <GroupToolRow
        title="洞察"
        selector={(
          <Select
            value={username}
            onChange={(v) => {
              setUsername(v)
              // 记住选择：下次打开这个面板直接回到同一个群（没有记忆时回落到第一个群）
              writeRenderCache('group-insights:selected', v)
            }}
            options={groups.map(g => ({ value: g.username, label: g.displayName || g.username }))}
            placeholder="选择群聊…"
            ariaLabel="选择群聊"
          />
        )}
        refreshing={loading}
        onRefresh={() => { setReloadNonce(n => n + 1) }}
      />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {/* 首次统计：走秒 + 骨架（原来是干等一行「统计中…」）。 */}
      {loading && (
        <>
          <div className={kitCss.emptyInline}>
            {`正在统计群聊洞察…已用 ${elapsed}s · 首次统计要逐条扫这个群的消息与公告，请稍候`}
          </div>
          <ListSkeleton rows={6} grid minCol={200} />
          <ListSkeleton rows={4} />
        </>
      )}
      {!loading && !data && !error && !username && <div className={kitCss.emptyInline}>请在上方选择群聊后查看洞察</div>}

      {data && !loading && (
        <>
          {/* 指标带：6 个数字压成一条横排，把纵向空间让给排行与热词。 */}
          <div className={css.metrics}>
            <Metric label="成员" value={String(data.memberCount)} />
            <Metric label="消息总数" value={data.total.toLocaleString()} />
            <Metric label="活跃天数" value={String(data.activeDays)} />
            <Metric label="日均" value={data.avgPerDay.toFixed(1)} />
            <Metric label="首次" value={fmtTs(data.from)} />
            <Metric label="最近" value={fmtTs(data.to)} />
          </div>

          {/* 群公告横跨整行、放在排行与热词**上方**（2026-10-17 用户要求）：
              公告是「这个群现在在做什么」的背景信息，先读它再看谁在说话、在说什么。 */}
          <Card
            title="群公告"
            extra={data.announcement && data.announcementTime
              ? <span className={kitCss.textCaption}>{`发布于 ${fmtDateTimeSec(data.announcementTime)}`}</span>
              : undefined}
          >
            {data.announcement ? (
              <div className={css.announcement}>{data.announcement}</div>
            ) : (
              <div className={css.empty}>
                <span>暂无群公告</span>
                <span className={css.emptyHint}>
                  公告来自微信的群资料，本机实测约六分之一的群有公告，多数群从没发过；
                  也可能是你入群之前的公告没有同步到本机
                </span>
              </div>
            )}
          </Card>

          <div className={css.cols}>
            <div className={css.col}>
              <Card
                title="成员发言排行"
                className={css.fillCard}
                extra={<span className={kitCss.textCaption}>{`Top ${String(data.topMembers.length)}`}</span>}
              >
                {data.topMembers.length === 0 ? (
                  <div className={css.empty}>
                    <span>暂无成员发言数据</span>
                    <span className={css.emptyHint}>这个群在本机解密库里没有可归属到具体成员的消息</span>
                  </div>
                ) : (
                  <div className={css.rankList}>
                    {data.topMembers.map((m, i) => {
                      /*
                       * 条宽与数字**各司其职**（2026-10-17 用户截图「占比要设置好」）：
                       *
                       * · **条宽按第一名归一** —— 条是「相对差距」的视觉编码，第一名占满整行
                       *   才能一眼看出「谁是这个群的主力」。按总量算的话第一名只有 35.5%，
                       *   条只占轨道 1/3，整列看起来像「大家都很低」（真机实测）。
                       * · **数字显示占群总量的百分比** —— 那才是「这个人说了多少」的绝对量。
                       *   两者一起给，读者既能看到差距，也能看到绝对占比。
                       *
                       * 下限 2%：末位 1.3% 在 515px 轨道上只有 6.7px，肉眼几乎看不见 ——
                       * 给一个可见的最小宽度，数字仍显示真实值（不撒谎）。
                       */
                      const pct = data.total > 0 ? (m.count / data.total) * 100 : 0
                      const barW = Math.max(2, Math.min(100, (m.count / maxCount) * 100))
                      return (
                        <div key={m.username} className={css.rankRow} data-top={i < 3 || undefined}>
                          <span className={css.rankNo}>{String(i + 1)}</span>
                          <div className={css.rankBody}>
                            <div className={css.rankHead}>
                              <span className={css.rankName} title={m.name}>{m.name}</span>
                              <span className={css.rankCount}>
                                <span className={css.rankPct}>{`${pct.toFixed(1)}%`}</span>
                                {`${m.count.toLocaleString()} 条`}
                              </span>
                            </div>
                            <div className={css.rankTrack}>
                              <div className={css.rankFill} style={{ width: `${String(barW)}%` }} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            </div>

            <div className={css.col}>
              <WordCloudCard scope="chat" username={data.username} fill />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 指标带里的一格：标签在上、数值在下（比 StatCard 矮一半，6 个并排也不挤）。 */
function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={css.metric}>
      <span className={css.metricLabel}>{label}</span>
      <span className={css.metricValue}>{value}</span>
    </div>
  )
}

/**
 * 群聊分析两视图（洞察 / 监控）共用的 36px 工具行：标题 + 群选择器 +（可选扩展）+ 刷新。
 *
 * 为什么写在本文件：两个视图要**同一份** DOM 与 CSS，各画一套会让「切换视图时布局跳变」
 * 重新出现；task-7 的写权限覆盖这两个文件，不需要进 kit。
 * @param props.title - 视图名（洞察 / 监控）。
 * @param props.selector - 群选择器节点。
 * @param props.extra - 监控页的自动刷新开关等额外控件。
 * @param props.refreshing - 是否正在刷新（刷新按钮禁用）。
 * @param props.onRefresh - 刷新动作。
 * @returns 工具行元素。
 */
export function GroupToolRow({ title, selector, extra, refreshing, onRefresh }: {
  title: string
  selector: React.ReactNode
  extra?: React.ReactNode
  refreshing: boolean
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <div className={css.toolRow}>
      <span className={css.toolTitle}>{title}</span>
      <span className={css.toolSpacer} />
      {selector}
      {extra}
      <button type="button" className={css.toolBtn} onClick={onRefresh} disabled={refreshing}>
        {refreshing ? '刷新中…' : '刷新'}
      </button>
    </div>
  )
}
