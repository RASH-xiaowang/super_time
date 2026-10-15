/**
 * wxgf → JPEG 的 **ffmpeg 兜底**（2026-10-13，移植自 WeChatDataAnalysis 的
 * `media_helpers.py#_wxgf_to_jpeg_with_ffmpeg`）。
 *
 * ## 为什么需要
 *
 * 高清原图档的 wxgf 封装本应由微信安装目录的 `VoipEngine.dll` 解码（`wxam-image.ts`）。
 * 但 DLL 缺失/加载失败/返回失败时，参考项目还有第二条链：wxgf 是「起始码 + VPS」切分的
 * **Annex-B HEVC 分区**（至多 [alpha, 画面] 两个），可以用 ffmpeg 把画面分区直接解成
 * **全分辨率 JPEG**——而不是我们此前「退回 `_t` 缩略图 / hevc 占位」的降级。
 *
 * ## 正确性口径（宁可慢，不可错；全部不抛、可降级）
 *
 * 只有「静态、单帧、不透明」的 wxgf 才走这条链：画面分区必须恰好 1 帧编码图，
 * alpha 分区（如有）必须解出来**全不透明**（单帧 JPEG 表达不了透明度——带透明的
 * 返回失败，调用方照旧走缩略图回退，绝不缓存降级画面）；分区前 4 字节大端长度
 * 对不上 / 分区数超上限 / NAL 超上限 / 像素超上限 / 超时，一律判失败。
 * 结果按**内容 sha256** 做 LRU 缓存（同一份 wxgf 会被反复送进来，不再重复起 ffmpeg）。
 *
 * ## 进程模型
 *
 * 同步入口（`transcodeWxgfWithFfmpeg`）只留给不跨 RPC 的兼容调用与测试；生产解码链应走
 * `transcodeWxgfWithFfmpegAsync`：ffmpeg 是 `spawn` 子进程，**不占 worker 事件循环**。
 * 异步版在每次 ffmpeg 启动前、收到输出块时都复核剩余 deadline，超时立刻 `kill()`；
 * stdout/stderr 累计上限也是 64MB，避免恶意/损坏码流把内存打满。
 *
 * 环境变量：`DSH_WECHAT_FFMPEG` 直接指定 ffmpeg 路径；`DSH_WECHAT_WXGF_FFMPEG=0` 关闭兜底。
 * @module query/wxgf-ffmpeg
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { jpegDimensions } from './jpeg-dimensions.ts'

export const WXGF_MAX_PARTITIONS = 2
export const WXGF_MAX_NAL_UNITS = 4096
export const WXGF_FFMPEG_MAX_PIXELS = 50_000_000
export const WXGF_FFMPEG_TIMEOUT_MS = 20_000

/** 「起始码 + VPS NAL 头」：wxgf 里每个 HEVC 分区的起点。 */
const WXGF_PARTITION_START = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x40, 0x01])

/** 内容缓存：512 条 / 16MB，按插入序淘汰（失败也缓存：不为同样的数据反复起进程）。 */
const CACHE_MAX_ENTRIES = 512
const CACHE_MAX_BYTES = 16 * 1024 * 1024
const contentCache = new Map<string, { bytes: Uint8Array } | null>()
/** 同一份载荷的并发 async 转码去重：多个调用共享一个子进程。 */
const pendingContent = new Map<string, Promise<{ bytes: Uint8Array } | { error: string }>>()

/** 测试注入点：换掉 ffmpeg 进程调用。 */
export interface WxgfFfmpegSpawnResult { status: number | null; stdout: Buffer; stderr: Buffer }
export type WxgfFfmpegSpawn = (exe: string, args: readonly string[], input: Buffer, timeoutMs: number) => WxgfFfmpegSpawnResult
export type WxgfFfmpegSpawnAsync = (exe: string, args: readonly string[], input: Buffer, timeoutMs: number) => Promise<WxgfFfmpegSpawnResult>

function defaultSpawn(exe: string, args: readonly string[], input: Buffer, timeoutMs: number): WxgfFfmpegSpawnResult {
  const r = spawnSync(exe, [...args], { input, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) }
}

async function defaultSpawnAsync(exe: string, args: readonly string[], input: Buffer, timeoutMs: number): Promise<WxgfFfmpegSpawnResult> {
  return await new Promise<WxgfFfmpegSpawnResult>((resolve) => {
    const child = spawn(exe, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const maxBytes = 64 * 1024 * 1024
    const finish = (result: WxgfFfmpegSpawnResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    const collect = (chunks: Buffer[], current: number, chunk: Buffer): number => {
      const size = Math.min(chunk.length, maxBytes - current)
      if (size > 0) chunks.push(chunk.subarray(0, size))
      return current + chunk.length
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, stderrBytes, chunk)
    })
    child.once('error', (e) => {
      finish({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.from((e as Error).message) })
    })
    child.once('close', (code, signal) => {
      if (timedOut) {
        const timeoutNote = Buffer.from(`ffmpeg 超时（${String(timeoutMs)}ms${signal ? `，signal=${signal}` : ''}）`)
        finish({ status: null, stdout: Buffer.concat(stdout), stderr: Buffer.concat([...stderr, timeoutNote]) })
        return
      }
      finish({ status: code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(1, timeoutMs))
    child.stdin.on('error', () => { /* EPIPE 交给 close/error 收口 */ })
    child.stdin.end(input)
  })
}

/** PATH 里找可执行文件（Windows 上补 .exe）。 */
function onPath(name: string): string {
  const path = process.env.PATH ?? ''
  const names = name.toLowerCase().endsWith('.exe') ? [name] : [name, name + '.exe']
  for (const dir of path.split(';')) {
    if (!dir) continue
    for (const n of names) {
      const candidate = dir.replace(/["\\]+$/, '') + '\\' + n
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/**
 * 定位 ffmpeg：`DSH_WECHAT_FFMPEG` 环境变量优先，其次 PATH。
 * @returns 绝对路径；找不到返回 ''。
 */
export function findFfmpegExecutable(): string {
  const envValue = (process.env.DSH_WECHAT_FFMPEG ?? '').trim()
  if (envValue) {
    if (existsSync(envValue)) return envValue
    const onPathHit = onPath(envValue)
    if (onPathHit) return onPathHit
  }
  return onPath('ffmpeg')
}

/**
 * 按「起始码 + VPS」切出 wxgf 里的各个 HEVC 分区。
 *
 * 头部与码流之间的元数据（如 ICC）里会出现形似起始码的字节，所以不能直接取第一个起始码；
 * 每个分区前是 4 字节大端长度，长度对不上说明文件被截断或不是这种布局——**整个放弃**，
 * 不把残缺的码流交给解码器。
 * @param data - wxgf 载荷（已解密的字节）。
 * @returns 分区列表；不可信时返回空表。
 */
export function wxgfHevcPartitions(data: Uint8Array): Uint8Array[] {
  const starts: number[] = []
  const marker = WXGF_PARTITION_START
  let pos = indexOfBytes(data, marker, 4)
  while (pos >= 0) {
    if (starts.length >= WXGF_MAX_PARTITIONS) return []
    starts.push(pos)
    pos = indexOfBytes(data, marker, pos + marker.length)
  }
  const partitions: Uint8Array[] = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!
    const limit = starts[i + 1] ?? data.length
    if (start < 4) return []
    const size = ((data[start - 4]! << 24) | (data[start - 3]! << 16) | (data[start - 2]! << 8) | data[start - 1]!) >>> 0
    if (!(size > 0 && size <= limit - start)) return []
    partitions.push(data.subarray(start, start + size))
  }
  return partitions
}

/** 字节数组里的子串查找（返回下标，找不到 -1）。 */
function indexOfBytes(haystack: Uint8Array, needle: Buffer, from: number): number {
  const h = Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength)
  return h.indexOf(needle, from)
}

/**
 * 数出码流里的编码图像：VCL NAL 且 `first_slice_segment_in_pic_flag` 为 1。
 * NAL 多到不像一张图片时不再往下数，按多帧处理（上限保护）。
 */
export function hevcPictureCount(stream: Uint8Array): number {
  let count = 0
  let nalUnits = 0
  let pos = indexOfBytes(stream, Buffer.from([0x00, 0x00, 0x01]), 0)
  while (pos >= 0 && pos < stream.length - 5) {
    nalUnits += 1
    if (nalUnits > WXGF_MAX_NAL_UNITS) return Math.max(count, 2)
    if (((stream[pos + 3]! >> 1) & 0x3f) < 32 && (stream[pos + 5]! & 0x80) !== 0) count += 1
    pos = indexOfBytes(stream, Buffer.from([0x00, 0x00, 0x01]), pos + 3)
  }
  return count
}

/** 一段码流经 stdin 交给 ffmpeg 取回首帧；失败返回空。 */
function ffmpegFirstFrame(
  spawn: WxgfFfmpegSpawn, exe: string, stream: Uint8Array,
  outputArgs: readonly string[], deadlineMs: number, elapsed: () => number,
): Buffer {
  const timeout = deadlineMs - elapsed()
  if (timeout <= 0) return Buffer.alloc(0)
  const r = spawn(exe, [
    '-hide_banner', '-loglevel', 'error',
    '-xerror', '-err_detect', 'explode',
    '-max_pixels', String(WXGF_FFMPEG_MAX_PIXELS),
    '-f', 'hevc', '-i', 'pipe:0',
    '-frames:v', '1',
    ...outputArgs,
    'pipe:1',
  ], Buffer.from(stream.buffer, stream.byteOffset, stream.byteLength), timeout)
  if (r.status === 0 && r.stdout.length > 0) return r.stdout
  return Buffer.alloc(0)
}

/** {@link ffmpegFirstFrame} 的异步版：子进程不阻塞 worker，deadline 每次输出也复核。 */
async function ffmpegFirstFrameAsync(
  spawnAsync: WxgfFfmpegSpawnAsync, exe: string, stream: Uint8Array,
  outputArgs: readonly string[], deadlineMs: number, elapsed: () => number,
): Promise<Buffer> {
  const timeout = deadlineMs - elapsed()
  if (timeout <= 0) return Buffer.alloc(0)
  const r = await spawnAsync(exe, [
    '-hide_banner', '-loglevel', 'error',
    '-xerror', '-err_detect', 'explode',
    '-max_pixels', String(WXGF_FFMPEG_MAX_PIXELS),
    '-f', 'hevc', '-i', 'pipe:0',
    '-frames:v', '1',
    ...outputArgs,
    'pipe:1',
  ], Buffer.from(stream.buffer, stream.byteOffset, stream.byteLength), timeout)
  if (r.status === 0 && r.stdout.length > 0) return r.stdout
  return Buffer.alloc(0)
}

/** JPEG 魔数检查。 */
function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/**
 * 用 ffmpeg 把静态、不透明的 wxgf 转成 JPEG（DLL 不可用时的兜底）。
 * @param payload - wxgf 载荷。
 * @param deps - 测试注入点（spawn / 可执行定位 / 缓存开关）。
 * @returns JPEG 字节与宽高；任何一步不成立返回 `{ error }`。
 */
export function transcodeWxgfWithFfmpeg(
  payload: Uint8Array,
  deps?: { spawn?: WxgfFfmpegSpawn; findExe?: () => string; useCache?: boolean },
): { bytes: Uint8Array; jpegWidth: number; jpegHeight: number } | { error: string } {
  const spawn = deps?.spawn ?? defaultSpawn
  const useCache = deps?.useCache ?? true
  const cacheKey = useCache
    ? createHash('sha256').update(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)).digest('hex')
    : ''
  if (useCache && contentCache.has(cacheKey)) {
    const hit = contentCache.get(cacheKey)!
    if (hit === null) return { error: 'wxgf ffmpeg 解码不可用（已缓存失败）' }
    const dims = jpegDimensions(hit.bytes)
    return { bytes: hit.bytes, jpegWidth: dims?.width ?? 0, jpegHeight: dims?.height ?? 0 }
  }
  const result = ((): { bytes: Uint8Array } | { error: string } => {
    try {
      const exe = (deps?.findExe ?? findFfmpegExecutable)()
      if (!exe) return { error: '未找到 ffmpeg（DSH_WECHAT_FFMPEG 或 PATH）' }
      const partitions = wxgfHevcPartitions(payload)
      if (partitions.length === 0) return { error: 'wxgf 没有可解码的单帧分区' }
      const picture = partitions[partitions.length - 1]!
      if (hevcPictureCount(picture) !== 1) return { error: 'wxgf 不是单帧图片（多帧动图不支持）' }
      const started = Date.now()
      const deadlineMs = WXGF_FFMPEG_TIMEOUT_MS
      // alpha 分区（画面分区之前的那些）必须全不透明：单帧 JPEG 表达不了透明度。
      for (const alpha of partitions.slice(0, -1)) {
        const plane = ffmpegFirstFrame(spawn, exe, alpha, ['-f', 'rawvideo', '-pix_fmt', 'gray'], deadlineMs, () => Date.now() - started)
        if (plane.length === 0 || plane.some(b => b !== 0xff)) return { error: 'wxgf 带透明度，单帧 JPEG 表达不了' }
      }
      const out = ffmpegFirstFrame(spawn, exe, picture, ['-f', 'image2pipe', '-codec:v', 'mjpeg', '-q:v', '3'], deadlineMs, () => Date.now() - started)
      if (!isJpeg(out)) return { error: 'ffmpeg 未产出 JPEG' }
      const bytes = new Uint8Array(Buffer.from(out))
      return { bytes }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })()
  if (useCache) {
    contentCache.set(cacheKey, 'bytes' in result ? { bytes: result.bytes } : null)
    let total = 0
    for (const v of contentCache.values()) total += v === null ? 0 : v.bytes.length
    while (contentCache.size > CACHE_MAX_ENTRIES || total > CACHE_MAX_BYTES) {
      const first = contentCache.keys().next()
      if (first.done) break
      const dropped = contentCache.get(first.value)
      contentCache.delete(first.value)
      if (dropped != null) total -= dropped.bytes.length
    }
  }
  if ('error' in result) return result
  const dims = jpegDimensions(result.bytes)
  return { bytes: result.bytes, jpegWidth: dims?.width ?? 0, jpegHeight: dims?.height ?? 0 }
}

/**
 * {@link transcodeWxgfWithFfmpeg} 的异步入口：ffmpeg 不在 worker 事件循环上阻塞。
 * 同一载荷的并发调用共享一个在途 Promise；失败同样进内容缓存。
 */
export async function transcodeWxgfWithFfmpegAsync(
  payload: Uint8Array,
  deps?: { spawn?: WxgfFfmpegSpawnAsync; findExe?: () => string; useCache?: boolean },
): Promise<{ bytes: Uint8Array; jpegWidth: number; jpegHeight: number } | { error: string }> {
  const spawn = deps?.spawn ?? defaultSpawnAsync
  const useCache = deps?.useCache ?? true
  const cacheKey = useCache
    ? createHash('sha256').update(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)).digest('hex')
    : ''
  if (useCache && contentCache.has(cacheKey)) {
    const hit = contentCache.get(cacheKey)!
    if (hit === null) return { error: 'wxgf ffmpeg 解码不可用（已缓存失败）' }
    const dims = jpegDimensions(hit.bytes)
    return { bytes: hit.bytes, jpegWidth: dims?.width ?? 0, jpegHeight: dims?.height ?? 0 }
  }
  if (useCache) {
    const pending = pendingContent.get(cacheKey)
    if (pending) return toTranscodeResult(await pending)
  }
  const run = async (): Promise<{ bytes: Uint8Array } | { error: string }> => {
    try {
      const exe = (deps?.findExe ?? findFfmpegExecutable)()
      if (!exe) return { error: '未找到 ffmpeg（DSH_WECHAT_FFMPEG 或 PATH）' }
      const partitions = wxgfHevcPartitions(payload)
      if (partitions.length === 0) return { error: 'wxgf 没有可解码的单帧分区' }
      const picture = partitions[partitions.length - 1]!
      if (hevcPictureCount(picture) !== 1) return { error: 'wxgf 不是单帧图片（多帧动图不支持）' }
      const started = Date.now()
      const deadlineMs = WXGF_FFMPEG_TIMEOUT_MS
      for (const alpha of partitions.slice(0, -1)) {
        const plane = await ffmpegFirstFrameAsync(spawn, exe, alpha, ['-f', 'rawvideo', '-pix_fmt', 'gray'], deadlineMs, () => Date.now() - started)
        if (plane.length === 0 || plane.some(b => b !== 0xff)) return { error: 'wxgf 带透明度，单帧 JPEG 表达不了' }
      }
      const out = await ffmpegFirstFrameAsync(spawn, exe, picture, ['-f', 'image2pipe', '-codec:v', 'mjpeg', '-q:v', '3'], deadlineMs, () => Date.now() - started)
      if (!isJpeg(out)) return { error: 'ffmpeg 未产出 JPEG' }
      return { bytes: new Uint8Array(Buffer.from(out)) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }
  const promise = run()
  if (useCache) pendingContent.set(cacheKey, promise)
  const result = await promise
  if (useCache) pendingContent.delete(cacheKey)
  if (useCache) storeContent(cacheKey, result)
  return toTranscodeResult(result)
}

function toTranscodeResult(result: { bytes: Uint8Array } | { error: string }): { bytes: Uint8Array; jpegWidth: number; jpegHeight: number } | { error: string } {
  if ('error' in result) return result
  const dims = jpegDimensions(result.bytes)
  return { bytes: result.bytes, jpegWidth: dims?.width ?? 0, jpegHeight: dims?.height ?? 0 }
}

function storeContent(cacheKey: string, result: { bytes: Uint8Array } | { error: string }): void {
  contentCache.set(cacheKey, 'bytes' in result ? { bytes: result.bytes } : null)
  let total = 0
  for (const v of contentCache.values()) total += v === null ? 0 : v.bytes.length
  while (contentCache.size > CACHE_MAX_ENTRIES || total > CACHE_MAX_BYTES) {
    const first = contentCache.keys().next()
    if (first.done) break
    const dropped = contentCache.get(first.value)
    contentCache.delete(first.value)
    if (dropped != null) total -= dropped.bytes.length
  }
}
