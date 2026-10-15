/**
 * Whisper transcription configuration support: engine detection (whisper-cli
 * binary or a user-pinned DSH_WECHAT_WHISPER_BIN), CUDA device presence, and
 * model inventory scanned from the configured models dir. Inference runs
 * locally in this package via whipser-cli (see voice-transcribe.ts); this
 * module reports what is configured and available so the settings panel can
 * offer a real model/device/threads configuration.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  copyFileSync, cpSync, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchWithRetry } from '../net/fetch-retry.ts'
import type { WhisperModelInfo } from '../types.ts'
import { resolveWechatDataRoot } from '../dirs.ts'
import { yieldToLoop } from './search-build.ts'
import { unpackedAware } from '../asar-path.ts'
import { isInsideRoot, writeDenialReason } from './path-policy.ts'
import { cachedBySig, fileSigOf } from './meta.ts'

/** Whisper model catalog (id/name/size labels). */
export const WHISPER_MODELS: ReadonlyArray<Pick<WhisperModelInfo, 'id' | 'name' | 'sizeLabel'>> = [
  { id: 'tiny', name: 'Tiny', sizeLabel: '约 75 MB · 最快' },
  { id: 'base', name: 'Base', sizeLabel: '约 145 MB · 很快' },
  { id: 'small', name: 'Small', sizeLabel: '约 466 MB · 较快' },
  { id: 'medium', name: 'Medium', sizeLabel: '约 1.5 GB · 中等' },
  { id: 'large-v3', name: 'Large v3', sizeLabel: '约 3.1 GB · 较慢' },
  { id: 'turbo', name: 'Turbo', sizeLabel: '约 1.6 GB · 快' },
]

/** ggml model file per model id (whisper.cpp official release artifacts). */
export const WHISPER_DOWNLOAD_FILES: ReadonlyArray<[string, string]> = [
  ['tiny', 'ggml-tiny.bin'],
  ['base', 'ggml-base.bin'],
  ['small', 'ggml-small.bin'],
  ['medium', 'ggml-medium.bin'],
  ['large-v3', 'ggml-large-v3.bin'],
  ['turbo', 'ggml-large-v3-turbo.bin'],
]

/**
 * W3-5.5：引擎包的**固定发布 tag**（不用 `latest`）。
 *
 * 环境变量 `DSH_WECHAT_WHISPER_ENGINE_TAG` 可覆盖；空值时回落到
 * `latest`（旧行为，保护已经配好镜像的环境）。
 * 这里是一个字符串常量而不是编号——— 固定哪一版
 * 应该是一行改动，而不是到处翻 URL。
 */
export const WHISPER_ENGINE_TAG = ((): string => {
  const pinned = (process.env.DSH_WECHAT_WHISPER_ENGINE_TAG ?? '').trim()
  return pinned === '' ? 'latest' : pinned
})()
/** Base order: env pin first, then the cached reachable one, then official/mirror. */
function whisperDownloadBases(): string[] {
  const pinned = process.env.DSH_WECHAT_WHISPER_MIRROR
  const bases: string[] = []
  if (pinned && pinned.trim().length > 0) bases.push(pinned.trim().replace(/\/$/, ''))
  if (reachableBase) bases.push(reachableBase)
  bases.push('https://huggingface.co', 'https://hf-mirror.com')
  return [...new Set(bases)]
}

/** First base that answered a download; remembered for subsequent models. */
let reachableBase: string | null = null

/** Header-arrival timeout before a base is declared unreachable. */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 20_000

/** 引擎包（约 20MB 的 zip）的连接超时。 */
const ENGINE_CONNECT_TIMEOUT_MS = 30_000

/**
 * 每个镜像最多试几次（含首次）。
 *
 * 为什么**不**用默认的 3 次：这一层的外层已经是「镜像轮换」（3 个 base），
 * 一次「连接超时」要 20–30s；3×3 个 base 会让「完全没网」的报错等上 3 分钟。
 * 2 次足够覆盖「同一个镜像偶发 5xx/429」（重试的主要收益），镜像轮换继续兜剩下的。
 */
const DOWNLOAD_MAX_ATTEMPTS = 2

/**
 * 把一个 URL 流式写进 `dest`，**支持断点续传**：以 `dest` 现有长度为起点发 `Range`。
 *
 * 为什么要续传：模型有 1.5–3.1 GB，一次连接中断就让整份重下；而重试层只管到「响应头」，
 * 中途断流它看不见（这正是 M7 的 N13 遗留项里那半句「另加断点续传」）。
 * 三处刻意取舍：
 *   · 只有服务端明确回 **206** 才追加写；回 200 说明 Range 没生效，必须从头写
 *     （否则文件前段是旧内容，拼出来的包是坏的）；
 *   · 续传起点取自 `statSync(dest).size` 而**不是**我们数过的字节数 —— 写缓冲可能被丢掉，
 *     按磁盘实际长度续传永远是对的（大不了重下一小段）；
 *   · 完成后校验长度：流提前 end（不算错误）时旧实现会把**截断的文件** rename 成正式模型。
 * @param url - 下载地址。
 * @param dest - 目标文件（同一个路径会被复用/续传）。
 * @param timeoutMs - 单次尝试的**连接**超时（拿到响应头即解除）。
 * @param onProgress - 进度回调（received 含续传已有的部分；total 未知时为 0）。
 * @returns 最终字节数（含续传部分）。
 */
export async function streamUrlToFile(
  url: string,
  dest: string,
  timeoutMs: number,
  onProgress: (received: number, total: number) => void,
  /** W3-5.5：取消信号（每个 chunk 检查一次）。 */
  signal?: AbortSignal,
): Promise<number> {
  let have = 0
  try { have = statSync(dest).size } catch { have = 0 }
  const res = await fetchWithRetry(
    fetch,
    url,
    { redirect: 'follow', headers: have > 0 ? { range: `bytes=${have}-` } : undefined },
    { timeoutMs, timeoutScope: 'headers', maxAttempts: DOWNLOAD_MAX_ATTEMPTS },
  )
  if (!res.ok || res.body === null) {
    if (res.status === 416 && have > 0) {
      // 局部文件不可能是对端的前缀（例如上游换了更小的一份）→ 丢掉它，下一次尝试从头来
      try { unlinkSync(dest) } catch { /* best effort */ }
      throw new Error('HTTP 416：已丢弃与远端不符的局部文件，请重新下载')
    }
    throw new Error(`HTTP ${res.status}`)
  }
  const append = have > 0 && res.status === 206
  if (append) {
    // 服务端必须从我们要求的位置开始给（`Content-Range: bytes <start>-…`）。
    // 起始偏移不对就是「拼错位置」——长度校验抓不到，只能在这里拦下。
    const start = /^bytes\s+(\d+)-/i.exec(String(res.headers.get('content-range') ?? ''))
    if (start && Number(start[1]) !== have) {
      try { unlinkSync(dest) } catch { /* best effort */ }
      throw new Error(`续传起点不符（对端从 ${start[1]} 开始，本机有 ${have} 字节），已丢弃局部文件`)
    }
  }
  const rest = Number(res.headers.get('content-length') ?? 0)
  const total = rest > 0 ? (append ? have + rest : rest) : 0
  let received = append ? have : 0
  const stream = createWriteStream(dest, { flags: append ? 'a' : 'w' })
  let settled = false
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stream.write(value)
      received += value.byteLength
      onProgress(received, total)
      /**
       * 每块都让出一次（W3 批次 1.1）。
       *
       * 为什么必须让出：模型 1.23GB，`reader.read()` 的分块来得又快又密 ——
       * 整段循环一个 `await` 都不放的话，微任务队列会被这块循环占满，
       * 同进程本该毫秒级的请求（面板列表、图片代理）全被顶住。
       * 这里的代价可以忽略：真正的瓶颈是网络，一次 `setImmediate`
       * 相对一个 4MB 块的下载时间是可以不要钱的。
       */
      await yieldToLoop()
      // W3-5.5：取消检查点。放在让出之后才有意义——先检查再让出的话，
      // 一次建连后的 chunk 读取会把顺序颠倒（先检查再让出 = 取消多等一个 chunk）。
      // 局部文件**不删**：下次续传仍然可用。
      if (signal?.aborted === true) {
        throw Object.assign(new Error('已取消下载'), { code: 'WHISPER_DOWNLOAD_CANCELED' })
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => { resolve() })
      stream.on('error', reject)
    })
    settled = true
  } finally {
    if (!settled) {
      try { stream.destroy() } catch { /* best effort */ }
      // 等句柄真正关掉：下一次尝试的 statSync 才是可信的续传起点
      await new Promise<void>((resolve) => {
        stream.once('close', () => { resolve() })
        setTimeout(resolve, 500).unref()
      })
    }
  }
  const size = (() => { try { return statSync(dest).size } catch { return -1 } })()
  if (total > 0 && size !== total) throw new Error(`下载不完整（${size}/${total} 字节），可重试续传`)
  return received
}

/**
 * Move one file/dir to a target (same-volume rename first, copy+remove
 * fallback). An existing destination directory is merged child-by-child and
 * then removed; existing destination files are kept untouched.
 * @returns the number of items moved (merged dirs count their moved children).
 */
function moveItem(src: string, dest: string): number {
  try {
    if (existsSync(dest)) {
      if (!statSync(src).isDirectory()) return 0 // keep existing target file
      let moved = 0
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        moved += moveItem(join(src, entry.name), join(dest, entry.name))
      }
      try { rmSync(src, { recursive: true, force: true }) } catch { /* best effort */ }
      return moved
    }
    mkdirSync(dirname(dest), { recursive: true })
    try {
      renameSync(src, dest)
      return 1
    } catch {
      // EXDEV across volumes: recursive copy then remove.
      cpSync(src, dest, { recursive: true })
      rmSync(src, { recursive: true, force: true })
      return 1
    }
  } catch { /* best effort */ }
  return 0
}

/**
 * Move engine binary + sibling engine DLLs sitting at a models-dir root
 * (manual extraction), keeping existing targets.
 * @returns the number of items moved.
 */
function moveTopLevelEngineFiles(fromDir: string, toDir: string): number {
  let moved = 0
  try {
    for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue
      if (/^whisper(?:-cli)?(?:\.exe)?$/i.test(entry.name) || /^(?:ggml-.+|llama)\.dll$/i.test(entry.name)) {
        moved += moveItem(join(fromDir, entry.name), join(toDir, entry.name))
      }
    }
  } catch { /* best effort */ }
  return moved
}

/**
 * Migrate downloaded models (ggml-*.bin), the engine install (bin/), and any
 * top-level engine files (whisper-cli.exe / whisper.exe + sibling engine DLLs)
 * from one models dir to another (best-effort, keeps existing targets).
 * @param fromDir - old models dir.
 * @param toDir - new models dir (created when missing).
 * @returns ok + moved count, or an error description.
 */
export function migrateWhisperModels(fromDir: string, toDir: string): { ok: boolean; moved: number; error?: string } {
  if (!fromDir || !toDir) return { ok: false, moved: 0, error: '目录为空' }
  if (fromDir.toLowerCase() === toDir.toLowerCase()) return { ok: true, moved: 0 }
  if (!existsSync(fromDir)) return { ok: true, moved: 0 }
  // 迁移的目的就是「从只读/旧位置搬到可写位置」，所以目标侧这道闸永远不该放行只读目录
  const refusal = whisperWriteRefusal(toDir)
  if (refusal) return { ok: false, moved: 0, error: refusal }
  try {
    mkdirSync(toDir, { recursive: true })
    let moved = 0
    for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
      const src = join(fromDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'bin') {
          moved += moveItem(src, join(toDir, 'bin'))
        }
        continue
      }
      if (/^ggml-.+\.bin$/i.test(entry.name)) {
        moved += moveItem(src, join(toDir, entry.name))
      }
      // leftover download artifacts: no longer needed.
      if (entry.name === 'whisper-bin-x64.zip' || entry.name === 'whisper-bin-x64.zip.part') {
        try { unlinkSync(src) } catch { /* best effort */ }
      }
    }
    moved += moveTopLevelEngineFiles(fromDir, toDir)
    try { rmSync(join(fromDir, '.engine-staging'), { recursive: true, force: true }) } catch { /* best effort */ }
    return { ok: true, moved }
  } catch (e) {
    return { ok: false, moved: 0, error: (e as Error).message }
  }
}

/**
 * Move the engine install directory (the folder holding `binPath`, when it
 * sits under `fromDir`) to the mirrored location under `toDir` and return the
 * relocated binary path; '' when binPath is outside fromDir (external engine:
 * left untouched). The move is best-effort — the returned path is the correct
 * destination either way.
 */
export function migrateWhisperEngineDir(binPath: string, fromDir: string, toDir: string): string {
  if (!binPath || !fromDir || !toDir) return ''
  // 目标不可写 ⇒ 什么都不搬，返回 ''（调用方按「引擎在外部、原样保留」处理同一个值）：
  // `saveWechatConfig` 里这两步是顺序调用的，第二步不看第一步的结果，所以闸门必须自己问一遍
  if (whisperWriteRefusal(toDir)) return ''
  const from = fromDir.replace(/[\\/]+$/, '')
  const norm = binPath.replace(/[\\/]+$/, '')
  const f = from.toLowerCase().replaceAll('\\', '/')
  const n = norm.toLowerCase().replaceAll('\\', '/')
  // `\` and `/` both occupy one byte, so indices stay aligned between forms.
  if (!n.startsWith(f + '/')) return ''
  const rel = norm.slice(from.length).split(/[\\/]+/).filter(Boolean)
  const dirSegs = rel.slice(0, -1)
  if (dirSegs.length > 0) moveItem(dirname(norm), join(toDir, ...dirSegs))
  else moveTopLevelEngineFiles(fromDir, toDir)
  return join(toDir, ...rel)
}

/** ggml file-name prefixes per model id (turbo before large-v3 — it shares the prefix). */
const MODEL_FILE_PREFIX: ReadonlyArray<[string, string]> = [
  ['turbo', 'ggml-large-v3-turbo'],
  ['large-v3', 'ggml-large-v3'],
  ['medium', 'ggml-medium'],
  ['small', 'ggml-small'],
  ['base', 'ggml-base'],
  ['tiny', 'ggml-tiny'],
]

/**
 * Resolve one engine candidate: a file path (validated) or a dir that
 * contains whisper-cli.exe / whisper.exe. An existing bare directory is not a
 * valid engine — an empty `bin/` leftover must not count as installed.
 * @returns the binary path, or '' when not present.
 */
function resolveEngineCandidate(candidate: string): string {
  const c = candidate.trim()
  if (!c) return ''
  for (const name of ['whisper-cli.exe', 'whisper.exe', 'whisper-cli', 'whisper']) {
    const p = join(c, name)
    if (existsSync(p)) return p
  }
  try {
    if (existsSync(c) && statSync(c).isFile()) return c
  } catch { /* invalid path */ }
  return ''
}

/**
 * Detect a local whisper CLI binary. Order: persisted config path → env pin →
 * models-dir install location (bin/ + a bounded search so engine releases
 * extracted into a subdir by earlier layouts still resolve) → PATH.
 * The probe (stat + bounded dir search + PATH lookup) is cached per file
 * fingerprint for a few seconds: the settings panel polls it while a
 * download progresses, and the search only needs to re-run once the dirs
 * actually change.
 * @param configBin - persisted engine path from config (file or dir).
 * @param modelsDir - models cache dir (the engine installs under bin/).
 * @returns the binary path, or '' when none.
 */
export function whisperEnginePath(configBin?: string, modelsDir?: string): string {
  const binSig = configBin && /[/\\]/.test(configBin) ? fileSigOf(configBin) : ''
  const dirSig = modelsDir ? fileSigOf(modelsDir) : ''
  return cachedBySig(
    'whisper-engine:' + (modelsDir ?? '') + '|' + (configBin ?? ''),
    `${binSig}|${dirSig}`,
    () => resolveWhisperEngine(configBin, modelsDir),
  )
}

/** Uncached engine probe (see {@link whisperEnginePath}). */
function resolveWhisperEngine(configBin?: string, modelsDir?: string): string {
  const candidates: string[] = []
  if (configBin && configBin.trim().length > 0) candidates.push(configBin)
  const pinned = process.env.DSH_WECHAT_WHISPER_BIN
  if (pinned && pinned.trim().length > 0) candidates.push(pinned)
  if (modelsDir) {
    candidates.push(join(modelsDir, 'bin'), join(modelsDir, 'whisper-cli.exe'))
  }
  for (const candidate of candidates) {
    const resolved = resolveEngineCandidate(candidate)
    if (resolved) return resolved
  }
  if (modelsDir) {
    const found = findFile(modelsDir, 'whisper-cli.exe')
    if (found) return found
  }
  for (const name of ['whisper-cli', 'whisper']) {
    try {
      const found = resolveCommand(name)
      if (found && existsSync(found)) return found
    } catch { /* not on PATH */ }
  }
  return ''
}

/** Resolve one command name/path against PATH (where/which). */
function resolveCommand(cmd: string): string {
  if (/[/\\]/.test(cmd)) return cmd
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const out = execFileSync(locator, [cmd], { encoding: 'utf8', windowsHide: true })
  const first = out.split(/\r?\n/).map(s => s.trim()).find(s => s.length > 0)
  return first ?? ''
}

/**
 * CUDA device presence (nvidia-smi replies with a device list). Process-level
 * memo: driver presence cannot change while the host runs, so probe once and
 * reuse for an hour (the nvidia-smi subprocess is otherwise spawned on every
 * settings-panel status poll).
 * @returns true when an NVIDIA CUDA device/driver is available.
 */
export function whisperHasCuda(): boolean {
  return cachedBySig('whisper-cuda', 'static', () => {
    try {
      execFileSync('nvidia-smi', ['-L'], { encoding: 'utf8', windowsHide: true })
      return true
    } catch {
      return false
    }
  }, 3_600_000)
}

/**
 * Scan a models dir for installed ggml binaries.
 * @param modelsDir - directory searched for `ggml-<id>[.*].bin`.
 * @returns per-model installed flags + the catalog.
 */
export function whisperModelsStatus(modelsDir: string): WhisperModelInfo[] {
  return cachedBySig('whisper-models:' + modelsDir, fileSigOf(modelsDir), () => {
    let names: string[] = []
    try {
      names = readdirSync(modelsDir)
    } catch { /* dir absent: nothing installed */ }
    return WHISPER_MODELS.map(m => ({
      ...m,
      installed: MODEL_FILE_PREFIX.some(([id, prefix]) =>
        id === m.id && names.some(n => n.toLowerCase().startsWith(prefix) && n.toLowerCase().endsWith('.bin'))),
    }))
  })
}

/** 随包分发的 whisper 资产目录（安装目录，只读）：引擎 `bin/` 与预置 `ggml-*.bin`。 */
export function bundledWhisperAssetsDir(): string {
  // Runtime 打包在 lib/index.js：往上 4 级到项目/包根，再进 wechat/whisper。
  const here = fileURLToPath(new URL('.', import.meta.url))
  // 打包后这里落在 app.asar 内 → 必须改写到 app.asar.unpacked 才读得到（见 unpackedAware）
  return unpackedAware(resolve(here, '..', '..', '..', '..', 'wechat', 'whisper'))
}

/**
 * 「这个目录能不能当**可写**的模型目录」（P2-6 那把尺子在 whisper 上的分册）。返回 null = 可以写。
 *
 * 为什么要单独一格：{@link defaultWhisperModelsDir} 在数据根下那个可写目录还没建好
 * （或镜像失败）时**会退回随包资产目录**。退回本身是对的 —— 读预置的 tiny 模型不需要写权限；
 * 错的是把这份「只读兜底」再交给写入侧：`installWhisperEngine` / `whisperDownloadModel`
 * 原本直接 `mkdirSync` + 落文件，装到 Program Files 时报的是 EACCES/ENOENT 这类看不懂的错，
 * 开发态那个目录就是仓库里的 `src/wechat/whisper` —— 一次模型下载能往仓库写进 1.5 GB。
 * 所以三个写入入口（引擎安装、模型下载、旧目录迁移）一律先问这一格，理由说人话。
 * @param modelsDir - 准备写入的目录。
 * @param bundled - 随包资产目录（默认取真实那份；单测给一个临时目录当替身）。
 * @returns 拒绝理由，或 null。
 */
export function whisperWriteRefusal(modelsDir: string, bundled: string = bundledWhisperAssetsDir()): string | null {
  const raw = String(modelsDir ?? '').trim()
  if (raw === '') return '没有给出模型目录'
  const abs = resolve(raw)
  if (isInsideRoot(abs, bundled)) {
    return '模型目录落在随包分发的只读位置（装到 Program Files 时写不进去）：请先在设置里指定一个可写的目录'
  }
  return writeDenialReason(abs, resolveWechatDataRoot() ?? abs)
}

/** 已做过资产镜像的目录（同进程内只做一次）。 */
const seededWhisperDirs = new Set<string>()

/** 目标不存在或大小不同才搬；大小一致即视为已完成，可中断后续跑。 */
function mirrorWhisperItem(src: string, dst: string): void {
  let size = -1
  try { size = statSync(src).size } catch { return }
  try { if (statSync(dst).size === size) return } catch { /* 目标不存在，继续 */ }
  try { linkSync(src, dst); return } catch { /* 跨卷等情况退回复制 */ }
  try { copyFileSync(src, dst) } catch { /* 单个文件失败不影响其它 */ }
}

/**
 * 把随包分发的引擎与模型镜像到可写目录。
 *
 * 为什么不直接用安装目录：安装目录是只读的（装到 Program Files 时更无写权限），
 * 而「下载其它模型」「重装引擎」都要往模型目录里写。镜像一次之后安装目录只被读取。
 * 同卷走硬链接（零拷贝），跨卷才真复制。
 * @param modelsDir - 可写的模型目录。
 */
function seedBundledWhisper(modelsDir: string): void {
  const bundled = bundledWhisperAssetsDir()
  // 镜像的目标必须是可写目录，且不能落在随包目录里面（原来只比了「相等」）
  if (!bundled || whisperWriteRefusal(modelsDir, bundled)) return
  let names: string[] = []
  try { names = readdirSync(bundled) } catch { return }
  const items = names.filter(n => n === 'bin' || n.toLowerCase().endsWith('.bin'))
  if (items.length === 0) return
  try { mkdirSync(modelsDir, { recursive: true }) } catch { return }
  for (const name of items) {
    const src = join(bundled, name)
    const dst = join(modelsDir, name)
    let isDir = false
    try { isDir = statSync(src).isDirectory() } catch { continue }
    if (!isDir) { mirrorWhisperItem(src, dst); continue }
    try { mkdirSync(dst, { recursive: true }) } catch { continue }
    let inner: string[] = []
    try { inner = readdirSync(src) } catch { continue }
    for (const child of inner) mirrorWhisperItem(join(src, child), join(dst, child))
  }
}

/** 目录里至少有一个可用件（引擎或模型）时算可用。 */
function whisperDirUsable(dir: string): boolean {
  if (existsSync(join(dir, 'bin', 'whisper-cli.exe'))) return true
  try { return readdirSync(dir).some(n => n.toLowerCase().endsWith('.bin')) } catch { return false }
}

/**
 * 默认模型/引擎目录：**数据根下的可写目录**（`<数据根>/whisper`），首次使用时把随包
 * 分发的引擎与模型镜像进来。
 *
 * 早先这里指向项目/安装目录的 `wechat/whisper`，于是「安装目录只读」形同虚设 ——
 * 下载一个新模型就会往安装位置写文件（装到 Program Files 时直接失败）。
 * 镜像失败（userData 不可写等）时退回随包资产目录，至少让预置的 tiny 模型仍可用。
 * @param decryptedDir - 解密库目录（其父目录即数据根）。
 */
export function defaultWhisperModelsDir(decryptedDir?: string): string {
  const bundled = bundledWhisperAssetsDir()
  const root = decryptedDir ? dirname(decryptedDir) : resolveWechatDataRoot()
  if (!root) return bundled
  const dir = join(root, 'whisper')
  if (!seededWhisperDirs.has(dir)) {
    seededWhisperDirs.add(dir)
    seedBundledWhisper(dir)
  }
  return whisperDirUsable(dir) ? dir : bundled
}

/**
 * 从配置解析出**可写**的模型目录。
 *
 * 配置里若钉的是随包分发的只读资产目录（或任何仍落在 `app.asar` 里的路径），
 * 一律当作「未配置」重新解析 —— 否则装上带此改动的新版本后，旧配置会继续把
 * 模型往安装目录里写（装到 Program Files 时失败，且把本机路径留在安装目录）。
 * @param configured - config.json 里的 whisper_models_dir。
 * @param decryptedDir - 解密库目录（其父目录即数据根）。
 */
export function resolveWhisperModelsDir(configured: string | undefined, decryptedDir?: string): string {
  const pinned = typeof configured === 'string' ? configured.trim() : ''
  if (pinned) {
    const bundled = bundledWhisperAssetsDir()
    if (!pinned.includes('app.asar') && resolve(pinned) !== resolve(bundled)) return pinned
  }
  return defaultWhisperModelsDir(decryptedDir)
}

/**
 * Download and install the whisper.cpp CLI engine into
 * `<modelsDir>/bin/whisper-cli.exe` (official release zip, streamed).
 * @param modelsDir - models cache dir.
 * @param onProgress - progress callback (bytes, total).
 * @returns ok + binary path, or an error description.
 */
export async function installWhisperEngine(
  modelsDir: string,
  onProgress: (received: number, total: number) => void,
  /** W3-5.5：取消信号（每个 chunk 检查一次）。 */
  signal?: AbortSignal,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const binDir = join(modelsDir, 'bin')
  const target = join(binDir, 'whisper-cli.exe')
  if (existsSync(target)) return { ok: true, path: target }
  // 预置引擎在只读目录里仍然能用（上面那条快路径），但「再下一份」必须落到可写位置
  const refusal = whisperWriteRefusal(modelsDir)
  if (refusal) return { ok: false, error: refusal }
  mkdirSync(binDir, { recursive: true })

  // W3-5.5：引擎包改成**固定 tag** 而不是 `releases/latest`。
  //
  // 为什么要固定：`latest` 是一个会自己漂移的目标——— 上游一发新版，
  // 同一个 URL 下载到的就是另一份。后果两个：
  //   · 无法复现（今天下的和下周下的可能不一样）；
  //   · **断点续传失效**：半个 zip 还在硬盘上，但它不再是
  //     新包的前缀（下面那段注释说的就是这个）。
  // 固定 tag 之后，“重下一次”和“续传上一次”才是同一件事情。
  // env 仍然能覆盖（内网镜像 / 打包时托管）。
  const urls = [
    process.env.DSH_WECHAT_WHISPER_ENGINE_URL?.trim().replace(/\/$/, ''),
    `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_ENGINE_TAG}/whisper-bin-x64.zip`,
    `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_ENGINE_TAG}/whisper-bin-x64.zip`,
  ].filter((u): u is string => Boolean(u))

  let lastError = '引擎下载失败'
  for (const url of urls) {
    const zipPath = join(modelsDir, 'whisper-bin-x64.zip')
    try {
      // N13：有界重试；`timeoutScope: 'headers'` = 只在拿到响应头之前计时，
      // 流式读取不会在下载途中被连接超时掐断（每次尝试重新计时）。
      const res = await fetchWithRetry(fetch, url, { redirect: 'follow' }, {
        timeoutMs: ENGINE_CONNECT_TIMEOUT_MS,
        timeoutScope: 'headers',
        maxAttempts: DOWNLOAD_MAX_ATTEMPTS,
      })
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const reader = res.body.getReader()
      const stream = createWriteStream(zipPath)
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        stream.write(value)
        received += value.byteLength
        onProgress(received, total)
        // W3-5.5：取消检查点。引擎包只有 ~20MB，比模型短很多，
        // 但同样可能卡在一个不给力的链路上，所以同一个取消键对两路都生效。
        // 已写的部分不删：下次重下时正确的是整份重下（见上面「不做续传」的理由）。
        if (signal?.aborted === true) {
          throw Object.assign(new Error('已取消下载'), { code: 'WHISPER_DOWNLOAD_CANCELED' })
        }
      }
      await new Promise<void>((resolve, reject) => {
        stream.end(() => { resolve() })
        stream.on('error', reject)
      })
      const extractedBase = await extractZip(zipPath, modelsDir)
      const found = findFile(extractedBase, 'whisper-cli.exe')
      if (!found) throw new Error('压缩包内未找到 whisper-cli.exe')
      // The CLI depends on the sibling ggml-*.dll / llama.dll — move the whole
      // release folder contents into bin/ so DLLs sit next to the exe.
      const releaseDir = dirname(found)
      mkdirSync(binDir, { recursive: true })
      for (const name of readdirSync(releaseDir)) {
        const src = join(releaseDir, name)
        const dest = join(binDir, name)
        if (existsSync(dest)) continue
        try { renameSync(src, dest) } catch { /* cross-device: copy */ }
        if (!existsSync(dest)) {
          try { copyFileSync(src, dest); unlinkSync(src) } catch { /* best effort */ }
        }
      }
      try { rmSync(extractedBase, { recursive: true, force: true }) } catch { /* best effort */ }
      try { unlinkSync(zipPath) } catch { /* best effort */ }
      return existsSync(target) ? { ok: true, path: target } : { ok: false, error: 'whisper-cli.exe 安装失败（拷贝/移动未完成）' }
    } catch (e) {
      lastError = `${url} ${(e as Error).message}`
      // 引擎包**不做续传**：这个 URL 是 `releases/latest`，上游一发新版内容就换了，
      // 残留的半个 zip 不能保证还是新包的前缀（拼出来解不开，比整份重下更糟）。
      try { unlinkSync(zipPath) } catch { /* best effort */ }
    }
  }
  return { ok: false, error: lastError + '（可设置 DSH_WECHAT_WHISPER_ENGINE_URL 指向可达镜像，或 DSH_WECHAT_WHISPER_BIN 指向已安装的 whisper-cli.exe）' }
}

/**
 * PowerShell 的单引号字面量：唯一规则是把内部的 `'` 翻倍（口径与 vendored
 * `dsh-native-command` 里的同名 helper 一致）。
 *
 * 为什么需要它：`-Command` 拿到的是**一整段脚本文本**，不是 argv —— 路径里一个撇号
 * （真实用户名就有，如 `C:\Users\O'Brien\…`）就会提前终结那个字面量，后面的内容变成
 * **要执行的代码**。`tar.exe` 那一路走的是参数数组，不过 shell，所以没有这个问题；
 * 只有拼字符串的这一路需要转义（审计 P3-11）。
 */
export function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Zip extraction is a small local operation; still bounded so a broken tool cannot pin the worker. */
export const ZIP_EXTRACT_TIMEOUT_MS = 120_000

/** Run one extraction command asynchronously, collecting output and enforcing a hard deadline. */
async function runExtractProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, [...args], { windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ status, stdout, stderr })
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* process may already be gone */ }
      finish(null)
    }, timeoutMs)
    child.once('error', () => finish(null))
    child.once('close', (code) => finish(code))
  })
}

/**
 * 解压 zip 到暂存目录（顶层目录名忽略）。导出只为让"拼出来的那条命令"能被用例钉住。
 * @param zipPath - 待解压的 zip 路径。
 * @param destDir - 目标根目录。
 * @returns 暂存目录（真正的内容在其下一层）。
 */
export async function extractZip(zipPath: string, destDir: string): Promise<string> {
  const staging = join(destDir, '.engine-staging')
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* best effort */ }
  mkdirSync(staging, { recursive: true })
  const tar = await runExtractProcess('tar.exe', ['-xf', zipPath, '-C', staging], ZIP_EXTRACT_TIMEOUT_MS)
  if (tar.status === 0) return staging
  // Fallback: PowerShell Expand-Archive.
  const ps = await runExtractProcess(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${powershellLiteral(zipPath)} -DestinationPath ${powershellLiteral(staging)} -Force`],
    ZIP_EXTRACT_TIMEOUT_MS,
  )
  if (ps.status === 0) return staging
  // 最终兜底：纯 JS unzipper（不依赖系统 tar/PowerShell）。
  try {
    const nodeRequire = createRequire(import.meta.url)
    const unzipper = nodeRequire('unzipper')
    const zip = await unzipper.Open.file(zipPath)
    await zip.extract({ path: staging })
    return staging
  } catch {
    throw new Error('解压失败（tar/PowerShell/unzipper 均不可用）')
  }
}

/**
 * Deep search one filename under a dir (depth ≤ 4; dot-entries skipped so
 * staging leftovers never resolve as an engine source).
 */
function findFile(dir: string, name: string, depth = 0): string {
  if (depth > 4 || !existsSync(dir)) return ''
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = findFile(p, name, depth + 1)
        if (found) return found
      } else if (entry.name.toLowerCase() === name.toLowerCase()) {
        return p
      }
    }
  } catch { /* unreadable */ }
  return ''
}

/**
 * Stream one official ggml model file into the models dir (atomic .part →
 * rename), reporting received/total bytes.
 * @param modelId - model id from the catalog.
 * @param modelsDir - target models dir (created when missing).
 * @param onProgress - per-chunk progress callback (bytes, total bytes).
 * @returns ok + file/bytes, or an error description.
 */
export async function whisperDownloadModel(
  modelId: string,
  modelsDir: string,
  onProgress: (received: number, total: number) => void,
  /** W3-5.5：取消信号；已取消时抛带 `WHISPER_DOWNLOAD_CANCELED` 的错误。 */
  signal?: AbortSignal,
): Promise<{ ok: boolean; file?: string; bytes?: number; error?: string }> {
  const entry = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)
  if (!entry) return { ok: false, error: '未知模型: ' + modelId }
  const file = entry[1]
  const finalPath = join(modelsDir, file)
  if (existsSync(finalPath)) return { ok: true, file, bytes: 0 }
  // 「已经下过」是一条读，落在只读目录也算命中；只有真要落盘时才需要可写
  const refusal = whisperWriteRefusal(modelsDir)
  if (refusal) return { ok: false, error: refusal }
  mkdirSync(modelsDir, { recursive: true })

  let lastError = '下载失败'
  for (const base of whisperDownloadBases()) {
    const url = `${base}/ggerganov/whisper.cpp/resolve/main/${file}`
    const tmp = join(modelsDir, file + '.part')
    try {
      const bytes = await streamUrlToFile(url, tmp, DOWNLOAD_CONNECT_TIMEOUT_MS, onProgress, signal)
      renameSync(tmp, finalPath)
      reachableBase = base
      return { ok: true, file, bytes }
    } catch (e) {
      // W3-5.5：取消不属于任何一个镜像——— 立即往外抛，
      // 否则会接着尝试剩下两个镜像（用户點了取消却看见下载继续跑）。
      const err = e as { code?: string }
      if (err?.code === 'WHISPER_DOWNLOAD_CANCELED') throw e
      lastError = `${base} ${(e as Error).message}`
      // 刻意**不删** .part（旧实现在这里 unlink）：留着它，下一个镜像 / 用户下一次点击
      // 才能从断点接着下（1.5–3.1 GB 重下代价太大）。安全性由 206/200 判别、416 丢弃、
      // 完成后长度校验三条兜住 —— 半成品永远不会被当成正式模型（只有跑完整份才 rename）。
      // 模型文件名与 release 资产一一对应（`resolve/main/ggml-*.bin` 不会就地改写），
      // 所以残留字节仍是同一对象的合法前缀。
    }
  }
  return { ok: false, error: lastError }
}
