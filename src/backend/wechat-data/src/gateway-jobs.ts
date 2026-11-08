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
import { STREAM_JOB_CAP, STREAM_JOB_TERMINAL_TTL_MS, normalizeJobId } from './gateway-support.ts'
import type { StreamJob } from './gateway-support.ts'
import type { StreamControl } from './query/zip.ts'

/** 一次进度推送的载荷（`getExportProgress` 与事件里是同一份形状）。 */
export interface JobProgressDetail { jobId: string; phase: string; done: number; total: number }

/** 终态事件额外字段；旧客户端忽略未知字段即可，轮询入口同时返回同一份状态。 */
export interface JobTerminalDetail extends JobProgressDetail {
  finished: true
  status: 'ok' | 'error' | 'canceled'
  error?: string
}

/** 交给 Remote 的可结算控制对象；`jobToken` 只在本进程内部使用，不过 RPC。 */
export interface ManagedStreamControl extends StreamControl {
  /** 生产控制槽总提供；测试/旧装配可省略，省略时按 jobId 结算。 */
  readonly jobToken?: symbol
}

/**
 * 进度事件出口：由类注入（**事件名留在装配那一侧** —— `ctx.emit` 的第一参数是
 * `keyof Events`，模块里拿一个 `string` 去调它类型就不成立了）。
 */
export type JobEmit = (detail: JobProgressDetail | JobTerminalDetail) => void

/** 判断一次失败是否属于用户取消（各层错误文案保持原样，不靠改错误类型兼容旧调用方）。 */
export function isCancelMessage(message: string): boolean {
  return /cancel|取消|abort/i.test(message)
}

/**
 * 清理已过期的终态槽位。没有定时器时也可由测试或网关直接调用。
 * @param jobs - 槽表。
 * @param now - 当前时间（测试可注入）。
 * @returns 清理数量。
 */
export function pruneSettledStreamJobs(jobs: Map<string, StreamJob>, now = Date.now()): number {
  let removed = 0
  for (const [id, job] of jobs) {
    if (job.finished && job.settledAt !== undefined && now - job.settledAt >= STREAM_JOB_TERMINAL_TTL_MS) {
      jobs.delete(id)
      removed += 1
    }
  }
  return removed
}

/** 淘汰最早一个终态槽位，给新任务腾位置；正在运行的任务不能被挤掉。 */
function evictOldestSettled(jobs: Map<string, StreamJob>): boolean {
  for (const [id, job] of jobs) {
    if (job.finished) {
      jobs.delete(id)
      return true
    }
  }
  return false
}

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
export function streamControlFor(jobs: Map<string, StreamJob>, emit: JobEmit, jobId?: string): ManagedStreamControl {
  const id = normalizeJobId(jobId)
  if (!id) return { jobToken: Symbol('no-job') }
  pruneSettledStreamJobs(jobs)
  const existing = jobs.get(id)
  if (existing && !existing.finished) {
    // 同一 id 再次开跑时，旧任务必须立即失去控制权。保留旧任务继续运行但不给它
    // 取消令牌，会让它和新任务同时写同一个界面的进度；这里主动中止旧代次，
    // 新代次用独立 token 收尾，旧任务晚到的 finish 会被 token 拒绝。
    existing.cancelRequested = true
    existing.ctrl.abort()
  }
  if (!jobs.has(id) && jobs.size >= STREAM_JOB_CAP) {
    // 到上限优先淘汰终态；全是运行中时宁可拒绝新任务，也不能把别人的取消槽挤掉。
    if (!evictOldestSettled(jobs)) throw new Error('导出/备份任务过多，请等当前任务结束后重试')
  }
  const generation = Symbol(id)
  const job: StreamJob = {
    ctrl: new AbortController(),
    progress: null,
    finished: false,
    generation,
    status: 'running',
  }
  terminalEmitters.set(job, emit)
  jobs.set(id, job)
  return {
    signal: job.ctrl.signal,
    jobToken: generation,
    onProgress: (p) => {
      if (job.finished) return
      // 终态由 finishStreamJobIn 根据累计高水位生成；查询层可在无 jobId 时自行发 done，
      // 但这里不能把消息条数 2000 突然改写成 1，否则界面会看到进度倒退。
      if (p.phase === 'done') return
      // 同一阶段的 done 只能前进；分页/分条目上报会从 0 重新计数，界面不能因此倒退。
      const previous = job.progress
      const samePhase = previous?.phase === p.phase
      const done = samePhase ? Math.max(previous.done, p.done) : p.done
      const total = samePhase && previous.total > 0 ? Math.max(previous.total, p.total) : p.total
      if (samePhase && previous.done === done && previous.total === total) return
      job.progress = { phase: p.phase, done, total }
      // 事件尽力而为：进度推不出去不该让导出失败（与 wechat-ask/delta 同策略）。
      try { emit({ jobId: id, phase: p.phase, done, total }) } catch { /* ignore */ }
    },
  }
}

/**
 * 收尾一个长任务：标记结束（**槽位留着不删**，让迟到的 `getExportProgress` 能读到终态与错误）。
 * @param jobs - 类持有的那张槽表。
 * @param jobId - 任务标识。
 * @param error - 失败/取消原因；成功时省略。
 * @param token - 本轮代次。给了 token 时只结算仍然拥有该槽的那一轮，旧任务晚到不会误伤新任务。
 * @param canceled - 是否明确是用户取消；省略时按错误文案判断。
 * @returns 无。未知 jobId 静默返回（收尾一个早被淘汰的槽不该把任务本身弄失败）。
 */
export function finishStreamJobIn(
  jobs: Map<string, StreamJob>,
  jobId: string,
  error?: string,
  token?: symbol,
  canceled?: boolean,
): void {
  const job = jobs.get(jobId)
  if (!job) return
  if (token !== undefined && job.generation !== token) return
  if (job.finished) return
  job.finished = true
  job.settledAt = Date.now()
  job.cancelRequested = false
  if (error) job.error = error
  job.status = canceled === true || (error !== undefined && isCancelMessage(error))
    ? 'canceled'
    : error === undefined ? 'ok' : 'error'
  if (job.status === 'ok') {
    const done = job.progress?.done ?? 0
    const total = job.progress?.total ?? 0
    const final = total > 0 ? Math.max(done, total) : done
    job.progress = { phase: 'done', done: final, total: final }
  } else if (job.progress) {
    job.progress = {
      phase: job.status === 'canceled' ? 'canceled' : 'failed',
      done: job.progress.done,
      total: job.progress.total,
    }
  }
  try {
    emitTerminalJob(jobId, job)
  } catch {
    /* 终态推送是通知；轮询仍可读到 */
  }
  const timer = setTimeout(() => {
    const current = jobs.get(jobId)
    if (current?.generation === job.generation && current.finished) jobs.delete(jobId)
  }, STREAM_JOB_TERMINAL_TTL_MS)
  timer.unref?.()
}

/** 终态事件出口由创建槽时绑定；这里从 job 的 progress 生成同一份 payload。 */
function emitTerminalJob(jobId: string, job: StreamJob): void {
  // 槽对象不持有 emit（避免它参与调试打印/序列化），终态统一由 streamControlFor
  // 写入 job 的 terminalEmit。这里用 WeakMap 维持这条只存在于进程内的关联。
  const status = job.status === 'running' ? 'error' : job.status
  terminalEmitters.get(job)?.({ ...progressPayload(job), jobId, finished: true, status, ...(job.error ? { error: job.error } : {}) })
}

const terminalEmitters = new WeakMap<StreamJob, JobEmit>()

function progressPayload(job: StreamJob): JobProgressDetail {
  return {
    jobId: '',
    phase: job.progress?.phase ?? '',
    done: job.progress?.done ?? 0,
    total: job.progress?.total ?? 0,
  }
}
