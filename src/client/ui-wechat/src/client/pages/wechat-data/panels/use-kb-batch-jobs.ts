/**
 * 文件批量动作的执行 hook（摘要 / 实体抽取）。
 *
 * 顺序、失败隔离与计数都在 `kb-batch-jobs.ts` 的纯模型里；这里只负责把模型
 * 调用接进去，并在 React 状态下逐步推进。关键边界：
 *   · 一次只发一个模型请求（串行）；
 *   · 每个文件先落 `running` 再发请求，界面不会提前报「处理中」；
 *   · 错误只记到当前条目，队列继续；
 *   · 动作开始时再筛一遍出网开关，文件列表在弹确认框期间也可能变。
 *
 * @module use-kb-batch-jobs
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiExtractKbEntities, apiSummarizeKbFile } from '../api.ts'
import type { KbFileMeta } from '../types.ts'
import {
  batchRunFinished,
  batchRunSummary,
  cancelBatchRun,
  createBatchRun,
  nextBatchIndex,
  patchBatchItem,
  pickBatchFiles,
  retryFailedBatchItems,
  skipQueuedItems,
  type KbBatchAction,
  type KbBatchOutcome,
  type KbBatchRun,
  type KbBatchScope,
} from './kb-batch-jobs.ts'

/** 一次批量动作的候选与作用域。 */
export interface KbBatchRequest {
  action: KbBatchAction
  scope: KbBatchScope
}

/** 批量动作的可观察状态。 */
export interface KbBatchJobsState {
  run: KbBatchRun | null
  /** 当前正在执行的文件 id（供列表行高亮）。 */
  runningId: number | null
  /** 启动失败（不是单文件失败）。 */
  error: string | null
  start: (request: KbBatchRequest, files: readonly KbFileMeta[]) => Promise<void>
  retryFailed: () => Promise<void>
  cancel: () => void
  dismiss: () => void
}

/**
 * 执行一个文件的批量动作。
 * @param kbId - 当前知识库。
 * @param action - 摘要或实体。
 * @param f - 目标文件。
 * @returns 归一化后的成功 / 失败结果。
 */
async function runOne(kbId: number, action: KbBatchAction, f: KbFileMeta): Promise<KbBatchOutcome> {
  if (action === 'summary') {
    const r = await apiSummarizeKbFile(kbId, f.id)
    return r.ok ? { status: 'ok' } : { status: 'failed', error: r.error ?? '生成摘要失败' }
  }
  const r = await apiExtractKbEntities(kbId, { fileIds: [f.id], limit: 1 })
  if (!r.ok) {
    return { status: 'failed', error: r.error ?? r.failed[0]?.error ?? '实体提取失败' }
  }
  // 0 条不是「成功但没东西」：它通常意味着模型没输出正文或格式全坏。
  // 新后端会直接回 ok:false；这里仍兜住旧版后端的 ok:true + saved:0，避免面板误报已完成。
  if (r.saved <= 0) {
    return { status: 'failed', error: r.error ?? r.failed[0]?.error ?? '模型没有返回可入库的实体' }
  }
  return { status: 'ok', detail: `写入 ${r.saved} 个实体` }
}

/**
 * 批量摘要 / 实体抽取的协调器。
 *
 * 新动作启动时会把上一轮未完成队列标成跳过，而不是直接丢弃：
 * 用户至少能看到「上一轮是被新动作取代的」。
 *
 * @param kbId - 当前知识库。
 * @param deps - 成功提示与文件列表重载。
 * @returns 启动、取消、关闭与当前队列。
 */
export function useKbBatchJobs(kbId: number, deps: {
  flash: (msg: string) => void
  /** 每完成一份就静默重取列表，让摘要 / 实体进度无需手动刷新即可出现。 */
  reload: () => Promise<void>
}): KbBatchJobsState {
  const { flash, reload } = deps
  const [run, setRun] = useState<KbBatchRun | null>(null)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 执行器读取取消状态：`cancel()` 只改 state，不会改正在跑的那个局部变量。 */
  const canceledRef = useRef(false)
  /** 当前是第几代任务。切库 / 新任务启动后，旧循环的后续回写全部作废。 */
  const generationRef = useRef(0)
  /** 当前库 id，供异步任务回来时判断是否已经切库。 */
  const kbIdRef = useRef(kbId)
  kbIdRef.current = kbId
  /** 文件快照：重试时用同一份候选；执行器内部用 ref 读取，不把整段循环写两遍。 */
  const filesRef = useRef<readonly KbFileMeta[]>([])

  useEffect(() => {
    generationRef.current += 1
    canceledRef.current = true
    setRun(null)
    setRunningId(null)
    setError(null)
  }, [kbId])

  const cancel = useCallback((): void => {
    canceledRef.current = true
    setRun(prev => (prev === null ? prev : skipQueuedItems(cancelBatchRun(prev), '已取消，尚未执行')))
  }, [])

  const dismiss = useCallback((): void => {
    if (runningId !== null) return
    setRun(null)
    setError(null)
  }, [runningId])

  const start = useCallback(async (request: KbBatchRequest, files: readonly KbFileMeta[]): Promise<void> => {
    filesRef.current = files
    const picked = pickBatchFiles(files, request.action, request.scope)
    if (picked.length === 0) {
      setError(request.action === 'summary' ? '没有可生成摘要的文件' : '没有可提取实体的文件')
      return
    }

    setError(null)
    // 新动作会取代上一轮：把尚未执行的项明确标成跳过，而不是让旧面板永远停在排队中。
    setRun(prev => (prev === null ? prev : skipQueuedItems(cancelBatchRun(prev), '已被新的批量任务取代')))
    generationRef.current += 1
    const generation = generationRef.current
    canceledRef.current = false
    const currentKbId = kbId
    const isCurrent = (): boolean => generationRef.current === generation
    let current = createBatchRun(picked, request.action)
    setRun(current)

    for (;;) {
      // 取消可能发生在正在跑的请求途中；回来后才在循环顶部统一收口。
      if (!isCurrent()) return
      const index = canceledRef.current ? -1 : nextBatchIndex(current)
      if (index < 0) {
        if (canceledRef.current) {
          current = skipQueuedItems(current, '已取消，尚未执行')
          setRun(current)
        }
        break
      }
      const item = current.items[index]
      if (item === undefined) break
      current = patchBatchItem(current, index, { status: 'running' })
      setRunningId(item.fileId)
      setRun(current)

      const f = picked.find(x => x.id === item.fileId)
      if (f === undefined) {
        current = patchBatchItem(current, index, { status: 'skipped', error: '文件已不在当前列表' })
        setRun(current)
        continue
      }

      try {
        const outcome = await runOne(kbId, request.action, f)
        if (!isCurrent()) return
        current = outcome.status === 'ok'
          ? patchBatchItem(current, index, { status: 'ok', detail: outcome.detail ?? '' })
          : patchBatchItem(current, index, { status: 'failed', error: outcome.error })
      } catch (e) {
        if (!isCurrent()) return
        current = patchBatchItem(current, index, { status: 'failed', error: (e as Error).message })
      }
      setRun(current)
      if (isCurrent()) await reload()
    }

    if (!isCurrent()) return
    setRunningId(null)
    // 即使被取消，已完成的摘要 / 实体也已经落库，必须刷新列表。
    if (currentKbId === kbIdRef.current) await reload()
    if (isCurrent() && batchRunFinished(current)) flash(batchRunSummary(current))
  }, [flash, kbId, reload])

  const retryFailed = useCallback(async (): Promise<void> => {
    if (run === null || runningId !== null) return
    const retried = retryFailedBatchItems(run)
    if (retried === run) return
    const files = filesRef.current
    // 重试目标是用户明确要求再跑一次的失败项，不能再按「只补缺摘要」筛掉。
    const picked = pickBatchFiles(files, run.action, 'all-rag')
    // 失败项可能因为出网开关在期间被关掉而不再合格：这不叫重试失败，要明确跳过。
    const eligible = new Set(picked.map(f => f.id))
    const retriedItems: KbBatchRun['items'] = retried.items.map((it) => {
      if (it.status !== 'queued') return it
      return eligible.has(it.fileId)
        ? it
        : { ...it, status: 'skipped' as const, error: '文件已关闭出网或已不满足条件' }
    })
    generationRef.current += 1
    const generation = generationRef.current
    canceledRef.current = false
    const isCurrent = (): boolean => generationRef.current === generation
    let nextRun: KbBatchRun = { ...retried, items: retriedItems }
    setRun(nextRun)
    const pickedById = new Map(picked.map(f => [f.id, f]))
    for (;;) {
      if (!isCurrent()) return
      const index = canceledRef.current ? -1 : nextBatchIndex(nextRun)
      if (index < 0) {
        if (canceledRef.current) {
          nextRun = skipQueuedItems(nextRun, '已取消，尚未执行')
          setRun(nextRun)
        }
        break
      }
      const item = nextRun.items[index]
      if (item === undefined) break
      nextRun = patchBatchItem(nextRun, index, { status: 'running' })
      setRunningId(item.fileId)
      setRun(nextRun)
      const f = pickedById.get(item.fileId)
      if (f === undefined) {
        nextRun = patchBatchItem(nextRun, index, { status: 'skipped', error: '文件已不在当前列表' })
        setRun(nextRun)
        continue
      }
      try {
        const outcome = await runOne(kbId, run.action, f)
        if (!isCurrent()) return
        nextRun = outcome.status === 'ok'
          ? patchBatchItem(nextRun, index, { status: 'ok', detail: outcome.detail ?? '' })
          : patchBatchItem(nextRun, index, { status: 'failed', error: outcome.error })
      } catch (e) {
        if (!isCurrent()) return
        nextRun = patchBatchItem(nextRun, index, { status: 'failed', error: (e as Error).message })
      }
      setRun(nextRun)
      if (isCurrent()) await reload()
    }
    if (!isCurrent()) return
    setRunningId(null)
    await reload()
    if (isCurrent()) flash(batchRunSummary(nextRun))
  }, [flash, kbId, reload, run, runningId])

  return { run, runningId, error, start, retryFailed, cancel, dismiss }
}
