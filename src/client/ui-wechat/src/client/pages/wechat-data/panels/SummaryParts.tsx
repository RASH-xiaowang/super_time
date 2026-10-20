/**
 * 总结工作台的展示组件 —— 从 `SummaryWorkbench.tsx` 拆出（单函数 250 行棘轮）。
 *
 * 这里只放**纯展示**：空态、统计卡、历史列表。所有状态与回调都由工作台传入，
 * 组件本身不读 API、不持状态 —— 这样它们可以单独测，也不会把工作台撑长。
 */
import { useCallback, useRef, useState } from 'react'
import type { SummaryRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { DateRangeField } from '../ui/kit.tsx'
import { fmtLocaleMs } from '../utils/format.ts'
import type { RangePresetKey } from '../utils/date-range.ts'
import css from './summary-workbench.module.css'

/** 一条 toast 提示（`kind` 与 `SummaryTaskDrawer` 的 `ToastKind` 同构）。 */
export interface ToastItem { id: number; kind: 'ok' | 'err' | 'info'; text: string }

/**
 * 提示队列 hook：追加后 3.2s 自动消失（原工作台内联逻辑，抽出来控制单函数行数）。
 * @returns 当前提示与 `notify(kind, text)`。
 */
export function useSummaryToasts(): { toasts: readonly ToastItem[]; notify: (kind: ToastItem['kind'], text: string) => void } {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([])
  const seq = useRef(0)
  const notify = useCallback((kind: ToastItem['kind'], text: string): void => {
    const id = ++seq.current
    setToasts(prev => [...prev, { id, kind, text }])
    window.setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)) }, 3200)
  }, [])
  return { toasts, notify }
}

/**
 * 结果区：统计卡 + 总结正文（或「模型没返回内容」的降级提示）。
 * @param props - 结果正文、统计、区间标签与设置出口。
 * @returns 结果元素。
 */
export function SummaryResult({ result, stats, label, isSingleDay, nameOf, onOpenSettings }: {
  result: string
  stats: Stats | null
  label: string
  isSingleDay: boolean
  nameOf: (username: string) => string
  onOpenSettings?: (section?: string) => void
}): React.JSX.Element {
  return (
    <>
      {stats && <StatsCard stats={stats} label={label} isSingleDay={isSingleDay} nameOf={nameOf} />}
      {isDegradedSummary(result) ? (
        <DegradedNotice text={result} onOpenSettings={onOpenSettings} />
      ) : (
        <div className={css.card}>
          <div className={css.cardHead}>
            {/* 标题不再与页头「总结」重复：结果卡只说「生成结果」 */}
            <span className={css.cardTitle}>生成结果</span>
            <span className={css.cardExtra}>{label}</span>
          </div>
          <div className={css.cardBody}>
            <div className={css.summary}>{result}</div>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * 提示条容器（无动画/无投影；`kind` 只影响小圆点颜色）。
 * @param props.toasts - 待展示的提示。
 * @returns 提示容器；无提示时不渲染。
 */
export function SummaryToasts({ toasts }: { toasts: readonly ToastItem[] }): React.JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div className={css.toasts}>
      {toasts.map(t => (
        <div key={t.id} className={css.toast} data-kind={t.kind}>
          <span className={css.toastDot} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}

/** 区间预设：覆盖"日常看"的全部粒度。 */
const PRESETS: readonly RangePresetKey[] = ['today', 'week', 'month', 'last-month', 'last-7', 'last-30']

/** 统一后的统计形状（两条生成链路都归一到这里）。 */
export interface Stats {
  total: number
  sessions: number
  messages: number
  types: Record<string, number>
  hourly: number[]
  topSessions: Array<{ username: string; count: number }>
}

/**
 * 判断一条记录是周期总结还是每日总结。
 *
 * 口径：`summaryDate` 里带 `~` 的是周期（后端存 `from~to`），否则是单日。
 * 不用 `taskId === 0` 判断 —— 定时任务产出的每日总结 `taskId > 0`，
 * 但手动生成的每日总结也是 0，两者都是"每日"。
 * @param r - 一条总结记录。
 * @returns 记录类型。
 */
export function recordKind(r: SummaryRecord): 'daily' | 'period' {
  return r.summaryDate.includes('~') ? 'period' : 'daily'
}

/**
 * 判断一条总结是不是「模型没返回内容」的降级结果。
 *
 * 后端在模型不可用 / 返回空时会拼一段「模型未返回内容（请为默认模型配置 …）」+
 * 原始消息摘要。那是**失败态**，不该当正文铺在「总结」卡里 —— 用户会以为
 * 这就是总结（2026-10-17 实测：整屏都是 `[gh_xxx] - 5 1 0 0 0 0 0 0 …` 的原始行）。
 * @param text - 总结正文。
 * @returns 是否为降级结果。
 */
export function isDegradedSummary(text: string): boolean {
  return text.startsWith('模型未返回内容') || text.startsWith('AI 不可用') || text.startsWith('LLM 调用失败')
}

/**
 * 降级提示卡：模型没返回内容时，把「为什么」和「怎么办」说清楚，而不是铺原始消息。
 * @param props.text - 后端返回的降级文本（只取第一行作为原因）。
 * @param props.onOpenSettings - 打开设置弹窗。
 * @returns 提示卡元素。
 */
export function DegradedNotice({ text, onOpenSettings }: {
  text: string
  onOpenSettings?: (section?: string) => void
}): React.JSX.Element {
  const reason = text.split('\n')[0] ?? ''
  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>模型没有返回内容</span>
      </div>
      <div className={css.cardBody}>
        <div className={css.degradedReason}>{reason}</div>
        <div className={css.degradedHint}>
          区间统计已经算好了（见上方「区间概览」），但要点总结需要模型生成。
          请到「设置 → AI 大模型」确认已选好模型并填好 API Key，然后重新生成。
        </div>
        <div>
          <button type="button" className={css.ghostBtn} data-active="true" onClick={() => { onOpenSettings?.('ai') }}>
            去配置模型
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 输出格式 —— 与后端 `summary-prompt.ts` 的 `FORMAT_SPEC` 一一对应。
 *
 * 为什么要让用户选：改前只有一种「简洁要点」，模型有时写 3 行、有时写 800 字，
 * 用户不知道会得到什么。现在每种格式都有**明确字数区间**（见后端），
 * 选「详细」就是 400–700 字，选「要点」就是 6–10 条。
 */
export const FORMATS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'brief', label: '简洁', hint: '150–250 字' },
  { key: 'detailed', label: '详细', hint: '400–700 字' },
  { key: 'bullets', label: '要点', hint: '6–10 条' },
  { key: 'story', label: '叙事', hint: '300–500 字' },
]

/**
 * 工具栏：区间 + 格式下拉 + 生成 + 复制。
 *
 * 抽成独立组件是为了控制 `SummaryWorkbench` 的行数（250 行棘轮）——
 * 它本身是纯展示，状态全由工作台传入。
 * @param props - 区间、格式、加载态与各回调。
 * @returns 工具栏元素。
 */
export function SummaryToolbar({ from, to, format, loading, hasResult, rangeText, isSingleDay, onFrom, onTo, onFormat, onGenerate, onCopy }: {
  from: string
  to: string
  format: string
  loading: boolean
  hasResult: boolean
  rangeText: string
  isSingleDay: boolean
  onFrom: (v: string) => void
  onTo: (v: string) => void
  onFormat: (v: string) => void
  onGenerate: () => void
  onCopy: () => void
}): React.JSX.Element {
  const active = FORMATS.find(f => f.key === format)
  return (
    <div className={css.toolbar}>
      <DateRangeField
        from={from}
        to={to}
        onFrom={onFrom}
        onTo={onTo}
        presets={PRESETS}
        ariaLabel="总结区间"
        idFrom="sw-from"
        idTo="sw-to"
        className={css.toolbarRange}
      />
      {/* 格式收进「格式 ▾」下拉（原来一排 5 个 chip 占掉工具栏一半宽度）。 */}
      <label className={css.formatSelectWrap}>
        <span className={css.formatSelectLabel}>格式</span>
        <select
          className={css.formatSelect}
          value={format}
          aria-label="总结格式"
          title={active ? `${active.label}：${active.hint}` : '总结格式'}
          onChange={(e) => { onFormat(e.target.value) }}
        >
          {FORMATS.map(f => (
            <option key={f.key} value={f.key} title={f.hint}>{f.label}（{f.hint}）</option>
          ))}
        </select>
      </label>
      {/* 空态（还没有结果）时，主操作按钮在空态卡里；这里只在已有结果时提供「重新生成」。 */}
      {hasResult && (
        <button type="button" className={css.primaryBtn} onClick={onGenerate} disabled={loading || !from || !to}>
          {loading ? <><span className={css.spin} />生成中…</> : '重新生成'}
        </button>
      )}
      <button type="button" className={css.ghostBtn} onClick={onCopy} disabled={!hasResult}>复制</button>
      <span className={css.toolbarSpacer} />
      <span className={css.cardExtra} title={rangeText}>{rangeText}</span>
    </div>
  )
}

/**
 * 空态：一行引导 + 一个主按钮（微信化：不再铺三步大卡）。
 *
 * 三步文案压成一行，保留"选范围 → 生成 → 回看"的信息（行为判据仍在断言这三句）。
 * @param props.isSingleDay - 当前区间是否只有一天（决定按钮文案）。
 * @param props.modelReady - 模型是否已配置。
 * @param props.onOpenSettings - 打开设置弹窗。
 * @param props.onGenerate - 生成总结（空态的主操作）。
 * @returns 空态元素。
 */
export function SummaryEmpty({ isSingleDay, modelReady, onOpenSettings, onGenerate }: {
  isSingleDay: boolean
  modelReady: boolean
  onOpenSettings?: (section?: string) => void
  onGenerate?: () => void
}): React.JSX.Element {
  const go = isSingleDay ? '生成每日总结' : '生成周期总结'
  return (
    <div className={css.card}>
      <div className={css.empty}>
        <div className={css.emptyTitle}>还没有这一段的总结</div>
        <div className={css.emptyHint}>选好上面的时间范围，点「{go}」即可；结果自动存进历史，随时回看。</div>
        {/* 三步信息压成一行（不再是一张占满高度的三列卡） */}
        <div className={css.emptySteps}>选时间范围 → 生成总结 → 回看与复制</div>
        <div className={css.emptyActions}>
          <button type="button" className={css.primaryBtn} onClick={() => { onGenerate?.() }}>{go}</button>
          {!modelReady && (
            <button type="button" className={css.ghostBtn} data-active="true" onClick={() => { onOpenSettings?.('ai') }}>
              模型未配置 · 去配置
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 统计卡：一排大数字 + 24 小时分布 + Top 会话。
 * @param props.stats - 统计。
 * @param props.label - 区间标签（右上角）。
 * @param props.isSingleDay - 是否单日（24 小时分布只在单日有意义）。
 * @param props.nameOf - username → 显示名（拿不到就退回 username）。
 * @returns 统计卡元素。
 */
export function StatsCard({ stats, label, isSingleDay, nameOf }: {
  stats: Stats
  label: string
  isSingleDay: boolean
  nameOf?: (username: string) => string
}): React.JSX.Element {
  const hourMax = Math.max(1, ...stats.hourly)
  const topBase = stats.topSessions[0]?.count ?? 1
  const name = nameOf ?? ((u: string) => u)
  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <span className={css.cardTitle}>区间概览</span>
        <span className={css.cardExtra}>{label}</span>
      </div>
      <div className={css.cardBody}>
        <div className={css.stats}>
          <div className={css.stat}>
            <span className={css.statK}>消息总数</span>
            <span className={css.statV} data-tone="cyan">{stats.total.toLocaleString()}</span>
          </div>
          <div className={css.stat}>
            <span className={css.statK}>活跃会话</span>
            <span className={css.statV}>{stats.sessions}</span>
          </div>
          <div className={css.stat}>
            <span className={css.statK}>文本行</span>
            <span className={css.statV}>{stats.messages.toLocaleString()}</span>
          </div>
          {Object.entries(stats.types).slice(0, 3).map(([k, v]) => (
            <div key={k} className={css.stat}>
              <span className={css.statK}>{k}</span>
              <span className={css.statV}>{v}</span>
            </div>
          ))}
        </div>

        {/* 24 小时分布：只在单日时有意义（多日累加会抹平作息）。
            ⚠️ 高度用**平方根**归一化，不是线性 —— 实测本机凌晨 3 点 262 条、白天 20 条，
            线性刻度下白天只有 7% 高，几乎看不见（2026-10-17 真机截图确认）。
            平方根把 20/262 从 7.6% 抬到 27.6%，既保留"凌晨最多"的对比，又让白天可见。 */}
        {isSingleDay && stats.hourly.length === 24 && (
          <>
            <div className={css.hourChart}>
              {stats.hourly.map((n, h) => (
                <div key={h} className={css.hourCol} data-peak={n === hourMax && n > 0 ? 'true' : undefined} title={`${String(h)}:00 · ${String(n)} 条`}>
                  <div className={css.hourFill} style={{ height: `${String(Math.max(3, Math.sqrt(n / hourMax) * 100))}%` }} />
                </div>
              ))}
            </div>
            <div className={css.hourAxis}><span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
          </>
        )}

        {/* Top 会话 */}
        {stats.topSessions.slice(0, 5).map((s, i) => (
          <div key={s.username} className={css.barRow}>
            <span className={css.barLabel} title={s.username}>{i + 1}. {name(s.username)}</span>
            <div className={css.barTrack}>
              <div className={css.barFill} style={{ width: `${String((s.count / topBase) * 100)}%` }} />
            </div>
            <span className={css.barValue}>{s.count} 条</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 历史抽屉外壳（2026-10-19）：把「历史」从固定 320px 侧栏改成盖在面板上的抽屉。
 *
 * 纯展示 + 事件透传；Esc 关闭由调用方处理（与定时任务抽屉同一套交互）。
 * @param props.children - 内部渲染的 `HistoryPanel`。
 * @param props.onClose - 关闭抽屉。
 * @returns 抽屉元素。
 */
export function SummaryHistoryDrawer({ children, onClose }: {
  children: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className={css.historyDrawer} onClick={onClose} role="dialog" aria-modal="true" aria-label="历史总结">
      <div className={css.historyPanel} onClick={(e) => { e.stopPropagation() }}>
        {children}
      </div>
    </div>
  )
}

/**
 * 历史列表：筛选 + 记录（现在渲染在抽屉里，不再是固定 320px 侧栏）。
 * @param props.records - 已按筛选过滤的记录。
 * @param props.filter - 当前筛选。
 * @param props.onFilter - 改筛选。
 * @param props.activeId - 正在预览的记录 id。
 * @param props.onOpen - 打开一条记录。
 * @param props.onCopy - 复制一条记录。
 * @param props.onDelete - 删除一条记录。
 * @param props.onClose - 关闭抽屉（可选）。
 * @returns 历史列表元素。
 */
export function HistoryPanel({ records, filter, onFilter, activeId, onOpen, onCopy, onDelete, onClose }: {
  records: readonly SummaryRecord[]
  filter: 'all' | 'daily' | 'period'
  onFilter: (f: 'all' | 'daily' | 'period') => void
  activeId: number | null
  onOpen: (r: SummaryRecord) => void
  onCopy: (r: SummaryRecord) => void
  onDelete: (r: SummaryRecord) => void
  onClose?: () => void
}): React.JSX.Element {
  return (
    <div className={css.history}>
      <div className={css.historyHead}>
        <span className={css.historyTitle}>历史</span>
        <span className={css.historyCount}>{records.length}</span>
        <div className={css.historyFilter}>
          {([['all', '全部'], ['daily', '每日'], ['period', '周期']] as const).map(([k, label]) => (
            <button key={k} type="button" className={css.filterChip} data-active={filter === k || undefined} onClick={() => { onFilter(k) }}>{label}</button>
          ))}
        </div>
        {onClose && (
          <button type="button" className={css.iconBtn} onClick={onClose} aria-label="关闭历史" title="关闭">✕</button>
        )}
      </div>
      <div className={css.historyList}>
        {records.length === 0 && (
          <div className={css.empty}>
            <div className={css.emptyHint}>
              {filter === 'all'
                ? '生成过的总结会自动出现在这里'
                : `还没有${filter === 'daily' ? '每日' : '周期'}总结`}
            </div>
          </div>
        )}
        {records.map(r => {
          const kind = recordKind(r)
          return (
            <div
              key={r.id}
              className={css.historyItem}
              data-active={activeId === r.id || undefined}
              onClick={() => { onOpen(r) }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r) } }}
            >
              <div className={css.historyItemTop}>
                <span className={css.historyDate}>{r.summaryDate}</span>
                <span className={css.historyKind} data-kind={kind}>{kind === 'period' ? '周期' : '每日'}</span>
                <span className={css.historyActions}>
                  <button type="button" className={css.iconBtn} title="复制" onClick={(e) => { e.stopPropagation(); onCopy(r) }}>⧉</button>
                  <button type="button" className={css.iconBtn} data-danger="true" title="删除" onClick={(e) => { e.stopPropagation(); onDelete(r) }}>✕</button>
                </span>
              </div>
              <div className={css.historyMeta}>
                {r.messageCount} 条 · {fmtLocaleMs(r.createdAt)}
                {r.status !== 'done' && ` · ${r.status}`}
              </div>
              <div className={css.historyPreview}>{r.summary.slice(0, 60)}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
