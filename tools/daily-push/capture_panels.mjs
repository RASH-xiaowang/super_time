/**
 * 每日一推·界面取材：用真实 profile + 真实数据根启动真实 Electron，逐面板截图。
 *
 * 为什么不用文生图：推销图必须对得上产品界面，抽象插画证明不了任何功能。
 *
 * 用法：
 *   node tools/daily-push/capture_panels.mjs --panels=overview,ask,privacytrust
 *   node tools/daily-push/capture_panels.mjs --panels=overview --out=.tmp-e2e/shots
 *
 * 说明：
 * - 可见页签按导航按钮点击；`hidden: true` 的页签走 `#tab` + reload（与 panel-audit 同一口径）。
 * - 窗口固定 1680×1050、深色主题，截图落在 --out（默认 .tmp-e2e/shots）。
 * - 只截图，不点任何写入类按钮；不修改用户数据。
 * - 依赖 `scripts/real-profile.mjs` 把真实配置复制进临时 profile（用完即删）。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { seedRealProfile } from '../../scripts/real-profile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const NAV = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const argOf = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const OUT = resolve(ROOT, argOf('out', '.tmp-e2e/shots'))
const want = argOf('panels', 'overview,ask,privacytrust').split(',').map((s) => s.trim()).filter(Boolean)

/** 从 nav-config.ts 读 tab → { label, hidden }，避免脚本里再维护一份名单。 */
function readNav () {
  const map = new Map()
  const src = readFileSync(NAV, 'utf8')
  for (const ln of src.split(/\r?\n/)) {
    const m = /\{ tab: '([a-z]+)', label: '([^']+)'/.exec(ln)
    if (m) map.set(m[1], { label: m[2], hidden: ln.includes('hidden: true') })
  }
  return map
}

const nav = readNav()
mkdirSync(OUT, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'st-cap-'))
const seeded = seedRealProfile(userData)
console.log('[seed] dataRoot =', seeded.dataRoot)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let app = null
try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: { ...env, SUPERTIME_USER_DATA_DIR: userData, SUPERTIME_SKIP_ONBOARDING: '1', SUPERTIME_TEST_MODE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(90000)
  await win.waitForLoadState('domcontentloaded')
  await sleep(3000)

  await win.evaluate(() => localStorage.setItem('super-time-wechat-theme', 'dark'))
  await win.evaluate(() => { location.hash = '#overview' })
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await sleep(4000)

  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) { w.setSize(1680, 1050); w.center() }
  })
  await sleep(2000)

  for (const tab of want) {
    const meta = nav.get(tab)
    const label = meta?.label ?? tab
    try {
      if (meta?.hidden) {
        await win.evaluate((t) => { location.hash = '#' + t }, tab)
        await win.reload({ waitUntil: 'domcontentloaded' })
        await sleep(12000)
      } else {
        await win.getByRole('button', { name: label, exact: true }).first().click({ timeout: 20000 })
        await sleep(9000)
      }
      const file = join(OUT, `${tab}.png`)
      await win.screenshot({ path: file })
      const body = (await win.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 70)
      console.log(`[ok] ${tab} (${label}) -> ${file} | ${body}`)
    } catch (e) {
      console.log(`[fail] ${tab} (${label}): ${String(e.message || e).split('\n')[0].slice(0, 110)}`)
    }
  }
} finally {
  try { await app?.close() } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
}
console.log('done ->', OUT)
