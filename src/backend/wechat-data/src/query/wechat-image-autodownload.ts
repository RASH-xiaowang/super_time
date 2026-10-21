/**
 * 微信原图自动下载（实验）：让微信自己在接收新图片时下载高清原图。
 *
 * ## 它补的是哪一段
 *
 * 本仓库原有的「原图」通路有三条（本机 `_h.dat` 重解 / 消息里的免登录直链 / 第三方服务），
 * 但都覆盖不了「本机只有缩略图、XML 只有 `cdnbigimgurl`」的那部分：聊天图片走 mmtls 私有 RPC，
 * 卡片里没有可直取的 HTTP 直链（详见 `original-harvester.ts` / `wxcdn-original.ts` 的实测注释）。
 *
 * 微信**自己**能下载原图（默认只下缩略图）。本模块复用上游 WeFlow-X（MIT）的
 * `img_helper.dll`（`native/img_helper/`），把它注入正在运行的微信进程，接管「收到图片」
 * 之后的下载策略：注入之后，**新收到 / 新同步到的图片**会由微信按原图下载。
 * 本应用自己不实现 mmtls、不接触登录凭据、不向微信服务器发任何请求。
 *
 * ## 边界（必须让用户知道，界面照实显示）
 *
 *   · 只影响**注入之后**新收到的图片；历史图片不会补下载（仍可在微信里点开一次原图，
 *     由「原图自动收割」接住）。
 *   · 注入是**进程内**的：正常停止会调用 `UninstallImgHelper`；应用被强杀/崩溃时微信可能
 *     保持被修改状态，直到微信重启。本模块在数据根写 marker，下次启动如实回报
 *     `cleanupUnconfirmed`，并在微信未重启时拒绝重复注入。
 *   · 仅 win32-x64；微信版本兼容性未声明（上游 provenance 的 `testedWechatVersions` 为空），
 *     失败会落到 `IMAGE_AUTODOWNLOAD_*` 错误码。
 *   · 组件加载前复核 SHA-256（与清单钉死值一致，见 `native/img_helper/PROVENANCE.md`）。
 *
 * ## 与「原图自动收割」的分工
 *
 * 收割是只读的（盯 `_h.dat` 落盘）；本模块是仓库里**唯一会修改微信进程内存**的可选功能，
 * 默认关闭，必须由用户在设置里显式打开。
 *
 * 依赖方向：query 层 → config 层（与 `keys/*` 同一口径）；不 import gateway/remotes/types。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { onDiskPath } from '../asar-path.ts'
import { getConfig, saveConfig } from '../config/wechat-config.ts'
import { weixinVersion } from '../config/detect.ts'

/** 一次动作（与 `@Remote('wechatImageAutoDownload')` 的入参对齐）。 */
export type WechatImageAutoDownloadAction = 'start' | 'stop' | 'status'

/** 运行状态机。 */
export type WechatImageAutoDownloadState =
  | 'unsupported'
  | 'idle'
  | 'waiting_wechat'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed'

/** 给界面看的完整状态（`getWechatImageAutoDownloadStatus` 的返回值）。 */
export interface WechatImageAutoDownloadStatus {
  /** 当前平台/组件是否具备开启条件（win32-x64 + 组件存在）。 */
  supported: boolean
  /** 配置里的持久开关（用户上次是否打开）。 */
  enabled: boolean
  /** 本进程是否在轮询（注入成功后 30s 一次重挂/探活）。 */
  watching: boolean
  /** 当前是否已成功注入微信进程。 */
  hooked: boolean
  /** 运行状态机。 */
  state: WechatImageAutoDownloadState
  /** 错误码（`IMAGE_AUTODOWNLOAD_*`）；空串 = 无错误。 */
  code: string
  /** 人类可读说明（错误时可直接显示）。 */
  message: string
  /** 被注入的微信进程 pid；未注入为 null。 */
  pid: number | null
  /** 本机检测到的微信版本（可能为空串）。 */
  wechatVersion: string
  /** 白名单里的会话数；0 = 全部会话（与上游组件语义一致）。 */
  whitelistCount: number
  /** 组件绝对路径（找不到为空串）。 */
  helperPath: string
  /** 组件 SHA-256（清单钉死值）。 */
  helperSha256: string
  /** 本次进程内是否已完成组件完整性复核。 */
  helperVerified: boolean
  /**
   * 上次退出可能没来得及还原注入（marker 存在且微信进程未重启）。
   * 为 true 时界面应提示用户重启微信，本模块也会拒绝重复注入。
   */
  cleanupUnconfirmed: boolean
  /** 最近一次失败时间戳（毫秒）；从未失败为 0。 */
  lastErrorAt: number
}

/** 组件完整性钉死值（`native/img_helper/win32-x64/img_helper.dll`）。 */
export const IMAGE_AUTODOWNLOAD_HELPER_SHA256 = '79596be6f0da84f25a763973f6d1a439bcd8df2c0300891f6d419984f16cfc91'

/** 轮询间隔：微信重启后最多 30s 重新接入。 */
const POLL_MS = 30_000
/** 白名单上限（与上游组件的 NUL 串体积折中；0 = 全量）。 */
const MAX_WHITELIST = 500
/** 单条 username 上限（微信 username 远小于此）。 */
const MAX_USERNAME_LEN = 256
/** 数据根下的清理标记（记录上次注入的 pid；用于崩溃后如实回报）。 */
const MARKER_NAME = 'wechat-image-autodownload.state.json'

/** 与 dll 绑定的三个导出（只在这里出现，便于测试替换）。 */
export interface ImageAutoDownloadHelper {
  /** `InitImgHelper(pid, whitelist)`；失败返回 false。 */
  init: (pid: number, whitelist: Buffer | null) => boolean
  /** `UninstallImgHelper()`；释放注入并还原字节。 */
  uninstall: () => void
  /** `GetImgHelperError()` 的字符串结果（失败原因）。 */
  error: () => string
}

/**
 * 可替换的运行时依赖（生产走真实实现；单测注入假的，避免加载 koffi / 注入进程）。
 * 只暴露本模块真正用到的面。
 */
export interface ImageAutoDownloadDeps {
  platform: string
  arch: string
  /** 找微信主进程 pid；没运行返回 null。 */
  findPid: () => number | null
  /** 加载组件（校验 + koffi 绑定）；失败抛错。 */
  loadHelper: () => Promise<ImageAutoDownloadHelper>
  /** 解析组件绝对路径；找不到返回空串。 */
  resolveHelperPath: () => string
  readConfig: (decryptedDir: string) => Record<string, unknown>
  saveConfig: (decryptedDir: string, patch: Record<string, unknown>) => { ok: boolean; error?: string }
  /** 本机微信版本（仅用于状态展示）。 */
  wechatVersion: () => string
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  onExit: (fn: () => void) => void
}

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/**
 * `process.resourcesPath` 只有 Electron 主进程有（types/node 没有该字段）。
 * 纯 Node（测试/冒烟）下取不到时返回空串。
 */
function processResourcesPath(): string {
  const p = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return typeof p === 'string' ? p : ''
}

/** 组件候选路径：打包态 → 构建产物（lib/）→ 源码布局（src/query/）。 */
function defaultResolveHelperPath(): string {
  const rel = ['native', 'img_helper', 'win32-x64', 'img_helper.dll']
  const resources = processResourcesPath()
  const candidates = [
    ...(resources === '' ? [] : [join(resources, 'app.asar.unpacked', 'src', 'backend', 'wechat-data', ...rel)]),
    join(HERE, '..', ...rel),
    join(HERE, '..', '..', ...rel),
  ]
  for (const candidate of candidates) {
    const usable = onDiskPath(candidate)
    if (usable !== '') return usable
  }
  return ''
}

interface KoffiFunction {
  (...args: unknown[]): unknown
}
interface KoffiLibrary {
  func: {
    (prototype: string): KoffiFunction
  }
}
interface KoffiModule {
  load: (path: string) => KoffiLibrary
}

/** 真实加载：先复核 SHA-256，再 koffi 绑定三个导出。 */
async function defaultLoadHelper(): Promise<ImageAutoDownloadHelper> {
  const path = defaultResolveHelperPath()
  if (path === '') throw new Error('找不到原图自动下载组件（native/img_helper/win32-x64/img_helper.dll）')
  const bytes = readFileSync(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== IMAGE_AUTODOWNLOAD_HELPER_SHA256) {
    throw new Error(
      `原图自动下载组件完整性校验失败（期望 ${IMAGE_AUTODOWNLOAD_HELPER_SHA256.slice(0, 16)}…，`
      + `实际 ${sha256.slice(0, 16)}…），已拒绝加载`,
    )
  }
  const koffi = (await import('koffi')).default as unknown as KoffiModule
  const lib = koffi.load(path)
  const init = lib.func('bool InitImgHelper(uint32, const char*)')
  const uninstall = lib.func('void UninstallImgHelper()')
  const lastError = lib.func('const char* GetImgHelperError()')
  return {
    init(pid, whitelist) {
      const result = init(pid, whitelist)
      return result === true || Number(result) === 1
    },
    uninstall() {
      uninstall()
    },
    error() {
      const value = lastError()
      return typeof value === 'string' ? value : ''
    },
  }
}

/** 一行 `Get-CimInstance Win32_Process` 结果的最小形状。 */
interface ProcessRow {
  ProcessId?: number
  CommandLine?: string | null
}

function isProcessRow(value: unknown): value is ProcessRow {
  return typeof value === 'object' && value !== null
}

/**
 * 找微信**主**进程：优先 PowerShell/CIM（命令行里含 `weixin.exe`、命令行最短的那个，
 * 与上游 WeFlow 的判据一致）；PowerShell 不可用时退回 tasklist 的第一个 `Weixin.exe`。
 */
function defaultFindPid(): number | null {
  if (process.platform !== 'win32') return null
  try {
    const script = "Get-CimInstance Win32_Process -Filter \"Name = 'Weixin.exe'\" "
      + '| Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
    const parsed: unknown = JSON.parse(out.trim() === '' ? 'null' : out.trim())
    const rows = (Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]).filter(isProcessRow)
    const matched = rows
      .filter((row) => typeof row.CommandLine === 'string' && row.CommandLine.toLowerCase().includes('weixin.exe'))
      .sort((a, b) => (a.CommandLine ?? '').length - (b.CommandLine ?? '').length)
    const first = matched[0]
    if (first !== undefined && typeof first.ProcessId === 'number') return first.ProcessId
  } catch { /* PowerShell 不可用/超时：走 tasklist 兜底 */ }
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    for (const line of out.split(/\r?\n/)) {
      const match = /^"([^"]+)"\s*,\s*"(\d+)"/.exec(line.trim())
      if (match === null) continue
      if ((match[1] ?? '').toLowerCase() !== 'weixin.exe') continue
      const pid = parseInt(match[2] ?? '', 10)
      if (Number.isFinite(pid) && pid > 0) return pid
    }
  } catch { /* tasklist 不可用 */ }
  return null
}

const defaultDeps: ImageAutoDownloadDeps = {
  platform: process.platform,
  arch: process.arch,
  findPid: defaultFindPid,
  loadHelper: defaultLoadHelper,
  resolveHelperPath: defaultResolveHelperPath,
  readConfig: (decryptedDir) => getConfig(decryptedDir),
  saveConfig: (decryptedDir, patch) => saveConfig(decryptedDir, patch),
  wechatVersion: () => {
    try {
      return weixinVersion()
    } catch {
      return ''
    }
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setInterval(fn, ms)
    ;(handle as unknown as { unref?: () => void }).unref?.()
    return handle
  },
  clearTimer: (handle) => { clearInterval(handle as ReturnType<typeof setInterval>) },
  onExit: (fn) => { process.once('exit', fn) },
}

/** 进程内单例状态（同一时刻只服务一个数据根 / 一个微信账号）。 */
let deps: ImageAutoDownloadDeps = defaultDeps
let root = ''
let timer: unknown = null
let helper: ImageAutoDownloadHelper | null = null
let hookedPid: number | null = null
let state: WechatImageAutoDownloadState = 'idle'
let code = ''
let message = ''
let lastErrorAt = 0
let cleanupUnconfirmed = false
let exitHookInstalled = false
let helperVerified = false

/** 状态快照里需要但不进状态机的那几个字段，由 `status()` 现算。 */
function resolveHelperPathSafe(): string {
  try {
    return deps.resolveHelperPath()
  } catch {
    return ''
  }
}

function isSupported(): boolean {
  return deps.platform === 'win32' && deps.arch === 'x64' && resolveHelperPathSafe() !== ''
}

/** 把任意配置值收成安全的会话白名单（去重、限长、限条数）。 */
export function sanitizeWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '' || trimmed.length > MAX_USERNAME_LEN) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
    if (out.length >= MAX_WHITELIST) break
  }
  return out
}

/**
 * 组件要的白名单形态：`a\0b\0\0`（NUL 分隔、双 NUL 结尾）；空列表 = 全部会话（null）。
 * @param whitelist - 已净化的 username 列表。
 * @returns 传给 `InitImgHelper` 的第二个参数。
 */
export function buildWhitelistBuffer(whitelist: readonly string[]): Buffer | null {
  if (whitelist.length === 0) return null
  return Buffer.from(whitelist.join('\0') + '\0\0', 'utf8')
}

function markerPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), MARKER_NAME)
}

interface MarkerShape {
  pid?: number
  at?: number
}

function readMarker(decryptedDir: string): MarkerShape | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath(decryptedDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const row = parsed as MarkerShape
    return { pid: typeof row.pid === 'number' ? row.pid : undefined, at: typeof row.at === 'number' ? row.at : undefined }
  } catch {
    return null
  }
}

function writeMarker(decryptedDir: string, pid: number): void {
  try {
    mkdirSync(dirname(markerPath(decryptedDir)), { recursive: true })
    writeFileSync(markerPath(decryptedDir), JSON.stringify({ pid, at: deps.now(), helperSha256: IMAGE_AUTODOWNLOAD_HELPER_SHA256 }), 'utf8')
  } catch { /* marker 只是提示，不阻断主流程 */ }
}

function clearMarker(decryptedDir: string): void {
  try {
    rmSync(markerPath(decryptedDir), { force: true })
  } catch { /* 已不存在 */ }
}

function fail(nextCode: string, nextMessage: string): void {
  state = 'failed'
  code = nextCode
  message = nextMessage
  lastErrorAt = deps.now()
}

function resetRuntime(): void {
  if (timer !== null) {
    try {
      deps.clearTimer(timer)
    } catch { /* 已被清理 */ }
    timer = null
  }
  helper = null
  hookedPid = null
  helperVerified = false
  state = 'idle'
  code = ''
  message = ''
  lastErrorAt = 0
  cleanupUnconfirmed = false
}

/**
 * 切换/初始化数据根。换账号时先尽力还原上一账号的注入，避免把注入留在旧进程里。
 * @param decryptedDir - 解密数据根（数据根下的 config.json 决定开关）。
 */
function ensureRoot(decryptedDir: string): void {
  if (root === decryptedDir) return
  if (root !== '') {
    try {
      const prior = root
      if (hookedPid !== null) helper?.uninstall()
      clearMarker(prior)
    } catch { /* 尽力还原 */ }
    timer = null
  }
  resetRuntime()
  root = decryptedDir
  const marker = readMarker(decryptedDir)
  if (marker !== null && typeof marker.pid === 'number') {
    const livePid = deps.findPid()
    if (livePid !== null && livePid === marker.pid) {
      // 上次进程没走到 Uninstall：微信仍是同一个进程，注入可能还在。
      cleanupUnconfirmed = true
      state = 'failed'
      code = 'IMAGE_AUTODOWNLOAD_CLEANUP_UNCONFIRMED'
      message = '上次退出未确认清理：请先重启微信，再重新开启原图自动下载'
    } else {
      clearMarker(decryptedDir)
    }
  }
}

function readEnabled(decryptedDir: string): boolean {
  try {
    return deps.readConfig(decryptedDir)['wechat_image_autodownload_enabled'] === true
  } catch {
    return false
  }
}

function readWhitelist(decryptedDir: string): string[] {
  try {
    return sanitizeWhitelist(deps.readConfig(decryptedDir)['wechat_image_autodownload_whitelist'])
  } catch {
    return []
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  deps.onExit(() => {
    try {
      if (hookedPid !== null) {
        helper?.uninstall()
        clearMarker(root)
      }
    } catch { /* exit 阶段只能力争 */ }
  })
}

/** 尝试注入一次（幂等：已注入直接返回）。 */
async function attemptHook(): Promise<void> {
  if (hookedPid !== null || cleanupUnconfirmed) return
  const pid = deps.findPid()
  if (pid === null) {
    state = 'waiting_wechat'
    code = 'IMAGE_AUTODOWNLOAD_WAITING_WECHAT'
    message = '等待微信启动'
    return
  }
  state = 'starting'
  code = ''
  message = ''
  try {
    if (helper === null) helper = await deps.loadHelper()
    if (helper === null) throw new Error('组件未加载')
    helperVerified = true
    const whitelist = buildWhitelistBuffer(readWhitelist(root))
    const ok = helper.init(pid, whitelist)
    if (!ok) {
      const err = helper.error()
      try { helper.uninstall() } catch { /* 失败时尽力还原 */ }
      fail('IMAGE_AUTODOWNLOAD_INIT_FAILED', err === '' ? '注入微信进程失败（组件未返回原因）' : err)
      return
    }
    hookedPid = pid
    writeMarker(root, pid)
    installExitHook()
    state = 'running'
    code = ''
    message = ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    fail('IMAGE_AUTODOWNLOAD_COMPONENT_ERROR', msg)
  }
}

/** 30s 一次：微信重启后重新接入；组件被卸载/进程消失时更新状态。 */
async function tick(): Promise<void> {
  if (root === '') return
  if (!readEnabled(root)) {
    await stopWechatImageAutoDownload()
    return
  }
  if (hookedPid !== null) {
    const livePid = deps.findPid()
    if (livePid === null || livePid !== hookedPid) {
      try { helper?.uninstall() } catch { /* 目标进程可能已退出 */ }
      hookedPid = null
      clearMarker(root)
      state = livePid === null ? 'waiting_wechat' : 'idle'
      code = livePid === null ? 'IMAGE_AUTODOWNLOAD_WAITING_WECHAT' : ''
      message = livePid === null ? '微信已退出，等待重新启动' : ''
      if (livePid !== null) await attemptHook()
    }
    return
  }
  if (cleanupUnconfirmed) return
  await attemptHook()
}

function startWatching(): void {
  if (timer !== null) return
  timer = deps.setTimer(() => { void tick() }, POLL_MS)
}

/** 计算当前状态快照（纯读，不改状态机）。 */
export function getWechatImageAutoDownloadStatus(decryptedDir: string): WechatImageAutoDownloadStatus {
  ensureRoot(decryptedDir)
  const supported = isSupported()
  const enabled = readEnabled(decryptedDir)
  let reported = state
  if (!supported) reported = 'unsupported'
  else if (reported === 'idle' && enabled && timer === null) reported = 'idle'
  const helperPath = resolveHelperPathSafe()
  return {
    supported,
    enabled,
    watching: timer !== null,
    hooked: hookedPid !== null,
    state: reported,
    code,
    message,
    pid: hookedPid,
    wechatVersion: deps.wechatVersion(),
    whitelistCount: readWhitelist(decryptedDir).length,
    helperPath,
    helperSha256: IMAGE_AUTODOWNLOAD_HELPER_SHA256,
    helperVerified,
    cleanupUnconfirmed,
    lastErrorAt,
  }
}

/**
 * 打开自动下载（先落盘开关，再开始注入并挂 30s 轮询）。
 * @param decryptedDir - 解密数据根。
 * @returns 最新状态快照。
 */
export async function startWechatImageAutoDownload(decryptedDir: string): Promise<WechatImageAutoDownloadStatus> {
  ensureRoot(decryptedDir)
  if (!isSupported()) {
    fail('IMAGE_AUTODOWNLOAD_UNSUPPORTED', '当前系统不支持原图自动下载（仅 Windows x64，且需组件存在）')
    return getWechatImageAutoDownloadStatus(decryptedDir)
  }
  if (cleanupUnconfirmed) {
    fail('IMAGE_AUTODOWNLOAD_CLEANUP_UNCONFIRMED', '上次退出未确认清理：请先重启微信，再重新开启原图自动下载')
    return getWechatImageAutoDownloadStatus(decryptedDir)
  }
  state = 'starting'
  code = ''
  message = ''
  startWatching()
  await attemptHook()
  return getWechatImageAutoDownloadStatus(decryptedDir)
}

/**
 * 启动恢复的延迟（毫秒）。
 *
 * 为什么不在 init 里同步恢复：`startWechatImageAutoDownload` 会先同步跑一轮进程发现
 * （`deps.findPid()` = PowerShell/CIM 查询，本机实测 217ms，超时上限 10s），
 * 而它正好落在「后端 ready」的返回路径上 —— 实测把后端 ready 从 ~120ms 拖到 ~340ms，
 * 并且这 217ms 是**主线程同步阻塞**，会和首屏查询抢同一个事件循环。
 *
 * 延后到首屏之后：开关与支持性仍在 boot 里判断（毫秒级），真正的 marker 校验 + 注入
 * 放到这个延迟之后。语义不变（仍在启动阶段自动恢复），只是不再挡 ready/首屏。
 */
export const BOOT_RESUME_DELAY_MS = 1200

/** 等待中的「启动恢复」票据：stop() 或配置关闭时取消，避免取消后又被定时器注入回来。 */
let bootResumeToken: { cancelled: boolean } | null = null

/**
 * 开启自动下载并尽力还原微信进程（幂等）。
 * @returns 最新状态快照。
 */
export async function stopWechatImageAutoDownload(): Promise<WechatImageAutoDownloadStatus> {
  // 先取消尚未执行的「启动恢复」：否则 stop 之后定时器到点还会把注入装回去。
  if (bootResumeToken !== null) {
    bootResumeToken.cancelled = true
    bootResumeToken = null
  }
  if (timer !== null) {
    try {
      deps.clearTimer(timer)
    } catch { /* 已清理 */ }
    timer = null
  }
  if (hookedPid !== null || helper !== null) {
    state = 'stopping'
    try {
      helper?.uninstall()
    } catch (e) {
      cleanupUnconfirmed = true
      fail('IMAGE_AUTODOWNLOAD_CLEANUP_UNCONFIRMED', e instanceof Error ? e.message : String(e))
    }
    hookedPid = null
    if (!cleanupUnconfirmed) {
      clearMarker(root)
      state = 'idle'
      code = ''
      message = ''
    }
  } else {
    state = 'idle'
  }
  return getWechatImageAutoDownloadStatus(root)
}

/**
 * `@Remote('wechatImageAutoDownload')` 的实现体：一次性动作 + 状态。
 * @param decryptedDir - 解密数据根。
 * @param action - `start` 打开开关并接入 / `stop` 关闭并还原 / `status` 只读。
 * @returns 最新状态快照。
 */
export async function wechatImageAutoDownload(
  decryptedDir: string,
  action: WechatImageAutoDownloadAction,
): Promise<WechatImageAutoDownloadStatus> {
  ensureRoot(decryptedDir)
  if (action === 'status') return getWechatImageAutoDownloadStatus(decryptedDir)
  if (action === 'start') {
    const saved = deps.saveConfig(decryptedDir, {
      wechat_image_autodownload_enabled: true,
      wechat_image_autodownload_whitelist: readWhitelist(decryptedDir),
    })
    if (!saved.ok) {
      fail('IMAGE_AUTODOWNLOAD_SETTINGS_SAVE_FAILED', saved.error ?? '保存设置失败')
      return getWechatImageAutoDownloadStatus(decryptedDir)
    }
    return await startWechatImageAutoDownload(decryptedDir)
  }
  const saved = deps.saveConfig(decryptedDir, { wechat_image_autodownload_enabled: false })
  if (!saved.ok) {
    fail('IMAGE_AUTODOWNLOAD_SETTINGS_SAVE_FAILED', saved.error ?? '保存设置失败')
    return getWechatImageAutoDownloadStatus(decryptedDir)
  }
  return await stopWechatImageAutoDownload()
}

/**
 * 后端启动时调用：上次开关是打开的，就自动恢复注入（失败不阻断启动）。
 * @param decryptedDir - 解密数据根。
 * @returns `null` = 无需/不能自动恢复；否则带一个同步 stop 钩子（宿主 dispose 时调用）。
 */
export function startWechatImageAutoDownloadOnBoot(
  decryptedDir: string,
): { enabled: boolean; stop: () => void } | null {
  try {
    // 这里只做「读配置 + 拼路径」这种毫秒级判断，**不做任何进程探测**（见
    // BOOT_RESUME_DELAY_MS 的注释：进程发现是同步 PowerShell，会挡 ready/首屏）。
    if (!readEnabled(decryptedDir) || !isSupported() || cleanupUnconfirmed) return null
    const token = { cancelled: false }
    bootResumeToken = token
    const timer = setTimeout(() => {
      if (token.cancelled) return
      if (bootResumeToken === token) bootResumeToken = null
      void startWechatImageAutoDownload(decryptedDir).catch(() => { /* 后台恢复失败只影响该功能 */ })
    }, BOOT_RESUME_DELAY_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return {
      enabled: true,
      stop: () => {
        token.cancelled = true
        if (bootResumeToken === token) bootResumeToken = null
        void stopWechatImageAutoDownload()
      },
    }
  } catch {
    return null
  }
}

/**
 * 单测缝合点：替换依赖 + 重置状态。仅测试使用。
 *
 * 生产代码不得调用 —— 它会把进程内的注入状态清空（不清真实微信进程）。
 */
export const __testing = {
  setDeps(partial: Partial<ImageAutoDownloadDeps>): void {
    deps = { ...defaultDeps, ...partial }
  },
  reset(): void {
    if (timer !== null) {
      try {
        deps.clearTimer(timer)
      } catch { /* 已清理 */ }
    }
    timer = null
    root = ''
    exitHookInstalled = false
    resetRuntime()
    deps = defaultDeps
  },
  tick: () => tick(),
  state: () => ({ root, timer: timer !== null, hookedPid, state, code, message, cleanupUnconfirmed, helperVerified }),
}
