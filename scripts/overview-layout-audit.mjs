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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { _electron } from 'playwright'
import { seedRealProfile } from './real-profile.mjs'

const ROOT = join(import.meta.dirname, '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = join(ROOT, '.tmp-e2e')
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE)
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

/**
 * 单独起一个 profile：用户的正式实例此刻可能正开着（单实例锁按 userData 区分）。
 * 配置从**真实 profile** 带过来（含 llm.json），数据根问应用自己写在
 * `resolved.dataRoot` 里的那个 —— 见 `real-profile.mjs` 的注释（"量的是同一个盘子"）。
 */
const userData = mkdtempSync(join(tmpdir(), 'st-ova-'))
const seeded = seedRealProfile(userData)
const DATA = seeded.dataRoot
console.log(`真实 profile：${seeded.source}（带入 ${seeded.copied.join('、') || '（无额外配置）'}）`)
console.log(`真实数据根：${DATA}`)

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
    // 就绪判据用**专属属性**而不是类名/文案：2026-09-27 换霓虹皮肤时，旧判据查的是
    // `[class*=ovHero]` —— 那一套类名被删掉之后，本脚本把"没找到"读成"首启空库"并**静默跳过**
    // （退出码还是 0）。真窗口判据的靶子必须是"只有那一块才有"的钩子，改皮不换钩子。
    const loaded = !!body.querySelector('[data-st-ov-hero]')
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
  // 等距指标牌：内容必须落在**板面（六边形）**的安全区里，且 8 张一模一样高。
  //
  // 为什么量的是"板面"而不是"按钮盒子"：第一版拿 `plateBody` 比 button 的 rect，它**永远通过** ——
  // button 是 flex 容器，内容多高它就多高（`min-height` 只是下限）。而真正的坏法是内容压到
  // **板面**上：板面是 `clip-path` 切出来的六边形（`inset: 12px 6px 6px` + 上下各 18% 高的斜带），
  // 内容比它的"中间带"高时，字就压在斜边上；而"裁切"那一条也抓不到（牌子不是滚动容器）。
  // 2026-09-27 就是这么做过去的：实测把牌子改矮到 92px，判据照样全绿 —— 于是改成按板面几何判。
  const plate = await win.evaluate(() => {
    const hero = document.querySelector('[data-st-ov-hero]')
    if (!hero) return { n: 0, out: [], hs: [], margins: [] }
    const plates = [...hero.querySelectorAll('button')]
    const out = []
    const margins = []
    for (const b of plates) {
      const faceEl = b.querySelector('[class*=plateFace]')
      const name = (b.getAttribute('title') ?? '').replace('查看', '')
      if (!faceEl) { out.push(`${name} 找不到板面元素`); continue }
      const f = faceEl.getBoundingClientRect()
      const body = b.querySelector('[class*=plateBody]') || b
      const c = body.getBoundingClientRect()
      // ① 内容整体要在板面的锚框内（留 4px 余量）
      const margin = Math.round(Math.min(c.left - f.left, f.right - c.right, c.top - f.top, f.bottom - c.bottom))
      margins.push(`${name} ${margin}px`)
      if (margin < 4) { out.push(`${name} 内容越出板面锚框（最小余量 ${margin}px）`); continue }
      // ② 斜带：板面上下各 18% 高度是**线性收窄**的（最窄处平边只占 18%–82%）。
      //    判据按斜边的真实方程算：在离顶 t 的位置，平边起点 = 18% × (1 − t/cap) × 面宽。
      //    （第一版拿"最窄处"当常数比，太严：内容刚进斜带一点点就被判红，那是判据错不是设计错。）
      const capH = f.height * 0.18
      const flat = (edge) => f.left + f.width * 0.18 * (1 - Math.min(1, Math.max(0, edge / capH)))
      if (c.top < f.top + capH) {
        const flatL = flat(c.top - f.top)
        if (c.left < flatL) out.push(`${name} 顶行压在上斜带里（内容 left ${Math.round(c.left)} < 该高度平边 ${Math.round(flatL)}）`)
      }
      if (c.bottom > f.bottom - capH) {
        const flatL = flat(f.bottom - c.bottom)
        if (c.left < flatL) out.push(`${name} 末行压在下斜带里（内容 left ${Math.round(c.left)} < 该高度平边 ${Math.round(flatL)}）`)
      }
    }
    return { n: plates.length, out, hs: plates.map((b) => Math.round(b.getBoundingClientRect().height)), margins }
  })
  check(plate.n === 8, `指标牌数量应为 8，实测 ${plate.n}`)
  check(plate.out.length === 0, `指标牌内容越出板面安全区：${plate.out.join(' | ')}`)
  if (plate.hs.length > 0) {
    check(Math.max(...plate.hs) - Math.min(...plate.hs) <= 2, `8 张指标牌高度不齐：${plate.hs.join('/')}`)
    console.log(`指标牌：${plate.hs.length} 张，高 ${plate.hs.join('/')}；内容距板面最小余量：${plate.margins.join(' / ')}`)
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
