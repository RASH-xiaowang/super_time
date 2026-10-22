/**
 * 检索范围浮层的真机验收。
 *
 * 复用真实 profile（同一份数据根与模型配置），只做界面动作：
 *   ① 顶部「全部会话 / 全部时间」控件确实不在；
 *   ② 在输入框输入 `@` 后，浮层从输入框**上方**展开，会话行带真实头像与类型；
 *   ③ 选中会话后输入框只移除触发用的 `@`，其它正文原样保留；
 *   ④ Esc 关闭并回到输入框，时间页能清除范围。
 *
 * 运行：node scripts/ask-scope-picker-e2e.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 前置缺失。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { seedRealProfile } from './real-profile.mjs'

const ROOT = join(import.meta.dirname, '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e', 'ask-scope-picker')
const checks = []

const check = (ok, label, detail = '') => {
  checks.push({ ok: Boolean(ok), label, detail: String(detail) })
}

if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'st-scope-'))
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
  win.setDefaultTimeout(45000)
  const errors = []
  win.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) {
      errors.push(message.text().slice(0, 240))
    }
  })
  win.on('pageerror', (error) => { errors.push('pageerror: ' + String(error.message).slice(0, 240)) })

  await win.getByRole('button', { name: '微信问答', exact: true }).first().click()
  const input = win.getByLabel('微信问答问题')
  await input.waitFor({ state: 'visible' })
  await win.waitForTimeout(1800)

  // ① 顶部范围条已移除；输入框占位文案给出 @ 入口。
  const topScopeCount = await win.evaluate(() => {
    const main = document.querySelector('main')
    if (!main) return -1
    const text = (main.textContent || '').replace(/\s+/g, ' ')
    return (text.match(/全部会话/g) || []).length + (text.match(/全部时间/g) || []).length
  })
  check(topScopeCount === 0, '顶部不再渲染「全部会话 / 全部时间」控件', `正文出现次数 ${topScopeCount}`)
  check((await input.getAttribute('placeholder'))?.includes('输入 @') === true,
    '输入框提示了 @ 入口', String(await input.getAttribute('placeholder')))

  // ② 在已输入正文的空白后输入 @，浮层向上展开。
  await input.click()
  await input.fill('帮我查一下 ')
  await win.keyboard.type('@')
  const picker = win.locator('[data-ask-scope-picker]')
  await picker.waitFor({ state: 'visible' })
  // 头像走异步批量接口，浮层先出现、图片稍后到位；等首批头像真的渲染出来再量。
  await picker.locator('img').first().waitFor({ state: 'visible', timeout: 15000 })
  const geometry = await win.evaluate(() => {
    const panel = document.querySelector('[data-ask-scope-picker]')
    const area = document.querySelector('textarea[aria-label="微信问答问题"]')
    if (!panel || !area) return null
    const p = panel.getBoundingClientRect()
    const a = area.getBoundingClientRect()
    return {
      panel: { top: Math.round(p.top), bottom: Math.round(p.bottom), left: Math.round(p.left), width: Math.round(p.width) },
      area: { top: Math.round(a.top), bottom: Math.round(a.bottom), left: Math.round(a.left) },
      rows: panel.querySelectorAll('button').length,
      avatars: panel.querySelectorAll('img').length,
      dialogs: document.querySelectorAll('[data-ask-scope-picker]').length,
    }
  })
  check(geometry !== null, '浮层与输入框都能定位')
  if (geometry) {
    check(geometry.panel.bottom <= geometry.area.top - 4,
      '浮层在输入框上方展开', `panel.bottom=${geometry.panel.bottom} area.top=${geometry.area.top}`)
    check(Math.abs(geometry.panel.left - geometry.area.left) <= 4,
      '浮层与输入框左缘对齐', `${geometry.panel.left} vs ${geometry.area.left}`)
    check(geometry.panel.width >= 400, '浮层有可用的阅读宽度', `${geometry.panel.width}px`)
    check(geometry.rows > 3, '会话列表已渲染可选行', `${geometry.rows} 个按钮`)
    check(geometry.avatars > 0, '会话行显示真实头像图片', `${geometry.avatars} 张 img`)
    check(geometry.dialogs === 1, '只打开一个范围浮层', String(geometry.dialogs))
  }
  const pickerText = await picker.innerText()
  check(pickerText.includes('群聊') || pickerText.includes('单聊'), '会话行带群聊 / 单聊标签')
  check(await picker.getByPlaceholder('搜索会话名或微信号').count() === 1, '会话搜索入口存在')
  await win.screenshot({ path: join(OUT, '01-picker-open.png') })

  // ③ 点第一条真实会话；输入框只删掉触发 @。
  const firstSession = picker.locator('button:has(img)').first()
  const picked = await firstSession.innerText()
  await firstSession.click()
  await picker.waitFor({ state: 'detached' })
  const cleaned = await input.inputValue()
  check(cleaned === '帮我查一下 ', '选择范围后只移除触发 @，正文原样保留', JSON.stringify(cleaned))
  const scopeNote = await win.locator('[class*="scopeActive"]').innerText().catch(() => '')
  check(scopeNote.includes('范围：') && !scopeNote.includes('全部会话'),
    '输入框页脚显示已生效的会话范围', scopeNote)
  check(await input.evaluate((el) => el === document.activeElement), '选择后焦点回到输入框')
  const pickedName = picked.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
  check(pickedName !== '' && scopeNote.includes(pickedName),
    '范围提示与所选会话一致', `${pickedName} / ${scopeNote}`)
  await win.screenshot({ path: join(OUT, '02-session-picked.png') })

  // ④ 时间页：打开、清除范围、Esc 关闭并回到输入框。
  await input.fill('')
  await win.keyboard.type('@')
  await picker.waitFor({ state: 'visible' })
  // Radix ToggleGroup 的选项是 radio 语义，不是 button 角色。
  await picker.getByText('时间', { exact: true }).click()
  check(await picker.locator('#ask-scope-from').count() === 1
    && await picker.locator('#ask-scope-to').count() === 1, '时间页提供起止日期输入')
  await picker.getByRole('button', { name: /全部时间/ }).first().click()
  await picker.waitFor({ state: 'detached' })
  const timeClearedScope = await win.locator('[class*="scopeActive"]').innerText().catch(() => '')
  check(timeClearedScope.includes('全部时间') && timeClearedScope.includes(pickedName),
    '清除时间范围后仍保留已选会话', timeClearedScope)

  // 会话页选「全部会话」后，会话与时间都为空，范围提示应整行消失。
  await input.fill('')
  await win.keyboard.type('@')
  await picker.waitFor({ state: 'visible' })
  await picker.locator('button:not(:has(img))').filter({ hasText: '全部会话' }).first().click()
  await picker.waitFor({ state: 'detached' })
  check(await win.locator('[class*="scopeActive"]').count() === 0,
    '选择全部会话且时间为空后，范围提示消失')

  await input.fill('测试 '); await win.keyboard.type('@')
  await picker.waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  await picker.waitFor({ state: 'detached' })
  check(await input.evaluate((el) => el === document.activeElement), 'Esc 关闭后焦点回到输入框')
  check(await input.inputValue() === '测试 ', 'Esc 关闭同样只移除触发 @', JSON.stringify(await input.inputValue()))

  // ⑤ 粘贴整段含 @ 的文本不触发（只有逐字输入单个 @ 才触发）。
  await input.fill('')
  await input.fill('联系 a@b.com')
  await win.waitForTimeout(250)
  check(await picker.count() === 0, '粘贴的 @ 不会误打开浮层')

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
  ? `\n结论：检索范围浮层验收通过。截图：${OUT}`
  : `\n结论：${failed} 项不成立。`)
process.exit(failed === 0 ? 0 : 1)
