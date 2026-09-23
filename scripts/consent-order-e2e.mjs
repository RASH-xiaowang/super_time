#!/usr/bin/env node
/**
 * H14 真机验收：隐私同意排在 License 授权**之前**，且两个出口都是真的。
 *
 * 为什么必须真跑一遍（而不是读代码）：这一条此前只有 SSR / 纯逻辑 / AST 三层证据，
 * 而三层都证明不了「闸门顺序」这件事 —— 恰恰相反，读代码看到的是「同意屏排在授权之后」，
 * 于是**没有有效许可证的机器永远走不到同意屏**（2026-09-23 实测：全新 userData 的第一屏
 * 一个 checkbox 都没有）。顺序改了，只有真点一次才知道它现在到底排在哪儿。
 *
 * 五件事都在这里量（`check` 逐条打勾）：
 *   ① 走「下一页」把流程走完：同意屏出现在授权屏**之前**；
 *   ② 同意屏上有复选框，未勾选时「同意并继续」点不动，且这一站**没有**「下一页」（只有一个出口）；
 *   ③ 点「授权验证」标签跳不过去（顺序是闸门，不是建议）；
 *   ④「不同意并退出」真的退出（窗口关闭 + 主进程结束），而且没有偷偷记下同意；
 *   ⑤ 同意之后落到授权站；换一份进程重启不再问第二次（这条只有真重启能证，SSR 证不了）。
 *
 * 全程**不需要许可证、不需要厂商私钥** —— 同意屏现在排在授权之前，正是为了让这一步
 * 能在干净检出 / CI runner 上成立（要签许可证的验收都进不了 CI，见 N23）。
 * 也不设 `SUPERTIME_SKIP_ONBOARDING`：那道豁免会把三道闸门一起跳掉，用了它就等于没验。
 *
 * 运行：node scripts/consent-order-e2e.mjs
 * 退出码：0 = 全部成立；1 = 有断言不成立；2 = 前置缺失（没有 playwright / electron）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { once } from 'node:events'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SHOT_DIR = join(tmpdir(), 'super-time-h14-e2e')
const CONSENT_KEY = 'super-time-privacy-consent-v1'
const CONSENT_TITLE = '隐私与数据边界'
const LICENSE_TITLE = 'License 授权验证'
/** 与 `privacy/consent.ts` 的 `PRIVACY_VERSION` 对齐：从源码读，别把数字抄在这儿。 */
const PRIVACY_VERSION = Number(
  readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'consent.ts'), 'utf8')
    .match(/export const PRIVACY_VERSION\s*=\s*(\d+)/)?.[1])

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
if (!PRIVACY_VERSION) {
  console.error('[前置] 读不到 PRIVACY_VERSION（consent.ts 的写法变了？断言 ⑤ 会失真）')
  process.exit(2)
}

mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail: String(detail) })
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + String(detail)}`)
  return !!ok
}

/** 起一个真实实例：只换 userData，不开任何闸门豁免。返回 null 表示起不来。 */
async function launch(userData) {
  const app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_USER_DATA_DIR: userData,
      // 合成一个空数据根，避免去碰本机那份真实微信库（N6 之后迁移已不带密钥，
      // 但指到本机目录仍会把真实库解密进测试目录 —— 这里干脆给一个不存在的路径）。
      DSH_WECHAT_DATA_DIR: join(userData, 'wechat-data'),
      DSH_WECHAT_DECRYPTED_DIR: join(userData, 'wechat-data', 'decrypted'),
    },
  })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 760 })
  await win.getByRole('button', { name: '首页' }).first().waitFor({ timeout: 60_000 })
  return { app, win }
}

/** 当前站在哪一屏：'' = 还在介绍页，'consent' / 'license'。 */
async function stageOf(win) {
  if (await win.locator(`text=${CONSENT_TITLE}`).count()) return 'consent'
  if (await win.locator(`text=${LICENSE_TITLE}`).count()) return 'license'
  return ''
}
const consentBox = (win) => win.getByRole('checkbox')
const shot = (win, name) => win.screenshot({ path: join(SHOT_DIR, name + '.png') }).catch(() => {})
const readConsent = (win) => win.evaluate((k) => localStorage.getItem(k), CONSENT_KEY)

/** 按「下一页」往前走，最多 N 步；返回走到哪一屏（每步都记下来，供顺序断言用）。 */
async function walkNext(win, maxSteps) {
  const path = []
  for (let i = 0; i < maxSteps; i += 1) {
    const stage = await stageOf(win)
    path.push(stage)
    if (stage) break
    const next = win.getByRole('button', { name: '下一页' })
    if ((await next.count()) === 0) break
    await next.first().click()
    await sleep(260)
  }
  return path
}

const cases = []
let launched = null
const userDataA = mkdtempSync(join(tmpdir(), 'super-time-h14-a-'))
const userDataB = mkdtempSync(join(tmpdir(), 'super-time-h14-b-'))

const closeApp = async (l) => {
  if (!l) return
  try { await l.app.close() } catch { /* 已经自己退了（走了「不同意并退出」那条路） */ }
}

try {
  // ── ① 同意屏排在授权屏之前 ──────────────────────────────────────────────
  console.log('\n[实例 A] 全新 userData，不设任何闸门豁免')
  launched = await launch(userDataA)
  let { win } = launched

  check((await consentBox(win).count()) === 0, '第一屏（首页）没有同意复选框 —— 它是第五站，不是开场')
  const path = await walkNext(win, 6)
  const atConsent = await stageOf(win)
  check(atConsent === 'consent',
    '按「下一页」走到的是同意屏，不是授权屏', `path=${JSON.stringify(path)} stage=${atConsent}`)
  check(!path.includes('license'), '走到同意屏之前没有任何一步是授权屏', JSON.stringify(path))

  // ── ② 同意屏自己：显式同意才有出口 ──────────────────────────────────────
  check((await consentBox(win).count()) === 1, '同意屏上有一个复选框')
  const agree = win.getByRole('button', { name: '同意并继续' })
  check((await agree.count()) === 1, '同意屏上有「同意并继续」')
  check(await agree.first().isDisabled(), '没勾选时「同意并继续」是点不动的')
  check((await win.getByRole('button', { name: '不同意并退出' }).count()) === 1,
    '给了「不同意并退出」，不是只有「同意」一条路')
  check((await win.getByRole('button', { name: '下一页' }).count()) === 0,
    '这一站没有「下一页」：往前走的唯一出口就是同意')
  check((await win.locator(`text=${LICENSE_TITLE}`).count()) === 0, '同意屏上没有混进授权内容')
  const stText = String(await win.locator('[class*="progressText"]').first().innerText().catch(() => ''))
  check(/CONSENT REQUIRED/.test(stText), '底栏自报这一站缺的是同意', stText)
  await shot(win, 'a-consent')

  // ── ③ 点标签也跳不过去 ─────────────────────────────────────────────────
  await win.getByRole('button', { name: '授权验证' }).first().click()
  await sleep(320)
  check(await stageOf(win) === 'consent', '点「授权验证」标签跳不过同意站', `stage=${await stageOf(win)}`)

  // ── ④「不同意并退出」是真的退出，且不留同意记录 ─────────────────────────
  check((await readConsent(win)) === null, '退出前 localStorage 里没有同意记录')
  const proc = launched.app.process()
  let exited = false
  const exitRace = Promise.race([
    once(proc, 'exit').then(() => { exited = true }),
    sleep(15_000),
  ])
  await win.getByRole('button', { name: '不同意并退出' }).first().click().catch((e) => {
    check(false, '「不同意并退出」点得动', e.message)
  })
  await exitRace
  check(exited, '点「不同意并退出」后主进程真的退出了（不是只换了个页面）',
    `exited=${exited} killed=${proc.killed} code=${proc.exitCode}`)
  launched = null

  // ── ⑤ 同一份 userData 重启：没同意过，就还该问第二遍 ────────────────────
  console.log('\n[实例 A2] 同一份 userData 重启（上面选了不同意）')
  launched = await launch(userDataA)
  win = launched.win
  check((await readConsent(win)) === null, '不同意退出没有偷偷写入同意记录')
  const pathA2 = await walkNext(win, 6)
  check(await stageOf(win) === 'consent', '重启后仍走到同意站（不同意 = 每次启动都再问一遍）', JSON.stringify(pathA2))
  await closeApp(launched)
  launched = null

  // ── ⑥ 勾上再同意：落到授权站，且记录只写一次 ───────────────────────────
  console.log('\n[实例 B] 另一份全新 userData，这次选同意')
  launched = await launch(userDataB)
  win = launched.win
  await walkNext(win, 6)
  check(await stageOf(win) === 'consent', '同意站的位置与实例 A 一致（不是靠运气撞上的）')
  await consentBox(win).first().check()
  const agreeB = win.getByRole('button', { name: '同意并继续' })
  check(!(await agreeB.first().isDisabled()), '勾上之后「同意并继续」解禁')
  await agreeB.first().click()
  await sleep(400)
  check(await stageOf(win) === 'license', '同意之后落到的是授权站（顺序：介绍页 → 同意 → 授权）')
  check((await win.getByRole('button', { name: '隐私同意' }).count()) === 0,
    '同意之后「隐私同意」这一站整体撤下（不是一份已经生效的声明挂在那儿）')
  const rec = JSON.parse(String(await readConsent(win)))
  check(rec && rec.version === PRIVACY_VERSION, '同意记录写进 localStorage，版本对得上声明', JSON.stringify(rec))
  check(typeof rec?.acceptedAt === 'string' && rec.acceptedAt.length > 0, '记录带时间（可审计）', String(rec?.acceptedAt))
  const stB = String(await win.locator('[class*="progressText"]').first().innerText().catch(() => ''))
  check(/LICENSE/.test(stB) && /STAGE 05/.test(stB), '底栏改口说授权缺什么，页码也从 05 起', stB)
  await shot(win, 'b-license')
  await closeApp(launched)
  launched = null

  // ── ⑦ 真重启后不再问第二次（只有这一步能证） ───────────────────────────
  console.log('\n[实例 B2] 同一份 userData 重启（上面同意了）')
  launched = await launch(userDataB)
  win = launched.win
  const pathB2 = await walkNext(win, 6)
  check(!pathB2.includes('consent'), '重启后介绍页里不再插入同意站', JSON.stringify(pathB2))
  check(await stageOf(win) === 'license', '重启后第四站之后直接就是授权站')
  check((await consentBox(win).count()) === 0, '重启后全路没有第二个复选框（一次同意有效）')
  const recB2 = JSON.parse(String(await readConsent(win)))
  check(recB2?.version === PRIVACY_VERSION, '同意记录跨进程仍然在（换进程重启不再问第二次）', JSON.stringify(recB2))
  await closeApp(launched)
  launched = null

  // ── ⑧ 声明升版 ⇒ 下次启动重新问（把记录版本改旧 = 等价于 PRIVACY_VERSION +1） ──
  // `consent.spec.ts` 已在纯函数层钉过这条；这里要的是**真应用读真 localStorage** 的那一遍：
  // 版本号写在磁盘上的记录里，判定发生在渲染层挂载时，只有真启一次才知道它有没有被接上。
  console.log('\n[实例 B3] 把同意记录的版本改旧（模拟声明升版），重启')
  launched = await launch(userDataB)
  win = launched.win
  const stale = { version: PRIVACY_VERSION - 1, acceptedAt: new Date(0).toISOString() }
  await win.evaluate(([k, v]) => { localStorage.setItem(k, JSON.stringify(v)) }, [CONSENT_KEY, stale])
  await win.reload()
  await win.getByRole('button', { name: '首页' }).first().waitFor({ timeout: 60_000 })
  const pathB3 = await walkNext(win, 6)
  check(await stageOf(win) === 'consent', '版本偏低的同意记录不算数：同意站又回来了', JSON.stringify(pathB3))
  check((await consentBox(win).count()) === 1, '重新问时仍是「必须显式勾选」，不是看一眼就过')
  check((await win.locator(`text=v${String(PRIVACY_VERSION)}`).count()) > 0,
    '同意屏上写的就是当前声明版本', `v${String(PRIVACY_VERSION)}`)
} catch (e) {
  check(false, '脚本跑完没有抛错', `${e?.stack || e}`)
} finally {
  await closeApp(launched)
  for (const dir of [userDataA, userDataB]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上进程可能还在收尾 */ }
  }
}

const failed = results.filter((r) => !r.ok)
writeFileSync(join(SHOT_DIR, 'result.json'), JSON.stringify({ results, failed: failed.length }, null, 2))
console.log(`\n${failed.length === 0 ? '✅' : '❌'} H14 同意先于授权：通过 ${results.length - failed.length} 项 / 失败 ${failed.length} 项`)
if (failed.length) {
  for (const f of failed) console.log(`   ✗ ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
  console.log(`截图与逐项结果：${SHOT_DIR}`)
}
process.exit(failed.length ? 1 : 0)
