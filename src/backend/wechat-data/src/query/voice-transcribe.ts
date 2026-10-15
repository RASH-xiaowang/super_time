/**
 * Local voice batch transcription: silk → WAV (wx_silk) → whisper-cli with the
 * selected ggml model → text cached as `<decoded>/voices/<svr_id>.txt`, WAVs
 * cached alongside so later runs only re-infer.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { recentVoiceMessages, silkToWav, svrIdByChatLocal, voiceDataBySvr } from './voice.ts'
import { yieldToLoop } from './search-build.ts'
import { WHISPER_DOWNLOAD_FILES } from './whisper.ts'

/** One per-message failure record. */
export interface TranscribeError {
  svrId: string
  username: string
  error: string
}

/** Batch transcription result. */
export interface VoiceBatchResult {
  ok: boolean
  total: number
  done: number
  failed: number
  skipped: number
  errors: TranscribeError[]
  engine: string
  model?: string
  error?: string
}

/** voice cache dir layout mirrors st_control: decoded_images/voices/. */
function voicesDir(decodedDir: string): string {
  return join(decodedDir, 'voices')
}

/** Cached transcript path for one voice message. */
export function transcriptPath(decodedDir: string, svrId: string): string {
  return join(voicesDir(decodedDir), svrId + '.txt')
}

/** Cached transcript text (empty when none). */
export function cachedTranscript(decodedDir: string, svrId: string): string {
  try {
    const t = readFileSync(transcriptPath(decodedDir, svrId), 'utf8').trim()
    return t
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// ASCII path aliases. whisper.cpp on Windows builds file paths from ANSI argv
// and opens them as UTF-8: any model/wav path containing non-ASCII characters
// aborts the process (0xC0000409). Junctions under an ASCII base give whisper
// an ASCII path to the same files.

/** Real parent dir → created ASCII junction path (per batch). */
/**
 * W3-5.4：批量转写的并发上界。
 *
 * 为什么小心把它写大：这里的“并发”是指一次最多几条 whisper 子进程
 * 在跑（spawn 出去同时等）。whisper 是 CPU 密集型，超过本机core 数
 * 之后互相抢，总时间反而变长；而 1 则与串行无异（那这条改动就白做）。
 * 2 是本机体感最好的值（双核以上的机器都能分到活）。
 */
export const TRANSCRIBE_CONCURRENCY = 2

const aliasLinks = new Map<string, string>()

function isAscii(s: string): boolean {
  return !/[^\x00-\x7f]/.test(s)
}

/** Pick a creatable ASCII alias base under (or near) the decoded data root. */
function pickAliasBase(decodedDir: string): string {
  const candidates = [join(decodedDir, '..', 'whisper-aliases'), join(tmpdir(), 'dsh-whisper-aliases')]
  for (const c of candidates) {
    if (!isAscii(c)) continue
    try {
      mkdirSync(c, { recursive: true })
      return c
    } catch { /* try next */ }
  }
  return tmpdir()
}

/** Ensure the ASCII junction for one real directory exists; returns its path. */
function ensureAsciiLink(realDir: string, aliasBase: string): string {
  const cached = aliasLinks.get(realDir)
  if (cached) return cached
  let link = join(aliasBase, 'wpa-' + createHash('sha1').update(realDir.toLowerCase()).digest('hex').slice(0, 12))
  try {
    if (existsSync(link)) {
      const target = readlinkSync(link).replace(/[\\/]+$/, '').toLowerCase()
      if (target !== realDir.replace(/[\\/]+$/, '').toLowerCase()) {
        rmSync(link, { recursive: true, force: true })
        symlinkSync(realDir, link, 'junction')
      }
    } else {
      symlinkSync(realDir, link, 'junction')
    }
  } catch {
    link = realDir // junctions unavailable: whisper will surface the aborted path
  }
  aliasLinks.set(realDir, link)
  return link
}

/**
 * Map a file path to an ASCII equivalent (junction alias for non-ASCII parent
 * dirs) so whisper-cli can open it; ASCII paths pass through untouched.
 * @param filePath - model/wav/output path to hand to whisper.
 * @param aliasBase - ASCII dir that holds the junction links.
 * @returns an ASCII-safe path to the same file.
 */
export function asciiPathForWhisper(filePath: string, aliasBase: string): string {
  if (isAscii(filePath)) return filePath
  return join(ensureAsciiLink(dirname(filePath), aliasBase), basename(filePath))
}

/**
 * Whisper 走**异步 spawn**（2026-10-13）。
 *
 * 为什么需要：内联分析（`laya/analysis.ts` 的 analyzeVisibleMessages）会给每条语音消息
 * 做转写，而 `spawnSync` 让整个 worker 在 whisper 的 2–4 秒里**完全独占**——用户实测
 * `getSessions` 排队 2.2s、消息查询被顶成秒级（「消息同步慢、会话列表更慢」的正主）。
 * 异步 spawn 期间事件循环照常服务别的请求；语义（输出解析/错误）与同步版逐条一致。
 */
export async function whisperOneAsync(bin: string, modelPath: string, wavPath: string, outBase: string): Promise<string> {
  const child = spawn(bin, ['-m', modelPath, '-f', wavPath, '-l', 'auto', '-np', '--no-timestamps', '-otxt', '-of', outBase], {
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += String(d) })
  child.stderr.on('data', (d) => { stderr += String(d) })
  const killTimer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 600_000)
  try {
    const status: number | null = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(null))
      child.on('close', (code) => resolve(code))
    })
    if (status === 0 && existsSync(outBase + '.txt')) {
      const text = readFileSync(outBase + '.txt', 'utf8').trim()
      if (text) return text
    }
    if (status === null) throw new Error('whisper-cli 启动失败')
    const out = stdout.trim()
    if (out) return out
    throw new Error(stderr.trim() || `whisper-cli 退出码 ${String(status)}`)
  } finally {
    clearTimeout(killTimer)
  }
}

/**
 * Whisper 走**异步 spawn**（内联分析专用）。
 * 缓存命中/语音数据缺失/SILK 解码失败的路径仍可测；只有 whisper 那一步
 * 从「阻塞等子进程」改成「事件循环照常服务别的请求」（2026-10-13）。
 */
async function transcribeVoiceTextAsync(
  decryptedDir: string,
  decodedDir: string,
  modelPath: string,
  engineBin: string,
  svrId: string,
  aliasBase: string,
): Promise<{ text?: string; error?: string }> {
  const vdir = voicesDir(decodedDir)
  mkdirSync(vdir, { recursive: true })
  const existing = cachedTranscript(decodedDir, svrId)
  if (existing) return { text: existing }
  try {
    const wavPath = join(vdir, svrId + '.wav')
    if (!existsSync(wavPath)) {
      const silk = voiceDataBySvr(decryptedDir, svrId)
      if (!silk) return { error: 'VoiceInfo 无语音数据' }
      const dec = await silkToWav(silk, wavPath)
      if (!dec.ok) return { error: 'SILK 解码失败: ' + (dec.error ?? '') }
    }
    const wavPathA = asciiPathForWhisper(wavPath, aliasBase)
    const outBaseA = asciiPathForWhisper(join(vdir, svrId), aliasBase)
    const modelPathA = asciiPathForWhisper(modelPath, aliasBase)
    const text = await whisperOneAsync(engineBin, modelPathA, wavPathA, outBaseA)
    if (text) {
      writeFileSync(transcriptPath(decodedDir, svrId), text, 'utf8')
      return { text }
    }
    return { error: '转写结果为空' }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/**
 * Whisper 走**异步 spawn**——
 * 内联分析路径专用（`laya/analysis.ts` 会 `await` 它）：转写期间 worker
 * 不再被独占，消息查询/会话列表照常服务（2026-10-13 用户报「新消息同步慢」的根因修复）。
 */
export async function transcribeOneVoiceAsync(
  decryptedDir: string,
  decodedDir: string,
  modelsDir: string,
  modelId: string,
  engineBin: string,
  username: string,
  localId: number,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const modelFile = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)?.[1]
  if (!modelFile) return { ok: false, error: '未知模型: ' + modelId }
  const modelPath = join(modelsDir, modelFile)
  if (!existsSync(modelPath)) return { ok: false, error: `模型未安装: ${modelFile}` }
  if (!existsSync(engineBin)) return { ok: false, error: '未找到 whisper.cpp 引擎: ' + engineBin }
  const svrId = svrIdByChatLocal(decryptedDir, username, localId)
  if (!svrId) return { ok: false, error: '未找到语音消息' }
  const r = await transcribeVoiceTextAsync(decryptedDir, decodedDir, modelPath, engineBin, svrId, pickAliasBase(decodedDir))
  return r.text ? { ok: true, text: r.text } : { ok: false, error: r.error ?? '转写失败' }
}

/**
 * Batch-transcribe the most recent voice messages.
 * @param decryptedDir - decrypted data root (VoiceInfo source).
 * @param decodedDir - decoded-images cache root (wav/txt caches).
 * @param modelsDir - model cache dir.
 * @param modelId - selected model id ('tiny' | ... | 'turbo').
 * @param engineBin - whisper-cli binary path.
 * @param limit - max voice messages to process (newest first).
 * @param onProgress - per-message progress callback.
 * @returns VoiceBatchResult with ok/done/failed/skipped counts.
 */
export async function transcribeVoiceBatch(
  decryptedDir: string,
  decodedDir: string,
  modelsDir: string,
  modelId: string,
  engineBin: string,
  limit: number,
  onProgress: (done: number, total: number, failed: number, current: string) => void,
): Promise<VoiceBatchResult> {
  const modelFile = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)?.[1]
  if (!modelFile) return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: engineBin, error: '未知模型: ' + modelId })
  const modelPath = join(modelsDir, modelFile)
  if (!existsSync(modelPath)) {
    return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: engineBin, model: modelFile, error: `模型未安装: ${modelFile}（请先下载或放入模型目录）` })
  }
  if (!existsSync(engineBin)) {
    return Promise.resolve({ ok: false, total: 0, done: 0, failed: 0, skipped: 0, errors: [], engine: engineBin, model: modelFile, error: '未找到 whisper.cpp 引擎: ' + engineBin })
  }

  const sources = recentVoiceMessages(decryptedDir, Math.max(1, limit))
  // whisper-cli aborts on non-ASCII file paths (UTF-8-only): alias them once.
  const aliasBase = pickAliasBase(decodedDir)
  const errors: TranscribeError[] = []
  let done = 0
  let failed = 0
  let skipped = 0
  const outcomes = new Array<{ kind: 'done' | 'skipped' | 'failed'; error?: string } | undefined>(sources.length)
  let nextReport = 0
  let nextSource = 0
  const finishOne = (index: number, outcome: { kind: 'done' | 'skipped' | 'failed'; error?: string }): void => {
    outcomes[index] = outcome
    if (outcome.kind === 'done') done += 1
    else if (outcome.kind === 'failed') failed += 1
    else skipped += 1
    // 进度按入队顺序上报：worker 完成顺序可以乱，但 UI 的「第 x/y」不能倒着跳。
    while (nextReport < sources.length && outcomes[nextReport]) {
      const src = sources[nextReport]!
      onProgress(nextReport + 1, sources.length, failed, src.svrId)
      nextReport += 1
    }
  }

  /**
   * W3 批次：逐条让出 + 有界并发（1.1 + 5.4）。
   *
   * 这里走异步转写器：单条 whisper 会跑几秒，
   * 同步版即便逐条 `yieldToLoop`，每次进入转写时仍会把 worker 钉住整段时间。
   * 异步 spawn 让子进程运行期间事件循环继续服务别的查询；并发池只是把
   * 200 条这样的任务从「串行等」变成「最多两个 whisper 进程同时跑」。
   */
  const workers = Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, sources.length) }, () => (async () => {
    for (;;) {
      const index = nextSource
      nextSource += 1
      if (index >= sources.length) return
      const src = sources[index]!
      await yieldToLoop()
      const existing = cachedTranscript(decodedDir, src.svrId)
      if (existing) {
        finishOne(index, { kind: 'skipped' })
        continue
      }
      const r = await transcribeVoiceTextAsync(decryptedDir, decodedDir, modelPath, engineBin, src.svrId, aliasBase)
      if (r.text) {
        finishOne(index, { kind: 'done' })
      } else if (r.error === '转写结果为空') {
        finishOne(index, { kind: 'skipped' })
      } else {
        const error = r.error ?? '转写失败'
        finishOne(index, { kind: 'failed', error })
      }
    }
  })())
  await Promise.all(workers)
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]
    if (outcome?.kind === 'failed') {
      const src = sources[index]!
      errors.push({ svrId: src.svrId, username: src.username, error: outcome.error ?? '转写失败' })
    }
  }
  return Promise.resolve({
    ok: errors.length === 0, total: sources.length, done, failed, skipped, errors, engine: engineBin, model: modelFile,
  })
}
