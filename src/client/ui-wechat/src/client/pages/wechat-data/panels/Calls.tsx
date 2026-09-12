/**
 * 通话记录面板 —— type-50 语音/视频通话的统计与明细。
 *
 * 数据全部来自 `getCalls`（后端 `query/calls.ts`）：它扫描每个 message 分片里
 * `local_type = 50` 的行，把 zstd 压着的 `<voipmsg>` XML 解出来。
 *
 * 三条实测口径（详见 docs/wechat-schema.md §B.16）：
 *  - **时长**只能从 `<msg>` 文本里解析（「通话时长 00:21」），XML 的 `<duration>` 恒为 0；
 *  - **接通**= 有本机时长 **或** 「已在其它设备接听」（后者没有时长）；
 *  - **方向**由 `real_sender_id` 经分片 `Name2Id` 解析：等于自己的 wxid 即呼出。
 * 语音/视频刻意不分类：`room_type` 的语义在本机数据里判不了，界面不据此下结论。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetCalls, readRenderCache, writeRenderCache } from '../api.ts'
import type { CallsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, EmptyState, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './calls.module.css'

/** Cache key for the render cache (survives panel remounts). */
const CACHE_KEY = 'calls'

/** 秒 → 「1小时23分」/「3分05秒」/「42 秒」。 */
function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return '0 秒'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h} 小时 ${String(m).padStart(2, '0')} 分`
  if (m > 0) return `${m} 分 ${String(s).padStart(2, '0')} 秒`
  return `${s} 秒`
}

/** `MM:SS` 形式的通话时长（与聊天页签里的气泡一致）。 */
function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** `2026-03` → `2026 年 3 月`。 */
function fmtMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  return m ? `${m[1]} 年 ${Number(m[2])} 月` : month
}

function fmtTime(sec: number): string {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false })
}

/**
 * Render the calls panel.
 * @param props - optional chat navigation callback.
 * @returns the calls element tree.
 */
export function CallsPanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  const [snap, setSnap] = useState<CallsSnapshot | null>(() => readRenderCache<CallsSnapshot>(CACHE_KEY))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const v = await apiGetCalls({ topPeers: 20, recentLimit: 60 })
      setSnap(v)
      writeRenderCache(CACHE_KEY, v)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 快照扫描一遍全部分片（实测 ~60ms，但仍先展示渲染缓存，避免切页签时白屏）。
  useEffect(() => {
    const cached = readRenderCache<CallsSnapshot>(CACHE_KEY)
    if (cached) setSnap(cached)
    void load()
  }, [load])

  const monthMax = snap ? Math.max(1, ...snap.months.map((m) => m.calls)) : 1
  const hourMax = snap ? Math.max(1, ...snap.byHour) : 1
  const peerMax = snap && snap.peers.length > 0 ? snap.peers[0]!.calls : 1

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="通话记录"
        desc={snap
          ? `${snap.total} 通 · 覆盖 ${snap.peerCount} 位联系人 · 合计 ${fmtDuration(snap.durationSec)} · 快照 ${fmtTime(snap.updatedAt)}`
          : '语音/视频通话统计（来自消息库 type-50 的 voip XML）'}
        actions={(
          <Button variant="outline" size="sm" onClick={() => { void load() }} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </Button>
        )}
      />

      {/* 正文独立滚动：页头（含「刷新」按钮）保持可见（见 kit.module.css 的 .panelBody） */}
      <div className={kitCss.panelBody}>
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !snap && <div className={kitCss.emptyInline}>正在扫描消息库…</div>}

      {snap && snap.total === 0 && (
        <EmptyState icon="📞" title="没有通话记录" desc="本机消息库里没有 type-50 的通话消息。" />
      )}

      {snap && snap.total > 0 && (
        <>
          <StatGrid>
            <StatCard icon="📞" value={snap.total} label="通话总数" hint={`覆盖 ${snap.peerCount} 位联系人`} />
            <StatCard icon="⏱️" value={fmtDuration(snap.durationSec)} label="通话总时长" tone="purple" hint={`平均 ${fmtDuration(snap.avgSec)}`} />
            <StatCard icon="✅" value={`${snap.connected} / ${snap.missed}`} label="接通 / 未接通" tone={snap.missed > snap.connected ? 'amber' : 'green'} hint={snap.total > 0 ? `接通率 ${Math.round((snap.connected / snap.total) * 100)}%` : ''} />
            <StatCard icon="📤" value={`${snap.outgoing} / ${snap.incoming}`} label="呼出 / 呼入" tone="blue" />
            <StatCard icon="🏆" value={fmtClock(snap.longestSec)} label="最长通话" tone="amber" hint={snap.longestPeer || ''} />
            <StatCard icon="📵" value={snap.ackElsewhere} label="其它设备接听" hint="接通但没有本机时长" />
          </StatGrid>

          <Card title="通话对象排行" extra={<span className={kitCss.textCaption}>按通话次数；同一人未接通也计入</span>}>
            {snap.peers.length === 0 ? (
              <div className={kitCss.emptyInline}>暂无通话对象</div>
            ) : (
              <div className={css.rankList}>
                {snap.peers.map((p, i) => (
                  <button
                    key={p.username}
                    type="button"
                    className={css.rankRow}
                    onClick={onOpenChat ? () => { onOpenChat(p.username) } : undefined}
                    title={onOpenChat ? `打开与 ${p.name} 的聊天` : p.username}
                  >
                    <span className={css.rankNo} data-top={i < 3 ? '1' : '0'}>{i + 1}</span>
                    <span className={css.rankName} title={p.username}>{p.name}</span>
                    <span className={css.rankBarWrap}>
                      <span className={css.rankBar} style={{ width: `${Math.max(3, Math.round((p.calls / peerMax) * 100))}%` }} />
                    </span>
                    <span className={css.rankNums}>
                      <span className={css.rankCalls}>{p.calls} 通</span>
                      <span className={css.rankDur}>{fmtDuration(p.durationSec)}</span>
                      {p.calls - p.connected > 0 && <span className={css.rankMissed}>未接 {p.calls - p.connected}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <div className={kitCss.cardGrid}>
            <Card title="逐月通话" extra={<span className={kitCss.textCaption}>{snap.months.length} 个月</span>}>
              {snap.months.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无数据</div>
              ) : (
                <div className={css.monthList}>
                  {snap.months.map((m) => (
                    <div key={m.month} className={css.monthRow}>
                      <span className={css.monthLabel}>{fmtMonth(m.month)}</span>
                      <span className={css.monthBarWrap}>
                        <span className={css.monthBar} style={{ width: `${Math.max(2, Math.round((m.calls / monthMax) * 100))}%` }} />
                        {m.connected > 0 && (
                          <span className={css.monthBarOk} style={{ width: `${Math.max(1, Math.round((m.connected / monthMax) * 100))}%` }} />
                        )}
                      </span>
                      <span className={css.monthNums}>{m.calls} 通 · {fmtDuration(m.durationSec)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="时段分布" extra={<span className={kitCss.textCaption}>按通话产生的整点</span>}>
              <div className={css.hourGrid}>
                {snap.byHour.map((n, h) => (
                  <div key={h} className={css.hourCell} title={`${h}:00–${h}:59 · ${n} 通`} data-empty={n === 0 ? '1' : '0'}>
                    <span className={css.hourBarWrap}>
                      <span className={css.hourBar} style={{ height: `${n === 0 ? 0 : Math.max(6, Math.round((n / hourMax) * 100))}%` }} />
                    </span>
                    <span className={css.hourLabel}>{h % 3 === 0 ? h : ''}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className={kitCss.cardGrid}>
            <Card title="未接通原因" extra={<span className={kitCss.textCaption}>{snap.missed} 通未接通</span>}>
              {snap.unanswered.length === 0 ? (
                <div className={kitCss.emptyInline}>全部接通</div>
              ) : (
                <div className={css.reasonList}>
                  {snap.unanswered.map((u) => (
                    <div key={u.status} className={css.reasonRow}>
                      <span className={css.reasonName}>{u.status}</span>
                      <span className={css.reasonCount}>{u.count} 通</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="最近通话" extra={<span className={kitCss.textCaption}>{snap.recent.length} 条</span>}>
              {snap.recent.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无记录</div>
              ) : (
                <div className={css.recentList}>
                  {snap.recent.map((r) => (
                    <button
                      key={`${r.username}-${r.localId}`}
                      type="button"
                      className={css.recentRow}
                      data-state={r.connected ? 'done' : 'missed'}
                      onClick={onOpenChat ? () => { onOpenChat(r.username, r.localId) } : undefined}
                      title={onOpenChat ? '在聊天记录中定位这条通话' : r.username}
                    >
                      <span className={css.recentDir} data-out={r.outgoing ? '1' : '0'}>{r.outgoing ? '呼出' : '呼入'}</span>
                      <span className={css.recentName}>{r.name}</span>
                      <span className={css.recentStatus}>{r.status}</span>
                      <span className={css.recentTime}>{fmtTime(r.createTime)}</span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className={kitCss.emptyInline}>
            口径说明：时长取自通话气泡里的「通话时长 MM:SS」文本（XML 的 duration 字段恒为 0）；
            「已在其它设备接听」计为接通但不计入时长；语音/视频不做区分（通话 XML 里的类型字段尚无可靠依据）。
          </div>
        </>
      )}
      </div>
    </div>
  )
}
