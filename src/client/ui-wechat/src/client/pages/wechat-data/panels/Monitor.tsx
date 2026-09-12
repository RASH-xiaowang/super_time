/**
 * 群监控面板 — 只读实时监控仪表盘：群热度、今日/当月消息、近期消息流
 * （会话/日历/消息 Remote 轮询，无需原生 Hook；自动刷新可开关）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {ListSkeleton, useWechatDataUpdated } from './hooks.tsx'
import { apiGetDailyCounts, apiGetMessages, apiGetSessions, readRenderCache, writeRenderCache } from '../api.ts'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './monitor.module.css'
import { fmtDateTimeSec } from '../utils/format.ts'

const REFRESH_VISIBLE_MS = 3000
const REFRESH_HIDDEN_MS = 10_000
const HEAT_DAYS = 14

/**
 * Render the group monitor dashboard.
 * @param props - optional chat navigation callback (message click jumps there).
 * @returns the monitor element tree.
 */
export function MonitorPanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  const [groups, setGroups] = useState<WechatSession[]>([])
  const [selected, setSelected] = useState('')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [messages, setMessages] = useState<WechatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const selectedRef = useRef('')

  const loadGroups = useCallback(async (): Promise<void> => {
    try {
      const env = await apiGetSessions({ limit: 500 })
      const gs = env.sessions.filter(s => s.type === 'group')
      setGroups(gs)
      /*
       * 默认选中：上次看过的群 → 否则第一个群（第 61 轮恢复自动选中）。
       * 原注释写「不自动选中…由用户点击后再按需加载」，但单群负载只是
       * 「本月日历 + 最近 12 条消息」两次并行请求（与面板首屏同量级），
       * 而空面板要多一次点击才看得到东西。`prev || …` 保证不会顶掉用户已选的群。
       */
      setSelected(prev => prev || readRenderCache<string>('monitor:selected') || (gs[0]?.username ?? ''))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const loadGroup = useCallback(async (username: string): Promise<void> => {
    if (!username) return
    setLoading(true)
    setError(null)
    try {
      // 先用上次渲染的日历 + 消息缓存,后台再同步
      const cached = readRenderCache<{ counts: Record<string, number>; messages: WechatMessage[] }>('monitor:' + username)
      if (cached) {
        setCounts(cached.counts)
        setMessages(cached.messages)
        setLoading(false)
      }
      const now = new Date()
      const year = now.getFullYear()
      const month = now.getMonth() + 1
      const [cal, msgs] = await Promise.all([
        apiGetDailyCounts({ username, year, month }),
        apiGetMessages({ talker: username, limit: 12 }),
      ])
      // A stale response must never overwrite the currently selected group.
      if (selectedRef.current !== username) return
      setCounts(cal.counts)
      setMessages(msgs.messages)
      writeRenderCache('monitor:' + username, { counts: cal.counts, messages: msgs.messages })
    } catch (e) {
      if (selectedRef.current === username) setError((e as Error).message)
    } finally {
      if (selectedRef.current === username) setLoading(false)
    }
  }, [])

  useEffect(() => { void loadGroups() }, [loadGroups])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (groups.length === 0) void loadGroups() })
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { if (selected) void loadGroup(selected) }, [selected, loadGroup])

  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    const start = (): void => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      if (!auto || !selected) return
      const ms = document.visibilityState === 'visible' ? REFRESH_VISIBLE_MS : REFRESH_HIDDEN_MS
      timerRef.current = setInterval(() => { void loadGroup(selected) }, ms)
    }
    start()
    const onVis = (): void => { void loadGroup(selected); start() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [auto, selected, loadGroup])

  // Host push: the realtime sync decrypted a WAL increment into the snapshot —
  // refresh the selected group (and the roster) immediately, independent of the
  // auto poll, so fresh counts/messages appear without waiting for the interval.
  useEffect(() => {
    const onUpdated = (): void => {
      void loadGroups()
      if (selectedRef.current) void loadGroup(selectedRef.current)
    }
    window.addEventListener('dsh-wechat-data-updated', onUpdated)
    return () => { window.removeEventListener('dsh-wechat-data-updated', onUpdated) }
  }, [loadGroups, loadGroup])

  const monthTotal = Object.values(counts).reduce((a, b) => a + b, 0)
  const activeDays = Object.values(counts).filter(n => n > 0).length
  const now = new Date()
  const todayKey = String(now.getDate())
  const todayCount = counts[todayKey] ?? 0

  const heat: Array<{ d: number; c: number; isToday: boolean }> = []
  const today = now.getDate()
  for (let i = Math.max(1, today - HEAT_DAYS + 1); i <= today; i++) {
    heat.push({ d: i, c: counts[String(i)] ?? 0, isToday: i === today })
  }
  const heatMax = Math.max(1, ...heat.map(h => h.c))
  const selGroup = groups.find(g => g.username === selected)

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="群活跃监控"
        desc={`只读仪表盘 · 自动刷新 ${auto ? '开' : '关'}`}
        actions={(
          <>
            <button type="button" className={css.chip} data-on={auto || undefined} onClick={() => { setAuto(v => !v) }}>{auto ? '⏸ 暂停轮询' : '▶ 自动刷新'}</button>
            <button type="button" className={css.chip} onClick={() => { if (selected) void loadGroup(selected) }} disabled={loading}>刷新</button>
          </>
        )}
      />
      <StatGrid>
        <StatCard icon="👥" value={groups.length} label="群" />
        <StatCard icon="📅" value={`${todayCount} 条`} label="今日" tone="green" />
        <StatCard icon="🗓️" value={`${monthTotal} 条`} label="本月" tone="blue" />
        <StatCard icon="🔥" value={`${activeDays} 天`} label="活跃" tone="amber" />
      </StatGrid>
      <div className={css.chipRow}>
        {groups.map(g => (
          <button
            type="button"
            key={g.username}
            className={css.chip}
            data-on={selected === g.username || undefined}
            onClick={() => { setSelected(g.username); writeRenderCache('monitor:selected', g.username) }}
          >
            {g.displayName}
          </button>
        ))}
        {groups.length === 0 && <span className={css.note}>暂无群聊会话</span>}
        {groups.length > 0 && !selected && <span className={css.note}>点击上方群聊查看监控</span>}
      </div>
      {error && <div className={css.note}>⚠️ {error}</div>}
      <div className={kitCss.cardGrid}>
        <Card title={`${selGroup ? selGroup.displayName : '群'} · 近 ${String(HEAT_DAYS)} 天消息热力`}>
          <div className={css.heatWrap}>
            {heat.map(h => (
              <div key={String(h.d)} className={css.heatCol} title={'Day ' + String(h.d) + ': ' + String(h.c) + ' 条'}>
                <span className={css.heatValue}>{h.c > 0 ? String(h.c) : ''}</span>
                <div className={css.heatTrack}>
                  <div className={css.heatBar} data-today={h.isToday || undefined} style={{ height: String(Math.max(3, Math.round((h.c / heatMax) * 100))) + '%' }} />
                </div>
                <span className={css.heatLabel}>{String(h.d)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card
          title="近期消息"
          extra={selGroup ? (
            <button type="button" className={css.chip} onClick={() => { onOpenChat?.(selGroup.username) }} disabled={!onOpenChat}>
              打开完整会话
            </button>
          ) : undefined}
        >
          <div className={css.msgList}>
            {messages.map(m => (
              <button
                key={String(m.localId)}
                type="button"
                className={css.msgRow}
                onClick={() => { onOpenChat?.(selected, m.localId) }}
                disabled={!onOpenChat}
                title={onOpenChat ? '跳转到该消息' : undefined}
              >
                <span className={css.msgName}>{m.senderName || (m.isSender ? '我' : '成员')}</span>
                <span className={css.msgTime}>{fmtDateTimeSec(m.createTime)}</span>
                <span className={css.msgText}>{m.displayText ?? m.msgContent ?? ''}</span>
              </button>
            ))}
            {messages.length === 0 && !loading && <div className={css.note}>暂无消息</div>}
            {loading && messages.length === 0 && <ListSkeleton rows={5} />}
          </div>
        </Card>
      </div>
    </div>
  )
}
