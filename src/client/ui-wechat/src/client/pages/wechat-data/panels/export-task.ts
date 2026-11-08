/**
 * 导出任务的统一生命周期。
 *
 * 所有真正落盘的导出（会话、朋友圈、CSV、年度报告、全部会话、历史重放）都走这里：
 * 生成 jobId、认领 `wechat-export/progress`、推送静默时用 `getExportProgress` 兜底、
 * 发起取消，并把 Promise 的最终结果收敛成 running / success / error / canceled 四种状态。
 *
 * 面板不再各自维护事件监听与 jobId。这样既不会漏掉某个入口，也不会出现
 * 「进度到了 100%，按钮还停在导出中」这种各写一套收尾逻辑造成的不一致。
 *
 * @module panels/export-task
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiCancelExportJob } from '../api.ts'
import { useExportProgressRelay } from './export-progress-relay.ts'

export type ExportTaskStatus = 'idle' | 'running' | 'success' | 'error' | 'canceled'

export interface ExportTaskProgress {
  phase: string
  done: number
  total: number
}

export interface ExportTaskState {
  status: ExportTaskStatus
  label: string
  progress: ExportTaskProgress | null
  message: string
  canceling: boolean
  cancelable: boolean
}

export interface ExportTaskRunOptions<T> {
  /** jobId 前缀，便于日志与真机验收按入口区分。 */
  idPrefix: string
  /** 状态卡上的人类可读任务名，例如「导出聊天记录」。 */
  label: string
  /** Promise 成功后的回执。 */
  successMessage: (result: T) => string
  /** 可选的起始阶段；默认是“准备导出”，总量未知。 */
  progress?: ExportTaskProgress
  /** 本地截图/即时下载没有后端 jobId，不显示取消。 */
  cancelable?: boolean
  /**
   * 多步任务（例如逐会话批量导出）在两次后端调用之间也能响应取消。
   * 开启后，取消 RPC 即使恰好落在两个子任务之间，也会由 worker 在下个检查点收尾。
   */
  cooperativeCancel?: boolean
}

export interface ExportTaskContext {
  /** 当前整条任务的逻辑标识；单次后端调用直接使用它。 */
  jobId: string
  /**
   * 多步任务切换到当前后端子任务时调用。
   * 进度事件只认这个标识，避免上一项迟到的进度覆盖下一项或批量汇总。
   */
  bindJobId: (jobId: string) => void
  /** 当前是否已经收到用户的取消请求；批量循环应在每个 await 后检查。 */
  cancelRequested: () => boolean
  /** 批量任务可在两次后端调用之间上报整体进度。 */
  report: (progress: ExportTaskProgress) => void
}

export type ExportTaskResult<T> =
  | { ok: true; result: T; message: string }
  | { ok: false; canceled: boolean; error: string; message: string }

export interface ExportTask {
  state: ExportTaskState
  running: boolean
  /** 进度已到总量，但 Promise 尚未返回；按钮应显示“完成中”而不是“导出中”。 */
  finishing: boolean
  run: <T>(
    worker: (ctx: ExportTaskContext) => Promise<T>,
    options: ExportTaskRunOptions<T>,
  ) => Promise<ExportTaskResult<T>>
  cancel: () => Promise<void>
  reset: () => void
}

const IDLE_STATE: ExportTaskState = {
  status: 'idle',
  label: '',
  progress: null,
  message: '',
  canceling: false,
  cancelable: false,
}

/** 后端取消口径与前端提示共用这一条判断。 */
export function isCanceledExportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /取消|cancel|abort/i.test(message)
}

function normalizeProgress(progress: ExportTaskProgress): ExportTaskProgress {
  const count = (value: number): number => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, n) : 0
  }
  return {
    phase: String(progress.phase ?? ''),
    done: count(progress.done),
    total: count(progress.total),
  }
}

function nextJobId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${String(Date.now())}-${String(Math.random()).slice(2)}`
  return `${prefix}-${suffix}`
}

/**
 * 管理一个面板内同一时刻唯一的一条导出任务。
 *
 * 同一面板的多个导出按钮共用一个实例即可：后一次 `run` 会替换上一次的终态；
 * 正在运行时再次调用会直接返回“已有任务进行中”，避免两个任务同时抢同一张进度卡。
 */
export function useExportTask(): ExportTask {
  const [state, setState] = useState<ExportTaskState>(IDLE_STATE)
  const jobRef = useRef('')
  const backendJobRef = useRef('')
  const cancelRequestedRef = useRef(false)
  const localRef = useRef(false)
  const cooperativeCancelRef = useRef(false)

  const setProgress = useCallback((progress: ExportTaskProgress): void => {
    const jobId = jobRef.current
    if (!jobId) return
    setState((prev) => {
      if (jobRef.current !== jobId || prev.status !== 'running') return prev
      return { ...prev, progress: normalizeProgress(progress) }
    })
  }, [])

  const notePush = useExportProgressRelay(backendJobRef, (sample) => {
    setProgress(sample)
  })

  useEffect(() => {
    const onProgress = (event: Event): void => {
      const detail = (event as CustomEvent<{
        jobId?: string
        phase?: string
        done?: number
        total?: number
      }>).detail
      if (!detail || !backendJobRef.current || detail.jobId !== backendJobRef.current) return
      setProgress({
        phase: String(detail.phase ?? ''),
        done: Number(detail.done ?? 0),
        total: Number(detail.total ?? 0),
      })
      notePush()
    }
    window.addEventListener('dsh-wechat-export-progress', onProgress)
    return (): void => { window.removeEventListener('dsh-wechat-export-progress', onProgress) }
  }, [notePush, setProgress])

  const run = useCallback(async function runExport<T>(
    worker: (ctx: ExportTaskContext) => Promise<T>,
    options: ExportTaskRunOptions<T>,
  ): Promise<ExportTaskResult<T>> {
    if (jobRef.current !== '') {
      const busy = '已有导出任务进行中'
      return { ok: false, canceled: false, error: busy, message: busy }
    }

    const jobId = nextJobId(options.idPrefix)
    jobRef.current = jobId
    backendJobRef.current = jobId
    cancelRequestedRef.current = false
    localRef.current = options.cancelable === false
    cooperativeCancelRef.current = options.cooperativeCancel === true
    setState({
      status: 'running',
      label: options.label,
      progress: normalizeProgress(options.progress ?? { phase: 'prepare', done: 0, total: 0 }),
      message: '',
      canceling: false,
      cancelable: options.cancelable !== false,
    })

    const report = (progress: ExportTaskProgress): void => { setProgress(progress) }
    const bindJobId = (nextJobId: string): void => {
      if (jobRef.current === jobId && nextJobId !== '') backendJobRef.current = nextJobId
    }
    const cancelRequested = (): boolean => jobRef.current === jobId && cancelRequestedRef.current
    try {
      const result = await worker({ jobId, bindJobId, cancelRequested, report })
      const message = options.successMessage(result)
      if (jobRef.current === jobId) {
        jobRef.current = ''
        backendJobRef.current = ''
        cancelRequestedRef.current = false
        localRef.current = false
        cooperativeCancelRef.current = false
        setState({
          status: 'success',
          label: options.label,
          progress: null,
          message,
          canceling: false,
          cancelable: false,
        })
      }
      return { ok: true, result, message }
    } catch (error) {
      const canceled = cancelRequestedRef.current || isCanceledExportError(error)
      const detail = error instanceof Error ? error.message : String(error ?? '未知错误')
      if (jobRef.current === jobId) {
        jobRef.current = ''
        backendJobRef.current = ''
        cancelRequestedRef.current = false
        localRef.current = false
        cooperativeCancelRef.current = false
        setState({
          status: canceled ? 'canceled' : 'error',
          label: options.label,
          progress: null,
          message: canceled ? '任务已停止' : detail,
          canceling: false,
          cancelable: false,
        })
      }
      return {
        ok: false,
        canceled,
        error: detail,
        message: canceled ? '任务已停止' : detail,
      }
    }
  }, [setProgress])

  const cancel = useCallback(async (): Promise<void> => {
    if (!jobRef.current || localRef.current || cancelRequestedRef.current) return
    const jobId = backendJobRef.current
    cancelRequestedRef.current = true
    setState((prev) => prev.status === 'running' ? { ...prev, canceling: true, message: '' } : prev)
    // 批量任务可能恰好在两个后端调用之间：worker 会在下个检查点本地收尾。
    if (!jobId) return
    try {
      const result = await apiCancelExportJob(jobId)
      if (!result.ok && backendJobRef.current === jobId) {
        const detail = result.error || '后端未接受取消请求'
        if (cooperativeCancelRef.current) {
          setState((prev) => prev.status === 'running'
            ? { ...prev, message: `取消请求未送达：${detail}；将在当前步骤结束后停止` }
            : prev)
        } else {
          cancelRequestedRef.current = false
          setState((prev) => prev.status === 'running'
            ? { ...prev, canceling: false, message: `取消失败：${detail}` }
            : prev)
        }
      }
    } catch (error) {
      // 取消失败不伪造成“已取消”：等 RPC 自己收尾，按钮恢复为可再次尝试。
      // 多步任务的取消请求仍由 worker 的下一个检查点兑现，因此保留该标记。
      const detail = error instanceof Error ? error.message : String(error ?? '未知错误')
      if (backendJobRef.current === jobId) {
        if (cooperativeCancelRef.current) {
          setState((prev) => prev.status === 'running'
            ? { ...prev, message: `取消请求未送达：${detail}；将在当前步骤结束后停止` }
            : prev)
        } else {
          cancelRequestedRef.current = false
          setState((prev) => prev.status === 'running'
            ? { ...prev, canceling: false, message: `取消失败：${detail}` }
            : prev)
        }
      }
    }
  }, [])

  const reset = useCallback((): void => {
    if (jobRef.current !== '') return
    setState(IDLE_STATE)
  }, [])

  const finishing = state.status === 'running'
    && state.progress !== null
    && state.progress.total > 0
    && state.progress.done >= state.progress.total

  return {
    state,
    running: state.status === 'running',
    finishing,
    run,
    cancel,
    reset,
  }
}
