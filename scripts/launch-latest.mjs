/**
 * 「启动最新版」：每次启动**先确保产物是最新的**，再关闭旧实例、启动应用。
 *
 * ## 为什么需要它
 *
 * 桌面快捷方式原来指向主工作区的 `SuperTime.cmd`，它只 `start electron.exe`：
 * 既不构建（`ui-dist`/`lib` 是 gitignore 的构建产物），也不在性能分支的工作树上。
 * 于是「代码已提交、启动的还是旧界面」。
 *
 * ## 它做的事
 *
 *  1. **报告身份**：当前分支 / 短 SHA / 未提交改动数（这次到底跑的是哪份代码）；
 *  2. **按需构建**：源码（排除测试/产物/依赖）比产物新、产物缺失、或 `--force-build` 时，
 *     跑 `npm run build:all`；否则跳过（正常改完代码再启动会触发构建）；
 *  3. **关掉旧实例**：只关闭命令行里带 `super-time-wechat` 的 dev Electron（不碰其它 Electron 应用），
 *     否则单实例锁会把旧窗口拉到前台 —— 看起来又"不是最新"；
 *  4. **启动**：detached 方式跑已有的唯一入口 `scripts/launch-app.mjs`（它会摘掉
 *     ELECTRON_RUN_AS_NODE 并等窗口进程；这里 detach 是为了不留控制台窗口）。
 *
 * ## 用法
 *
 *   node scripts/launch-latest.mjs                  # 正常启动（快捷方式用这个）
 *   node scripts/launch-latest.mjs --no-launch      # 只报告 + 按需构建，不启动（自检用）
 *   node scripts/launch-latest.mjs --force-build    # 不管 mtime 强制重建
 *   node scripts/launch-latest.mjs --skip-build     # 跳过构建（调试用）
 *   node scripts/launch-latest.mjs --no-kill        # 不关闭已在运行的实例
 *
 * 退出码：0 = 已启动/自检通过；非 0 = 构建失败或环境缺失（cmd 包装会 pause 显示原因）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReasonText, launchBanner, needsBuild, parseLauncherArgs } from './launch-latest-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = parseLauncherArgs(process.argv.slice(2))
const IS_WIN = process.platform === 'win32'

/** 计算「源码最新 mtime」时要跳过的目录名（产物/依赖/文档/测试数据都不该触发构建）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'ui-dist', 'working', 'docs', 'tests', '.worktrees', 'dist'])
/** 源码根（构建输入实际来自这些目录；`src/backend` 里排掉 `wechat-data/lib` 由 SKIP_DIRS 负责）。 */
const SOURCE_ROOTS = ['src/backend', 'src/client/ui-wechat/src', 'src/client/ui-app']
/** 构建产物的 mtime 取最小值（任一缺失/偏旧就重建）。 */
const PRODUCT_FILES = [
  'src/backend/wechat-data/lib/index.js',
  'src/backend/wechat-data/lib/types/index.d.ts',
  'src/client/ui-dist/index.html',
]
/** 构建配置类文件（改了也要重建）。 */
const SOURCE_FILES = ['package.json', 'vite.config.ts', 'vite.config.mjs', 'scripts/build-wechat-bundle.js', 'scripts/build-types.js']

/** 递归取目录内最新 mtime（跳过 SKIP_DIRS、测试文件与点文件）。 */
function newestMtime(dir) {
  let newest = 0
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return newest }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      newest = Math.max(newest, newestMtime(full))
      continue
    }
    if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) continue
    try { newest = Math.max(newest, statSync(full).mtimeMs) } catch { /* 单文件失败不阻塞 */ }
  }
  return newest
}

/** 源码最新 mtime。 */
function sourceNewestMs() {
  let newest = 0
  for (const rel of SOURCE_ROOTS) newest = Math.max(newest, newestMtime(join(ROOT, rel)))
  for (const rel of SOURCE_FILES) {
    try { newest = Math.max(newest, statSync(join(ROOT, rel)).mtimeMs) } catch { /* 可选文件 */ }
  }
  return newest
}

/** 产物最旧 mtime（缺失记 0 ⇒ 触发构建）。 */
function productOldestMs() {
  let oldest = 0
  for (const rel of PRODUCT_FILES) {
    try {
      const ms = statSync(join(ROOT, rel)).mtimeMs
      if (oldest === 0 || ms < oldest) oldest = ms
    } catch { return 0 }
  }
  return oldest
}

/** 读 git 身份（失败返回空值，不阻塞启动）。 */
function gitInfo() {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    return r.status === 0 ? String(r.stdout ?? '').trim() : ''
  }
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    sha: run(['rev-parse', '--short', 'HEAD']),
    dirty: run(['status', '--porcelain']).split('\n').filter((l) => l.trim() !== '').length,
  }
}

/** 列出本项目（命令行含 super-time-wechat）的 Electron 主进程 PID。 */
function listRunningInstances() {
  if (!IS_WIN) return []
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine -like '*super-time-wechat*' -and $_.CommandLine -notlike '*--type=*' } | " +
    'ForEach-Object { Write-Output $_.ProcessId }'
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
}

/** 忙等一小段（启动器是同步脚本，几百毫秒的阻塞可接受，省掉异步时序复杂度）。 */
function busyWait(ms) {
  const until = Date.now() + Math.max(0, ms)
  while (Date.now() < until) { /* 等旧实例释放单实例锁 */ }
}

/**
 * 只关闭本项目（命令行含 super-time-wechat）的 dev Electron 主进程，
 * 并**等到它们真正退出**再返回：单实例锁在旧进程退出前仍被持有，
 * 立刻拉起新实例会直接被挡掉（表现为"点了启动却没窗口"）。
 */
function killRunningInstances() {
  if (!IS_WIN || ARGS.noKill) return 0
  const before = listRunningInstances()
  if (before.length === 0) return 0
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -and $_.CommandLine -like '*super-time-wechat*' -and $_.CommandLine -notlike '*--type=*' } | " +
    'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output $_.ProcessId } catch {} }'
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  // 最多等 6s：旧实例把锁释放出来再继续。
  for (let i = 0; i < 30; i += 1) {
    if (listRunningInstances().length === 0) break
    busyWait(200)
  }
  return before.length
}

try {
  const git = gitInfo()
  const plan = needsBuild({
    sourceNewestMs: sourceNewestMs(),
    productOldestMs: productOldestMs(),
    force: ARGS.forceBuild,
    skip: ARGS.skipBuild,
  })
  if (git.branch && git.branch !== 'main') {
    console.warn('[Super Time] 注意：当前在 ' + git.branch + ' 分支；按仓库约定（docs/CONTRIBUTING.md §11）请切回 main 再开发/启动。')
  }
  console.log(launchBanner({ ...git, build: buildReasonText(plan) }))

  if (plan.build) {
    console.log('[Super Time] 开始构建（build:all）…')
    // Windows 下 .cmd 不能直接 spawn（Node 的 shell 修复后需要 shell），统一走 cmd.exe /c。
    const built = IS_WIN
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run build:all'], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
      : spawnSync('npm', ['run', 'build:all'], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
    if (built.status !== 0) {
      console.error('[Super Time] 构建失败（退出码 ' + String(built.status ?? 'unknown') + '），为避免跑旧代码不启动。')
      process.exit(1)
    }
    const after = productOldestMs()
    if (after === 0) {
      console.error('[Super Time] 构建后仍找不到产物，退出。')
      process.exit(1)
    }
    console.log('[Super Time] 构建完成。')
  }

  if (ARGS.noLaunch) {
    console.log('[Super Time] --no-launch：自检结束，未启动窗口。')
    process.exit(0)
  }

  const killed = killRunningInstances()
  if (killed > 0) console.log('[Super Time] 已关闭旧实例 ' + String(killed) + ' 个，准备启动新版本。')

  const launcher = join(ROOT, 'scripts', 'launch-app.mjs')
  if (!existsSync(launcher)) {
    console.error('[Super Time] 找不到启动入口：' + relative(ROOT, launcher))
    process.exit(1)
  }
  // detached：cmd 窗口立即收起；真正等待窗口进程的是 launch-app 自己（它退出码=Electron 退出码）。
  const child = spawn(process.execPath, [launcher], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()
  // 启动自检：给 Electron 一点时间建窗口；若进程没起来（常见原因：单实例锁/依赖缺失），
  // 明确报错而不是让用户对着"没有窗口"猜。cmd 包装会 pause 展示这条。
  busyWait(1800)
  const running = listRunningInstances()
  if (running.length === 0) {
    console.error('[Super Time] 启动后未检测到窗口进程（可能被单实例锁或环境问题挡住）。')
    process.exit(1)
  }
  console.log('[Super Time] 已启动最新版（' + (git.branch || 'detached') + ' @ ' + (git.sha || '?') + '）。')
  process.exit(0)
} catch (error) {
  console.error('[Super Time] 启动器异常：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
