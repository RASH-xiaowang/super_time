/**
 * 收藏/表情资产洞察 — 收藏类型与年份分布、表情包/文案规模、最常使用的
 * 表情 md5 排行。全部本机离线计算。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetAssetInsights, readRenderCache, writeRenderCache } from '../api.ts'
import type { AssetInsightsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './asset-insights.module.css'
import { useWechatDataUpdated } from './hooks.tsx'

/**
 * Render the asset insights panel.
 * @returns the asset insights element tree.
 */
export function AssetInsightsPanel(): React.JSX.Element {
  const [data, setData] = useState<AssetInsightsSnapshot | null>(() => readRenderCache<AssetInsightsSnapshot>('asset-insights'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const fresh = await apiGetAssetInsights()
      setData(fresh)
      writeRenderCache('asset-insights', fresh)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (!data) void load() })

  const maxYear = data && data.favorites.byYear.length > 0 ? Math.max(...data.favorites.byYear.map(y => y.count)) : 1

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="收藏/表情资产"
        desc="收藏类型与年份分布 · 表情规模 · 常用表情排行"
      />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <div className={kitCss.emptyInline}>统计中…</div>}

      {data && !loading && (
        <>
          <StatGrid>
            <StatCard icon="⭐" value={data.favorites.total} label="收藏总数" tone="amber" />
            <StatCard icon="😀" value={data.emoticons.customCount} label="自定义表情" tone="green" />
            <StatCard icon="📦" value={data.emoticons.storePackages} label="表情包" tone="purple" />
            <StatCard icon="💬" value={data.emoticons.captions} label="表情文案" tone="blue" />
          </StatGrid>

          <div className={kitCss.cardGrid}>
            <Card title="收藏类型分布">
              {data.favorites.byType.length === 0 ? <div className={kitCss.emptyInline}>暂无收藏</div> : (
                <div className={css.typeList}>
                  {data.favorites.byType.map(t => (
                    <div key={t.type} className={css.typeRow}>
                      <span className={css.typeLabel}>{t.label}</span>
                      <span className={css.typeCount}>{t.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="收藏年份分布">
              {data.favorites.byYear.length === 0 ? <div className={kitCss.emptyInline}>暂无收藏</div> : (
                <div className={css.yearList}>
                  {data.favorites.byYear.slice(0, 12).map(y => (
                    <div key={y.year} className={css.yearRow}>
                      <span className={css.yearLabel}>{y.year}</span>
                      <div className={css.yearTrack}><div className={css.yearFill} style={{ width: `${Math.round((y.count / maxYear) * 100)}%` }} /></div>
                      <span className={css.yearCount}>{y.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="常用表情 Top 10">
            {data.emoticons.topUsed.length === 0 ? <div className={kitCss.emptyInline}>暂无使用记录</div> : (
              <div className={css.emojiList}>
                {data.emoticons.topUsed.map(e => (
                  <div key={e.md5} className={css.emojiRow}>
                    <span className={css.emojiMd5}>{e.md5}</span>
                    <span className={css.emojiCount}>{e.count} 次</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
