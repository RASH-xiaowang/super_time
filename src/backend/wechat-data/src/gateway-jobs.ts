/**
 * 长任务槽位（#20 第四个协作者）：导出 / 备份这类可取消、可查进度的任务的槽位管理。
 *
 * 为什么单独成模块：这几条规则全属「错了不报错，只是某一次操作诡异地失败」那一类 ——
 * 同一个 jobId 复用时如果留着上一轮的 `finished`/`error`，迟到的 `getExportProgress`
 * 会一直报"已完成/失败"；如果复用那个**已经 abort 的** AbortController，新一轮导出
 * 刚起步就抛「已取消」；槽位到上限时该淘汰谁、什么时候不该淘汰，也只在并发跑到第 21 个
 * 任务时才看得出来。原先这段住在 986 行的 `GatewayCore` 里，要验就得起了网关不可得。
 *
 * 槽表（那个 `Map`）仍由类持有并原样交给 remotes —— 协作者操作传进来的那张表，
 * 不另起一份状态，避免出现「两个进度视图对不上」。
 */
import { STREAM_JOB_CAP, normalizeJobId } from './gateway-support.ts'
import type { StreamJob } from './gateway-support.ts'
import type { StreamControl } from './query/zip.ts'

/** 一次进度推送的载荷（`getExportProgress` 与事件里是同一份形状）。 */
export interface JobProgressDetail { jobId: string; phase: string; done: number; total: number }

/**
 * 进度事件出口：由类注入（**事件名留在装配那一侧** —— `ctx.emit` 的第一参数是
 * `keyof Events`，模块里拿一个 `string` 去调它类型就不成立了）。
 */
export type JobEmit = (detail: JobProgressDetail) => void

/**
 * 取（或新建）一个长任务的控制槽，并包成 query 层要的 {@link StreamControl}。
 *
 * 每次调用都换一个**新的** AbortController：同一个 jobId 被复用（先取消、再重跑）时，
 * 复用一个已 abort 的令牌会让新一轮导出刚起步就抛「已取消」。同理每轮都把上一轮的
 * `progress` / `finished` / `error` 擦干净 —— 留着就会让"这次到底跑到哪了"读到上次的答复。
 * @param jobs - 类持有的那张槽表。
 * @param emit - 进度事件出口（尽力而为：抛错不影响任务本身）。
 * @param jobId - 渲染层生成的标识；缺省/空白时返回空控制（＝无进度、不可取消，
 *   旧调用方的行为完全不变）。
 * @returns 含 `signal` 与 `onProgress` 的控制对象，可直接透传给 query 层。
 */
export function streamControlFor(jobs: Map<string, StreamJob>, emit: JobEmit, jobId?: string): StreamControl {
  const id = normalizeJobId(jobId)
  if (!id) return {}
  if (!jobs.has(id) && jobs.size >= STREAM_JOB_CAP) {
    // 到上限就淘汰最早那一个槽（Map 保持插入序）。只淘汰**别的**槽：
    // 正在复用这个 id 时不能把它自己挤掉，否则进度与取消令牌一起丢。
    const first = jobs.keys().next()
    if (!first.done && first.value !== undefined) jobs.delete(first.value)
  }
  const job: StreamJob = jobs.get(id) ?? { ctrl: new AbortController(), progress: null, finished: false }
  job.ctrl = new AbortController()
  job.progress = null
  job.finished = false
  delete job.error
  jobs.set(id, job)
  return {
    signal: job.ctrl.signal,
    onProgress: (p) => {
      job.progress = { phase: p.phase, done: p.done, total: p.total }
      // 事件尽力而为：进度推不出去不该让导出失败（与 wechat-ask/delta 同策略）。
      try { emit({ jobId: id, phase: p.phase, done: p.done, total: p.total }) } catch { /* ignore */ }
    },
  }
}

/**
 * 收尾一个长任务：标记结束（**槽位留着不删**，让迟到的 `getExportProgress` 能读到终态与错误）。
 * @param jobs - 类持有的那张槽表。
 * @param jobId - 任务标识。
 * @param error - 失败/取消原因；成功时省略。
 * @returns 无。未知 jobId 静默返回（收尾一个早被淘汰的槽不该把任务本身弄失败）。
 */
export function finishStreamJobIn(jobs: Map<string, StreamJob>, jobId: string, error?: string): void {
  const job = jobs.get(jobId)
  if (!job) return
  job.finished = true
  if (error) job.error = error
}
