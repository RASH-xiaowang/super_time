/**
 * 「其他表情包」完整返回的真机验收。
 *
 * 用真实 profile + 真实数据根打开表情面板，断言：
 *   ① 顶部「其他 N」与下拉「其他表情包 (N)」数量一致；
 *   ② N 大于 500 时（本机真实数据约 1900），列表仍能继续向下滚动加载到 500 之后；
 *   ③ 渲染层无 console error / pageerror。
 *
 * 运行：node scripts/emoticons-others-e2e.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 前置缺失。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { seedRealProfile } from './real-profile.mjs'

const ROOT = join(import.meta.dirname, '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e', 'emoticons-others')
const checks = []

const check = (ok, label, detail = '') => {
  checks.push({ ok: Boolean(ok), label, detail: String(detail) })
}

if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'st-emoticons-'))
const seeded = seedRealProfile(userData)
console.log(`真实 profile：${seeded.source}（带入 ${seeded.copied.join('、') || '（无额外配置）'}）`)
console.log(`真实数据根：${seeded.dataRoot}`)

let app = null
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...env,
      SUPERTIME_USER_DATA_DIR: userData,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(90000)
  const errors = []
  win.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) {
      errors.push(message.text().slice(0, 240))
    }
  })
  win.on('pageerror', (error) => { errors.push('pageerror: ' + String(error.message).slice(0, 240)) })

  // `emoticons` 是隐藏的深链页签，侧栏入口是「收藏与表情」，面板内再切到「表情」。
  const favoritesNav = win.getByRole('button', { name: '收藏与表情', exact: true }).first()
  await favoritesNav.waitFor({ state: 'visible' })
  await favoritesNav.click()
  const emoTab = win.getByRole('radio', { name: '表情', exact: true }).first()
  await emoTab.waitFor({ state: 'visible' })
  await emoTab.click()
  const search = win.getByLabel('搜索表情')
  await search.waitFor({ state: 'visible' })

  // 等后端首次同步完成：顶部的「个人 N · 其他 N · 表情包 N」出现有效数字。
  const stats = win.locator('[class*="textCaption"]').filter({ hasText: '其他' }).first()
  await stats.waitFor({ state: 'visible' })
  let caption = ''
  for (let i = 0; i < 90; i += 1) {
    caption = await stats.innerText()
    const parsed = /个人\s+(\d+)\s+·\s+其他\s+(\d+)/.exec(caption)
    if (parsed && Number(parsed[2]) > 0) break
    await win.waitForTimeout(1000)
  }

  const totals = /个人\s+(\d+)\s+·\s+其他\s+(\d+)\s+·\s+表情包\s+(\d+)/.exec(caption)
  check(totals !== null, '顶部统计行可解析', caption)
  const othersTotal = totals ? Number(totals[2]) : 0
  check(othersTotal > 500, '本机其他表情数超过 500（能复现原问题）', String(othersTotal))

  const select = win.getByLabel('表情分类')
  await select.click()
  const option = win.getByRole('option').filter({ hasText: '其他表情包' }).first()
  await option.waitFor({ state: 'visible' })
  const optionText = await option.innerText()
  const optionCount = Number(/\((\d+)\)/.exec(optionText)?.[1] ?? '-1')
  check(optionCount === othersTotal, '下拉条目数量与顶部总数一致',
    `顶部 ${othersTotal} / 下拉 ${optionCount}`)
  await option.click()
  await win.waitForTimeout(800)

  // 渐进列表每次 150 个。用格子上的 data-emo-md5 计数，避免把网格里的哨兵算进条目。
  const cell = win.locator('[data-emo-md5]')
  const cellsBefore = await cell.count()
  const grid = cell.first().locator('..')
  let rendered = cellsBefore
  for (let i = 0; i < 30 && rendered < othersTotal; i += 1) {
    await grid.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await win.waitForTimeout(350)
    const next = await cell.count()
    if (next === rendered) await win.waitForTimeout(650)
    rendered = await cell.count()
  }
  check(rendered > 500, '列表可越过第 500 条继续渲染', `进入前 ${cellsBefore} · 滚动后 ${rendered}`)
  check(rendered === othersTotal, '滚动后渲染条数与顶部总数一致',
    `顶部 ${othersTotal} / 已渲染 ${rendered}`)
  await win.screenshot({ path: join(OUT, '01-others-full.png') })

  check(errors.length === 0, '渲染层没有 console error / pageerror', errors.slice(0, 3).join(' | '))
} catch (error) {
  check(false, '真机流程未能跑完', (error && error.message ? error.message : String(error)).split('\n')[0])
} finally {
  if (app) {
    try { await app.close() } catch { /* ignore */ }
  }
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
}

let failed = 0
for (const item of checks) {
  if (!item.ok) failed += 1
  console.log(`${item.ok ? '  PASS' : '  FAIL'}  ${item.label}${item.detail ? '  → ' + item.detail : ''}`)
}
console.log(failed === 0
  ? `\n结论：其他表情包完整返回。截图：${OUT}`
  : `\n结论：${failed} 项不成立。`)
process.exit(failed === 0 ? 0 : 1)
