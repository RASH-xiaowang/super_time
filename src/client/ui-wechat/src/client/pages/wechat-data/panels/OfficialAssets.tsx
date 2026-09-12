/**
 * 公众号内容资产面板 — gh_* 账号的消息/文章规模与最近文章时间，支持跳转
 * 会话查看原文。全部本机离线统计。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListSentinel, useProgressiveList } from './hooks.tsx'
import { apiGetOfficialAssets, readRenderCache, writeRenderCache } from '../api.ts'
import type { OfficialAssetsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, CellPrimary, Mono, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import css from './official-assets.module.css'
import kitCss from '../ui/kit.module.css'

function fmtTs(ts?: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Render the official account assets panel.
 * @param props - optional chat navigation callback.
 * @returns the official assets element tree.
 */
export function OfficialAssetsPanel({ onOpenChat }: { onOpenChat?: (username: string) => void } = {}): React.JSX.Element {
  const [data, setData] = useState<OfficialAssetsSnapshot | null>(() => readRenderCache<OfficialAssetsSnapshot>('official-assets'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const fresh = await apiGetOfficialAssets()
      setData(fresh)
      writeRenderCache('official-assets', fresh)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const { count: rowCount, sentinelRef } = useProgressiveList(data?.rows.length ?? 0, 100)

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader title="公众号内容资产" desc="gh_* 账号消息/文章规模 · 最近文章 · 本地离线" />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <div className={kitCss.emptyInline}>统计中…</div>}

      {data && !loading && (
        <>
          <StatGrid>
            <StatCard icon="📢" value={data.total.toLocaleString()} label="公众号" tone="blue" />
            <StatCard icon="💬" value={data.rows.reduce((a, r) => a + r.messages, 0).toLocaleString()} label="消息" />
            <StatCard icon="📄" value={data.rows.reduce((a, r) => a + r.articles, 0).toLocaleString()} label="文章" tone="purple" />
            <StatCard icon="🕐" value={data.rows.filter(r => r.articles > 0).length.toLocaleString()} label="最近更新" hint="有文章账号" tone="green" />
          </StatGrid>
          <Card flush title="公众号明细">
            <div className={css.table}>
              <div className={css.head}>
                <span className={css.colName}>公众号</span>
                <span className={css.colNum}>消息</span>
                <span className={css.colNum}>文章</span>
                <span className={css.colTime}>最近文章</span>
              </div>
              {data.rows.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无公众号内容 — 请确认公众号会话已入库</div>
              ) : (
                data.rows.slice(0, rowCount).map(r => (
                  <button key={r.username} type="button" className={css.row} onClick={() => { onOpenChat?.(r.username) }} title="打开会话">
                    <span className={css.colName}>
                      <CellPrimary>{r.name}</CellPrimary>
                      <span className={css.rowUser}>{r.username}</span>
                    </span>
                    <span className={css.colNum}>{r.messages.toLocaleString()}</span>
                    <span className={css.colNum}>{r.articles.toLocaleString()}</span>
                    <Mono>{fmtTs(r.lastArticleTime)}</Mono>
                  </button>
                ))
              )}
              {data.rows.length > rowCount && <ListSentinel refFn={sentinelRef} />}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
