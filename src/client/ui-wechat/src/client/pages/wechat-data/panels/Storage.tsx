/**
 * 存储空间分析 — 仪表盘版：总占用 Hero + 指标卡 + 分类环形图 + 会话/发送者
 * 排行 + 大文件清单。数据经 DSH 后端 Remote（message_resource.db 联表）。
 */
import { useEffect, useState } from 'react'
import { apiGetStorageStats, readRenderCache, writeRenderCache } from '../api.ts'
import css from './storage.module.css'
import type { StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, CellPrimary, clickableKey, DataTable, Mono, PanelHeader } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import { fmtBytes, fmtSharePct } from '../utils/format.ts'
import { useWechatDataUpdated } from './hooks.tsx'

type StorageStats = StorageSnapshot

const DONUT_COLORS = ['#22d3ee', '#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#f472b6', '#2dd4bf', '#94a3b8']

/**
 * Render the storage panel.
 * @param props - optional callback to open a conversation.
 * @returns the storage element tree.
 */
export function StoragePanel({ onOpenChat }: { onOpenChat?: (username: string) => void }): React.JSX.Element {
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (!stats) void load() })

  const cats = (stats?.categories ?? []).slice().sort((a, b) => b.size - a.size)
  const chats = (stats?.chats ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 10)
  const senders = (stats?.senders ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 10)
  const files = (stats?.large_files ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 20)
  const total = stats?.total_size ?? 0
  const totalCount = stats?.total_count ?? 0
  const maxChat = Math.max(1, ...chats.map(c => c.size))
  const maxSender = Math.max(1, ...senders.map(c => c.size))
  const topCat = cats[0]
  const topChat = chats[0]

  // 环形图 conic-gradient（按分类大小占比）
  let acc = 0
  const stops = cats.map((c, i) => {
    const start = acc
    acc += total > 0 ? (c.size / total) * 100 : 0
    const color = DONUT_COLORS[i % DONUT_COLORS.length] ?? '#22d3ee'
    return `${color} ${start}% ${acc}%`
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
        ? <button type="button" className={css.linkBtn} onClick={() => { onOpenChat(f.username) }}>{f.sessionName || f.username}</button>
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
        title="存储空间分析"
        desc="来自消息资源库的只读统计（不含本地数据库本身）"
        actions={(
          <button type="button" className={css.btn} onClick={() => { void load() }} disabled={loading}>
            {loading ? '统计中…' : '刷新'}
          </button>
        )}
      />

      {loading && stats === null && (
        <div className={css.skeletonWrap}>
          <div className={css.skelHero}><div className={css.skelBlock} /><div className={css.skelBlock} /></div>
          <div className={css.grid}>
            <section className={css.card}>
              <h3 className={css.cardTitle}>分类分布</h3>
              <div className={css.skelLine} /><div className={css.skelLine} /><div className={css.skelLine} />
            </section>
            <section className={css.card}>
              <h3 className={css.cardTitle}>会话占用排行</h3>
              <div className={css.skelLine} /><div className={css.skelLine} /><div className={css.skelLine} />
            </section>
            <section className={css.card}>
              <h3 className={css.cardTitle}>发送者排行</h3>
              <div className={css.skelLine} /><div className={css.skelLine} />
            </section>
          </div>
        </div>
      )}
      {error && <div className={kitCss.error} role="alert">⚠️ 存储数据读取失败（{error}）</div>}
      {!error && stats !== null && (
        <>
          {/* Hero 总览卡 */}
          <div className={css.hero}>
            <div className={css.heroMain}>
              <span className={css.heroValue}>{fmtBytes(total)}</span>
              <span className={kitCss.textMeta}>媒体资源总占用</span>
            </div>
            <div className={css.heroStats}>
              <div className={css.heroStat}>
                <span className={css.heroStatValue}>{totalCount.toLocaleString()}</span>
                <span className={kitCss.textCaptionTrunc}>资源总数</span>
              </div>
              <div className={css.heroStat}>
                <span className={css.heroStatValue}>{fmtBytes(totalCount > 0 ? total / totalCount : 0)}</span>
                <span className={kitCss.textCaptionTrunc}>平均单项</span>
              </div>
              <div className={css.heroStat}>
                <span className={css.heroStatValue}>{topCat ? fmtSharePct(topCat.size, total) : 0}%</span>
                <span className={kitCss.textCaptionTrunc}>{topCat?.label ?? '—'}</span>
              </div>
              <div className={css.heroStat}>
                <span className={css.heroStatValue}>{topChat ? fmtSharePct(topChat.size, total) : 0}%</span>
                <span className={kitCss.textCaptionTrunc}>最多会话 · {topChat?.name || topChat?.username || '—'}</span>
              </div>
            </div>
          </div>

          <div className={kitCss.cardGrid}>
            {/* 分类环形图 */}
            <Card title="分类分布">
              <div className={css.donutRow}>
                <div className={css.donut} style={{ background: `conic-gradient(${stops})` }} />
                <div className={css.donutLegend}>
                  {cats.map((c, i) => (
                    <div key={c.label} className={css.legendRow}>
                      <span className={css.legendDot} style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] ?? '#22d3ee' }} />
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
                    <div className={css.barTrack}><div className={css.barFill} style={{ width: `${(c.size / maxChat) * 100}%` }} /></div>
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
                  <div className={css.barTrack}><div className={css.barFill} style={{ width: `${(c.size / maxSender) * 100}%` }} /></div>
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
