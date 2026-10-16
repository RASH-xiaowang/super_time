/**
 * 启动 Electron 的**唯一入口** —— `npm start` / `npm run dev` / `npm run dev:only` 都走它。
 *
 * ## 为什么不能直接写 `electron .`
 *
 * 环境里只要带着 `ELECTRON_RUN_AS_NODE=1`（本机 harness 与部分 CI 会注入），Electron 就会
 * **退化成纯 Node**：`require('electron')` 返回的是**可执行文件路径字符串**，
 * 于是 `main.js` 里解构出来的 `app` 是 `undefined`，崩在第 27 行的 `app.isPackaged`：
 *
 * ```
 * TypeError: Cannot read properties of undefined (reading 'isPackaged')
 *     at Object.<anonymous> (main.js:27:9)
 * ```
 *
 * 报错与真因（环境变量）**完全不相干**，实测排查成本很高。
 *
 * ## 这不是新问题，只是漏了一条路
 *
 * 仓库里三个真机脚本早就各自摘掉过这个变量（`scripts/panel-audit.mjs:141`、
 * `scripts/theme-live-audit.mjs:319`、`scripts/mutation-check.mjs:94`），
 * `SuperTime.cmd:4` 也摘 —— **只有 npm scripts 这条路漏了**。这里把它补成一处：
 * 启动前统一摘掉，并**留一行日志**说明摘过（免得下次有人以为变量没生效）。
 *
 * ## `--dry-run`：这条路唯一的可测面
 *
 * 打印"解析到的 electron 路径 + 有没有摘掉那个变量 + 应用目录"，**不启动任何窗口**。
 * `src/backend/tests/electron-launch.spec.ts` 用它做判据（真实行为，不是文本断言）。
 *
 * 用法：
 *   node scripts/launch-app.mjs                 # 启动应用（等价于 `electron .`）
 *   node scripts/launch-app.mjs --dry-run       # 只打印解析结果（JSON）
 *   node scripts/launch-app.mjs --inspect=9229  # 其余参数原样透传给 Electron
 *
 * 退出码：0 = 子进程正常退出；非 0 = 子进程的退出码；2 = 找不到 Electron 二进制。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')
/** 透传给 Electron 的参数（`--dry-run` 只是本脚本自己的开关，不往下传）。 */
const PASSTHROUGH = process.argv.slice(2).filter((a) => a !== '--dry-run')

/**
 * 解析 Electron 可执行文件路径。
 *
 * 在**纯 Node** 下 `require('electron')` 按官方约定返回二进制路径字符串；
 * 万一在 Electron 运行时里被调用（返回的是 API 对象），退回仓库内的固定路径。
 * @returns 可执行文件绝对路径。
 */
function resolveElectron () {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('electron')
    if (typeof mod === 'string' && mod.length > 0) return mod
  } catch { /* 没装依赖时走下面的兜底 */ }
  return join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
}

const electron = resolveElectron()
const exists = existsSync(electron)
const hadRunAsNode = process.env.ELECTRON_RUN_AS_NODE !== undefined

if (DRY) {
  console.log(JSON.stringify({
    electron,
    exists,
    appDir: ROOT,
    // 这两个字段是判据：`--dry-run` 必须**如实报告**环境里有没有那个变量、以及会不会摘掉。
    hadRunAsNode,
    stripped: hadRunAsNode,
  }, null, 2))
  process.exit(exists ? 0 : 2)
}

if (!exists) {
  console.error('[launch] 找不到 Electron：' + electron)
  console.error('        先跑 `npm ci`（依赖里含 electron）。')
  process.exit(2)
}

/** 子进程环境：**必须摘掉** `ELECTRON_RUN_AS_NODE`，否则 Electron 退化成纯 node。 */
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
if (hadRunAsNode) {
  console.log('[launch] 检测到 ELECTRON_RUN_AS_NODE=1 —— 已为 Electron 子进程摘掉' +
    '（不摘会让它退化成纯 node，并崩在 main.js 的 app.isPackaged）。')
}

const child = spawn(electron, [ROOT, ...PASSTHROUGH], { stdio: 'inherit', env: childEnv })

// 转发终止信号：终端里 Ctrl+C 要能关掉窗口进程，而不是只杀掉这个转发器。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig) } catch { /* 子进程可能已退出 */ } })
}
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 0 : (code ?? 0))
})
