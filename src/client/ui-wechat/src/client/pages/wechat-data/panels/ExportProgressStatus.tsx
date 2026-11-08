/**
 * 所有导出入口共用的一张状态卡。
 *
 * 运行中显示后端阶段、真实 done/total 与百分比；成功、失败、取消都沿用同一块位置，
 * 不再由每个面板各画一套。`total <= 0` 时必须走不定量进度，不能把“总量未知”画成 0%。
 *
 * @module panels/ExportProgressStatus
 */
import { ProgressBar } from '../ui/kit.tsx'
import css from './export-progress.module.css'
import type { ExportTaskProgress, ExportTaskState } from './export-task.ts'

const PHASE_LABEL: Record<string, string> = {
  prepare: '准备导出',
  collect: '正在收集数据',
  format: '正在生成内容',
  write: '正在写入文件',
  'write-bytes': '正在写入字节',
  files: '正在处理文件',
  sessions: '正在导出会话',
  batch: '正在批量导出会话',
  media: '正在处理媒体',
  zip: '正在打包文件',
  'zip-write': '正在写入压缩包',
  encrypt: '正在加密备份',
  locate: '正在定位原文件',
  read: '正在读取原文件',
  copy: '正在复制原文件',
  verify: '正在校验原文件',
  compress: '正在压缩',
  scan: '正在扫描',
  segment: '正在分段处理',
  local: '正在本地生成',
  finalizing: '正在收尾',
}

const PHASE_UNIT: Record<string, string> = {
  collect: '条',
  format: '条',
  write: '个文件',
  'write-bytes': '字节',
  files: '项',
  sessions: '个会话',
  batch: '个会话',
  media: '项',
  locate: '项',
  read: '项',
  copy: '字节',
  verify: '字节',
  compress: '字节',
  'zip-write': '字节',
  encrypt: '字节',
}

/** 后端 phase → 界面文案。未知 phase 原样显示，避免新阶段被吞成“导出中”。 */
export function exportPhaseLabel(phase: string): string {
  const key = phase.trim()
  if (key === '') return '导出中'
  return PHASE_LABEL[key] ?? key
}

/** 只有后端给出总量时才显示确定百分比；否则返回 null 走不定量态。 */
export function exportProgressPercent(progress: ExportTaskProgress | null): number | null {
  if (!progress || progress.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)))
}

/** 完成数文案按阶段选择单位；总量未知时只报已完成数。 */
export function exportProgressDetail(progress: ExportTaskProgress | null): string {
  if (!progress) return ''
  const phase = exportPhaseLabel(progress.phase)
  const unit = PHASE_UNIT[progress.phase] ?? '条'
  const count = progress.total > 0
    ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} ${unit}`
    : `${progress.done.toLocaleString()} ${unit}`
  return `${phase} · ${count}`
}

function statusTitle(state: ExportTaskState, finishing: boolean): string {
  if (state.status === 'success') return '导出完成'
  if (state.status === 'error') return '导出失败'
  if (state.status === 'canceled') return '已取消'
  if (finishing) return '正在收尾'
  return state.label || '导出中'
}

/**
 * 统一导出状态卡。
 * @param props.state - `useExportTask()` 的状态。
 * @param props.onCancel - 运行中显示取消入口；本地即时操作不传。
 * @param props.compact - 紧凑模式，用于工具行/弹窗内部。
 */
export function ExportProgressStatus({
  state,
  onCancel,
  compact = false,
}: {
  state: ExportTaskState
  onCancel?: () => void
  compact?: boolean
}): React.JSX.Element | null {
  if (state.status === 'idle') return null

  const progress = state.progress
  const percent = exportProgressPercent(progress)
  const finishing = state.status === 'running'
    && progress !== null
    && progress.total > 0
    && progress.done >= progress.total
  const showProgress = state.status === 'running'

  return (
    <div
      className={`${css.box} ${compact ? css.compact : ''}`}
      data-export-status={state.status}
      data-export-exclude=""
      role="status"
      aria-live="polite"
    >
      <div className={css.head}>
        <span className={css.title}>{statusTitle(state, finishing)}</span>
        {showProgress && percent !== null && <span className={css.percent}>{String(percent)}%</span>}
        {showProgress && onCancel && state.cancelable && (
          <button
            type="button"
            className={css.cancel}
            onClick={(event) => { event.stopPropagation(); onCancel() }}
            disabled={state.canceling}
          >
            {state.canceling ? '正在取消…' : '取消导出'}
          </button>
        )}
      </div>
      {showProgress && <ProgressBar value={percent ?? 0} indeterminate={percent === null} />}
      {showProgress && progress && <span className={css.detail}>{exportProgressDetail(progress)}</span>}
      {state.message && <span className={css.detail}>{state.message}</span>}
    </div>
  )
}
