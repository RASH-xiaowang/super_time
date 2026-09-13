#!/usr/bin/env node
/**
 * EPIPE 回归：让应用的 stdout 接进一根**会立刻关闭读端**的管道，模拟
 * 「从终端拉起应用，然后终端/父进程退出」——此后主进程每次 console.log 都写向断管。
 *
 * 期望（装了 console-safe 之后）：主进程不受影响，9 秒时照常截图并退出。
 * 未装保险时：主进程抛未捕获 EPIPE → Electron 弹「A JavaScript error occurred in the
 * main process」致命框 → 卡在那儿不退，等不到截图。
 *
 * 两个踩过的坑：
 *   · 在 Node 里对父端 readable 调 destroy() **不会**真正关掉 Windows 管道句柄，子进程
 *     拿不到 EPIPE（负对照「删掉保险也照样通过」就是这么来的）。必须用 cmd 的真管道 +
 *     立刻退出的读端。
 *   · 通过 spawn('cmd.exe', ['/c', cmd]) 传参会被转义坏掉（读端跑不起来）。用 shell 形式。
 */
const { spawn, execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const root = path.resolve(__dirname, '..')
const userData = path.join(os.tmpdir(), `st-epipe-ud-${Date.now()}`)
const png = path.join(os.tmpdir(), `st-epipe-${Date.now()}.png`)
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

/** 还活着的 electron 进程数（>0 且没有截图 ⇒ 基本可以断定是致命框卡住了）。 */
function aliveElectrons() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH', { encoding: 'utf8' })
    return (out.match(/electron\.exe/gi) || []).length
  } catch {
    return 0
  }
}

// 读端立刻退出 → 管道关闭 → 之后应用写日志就是 EPIPE
const cmdline = `"${exe}" . | node -e "process.exit(0)"`
const baseline = aliveElectrons()
const cmd = spawn(cmdline, {
  shell: true,
  cwd: root,
  env: {
    ...process.env,
    SUPERTIME_USER_DATA_DIR: userData,
    SUPERTIME_SCREENSHOT: png,
    SUPERTIME_RENDERER_LOG: '1', // 持续写日志，放大 EPIPE 概率
  },
  stdio: 'ignore',
})
cmd.on('exit', () => console.log('[repro] cmd 已退出（读端关闭）；应用成为孤儿进程继续运行'))

setTimeout(() => {
  const okPng = fs.existsSync(png)
  const alive = aliveElectrons() - baseline
  // 两条判据缺一不可：断管后要能跑完截图，并且要能正常退出。
  // 只看截图会漏判 —— 致命框弹出时 9 秒的定时器照样会触发截图，但 app.quit()
  // 被模态框挡住，进程会一直挂在那里（实测残留 5 个 electron 进程）。
  const okExit = alive <= 0
  console.log(`[repro] 截图: ${okPng ? '有' : '无'} · 残留 electron 进程: ${alive}`)
  try { execSync('taskkill /IM electron.exe /F', { stdio: 'ignore' }) } catch { /* ignore */ }
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
  try { fs.rmSync(png, { force: true }) } catch { /* ignore */ }
  if (okPng && okExit) console.log('\n✅ 通过：断管后主进程仍完成了截图并正常退出')
  else if (!okPng && alive > 0) console.log('\n❌ 失败：主进程被 EPIPE 卡住（Electron 致命框还在）')
  else if (!okPng) console.log('\n❌ 失败：主进程因 EPIPE 直接退出')
  else console.log(`\n❌ 失败：截图出来了但进程没退干净（残留 ${alive} 个，多半是致命框挡住了 app.quit）`)
  process.exit(okPng && okExit ? 0 : 1)
}, 18000)
