/**
 * 媒体资产馆（v1 盘点）— hardlink 图片/文件/视频规模、总占用与重复 md5
 * 清单。空间治理的可执行动作（去重/清理）为后续项。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListSentinel, useProgressiveList, useWechatDataUpdated } from './hooks.tsx'
import { apiGetMediaAssets, readRenderCache, writeRenderCache } from '../api.ts'
import type { MediaAssetsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, Mono, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import css from './media-assets.module.css'
import { fmtBytes } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

/**
 * Render the media assets panel.
 * @param props - optional tab navigation callback for quick jumps.
 * @returns the media assets element tree.
 */
export function MediaAssetsPanel({ onNavigate }: { onNavigate?: (tab: string) => void } = {}): React.JSX.Element {
  const [data, setData] = useState<MediaAssetsSnapshot | null>(() => readRenderCache<MediaAssetsSnapshot>('media-assets'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    // 安静 SWR：有渲染缓存时先展示缓存（不闪整页），后台再刷新。
    const cached = readRenderCache<MediaAssetsSnapshot>('media-assets')
    if (cached) setLoading(false)
    else setLoading(true)
    setError(null)
    try {
      const fresh = await apiGetMediaAssets()
      setData(fresh)
      writeRenderCache('media-assets', fresh)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 新媒体随真实同步落地后安静刷新。
  useWechatDataUpdated(() => { void load() })

  const { count: dupCount, sentinelRef } = useProgressiveList(data?.duplicates.length ?? 0, 100)

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader title="媒体资产馆" desc="图片/文件/视频规模 · 重复资产清单 · 本地盘点" />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <div className={kitCss.emptyInline}>统计中…</div>}

      {data && !loading && (
        <>
          <StatGrid>
            {data.categories.map(c => (
              <StatCard key={c.category} icon="🗂️" value={c.count.toLocaleString()} label={c.category} hint={fmtBytes(c.size)} />
            ))}
            <StatCard icon="🧮" value={data.totalFiles.toLocaleString()} label="合计" hint={fmtBytes(data.totalBytes)} tone="blue" />
            <StatCard icon="♻️" value={data.duplicateFiles.toLocaleString()} label="重复文件" hint={fmtBytes(data.duplicateBytes)} tone="amber" />
            <StatCard icon="✨" value={fmtBytes(data.reclaimBytes)} label="可回收估算" hint="去重后（只读）" tone="green" />
          </StatGrid>

          {onNavigate && (
            <Card title="快捷入口">
              <div className={css.actions}>
                <button type="button" className={css.actionBtn} onClick={() => { onNavigate('files') }}>查看文件资产</button>
                <button type="button" className={css.actionBtn} onClick={() => { onNavigate('storage') }}>查看存储占用</button>
                <button type="button" className={css.actionBtn} onClick={() => { onNavigate('health') }}>数据健康检查</button>
              </div>
            </Card>
          )}

          <Card title="重复资产（md5 相同，待去重）">
            {data.duplicates.length === 0 ? <div className={kitCss.emptyInline}>未发现重复资产</div> : (
              <div className={css.dupList}>
                {data.duplicates.slice(0, dupCount).map(d => (
                  <div key={d.md5} className={css.dupRow}>
                    <Mono>{d.md5}</Mono>
                    <span className={css.dupCount}>{d.count} 份 · {fmtBytes(d.size)} · 可回收 {fmtBytes(d.reclaimBytes)}</span>
                  </div>
                ))}
                {data.duplicates.length > dupCount && <ListSentinel refFn={sentinelRef} />}
              </div>
            )}
          </Card>

          <p className={css.footnote}>去重/清理动作与离线原图关联为后续项；本页先做只读盘点，明细可跳「文件资产」与「存储占用」。</p>
        </>
      )}
    </div>
  )
}
