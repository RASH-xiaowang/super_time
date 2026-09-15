/**
 * 群聊信息面板视觉审计 v3。
 * 起真实 Electron（连本机已解密微信库）→ CDP 驱动 → 打开「群聊信息」抽屉
 * → 采集计算样式 / 交互态（CDP 强制伪类）/ 响应式表现，并截图。
 * 只写 output/visual-audit/（gitignored），不改仓库源码。
 */
// playwright 需自行安装（仓库未把它列为常规依赖，见 RELEASE-PLAN 的 L5）：
//   npm i --no-save playwright    # PowerShell: $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm i --no-save playwright
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 本脚本现在住在仓库里（原先在 gitignore 的 output/ 下，导致审计结论不可复现）：
// 上溯两级到仓库根，产物一律写回 gitignore 的 output/ 下，不污染工作树。
const REPO = path.resolve(import.meta.dirname, '..', '..')
const OUT = path.join(REPO, 'output', 'visual-audit')
const PORT = 9335
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
// 优先审计的群名：原先硬编码了两个**真实群名**（提交到仓库等于泄漏用户数据），
// 现在改成从环境变量取，默认空 = 按聊天列表顺序取前几个。
//   AUDIT_GROUPS="群A,群B" node tools/visual-audit/audit3.mjs
const PREFERRED = (process.env.AUDIT_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean)

const log = (...a) => console.log('[audit]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(port, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return await r.json()
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  throw new Error('CDP 端口未就绪')
}

const HELPERS = `
window.__a = {
  find(s) {
    const exact = document.querySelector('[class~="' + s + '"]')
    if (exact) return exact
    return Array.from(document.querySelectorAll('[class*="' + s + '"]'))
      .find(el => Array.from(el.classList).some(c => c.includes(s))) || null
  },
  all(s) {
    return Array.from(document.querySelectorAll('[class*="' + s + '"]'))
      .filter(el => Array.from(el.classList).some(c => c.includes(s)))
  },
  rect(el) {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
  },
  dump(label, el, props) {
    if (!el) return { label, missing: true }
    const cs = getComputedStyle(el)
    const o = { label, tag: el.tagName, cls: el.className, rect: window.__a.rect(el) }
    for (const p of props) o[p] = cs.getPropertyValue(p)
    return o
  },
}
`

const BOX = ['width','height','padding','padding-top','padding-bottom','padding-left','padding-right',
  'margin','margin-bottom','border','border-top','border-bottom','border-left','border-radius',
  'background-color','background-image','color','font-size','font-weight','line-height','font-family',
  'display','flex-direction','align-items','justify-content','gap','grid-template-columns','column-gap','row-gap',
  'box-shadow','letter-spacing','overflow','overflow-y','text-overflow','white-space','opacity','transition',
  'backdrop-filter','position','z-index','align-self','flex-shrink','min-height','max-width','box-sizing','text-align','cursor']

async function main() {
  // 只清产物，脚本本体放在上一层
  for (const f of fs.readdirSync(OUT, { withFileTypes: true })) {
    fs.rmSync(path.join(OUT, f.name), { recursive: true, force: true })
  }
  fs.mkdirSync(OUT, { recursive: true })

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: REPO,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write('[electron] ' + d))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (/wechat|screenshot|Error/i.test(s)) process.stderr.write('[electron:err] ' + s)
  })

  const ver = await waitForCdp(PORT)
  log('CDP ready:', ver.Browser)

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().startsWith('file://')) || ctx.pages()[0]
  if (!page) throw new Error('找不到渲染页')

  const report = { steps: [], shots: [], probe: {} }
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')

  const forceState = async (selector, pseudoClasses) => {
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId) return false
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudoClasses })
      return true
    } catch (e) {
      log('forceState failed', selector, e.message)
      return false
    }
  }

  await page.evaluate(HELPERS)
  await page.waitForSelector('button', { timeout: 60000 })
  await sleep(4000)

  // ── 1) 进入「聊天会话」 ──
  const navClicked = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '聊天会话')
    if (!b) return false
    b.click()
    return true
  })
  if (!navClicked) throw new Error('点不到「聊天会话」')
  report.steps.push('进入 聊天会话')
  await sleep(6000)
  await page.screenshot({ path: path.join(OUT, '01-panel-chats.png') })
  report.shots.push('01-panel-chats.png')

  report.probe.panelColumns = await page.evaluate(() => {
    const { find, rect } = window.__a
    return { panel: rect(find('panel')), sidebar: rect(find('sidebar')), msgArea: rect(find('msgArea')) }
  })

  // ── 2) 选样本群 ──
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('button[title]'))
    .map((b) => (b.getAttribute('title') || '').split('\n')[0])
    .filter((n, i, a) => n && a.indexOf(n) === i))
  const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('button[title]'))
    .filter((b) => (b.getAttribute('title') || '').includes('@chatroom'))
    .map((b) => (b.getAttribute('title') || '').split('\n')[0]))
  const ordered = [...PREFERRED.filter((n) => candidates.includes(n)), ...candidates.filter((n) => !PREFERRED.includes(n))].slice(0, 8)
  log('candidates:', ordered.length)
  report.probe.candidateGroups = ordered

  const openGroup = async (name) => {
    const ok = await page.evaluate((n) => {
      const b = Array.from(document.querySelectorAll('button[title]')).find((x) => (x.getAttribute('title') || '').split('\n')[0] === n)
      if (!b) return false
      b.click()
      return true
    }, name)
    if (!ok) return false
    await sleep(2600)
    const hasInfo = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === '群聊信息' || (x.textContent || '').trim() === '群信息')
      if (!b) return false
      b.click()
      return true
    })
    if (!hasInfo) return false
    await sleep(3800)
    return true
  }

  let best = null
  for (const name of ordered) {
    if (!(await openGroup(name))) continue
    const stat = await page.evaluate(() => ({
      tiles: window.__a.all('memberTile').length,
      hasAdd: !!window.__a.find('memberAdd'),
      moreText: (window.__a.find('memberMore') || {}).textContent?.trim() || null,
      hasAnnounce: !!Array.from(document.querySelectorAll('*')).find((e) => (e.textContent || '').trim() === '群公告' && e.children.length === 0),
    }))
    log('group', name, '→', JSON.stringify(stat))
    if (!best || stat.tiles > best.stat.tiles) best = { name, stat }
    await page.evaluate(() => { const b = window.__a.find('groupInfoClose'); b && b.click() })
    await sleep(1000)
  }
  if (!best) throw new Error('没能打开任何群聊信息抽屉')
  log('chosen:', best.name, JSON.stringify(best.stat))
  report.probe.sample = best
  report.steps.push(`样本群：${best.name}（成员格子 ${best.stat.tiles}，全部群 ${groups.length} 个）`)

  if (!(await openGroup(best.name))) throw new Error('重开样本群失败')
  await page.screenshot({ path: path.join(OUT, '03-groupinfo-dark.png') })
  report.shots.push('03-groupinfo-dark.png')

  // ── 3) 计算样式 ──
  report.styles = await page.evaluate((props) => {
    const { find, dump, all } = window.__a
    const search = find('memberSearchBox')
    const grid = find('memberGrid')
    const tile = all('memberTile')[0]
    return {
      drawer: dump('drawer', find('groupInfo'), props),
      header: dump('header', find('groupInfoHeader'), props),
      title: dump('title', find('groupInfoTitle'), props),
      close: dump('close', find('groupInfoClose'), props),
      body: dump('body', find('groupInfoBody'), props),
      searchBox: dump('searchBox', search, props),
      searchInput: dump('searchInput', search ? search.querySelector('input') : null, props),
      searchIconWrap: dump('searchIcon', search ? search.querySelector('div,span') : null, props),
      searchIconSvg: dump('searchIconSvg', search ? search.querySelector('svg') : null, props),
      memberGrid: dump('memberGrid', grid, props),
      memberTile: dump('memberTile', tile, props),
      memberAvatarImg: dump('avatarImg', tile ? tile.querySelector('img') : null, props),
      memberAvatarFallback: dump('avatarFallback', tile ? tile.querySelector('div,span') : null, props),
      memberName: dump('memberName', find('memberName'), props),
      memberAdd: dump('memberAdd', find('memberAdd'), props),
      memberMore: dump('memberMore', find('memberMore'), props),
      section: dump('section', find('groupInfoSection'), props),
      label: dump('label', find('groupInfoLabel'), props),
      value: dump('value', find('groupInfoValue'), props),
      msgHeaderInfo: dump('msgHeaderInfo', find('msgHeaderInfo'), props),
      calBtn: dump('calBtn', find('calBtn'), props),
      tileCount: all('memberTile').length,
      tileHtml: tile ? tile.outerHTML.slice(0, 900) : null,
      closeHtml: (find('groupInfoClose') || {}).outerHTML || null,
      gridHtml: grid ? grid.outerHTML.slice(0, 500) : null,
      sectionHtml: (find('groupInfoSection') || {}).outerHTML || null,
      headerHtml: (find('groupInfoHeader') || {}).outerHTML || null,
      allClasses: Array.from(new Set(Array.from(document.querySelectorAll('[class]'))
        .flatMap((e) => Array.from(e.classList))
        .filter((c) => /groupInfo|member/i.test(c)))).slice(0, 40),
    }
  }, BOX)

  report.tokens = await page.evaluate(() => {
    const names = ['--nm-cyan','--nm-bg-card','--nm-bg-hover','--nm-bg-input','--nm-border','--nm-border-hover','--nm-text-1','--nm-text-2','--nm-bg','--nm-bg-panel','--nm-radius']
    const out = {}
    const pick = (el) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const o = {}
      for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) o[n] = v }
      return o
    }
    out.root = pick(document.documentElement)
    out.drawer = pick(window.__a.find('groupInfo'))
    out.header = pick(window.__a.find('groupInfoHeader'))
    out.tile = pick(window.__a.all('memberTile')[0])
    out.input = pick(window.__a.find('memberSearchBox'))
    return out
  })

  // ── 4) 交互态 ──
  const stylesOf = () => page.evaluate(() => {
    const { find, all } = window.__a
    const g = (el, ps) => { if (!el) return null; const cs = getComputedStyle(el); const o = {}; for (const p of ps) o[p] = cs.getPropertyValue(p); return o }
    const ps = ['background-color','color','border-color','border-style','box-shadow','transform','opacity','outline','outline-color','outline-style','outline-width','border-radius']
    const tile = all('memberTile')[0]
    return {
      tile: g(tile, ps),
      tileAdd: g(tile ? tile.querySelector('[class*="memberAdd"]') : null, ps),
      close: g(find('groupInfoClose'), ps),
      more: g(find('memberMore'), ps),
      input: g(find('memberSearchBox') ? find('memberSearchBox').querySelector('input') : null, ps),
    }
  })

  report.states = { baseline: await stylesOf() }

  const selOf = (d, suffix = '') => {
    if (!d || d.missing || !d.cls) return null
    const parts = String(d.cls).trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return null
    return '.' + parts.join('.') + suffix
  }
  const tileSel = selOf(report.styles.memberTile)
  const closeSel = selOf(report.styles.close)
  const moreSel = selOf(report.styles.memberMore)
  const inputSel = selOf(report.styles.searchBox, ' input')
  log('selectors:', JSON.stringify({ tileSel, closeSel, moreSel, inputSel }))

  const snap = async (name, sel, pseudo, shot) => {
    if (!sel) { report.states[name] = { skipped: true }; return }
    const ok = await forceState(sel, pseudo)
    await sleep(500)
    report.states[name] = ok ? await stylesOf() : { missing: sel }
    if (shot) { await page.screenshot({ path: path.join(OUT, shot) }); report.shots.push(shot) }
    await forceState(sel, [])
    await sleep(250)
  }

  await snap('tileHover', tileSel, ['hover'], '04-tile-hover.png')
  await snap('tileActive', tileSel, ['active'], null)
  await snap('tileFocusVisible', tileSel, ['focus', 'focus-visible'], '05-tile-focus.png')
  await snap('closeHover', closeSel, ['hover'], '06-close-hover.png')
  await snap('moreHover', moreSel, ['hover'], null)
  await snap('inputFocus', inputSel, ['focus', 'focus-visible'], '07-input-focus.png')

  report.a11y = await page.evaluate(() => {
    const drawer = window.__a.find('groupInfo')
    if (!drawer) return null
    const focusables = Array.from(drawer.querySelectorAll('button,input,[tabindex]'))
    return {
      focusableCount: focusables.length,
      names: focusables.slice(0, 8).map((e) => e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent || '').trim().slice(0, 12) || e.tagName),
      role: drawer.getAttribute('role'),
      ariaModal: drawer.getAttribute('aria-modal'),
      ariaLabel: drawer.getAttribute('aria-label'),
      closeAriaLabel: (window.__a.find('groupInfoClose') || {}).getAttribute?.('aria-label') || null,
      drawerTag: drawer.tagName,
      titleTag: (window.__a.find('groupInfoTitle') || {}).tagName,
    }
  })

  // ── 5) 响应式 ──
  report.responsive = []
  for (const [w, h] of [[1664, 1066], [1440, 900], [1280, 800], [1152, 720], [1024, 700]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(1100)
    const m = await page.evaluate(() => {
      const { find, rect, all } = window.__a
      const drawer = find('groupInfo')
      const grid = find('memberGrid')
      const body = find('groupInfoBody')
      const tile = all('memberTile')[0]
      const cs = grid ? getComputedStyle(grid) : null
      const name = find('memberName')
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        drawer: rect(drawer),
        bodyScrollH: body ? body.scrollHeight : null,
        bodyClientH: body ? body.clientHeight : null,
        grid: rect(grid),
        gridTemplate: cs ? cs.gridTemplateColumns : null,
        gap: cs ? cs.gap : null,
        tile: rect(tile),
        nameFS: name ? getComputedStyle(name).fontSize : null,
        nameLineH: name ? getComputedStyle(name).lineHeight : null,
        panelCols: { sidebar: rect(find('sidebar')), msgArea: rect(find('msgArea')) },
        docScrollW: document.documentElement.scrollWidth,
      }
    })
    report.responsive.push({ w, h, ...m })
    await page.screenshot({ path: path.join(OUT, `08-responsive-${w}x${h}.png`) })
    report.shots.push(`08-responsive-${w}x${h}.png`)
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(900)

  // ── 6) 搜索 ──
  const typeSearch = async (q) => page.evaluate((v) => {
    const el = window.__a.find('memberSearchBox')?.querySelector('input')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, q)

  await typeSearch('a')
  await sleep(1500)
  report.searchWithQuery = await page.evaluate(() => {
    const grid = window.__a.find('memberGrid')
    const g = grid ? getComputedStyle(grid) : null
    return {
      tiles: window.__a.all('memberTile').length,
      addTilePresent: !!window.__a.find('memberAdd'),
      morePresent: !!window.__a.find('memberMore'),
      gridTemplate: g ? g.gridTemplateColumns : null,
      gridHeight: grid ? grid.getBoundingClientRect().height : null,
      bodyText: (window.__a.find('groupInfoBody') || {}).textContent?.trim().slice(0, 160) || null,
    }
  })
  await page.screenshot({ path: path.join(OUT, '09-search-hit.png') })
  report.shots.push('09-search-hit.png')

  await typeSearch('zzzz-no-such-member-zzzz')
  await sleep(1500)
  report.searchEmpty = await page.evaluate(() => {
    const grid = window.__a.find('memberGrid')
    const body = window.__a.find('groupInfoBody')
    return {
      tiles: window.__a.all('memberTile').length,
      gridPresent: !!grid,
      gridHeight: grid ? grid.getBoundingClientRect().height : null,
      bodyText: body ? body.textContent.trim().slice(0, 200) : null,
      bodyHTML: body ? body.innerHTML.slice(0, 700) : null,
    }
  })
  await page.screenshot({ path: path.join(OUT, '10-search-empty.png') })
  report.shots.push('10-search-empty.png')
  await typeSearch('')
  await sleep(1000)

  // ── 7) 浅色主题 ──
  report.themeToggle = await page.evaluate(() => {
    const btn = document.querySelector('[data-theme-toggle]')
    if (!btn) return 'no-toggle'
    btn.click()
    return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark'
  })
  await sleep(1600)
  report.lightStyles = await page.evaluate((props) => {
    const { find, dump, all } = window.__a
    const search = find('memberSearchBox')
    return {
      htmlClass: document.documentElement.className,
      drawer: dump('drawer', find('groupInfo'), props),
      header: dump('header', find('groupInfoHeader'), props),
      title: dump('title', find('groupInfoTitle'), props),
      input: dump('input', search ? search.querySelector('input') : null, props),
      label: dump('label', find('groupInfoLabel'), props),
      value: dump('value', find('groupInfoValue'), props),
      name: dump('name', find('memberName'), props),
      tile: dump('tile', all('memberTile')[0], props),
      add: dump('add', find('memberAdd'), props),
    }
  }, BOX)
  await page.screenshot({ path: path.join(OUT, '11-groupinfo-light.png') })
  report.shots.push('11-groupinfo-light.png')

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  log('report.json written; shots:', report.shots.length)

  await browser.close()
  child.kill()
  await sleep(1500)
  process.exit(0)
}

main().catch(async (e) => {
  console.error('[audit] FAILED', e)
  try { fs.writeFileSync(path.join(OUT, 'FAILED.txt'), String(e && e.stack || e), 'utf8') } catch { /* ignore */ }
  process.exit(1)
})
