/**
 * 收藏/表情统计 — 内联 KPI 条 + 2 张分布图。
 * 全部本机离线计算。
 *
 * 微信化精简（本轮）：
 *   · 3 张 StatCard → 一条内联 KPI 条（40–46px，四个计数并排）；
 *   · 「常用表情 Top 10」列表删除 —— 它是表情页的重复列表，统计页只保留聚合视角；
 *   · 只留 2 张图：收藏类型分布 / 收藏年份分布；
 *   · 去掉渐变条、彩色底徽章与 emoji，条形统一用主色。
 */
import { useCallback } from 'react'
import { apiGetAssetInsights } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { AssetInsightsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, LoadingState } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './asset-insights.module.css'
import { useWechatDataUpdated } from './hooks.tsx'

/** 一行「名称 + 条形 + 数字」，条宽按 `max` 归一。 */
function BarRow({ name, count, max }: { name: string; count: number; max: number }): React.JSX.Element {
  const w = Math.max(2, Math.round((count / Math.max(1, max)) * 100))
  return (
    <div className={css.barRow} title={`${name}：${String(count)} 项`}>
      <span className={css.barName}>{name}</span>
      <div className={css.barTrack}>
        <div className={css.barFill} style={{ width: `${String(w)}%` }} />
      </div>
      <span className={css.barCount}>{count}</span>
    </div>
  )
}

/** 内联 KPI：一个数字 + 一个标签。 */
function Kpi({ value, label }: { value: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <span className={css.kpi}>
      <span className={css.kpiValue}>{value}</span>
      <span className={css.kpiLabel}>{label}</span>
    </span>
  )
}

/**
 * Render the asset insights panel.
 * @returns the asset insights element tree.
 */
export function AssetInsightsPanel(): React.JSX.Element {
  /* 2026-10-03 推广批次 2：改用共用 useFreshData —— 打开即查最新（不再预填缓存），
     成功写回缓存；失败才回退缓存并由 hook 在 error 里标注「以下为本地缓存（可能不是最新）」。 */
  const load = useCallback((): Promise<AssetInsightsSnapshot> => apiGetAssetInsights(), [])
  const { data, loading, error, reload } = useFreshData<AssetInsightsSnapshot>('asset-insights', load)
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费。
  useWechatDataUpdated(() => { if (!data) void reload() })

  const typeMax = data && data.favorites.byType.length > 0
    ? Math.max(...data.favorites.byType.map(t => t.count))
    : 1
  const yearMax = data && data.favorites.byYear.length > 0
    ? Math.max(...data.favorites.byYear.map(y => y.count))
    : 1

  return (
    <div className={kitCss.panelShell}>
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <LoadingState variant="compact" label="统计中…" />}

      {data && !loading && (
        <>
          {/* 内联 KPI 条：分段名已是「统计」，这里不再重复标题。 */}
          <div className={css.insightBar}>
            <Kpi value={data.favorites.total} label="收藏总数" />
            <Kpi value={data.emoticons.customCount} label="自定义表情" />
            {data.emoticons.storePackages > 0 && <Kpi value={data.emoticons.storePackages} label="表情包" />}
            <Kpi value={data.emoticons.captions} label="表情文案" />
            <Kpi value={data.favorites.byType.length} label="收藏类型" />
            <Kpi value={data.favorites.byYear.length} label="年份跨度" />
            <span className={css.barSpacer} />
            <button type="button" className={css.refreshBtn} onClick={() => { void reload() }} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
          </div>

          {/* 只保留 2 张图（收藏类型 / 收藏年份），与收藏页的条目列表不重复。 */}
          <div className={css.grid2}>
            <Card
              title="收藏类型分布"
              className={css.fillCard}
              extra={<span className={kitCss.textCaption}>{`${String(data.favorites.byType.length)} 类`}</span>}
            >
              {data.favorites.byType.length === 0 ? (
                <div className={css.empty}>暂无收藏</div>
              ) : (
                <div className={css.list}>
                  {data.favorites.byType.map(t => (
                    <BarRow key={t.type} name={t.label} count={t.count} max={typeMax} />
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="收藏年份分布"
              className={css.fillCard}
              extra={<span className={kitCss.textCaption}>{`${String(data.favorites.byYear.length)} 年`}</span>}
            >
              {data.favorites.byYear.length === 0 ? (
                <div className={css.empty}>暂无收藏</div>
              ) : (
                <div className={css.list}>
                  {data.favorites.byYear.map(y => (
                    <BarRow key={y.year} name={String(y.year)} count={y.count} max={yearMax} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
