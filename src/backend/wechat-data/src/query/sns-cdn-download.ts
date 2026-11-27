/** SNS-only bounded HTTP body ownership. No host/auth policy lives here. */
export interface SnsDownloadOptions {
  signal?: AbortSignal
  headerTimeoutMs?: number
  bodyTimeoutMs?: number
  maxBytes?: number
}
export const SNS_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024
export const SNS_DOWNLOAD_HEADER_MS = 15_000
export const SNS_DOWNLOAD_BODY_MS = 30_000
function bounded(value: number | undefined, ceiling: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(ceiling, Math.max(1, Math.trunc(value))) : ceiling
}
/** Bounds headers and the entire body separately; aborts transport AND cancels its reader. */
export async function downloadSnsBody(
  url: string, fetchImpl: typeof fetch, options: SnsDownloadOptions = {},
): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController()
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, stopped: Error | undefined, complete = false
  let cancelTask: Promise<void> | undefined
  const maxBytes = bounded(options.maxBytes, SNS_DOWNLOAD_MAX_BYTES)
  let rejectAbort!: (reason: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  // Keep a rejection handler even if an already-aborted caller stops before the first race.
  void aborted.catch(() => undefined)
  const cancelBody = (): void => {
    if (cancelTask) return
    try {
      const body = reader ? reader.cancel(stopped) : response?.body?.cancel(stopped)
      if (body) cancelTask = body.catch(() => undefined)
    } catch { /* An injected broken stream cannot override the original bounded failure. */ }
  }
  const stop = (error: Error): void => {
    if (stopped) return
    stopped = error
    controller.abort(error)
    cancelBody()
    rejectAbort(error)
  }
  const callerAbort = (): void => { stop(new Error('朋友圈图片下载已取消')) }
  const deadline = (ms: number, stage: string): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => stop(new Error('朋友圈图片下载' + stage + '超时')), ms)
  }
  options.signal?.addEventListener('abort', callerAbort, { once: true })
  try {
    if (options.signal?.aborted) callerAbort()
    if (stopped) throw stopped
    deadline(bounded(options.headerTimeoutMs, SNS_DOWNLOAD_HEADER_MS), '响应头')
    const pending = fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0.49' }, signal: controller.signal })
    // A non-cooperative injected fetch may finish late; do not leak the newly returned body.
    void pending.then(late => { if (stopped) { void late.body?.cancel(stopped).catch(() => undefined) } }, () => undefined)
    response = await Promise.race([pending, aborted])
    if (stopped) throw stopped
    if (!response.ok) throw new Error('CDN 返回 HTTP ' + String(response.status))
    const length = response.headers.get('content-length')
    if (length !== null && /^\d+$/.test(length.trim()) && Number(length) > maxBytes) throw new Error('CDN 图片体积超过上限 ' + maxBytes)
    if (!response.body) throw new Error('CDN 返回空响应')
    reader = response.body.getReader()
    deadline(bounded(options.bodyTimeoutMs, SNS_DOWNLOAD_BODY_MS), '响应体')
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const item = await Promise.race([reader.read(), aborted])
      if (stopped) throw stopped
      if (item.done) break
      total += item.value.byteLength
      if (total > maxBytes) throw new Error('CDN 图片体积超过上限 ' + maxBytes)
      chunks.push(item.value)
    }
    if (total === 0) throw new Error('CDN 返回空响应')
    complete = true
    return { response, bytes: Buffer.concat(chunks, total) }
  } catch (error) {
    stop(error instanceof Error ? error : new Error('图片下载失败'))
    throw stopped
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', callerAbort)
    if (!complete) cancelBody()
    // cancel() resolves pending read() in native WHATWG streams; release after that cleanup.
    if (cancelTask) void cancelTask.then(() => { try { reader?.releaseLock() } catch { /* non-cooperative injected stream */ } })
    else { try { reader?.releaseLock() } catch { /* preserve the original result */ } }
  }
}
