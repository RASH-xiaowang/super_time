/**
 * 「微信数据总览」留白审计：真实 Electron + 真实解密数据，量出**空白到底有多少**。
 *
 * 为什么要有这个脚本：本轮把总览的留白清掉时，好几处问题在源码和单测里完全看不出来 ——
 *   · 世界地图卡 619px 高，其中一张 520px 的画布只画了中间一条，两侧还各有一条 240px 的
 *     头像栏；「限高 340px」「隐藏头像栏」两条规则因为用了 `:global(.stage)`（发出的是裸类名，
 *     而真实类名带哈希）而**从未生效**。
 *   · 「轨道趋势」5 个指标排成 3 行（`.ovTrend` 类没接到 JSX 上），一张卡凭空高 110px。
 *   · 底栏是一个 5 栅格纵列，12 栅格里空着 7 栅格 ≈ 770×814px。
 *   · 同行卡片等高拉伸后，矮的那张底部留 70–145px 空白。
 * 这些只有真实布局引擎 + 真实数据能回答。所以这里把「留白」变成可复现的两个数字：
 *   **卡内空白合计** 与 **网格空洞**，并留下上/中/下三张截图供人眼复核。
 *
 * 前置：开发态的真实解密库（默认 `%APPDATA%\super-time-electron\wechat-data`）。
 * 没有数据时（首启空库）本脚本**跳过布局判定**并以 0 退出 —— 空库下所有卡片都是骨架屏，
 * 量出来的空白没有意义。
 *
 * 运行：npm run ui:overview-audit
 * 退出码：0 = 通过或跳过；1 = 有断言不成立；2 = 前置缺失。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { _electron } from 'playwright'

const ROOT = join(import.meta.dirname, '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e')
const DATA = join(process.env.APPDATA ?? '', 'super-time-electron', 'wechat-data')
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

/**
 * 单独起一个 profile：用户的正式实例此刻可能正开着（单实例锁按 userData 区分），
 * 而 state 里的 config.json 显式写明 dataRoot/decryptedDir 指向真实解密库，
 * 这样既不打扰用户实例，又能读到真实数据。不写 db_dir/密钥 → 不会触发重新解密。
 */
const userData = mkdtempSync(join(tmpdir(), 'st-ova-'))
mkdirSync(join(userData, 'wechat'), { recursive: true })
writeFileSync(join(userData, 'wechat', 'config.json'), JSON.stringify({
  dataRoot: DATA,
  decryptedDir: join(DATA, 'decrypted'),
  decodedImagesDir: join(DATA, 'decoded_images'),
  sourceDir: '', baseDir: '', selfWxid: '', silkBinary: '', resolved: {},
  wechatSettings: { api_enabled: true, api_port: 5032, cdn_enabled: true, cdn_local_decrypt: false },
  wechatSettingsMeta: { savedAt: new Date().toISOString(), source: 'overview-audit' },
}, null, 2) + '\n')

let app = null
const fails = []
const check = (ok, msg) => { if (!ok) fails.push(msg) }
try {
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, SUPERTIME_USER_DATA_DIR: userData, SUPERTIME_SKIP_ONBOARDING: '1', SUPERTIME_TEST_MODE: '1' },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(60000)
  const errs = []
  win.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)) })
  win.on('pageerror', (e) => errs.push('pageerror: ' + String(e.message).slice(0, 160)))
  await win.waitForLoadState('domcontentloaded')
  await win.getByRole('button', { name: '数据总览', exact: true }).waitFor({ state: 'visible' })
  await win.getByRole('button', { name: '数据总览', exact: true }).click()
  for (let i = 0; i < 90; i++) {
    const t = await win.locator('main').innerText().catch(() => '')
    if (t.length > 600 && !/正在加载|加载中/.test(t)) break
    await sleep(1000)
  }
  await sleep(7000)

  /** 面板滚动容器（从正文往上找，别误抓左侧导航）。 */
  const scrollTo = async (ratio) => {
    await win.evaluate((r) => {
      let el = document.querySelector('[class*=panelBody]')
      let sc = null
      while (el) {
        if (el.scrollHeight > el.clientHeight + 50) { sc = el; break }
        el = el.parentElement
      }
      if (sc) sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * r
    }, ratio)
    await sleep(1400)
  }
  // 量之前先回到顶部：否则卡片 y 会是负的（截图也会从中间开始）
  await scrollTo(0)

  const rep = await win.evaluate(() => {
    const body = document.querySelector('main [class*=panelBody]') || document.querySelector('main')
    const loaded = !!body.querySelector('[class*=ovHero]')
    if (!loaded) return { loaded: false }
    const cls = (el) => Array.from(el.classList).join(' ').slice(0, 50)
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const grid = body.querySelector('[class*=ovGrid]')
    const gw = grid ? Math.round(grid.getBoundingClientRect().width) : 0
    const cards = [...body.querySelectorAll('section[class*=ovCard]')].map((c) => {
      const bd = c.querySelector('[class*=ovCardBd]')
      const r = rect(c)
      const pad = bd ? parseFloat(getComputedStyle(bd).paddingBottom) : 0
      let contentBottom = 0
      if (bd) for (const k of bd.children) contentBottom = Math.max(contentBottom, k.getBoundingClientRect().bottom)
      const bdRect = bd ? bd.getBoundingClientRect() : null
      const empty = bdRect ? Math.max(0, Math.round(bdRect.bottom - pad - contentBottom)) : 0
      const clipped = [...c.querySelectorAll('*')]
        .filter((el) => el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 20)
        .map((el) => `${cls(el)} ${el.clientHeight}<${el.scrollHeight}`)
      return { title: (c.querySelector('h3')?.textContent ?? '').trim(), ...r, empty, clipped: clipped.slice(0, 2) }
    })
    // 网格空洞：按 y 分行，一行卡片宽度和 + 间距若明显小于网格宽度 → 那一行有空列
    const byRow = new Map()
    for (const c of cards) {
      const key = Math.round(c.y / 8) * 8
      if (!byRow.has(key)) byRow.set(key, [])
      byRow.get(key).push(c)
    }
    const holes = []
    for (const [y, row] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const used = row.reduce((s, c) => s + c.w, 0) + (row.length - 1) * 10
      if (gw && used < gw - 20) holes.push(`y=${y} 只用到 ${used}/${gw}px，空 ${gw - used}px（${row.map((c) => c.title || '?').join(' + ')}）`)
    }
    return { loaded: true, total: body.scrollHeight, cards, gw, holes }
  })

  if (!rep.loaded) {
    console.log('未检测到已加载的总览数据（首启空库），跳过布局判定。')
    console.log('把真实解密库放到', DATA, '后再运行。')
    process.exit(0)
  }

  console.log(`正文总高: ${rep.total}px（整屏约 802px → ${(rep.total / 802).toFixed(1)} 屏）`)
  console.log(`网格宽: ${rep.gw}px\n`)
  console.log('卡片                           y     h   卡内空白   裁切')
  let sumEmpty = 0
  for (const c of rep.cards) {
    sumEmpty += c.empty
    console.log(`${c.title.padEnd(26)} ${String(c.y).padStart(5)} ${String(c.h).padStart(5)} ${String(c.empty).padStart(8)}   ${c.clipped.join(' | ')}`)
  }
  console.log(`\n卡内空白合计: ${sumEmpty}px`)
  console.log(`网格空洞: ${rep.holes.length === 0 ? '无' : ''}`)
  for (const h of rep.holes) console.log('  ✗ ' + h)

  check(sumEmpty < 200, `卡内空白合计 ${sumEmpty}px 偏大（阈值 200px）`)
  check(rep.holes.length === 0, `网格存在空洞：${rep.holes.join(' | ')}`)
  check(rep.cards.every((c) => c.clipped.length === 0), `有内容被裁切：${rep.cards.filter((c) => c.clipped.length).map((c) => `${c.title} ${c.clipped.join(',')}`).join(' | ')}`)
  check(errs.length === 0, `渲染层 console error：${errs.slice(0, 2).join(' | ')}`)

  const scrollToBottom = async (ratio) => {
    await win.evaluate((r) => {
      let el = document.querySelector('[class*=panelBody]')
      let sc = null
      while (el) {
        if (el.scrollHeight > el.clientHeight + 50) { sc = el; break }
        el = el.parentElement
      }
      if (sc) sc.scrollTop = (sc.scrollHeight - sc.clientHeight) * r
    }, ratio)
    await sleep(1400)
  }
  await win.screenshot({ path: join(OUT, 'overview-top.png') })
  await scrollToBottom(0.5)
  await win.screenshot({ path: join(OUT, 'overview-mid.png') })
  await scrollToBottom(1)
  await win.screenshot({ path: join(OUT, 'overview-bottom.png') })
  console.log(`\n截图：${OUT}\\overview-{top,mid,bottom}.png`)
} catch (e) {
  check(false, '端到端流程未能跑完：' + (e && e.message ? e.message.split('\n')[0] : String(e)))
} finally {
  if (app) { try { await app.close() } catch { /* ignore */ } }
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(fails.length === 0 ? '\n✅ 留白审计通过' : `\n❌ 留白审计不通过：\n - ${fails.join('\n - ')}`)
process.exit(fails.length === 0 ? 0 : 1)
