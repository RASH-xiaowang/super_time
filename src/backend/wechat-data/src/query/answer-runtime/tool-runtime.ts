/**
 * 工具循环的截止、取消与重试运行时。
 *
 * 这些能力独立于具体工具：模型轮次需要硬截止，单次工具调用需要可取消的
 * deadline，重试退避必须能被「停止生成」立即唤醒。
 *
 * @module query/answer-runtime/tool-runtime
 */
import type { ToolLoopInput } from './types.ts'

const MAX_RETRY_AFTER_MS = 5_000

/** 给任意 promise 套一个 deadline；超时后执行旁路取消回调。 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  onTimeout?: () => void,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        // 取消回调是旁路；deadline 结果仍必须返回。
      }
      resolve({ timedOut: true })
    }, deadlineMs)
  })
  // 超时后原 promise 仍可能 reject；先挂一个空 catch，避免 unhandled rejection。
  work.catch(() => undefined)
  try {
    return await Promise.race([
      work.then(value => ({ timedOut: false as const, value })),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 单次模型轮次的硬截止。
 *
 * 不能只 `Promise.race`：超时后底层流式请求必须收到 abort，否则它会继续占用
 * 供应商额度，晚到的块还可能被下一轮误当作新输出。这里同时监听外部取消，
 * 并在 finally 里清理计时器与监听器。
 */
export async function runTurnWithDeadline(
  input: {
    loop: ToolLoopInput
    deadlineMs: number
    buildTurnInput: (signal?: AbortSignal) => Parameters<ToolLoopInput['runTurn']>[0]
  },
): Promise<Awaited<ReturnType<ToolLoopInput['runTurn']>>> {
  const { loop, deadlineMs, buildTurnInput } = input
  loop.throwIfCanceled?.()
  if (isAborted(loop.cancelSignal)) throw canceledError(loop)
  if (deadlineMs <= 0) {
    const turn = await loop.runTurn(buildTurnInput())
    loop.throwIfCanceled?.()
    if (isAborted(loop.cancelSignal)) throw canceledError(loop)
    return turn
  }

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let onLoopAbort: (() => void) | undefined

  const timedOutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      const error = modelTimeoutError(deadlineMs)
      controller.abort(error)
      reject(error)
    }, deadlineMs)
  })
  const canceledPromise = new Promise<never>((_resolve, reject) => {
    if (!loop.cancelSignal) return
    onLoopAbort = () => {
      const error = canceledError(loop)
      controller.abort(error)
      reject(error)
    }
    loop.cancelSignal.addEventListener('abort', onLoopAbort, { once: true })
  })

  try {
    const turn = loop.runTurn(buildTurnInput(controller.signal))
    // 超时/取消后底层 promise 仍可能晚到；挂空 catch 防 unhandled rejection。
    turn.catch(() => undefined)
    const value = await Promise.race([turn, timedOutPromise, canceledPromise])
    // 取消与正常完成同时发生时，以取消为准，晚到结果不进入消息历史。
    loop.throwIfCanceled?.()
    if (isAborted(loop.cancelSignal)) throw canceledError(loop)
    return value
  } catch (error) {
    // 供应商可能把 abort 包装成自己的错误；只要本轮已超时就统一成稳定 code。
    if (timedOut) throw modelTimeoutError(deadlineMs, error)
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onLoopAbort && loop.cancelSignal) {
      loop.cancelSignal.removeEventListener('abort', onLoopAbort)
    }
  }
}

/** 通过函数读取，避免 TS 把属性窄化后把后续的实时检查误判为恒假。 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/** 截止/取消后，底层即使继续吐增量也不能再推给界面。 */
export function gateLateDelta<T>(emit: (value: T) => void, signal?: AbortSignal): (value: T) => void {
  if (signal === undefined) return emit
  return (value: T): void => {
    if (!signal.aborted) emit(value)
  }
}

function modelTimeoutError(deadlineMs: number, cause?: unknown): Error {
  const suffix = cause instanceof Error && cause.message !== ''
    ? `：${cause.message}`
    : ''
  return Object.assign(new Error(`模型轮次超时（${String(deadlineMs)}ms）${suffix}`), {
    code: 'model_timeout',
    category: 'timeout',
  })
}

/** 把分类器给出的尝试次数收口到 1..4。 */
export function detailAttempts(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(4, Math.trunc(value)))
}

/** 指数退避，同时尊重服务端的 Retry-After，但有上限。 */
export function retryDelayMs(retryAfterMs: number | undefined, attempts: number): number {
  const exponential = 100 * (2 ** Math.max(0, attempts - 1))
  const base = retryAfterMs === undefined ? exponential : Math.max(exponential, retryAfterMs)
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.trunc(base)))
}

/** 默认退避：收到取消时立即清理定时器并返回，由外层统一抛取消错误。 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** 取消已被外部信号触发时的稳定错误；优先沿用调用方的 ASK_CANCELED。 */
function canceledError(loop: ToolLoopInput): Error {
  try {
    loop.throwIfCanceled?.()
  } catch (error) {
    if (error instanceof Error) return error
    return Object.assign(new Error(String(error)), { code: 'ASK_CANCELED' })
  }
  return Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' })
}

/**
 * 退避等待必须可被取消唤醒。
 *
 * 只靠 sleep 结束后再查 flag 会让「停止生成」最多等满一次退避（限流场景可达
 * 5 秒），用户感知为点了没反应。这里用取消信号与 sleep 竞速；即使注入的 sleep
 * 不监听 signal，也会在 abort 时立即退出。
 */
export async function sleepBeforeRetry(loop: ToolLoopInput, ms: number): Promise<void> {
  loop.throwIfCanceled?.()
  const signal = loop.cancelSignal
  const sleep = loop.sleep ?? defaultSleep
  if (!signal) {
    await sleep(ms)
    loop.throwIfCanceled?.()
    return
  }
  if (signal.aborted) throw canceledError(loop)

  let onAbort: (() => void) | undefined
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(canceledError(loop))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([sleep(ms, signal), canceled])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
  loop.throwIfCanceled?.()
}
