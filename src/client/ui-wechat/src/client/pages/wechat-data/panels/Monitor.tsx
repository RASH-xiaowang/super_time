/**
 * 群聊分析 · 监控 — 只读实时监控：群热度、今日/近 30 天消息、近期消息流
 * （会话/日历/消息 Remote 轮询，无需原生 Hook；自动刷新可开关）。
 *
 * 2026-10-19 微信化：与「洞察」共用 36px 工具行（群选择器 + 自动刷新开关 + 刷新），
 * 不再单独画页头；群选择器从「左栏大列表」收进工具行下拉；热力格改微信绿单色阶。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ListSkeleton, useWechatDataUpdated } from './hooks.tsx'
import { apiGetDailyCounts, apiGetMessages, apiGetSessions, readRenderCache, writeRenderCache } from '../api.ts'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, ErrorState, Select } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './monitor.module.css'
import { GroupToolRow } from './GroupInsights.tsx'
import { buildHeatDays, HeatCalendar } from './monitor-heat.tsx'
import { fmtDateTimeSec } from '../utils/format.ts'

const REFRESH_VISIBLE_MS = 3000
const REFRESH_HIDDEN_MS = 10_000
/** 热力图窗口：近 30 天（2026-10-17 用户要求「近 14 天改为近 1 个月」）。 */
const HEAT_DAYS = 30

/**
 * Render the group monitor dashboard.
 * @param props - optional chat navigation callback (message click jumps there).
 * @returns the monitor element tree.
 */
export function MonitorPanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  const [groups, setGroups] = useState<WechatSession[]>([])
  const [selected, setSelected] = useState('')
  /** 日计数，按 `YYYY-M` 分组（跨月窗口要两个月的数据，纯日号会互相覆盖）。 */
  const [counts, setCounts] = useState<Record<string, Record<string, number>>>({})
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
      const cached = readRenderCache<{ counts: Record<string, Record<string, number>>; messages: WechatMessage[] }>('monitor:' + username)
      if (cached) {
        setCounts(cached.counts)
        setMessages(cached.messages)
        setLoading(false)
      }
      /*
       * 取**两个月**的日计数：热力图窗口是近 30 天，月初会跨到上个月
       * （10 月 3 日往前 30 天 = 9 月 4 日）。只取本月的话，月初那几天热力图会全是 0。
       *
       * ⚠️ `apiGetDailyCounts` 返回的 `counts` 键是**纯日号**（`'1'`、`'2'`…），
       * 两个月直接展开合并会互相覆盖（9 月的 17 日盖掉 10 月的 17 日）。
       * 所以按 `YYYY-M` 分组存，`buildHeatDays` 按这个形状查。
       */
      const now = new Date()
      const thisY = now.getFullYear()
      const thisM = now.getMonth() + 1
      const prev = new Date(thisY, thisM - 2, 1)
      const prevY = prev.getFullYear()
      const prevM = prev.getMonth() + 1
      const [calThis, calPrev, msgs] = await Promise.all([
        apiGetDailyCounts({ username, year: thisY, month: thisM }),
        apiGetDailyCounts({ username, year: prevY, month: prevM }),
        /*
         * 取 50 条而不是 12 条（2026-10-17 用户截图「下方大片空白」）：
         * 右栏高 582px，一行消息约 44px ⇒ 12 条只占 528px 的一半，下方空 250px。
         * 50 条足够填满一屏并留出滚动余量；列表自己内滚，不会撑高卡片。
         */
        apiGetMessages({ talker: username, limit: 50 }),
      ])
      // A stale response must never overwrite the currently selected group.
      if (selectedRef.current !== username) return
      const merged: Record<string, Record<string, number>> = {
        [`${String(prevY)}-${String(prevM)}`]: calPrev.counts,
        [`${String(thisY)}-${String(thisM)}`]: calThis.counts,
      }
      setCounts(merged)
      setMessages(msgs.messages)
      writeRenderCache('monitor:' + username, { counts: merged, messages: msgs.messages })
    } catch (e) {
      if (selectedRef.current === username) setError((e as Error).message)
    } finally {
      if (selectedRef.current === username) setLoading(false)
    }
  }, [])

  useEffect(() => { void loadGroups() }, [loadGroups])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费。
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

  /*
   * 指标带与热力图都基于**近 30 天**窗口（`heat`），不再用「本月」——
   * 用户要的是「近 1 个月」，而「本月」在月初只有几天数据，看起来像群死了。
   */
  const heat = buildHeatDays(counts, HEAT_DAYS)
  const heatMax = Math.max(1, ...heat.map(h => h.count))
  const heatTotal = heat.reduce((a, h) => a + h.count, 0)
  const heatActiveDays = heat.filter(h => h.count > 0).length
  const todayCount = heat.find(h => h.isToday)?.count ?? 0
  const selGroup = groups.find(g => g.username === selected)

  return (
    <div className={kitCss.panelShell}>
      <GroupToolRow
        title="监控"
        selector={(
          <Select
            value={selected}
            onChange={(v) => { setSelected(v); writeRenderCache('monitor:selected', v) }}
            options={groups.map(g => ({ value: g.username, label: g.displayName || g.username }))}
            placeholder="选择群聊…"
            ariaLabel="选择群聊"
          />
        )}
        extra={(
          <button
            type="button"
            className={css.autoChip}
            aria-pressed={auto}
            data-on={auto || undefined}
            onClick={() => { setAuto(v => !v) }}
          >
            自动刷新
          </button>
        )}
        refreshing={loading}
        onRefresh={() => { if (selected) void loadGroup(selected) }}
      />

      {/* 指标带：4 个数字压成一条横排，与资产类 KPI 条同一视觉。 */}
      <div className={css.metrics}>
        <Metric label="群" value={String(groups.length)} />
        <Metric label="今日" value={`${String(todayCount)} 条`} />
        <Metric label="近 30 天" value={`${String(heatTotal)} 条`} />
        <Metric label="活跃天数" value={`${String(heatActiveDays)} / ${String(HEAT_DAYS)}`} />
      </div>

      {error && <ErrorState message={error} />}

      <div className={css.cols}>
        <div className={css.col}>
          <Card
            title={`${selGroup ? selGroup.displayName : '群'} · 近 ${String(HEAT_DAYS)} 天`}
            extra={<span className={kitCss.textCaption}>{`${String(heatTotal)} 条 · 活跃 ${String(heatActiveDays)} 天`}</span>}
          >
            <HeatCalendar heat={heat} max={heatMax} />
          </Card>
        </div>

        <div className={css.col}>
          <Card
            title="近期消息"
            className={css.fillCard}
            extra={selGroup ? (
              <button type="button" className={css.headBtn} onClick={() => { onOpenChat?.(selGroup.username) }} disabled={!onOpenChat}>
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
              {messages.length === 0 && !loading && (
                <div className={css.empty}>
                  <span>暂无消息</span>
                  <span className={css.emptyHint}>这个群在本机解密库里没有消息记录</span>
                </div>
              )}
              {loading && messages.length === 0 && <ListSkeleton rows={5} />}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

/** 指标带里的一格：标签在上、数值在下（比 StatCard 矮一半，4 个并排也不挤）。 */
function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={css.metric}>
      <span className={css.metricLabel}>{label}</span>
      <span className={css.metricValue}>{value}</span>
    </div>
  )
}
