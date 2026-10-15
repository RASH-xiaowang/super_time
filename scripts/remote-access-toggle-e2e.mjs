/**
 * 远程访问（手机）开关真实 Electron 回归：切换开 / 关后设置界面不能黑屏。
 *
 * 使用独立临时 userData，并将测试 HTTP 服务绑定到 loopback，不读取真实配置、不暴露局域网端口。
 * 运行：node scripts/remote-access-toggle-e2e.mjs
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { _electron } from 'playwright'

const ROOT = join(import.meta.dirname, '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}

const userData = mkdtempSync(join(tmpdir(), 'st-remote-toggle-'))
const dataRoot = join(userData, 'wechat-data')
mkdirSync(dataRoot, { recursive: true })
writeFileSync(join(dataRoot, 'config.json'), JSON.stringify({ api_enabled: false, api_port: 5032 }))
writeFileSync(join(dataRoot, 'secrets.json'), JSON.stringify({ api_token: 'e2e-only-token-not-for-use' }))

let app = null
const errors = []
const check = (ok, text) => {
  if (!ok) errors.push(text)
}

try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_REMOTE_ACCESS_LOOPBACK_TEST: '1',
      SUPERTIME_USER_DATA_DIR: userData,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  win.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  win.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  await win.waitForLoadState('domcontentloaded')
  await win.getByRole('button', { name: '设置', exact: true }).first().click()

  const section = win.locator('[data-settings-section="remote"]')
  await section.waitFor({ state: 'visible' })
  await section.scrollIntoViewIfNeeded()
  const toggle = section.locator('input[type="checkbox"]')
  const snapshot = async () => win.evaluate(async () => {
    const panel = document.querySelector('[data-settings-section="remote"]')
    return {
      status: panel?.querySelector('[class*="status"]')?.textContent?.trim() ?? '',
      alerts: [...(panel?.querySelectorAll('[role="alert"]') ?? [])].map((el) => el.textContent?.trim() ?? ''),
      state: await window.electronAPI.remoteAccess.state().catch((error) => ({ error: String(error) })),
    }
  })

  await toggle.check()
  const started = await win.waitForFunction(() => {
    const status = document.querySelector('[data-settings-section="remote"] [class*="status"]')
    return status?.textContent?.includes('正在监听') === true
  }, { timeout: 10000 }).then(() => true).catch(() => false)
  const afterEnable = await snapshot()
  console.log('[E2E] 打开后：', JSON.stringify(afterEnable))
  check(started, `打开后没有开始监听：${JSON.stringify(afterEnable)}`)
  check(await toggle.isChecked(), '打开后开关没有保持打开')
  check((await win.locator('body').innerText()).includes('远程访问（手机）'), '打开后设置内容不可见')

  await toggle.uncheck()
  const stopped = await win.waitForFunction(() => {
    const status = document.querySelector('[data-settings-section="remote"] [class*="status"]')
    return status?.textContent?.includes('未监听') === true
  }, { timeout: 10000 }).then(() => true).catch(() => false)
  const afterDisable = await snapshot()
  console.log('[E2E] 关闭后：', JSON.stringify(afterDisable))
  check(stopped, `关闭后没有停止监听：${JSON.stringify(afterDisable)}`)
  check(!(await toggle.isChecked()), '关闭后开关没有保持关闭')
  check((await win.locator('body').innerText()).includes('远程访问（手机）'), '关闭后设置内容不可见')
  check(errors.length === 0, `渲染层错误：${errors.slice(0, 3).join(' | ')}`)
} catch (error) {
  errors.push(`E2E 流程失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
}

if (errors.length > 0) {
  console.error('远程访问开关 E2E 失败：')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log('远程访问开 / 关后设置页面保持可见，且没有 renderer 错误。')