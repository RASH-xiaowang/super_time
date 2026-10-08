#!/usr/bin/env node
/**
 * 真机验收：渲染层的 `console.warn/error` **真的进了诊断日志**。
 *
 * ## 为什么必须真机
 *
 * `diag-log.spec.ts`（23 条）只证明了「给定一个假的 `contents`，转发函数会把 warn/error
 * 写进日志器」，`renderer-console-capture-guard.spec.ts`（7 条）证明了「`main.js` 真的调用了它」。
 * 两者都停在**接线正确**为止，没有证明「Electron 真的会派发 `console-message`、
 * 渲染层的 `console.warn` 真的会经过它、日志真的落在 `STATE_DIR/logs/app.log` 里」。
 *
 * 这不是多余的谨慎：修复前 `app.log` 里 `moments-media` / `renderer` / `取图失败`
 * 各 **0 行**，排查朋友圈问题时因此连续判错三次（以为是跑旧代码、以为是键为空、
 * 以为是尾块导致渲染失败）。那条链的每一段都只有真机能证。
 *
 * ## 怎么跑
 *
 * 起一份**独立 userData** 的真 Electron（与正在跑的正式实例互不影响 ——
 * 单实例锁文件在 userData 里），在渲染层里真的打两条 warn/error，然后读那份 userData 的
 * 日志目录断言它们在里面。
 *
 * 运行：`node scripts/renderer-console-capture-e2e.mjs`
 * 退出码：`0` = 全部成立；`1` = 有断言不成立；`2` = 前置缺失（没有 playwright / electron）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

let _electron
try {
  ;({ _electron } = await import('playwright'))
} catch (e) {
  console.error('[前置] 缺少 playwright：', e.message)
  process.exit(2)
}
if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label })
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail)}`)
}

const userData = mkdtempSync(join(tmpdir(), 'renderer-console-e2e-'))
let app = null

try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: userData,
    },
  })

  const page = await app.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')

  // 界面上「正在取原图…」那条路径就是走 console.warn 的；这里用同样的形态打两条，
  // 一条 warn 一条 error —— 验证的是**级别映射**而不只是「有没有落盘」。
  await page.evaluate(() => {
    console.warn('[renderer-console-e2e] 这是渲染层 warn')
    console.error('[renderer-console-e2e] 这是渲染层 error')
    console.info('[renderer-console-e2e] 这是渲染层 info')
  })

  // 日志是 appendFileSync 同步落盘的，但仍给一点余量 —— 首次调用还要 mkdirSync
  let text = ''
  for (let i = 0; i < 20; i += 1) {
    const dir = join(userData, 'wechat', 'logs')
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.log')) } catch { files = [] }
    text = files.map((f) => {
      try { return readFileSync(join(dir, f), 'utf8') } catch { return '' }
    }).join('\n')
    if (text.includes('这是渲染层 error')) break
    await sleep(250)
  }

  check(text.includes('这是渲染层 warn'), '渲染层 console.warn 进了 app.log', text.slice(-400))
  check(text.includes('这是渲染层 error'), '渲染层 console.error 进了 app.log', text.slice(-400))
  check(text.includes('[renderer]'), '带 [renderer] 级别标签（可与主进程/后端区分）', text.slice(-400))
  check(text.includes('[warn]') && text.includes('[error]'), 'Electron 数字级别映射成级别名', text.slice(-400))
  check(/\[renderer][^\n]*\[warn]/.test(text), 'warn 行的级别顺序正确', text.slice(-400))
  check(!text.includes('这是渲染层 info'), '默认档位**不收** info（否则轮转会被冲掉）', text.slice(-400))
  check(/\[[^\]\n]*:[0-9]+\]/.test(text), '带来源文件与行号（渲染层没有栈，来源是唯一线索）', text.slice(-400))
} catch (e) {
  check(false, '跑真 Electron 时抛异常', e && e.message ? e.message : e)
} finally {
  try { if (app) await app.close() } catch { /* 关不掉也要继续收尾 */ }
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* 临时目录留着也无妨 */ }
}

const bad = results.filter((r) => !r.ok)
console.log(bad.length === 0 ? '\n全部成立。' : `\n有 ${bad.length} 条不成立。`)
process.exit(bad.length === 0 ? 0 : 1)