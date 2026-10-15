/**
 * WeChat voice-message source helpers: media_0.db VoiceInfo rows (silk v3
 * voice_data), Name2Id username mapping, and the wx_silk decoder process
 * (pure-Rust SILK v3 → WAV, bundled under resources/win32/x64).
 *
 * 全部连接经 `withDb` 打开（P0-1）：本文件原先同时存在「finally 关」和「catch 不关」两种写法，
 * 后者在 `prepare` 抛错时泄漏句柄。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onDiskPath } from '../asar-path.ts'
import { withDb } from './db-open.ts'

/** One VoiceInfo row with its chat username. */
export interface VoiceSource {
  chatId: string
  localId: string
  svrId: string
  username: string
}

function mediaDbPath(decryptedDir: string): string {
  return join(decryptedDir, 'message', 'media_0.db')
}

/** Map a chat_name_id (Name2Id rowid) to its user_name. */
export function usernameByChatId(decryptedDir: string, chatId: string): string {
  try {
    const row = withDb(mediaDbPath(decryptedDir), (db) => db.prepare('SELECT user_name FROM Name2Id WHERE rowid = CAST(? AS INTEGER) LIMIT 1').get(chatId) as { user_name?: unknown } | undefined)
    if (row && typeof row.user_name === 'string') return row.user_name
  } catch { /* db unavailable */ }
  return ''
}

/** Most recent voice messages (newest first). */
export function recentVoiceMessages(decryptedDir: string, limit: number): VoiceSource[] {
  const dbPath = mediaDbPath(decryptedDir)
  if (!existsSync(dbPath)) return []
  return withDb(dbPath, (db) => {
    const rows = db.prepare(
      `SELECT CAST(chat_name_id AS TEXT) AS c, CAST(local_id AS TEXT) AS l, CAST(svr_id AS TEXT) AS s
       FROM VoiceInfo ORDER BY create_time DESC LIMIT ?`,
    ).all(limit) as Array<{ c: string | null; l: string | null; s: string | null }>
    return rows.map((r) => {
      const chatId = r.c ?? ''
      const svrId = r.s ?? ''
      const localId = r.l ?? ''
      return { chatId, localId, svrId, username: usernameByChatId(decryptedDir, chatId) }
    })
  })
}

/** The raw silk voice_data bytes for a svr_id. */
export function voiceDataBySvr(decryptedDir: string, svrId: string): Buffer | null {
  const dbPath = mediaDbPath(decryptedDir)
  if (!existsSync(dbPath)) return null
  try {
    const row = withDb(dbPath, (db) => db.prepare('SELECT voice_data FROM VoiceInfo WHERE svr_id = CAST(? AS INTEGER) LIMIT 1').get(svrId) as { voice_data?: unknown } | undefined)
    if (row?.voice_data instanceof Uint8Array) return Buffer.from(row.voice_data)
    return null
  } catch {
    return null
  }
}

/** VoiceInfo svr_id for (username, local_id) — direct Name2Id mapping. */
export function svrIdByChatLocal(decryptedDir: string, username: string, localId: number): string {
  const dbPath = mediaDbPath(decryptedDir)
  if (!existsSync(dbPath)) return ''
  try {
    const chatRowId = withDb(dbPath, (db) => {
      const chat = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ? LIMIT 1').get(username) as { rowid?: number | bigint } | undefined
      return chat && typeof chat.rowid === 'number' ? chat.rowid : null
    })
    if (chatRowId === null) return ''
    return withDb(dbPath, (db) => {
      const row = db.prepare('SELECT CAST(svr_id AS TEXT) AS s FROM VoiceInfo WHERE chat_name_id = ? AND local_id = ? LIMIT 1').get(chatRowId, localId) as { s?: string | null } | undefined
      return row?.s ?? ''
    })
  } catch {
    return ''
  }
}

/**
 * Resolve the wx_silk decoder binary: env pin, bundled resources, '' when none.
 *
 * The bundled candidate must go through `onDiskPath` (N19): in a packaged
 * build the walk from `import.meta.url` lands inside app.asar, where
 * `existsSync` says the exe is there but `spawn` cannot run it (ENOENT).
 * Returning `''` instead of an unrunnable path keeps the caller's error
 * message honest ("打包资源缺失") when `asarUnpack` is not covering it.
 *
 * `startDir` exists so the packaged layout can be exercised as a **behaviour**
 * rather than as a source-string assertion: a spec builds
 * `<tmp>/app.asar/src/backend/wechat-data/lib` plus the unpacked sibling and
 * calls this function with it. (The first version of the guard asserted the
 * source contained `onDiskPath(candidate)`; leaving that string in a comment
 * and calling `existsSync` underneath kept it green while the bug returned.)
 * @param startDir - Directory to start the upward walk from; defaults to the
 *   directory of the emitted module.
 * @returns A runnable on-disk exe path, or `''` when there is none.
 */
export function silkDecoderBin(startDir?: string): string {
  const pinned = process.env.DSH_WECHAT_SILK_BIN
  if (pinned && pinned.trim().length > 0) return pinned.trim()
  try {
    // Walk up from the emitted module (lib or lib/types/query) to the package
    // root and look for resources/win32/x64/wx_silk.exe.
    let dir = startDir ?? fileURLToPath(new URL('.', import.meta.url))
    for (let i = 0; i < 5; i += 1) {
      const candidate = join(dir, 'resources', 'win32', 'x64', 'wx_silk.exe')
      const bin = onDiskPath(candidate)
      if (bin) return bin
      const parent = existingParent(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* bundled lookup best-effort */ }
  return ''
}

/** Parent dir that exists (dirname loop guard). */
function existingParent(dir: string): string {
  const parent = dirname(dir)
  return parent === dir ? dir : parent
}

/** Upper bound for one wx_silk decode. Bad input must not consume the whole call window. */
export const SILK_DECODE_TIMEOUT_MS = 120_000

/** Run one decoder process without ever blocking the worker's event loop. */
function runSilkDecoder(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  const child = spawn(bin, [...args], { windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (status: number | null, error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ status, stdout, stderr, error })
    }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* process may already be gone */ }
      finish(null, new Error(`silk 解码超时（${String(timeoutMs)}ms）`))
    }, timeoutMs)
    child.once('error', (error) => finish(null, error))
    child.once('close', (code) => finish(code))
  })
}

/** Collision-free temp name: length alone collided for concurrent equal-length messages. */
function silkTempPath(wavPath: string): string {
  return join(
    dirname(wavPath),
    `.wx_silk_${process.pid}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}.silk`,
  )
}

/**
 * Decode silk bytes to a WAV file via wx_silk (16 kHz mono, whisper-ready).
 * @param silk - raw voice_data bytes (leading 0x02 tolerated).
 * @param wavPath - output WAV path (parent dir created).
 * @param options.timeoutMs - decoder process bound (defaults to {@link SILK_DECODE_TIMEOUT_MS}).
 * @returns ok, or an error description.
 */
export async function silkToWav(
  silk: Buffer,
  wavPath: string,
  options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const bin = silkDecoderBin()
  if (!bin) return { ok: false, error: '未找到 wx_silk 解码器（DSH_WECHAT_SILK_BIN 或打包资源缺失）' }
  const silkPath = silkTempPath(wavPath)
  try {
    await mkdir(dirname(wavPath), { recursive: true })
    await writeFile(silkPath, silk)
    const res = await runSilkDecoder(bin, ['16000', silkPath, wavPath], options.timeoutMs ?? SILK_DECODE_TIMEOUT_MS)
    if (res.status === 0 && existsSync(wavPath)) return { ok: true }
    // `res.error` 单独看：exe 起不来（ENOENT/EACCES）与「解码器明确报错」是两回事，
    // 只报「退出码 null」会让「缺二进制」和「音频损坏」看起来一模一样（复审实测）。
    const reason = res.error?.message || res.stderr || `解码器退出码 ${String(res.status)}`
    return { ok: false, error: reason.trim().slice(0, 200) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    // 临时 silk 必须清掉：原先从不删除，本机 cached voices 目录实测已积了十余个残留。
    try { await rm(silkPath, { force: true }) } catch { /* 清理尽力而为 */ }
  }
}

/** 解码器输出固定为 16 kHz 单声道 16bit；WAV 头 44 字节。 */
const WAV_BYTES_PER_SEC = 16000 * 2
const WAV_HEADER_BYTES = 44

/**
 * 一条语音消息 → 可就地播放的 wav data URL。
 *
 * 复用**转写链路的缓存目录** `<decoded>/voices/<svr_id>.wav`（`voice-transcribe.ts` 也写这里），
 * 两边共用同一份产物：命中缓存 0ms；未命中才调打包的 wx_silk 解码（本机实测 **13ms**，
 * 16kHz 单声道下发 3.5 秒 ≈ 145KB / 51 秒 ≈ 2.1MB 的 base64，语音上限 60 秒，量级可接受）。
 *
 * 为什么用 data URL 而不是 `file://`：渲染进程 CSP 是 `media-src 'self' data: blob:`，
 * **不含 `file:`**，站内 `<audio src="file://…">` 会被直接拦掉。
 *
 * @param decryptedDir - decrypted data root.
 * @param decodedDir - decoded cache root (wav 落在其 voices/ 下).
 * @param username - conversation username.
 * @param localId - message local id.
 * @returns url (base64 wav) + durationSec, or an error description.
 */
export async function resolveVoiceDataUrl(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
): Promise<{ url?: string; durationSec?: number; error?: string }> {
  const svrId = svrIdByChatLocal(decryptedDir, username, localId)
  if (!svrId) return { error: '未找到语音消息' }
  const wavPath = join(decodedDir, 'voices', svrId + '.wav')
  if (!existsSync(wavPath)) {
    const data = voiceDataBySvr(decryptedDir, svrId)
    if (!data) return { error: '未找到语音数据' }
    const decoded = await silkToWav(data, wavPath)
    if (!decoded.ok) return { error: decoded.error ?? 'silk 解码失败' }
  }
  try {
    const bytes = await readFile(wavPath)
    if (bytes.length <= WAV_HEADER_BYTES) return { error: '语音数据为空' }
    return {
      url: 'data:audio/wav;base64,' + bytes.toString('base64'),
      durationSec: Math.round((bytes.length - WAV_HEADER_BYTES) / WAV_BYTES_PER_SEC),
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}
