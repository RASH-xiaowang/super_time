/**
 * 周期总结面板 — 按日期区间（本周/本月/自定义）汇总聊天要点，复用每日
 * 总结的数据收集与 DSH LLM 生成链路，支持复制结果。
 */
import { useCallback, useMemo, useState } from 'react'
import { apiGeneratePeriodSummary } from '../api.ts'
import type { PeriodSummaryResult } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, PanelHeader } from '../ui/kit.tsx'
import { useTransientNotice } from './hooks.tsx'
import css from './period-summary.module.css'
import kitCss from '../ui/kit.module.css'

function localToday(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function fmt(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Ready-made ranges. */
const RANGES: ReadonlyArray<{ key: string; label: string; range: () => { from: string; to: string } }> = [
  {
    key: 'week', label: '本周',
    range: () => {
      const now = new Date()
      const monday = addDays(now, -((now.getDay() + 6) % 7))
      return { from: fmt(monday), to: fmt(addDays(monday, 6)) }
    },
  },
  {
    key: 'month', label: '本月',
    range: () => {
      const now = new Date()
      return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)) }
    },
  },
  {
    key: 'last-month', label: '上月',
    range: () => {
      const now = new Date()
      return { from: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: fmt(new Date(now.getFullYear(), now.getMonth(), 0)) }
    },
  },
]

/**
 * Render the period summary panel.
 * @returns the period summary element tree.
 */
export function PeriodSummaryPanel(): React.JSX.Element {
  const today = localToday()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [result, setResult] = useState<PeriodSummaryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash, hold } = useTransientNotice()

  const applyRange = useCallback((key: string): void => {
    const r = RANGES.find(x => x.key === key)?.range()
    if (r) { setFrom(r.from); setTo(r.to) }
  }, [])

  const generate = useCallback(async (): Promise<void> => {
    if (!from || !to) return
    setLoading(true)
    setError(null)
    try {
      const r = await apiGeneratePeriodSummary({ from, to })
      setResult(r)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  const copyResult = useCallback(async (): Promise<void> => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.summary)
      flash('已复制总结')
    } catch {
      hold('复制失败')
    }
  }, [result])

  const rangeText = useMemo(() => (from && to ? `${from} ~ ${to}` : '未选择日期'), [from, to])
  const typesText = useMemo(() => {
    if (!result) return ''
    return Object.entries(result.types).map(([k, v]) => `${k} ${v}`).join(' · ')
  }, [result])

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader title="周期总结" desc="按日期区间汇总聊天要点 · 复用每日总结链路（DSH LLM）" />

      <div className={css.formCard}>
        <div className={css.row}>
          <label className={css.fieldLabel} htmlFor="period-from">从</label>
          <input id="period-from" className={css.input} type="date" value={from} onChange={(e) => { setFrom(e.target.value) }} />
          <label className={css.fieldLabel} htmlFor="period-to">到</label>
          <input id="period-to" className={css.input} type="date" value={to} onChange={(e) => { setTo(e.target.value) }} />
        </div>
        <div className={css.row}>
          {RANGES.map(r => (
            <Button variant="pill" key={r.key} onClick={() => { applyRange(r.key) }}>{r.label}</Button>
          ))}
          <Button variant="pill" data-active="true" onClick={() => { void generate() }} disabled={loading}>
            {loading ? '生成中…' : '生成总结'}
          </Button>
          <Button variant="pill" onClick={() => { void copyResult() }} disabled={!result}>复制结果</Button>
        </div>
        <div className={kitCss.textMeta}>当前区间：{rangeText}</div>
      </div>

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && <div className={css.loading}>正在收集区间消息并生成总结…</div>}

      {result && !loading && (
        <div className={css.resultCard}>
          <div className={css.cardTitle}>总结</div>
          <div className={css.stats}>
            <span className={`${kitCss.textMeta} ${css.stat}`}><b>{result.total.toLocaleString()}</b> 消息</span>
            <span className={`${kitCss.textMeta} ${css.stat}`}><b>{result.sessions}</b> 活跃会话</span>
            <span className={`${kitCss.textMeta} ${css.stat}`}><b>{result.messages}</b> 文本行</span>
          </div>
          {typesText && <div className={css.types}>{typesText}</div>}
          {result.topSessions.length > 0 && (
            <div className={css.topSessions}>
              {result.topSessions.slice(0, 5).map(s => (
                <span key={s.username} className={css.topChip}>{s.username} · {s.count}</span>
              ))}
            </div>
          )}
          <div className={css.summary}>{result.summary}</div>
        </div>
      )}
    </div>
  )
}
