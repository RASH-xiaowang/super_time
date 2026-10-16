/**
 * wxgf → 可渲染图片：调用**微信安装目录里的解码库**（`VoipEngine.dll`）。
 *
 * ## 为什么需要这个模块
 *
 * 微信 4.x 的高清原图档与相当一部分聊天版都是自研封装 `wxgf`（头 `77 78 67 66`），
 * 浏览器渲染不了。本项目原先的做法是**直接报 `hevc-unsupported`**（界面写「wxgf 原图
 * （需系统 HEVC 解码）」）。本机实测（`msg/attach` 下 59,673 个 md5 前缀 `.dat`）：
 * 主体档 6,720 个里 **4,748 个是 wxgf**、`_h` 原图档 971 个里 361 个 —— 合计 **5,109 张**
 * 解出来打不开。而微信自带解码器就在它的安装目录里（本机 `VoipEngine.dll` 20.8 MB），
 * 把它映射进**我们自己的进程**解**我们自己的文件**即可 —— 不碰微信进程、不读它的内存、
 * 不 hook、不注入，与 `docs/PRIVACY.md` 的承诺不冲突。
 *
 * ## DLL 契约（wxhook 反汇编 + 本机实证）
 *
 * - `wxam_dec_wxam2pic_5(inPtr, inLen, outPtr, outSz*, optPtr)` —— **第 5 个参数必须是
 *   指向 ≥0x20 字节结构的有效指针**，传 `NULL` 必然访问违规（公开示例在本版崩掉的原因）
 *   ⇒ 这里一律传全零的 64 字节缓冲。
 * - 输出**带 24 字节 trailer**，必须截断到**最后一个 `FF D9`**，否则 JPEG 没有 EOI。
 * - **只绑定这一个导出**：`wxam_dec_getWXGFInfo_5` / `wxam_dec_isWXGF_5` 的签名没有验证过，
 *   不调用（魔数我们自己判、宽高从输出里自己读）。调错原生签名会直接把进程带走。
 *
 * ## 边界（全部「不抛、可降级」）
 *
 * - 非 Windows / 找不到 DLL / 环境变量关掉 / koffi 加载失败 → `native` 为 null，
 *   转码返回 `{ error }`，调用方维持原来的 `hevc` 降级（**行为与改造前一致**）；
 * - 返回非 0 或输出长度为 0 → 用更大的缓冲**重试一次**（扩容是最可能的成功原因）；
 * - 输出里没有 `FF D9` → 判失败（写出去也是坏图）；
 * - 超过 64MB 上限 → 判失败（与远端原图 `MAX_ORIGINAL_BYTES` 同口径）。
 *
 * 环境变量：`DSH_WECHAT_VOIP_ENGINE` 直接指定 DLL 路径（测试/排障用）；
 * `DSH_WECHAT_WXGF=0` 关闭转码（与项目里其它 `DSH_WECHAT_*` 开关同族）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { weixinInstallPath } from '../config/detect.ts'
import { jpegDimensions } from './jpeg-dimensions.ts'
export { jpegDimensions } from './jpeg-dimensions.ts'
import { transcodeWxgfWithFfmpeg, transcodeWxgfWithFfmpegAsync } from './wxgf-ffmpeg.ts'

/** 单次转码输出的字节上限：与远端原图的 `MAX_ORIGINAL_BYTES` 同口径。 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** 输出缓冲的下界：最小的 wxgf 也会解出几百 KB 的 JPEG，给 4MB 起步免得频繁扩容。 */
const MIN_OUTPUT_BYTES = 4 * 1024 * 1024

/** 微信版本目录名（与 `config/detect.ts` 的同款判据）。 */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/** `wxam_dec_wxam2pic_5` 的输出结构指针所需的最小长度（反汇编结论：≥ 0x20）。 */
const OPT_STRUCT_BYTES = 64

/**
 * 原生解码库的最小接口。
 *
 * 抽成接口而不是直接暴露 koffi：① 调用点只需「跑一次、拿到输出长度」；
 * ② 单测可以注入假实现，不必依赖本机装没装微信、更不必真去调原生代码。
 */
export interface WxgfNative {
  /** 跑一次转码。`output` 由调用方按需分配；真实输出长度写回 `outSize`（int32 LE）。 */
  run(input: Buffer, output: Buffer, outSize: Buffer, opt: Buffer): { ret: number; size: number }
  /** 诊断用的来源标识（DLL 路径或假实现的标签）。 */
  readonly label: string
}

/** 转码结果：成功给出像素字节与宽高（宽高供诊断/测试，不参与接口）；失败给一句原因。 */
export type WxgfTranscodeResult =
  | { bytes: Uint8Array; jpegWidth: number; jpegHeight: number; ms: number }
  | { error: string }

/** 转码器签名（调用方可通过参数注入替身）。 */
export type WxgfTranscoder = (payload: Uint8Array) => WxgfTranscodeResult
/** 异步转码器签名：DLL 路径仍同步，ffmpeg 兜底不再占 worker 事件循环。 */
export type WxgfTranscoderAsync = (payload: Uint8Array) => Promise<WxgfTranscodeResult>

/** 真假实现都需要的「输出是不是 JPEG 且完整」判据：找最后一个 EOI。 */
function trimToJpegEnd(bytes: Buffer): Buffer | null {
  const eoi = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]))
  if (eoi <= 0) return null
  return bytes.subarray(0, eoi + 2)
}

/**
 * 找到微信安装目录下的解码库路径。
 *
 * 安装根来自注册表（`config/detect.ts` 的 `weixinInstallPath`），DLL 在**版本子目录**下。
 * 本机可能存在多个版本目录，且 `readdir` 顺序不保证 ⇒ 这里**自己按版本号倒序扫**
 * （而不是取 `weixinVersion()` 返回的第一个），并挑第一个真的有 DLL 的目录。
 * @returns DLL 绝对路径；未安装 / 目录里没有该 DLL 时返回 ''。
 */
export function resolveVoipEnginePath(): string {
  const override = (process.env.DSH_WECHAT_VOIP_ENGINE ?? '').trim()
  if (override) return existsSync(override) ? override : ''
  if (process.platform !== 'win32') return ''
  const install = weixinInstallPath()
  if (!install || !existsSync(install)) return ''
  let dirs: string[] = []
  try {
    dirs = readdirSync(install, { withFileTypes: true })
      .filter(e => e.isDirectory() && VERSION_DIR_RE.test(e.name))
      .map(e => e.name)
  } catch {
    return ''
  }
  // 版本号按数字段比较（字符串比较会把 4.1.9 排在 4.1.15 后面）。
  const cmp = (a: string, b: string): number => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  }
  for (const dir of dirs.sort(cmp)) {
    const dll = join(install, dir, 'VoipEngine.dll')
    if (existsSync(dll)) return dll
  }
  return ''
}

/** koffi 的具名导出函数：这里只用到「调用」这一件事，故只声明参数形态。 */
type NativeFn = (...args: unknown[]) => number

/** 真实的原生绑定缓存（undefined = 还没试过；null = 试过且不可用）。 */
let cachedNative: WxgfNative | null | undefined
/** 不可用的原因（给错误信息与诊断用）。 */
let unavailableReason = ''

/**
 * 惰性加载真 DLL（首次调用才加载，之后复用）。
 * @returns 绑定；不可用时返回 null（原因记在 {@link transcodeWxgf} 的错误信息里）。
 */
function loadRealNative(): WxgfNative | null {
  // 开关**每次都判、不进缓存**：关掉之后要立刻生效（而不是等进程重启），
  // 所以这一条必须在 cachedNative 的短路之前。
  if ((process.env.DSH_WECHAT_WXGF ?? '') === '0') {
    unavailableReason = '已被 DSH_WECHAT_WXGF=0 关闭'
    return null
  }
  if (cachedNative !== undefined) return cachedNative
  cachedNative = null
  if (process.platform !== 'win32') {
    unavailableReason = '仅 Windows 支持（微信解码库是 PE 动态库）'
    return null
  }
  const dll = resolveVoipEnginePath()
  if (!dll) {
    unavailableReason = '未找到微信安装目录下的 VoipEngine.dll'
    return null
  }
  try {
    // 同步 require：调用链（decodeDatBytes → decodeImageDataUrl → @Remote）全是同步的，
    // 用动态 import 就只能「首次解码失败、以后再成功」，那是最难排查的一类行为。
    // 先例：query/whisper.ts 的 unzipper 兜底、query/kb/parse-pdf.ts 的 pdfjs。
    const require = createRequire(import.meta.url)
    const koffi = require('koffi') as {
      load: (path: string) => { func: (name: string, ret: string, args: string[]) => NativeFn }
      address: (value: unknown) => number
    }
    const dec = koffi.load(dll).func('wxam_dec_wxam2pic_5', 'int64', ['int64', 'int', 'int64', 'int *', 'void *'])
    cachedNative = {
      label: dll,
      run(input, output, outSize, opt) {
        outSize.writeInt32LE(output.length, 0)
        const ret = dec(
          koffi.address(input), input.length,
          koffi.address(output), koffi.address(outSize), koffi.address(opt),
        )
        return { ret: Number(ret), size: outSize.readInt32LE(0) }
      },
    }
    return cachedNative
  } catch (e) {
    unavailableReason = '加载微信解码库失败：' + ((e as Error).message || String(e))
    return null
  }
}

/** 按输入体量估输出缓冲：本机样本的膨胀比 ≤ 8×，给 16× 余量；上限与远端原图同口径。 */
function outputCapacity(inputBytes: number): number {
  return Math.min(MAX_OUTPUT_BYTES, Math.max(MIN_OUTPUT_BYTES, inputBytes * 16))
}

type NativeWxgfAttempt =
  | { outcome: 'result'; result: WxgfTranscodeResult }
  | { outcome: 'fallback'; reason: string }

/**
 * 跑通 DLL 的三次尝试。同步/异步转码器共用这一段：它们唯一的差异是失败后 ffmpeg
 * 用 `spawnSync` 还是 `spawn`，所以把「DLL 契约」收敛到这一份，避免两边各自漂移。
 */
function attemptNativeWxgf(native: WxgfNative, payload: Uint8Array, started: number): NativeWxgfAttempt {
  if (payload.length < 8) {
    return { outcome: 'result', result: { error: 'wxgf 数据过小，无法解码' } }
  }
  const input = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  const opt = Buffer.alloc(OPT_STRUCT_BYTES) // 全零 = mode 0；第三次尝试写 mode 3（见下）
  const outSize = Buffer.alloc(4)
  let capacity = outputCapacity(payload.length)
  // 三次机会：mode 0 按估算缓冲、mode 0 顶到上限、mode 3 顶到上限——
  // 参考项目实测有 wxgf 变体只有 mode 3 能解（2026-10-13 移植）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt === 2) opt.writeInt32LE(3, 0)
    const output = Buffer.allocUnsafe(capacity)
    const { ret, size } = native.run(input, output, outSize, opt)
    if (size > MAX_OUTPUT_BYTES) {
      return { outcome: 'result', result: { error: `wxgf 转码输出 ${String(size)} 字节，超过 64MB 上限` } }
    }
    // 原生实现若报告了比传入缓冲更大的真实长度，直接截断会静默产出坏 JPEG；
    // 先用 64MB 上限重试，顶到上限仍装不下才判失败。
    if (size > output.length) {
      if (attempt < 2) {
        capacity = MAX_OUTPUT_BYTES
        continue
      }
      return { outcome: 'fallback', reason: `wxgf 转码输出 ${String(size)} 字节，大于 ${String(output.length)} 字节缓冲` } }
    if (ret === 0 && size > 0) {
      const jpeg = trimToJpegEnd(output.subarray(0, Math.min(size, output.length)))
      if (!jpeg) {
        return { outcome: 'result', result: { error: 'wxgf 转码结果里没有 JPEG 结束标记（FFD9），已丢弃' } }
      }
      const dims = jpegDimensions(jpeg)
      // 必须拷出：output 是每次新建的，但下层的原生库可能复用内部缓冲，且 Buffer.allocUnsafe
      // 的内存会被下一次分配覆盖 —— 返回切片等于返回悬垂视图。
      return {
        outcome: 'result',
        result: {
          bytes: new Uint8Array(Buffer.from(jpeg)),
          jpegWidth: dims?.width ?? 0,
          jpegHeight: dims?.height ?? 0,
          ms: Date.now() - started,
        },
      }
    }
    if (attempt < 2) {
      capacity = MAX_OUTPUT_BYTES
      continue
    }
    // DLL 三次都失败：走 ffmpeg 兜底（2026-10-13 移植自 WeChatDataAnalysis）。
    return { outcome: 'fallback', reason: `wxgf 转码失败（返回 ${String(ret)}，输出 ${String(size)} 字节）` }
  }
  return { outcome: 'fallback', reason: 'wxgf 转码失败' }
}

/**
 * 造一个转码器。
 * @param native - `undefined` = 用真 DLL（惰性加载）；`null` = 强制不可用；对象 = 注入替身（单测）。
 * @returns 转码器；**永不抛**，失败一律返回 `{ error }`。
 */
export function createWxgfTranscoder(native?: WxgfNative | null, ffmpegFallback?: WxgfTranscoder | null): WxgfTranscoder {
  return (payload: Uint8Array): WxgfTranscodeResult => {
    const started = Date.now()
    const nat = native === undefined ? loadRealNative() : native
    if (!nat) {
      // 注入 null 是调用方主动禁用，别把上一次探测的全局原因（可能来自别的场景）报出去。
      const dllError = native === null ? '微信解码库不可用（已强制禁用）' : (unavailableReason || '微信解码库不可用')
      // DLL 不可用（没装微信 / 加载失败 / 被开关关掉）时走 ffmpeg 兜底（2026-10-13，
      // 移植自 WeChatDataAnalysis）：能解出全分辨率 JPEG，而不是退回缩略图。
      return runFfmpegFallback(ffmpegFallback, payload, started, dllError)
    }
    const attempt = attemptNativeWxgf(nat, payload, started)
    return attempt.outcome === 'result'
      ? attempt.result
      : runFfmpegFallback(ffmpegFallback, payload, started, attempt.reason)
  }
}

/**
 * 异步版转码器。与同步版同一套 DLL 契约；只有 ffmpeg 兜底是 `spawn` 而非 `spawnSync`。
 * 生产媒体 RPC 链应优先用 `transcodeWxgfAsync` / `decodeDatBytesAsync`。
 */
export function createWxgfTranscoderAsync(native?: WxgfNative | null, ffmpegFallback?: WxgfTranscoderAsync | null): WxgfTranscoderAsync {
  return async (payload: Uint8Array): Promise<WxgfTranscodeResult> => {
    const started = Date.now()
    const nat = native === undefined ? loadRealNative() : native
    if (!nat) {
      const dllError = native === null ? '微信解码库不可用（已强制禁用）' : (unavailableReason || '微信解码库不可用')
      return await runFfmpegFallbackAsync(ffmpegFallback, payload, started, dllError)
    }
    const attempt = attemptNativeWxgf(nat, payload, started)
    return attempt.outcome === 'result'
      ? attempt.result
      : await runFfmpegFallbackAsync(ffmpegFallback, payload, started, attempt.reason)
  }
}

/**
 * ffmpeg 兜底（DLL 不可用/失败后的第二条链）：`DSH_WECHAT_WXGF_FFMPEG=0` 可整体关闭；
 * 注入 null 表示调用方主动禁用（单测）。兜底失败时把 DLL 侧的原因一并带上——
 * 用户看到的是「为什么这条路也走不通」的完整故事。
 */
function runFfmpegFallback(
  ffmpegFallback: WxgfTranscoder | null | undefined,
  payload: Uint8Array,
  started: number,
  dllError: string,
): WxgfTranscodeResult {
  if (ffmpegFallback === null) return { error: dllError }
  if ((process.env.DSH_WECHAT_WXGF_FFMPEG ?? '') === '0') return { error: dllError + '（ffmpeg 兜底已被 DSH_WECHAT_WXGF_FFMPEG=0 关闭）' }
  const fb = ffmpegFallback ?? defaultFfmpegFallback
  const r = fb(payload)
  if ('bytes' in r) return { ...r, ms: Date.now() - started }
  return { error: dllError + '；ffmpeg 兜底也失败：' + r.error }
}

async function runFfmpegFallbackAsync(
  ffmpegFallback: WxgfTranscoderAsync | null | undefined,
  payload: Uint8Array,
  started: number,
  dllError: string,
): Promise<WxgfTranscodeResult> {
  if (ffmpegFallback === null) return { error: dllError }
  if ((process.env.DSH_WECHAT_WXGF_FFMPEG ?? '') === '0') return { error: dllError + '（ffmpeg 兜底已被 DSH_WECHAT_WXGF_FFMPEG=0 关闭）' }
  const fb = ffmpegFallback ?? defaultFfmpegFallbackAsync
  const r = await fb(payload)
  if ('bytes' in r) return { ...r, ms: Date.now() - started }
  return { error: dllError + '；ffmpeg 兜底也失败：' + r.error }
}

/** 默认兜底（真 ffmpeg；惰性定位）。 */
function defaultFfmpegFallback(payload: Uint8Array): WxgfTranscodeResult {
  const r = transcodeWxgfWithFfmpeg(payload)
  if ('bytes' in r) return { ...r, ms: 0 }
  return { error: r.error }
}

async function defaultFfmpegFallbackAsync(payload: Uint8Array): Promise<WxgfTranscodeResult> {
  const r = await transcodeWxgfWithFfmpegAsync(payload)
  if ('bytes' in r) return { ...r, ms: 0 }
  return { error: r.error }
}

/** 默认转码器（真 DLL，惰性加载）。 */
export const transcodeWxgf: WxgfTranscoder = createWxgfTranscoder()
/** 生产解码链使用的异步转码器（DLL 失败时 ffmpeg 走子进程）。 */
export const transcodeWxgfAsync: WxgfTranscoderAsync = createWxgfTranscoderAsync()

/**
 * 转码能力是否可用（惰性探测并缓存）。
 *
 * 注意：**首次调用会真的去加载 DLL**（约 1.5s）。只在需要判断「要不要报降级文案」时调，
 * 不要放进每张图的解码路径（那里直接调 {@link transcodeWxgf}，失败自然降级）。
 * @returns 可用为 true。
 */
export function isWxgfTranscodeAvailable(): boolean {
  return loadRealNative() !== null
}
