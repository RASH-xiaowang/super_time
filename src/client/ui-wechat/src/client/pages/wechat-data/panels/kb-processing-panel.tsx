/**
 * 文档处理实时状态面板。
 *
 * 这里合并两类**不同来源**的状态，并明确标注：
 *   · 解析队列：来自 `KbFileMeta.parseState`，是后端真实状态（会随轮询推进）；
 *   · AI 批量任务：来自前端串行队列，只有排队 / 处理中 / 完成 / 失败，没有百分比。
 *
 * 不把两者混成一个「总进度」：解析是本地队列，摘要 / 实体是模型调用，速度与失败
 * 原因完全不同。混在一起会让用户以为所有文件都在同一条流水线上。
 *
 * 面板由工具栏的状态按钮唤出，显示在右侧抽屉里；关闭抽屉只收起视图，
 * 不会中断正在运行的解析轮询或模型批量任务。
 *
 * @module kb-processing-panel
 */
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Drawer } from '../ui/kit.tsx'
import type { KbFileMeta } from '../types.ts'
import {
  batchRunSummary,
  batchStatusLabel,
  tallyBatchRun,
  type KbBatchRun,
} from './kb-batch-jobs.ts'
import { PARSE_LOOK } from './kb-files-support.tsx'
import css from './kb-processing.module.css'

/** 状态面板道具。 */
export interface KbProcessingPanelProps {
  files: readonly KbFileMeta[]
  batch: KbBatchRun | null
  /** 正在执行批量动作的文件 id，用于列表行高亮。 */
  runningId: number | null
  /** 当前是否有批量动作在执行（含取消请求后等待当前文件结束）。 */
  busy: boolean
  /** 批量任务启动 / 重试失败时的原因（不是单文件失败）。 */
  error: string | null
  onCancel: () => void
  onRetryFailed: () => void
  onDismiss: () => void
  onSelectFile: (fileId: number) => void
}

/** 工具栏入口与右侧抽屉的组合道具。 */
export interface KbProcessingDrawerProps extends KbProcessingPanelProps {
  /** 新的处理工作出现时自动展开；用户主动收起后不再强行弹出。 */
  autoOpen?: boolean
}

/** 文件面板工具栏需要转交给处理抽屉的批量状态。 */
export interface KbProcessingEntryProps {
  files: readonly KbFileMeta[]
  batchJobs: {
    run: KbBatchRun | null
    runningId: number | null
    error: string | null
    cancel: () => void
    retryFailed: () => Promise<void>
    dismiss: () => void
  }
  onSelectFile: (fileId: number) => void
}

/** 解析阶段的短标签与统计。 */
function parseTally(files: readonly KbFileMeta[]): {
  pending: number
  ready: number
  attention: number
  details: Array<{ f: KbFileMeta; label: string }>
  issues: Array<{ f: KbFileMeta; label: string; reason: string }>
} {
  let pending = 0
  let ready = 0
  let attention = 0
  const details: Array<{ f: KbFileMeta; label: string }> = []
  const issues: Array<{ f: KbFileMeta; label: string; reason: string }> = []
  for (const f of files) {
    const look = PARSE_LOOK[f.parseState]
    if (look.pending) {
      pending += 1
      details.push({ f, label: look.label })
    } else if (look.attention) {
      attention += 1
      issues.push({ f, label: look.label, reason: f.parseError || look.hint })
    } else {
      ready += 1
    }
  }
  return { pending, ready, attention, details, issues }
}

/**
 * 文档处理实时状态面板。
 * @param props - 文件快照与批量队列状态。
 * @returns 状态面板；没有文件时不渲染。
 */
function KbProcessingBody({
  files, batch, runningId, busy, error, onCancel, onRetryFailed, onDismiss, onSelectFile,
}: KbProcessingPanelProps): React.JSX.Element | null {
  if (files.length === 0) return null
  const parse = parseTally(files)
  const tally = batch === null ? null : tallyBatchRun(batch)
  const hasBatch = batch !== null && tally !== null
  const hasWork = parse.pending > 0 || (hasBatch && !batch.canceled && tally.queued + tally.running > 0)
  const hasFailed = tally !== null && tally.failed > 0

  return (
    <section className={css.processing} aria-label="文档处理状态" aria-busy={hasWork}>
      {error !== null && <div className={css.processingError} role="alert">{error}</div>}
      <div className={css.processingHead}>
        <div className={css.processingTitle}>
          <span className={css.processingPulse} data-on={hasWork ? '1' : undefined} aria-hidden="true" />
          实时进度
          <span className={css.processingMeta}>
            {parse.pending > 0
              ? `解析中 ${parse.pending} 份`
              : parse.attention > 0 ? `需注意 ${parse.attention} 份` : `已就绪 ${parse.ready} 份`}
            {hasBatch && ` · ${batch.action === 'summary' ? '摘要' : '实体'} ${String(tally.done)}/${String(tally.total)}`}
          </span>
        </div>
        <div className={css.processingActions}>
          {busy && (
            <Button size="sm" variant="outline" onClick={onCancel}>停止后续</Button>
          )}
          {!busy && hasFailed && (
            <Button size="sm" variant="outline" onClick={onRetryFailed}>重试失败项</Button>
          )}
          {!busy && hasBatch && (
            <Button size="sm" variant="ghost" onClick={onDismiss}>收起记录</Button>
          )}
        </div>
      </div>

      {parse.details.length > 0 && (
        <div className={css.processingSection}>
          <div className={css.processingLabel}>
            解析队列
            <span className={css.processingCount}>{String(parse.details.length)} 份未结束</span>
          </div>
          <ul className={css.processingList}>
            {parse.details.slice(0, 8).map(({ f, label }) => (
              <li key={f.id} className={css.processingItem}>
                <button type="button" className={css.processingFile} onClick={() => { onSelectFile(f.id) }}>
                  <span className={css.processingFileName} title={f.name}>{f.name}</span>
                  <Badge tone={PARSE_LOOK[f.parseState].tone}>{label}</Badge>
                </button>
              </li>
            ))}
          </ul>
          {parse.details.length > 8 && (
            <div className={css.processingMore}>另有 {parse.details.length - 8} 份在队列中，左侧列表可查看全部。</div>
          )}
        </div>
      )}

      {parse.issues.length > 0 && (
        <details className={css.processingSection} open>
          <summary className={css.processingLabel}>
            需要处理
            <span className={css.processingCount}>{String(parse.issues.length)} 份</span>
          </summary>
          <ul className={css.processingList}>
            {parse.issues.slice(0, 8).map(({ f, label, reason }) => (
              <li key={f.id} className={css.processingItem}>
                <button type="button" className={css.processingFile} onClick={() => { onSelectFile(f.id) }}>
                  <span className={css.processingFileName} title={f.name}>{f.name}</span>
                  <Badge tone={PARSE_LOOK[f.parseState].tone}>{label}</Badge>
                </button>
                <span className={css.processingDetail} title={reason}>{reason}</span>
              </li>
            ))}
          </ul>
          {parse.issues.length > 8 && (
            <div className={css.processingMore}>另有 {parse.issues.length - 8} 份需要处理，左侧列表可查看全部。</div>
          )}
        </details>
      )}

      {batch !== null && tally !== null && (
        <div className={css.processingSection}>
          <div className={css.processingLabel}>
            {batch.action === 'summary' ? '批量摘要' : '批量提取实体'}
            <span className={css.processingCount}>{batchRunSummary(batch)}</span>
          </div>
          <div className={css.processingProgress} role="progressbar" aria-valuemin={0} aria-valuemax={tally.total} aria-valuenow={tally.done}>
            <div className={css.processingBar} style={{ width: `${tally.total === 0 ? 0 : (tally.done / tally.total) * 100}%` }} />
          </div>
          <ul className={css.processingList}>
            {batch.items.map((it) => (
              <li key={it.fileId} className={css.processingItem} data-running={it.fileId === runningId ? '1' : undefined}>
                <button type="button" className={css.processingFile} onClick={() => { onSelectFile(it.fileId) }}>
                  <span className={css.processingFileName} title={it.name}>{it.name}</span>
                  <span className={css.processingState} data-status={it.status}>{batchStatusLabel(it.status)}</span>
                </button>
                {it.detail !== '' && <span className={css.processingDetail}>{it.detail}</span>}
                {it.error !== '' && <span className={css.processingError}>{it.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * 工具栏处理状态入口与右侧抽屉。
 *
 * 状态计算与列表渲染仍由 `KbProcessingBody` 负责；这一层只处理「何时打开」，
 * 让文件面板不必新增一个展开布尔值。抽屉关闭不影响批量队列继续推进。
 * @param props - 与状态面板相同，另含是否在出现新工作时自动展开。
 * @returns 工具栏按钮与抽屉。
 */
export function KbProcessingDrawer({
  autoOpen = true, ...props
}: KbProcessingDrawerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const closingRef = useRef(false)
  const parse = parseTally(props.files)
  const tally = props.batch === null ? null : tallyBatchRun(props.batch)
  const hasWork = parse.pending > 0
    || (tally !== null && props.batch !== null && !props.batch.canceled && tally.queued + tally.running > 0)
  const hasFailed = tally !== null && tally.failed > 0
  const statusLabel = parse.pending > 0
    ? `解析中 ${parse.pending}`
    : tally !== null && props.batch !== null && tally.done < tally.total
      ? `${props.batch.action === 'summary' ? '摘要' : '实体'} ${tally.done}/${tally.total}`
      : parse.attention > 0 ? `需注意 ${parse.attention}` : `已就绪 ${parse.ready}`
  const signature = [
    props.files.length, parse.pending, parse.attention, parse.ready,
    props.batch?.action ?? '', tally?.done ?? 0, tally?.total ?? 0, tally?.failed ?? 0,
  ].join(':')

  useEffect(() => {
    if (hasWork) closingRef.current = false
  }, [hasWork, signature])

  useEffect(() => {
    if (!autoOpen || !hasWork || closingRef.current) return
    setOpen(true)
  }, [autoOpen, hasWork, signature])

  const close = (): void => {
    closingRef.current = true
    setOpen(false)
  }

  return (
    <>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-controls="kb-processing-drawer"
        onClick={() => { if (open) close(); else setOpen(true) }}
        title="查看文档解析与批量处理进度"
      >
        <span className={css.entryPulse} data-on={hasWork ? '1' : undefined} aria-hidden="true" />
        处理状态
        <span className={css.entryBadge} data-tone={hasFailed ? 'bad' : undefined}>{statusLabel}</span>
      </Button>
      {open && (
        <div id="kb-processing-drawer">
          <Drawer open onClose={close} title="文档处理状态" width={480}>
            <KbProcessingBody {...props} />
          </Drawer>
        </div>
      )}
    </>
  )
}

/**
 * 文件面板工具栏里的处理状态入口。
 *
 * 把六个逐项传递的 props 收成一处，主面板只留一行；这样工具栏加入口不会把
 * `KbFilesPanel` 推过已有的函数行数棘轮。
 * @param props - 文件快照、批量队列与选中回调。
 * @returns 处理状态按钮和它唤出的抽屉。
 */
export function KbProcessingEntry({
  files, batchJobs, onSelectFile,
}: KbProcessingEntryProps): React.JSX.Element | null {
  return (
    <KbProcessingDrawer
      files={files}
      batch={batchJobs.run}
      runningId={batchJobs.runningId}
      busy={batchJobs.runningId !== null}
      error={batchJobs.error}
      onCancel={batchJobs.cancel}
      onRetryFailed={() => { void batchJobs.retryFailed() }}
      onDismiss={batchJobs.dismiss}
      onSelectFile={onSelectFile}
    />
  )
}
