/**
 * `Overview.tsx` 的「总览面板本体（消费上述模块）」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * M22（2026-10-16）：四组卡片的 JSX 全部拆进 `overview-sections.tsx` 的具名区块组件，
 * 本文件只负责取数、状态与版式编排。
 *
 * Wave D3（2026-10-18）用户要求「和其他界面一致、用 Bootstrap 栅格」：
 * 删掉 NeonBackdrop 装饰层 + NeonHero 等距牌 + 自造 12 栅格，KPI 改 kit `StatCard`
 * （`row g-2` / `col-6 col-sm-3`），卡片区改 `row g-2` / `col-12 col-xl-*`。
 *
 * 微信化改版（2026-10-19）：页头「数据总览」+ 2 个动作（刷新 / 更多▾，导出收进菜单）；
 * KPI 8→4（会话/消息/好友/群聊），卡片 14→6（趋势/热度/关系/内容/存储/资金），
 * 其余分析进「更多分析」折叠区。取数/缓存/导出/归档/刷新/骨架屏逻辑一行未动。
 *
 * @module overview-panelx
 */

import { useEffect, useRef, useState } from 'react'
import {
  apiExportAllSessions,
  apiGetLedger,
  apiGetOverview,
  apiGetOverviewInsights,
  apiGetStorageStats,
  apiGetAvatar,
} from '../api.ts'
import { useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { ErrorState, PanelHeader } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'
import { fmtClockMs } from '../utils/format.ts'
import { buildOverviewReport, downloadText, exportElementImage } from './overview-export.ts'
import { RegionBoard } from './RegionBoard.tsx'
import { CACHE_BASE, CACHE_INSIGHTS, CACHE_LEDGER, CACHE_STOR, CACHE_TIME, SkeletonOverview, readCache, writeCache } from './overview-parts.tsx'
import {
  ContentAssetsSection,
  HealthSection,
  HeatmapSection,
  InteractionSection,
  LedgerSection,
  MomentsAuthorsSection,
  MoreAnalysis,
  RelationSection,
  RevokedSection,
  StorageCompositionSection,
  KpiSection,
  TrendSection,
  WordCloudSection,
} from './overview-sections.tsx'

/**
 * Render the WeChat data overview panel (space-capsule cockpit).
 * @param props - navigation, chat and moments deep-link callbacks.
 * @returns the overview element tree.
 */
export function OverviewPanel({ onNavigate, onOpenChat, onOpenMoments }: {
  onNavigate?: (tab: string) => void
  onOpenChat?: (username: string) => void
  onOpenMoments?: (username: string) => void
} = {}): React.JSX.Element {
  // 调试：URL 带 ?skeleton=1 时强制展示骨架屏（截图/视觉验收用）。
  const debugSkeleton = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('skeleton') === '1'
  const [data, setData] = useState<OverviewSnapshot | null>(() => readCache(CACHE_BASE) as OverviewSnapshot | null)
  const [ins, setIns] = useState<OverviewInsights | null>(() => readCache(CACHE_INSIGHTS) as OverviewInsights | null)
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(() => readCache(CACHE_LEDGER) as LedgerSnapshot | null)
  const [stor, setStor] = useState<StorageSnapshot | null>(() => readCache(CACHE_STOR) as StorageSnapshot | null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 6000 / 2500)` 已由 hook 统一管理。
  // 失败类提示改前不带定时器（一直留着），所以走 hold 而不是 flash。
  const { notice, flash, hold } = useTransientNotice(6000)
  const [lastUpdated, setLastUpdated] = useState<number | null>(() => readCache(CACHE_TIME) as number | null)
  const [done, setDone] = useState(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // 「更多 ▾」菜单：导出报告/数据/图片 + 归档全部会话（页头动作 3→2 后收进来的）。
  const [moreOpen, setMoreOpen] = useState(false)

  const load = async (): Promise<void> => {
    const hadData = data !== null
    if (hadData) setRefreshing(true)
    else setLoading(true)
    try {
      const [base, insw] = await Promise.all([
        apiGetOverview(),
        apiGetOverviewInsights(),
      ])
      setData(base)
      setIns(insw)
      writeCache(CACHE_BASE, base)
      writeCache(CACHE_INSIGHTS, insw)
      setError(null)
      const now = Date.now()
      setLastUpdated(now)
      writeCache(CACHE_TIME, now)
      if (hadData) {
        setDone(true)
        if (doneTimer.current) clearTimeout(doneTimer.current)
        doneTimer.current = setTimeout(() => { setDone(false) }, 1600)
      }
    } catch (e) {
      if (data === null) setError((e as Error).message)
      else hold('后台刷新失败，当前显示缓存数据：' + (e as Error).message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
    // 资金/存储等较重扩展数据在后台慢慢更新并持久化，不阻塞核心刷新。
    try {
      const [lg, st] = await Promise.all([
        apiGetLedger(),
        apiGetStorageStats(),
      ])
      setLedger(lg)
      setStor(st)
      writeCache(CACHE_LEDGER, lg)
      writeCache(CACHE_STOR, st)
    } catch {
      /* 保留已有缓存/数据 */
    }
  }

  useEffect(() => { void load() }, [])
  useWechatDataUpdated(() => { void load() })
  // 朋友圈活跃作者头像改为逐行懒加载：作者卡片进入可视区附近时才请求头像。

  const go = (tab: string): void => { onNavigate?.(tab) }
  const openChat = (username: string): void => { onOpenChat?.(username) }
  const openMoments = (username: string): void => { onOpenMoments?.(username) }
  const topBase = Math.max(1, ...(ins?.relations.top ?? []).map(x => x.count))
  const extras = ins?.extras

  const exportAll = async (): Promise<void> => {
    setExporting(true)
    try {
      const r = await apiExportAllSessions()
      flash('已归档 ' + String(r.count) + ' 条消息 → ' + r.path)
    } catch (e) {
      hold('归档失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }
  const doExport = async (format: 'md' | 'json' | 'png' | 'jpg'): Promise<void> => {
    if (!data) return
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    if (format === 'json') {
      const payload = {
        exportedAt: now.toISOString(),
        updatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        snapshot: data,
        insights: ins,
        ledger,
        storage: stor,
      }
      downloadText(`微信数据总览-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json')
    } else if (format === 'md') {
      downloadText(`微信数据总览报告-${stamp}.md`, buildOverviewReport(data, ins, ledger, stor, now, lastUpdated), 'text/markdown;charset=utf-8')
    } else {
      setMoreOpen(false)
      await new Promise((r) => { setTimeout(r, 40) })
      const root = rootRef.current
      if (root) {
        try {
          await exportElementImage(root, format, `微信数据总览-${stamp}.${format}`)
        } catch (e) {
          hold('图片导出失败: ' + (e as Error).message)
          return
        }
      }
    }
    flash('已导出报告', 2500)
  }

  const largeFiles = stor?.large_files?.slice(0, 4) ?? []
  const warnCount = ledger?.warnings.length ?? 0

  return (
    <div ref={rootRef} className={kitCss.panelShell}>
      <PanelHeader
        title="数据总览"
        desc={(
          <>
            本机微信数据资产一屏纵览
            {refreshing && <><span className={css.spinner} /> 同步中…</>}
            {lastUpdated ? ` · 最后更新 ${fmtClockMs(lastUpdated)}` : ''}
          </>
        )}
        actions={(
          <>
            {/* 页头只留两个动作（微信化层级）：刷新 + 更多。导出与归档收进「更多 ▾」。 */}
            <button type="button" className={css.refresh} onClick={() => { void load() }} disabled={loading || refreshing}>
              {(loading || refreshing)
                ? <><span className={css.spinner} /> {loading ? '统计中…' : '更新中…'}</>
                : done ? '✓ 已更新' : '刷新'}
            </button>
            <div className={css.exportWrap}>
              <button type="button" className={css.refresh} aria-expanded={moreOpen} onClick={() => { setMoreOpen(v => !v) }} disabled={!data}>
                更多 ▾
              </button>
              {moreOpen && (
                <>
                  <div className={css.exportBackdrop} onClick={() => { setMoreOpen(false) }} />
                  <div className={css.exportMenu} role="menu" aria-label="更多操作">
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('md'); setMoreOpen(false) }}>导出报告 · Markdown</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('json'); setMoreOpen(false) }}>导出数据 · JSON</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('png'); setMoreOpen(false) }}>导出图片 · PNG</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('jpg'); setMoreOpen(false) }}>导出图片 · JPG</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void exportAll() }} disabled={exporting} {...desktopActionProps()}>
                      {exporting ? '归档中…' : desktopAction() ? '归档全部会话 ZIP（仅电脑）' : '归档全部会话 ZIP'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      />

      {/* 正文独立滚动：页头（含「更多」菜单）保持可见（见 kit.module.css 的 .panelBody） */}
      <div className={kitCss.panelBody}>
        {notice && <div className={kitCss.emptyInline}>{notice}</div>}
        {!debugSkeleton && error && data !== null && <ErrorState message="后台刷新失败（正在展示缓存数据）" />}
        {data === null || debugSkeleton ? <SkeletonOverview /> : null}

        {!debugSkeleton && data !== null && (
          <>
            <KpiSection data={data} ins={ins} onGo={go} />

            {/* 卡片区：Bootstrap 栅格。默认 6 张核心卡（趋势/热度/关系/内容/存储/资金），
                其余分析收进「更多分析」折叠区 —— 首屏不再是一堵卡片墙。 */}
            <div className="d-flex flex-column gap-2">
              <div className="row g-2">
                {extras && <TrendSection extras={extras} />}
                {extras && extras.heatmap.length > 0 && <HeatmapSection heatmap={extras.heatmap} />}
              </div>

              <div className="row g-2">
                {ins && <RelationSection ins={ins} onOpenChat={openChat} />}
                {ins && <ContentAssetsSection ins={ins} official={data.official} />}
              </div>

              <div className="row g-2">
                <StorageCompositionSection categories={data.storage.categories} stor={stor} largeFileCount={largeFiles.length} onGo={go} />
                <LedgerSection ledger={ledger} onGo={go} />
              </div>

              <MoreAnalysis count={6}>
                {ins && <InteractionSection ins={ins} />}
                <WordCloudSection />
                <RegionBoard />
                <MomentsAuthorsSection authors={data.moments_authors} onOpenMoments={openMoments} onGo={go} />
                <RevokedSection revoked={data.revoked} warnCount={warnCount} onGo={go} />
                {ins && <HealthSection ins={ins} extras={extras} />}
              </MoreAnalysis>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
