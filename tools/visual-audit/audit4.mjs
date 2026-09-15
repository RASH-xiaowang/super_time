/**
 * 聊天面板全层审计：会话列表 / 消息头部 / 消息流 / 群聊信息抽屉。
 * 起真实 Electron → CDP 驱动 → 采集计算样式、交互态、窄窗口溢出。
 * 只写 output/visual-audit-panel/（gitignored），不改仓库源码。
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
const OUT = path.join(REPO, 'output', 'visual-audit-panel')
const PORT = 9336
const ELECTRON = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
// 被审计的群名：原先硬编码了一个**真实群名**（提交到仓库等于泄漏用户数据），
// 现在从环境变量取，默认空 = 取聊天列表里的第一个群。
//   AUDIT_GROUP="群名" node tools/visual-audit/audit4.mjs
const GROUP = (process.env.AUDIT_GROUP || '').trim()

const log = (...a) => console.log('[audit]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForCdp(port, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json() } catch { /* not up */ }
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
  rect(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x:+r.x.toFixed(1), y:+r.y.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1) } },
  dump(label, el, props) {
    if (!el) return { label, missing: true }
    const cs = getComputedStyle(el)
    const o = { label, tag: el.tagName, cls: typeof el.className === 'string' ? el.className : String(el.className), rect: window.__a.rect(el) }
    for (const p of props) o[p] = cs.getPropertyValue(p)
    return o
  },
  states(s) {
    const ps = ['background-color','background-image','color','border-color','box-shadow','opacity','transform','outline','outline-offset','border-radius','cursor','-webkit-text-fill-color']
    const g = (el) => { if (!el) return null; const cs = getComputedStyle(el); const o = {}; for (const p of ps) o[p] = cs.getPropertyValue(p); return o }
    const el = window.__a.find(s)
    return el ? g(el) : null
  },
}
`

const BOX = ['width','height','padding','padding-left','padding-right','margin','border','border-top','border-left','border-radius',
  'background-color','background-image','color','font-size','font-weight','line-height','font-family','display','align-items','justify-content',
  'gap','flex-shrink','flex-wrap','overflow','overflow-y','scrollbar-width','text-overflow','white-space','opacity','transition','box-shadow',
  'backdrop-filter','position','min-height','box-sizing','text-align','cursor','-webkit-text-fill-color','letter-spacing','font-variant-numeric','outline','outline-offset']

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: REPO, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.stdout.write('[electron] ' + d))
  child.stderr.on('data', (d) => { const s = String(d); if (/wechat|Error/i.test(s)) process.stderr.write('[electron:err] ' + s) })

  const ver = await waitForCdp(PORT)
  log('CDP', ver.Browser)
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => p.url().startsWith('file://')) || ctx.pages()[0]
  if (!page) throw new Error('找不到渲染页')

  const report = { steps: [], shots: [] }
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  const forceState = async (selector, pseudo) => {
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId) return false
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo })
      return true
    } catch { return false }
  }

  await page.evaluate(HELPERS)
  await page.waitForSelector('button', { timeout: 60000 })
  await sleep(4000)
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '聊天会话')
    b && b.click()
  })
  await sleep(6000)

  // 打开样本群 + 群信息抽屉
  await page.evaluate((n) => {
    const buttons = Array.from(document.querySelectorAll('button[title]'))
    const b = n
      ? buttons.find((x) => (x.getAttribute('title') || '').split('\n')[0] === n)
      // 未指定 AUDIT_GROUP 时取会话列表里的第一个（脚本原先硬编码了一个真实群名）
      : buttons[0]
    b && b.click()
  }, GROUP)
  await sleep(3000)
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === '群聊信息' || (x.textContent || '').trim() === '群信息')
    b && b.click()
  })
  await sleep(4000)
  report.steps.push(`打开 ${GROUP} + 群信息抽屉`)

  await page.screenshot({ path: path.join(OUT, 'p01-full-dark.png') })
  report.shots.push('p01-full-dark.png')

  // ── 1) 三层列布局对齐 ──
  report.layout = await page.evaluate((props) => {
    const { find, rect, dump } = window.__a
    return {
      rail: rect(find('rail') || find('navRail') || find('sidebar')),
      list: rect(find('list')),
      sessionItem0: rect(window.__a.all('sessionItem')[0]),
      msgArea: rect(find('msgArea') || find('msgBody')) ,
      msgHeader: rect(find('msgHeader')),
      drawer: rect(find('groupInfo')),
      listDump: dump('list', find('list'), props),
    }
  }, BOX)

  // ── 2) 会话列表项 ──
  report.session = await page.evaluate((props) => {
    const { find, all, dump } = window.__a
    const item = all('sessionItem')[0]
    return {
      item: dump('sessionItem', item, props),
      name: dump('sessionName', find('sessionName'), props),
      time: dump('sessionTime', find('sessionTime'), props),
      summary: dump('sessionSummary', find('sessionSummary'), props),
      unread: dump('unread', find('unread'), props),
      pinMark: dump('pinMark', find('pinMark'), props),
      avatar: dump('avatar', item ? item.querySelector('[class*="avatar"]') : null, props),
      itemCount: all('sessionItem').length,
      itemHtml: item ? item.outerHTML.slice(0, 700) : null,
    }
  }, BOX)

  // ── 3) 消息头部 ──
  report.header = await page.evaluate((props) => {
    const { find, dump, rect } = window.__a
    const actions = find('msgHeaderActions')
    const btns = actions ? Array.from(actions.querySelectorAll('button')) : []
    const ar = rect(actions)
    return {
      header: dump('msgHeader', find('msgHeader'), props),
      name: dump('msgHeaderName', find('msgHeaderName'), props),
      user: dump('msgHeaderUser', find('msgHeaderUser'), props),
      actions: dump('msgHeaderActions', actions, props),
      actionsScrollW: actions ? actions.scrollWidth : null,
      actionsClientW: actions ? actions.clientWidth : null,
      btnCount: btns.length,
      btnRects: btns.map((b) => ({ t: (b.textContent || '').trim(), ...rect(b), disabled: b.disabled })),
      chip: dump('msgTypeChip', find('msgTypeChip'), props),
    }
  }, BOX)

  // ── 4) 头像圆角三处对照 ──
  report.avatarConsistency = await page.evaluate(() => {
    const rad = (el) => { if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return { radius: cs.borderRadius, w: +r.width.toFixed(1), h: +r.height.toFixed(1) } }
    const inList = window.__a.all('sessionItem')[0]
    const inMsg = window.__a.find('msgRow')
    const inDrawer = window.__a.all('memberTile')[0]
    return {
      sessionList: rad(inList ? inList.querySelector('[class*="avatar"]') : null),
      messageRow: rad(inMsg ? inMsg.querySelector('[class*="avatar"]') : null),
      drawerMember: rad(inDrawer ? inDrawer.querySelector('[class*="avatar"]') : null),
      drawerAddTile: rad(window.__a.find('memberAdd')),
    }
  })

  // ── 5) 交互态 ──
  const selOf = (el) => {
    const c = window.__a.find(el)
    return c
  }
  const clsToSel = async (name) => page.evaluate((n) => {
    const el = window.__a.find(n)
    if (!el || !el.className) return null
    const parts = String(el.className).trim().split(/\s+/).filter(Boolean)
    return parts.length ? '.' + parts.join('.') : null
  }, name)

  const statesOf = () => page.evaluate(() => {
    const st = (s) => {
      const el = window.__a.find(s)
      if (!el) return null
      const cs = getComputedStyle(el)
      const out = {}
      for (const p of ['background-color','background-image','color','border-color','box-shadow','opacity','transform','outline','outline-offset','-webkit-text-fill-color']) out[p] = cs.getPropertyValue(p)
      return out
    }
    return { sessionItem: st('sessionItem'), calBtn: st('calBtn'), unread: st('unread') }
  })

  report.states = { baseline: await statesOf() }
  const snap = async (label, name, pseudo, shot) => {
    const sel = await clsToSel(name)
    if (!sel) { report.states[label] = { skipped: name }; return }
    const ok = await forceState(sel, pseudo)
    await sleep(450)
    report.states[label] = ok ? await statesOf() : { missing: sel }
    if (shot) { await page.screenshot({ path: path.join(OUT, shot) }); report.shots.push(shot) }
    await forceState(sel, [])
    await sleep(200)
  }
  await snap('sessionHover', 'sessionItem', ['hover'], 'p02-session-hover.png')
  await snap('sessionFocusVisible', 'sessionItem', ['focus', 'focus-visible'], 'p03-session-focus.png')
  await snap('calBtnHover', 'calBtn', ['hover'], 'p04-header-btn-hover.png')
  await snap('calBtnActive', 'calBtn', ['active'], null)

  // 禁用态：真实置 disabled 后读样式
  report.disabledBtn = await page.evaluate(() => {
    const b = Array.from(window.__a.find('msgHeaderActions').querySelectorAll('button')).find((x) => x.disabled)
      || window.__a.find('msgHeaderActions').querySelector('button')
    const before = getComputedStyle(b).opacity
    const wasDisabled = b.disabled
    b.disabled = true
    const cs = getComputedStyle(b)
    const after = { opacity: cs.opacity, cursor: cs.cursor, color: cs.color, background: cs.backgroundColor, borderColor: cs.borderColor }
    b.disabled = wasDisabled
    return { text: (b.textContent || '').trim(), wasDisabled, before, after }
  })

  // ── 6) 窄窗口下的溢出 ──
  report.responsive = []
  for (const [w, h] of [[1664, 1066], [1440, 900], [1280, 800], [1152, 720], [1024, 700], [960, 640]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(1100)
    const m = await page.evaluate(() => {
      const { find, rect, all } = window.__a
      const header = find('msgHeader'), actions = find('msgHeaderActions'), body = find('msgBody')
      const drawer = find('groupInfo'), list = find('list'), item = all('sessionItem')[0]
      const hr = rect(header), ar = rect(actions)
      const btns = actions ? Array.from(actions.querySelectorAll('button')) : []
      const clipped = btns.filter((b) => {
        const r = b.getBoundingClientRect()
        return r.right > hr.x + hr.w + 0.5
      }).map((b) => (b.textContent || '').trim())
      const grid = find('memberGrid')
      const tile = all('memberTile')[0]
      const tileR = tile ? tile.getBoundingClientRect() : null
      const av = tile ? tile.querySelector('[class*="avatar"]') : null
      const avR = av ? av.getBoundingClientRect() : null
      const name = find('memberName')
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        list: rect(list), sessionItem0: rect(item),
        msgHeader: hr, msgBody: rect(body),
        bubbleRows: all('msgRow').length,
        actions: ar, actionsScrollW: actions ? actions.scrollWidth : null, actionsClientW: actions ? actions.clientWidth : null,
        btnRects: btns.map((b) => ({ t: (b.textContent || '').trim(), x: +b.getBoundingClientRect().x.toFixed(1), right: +b.getBoundingClientRect().right.toFixed(1) })),
        clippedButtons: clipped,
        headerOverflow: header ? getComputedStyle(header).overflow : null,
        grid: rect(grid),
        gridTemplate: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        tile: tileR ? { w: +tileR.width.toFixed(1), h: +tileR.height.toFixed(1) } : null,
        avatar: avR ? { w: +avR.width.toFixed(1), overflowOfTile: +(avR.width - tileR.width).toFixed(1) } : null,
        nameFS: name ? getComputedStyle(name).fontSize : null,
        nameScrollW: name ? name.scrollWidth : null,
        nameClientW: name ? name.clientWidth : null,
        drawer: rect(drawer),
        docScrollW: document.documentElement.scrollWidth,
        bodyOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      }
    })
    report.responsive.push({ w, h, ...m })
    await page.screenshot({ path: path.join(OUT, `p05-${w}x${h}.png`) })
    report.shots.push(`p05-${w}x${h}.png`)
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await sleep(900)

  // ── 7) 浅色主题下的会话列表 / 头部 / 抽屉 ──
  report.themeToggle = await page.evaluate(() => {
    const btn = document.querySelector('[data-theme-toggle]')
    if (!btn) return 'no-toggle'
    btn.click()
    return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark'
  })
  await sleep(1700)
  report.light = await page.evaluate((props) => {
    const { find, all, dump } = window.__a
    const item = all('sessionItem')[0]
    return {
      htmlClass: document.documentElement.className,
      sessionItem: dump('sessionItem', item, props),
      sessionName: dump('sessionName', find('sessionName'), props),
      sessionTime: dump('sessionTime', find('sessionTime'), props),
      sessionSummary: dump('sessionSummary', find('sessionSummary'), props),
      unread: dump('unread', find('unread'), props),
      msgHeaderName: dump('msgHeaderName', find('msgHeaderName'), props),
      msgHeaderUser: dump('msgHeaderUser', find('msgHeaderUser'), props),
      calBtn: dump('calBtn', find('calBtn'), props),
      drawer: dump('drawer', find('groupInfo'), props),
      drawerTitle: dump('title', find('groupInfoTitle'), props),
      searchInput: dump('searchInput', (find('memberSearchBox') || {}).querySelector ? find('memberSearchBox').querySelector('input') : null, props),
      memberName: dump('name', find('memberName'), props),
      msgBubbleOther: dump('bubbleOther', all('msgBubble')[0], props),
      msgRowAvatar: dump('msgAvatar', find('msgRow') ? find('msgRow').querySelector('[class*="avatar"]') : null, props),
    }
  }, BOX)
  await page.screenshot({ path: path.join(OUT, 'p06-full-light.png') })
  report.shots.push('p06-full-light.png')

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  log('report written; shots:', report.shots.length)
  await browser.close()
  child.kill()
  await sleep(1500)
  process.exit(0)
}

main().catch((e) => { console.error('[audit] FAILED', e); try { fs.writeFileSync(path.join(OUT, 'FAILED.txt'), String(e && e.stack || e), 'utf8') } catch { /* ignore */ } process.exit(1) })
