/**
 * 公众号 — gh_* 账号的消息/文章规模与最近文章时间，支持跳转会话查看原文。
 * 全部本机离线统计。与「文件 / 媒体 / 存储」共用页头语言与内联 KPI 条。
 */
import { useCallback } from 'react'
import { ListSentinel, useProgressiveList } from './hooks.tsx'
import { apiGetOfficialAssets } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { OfficialAssetsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, CellPrimary, LoadingState, Mono, PanelHeader } from '../ui/kit.tsx'
import { AssetKpiBar } from './files-cell.tsx'
import { PanelAction } from './asset-ui.tsx'
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
  /* 2026-10-03 推广批次 1：改用共用 useFreshData（打开即查最新、失败才回退缓存并标注）。 */
  const load = useCallback((): Promise<OfficialAssetsSnapshot> => apiGetOfficialAssets(), [])
  const { data, loading, error, reload } = useFreshData<OfficialAssetsSnapshot>('official-assets', load, { liveRefresh: true })

  const { count: rowCount, sentinelRef } = useProgressiveList(data?.rows.length ?? 0, 100)

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="公众号"
        desc="gh_* 账号消息 / 文章规模 · 最近文章 · 本地离线"
        actions={(
          <PanelAction onClick={() => { void reload() }} disabled={loading}>{loading ? '统计中…' : '刷新'}</PanelAction>
        )}
      />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <LoadingState variant="compact" label="统计中…" />}

      {data && !loading && (
        <>
          <AssetKpiBar items={[
            { label: '公众号', value: data.total.toLocaleString() },
            { label: '消息', value: data.rows.reduce((a, r) => a + r.messages, 0).toLocaleString() },
            { label: '文章', value: data.rows.reduce((a, r) => a + r.articles, 0).toLocaleString() },
            { label: '有文章账号', value: data.rows.filter(r => r.articles > 0).length.toLocaleString() },
          ]} />
          <Card flush title="公众号明细" className={css.fillCard}>
            <div className={css.table}>
              <div className={css.head} aria-hidden="true">
                <span className={css.colName}>公众号</span>
                <span className={css.colNum}>消息</span>
                <span className={css.colNum}>文章</span>
                <span className={css.colTime}>最近文章</span>
              </div>
              {data.rows.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无公众号内容 —— 请确认公众号会话已入库</div>
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
