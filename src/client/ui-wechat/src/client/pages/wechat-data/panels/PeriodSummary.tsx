/**
 * 周期总结面板 — 按日期区间（本周/本月/自定义）汇总聊天要点，复用每日
 * 总结的数据收集与 DSH LLM 生成链路，支持复制结果。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGeneratePeriodSummary, apiGetLlmConfig } from '../api.ts'
import type { PeriodSummaryResult } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, DateRangeField, PanelHeader } from '../ui/kit.tsx'
import { describeRange, todayISO } from '../utils/date-range.ts'
import { useTransientNotice } from './hooks.tsx'
import css from './period-summary.module.css'
import kitCss from '../ui/kit.module.css'

/**
 * Render the period summary panel.
 * @param props.onOpenSettings - 打开「设置」弹窗的指定节（未配模型时给"去配置"的出口）。
 * @returns the period summary element tree.
 */
export function PeriodSummaryPanel({ onOpenSettings }: { onOpenSettings?: (section?: string) => void } = {}): React.JSX.Element {
  const [from, setFrom] = useState(todayISO)
  const [to, setTo] = useState(todayISO)
  const [result, setResult] = useState<PeriodSummaryResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 模型是否已配置：周期总结与每日总结同一条链路，没配模型点生成必然失败。 */
  const [llm, setLlm] = useState<{ provider: string; model: string } | null>(null)
  const modelReady = !!llm && llm.model.trim() !== ''
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash, hold } = useTransientNotice()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const c = await apiGetLlmConfig()
        if (!cancelled) setLlm({ provider: c.provider, model: c.model })
      } catch { /* 读不到就不显示具体模型 */ }
    })()
    return () => { cancelled = true }
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

  const rangeText = useMemo(() => describeRange(from, to, '未选择日期'), [from, to])
  const typesText = useMemo(() => {
    if (!result) return ''
    return Object.entries(result.types).map(([k, v]) => `${k} ${v}`).join(' · ')
  }, [result])

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader title="周期总结" desc="按日期区间汇总聊天要点 · 复用每日总结链路（DSH LLM）" />

      <div className={css.formCard}>
        <DateRangeField
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
          onClear={() => { setFrom(''); setTo('') }}
          presets={['today', 'week', 'month', 'last-month', 'last-7', 'last-30']}
          ariaLabel="周期总结区间"
          idFrom="period-from"
          idTo="period-to"
        />
        <div className={css.row}>
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

      {/* 还没生成过时的落地：此前表单下方**什么都没有**，实测留 515px 空白。
          这里说清"会得到什么 / 三步怎么做 / 模型配好了没"，与「每日总结」同一套口径。 */}
      {!result && !loading && (
        <div className={css.psLand}>
          <div className={css.psCard}>
            <div className={css.psTitle}>还没有这一段的总结</div>
            <div className={css.psSteps}>
              <span className={css.psStep}><b>1</b> 选区间：上面 6 个快捷预设（今天 / 本周 / 本月 / 上月 / 近 7 天 / 近 30 天）或手选起止</span>
              <span className={css.psStep}><b>2</b> 点「生成总结」：先在本机收集区间消息，再交给模型写要点</span>
              <span className={css.psStep}><b>3</b> 点「复制结果」把整段总结拿走；生成结果不会落库，刷新后需重新生成</span>
            </div>
          </div>
          <div className={css.psCard}>
            <div className={css.psTitle}>会得到什么</div>
            <ul className={css.psList}>
              <li><b>区间统计</b>：消息数 / 活跃会话 / 文本行 / 类型分布 / Top 会话</li>
              <li><b>要点总结</b>：由模型按区间内容写成一段可复制的文字</li>
              <li><b>模型</b>：{modelReady ? `已配置 —— ${llm?.provider} · ${llm?.model}` : '尚未配置，需先配好模型才能生成'}</li>
              <li><b>耗时</b>：取决于区间大小（要先把区间内的消息读出来），区间越大越慢</li>
            </ul>
            {!modelReady && (
              <Button variant="pill" data-active="true" onClick={() => { onOpenSettings?.('ai') }}>去配置模型</Button>
            )}
          </div>
        </div>
      )}

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
