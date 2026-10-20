/**
 * 媒体资产（v1 盘点）— hardlink 图片/文件/视频规模、总占用与重复 md5 清单。
 * 空间治理的可执行动作（去重/清理）为后续项；本页只读盘点，与「存储」分段共用
 * 页头语言（标题 + ≤2 动作）与内联 KPI 条。
 */
import { useCallback } from 'react'
import { ListSentinel, ListSkeleton, useElapsedSeconds, useProgressiveList, useWechatDataUpdated } from './hooks.tsx'
import { apiGetMediaAssets } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { MediaAssetsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, Mono, PanelHeader } from '../ui/kit.tsx'
import { AssetKpiBar, AssetMoreMenu } from './files-cell.tsx'
import { PanelAction } from './asset-ui.tsx'
import css from './media-assets.module.css'
import { fmtBytes } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

/**
 * Render the media assets panel.
 * @param props - optional tab navigation callback for quick jumps.
 * @returns the media assets element tree.
 */
export function MediaAssetsPanel({ onNavigate }: { onNavigate?: (tab: string) => void } = {}): React.JSX.Element {
  /* 2026-10-03 推广批次 1：改用共用 useFreshData —— 打开即查最新（不再预填缓存），成功写回缓存；失败才回退缓存并由 hook 标注「以下为本地缓存（可能不是最新）」。 */
  const load = useCallback((): Promise<MediaAssetsSnapshot> => apiGetMediaAssets(), [])
  const { data, loading, error, reload } = useFreshData<MediaAssetsSnapshot>('media-assets', load)
  // WAL 增量推送到达后静默重取（不翻 loading）：实时刷新接线由 wechat-live-refresh spec 钉住。
  useWechatDataUpdated(() => { void reload() })

  const { count: dupCount, sentinelRef } = useProgressiveList(data?.duplicates.length ?? 0, 100)
  // 首次盘点走秒（口径见 hooks.tsx#useElapsedSeconds）
  const elapsed = useElapsedSeconds(loading && data === null)

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="媒体"
        desc="图片 / 文件 / 视频规模 · 重复资产清单 · 本地离线盘点"
        actions={(
          <>
            <PanelAction onClick={() => { void reload() }} disabled={loading}>{loading ? '盘点中…' : '刷新'}</PanelAction>
            {onNavigate && (
              <AssetMoreMenu items={[
                { key: 'files', label: '查看文件资产', onSelect: () => { onNavigate('files') } },
                { key: 'storage', label: '查看存储占用', onSelect: () => { onNavigate('storage') } },
                { key: 'health', label: '数据健康检查', onSelect: () => { onNavigate('health') } },
              ]} />
            )}
          </>
        )}
      />

      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {/* 首次盘点：走秒 + 与真实布局同形的骨架（原来是干等一行「统计中…」）。 */}
      {loading && !data && (
        <>
          <div className={kitCss.emptyInline}>
            {`正在盘点本机媒体资产…已用 ${elapsed}s · 首次盘点要汇总本机文件索引，若刚启动后台可能仍在同步，请稍候`}
          </div>
          <ListSkeleton rows={6} grid minCol={180} />
          <ListSkeleton rows={4} />
        </>
      )}

      {data && !loading && (
        <div className={css.layout}>
          <AssetKpiBar items={[
            { label: '合计文件', value: data.totalFiles.toLocaleString() },
            { label: '总占用', value: fmtBytes(data.totalBytes) },
            { label: '重复文件', value: data.duplicateFiles.toLocaleString() },
            { label: '可回收估算', value: fmtBytes(data.reclaimBytes) },
            ...data.categories.map(c => ({ label: c.category, value: `${c.count.toLocaleString()} 项 · ${fmtBytes(c.size)}` })),
          ]} />

          <Card title="重复资产（md5 相同，待去重）" flush>
            {data.duplicates.length === 0 ? <div className={kitCss.emptyInline}>未发现重复资产</div> : (
              <div className={css.dupList}>
                {data.duplicates.slice(0, dupCount).map(d => (
                  <div key={d.md5} className={css.dupRow}>
                    <span className={css.dupHash}><Mono>{d.md5}</Mono></span>
                    <span className={css.dupCount}>{d.count} 份 · {fmtBytes(d.size)}</span>
                    <span className={css.dupReclaim}>可回收 {fmtBytes(d.reclaimBytes)}</span>
                  </div>
                ))}
                {data.duplicates.length > dupCount && <ListSentinel refFn={sentinelRef} />}
              </div>
            )}
          </Card>

          <p className={css.footnote}>去重 / 清理动作与离线原图关联为后续项；本页先做只读盘点，文件明细见「文件」分段。</p>
        </div>
      )}
    </div>
  )
}
