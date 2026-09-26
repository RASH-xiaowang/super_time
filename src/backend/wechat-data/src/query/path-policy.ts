/**
 * 路径政策（CODE-AUDIT-2026-09-26 P2-6）：哪些路径允许「交给系统打开」，哪些允许写。
 *
 * ## 为什么要限
 *
 * `@Remote('openPath')` 的实现在 vendored 依赖里是
 * `powershell.exe … Start-Process Invoke-Item -LiteralPath '<path>'`（转义是对的，
 * 注入不成立），**但对 `.exe` 就是直接执行** —— 于是「渲染层被控」可以从
 * 「读到你自己的聊天数据」升级到「以当前用户权限跑任意程序」。
 * 导出那几条则相反：`exportDir = dir.trim()` 之后直接 `mkdirSync` + 写文件，
 * 拿到一个绝对路径就能往**任何位置**落盘（启动目录、`%APPDATA%\Microsoft\Windows\Start Menu`…）。
 *
 * ## 政策
 *
 * **打开**（{@link openDenialReason}）：只允许落在
 *   ① 数据根（解密快照、导出目录、缓存都在它下面，应用自己产出的东西全在这里）；或
 *   ② 已被**授予**的目录（{@link grantRoot}：应用真的往那里写过东西之后记下来，
 *      对应「用户用原生对话框选了一个数据根之外的目录」这条合法路径）。
 * 两条之外一律拒；另外**可执行/脚本扩展名一律拒**（即使落在根内 ——
 * 应用没有任何功能需要「打开一个 exe」）。
 *
 * **写**（{@link writeDenialReason}）：拒掉系统关键目录与可执行/脚本扩展名。
 * 这里刻意用**黑名单**而不是白名单：导出目录本来就是「用户挑的」，
 * 白名单会在唯一合法的用例上把功能打死；而真正需要挡的是「落到系统位置」与
 * 「落一个能执行的东西」。要升级成真正的令牌制，得让主进程把对话框结果换成
 * 一次性凭据传进来（改动跨协议层，见审查 §七 第二批次）。
 */
import { basename, extname, resolve, sep } from 'node:path'

/** Windows 上会被「双击即执行」的扩展名（`Invoke-Item` 对它们走的是执行路径）。 */
export const EXECUTABLE_EXTS: ReadonlySet<string> = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif', '.hta', '.cpl', '.lnk', '.jar', '.appx',
])

/** 不许写进去的系统位置（大小写不敏感，按解析后的绝对路径前缀比）。 */
const FORBIDDEN_WRITE_PREFIXES = [
  '\\windows\\',
  '\\program files',
  '\\programdata\\microsoft\\windows\\start menu',
  '\\appdata\\microsoft\\windows\\start menu',
  '\\appdata\\roaming\\microsoft\\internet explorer\\quick launch\\',
  '\\system32\\',
  '\\syswow64\\',
]

/**
 * 被授予过的目录（应用确实往里写过产出）。
 * 上限是刻意的：导出/备份目录由用户挑，长跑不能无上限地攒。
 */
const GRANT_CAP = 32
const grantedRoots: string[] = []

/** 规范化成「比较前缀」用的形态：绝对路径、去尾分隔符、小写（Windows 大小写不敏感）。 */
function canon(p: string): string {
  const s = resolve(String(p ?? '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 记录一个目录为「应用产出过东西、随后可被打开」。幂等，保序（新的放最后）。 */
export function grantRoot(dir: string): void {
  const key = canon(dir)
  if (key === '') return
  const at = grantedRoots.indexOf(key)
  if (at >= 0) grantedRoots.splice(at, 1)
  grantedRoots.push(key)
  while (grantedRoots.length > GRANT_CAP) grantedRoots.shift()
}

/** 当前被授予的目录列表（只读快照，给测试与诊断用）。 */
export function grantedRootList(): string[] {
  return [...grantedRoots]
}

/** `child` 是否等于 `root` 或在其之下（按路径段比，不比字符串前缀）。 */
export function isInsideRoot(child: string, root: string): boolean {
  const c = canon(child)
  const r = canon(root)
  if (r === '' || c === '') return false
  if (c === r) return true
  return c.startsWith(r + sep) || c.startsWith(r + '/')
}

/**
 * 「交给系统打开」的拒绝理由（返回 null = 允许）。
 * @param target - 要打开的路径（文件或目录）。
 * @param dataRoot - 数据根（`dirname(decryptedDir)`）—— 应用自己的产出都在这里。
 * @returns 给用户看的中文理由，或 null。
 */
export function openDenialReason(target: string, dataRoot: string): string | null {
  const raw = String(target ?? '').trim()
  if (raw === '') return '没有给出要打开的路径'
  const abs = resolve(raw)
  const ext = extname(basename(abs)).toLowerCase()
  if (ext !== '' && EXECUTABLE_EXTS.has(ext)) {
    return `出于安全不打开可执行文件（${ext}）：请只在资源管理器里定位数据文件`
  }
  if (isInsideRoot(abs, dataRoot)) return null
  for (const g of grantedRoots) {
    if (isInsideRoot(abs, g)) return null
  }
  return '只能打开应用自己数据目录内的文件（其它位置请先在导出对话框里选择该目录）'
}

/**
 * 「往这里写」的拒绝理由（返回 null = 允许）。
 * @param target - 目标**文件**路径。
 * @param dataRoot - 数据根（用于日志与文案，不做白名单，见文件头）。
 * @returns 理由或 null。
 */
export function writeDenialReason(target: string, dataRoot: string): string | null {
  void dataRoot
  const raw = String(target ?? '').trim()
  if (raw === '') return '没有给出保存路径'
  const abs = resolve(raw)
  const ext = extname(basename(abs)).toLowerCase()
  if (ext !== '' && EXECUTABLE_EXTS.has(ext)) return `不能把导出文件写成可执行格式（${ext}）`
  const probe = (process.platform === 'win32' ? abs.toLowerCase() : abs).replace(/\\/g, '/')
  for (const bad of FORBIDDEN_WRITE_PREFIXES) {
    if (probe.includes(bad.replace(/\\/g, '/'))) return `不能写入系统关键目录：${basename(abs)}`
  }
  return null
}
