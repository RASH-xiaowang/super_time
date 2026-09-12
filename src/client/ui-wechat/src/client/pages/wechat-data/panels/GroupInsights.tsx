/**
 * 群聊离线洞察面板 — 选择群聊后展示总量/活跃天数/人均/群公告/成员发言排行。
 * 全部基于本机解密库离线统计。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetGroupInsights, apiGetSessions, readRenderCache, writeRenderCache } from '../api.ts'
import type { GroupInsightsSnapshot, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, PanelHeader, Select, StatCard, StatGrid } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './group-insights.module.css'
import { fmtDateTimeSec } from '../utils/format.ts'
import { useWechatDataUpdated } from './hooks.tsx'

function fmtTs(ts?: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Render the offline group insights panel.
 * @param props - optional chat navigation + tab navigation callbacks.
 * @returns the insights element tree.
 */
export function GroupInsightsPanel({
  onOpenChat,
  onNavigate,
}: { onOpenChat?: (username: string) => void; onNavigate?: (tab: string) => void } = {}): React.JSX.Element {
  const [groups, setGroups] = useState<readonly WechatSession[]>([])
  const [username, setUsername] = useState('')
  const [data, setData] = useState<GroupInsightsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
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
  }, [username])

  const maxCount = data && data.topMembers.length > 0 ? Math.max(...data.topMembers.map(m => m.count)) : 1

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="群聊离线洞察"
        desc="总量/活跃天数/群公告/成员发言排行 · 仅本地计算"
        actions={(
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
      />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && <div className={kitCss.emptyInline}>统计中…</div>}
      {!loading && !data && !error && !username && <div className={kitCss.emptyInline}>请选择上方群聊后查看洞察</div>}

      {data && !loading && (
        <>
          <StatGrid>
            <StatCard icon="👥" value={data.memberCount} label="成员" />
            <StatCard icon="💬" value={data.total.toLocaleString()} label="消息总数" tone="purple" />
            <StatCard icon="📅" value={data.activeDays} label="活跃天数" tone="green" />
            <StatCard icon="⚖️" value={data.avgPerDay.toFixed(1)} label="日均" tone="blue" />
            <StatCard icon="🕐" value={fmtTs(data.from)} label="首次" tone="amber" />
            <StatCard icon="🕑" value={fmtTs(data.to)} label="最近" />
          </StatGrid>

          {(onOpenChat || onNavigate) && (
            <div className={css.actions}>
              {onOpenChat && <Button variant="pill" onClick={() => { onOpenChat(data.username) }}>打开完整会话</Button>}
              {onNavigate && <Button variant="pill" onClick={() => { onNavigate('monitor') }}>群聊活跃监控</Button>}
              {onNavigate && <Button variant="pill" onClick={() => { onNavigate('contacts') }}>通讯录管理</Button>}
            </div>
          )}

          <div className={kitCss.cardGrid}>
            <Card title={`成员发言排行 Top ${data.topMembers.length}`}>
              {data.topMembers.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无成员发言数据</div>
              ) : (
                <div className={css.bars}>
                  {data.topMembers.map(m => (
                    <div key={m.username} className={css.barRow}>
                      <span className={css.barName}>{m.name}</span>
                      <div className={css.barTrack}>
                        <div className={css.barFill} style={{ width: `${Math.round((m.count / maxCount) * 100)}%` }} />
                      </div>
                      <span className={css.barCount}>{m.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="群公告"
              extra={data.announcement && data.announcementTime
                ? <span className={kitCss.textCaption}>发布于 {fmtDateTimeSec(data.announcementTime)}</span>
                : undefined}
            >
              {/*
               * 第 66 轮补上发布时间：后端 `GroupInsightsSnapshot.announcementTime` 一直在给
               * （来自 `chat_room_info_detail.announcement_publish_time_`，实测本机 53 个群里 8 个有公告，
               * 时间跨度 2020-09 ~ 2026-09），但界面从来没渲染过。公告的「新旧」直接决定它还算不算数，
               * 「发布于 …」是这条数据最该配套展示的信息。
               */}
              {data.announcement ? (
                <div className={css.announcement}>{data.announcement}</div>
              ) : (
                <div className={kitCss.emptyInline}>暂无群公告</div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

