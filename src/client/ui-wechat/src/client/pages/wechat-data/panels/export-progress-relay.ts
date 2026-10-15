/**
 * 进度中继的「拉推结合」兜底（W2-10.4）。
 *
 * ## 为什么需要它
 *
 * 回调与 AbortSignal 都过不了 IPC，所以后端只能把导出进度**推**出来：
 * `wechat-export/progress` → ui-entry 中继成 DOM 事件 `dsh-wechat-export-progress`。
 * 这条路任何一环断了（中继没装上、监听器比第一条事件晚挂、HMR 重挂、面板卸载过一轮），
 * 表现都是**进度条永远停在 null**，而后端那边任务跑得好好的 —— 用户看到的是
 * 「点了导出，什么都没有」，也不会报错。
 *
 * 后端一直有 `getExportProgress(jobId)` 这条「拉」的路（M3 收尾时就留了终态可轮询），
 * 但**前端没有任何地方调它**。本条把两条路接起来：推是主路，拉是兜底。
 *
 * ## 成本承诺（这是本条最容易写坏的地方）
 *
 * 拉只能是兜底，不能是常驻轮询 —— 否则每秒钟多一次 IPC，而且「进度条动了」
 * 也不再证明推送是通的。所以：
 *   ① **推送静默超过 `SILENT_MS` 才拉**。正常导出事件密集，一次都不该拉；
 *   ② **只在有任务在飞时拉**（`jobRef.current` 非空）。空闲时这个 interval 是空转；
 *   ③ 每次**新任务开始**重新起算静默计时，不拿上一个任务的旧时间戳放行。
 *
 * @module panels/export-progress-relay
 */
import { useCallback, useEffect, useRef } from 'react'
import { apiGetExportProgress } from '../api.ts'

/** 推送静默多久才认为「推的那条路可能断了」，开始拉。 */
export const RELAY_SILENT_MS = 2500
/** 兜底轮询的间隔。只在推断了之后才真正发请求，所以这个值只影响「恢復得多快」。 */
export const RELAY_POLL_MS = 1000

/** 一次进度样本（与 `getExportProgress` 的返回值同口径）。 */
export interface RelaySample {
  phase: string
  done: number
  total: number
}

/**
 * 给「只认推送」的调用方补上拉的兜底。
 * @param jobRef - 当前在飞任务的 jobId（空串 = 没有任务，interval 全程空转）。
 * @param onSample - 拉到一次有效进度时调用（与推送走同一个 setState，不引入第二份真相）。
 * @returns `notePush()`：调用方在收到推送时调一次，用来压制兜底轮询。
 */
export function useExportProgressRelay(
  jobRef: React.RefObject<string>,
  onSample: (s: RelaySample) => void,
): () => void {
  const lastPushRef = useRef(0)
  /** 已经为哪个 jobId 起算过静默计时（新任务要重新起算，否则会秒拉一次）。 */
  const armedForRef = useRef('')
  // 回调用 ref 兜着：不然 onSample 每次渲染都是新函数，interval 会被反复重排。
  const sampleRef = useRef(onSample)
  sampleRef.current = onSample

  useEffect(() => {
    const timer = setInterval(() => {
      const jobId = jobRef.current ?? ''
      if (jobId === '') return
      const now = Date.now()
      if (armedForRef.current !== jobId) {
        // 新任务：从现在起算，给它 2.5 秒让推送先证明自己是通的。
        armedForRef.current = jobId
        lastPushRef.current = now
        return
      }
      if (now - lastPushRef.current < RELAY_SILENT_MS) return
      void apiGetExportProgress(jobId)
        .then((s) => {
          if (!s.found) return
          sampleRef.current({ phase: s.phase, done: s.done, total: s.total })
        })
        .catch(() => { /* 兜底自己失败就继续等推送：多一条错误提示没有意义 */ })
    }, RELAY_POLL_MS)
    return () => { clearInterval(timer) }
  }, [jobRef])

  return useCallback(() => { lastPushRef.current = Date.now() }, [])
}
