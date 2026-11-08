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

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { exportElementImage } from './overview-export.ts'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask, type ExportTask } from './export-task.ts'
import { useOverviewReportExport, type OverviewReportExport } from './use-overview-report-export.ts'
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
import { useMenuDismiss } from './use-menu-dismiss.ts'

/** 总览的统计查询单次约 1–2 秒；WAL 高频推送只做合并限频，避免每几秒重复全量重算。 */
export const OVERVIEW_AUTO_REFRESH_MIN_MS = 30_000

async function archiveAllSessions(
  task: Pick<ExportTask, 'running' | 'run'>,
  flash: (message: string) => void,
  hold: (message: string) => void,
): Promise<void> {
  if (task.running) return
  const outcome = await task.run(async ({ jobId }) => apiExportAllSessions({ jobId }), {
    idPrefix: 'overview-archive',
    label: '归档全部会话',
    successMessage: (r) => '已归档 ' + String(r.count) + ' 条消息 → ' + r.path,
  })
  if (outcome.ok) flash(outcome.message)
  else if (!outcome.canceled) hold('归档失败: ' + outcome.error)
}

function overviewImageStamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
}

async function exportOverviewImage(input: {
  format: 'md' | 'json' | 'png' | 'jpg'
  hasData: boolean
  root: HTMLDivElement | null
  closeMenu: () => void
  imageTask: ExportTask
  reportExport: OverviewReportExport
  hold: (message: string) => void
}): Promise<void> {
  const { format, hasData, root, closeMenu, imageTask, reportExport, hold } = input
  if (!hasData || imageTask.running || reportExport.running) return
  if (format === 'json' || format === 'md') {
    await reportExport.exportText(format)
    return
  }
  closeMenu()
  await new Promise((resolve) => { setTimeout(resolve, 40) })
  if (!root) {
    hold('图片导出失败：页面尚未就绪')
    return
  }
  const filename = `微信数据总览-${overviewImageStamp(new Date())}.${format}`
  const outcome = await imageTask.run(
    async () => exportElementImage(root, format, filename),
    {
      idPrefix: 'overview-image',
      label: '导出总览图片',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: () => `已导出 ${format.toUpperCase()}`,
    },
  )
  if (!outcome.ok) hold('图片导出失败: ' + outcome.error)
}

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
  const archiveTask = useExportTask()
  const imageTask = useExportTask()
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 6000 / 2500)` 已由 hook 统一管理。
  // 失败类提示改前不带定时器（一直留着），所以走 hold 而不是 flash。
  const { notice, flash, hold } = useTransientNotice(6000)
  const [lastUpdated, setLastUpdated] = useState<number | null>(() => readCache(CACHE_TIME) as number | null)
  const reportExport = useOverviewReportExport({ data, insights: ins, ledger, storage: stor, lastUpdated, flash, hold })
  const [done, setDone] = useState(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // 「更多 ▾」菜单：导出报告/数据/图片 + 归档全部会话（页头动作 3→2 后收进来的）。
  const [moreOpen, setMoreOpen] = useState(false)
  const closeMore = useCallback((): void => { setMoreOpen(false) }, [])
  const { rootRef: moreRootRef, triggerRef: moreTriggerRef } = useMenuDismiss(moreOpen, closeMore)

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
      if (lg.readError) hold('资金台账读取不完整：' + lg.readError)
      else writeCache(CACHE_LEDGER, lg)
      writeCache(CACHE_STOR, st)
    } catch (e) {
      // 保留已有缓存，但资金读取失败不能伪装成“没有资金记录”。
      hold('资金台账或存储统计失败，当前显示缓存数据：' + (e as Error).message)
    }
  }

  const loadRef = useRef(load)
  loadRef.current = load
  const loadInFlightRef = useRef<Promise<void> | null>(null)
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoRefreshAtRef = useRef(0)

  /** 所有入口共用同一在途任务；刷新期间再收到事件只复用它，不并发发起第二份重查询。 */
  const runLoad = (): Promise<void> => {
    if (loadInFlightRef.current !== null) return loadInFlightRef.current
    const task = loadRef.current().finally(() => {
      if (loadInFlightRef.current === task) loadInFlightRef.current = null
    })
    loadInFlightRef.current = task
    return task
  }

  const scheduleAutoRefresh = (): void => {
    const wait = Math.max(0, OVERVIEW_AUTO_REFRESH_MIN_MS - (Date.now() - lastAutoRefreshAtRef.current))
    if (wait === 0) {
      lastAutoRefreshAtRef.current = Date.now()
      void runLoad()
      return
    }
    if (autoRefreshTimerRef.current !== null) return
    autoRefreshTimerRef.current = setTimeout(() => {
      autoRefreshTimerRef.current = null
      lastAutoRefreshAtRef.current = Date.now()
      void runLoad()
    }, wait)
  }

  useEffect(() => {
    lastAutoRefreshAtRef.current = Date.now()
    void runLoad()
    return () => {
      if (autoRefreshTimerRef.current !== null) clearTimeout(autoRefreshTimerRef.current)
    }
  }, [])
  useWechatDataUpdated(scheduleAutoRefresh)
  // 朋友圈活跃作者头像改为逐行懒加载：作者卡片进入可视区附近时才请求头像。

  const go = (tab: string): void => { onNavigate?.(tab) }
  const openChat = (username: string): void => { onOpenChat?.(username) }
  const openMoments = (username: string): void => { onOpenMoments?.(username) }
  const topBase = Math.max(1, ...(ins?.relations.top ?? []).map(x => x.count))
  const extras = ins?.extras

  const exportAll = async (): Promise<void> => {
    await archiveAllSessions(archiveTask, flash, hold)
  }
  const doExport = async (format: 'md' | 'json' | 'png' | 'jpg'): Promise<void> => {
    await exportOverviewImage({
      format,
      hasData: data !== null,
      root: rootRef.current,
      closeMenu: () => { setMoreOpen(false) },
      imageTask,
      reportExport,
      hold,
    })
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
            <button type="button" className={css.refresh} onClick={() => { lastAutoRefreshAtRef.current = Date.now(); void runLoad() }} disabled={loading || refreshing}>
              {(loading || refreshing)
                ? <><span className={css.spinner} /> {loading ? '统计中…' : '更新中…'}</>
                : done ? '✓ 已更新' : '刷新'}
            </button>
            <div className={css.exportWrap} ref={moreRootRef}>
              <button
                ref={moreTriggerRef}
                type="button"
                className={css.refresh}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => { setMoreOpen(v => !v) }}
                disabled={!data}
                title={!data && !loading ? '数据加载完成后可导出' : undefined}
              >
                更多 ▾
              </button>
              {moreOpen && (
                <>
                  <div className={css.exportBackdrop} onClick={() => { setMoreOpen(false) }} />
                  <div className={css.exportMenu} role="menu" aria-label="更多操作">
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('md'); setMoreOpen(false) }} disabled={reportExport.running || imageTask.running}>{reportExport.running ? '报告导出中…' : '导出报告 · Markdown'}</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('json'); setMoreOpen(false) }} disabled={reportExport.running || imageTask.running}>{reportExport.running ? '数据导出中…' : '导出数据 · JSON'}</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('png'); setMoreOpen(false) }} disabled={reportExport.running || imageTask.running}>{imageTask.running ? '图片导出中…' : '导出图片 · PNG'}</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void doExport('jpg'); setMoreOpen(false) }} disabled={reportExport.running || imageTask.running}>{imageTask.running ? '图片导出中…' : '导出图片 · JPG'}</button>
                    <button type="button" className={css.exportItem} role="menuitem" onClick={() => { void exportAll() }} disabled={archiveTask.running} {...desktopActionProps()}>
                      {archiveTask.finishing ? '完成中…' : archiveTask.running ? '归档中…' : desktopAction() ? '归档全部会话文本 ZIP（仅电脑）' : '归档全部会话文本 ZIP'}
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
        <ExportProgressStatus state={archiveTask.state} onCancel={() => { void archiveTask.cancel() }} />
        <ExportProgressStatus state={imageTask.state} />
        <ExportProgressStatus state={reportExport.state} />
        {!debugSkeleton && error && data !== null && <ErrorState message="后台刷新失败（正在展示缓存数据）" />}
        {data === null || debugSkeleton ? <SkeletonOverview /> : null}

        {!debugSkeleton && data !== null && (
          <>
            <KpiSection data={data} ins={ins} onGo={go} />

            {/* 卡片区：Bootstrap 栅格。默认 6 张核心卡（趋势/热度/关系/内容/存储/资金），
                其余分析收进「更多分析」折叠区 —— 首屏不再是一堵卡片墙。 */}
            <div className={css.cardStack}>
              <div className="row g-2">
                {extras && <TrendSection extras={extras} />}
                {extras && extras.heatmap.length > 0 && <HeatmapSection heatmap={extras.heatmap} />}
              </div>

              <div className="row g-2">
                {ins && <RelationSection className={`col-12 col-xl-6 ${css.overviewRelationColumn}`} ins={ins} onOpenChat={openChat} />}
                <div className={`col-12 col-xl-6 ${css.overviewRightStack}`}>
                  {ins && <ContentAssetsSection className={css.overviewStackCard} ins={ins} official={data.official} />}
                  <StorageCompositionSection className={css.overviewStackCard} categories={data.storage.categories} stor={stor} largeFileCount={largeFiles.length} onGo={go} />
                  <LedgerSection className={css.overviewStackCard} ledger={ledger} onGo={go} />
                </div>
              </div>

              <MoreAnalysis count={6}>
                {ins && <InteractionSection ins={ins} />}
                <MomentsAuthorsSection authors={data.moments_authors} onOpenMoments={openMoments} onGo={go} />
                <WordCloudSection />
                <RegionBoard />
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
