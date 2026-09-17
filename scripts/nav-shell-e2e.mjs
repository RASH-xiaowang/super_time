/**
 * 导航栏改版的**真实浏览器**验证（Electron 自带 Chromium + Playwright 驱动，零下载）。
 *
 * 为什么写这个：本轮把顶栏的品牌 / 全局搜索 / 主题 / 数据状态全部迁进了左侧导航栏。
 * 这类改动的失败模式（收起态露出半截文字、Portal 定位算错、导航底部被浮层压住）
 * 在源码里看不出来，只有真实布局引擎能回答。本脚本做两件事：
 *   ① 断言语义（收起隐藏 / 展开显示 / Ctrl+K 联动 / 下拉不被裁 / 无横向溢出）；
 *   ② 在 `.tmp-e2e/` 落下 4 张截图，供人眼复核视觉。
 *
 * 运行：node scripts/nav-shell-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e')

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
mkdirSync(OUT, { recursive: true })

const results = []
const check = (ok, label, detail = '') => results.push({ ok: !!ok, label, detail: String(detail) })
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const report = []
const note = (k, v) => report.push(`  ${k.padEnd(26)} ${v}`)

let app = null
const probeUserData = mkdtempSync(join(tmpdir(), 'super-time-nav-'))
try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: probeUserData,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const consoleErrors = []
  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
  win.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 200)))
  await win.waitForLoadState('domcontentloaded')

  // 主界面挂载锚点：左侧导航里的第一项
  const anchor = win.getByRole('button', { name: '数据总览', exact: true })
  await anchor.waitFor({ state: 'visible' })
  const sidebar = anchor.locator('xpath=ancestor::aside[1]')

  const vp = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  note('视口', `${vp.w} × ${vp.h}`)

  const box = async (loc) => { try { return await loc.boundingBox() } catch { return null } }
  const sideW = async () => Math.round((await box(sidebar))?.width ?? -1)
  const vis = async (loc) => { try { return await loc.isVisible() } catch { return false } }
  const input = sidebar.locator('input[aria-label^="全局搜索"]')
  const brandName = sidebar.getByText('Super Time', { exact: true })
  const themeBtn = sidebar.locator('[data-theme-toggle]')
  const apiTag = sidebar.locator('span[data-status]')
  // 文案是 apiTag 里最后一个 span（前一个是状态圆点）—— 不取 last() 会同时命中两个而触发 strict 报错
  const apiText = sidebar.locator('span[data-status] > span').last()
  const dropdown = win.locator('[role="listbox"][aria-label="搜索结果"]')

  // ── ① 默认收起态 ─────────────────────────────────────────────
  await win.screenshot({ path: join(OUT, '01-collapsed.png') })
  const wCollapsed = await sideW()
  note('收起态导航宽', `${wCollapsed}px`)
  check(wCollapsed >= 54 && wCollapsed <= 62, '默认是 58px 收起轨', `${wCollapsed}px`)
  check(!(await vis(input)), '收起态：搜索框整块不显示（不是露半截）')
  check(!(await vis(brandName)), '收起态：品牌文字不显示，只留徽标')
  check(!(await vis(apiText)), '收起态：状态文案不显示，只留状态点')
  check(await vis(themeBtn), '收起态：主题按钮仍可见（图标按钮）')
  check(await vis(apiTag), '收起态：状态标签容器仍在（只剩圆点）')

  // 收起态徽标是否在 42px 窄轨里居中
  const logo = sidebar.locator('span[title], div[title]').first()
  const logoBox = (await box(logo)) ?? (await box(sidebar.locator('> div').first()))
  const sbBox = await box(sidebar)
  if (logoBox && sbBox) {
    const leftGap = logoBox.x - sbBox.x
    const rightGap = (sbBox.x + sbBox.width) - (logoBox.x + logoBox.width)
    note('徽标左右留白', `${Math.round(leftGap)} / ${Math.round(rightGap)}`)
    check(Math.abs(leftGap - rightGap) <= 2.5, '收起态徽标在窄轨里居中', `${Math.round(leftGap)} vs ${Math.round(rightGap)}`)
  }

  // 收起态底部两个控件应当等宽对齐（窄轨里上下叠放，宽度不一致会看起来歪）
  const themeCollapsed = await box(themeBtn)
  const tagCollapsed = await box(apiTag)
  if (themeCollapsed && tagCollapsed) {
    note('收起态底部宽度', `主题 ${Math.round(themeCollapsed.width)} / 状态 ${Math.round(tagCollapsed.width)}`)
    check(Math.abs(themeCollapsed.width - tagCollapsed.width) <= 1, '收起态：主题按钮与状态标签等宽对齐',
      `${Math.round(themeCollapsed.width)} vs ${Math.round(tagCollapsed.width)}`)
  }

  // ── ② 展开态 ────────────────────────────────────────────────
  await win.getByRole('button', { name: '展开导航', exact: true }).click()
  await sleep(500) // 宽度过渡 200ms，留余量
  await win.screenshot({ path: join(OUT, '02-expanded.png') })
  await sidebar.screenshot({ path: join(OUT, '02b-sidebar-expanded.png') })
  const wOpen = await sideW()
  note('展开态导航宽', `${wOpen}px`)
  check(wOpen >= 170 && wOpen <= 182, '展开态是 176px', `${wOpen}px`)
  check(await vis(input), '展开态：搜索框显示')
  check(await vis(brandName), '展开态：品牌文字显示')
  check(await vis(apiText), '展开态：状态文案显示')
  const apiTextValue = await apiText.textContent().catch(() => null)
  note('状态文案', JSON.stringify(apiTextValue))
  check(['数据就绪', '数据不可用', '检测中…'].includes((apiTextValue ?? '').trim()), '状态文案是预期的三选一', String(apiTextValue))

  // 底部固定区必须落在导航栏矩形之内（写错层的经典表现就是在外面）
  const sbOpen = await box(sidebar)
  const themeBox = await box(themeBtn)
  if (sbOpen && themeBox) {
    const insideX = themeBox.x >= sbOpen.x - 1 && themeBox.x + themeBox.width <= sbOpen.x + sbOpen.width + 1
    const insideY = themeBox.y + themeBox.height <= sbOpen.y + sbOpen.height + 1
    note('主题按钮在导航内', `x∈[${Math.round(sbOpen.x)},${Math.round(sbOpen.x + sbOpen.width)}] y底=${Math.round(themeBox.y + themeBox.height)}/${Math.round(sbOpen.y + sbOpen.height)}`)
    check(insideX && insideY, '主题/状态真的落在导航栏矩形内（没落到 aside 外面）')
  }
  // 主题与状态在展开态是否同行（省高度）：两者 y 中心接近
  const tagBox = await box(apiTag)
  if (themeBox && tagBox) {
    note('主题/状态中心 y', `${Math.round(themeBox.y + themeBox.height / 2)} / ${Math.round(tagBox.y + tagBox.height / 2)}`)
    check(Math.abs((themeBox.y + themeBox.height / 2) - (tagBox.y + tagBox.height / 2)) <= 6, '展开态两者同行（不是白占一行的纵向堆叠）')
  }

  // 横向溢出（露半截/被切断的真正判据）
  const overflow = await sidebar.evaluate((el) => {
    const bad = []
    for (const c of el.querySelectorAll('*')) {
      if (c.scrollWidth > c.clientWidth + 1 && c.clientWidth > 0) {
        bad.push(`${c.className || c.tagName}:${c.clientWidth}<${c.scrollWidth}`)
      }
    }
    return bad.slice(0, 5)
  })
  note('横向溢出元素', overflow.length ? overflow.join(' | ') : '无')
  check(overflow.length === 0, '展开态导航内无横向溢出（没有内容被切断）')

  const inputBox = await box(input)
  note('搜索输入区宽', inputBox ? `${Math.round(inputBox.width)}px` : 'n/a')
  check((inputBox?.width ?? 0) >= 80, '搜索输入区仍有可用宽度（≥80px）', `${Math.round(inputBox?.width ?? 0)}px`)

  // ── ③ 搜索下拉（Portal 定位）─────────────────────────────────
  await input.click()
  await input.fill('的')
  await sleep(700)
  await win.screenshot({ path: join(OUT, '03-search-open.png') })
  const ddVisible = await vis(dropdown)
  check(ddVisible, '输入后结果面板出现')
  if (ddVisible) {
    await dropdown.screenshot({ path: join(OUT, '03b-dropdown.png') }).catch(() => {})
    const dd = await box(dropdown)
    const sbNow = await box(sidebar)
    if (dd && sbNow) {
      note('下拉框', `x=${Math.round(dd.x)} y=${Math.round(dd.y)} ${Math.round(dd.width)}×${Math.round(dd.height)}`)
      check(dd.x >= sbNow.x + sbNow.width - 1, '下拉在导航栏右侧展开（没压在导航栏上）', `${Math.round(dd.x)} ≥ ${Math.round(sbNow.x + sbNow.width)}`)
      check(dd.x + dd.width <= vp.w - 4, '下拉不越过视口右缘', `${Math.round(dd.x + dd.width)} ≤ ${vp.w - 4}`)
      check(dd.y >= -1 && dd.y + dd.height <= vp.h + 1, '下拉纵向完整落在视口内（没被 overflow 裁掉）', `${Math.round(dd.y)}…${Math.round(dd.y + dd.height)} / ${vp.h}`)
      check(dd.width >= 240, '下拉宽度 ≥ 240px（没被 176px 导航宽限制）', `${Math.round(dd.width)}px`)
    }
    const inAside = await sidebar.evaluate((el) => {
      const dd = document.querySelector('[role="listbox"][aria-label="搜索结果"]')
      return !!(dd && el.contains(dd))
    })
    check(!inAside, '下拉不在导航栏 DOM 内（走的是 Portal 到 body）')
    const ddText = (await dropdown.textContent().catch(() => '')) ?? ''
    note('下拉内容', JSON.stringify(ddText.slice(0, 60)))
  }

  // ── ④ 面板开着时，界面其余部分必须仍可点（本轮真实浏览器暴露的缺陷）──
  // 旧实现用了 `position: fixed; inset: 0` 的全屏遮罩：这一下点击会被遮罩吃掉，
  // 只关掉面板、导航纹丝不动，用户必须点第二次。现在改为 document 上的 mousedown 外部关闭。
  const collapseBtn = win.getByRole('button', { name: '收起导航', exact: true })
  await collapseBtn.click({ timeout: 5000 })
  await sleep(500)
  check(!(await vis(dropdown)), '收起导航：结果面板一并关闭（避免拿全零矩形定位）')
  check((await sideW()) <= 62, '一次点击就同时关面板并收起导航（没有透明的全屏遮罩吃点击）', `${await sideW()}px`)
  check(!(await vis(input)), '收起导航：搜索框重新隐藏')

  // ── ⑤ Ctrl+K 联动 ──────────────────────────────────────────
  await win.keyboard.press('Control+k')
  await sleep(600)
  const wAfterK = await sideW()
  const focused = await win.evaluate(() => {
    const el = document.activeElement
    return !!el && el.tagName === 'INPUT' && (el.getAttribute('aria-label') ?? '').startsWith('全局搜索')
  })
  check(wAfterK >= 170, 'Ctrl+K 会自动展开导航（收起态搜索框是 display:none，直接聚焦会失败）', `${wAfterK}px`)
  check(focused, 'Ctrl+K 之后焦点真的落在搜索输入框上')
  await win.screenshot({ path: join(OUT, '04-ctrl-k.png') })
  await win.keyboard.press('Escape')

  // ── ⑥ 主题切换 ─────────────────────────────────────────────
  const themeBefore = await win.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className)
  await themeBtn.click()
  await sleep(400)
  const themeAfter = await win.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className)
  note('主题', `${themeBefore} → ${themeAfter}`)
  check(themeBefore !== themeAfter, '主题按钮真的切换了主题（迁到导航栏后接线仍通）')
  await win.screenshot({ path: join(OUT, '05-theme-toggled.png') })
  const apiTextInLight = await apiText.textContent().catch(() => null)
  check(await vis(apiText), '切换主题后导航栏底部控件仍可见', String(apiTextInLight))
  await themeBtn.click() // 切回去
  await sleep(300)

  check(consoleErrors.length === 0, '渲染层无 console error / pageerror', consoleErrors.slice(0, 3).join(' | '))

  // ── ⑦ 品牌口径（此处是**运行期**证据，静态文本由 brand-consistency.spec.ts 守）──
  // OS 标题栏取的是 BrowserWindow.getTitle()，而它会被页面 <title> 覆盖 —— 两处都得看，
  // 只看一处会漏掉「窗口标题还写着旧名」这种第一眼就能看见的问题。
  const osTitles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.getTitle()))
  const bodyText = await win.evaluate(() => document.body.innerText)
  // 旧品牌名拼出来而不是写字面量：brand-consistency.spec.ts 会全仓库扫描这个字符串，
  // 本脚本是检查者，不该自己被自己的规则命中。
  const LEGACY = '微信' + '+'
  note('OS 窗口标题', JSON.stringify(osTitles))
  check(osTitles.length > 0 && osTitles.every(t => t.includes('Super Time') && !t.includes(LEGACY)),
    'OS 窗口标题是 Super Time（不含旧品牌名）', JSON.stringify(osTitles))
  check(!bodyText.includes(LEGACY), '当前界面正文里没有旧品牌名')
} catch (e) {
  check(false, '端到端流程未能跑完', (e && e.message ? e.message : String(e)).split('\n')[0])
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
  try { rmSync(probeUserData, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log('\n── 实测几何 ──────────────────────────────')
for (const r of report) console.log(r)
console.log('\n── 断言 ──────────────────────────────────')
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.label}${r.detail ? '  → ' + r.detail : ''}`)
}
console.log(`\n截图目录：${OUT}`)
console.log(failed === 0 ? `结论：${results.length} 项全部成立。` : `结论：${failed}/${results.length} 项不成立。`)
process.exit(failed === 0 ? 0 : 1)
