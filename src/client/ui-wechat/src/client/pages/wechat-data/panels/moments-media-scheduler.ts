/** SNS-only pool: keep a wake handle while work runs, never exceed the existing slot cap. */
export async function drainSnsWorkPool<T>(
  queue: T[], limit: number, cancelled: () => boolean, work: (item: T) => Promise<void>,
  registerWake?: (wake: (() => void) | undefined) => void,
): Promise<void> {
  const slots = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1
  return new Promise<void>((resolve, reject) => {
    let active = 0, settled = false
    const finish = (failed = false, error?: unknown): void => {
      if (settled) return
      settled = true
      registerWake?.(undefined)
      if (failed) reject(error); else resolve()
    }
    const pump = (): void => {
      if (settled) return
      while (active < slots && queue.length > 0 && !cancelled()) {
        const item = queue.shift() as T
        active++
        const run = async (): Promise<void> => { await work(item) }
        void run().then(() => { active--; pump() }, (error: unknown) => { active--; finish(true, error) })
      }
      if (active === 0) finish()
    }
    registerWake?.(pump)
    pump()
  })
}

/** Only coalesce live, exactly equivalent SNS requests. No result cache, no cancellation ownership. */
export function createSnsRequestJoiner<O, R>(request: (options: O) => Promise<R>, generation: () => unknown = () => undefined): (options: O) => Promise<R> {
  const inflight = new Map<string, Promise<R>>()
  return (options) => {
    // Request objects are constructed in one field order by buildSnsImageRequestOptions.
    // Include all quality/offline metadata, not just md5; scope is this mounted hook, never global.
    const key = JSON.stringify([generation(), options])
    const pending = inflight.get(key)
    if (pending) return pending
    const task = Promise.resolve().then(() => request(options)).finally(() => {
      if (inflight.get(key) === task) inflight.delete(key)
    })
    inflight.set(key, task)
    return task
  }
}
