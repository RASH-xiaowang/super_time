/**
 * 存储 — 只读盘点：媒体资源总占用、分类分布、会话/发送者排行与大文件清单。
 * 数据经 DSH 后端 Remote（message_resource.db 联表）。与「媒体」分段共用页头语言
 * （标题 + ≤2 动作）与内联 KPI 条；环形图用微信绿单色阶。
 */
import { useEffect, useState } from 'react'
import { apiGetStorageStats, readRenderCache, writeRenderCache } from '../api.ts'
import css from './storage.module.css'
import type { StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, CellPrimary, clickableKey, DataTable, LinkButton, LoadingState, Mono, PanelHeader } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import { AssetKpiBar } from './files-cell.tsx'
import { PanelAction } from './asset-ui.tsx'
import { fmtBytes, fmtSharePct } from '../utils/format.ts'
import { useElapsedSeconds, useWechatDataUpdated } from './hooks.tsx'

type StorageStats = StorageSnapshot

/**
 * 环形图色阶：微信绿单色由深到浅（取主题里已有的 alpha 档）。
 * 不再用多色霓虹 —— 分类之间靠图例文字区分，颜色只表达「占比大小」。
 */
const DONUT_ALPHA = [70, 50, 40, 35, 25, 20, 16, 14, 12, 10] as const
const catColor = (i: number): string => `var(--nm-cyan-${String(DONUT_ALPHA[i % DONUT_ALPHA.length] ?? 70)})`

/**
 * Render the storage panel.
 * @param props - optional callback to open a conversation.
 * @returns the storage element tree.
 */
export function StoragePanel({ onOpenChat }: { onOpenChat?: (username: string) => void }): React.JSX.Element {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 首次统计走秒（口径见 hooks.tsx#useElapsedSeconds）
  const elapsed = useElapsedSeconds(loading && stats === null)

  const load = async (): Promise<void> => {
    setError(null)
    const cached = readRenderCache<StorageStats>('storage')
    if (cached) {
      setStats(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    try {
      const fresh = await apiGetStorageStats()
      setStats(fresh)
      writeRenderCache('storage', fresh)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费。
  useWechatDataUpdated(() => { if (!stats) void load() })

  const cats = (stats?.categories ?? []).slice().sort((a, b) => b.size - a.size)
  const chats = (stats?.chats ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 10)
  const senders = (stats?.senders ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 10)
  const files = (stats?.large_files ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 20)
  const total = stats?.total_size ?? 0
  const totalCount = stats?.total_count ?? 0
  const maxChat = Math.max(1, ...chats.map(c => c.size))
  const maxSender = Math.max(1, ...senders.map(c => c.size))
  const topChat = chats[0]

  // 环形图 conic-gradient（按分类大小占比；单色阶，由大到小）
  let acc = 0
  const stops = cats.map((c, i) => {
    const start = acc
    acc += total > 0 ? (c.size / total) * 100 : 0
    return `${catColor(i)} ${String(start)}% ${String(acc)}%`
  }).join(', ')

  /** 大文件清单列定义（闭包持有 total 与跳转回调）。 */
  const fileCols: ReadonlyArray<DataColumn<NonNullable<StorageSnapshot['large_files']>[number]>> = [
    {
      id: 'name',
      header: '文件名',
      cell: f => <CellPrimary>{f.name || '(未知文件名)'}</CellPrimary>,
      sortValue: f => f.name || '',
    },
    {
      id: 'session',
      header: '所属会话',
      cell: f => (f.username && onOpenChat
        ? <LinkButton onClick={() => { onOpenChat(f.username) }}>{f.sessionName || f.username}</LinkButton>
        : (f.sessionName || f.username || '—')),
      sortValue: f => f.sessionName || f.username || '',
    },
    {
      id: 'date',
      header: '日期',
      cell: f => <Mono>{f.create_time ? new Date(f.create_time * 1000).toISOString().slice(0, 10) : '--'}</Mono>,
      sortValue: f => f.create_time || 0,
    },
    {
      id: 'size',
      header: '大小',
      cell: f => <Mono>{fmtBytes(f.size)}</Mono>,
      sortValue: f => f.size,
      align: 'right',
    },
    {
      id: 'pct',
      header: '占比',
      cell: f => `${fmtSharePct(f.size, total)}%`,
      sortValue: f => f.size,
      align: 'right',
    },
  ]

  return (
    <div className={css.panel}>
      <PanelHeader
        title="存储"
        desc="来自消息资源库的只读统计（不含本地数据库本身）"
        actions={(
          <PanelAction onClick={() => { void load() }} disabled={loading}>{loading ? '统计中…' : '刷新'}</PanelAction>
        )}
      />

      {loading && stats === null && (
        <LoadingState
          variant="timed"
          since={elapsed}
          label="正在统计存储占用…"
          hint="首次统计要汇总 message_resource 全表，若刚启动可能偏慢，请稍候"
        />
      )}
      {error && <div className={kitCss.error} role="alert">存储数据读取失败（{error}）</div>}
      {!error && stats !== null && (
        <>
          <AssetKpiBar items={[
            { label: '媒体资源总占用', value: fmtBytes(total) },
            { label: '资源总数', value: totalCount.toLocaleString() },
            { label: '平均单项', value: fmtBytes(totalCount > 0 ? total / totalCount : 0) },
            { label: '最多会话', value: topChat ? `${fmtSharePct(topChat.size, total)}% · ${topChat.name || topChat.username || '—'}` : '—' },
          ]} />

          <div className={kitCss.cardGrid}>
            {/* 分类环形图 */}
            <Card title="分类分布">
              <div className={css.donutRow}>
                <div className={css.donut} style={{ background: `conic-gradient(${stops})` }} />
                <div className={css.donutLegend}>
                  {cats.map((c, i) => (
                    <div key={c.label} className={css.legendRow}>
                      <span className={css.legendDot} style={{ background: catColor(i) }} />
                      <span className={css.legendLabel}>{c.label}</span>
                      <span className={css.legendMeta}>{c.count.toLocaleString()} 项 · {fmtBytes(c.size)} · {fmtSharePct(c.size, total)}%</span>
                    </div>
                  ))}
                  {cats.length === 0 && <div className={kitCss.emptyInline}>暂无分类数据</div>}
                </div>
              </div>
            </Card>

            {/* 会话排行 */}
            <Card title="会话占用排行（Top 10）">
              {chats.map((c) => {
                const name = c.name || c.username || '(未知)'
                return (
                  <div key={`${c.username}_${c.name}_${c.count}`} className={css.barRow}
                    style={onOpenChat ? { cursor: 'pointer' } : undefined}
                    {...(onOpenChat ? clickableKey(() => { onOpenChat(c.username) }) : {})}
                    title={`${name}\n点击打开会话`}>
                    <span className={css.barLabel}>{name}</span>
                    <div className={css.barTrack}><div className={css.barFill} style={{ width: `${String((c.size / maxChat) * 100)}%` }} /></div>
                    <span className={css.barValue}>{fmtBytes(c.size)} · {fmtSharePct(c.size, total)}%</span>
                  </div>
                )
              })}
              {chats.length === 0 && <div className={kitCss.emptyInline}>暂无数据</div>}
            </Card>

            {/* 发送者排行 */}
            <Card title="发送者排行（Top 10）">
              {senders.map(c => (
                <div key={`${c.username}_${c.name}_${c.count}`} className={css.barRow} title={c.name || c.username || '(未知)'}>
                  <span className={css.barLabel}>{c.name || c.username || '(未知)'}</span>
                  <div className={css.barTrack}><div className={css.barFill} style={{ width: `${String((c.size / maxSender) * 100)}%` }} /></div>
                  <span className={css.barValue}>{fmtBytes(c.size)} · {fmtSharePct(c.size, total)}%</span>
                </div>
              ))}
              {senders.length === 0 && <div className={kitCss.emptyInline}>暂无数据</div>}
            </Card>
          </div>

          {/* 大文件清单（kit DataTable：本页可排序） */}
          <Card
            title="大文件清单（按体积 Top 20）"
            extra={<span className={kitCss.textCaption}>共 {files.length} 个 · 合计 {fmtBytes(files.reduce((a, f) => a + f.size, 0))}</span>}
            flush
          >
            <DataTable<NonNullable<StorageSnapshot['large_files']>[number]>
              columns={fileCols}
              rows={files}
              getRowId={(f, i) => `${f.username}-${f.size}-${f.create_time}-${i}`}
              emptyTitle="暂无大文件"
            />
          </Card>
        </>
      )}
    </div>
  )
}
