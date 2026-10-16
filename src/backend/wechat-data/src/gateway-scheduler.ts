/**
 * 摘要任务的**定时器调度**（#20 第七刀：报告 §P2-2 第 1 条里"调度"那一族剩下的最后半件）。
 *
 * 之前 `GatewayCore` 里留着的是这二三十行的**执行**加上一个 `_schedBusy` 标志：
 * 「读表 → 挑出到期的 → 有界并发跑 → 出错记一条 op 日志」全部写在类里，四个依赖
 * （`_dirs` / `op` / `runSummaryTask` / 忙闲标志）都靠 this 隐式捕获，于是这一族既不能单独测，
 * 也没法看清"忙闲标志到底被谁读写"（`summaryRecordRemotes` 里那两个 closure 就是为此存在的）。
 * 搬出来之后：类只持有这颗协作者并转发一次调用，忙闲标志变成它自己的内部状态（外部仍可通过
 * `busy()` / `setBusy()` 读写 —— 手工"立即运行"那条路径要它）。
 *
 * 两条原样保留的口径（都有用例钉着，出处是 `summary-run-due.spec.ts`）：
 *  - **到期判定里 `lastRunAt` 缺值按 0 处理**：`Number(undefined)` 是 NaN，`NaN > 60000` 恒 false，
 *    照抄那一句会让从未跑过的新任务**永远**等不到第一次调度；
 *  - **失败不连坐**：单个任务抛错只记下原因，同批其它任务照常跑完，全部跑完后再把首个错误
 *    交给外层 catch（保留 `summary_scheduler_error` 这条日志）。
 */
import type { OperationCategory, OperationStatus } from './types.ts'
import { listSummaryTasks, type SummaryTask } from './query/summary-tasks.ts'

/**
 * 同一分钟到期的摘要任务并发上限（N15）。
 *
 * 为什么是 2：受「同一分钟到期」约束，这一批通常只有 1~2 项，上限本身只是「别一次把一堆
 * LLM 请求打出去」的保险。不做成配置项：加一个没人会改的旋钮只是多一处待验证的输入面
 * （`embedding.concurrency` 那套夹取是因为它来自可手改的 `rag-config.json`）。
 */
export const DUE_SUMMARY_CONCURRENCY = 2

/** 调度要的外部依赖（全部按函数注入，方便单独测；`now` 只给测试留口子）。 */
export interface SummarySchedulerDeps {
  /** 数据根目录（读任务表用）。 */
  decryptedDir: () => string
  /** 操作日志那一格（到期判定与执行失败都要往这里记一次）。 */
  op: (category: OperationCategory, action: string, status: OperationStatus, target: string, detail: string) => void
  /** 跑一个任务 —— 就是网关上那颗 `runSummaryTask`（用例会在实例上打桩它）。 */
  runTask: (options: { id: number }) => Promise<unknown>
  /** 时钟。默认 `new Date()`。 */
  now?: () => Date
}

/** 一颗摘要任务调度器。 */
export interface SummaryScheduler {
  /** 是否有一轮调度正在跑（与 `summaryrec` 那颗手工"立即运行"共用同一件标志）。 */
  busy(): boolean
  /** 置/清忙闲标志（手工触发那条路径沿用旧行为）。 */
  setBusy(v: boolean): void
  /** 到点跑一轮：挑出到期任务并有界并发执行。 */
  runDue(): Promise<void>
}

/**
 * 挑出这一分钟该跑的摘要任务 id。
 * @param tasks - 任务表全量。
 * @param now - 当前时刻（真实时钟或用例注入的那个）。
 * @returns 到期任务的 id 列表（顺序就是表里的顺序）。
 */
export function dueSummaryTaskIds(tasks: readonly SummaryTask[], now: Date): number[] {
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  const due: number[] = []
  for (const t of tasks) {
    if (!t.enabled) continue
    const sched = (t.scheduleTime || '08:00').slice(0, 5)
    // 「一分钟内没跑过」：`Number(t.lastRunAt)` 对从未跑过的任务是 NaN，`NaN > 60000` 恒 false
    // ⇒ 新任务永远等不到第一次调度（last_run_at 只在跑过一次之后才被写）。缺值按 0 处理。
    const lastRun = Number(t.lastRunAt ?? 0)
    if (sched === hhmm && now.getTime() - lastRun > 60_000) due.push(t.id)
  }
  return due
}

/**
 * 造摘要任务调度器。
 * @param deps - 见 {@link SummarySchedulerDeps}。
 * @returns 调度器（`busy` / `setBusy` / `runDue`）。
 */
export function createSummaryScheduler(deps: SummarySchedulerDeps): SummaryScheduler {
  let busy = false
  return {
    busy: () => busy,
    setBusy: (v: boolean) => { busy = v },
    async runDue(): Promise<void> {
      if (busy) return
      busy = true
      try {
        const now = (deps.now ?? (() => new Date()))()
        const due = dueSummaryTaskIds(listSummaryTasks(deps.decryptedDir()).items, now)
        /**
         * 有界并发 + 失败不连坐（N15，worker 池形态照搬 M10）。
         *
         * 改前是 `for (const t of tasks) await runTask(...)`：N 次**串行**的完整流式往返，
         * 而且前一个任务失败会中断后面所有任务 —— 那正是「失败半写」在摘要任务上的形态：
         * 同一分钟到期的一批只落地一部分，且没有任何地方会补跑剩下的。
         * 现在 worker 原子认领下一个到期任务；单个任务抛错只记下原因，不影响其它任务跑完，
         * 全部结束后再把首个错误抛给外层 catch（保留原来的 summary_scheduler_error 日志）。
         *
         * 并发本身不会引入写冲突：这批唯一的共享资源是 `daily_summary.db`，而 node:sqlite 是同步 API、
         * `saveSummaryRecord` / `updateSummaryTaskRunState` 都是**单语句 autocommit** —— 从加锁到提交
         * 不让出事件循环，两次调用在 JS 层不可能交错（实测 500 次交叉单语句写 0 次 SQLITE_BUSY；
         * 只有把事务开着跨 await 才会撞锁，那是 N10 的病）。
         */
        let next = 0
        let failure: unknown = null
        const worker = async (): Promise<void> => {
          for (;;) {
            const i = next
            next += 1
            // `due` 是稠密的 number 数组 ⇒ 「取不到」与「下标越界」是同一件事，正好就是「没有到期任务了」。
            const id = i >= due.length ? undefined : due[i]
            if (id === undefined) return
            try {
              await deps.runTask({ id })
            } catch (e) {
              failure = failure ?? e
            }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(DUE_SUMMARY_CONCURRENCY, due.length) }, () => worker()),
        )
        if (failure) throw failure
      } catch (e) {
        deps.op('error', 'summary_scheduler_error', 'fail', '', (e as Error).message)
      } finally { busy = false }
    },
  }
}
