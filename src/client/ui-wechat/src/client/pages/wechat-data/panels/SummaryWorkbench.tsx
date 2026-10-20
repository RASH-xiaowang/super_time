/**
 * 总结工作台 —— 「每日总结与任务」与「周期总结」合并后的统一面板。
 *
 * ## 为什么合并（2026-10-17 重做）
 *
 * 改前是两个独立面板，而「每日总结」内部还有 3 个 tab（任务栏 / 阅览 / 手动生成）——
 * 用户要在 **5 个视图**之间跳才能完成"生成一份总结并回看"这一件事。而这两个面板
 * 本质是**同一件事**：按时间范围总结聊天，区别只是粒度（一天 vs 一段）。
 *
 * 合并后的结构：
 *   · 顶部一条工具栏：时间范围（今天 / 本周 / 本月 / 上月 / 近 7 天 / 近 30 天 / 自定义）
 *     + 格式下拉 + 生成 + 复制。**一个入口驱动一切**。
 *   · 主区：统计条 → 24 小时分布 → Top 会话 → 总结正文。结果一屏可见。
 *   · 历史改抽屉（2026-10-19 微信化）：不再固定占 320px 压缩正文，页头「历史」按钮唤出。
 *   · 定时任务收进抽屉 —— 它是"配置"，不是"日常操作"，不该占主区。
 *
 * ## 数据口径
 *
 * 区间只有一天时走 `generateDailySummary`（它额外返回 hourly / types / topSessions，
 * 且会落库）；多天时走 `generatePeriodSummary`（同样落库，见 `summaryrec.ts`）。
 * 两条链路都返回统计，所以主区渲染逻辑只有一份。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copyTextToClipboard } from '../utils/misc.ts'
import {
  apiDeleteSummaryRecord,
  apiGenerateDailySummary,
  apiGeneratePeriodSummary,
  apiGetLlmConfig,
  apiGetSessions,
  apiListSummaryRecords,
  apiListSummaryTasks,
  readRenderCache,
  writeRenderCache,
} from '../api.ts'
import type { SummaryRecord, SummaryTask } from '@deepseek-ai/dsh-wechat-data/types'
import { ErrorState, PanelHeader } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { describeRange, todayISO } from '../utils/date-range.ts'
import { TaskDrawer } from './SummaryTaskDrawer.tsx'
import {
  HistoryPanel, recordKind, SummaryEmpty,
  SummaryHistoryDrawer, SummaryResult, SummaryToasts, SummaryToolbar,
  useSummaryToasts, type Stats,
} from './SummaryParts.tsx'
import css from './summary-workbench.module.css'

/** 历史筛选：全部 / 每日 / 周期。 */
type HistoryFilter = 'all' | 'daily' | 'period'

/** 上次选择的格式（记住用户选择，下次打开沿用）。 */
const FORMAT_CACHE_KEY = 'dsh-summary-format-v1'
/** 支持在工作台里手动选择的格式（与 `SummaryParts.FORMATS` 对齐）。 */
const BRIEF_FORMAT = 'brief'

/** 上次选择的格式（坏值/未知值回退到「简洁」，避免下拉显示空白）。 */
function readSavedFormat(): string {
  const cached = readRenderCache<{ key?: string }>(FORMAT_CACHE_KEY)?.key
  return cached !== undefined && ['brief', 'detailed', 'bullets', 'story'].includes(cached) ? cached : BRIEF_FORMAT
}

/**
 * username → 显示名（模块级 hook，控制 `SummaryWorkbench` 的行数）。
 *
 * 为什么需要：`topSessions` 里是原始 username（`1.44732057510@chatroom`），
 * 直接显示等于没信息（2026-10-17 真机截图确认）。会话列表本来就要拉，
 * 顺手建个映射，不额外查库。
 * @returns 解析函数（拿不到就退回 username）。
 */
function useSessionNames(): (username: string) => string {
  const [map, setMap] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cached = readRenderCache<readonly { username: string; name: string }[]>('summary-groups')
        if (cached && !cancelled) setMap(new Map(cached.map(g => [g.username, g.name])))
        const env = await apiGetSessions({ limit: 500 })
        if (cancelled) return
        const gs = env.sessions.map(s => ({ username: s.username, name: s.displayName || s.username }))
        setMap(new Map(gs.map(g => [g.username, g.name])))
        writeRenderCache('summary-groups', gs)
      } catch { /* 拿不到就退回 username */ }
    })()
    return () => { cancelled = true }
  }, [])
  return useCallback((u: string): string => map.get(u) ?? u, [map])
}

/**
 * 渲染总结工作台。
 * @param props.onOpenSettings - 打开设置弹窗（未配模型时给"去配置"的出口）。
 * @returns 面板元素树。
 */
export function SummaryWorkbench({ onOpenSettings }: { onOpenSettings?: (section?: string) => void } = {}): React.JSX.Element {
  const confirm = useConfirm()

  // ── 区间与结果 ────────────────────────────────────────────────
  const [from, setFrom] = useState(todayISO)
  const [to, setTo] = useState(todayISO)
  // 格式收进「格式 ▾」下拉后，选择记在本机缓存里（下次打开沿用上次选择）。
  const [format, setFormat] = useState(readSavedFormat)
  const [result, setResult] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [resultLabel, setResultLabel] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── 历史与任务 ────────────────────────────────────────────────
  const [records, setRecords] = useState<readonly SummaryRecord[]>([])
  const [tasks, setTasks] = useState<readonly SummaryTask[]>([])
  const [activeRecordId, setActiveRecordId] = useState<number | null>(null)
  const [filter, setFilter] = useState<HistoryFilter>('all')
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 历史改抽屉：不再固定占 320px 压缩正文。
  const [historyOpen, setHistoryOpen] = useState(false)

  // ── 模型状态 ──────────────────────────────────────────────────
  const [llm, setLlm] = useState<{ provider: string; model: string } | null>(null)
  const modelReady = !!llm && llm.model.trim() !== ''
  const nameOf = useSessionNames()

  // ── 提示 ──────────────────────────────────────────────────────
  const { toasts, notify } = useSummaryToasts()

  const mainRef = useRef<HTMLDivElement | null>(null)

  // ── 载入 ──────────────────────────────────────────────────────
  const loadRecords = useCallback(async (): Promise<void> => {
    try {
      const r = await apiListSummaryRecords()
      setRecords(r.items)
    } catch { /* 读不到就保持旧列表 */ }
  }, [])

  const loadTasks = useCallback(async (): Promise<void> => {
    try {
      const t = await apiListSummaryTasks()
      setTasks(t.items)
    } catch { /* 同上 */ }
  }, [])

  useEffect(() => { void loadRecords(); void loadTasks() }, [loadRecords, loadTasks])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const c = await apiGetLlmConfig()
        if (!cancelled) setLlm({ provider: c.provider, model: c.model })
      } catch { if (!cancelled) setLlm(null) }
    })()
    return () => { cancelled = true }
  }, [])

  // ── 生成 ──────────────────────────────────────────────────────
  const generate = useCallback(async (): Promise<void> => {
    if (!from || !to) return
    setLoading(true)
    setError(null)
    try {
      // 单日走每日链路（多返回 hourly / types / topSessions，且落库）；
      // 多日走周期链路（同样落库）。两条都归一成 `Stats`。
      if (from === to) {
        const r = await apiGenerateDailySummary({ date: from, format })
        setResult(r.summary)
        setStats({ total: r.total, sessions: r.sessions, messages: r.messages, types: r.types, hourly: r.hourly, topSessions: r.topSessions })
        setResultLabel(`${from} · 每日总结`)
      } else {
        const r = await apiGeneratePeriodSummary({ from, to, format })
        setResult(r.summary)
        setStats({ total: r.total, sessions: r.sessions, messages: r.messages, types: r.types, hourly: r.hourly, topSessions: r.topSessions })
        setResultLabel(`${from} ~ ${to} · 周期总结`)
      }
      setActiveRecordId(null)
      notify('ok', '总结已生成')
      await loadRecords()
      requestAnimationFrame(() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
    } catch (e) {
      setError((e as Error).message)
      notify('err', (e as Error).message || '生成失败')
    } finally {
      setLoading(false)
    }
  }, [from, to, format, notify, loadRecords])

  const copyResult = useCallback((): void => {
    if (!result) { notify('info', '暂无可复制的总结'); return }
    void copyTextToClipboard(result).then(ok => { notify(ok ? 'ok' : 'err', ok ? '已复制总结' : '复制失败') })
  }, [result, notify])

  // ── 历史操作 ──────────────────────────────────────────────────
  const openRecord = useCallback((r: SummaryRecord): void => {
    setResult(r.summary)
    setStats(null)
    setResultLabel(`${r.summaryDate} · ${recordKind(r) === 'period' ? '周期总结' : '每日总结'}`)
    setActiveRecordId(r.id)
    requestAnimationFrame(() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
  }, [])

  const deleteRecord = useCallback(async (r: SummaryRecord): Promise<void> => {
    const ok = await confirm({ title: '删除这条总结？', message: '删除后不可恢复。', tone: 'danger' })
    if (!ok) return
    try {
      await apiDeleteSummaryRecord({ id: r.id })
      notify('ok', '已删除')
      if (activeRecordId === r.id) { setResult(null); setStats(null); setActiveRecordId(null); setResultLabel('') }
      await loadRecords()
    } catch (e) { notify('err', (e as Error).message || '删除失败') }
  }, [confirm, notify, activeRecordId, loadRecords])

  const filteredRecords = useMemo(() => {
    if (filter === 'all') return records
    return records.filter(r => recordKind(r) === filter)
  }, [records, filter])

  const rangeText = useMemo(() => describeRange(from, to, '未选择日期'), [from, to])
  const isSingleDay = from === to

  /** 改格式并记住选择。 */
  const changeFormat = useCallback((key: string): void => {
    setFormat(key)
    writeRenderCache(FORMAT_CACHE_KEY, { key })
  }, [])

  /** 历史抽屉：Esc 关闭。 */
  useEffect(() => {
    if (!historyOpen) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setHistoryOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [historyOpen])

  return (
    <div className={css.panel}>
      <PanelHeader
        title="总结"
        desc="按时间范围总结聊天"
        actions={(
          <>
            <button type="button" className={css.ghostBtn} aria-expanded={historyOpen} onClick={() => { setHistoryOpen(v => !v) }} title="回看历史总结">
              历史{records.length > 0 ? ` (${String(records.length)})` : ''}
            </button>
            <button type="button" className={css.ghostBtn} onClick={() => { setDrawerOpen(true) }} title="管理定时总结任务">
              定时任务{tasks.length > 0 ? ` (${String(tasks.length)})` : ''}
            </button>
          </>
        )}
      />

      {/* 工具栏：区间 + 格式下拉 + 生成 + 复制。整页唯一的高亮动作是「生成」。 */}
      <SummaryToolbar
        from={from}
        to={to}
        format={format}
        loading={loading}
        hasResult={!!result}
        rangeText={rangeText}
        isSingleDay={isSingleDay}
        onFrom={setFrom}
        onTo={setTo}
        onFormat={changeFormat}
        onGenerate={() => { void generate() }}
        onCopy={copyResult}
      />

      {error && <ErrorState message={error} />}

      <div className={css.body}>
        {/* ── 主区（满宽）：历史改抽屉后不再被 320px 侧栏挤压 ── */}
        <div className={css.main} ref={mainRef}>
          {!result && !loading && (
            <SummaryEmpty isSingleDay={isSingleDay} modelReady={modelReady} onOpenSettings={onOpenSettings} onGenerate={() => { void generate() }} />
          )}

          {loading && (
            <div className={css.card}>
              <div className={css.empty}>
                <span className={css.spin} />
                <div className={css.emptyHint}>正在收集区间消息并生成总结…</div>
              </div>
            </div>
          )}

          {result && !loading && (
            <SummaryResult
              result={result}
              stats={stats}
              label={resultLabel}
              isSingleDay={isSingleDay}
              nameOf={nameOf}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>
      </div>

      {/* ── 历史抽屉（2026-10-19：从固定 320px 侧栏改为抽屉，正文满宽）── */}
      {historyOpen && (
        <SummaryHistoryDrawer onClose={() => { setHistoryOpen(false) }}>
          <HistoryPanel
            records={filteredRecords}
            filter={filter}
            onFilter={setFilter}
            activeId={activeRecordId}
            onOpen={(r) => { setHistoryOpen(false); openRecord(r) }}
            onCopy={(r) => { void copyTextToClipboard(r.summary).then(ok => { notify(ok ? 'ok' : 'err', ok ? '已复制' : '复制失败') }) }}
            onDelete={(r) => { void deleteRecord(r) }}
            onClose={() => { setHistoryOpen(false) }}
          />
        </SummaryHistoryDrawer>
      )}

      {/* ── 定时任务抽屉 ── */}
      {drawerOpen && (
        <TaskDrawer
          tasks={tasks}
          onClose={() => { setDrawerOpen(false) }}
          onChanged={() => { void loadTasks() }}
          notify={notify}
        />
      )}

      <SummaryToasts toasts={toasts} />
    </div>
  )
}
