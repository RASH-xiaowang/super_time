#!/usr/bin/env node
/**
 * M3 真机验收（第二半）：**加密备份**那条入口的进度与中止。
 *
 * 上一份 `export-progress-e2e.mjs` 验的是聊天记录导出；`Backup.tsx` 接的是**同一条**中继与
 * **同一个** jobId 口径，但那是另一条按钮、另一段渲染分支 —— 「同一套」不等于「一起验过」，
 * 台账里这一条一直挂着「仍未验」。这一刀把它跑掉。
 *
 * 走的是真界面：设置 → 备份恢复 → 填密码 → 加密备份 →（观察进度）→ 中止 → 再跑一次小的确认真落盘。
 * 合成根里塞了 300 个 ~600KB 的文件，让 `createEncryptedBackup` 的 'files' 阶段有东西可报
 * （'files' 报 i/N ⇒ 总量已知 ⇒ 进度条应当真的在填；'write' 报字节且 total=0 ⇒ 应当走不定量态）。
 *
 * 运行：node scripts/backup-progress-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const BULK_FILES = 250
const BULK_SIZE = 4 * 1024 * 1024
const USER = 'wxid_m3bak'

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
  results.push({ ok: !!ok, label, detail: String(detail) })
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail)}`)
}

/** 合成一份「备份得到东西」的解密根：几个真实小库 + 一批大块文件（喂给 files/write 两个阶段）。 */
function makeFixture(userData) {
  const decrypted = join(userData, 'wechat-data', 'decrypted')
  mkdirSync(join(decrypted, 'session'), { recursive: true })
  writeFileSync(join(decrypted, 'session', 'session.db'), randomBytes(64 * 1024))
  const bulk = join(decrypted, 'media_bulk')
  mkdirSync(bulk, { recursive: true })
  // 一次生成一块随机数据再复制，避免 300 次 randomBytes（慢且没意义）
  const one = randomBytes(BULK_SIZE)
  for (let i = 0; i < BULK_FILES; i += 1) writeFileSync(join(bulk, 'blob_' + String(i) + '.bin'), one)
  return decrypted
}

let app = null
const userData = mkdtempSync(join(tmpdir(), 'super-time-m3bak-'))
try {
  const decrypted = makeFixture(userData)
  const backupsDir = join(userData, 'wechat-data', 'backups')
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: userData,
      DSH_WECHAT_DATA_DIR: join(userData, 'wechat-data'),
      DSH_WECHAT_DECRYPTED_DIR: decrypted,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30000)
  const pageErrors = []
  win.on('pageerror', (e) => { pageErrors.push(String(e.message).slice(0, 200)) })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(2500)
  const later = win.getByRole('button', { name: '稍后再说', exact: true })
  try { await later.waitFor({ state: 'visible', timeout: 5000 }); await later.click() } catch { /* 没有向导 */ }

  // 事件记录器：进度是异步推的，靠轮询会漏掉短阶段（导出那份脚本已经踩过一次）
  await win.evaluate(() => {
    window.__prog = []
    window.addEventListener('dsh-wechat-export-progress', (e) => { window.__prog.push(e.detail) })
  })

  await win.getByRole('button', { name: '设置', exact: true }).first().click()
  await win.waitForTimeout(800)
  const section = win.locator('[data-settings-section="backup"]')
  await section.scrollIntoViewIfNeeded()
  const pwd = section.locator('input[type="password"]')
  await pwd.fill('m3-e2e-passw0rd')

  // ── ① 大备份：进度要看得见，然后中止 ────────────────────────────
  await section.getByRole('button', { name: '加密备份', exact: true }).click()
  // 界面层看「有没有在动」（渲染出来的那一格），事件层看「动得对不对」（阶段、done/total）。
  // 分两层是必须的：'write' 每个数据块报一次、'files' 每个文件报一次，DOM 上永远只显示**最后一条**，
  // 所以想在界面上看见 'files' 阶段基本靠运气 —— 阶段的事实只能从事件里读。
  const CAPTION = /([a-z]+) · (\d+)(?: \/ (\d+))?/
  const seen = []
  let sawIndeterminate = false
  let sawBar = false
  for (let i = 0; i < 900; i += 1) {
    const row = await section.innerText().catch(() => '')
    const m = row.match(CAPTION)
    if (m) seen.push({ phase: m[1], done: Number(m[2]), total: Number(m[3] ?? 0) })
    const bars = await win.locator('[role="progressbar"]').count()
    if (bars > 0) {
      sawBar = true
      if (await win.locator('[role="progressbar"][data-indeterminate]').count() > 0) sawIndeterminate = true
    }
    if (seen.length >= 4 && sawIndeterminate && sawBar) break
    await sleep(60)
  }
  const events = await win.evaluate(() => window.__prog ?? [])
  check(seen.length >= 2 && sawBar, '界面上看得到加密备份的进度行', `采到 ${seen.length} 格，progressbar 元素 ${sawBar}`)
  check(events.length > 0 && events.every((e) => /^backup-enc-/.test(String(e.jobId))),
    '进度事件都挂在加密备份自己的 jobId 上', `事件 ${events.length}：${[...new Set(events.map((e) => String(e.jobId)))].join(',')}`)
  /** 事件里按阶段分组（'write' 是字节、'files' 是「第 i / 共 N 个文件」）。 */
  const byPhase = new Map()
  for (const e of events) {
    const ph = String(e.phase ?? '')
    byPhase.set(ph, [...(byPhase.get(ph) ?? []), { done: Number(e.done ?? 0), total: Number(e.total ?? 0) }])
  }
  const filesEv = byPhase.get('files') ?? []
  check(filesEv.length >= 2 && filesEv[filesEv.length - 1].done > filesEv[0].done,
    `'files' 阶段按 i/N 往前走（这一阶段总量已知）`,
    `files ${filesEv.length} 格：${filesEv.slice(0, 3).map((x) => x.done + '/' + x.total).join(' → ')}`)
  check(filesEv.length === 0 || filesEv.every((x) => x.total > 0 && x.done <= x.total),
    `'files' 每条都给出可核对的 done ≤ total`, filesEv.slice(0, 2).map((x) => x.done + '/' + x.total).join(' '))
  const writeEv = byPhase.get('write') ?? []
  check(writeEv.length > 1 && writeEv[writeEv.length - 1].done > writeEv[0].done,
    `'write' 阶段的字节数在涨`, `write ${writeEv.length} 格：${writeEv[0]?.done} → ${writeEv[writeEv.length - 1]?.done}`)
  check(sawIndeterminate, '总量未知的阶段走不定量态（而不是钉在 0%）', `界面采到 ${seen.length} 格`)
  check([...byPhase.values()].flat().every((x) => x.total === 0 || x.done <= x.total),
    '没有任何一条上报出现 done > total',
    [...byPhase.entries()].map(([k, v]) => k + ':' + v.length).join(' '))

  const stopBtn = section.getByRole('button', { name: '中止', exact: true })
  check(await stopBtn.count() > 0, '备份进行中给出「中止」入口', '')
  await stopBtn.click()
  let stopped = false
  for (let i = 0; i < 120; i += 1) {
    await sleep(150)
    const row = await section.innerText().catch(() => '')
    if (!CAPTION.test(row) && !(await win.locator('[role="progressbar"]').count())) { stopped = true; break }
  }
  check(stopped, '中止后进度行收掉（不卡在备份中）', '')
  await sleep(600)
  const bodyText = await win.locator('body').innerText()
  check(/已取消加密备份/.test(bodyText), '提示是「已取消加密备份」', bodyText.match(/[^\n]*取消[^\n]*/)?.[0] ?? '(没找到)')
  check(!/加密备份失败/.test(bodyText) && !/备份失败/.test(bodyText), '取消没有被报成失败',
    bodyText.match(/(加密备份失败|备份失败)[^\n]*/)?.[0] ?? '')
  const wcb = existsSync(backupsDir) ? readdirSync(backupsDir).filter((f) => f.endsWith('.wcb')) : []
  check(wcb.length === 0, '被取消的备份没有留下 .wcb', wcb.join(', '))
  const residue = existsSync(backupsDir) ? readdirSync(backupsDir).filter((f) => f.includes('.partial-')) : []
  check(residue.length === 0, '备份目录里没有 `.partial-*` 半成品', residue.join(', '))

  // ── ② 小备份：真落盘，并且出现在列表里 ──────────────────────────
  await win.evaluate(() => { window.__prog = [] })
  const bulk = join(decrypted, 'media_bulk')
  for (const f of readdirSync(bulk)) rmSync(join(bulk, f), { force: true, maxRetries: 8, recursive: true })
  for (let i = 0; i < 60 && readdirSync(bulk).length > 0; i += 1) {
    for (const f of readdirSync(bulk)) { try { rmSync(join(bulk, f), { force: true }) } catch { /* 句柄未释放 */ } }
    await sleep(200)
  }
  check(readdirSync(bulk).length === 0, '清空大块文件（让第二次备份是小活儿）', `剩余 ${readdirSync(bulk).length} 个`)
  await section.getByRole('button', { name: '加密备份', exact: true }).click()
  let done = false
  for (let i = 0; i < 240; i += 1) {
    await sleep(250)
    const list = await section.innerText().catch(() => '')
    if (existsSync(backupsDir) && readdirSync(backupsDir).some((f) => f.endsWith('.wcb'))) { done = true; break }
    if (/加密备份失败|请输入备份密码/.test(list)) break
  }
  const wcb2 = existsSync(backupsDir) ? readdirSync(backupsDir).filter((f) => f.endsWith('.wcb')) : []
  check(done && wcb2.length === 1, '清空大块文件后一次加密备份真的落盘',
    `文件：${wcb2.join(', ') || '(无)'} · 界面：${(await section.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)}`)
  if (wcb2.length === 1) {
    const size = statSync(join(backupsDir, wcb2[0])).size
    check(size > 1024, '产物不是空壳', `字节 ${size}`)
  }
  const shown = await section.innerText().catch(() => '')
  check(wcb2.length === 0 || shown.includes(wcb2[0]), '备份完成后列表里能看到它（refresh 真的跑了）', shown.slice(0, 80).replace(/\s+/g, ' '))
  check(pageErrors.length === 0, '全程无渲染层异常', pageErrors.join(' | ').slice(0, 200))
} catch (e) {
  console.error('测试执行异常:', e)
  results.push({ ok: false, label: '执行期异常', detail: String(e).slice(0, 300) })
} finally {
  try { await app?.close() } catch { /* 已退出 */ }
  for (let i = 0; i < 20 && existsSync(userData); i += 1) {
    try { rmSync(userData, { recursive: true, force: true }) } catch { await sleep(250) }
  }
}

const bad = results.filter((r) => !r.ok)
console.log(`\nM3 加密备份真机验收：${results.length - bad.length}/${results.length} 成立`)
if (bad.length > 0) {
  console.log('未成立：')
  for (const b of bad) console.log(`  · ${b.label}${b.detail ? ' —— ' + b.detail : ''}`)
  process.exit(1)
}
process.exit(0)
