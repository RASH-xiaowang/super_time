/**
 * H14：隐私同意判定与接线守卫。
 *
 * 要守住的不变量是「**未同意就不放行**」，而它的失败方向很危险：
 * 任何解析失败、版本比对写错、或者接线漏掉，都会让用户**没看到声明就进了主界面**。
 * 所以这里既测纯逻辑（含各种畸形输入），也用 AST 断言接线（注释里留个字符串骗不过去，
 * 见 M12 / N19 的教训）。
 *
 * 能守什么、守不住什么：
 *   · 守得住：判定逻辑、「ui-entry 里真的挂了闸门且自动进主界面的条件含 consented」；
 *   · 守不住：真实 Electron 里首次启动的观感（勾选框、按钮）—— 仓库没有组件测试环境。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  PRIVACY_STORAGE_KEY,
  PRIVACY_VERSION,
  acceptConsent,
  loadConsentRecord,
  needsConsent,
  parseConsent,
  resetConsent,
} from './consent.ts'
import type { ConsentKv } from './consent.ts'

// 仓库根：spec 在 src/client/ui-app/privacy/ 下，要上溯 4 层才到仓库根
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const entrySrc = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'ui-entry.tsx'), 'utf8')

/** 内存版 KV，并记录调用（用来断言「真的写了」而不是「看起来写了」）。 */
function fakeKv(initial: Record<string, string> = {}): ConsentKv & { store: Map<string, string>; removed: string[] } {
  const store = new Map(Object.entries(initial))
  const removed: string[] = []
  return {
    store,
    removed,
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k); removed.push(k) },
  }
}

describe('H14：隐私同意状态', () => {
  it('parseConsent 对畸形输入一律返回 null（失败方向是「再问一次」）', () => {
    expect(parseConsent(null)).toBeNull()
    expect(parseConsent('')).toBeNull()
    expect(parseConsent('不是 JSON')).toBeNull()
    expect(parseConsent('{}')).toBeNull()
    expect(parseConsent('{"version":1}')).toBeNull()
    expect(parseConsent('{"acceptedAt":"2026-09-15T00:00:00.000Z"}')).toBeNull()
    expect(parseConsent('{"version":0,"acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":-1,"acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":1.5,"acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":"1","acceptedAt":"x"}')).toBeNull()
    expect(parseConsent('{"version":1,"acceptedAt":""}')).toBeNull()
    expect(parseConsent('{"version":1,"acceptedAt":"2026-09-15T00:00:00.000Z"}'))
      .toEqual({ version: 1, acceptedAt: '2026-09-15T00:00:00.000Z' })
  })

  it('needsConsent：无记录要问、同版本不问、旧版本要重问、未来版本不问', () => {
    const rec = { version: PRIVACY_VERSION, acceptedAt: '2026-09-15T00:00:00.000Z' }
    expect(needsConsent(null)).toBe(true)
    expect(needsConsent(rec)).toBe(false)
    expect(needsConsent({ ...rec, version: PRIVACY_VERSION - 1 })).toBe(true)
    // 版本比当前高（例如用户降级安装）：已在更高版本上同意过，不重复打扰
    expect(needsConsent({ ...rec, version: PRIVACY_VERSION + 1 })).toBe(false)
    // 显式版本参数（将来提升 PRIVACY_VERSION 时，旧记录必须变成「需要重问」）
    expect(needsConsent({ ...rec, version: 1 }, 2)).toBe(true)
  })

  it('acceptConsent 写入版本与时间，并可被 loadConsentRecord 读回', () => {
    const kv = fakeKv()
    const at = new Date('2026-09-15T08:30:00.000Z')
    const rec = acceptConsent(() => at, kv)
    expect(rec).toEqual({ version: PRIVACY_VERSION, acceptedAt: '2026-09-15T08:30:00.000Z' })
    expect(kv.store.has(PRIVACY_STORAGE_KEY)).toBe(true)
    expect(loadConsentRecord(kv)).toEqual(rec)
    expect(needsConsent(loadConsentRecord(kv))).toBe(false)
  })

  it('resetConsent 清掉记录（清掉之后重新要求同意）', () => {
    const kv = fakeKv()
    acceptConsent(() => new Date('2026-09-15T08:30:00.000Z'), kv)
    resetConsent(kv)
    expect(kv.removed).toEqual([PRIVACY_STORAGE_KEY])
    expect(kv.store.has(PRIVACY_STORAGE_KEY)).toBe(false)
    expect(needsConsent(loadConsentRecord(kv))).toBe(true)
  })

  it('存储不可用/抛错时不抛，且当前会话仍视为已同意', () => {
    const boom: ConsentKv = {
      getItem: () => { throw new Error('no storage') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('no storage') },
    }
    expect(loadConsentRecord(boom)).toBeNull()
    expect(() => acceptConsent(() => new Date('2026-09-15T08:30:00.000Z'), boom)).not.toThrow()
    expect(acceptConsent(() => new Date('2026-09-15T08:30:00.000Z'), boom).version).toBe(PRIVACY_VERSION)
    expect(() => resetConsent(boom)).not.toThrow()
    // 读回仍然是 null（不落盘），所以下次启动会再问一次 —— 这是可接受的降级
    expect(loadConsentRecord(boom)).toBeNull()
  })
})

/** 在 TSX 里找某个 JSX 元素的节点（注释里的同名文本不算）。 */
function findJsxElement(src: string, tagName: string): boolean {
  const sf = ts.createSourceFile('ui-entry.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let hit = false
  const visit = (node: ts.Node): void => {
    if (hit) return
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sf) === tagName) { hit = true; return }
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return hit
}

/** 取出「函数体里调用了 openWechat() 的 if 语句」的条件源码文本（没有则返回 null）。 */
function autoOpenConditionText(src: string): string | null {
  const sf = ts.createSourceFile('ui-entry.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: string | null = null
  const bodyCallsOpen = (node: ts.Node): boolean => {
    let yes = false
    const walk = (n: ts.Node): void => {
      if (yes) return
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'openWechat') { yes = true; return }
      n.forEachChild(walk)
    }
    node.forEachChild(walk)
    return yes
  }
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isIfStatement(node) && node.expression && bodyCallsOpen(node.thenStatement)) {
      found = node.expression.getText(sf)
      return
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return found
}

describe('H14：同意闸门的接线', () => {
  it('ui-entry 真的渲染 PrivacyConsentGate（注释里的同名文本不算）', () => {
    expect(findJsxElement(entrySrc, 'PrivacyConsentGate')).toBe(true)
    // 反向确认解析有效：故意找一个不存在的组件名必须是 false
    expect(findJsxElement(entrySrc, 'NoSuchGateXyz')).toBe(false)
  })

  it('自动进入主界面的条件里必须包含 consented（否则同意闸门形同虚设）', () => {
    const cond = autoOpenConditionText(entrySrc)
    expect(cond, 'ui-entry 里找不到调用 openWechat() 的 if 语句').toBeTruthy()
    expect(cond!).toMatch(/consented/)
    expect(cond!).toMatch(/onboardingDone/)
    expect(cond!).toMatch(/isLicenseUsable/)
  })

  it('同意状态在未放行的分支里被消费（渲染分支含 !consented）', () => {
    // 只断言「变量被用于条件」不够 —— 必须有一个以它为前提的渲染分支。
    // 判据放宽成「条件里含 !consented 的 if 分支」而不是钉死 `if (!consented) {`：
    // 后者会在任何新增条件时误报（N2 的豁免变量 `!skipGates && !consented` 就撞上了），
    // 而它要守的东西是「存在这样一个分支」，不是「这个分支长什么样」。
    expect(entrySrc).toMatch(/if \([^)]*!consented\b[^)]*\)\s*\{/)
  })
})

/**
 * 同意区的**排版口径**：它必须是文档流里的一段，不是悬浮条。
 *
 * 为什么值得一条守卫：这一块的形态被改过两次（2026-09-29 改成吸底 → 2026-09-30 用户要求
 * 改回流内）。CSS 改错了没有任何构建或类型检查会报，症状是「勾选框与两个按钮变成压在正文上的
 * 浮条」——只有对着那一屏才看得见。这里直接把 `.consentBar` 的声明块切出来看，不看别的规则。
 */
describe('H14：同意区不许再做成悬浮 / 吸底', () => {
  const css = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'PrivacyConsentGate.module.css'), 'utf8')

  /** 取 `.consentBar { … }` 这一段（到第一个右花括号）。 */
  function consentBarBlock(): string {
    const at = css.indexOf('.consentBar {')
    expect(at, 'CSS 里找不到 .consentBar 规则').toBeGreaterThan(-1)
    const end = css.indexOf('}', at)
    return css.slice(at, end + 1)
  }

  it('`.consentBar` 不带 position: sticky / fixed，也不带遮挡用的 z-index 与不透明底色', () => {
    const block = consentBarBlock()
    expect(block, '.consentBar 又变成吸底 / 悬浮条了').not.toMatch(/position:\s*(sticky|fixed)/)
    expect(block, '.consentBar 带上了 z-index ⇒ 它会盖住正文').not.toMatch(/z-index/)
    expect(block, '.consentBar 又铺了不透明底色 ⇒ 那是悬浮层的样子').not.toMatch(/background(?!-color):/)
  })
})

/**
 * 2026-10-17 重设计：用户报「布局不合理，与其他启动页的字体大小不合适」。
 * 2026-10-19 微信化改版：版式从「两栏各自滚动」改成「单列单滚动 + 底部同意条常驻」。
 *
 * 四条不变量：
 *   ① **字号与启动页对齐**（标题 26 / 导语 13 / 正文 13 / 小字 11.5 / 标签 11）；
 *   ② **单列单滚动 + 底部同意条常驻**（整页只有一个滚动容器；同意条是文档流里的最后一格，
 *      不是 sticky/fixed 浮层，也不随正文滚走 —— 否则长声明会看不到勾选框）；
 *   ③ **页头交给 `StageHead`**（不再自己写一套 `.kicker / .title / .sub`）；
 *   ④ **不再自带背景**（它渲染在启动页外壳内部，两层背景叠在一起）。
 */
describe('H14：同意屏排版与启动页对齐（2026-10-17 重设计 / 2026-10-19 单列化）', () => {
  const css = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'PrivacyConsentGate.module.css'), 'utf8')
  const gateSrc = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'PrivacyConsentGate.tsx'), 'utf8')
  const shellSrc = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'onboarding', 'OnboardingShell.tsx'), 'utf8')
  const stagesCss = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'onboarding', 'onboarding-stages.module.css'), 'utf8')

  /** 取某个类名的声明块（到第一个右花括号）。 */
  function block(sel: string): string {
    const at = css.indexOf(`${sel} {`)
    expect(at, `CSS 里找不到 ${sel} 规则`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at) + 1)
  }

  it('① 正文字号与启动页一致（13px，不是 13.5 / 12.5）', () => {
    // 启动页的 .stageLead / .stepBody 都是 13px
    expect(stagesCss, '启动页导语基准变了，本判据要跟着改').toMatch(/\.stageLead\s*\{[^}]*font-size:\s*13px/)
    expect(block('.p'), '同意屏正文必须与启动页同刻度 13px').toMatch(/font-size:\s*13px/)
    expect(block('.p'), '同意屏正文不许再是 13.5px').not.toMatch(/font-size:\s*13\.5px/)
  })

  it('② 单列单滚动 + 底部同意条常驻（非 sticky/fixed）', () => {
    // 外壳是单列 flex 列，内容宽 760 上限（与启动页内容列同刻度）。
    const shell = block('.shell')
    expect(shell, '同意屏外壳必须是单列（flex column）').toMatch(/flex-direction:\s*column/)
    expect(shell, '内容列宽度上限必须与启动页一致（760px）').toMatch(/max-width:\s*760px/)

    // 整页只允许一个滚动容器：正文区自己滚，底部的同意条不动。
    // （旧版是两栏各自滚动，长卷问题解决了，但产生了两个滚动条；新口径是单列单滚动。）
    const scrollers = css.match(/overflow-y:\s*auto/g) ?? []
    expect(scrollers.length, '整页只允许一个滚动容器（单列单滚动）').toBe(1)
    const scroll = block('.scroll')
    expect(scroll, '滚动区必须能滚').toMatch(/overflow-y:\s*auto/)
    expect(scroll, '滚动区必须能收缩（否则内容把父级撑开，滚动永不触发）').toMatch(/min-height:\s*0/)
    expect(scroll, '滚动区必须吃掉页头与同意条之间的剩余高度').toMatch(/flex:\s*1 1 0/)

    // 反向：旧的两栏网格/列规则不许回潮（回潮 = 又出现两个滚动条 / 两截长卷）。
    expect(css, '两栏网格/列规则又回来了').not.toMatch(/\.(?:grid|col)\s*\{/)

    // 同意条是文档流里的最后一格：flex 子项 + 上方分隔线；不是浮层。
    const bar = block('.consentBar')
    expect(bar, '同意条必须是文档流里的 flex 子项（常驻底部，不随正文滚走）').toMatch(/flex:\s*0 0 auto/)
    expect(bar, '同意条不许变成 sticky / fixed 浮层').not.toMatch(/position:\s*(sticky|fixed)/)
    expect(bar, '同意条不许用 z-index 压住正文').not.toMatch(/z-index/)
    expect(bar, '同意条必须与正文用一条分隔线分开').toMatch(/border-top:\s*1px solid/)

    // DOM 顺序：滚动区之后才是同意条（否则勾选框会跟着正文滚走）。
    const scrollAt = gateSrc.indexOf('css.scroll')
    const barAt = gateSrc.indexOf('css.consentBar')
    expect(scrollAt, '组件里找不到滚动区（css.scroll）').toBeGreaterThan(-1)
    expect(barAt, '组件里找不到同意条（css.consentBar）').toBeGreaterThan(-1)
    expect(barAt, '同意条必须在滚动区之后渲染').toBeGreaterThan(scrollAt)
  })

  it('③ 页头交给 StageHead（不再自己写一套 kicker / title / sub）', () => {
    // ⚠️ 不能用 `onConsentStage[\s\S]{0,600}<StageHead`：`onConsentStage` 在文件里出现多次
    // （`const onConsentStage = page === CONSENT_STAGE` 在很前面），正则会从那里开始跨过整个文件。
    // 改成先切出 `{onConsentStage ? (` 那一段，再在段内找 `<StageHead`。
    const at = shellSrc.indexOf('{onConsentStage ? (')
    expect(at, '找不到同意站的分支').toBeGreaterThan(-1)
    const branch = shellSrc.slice(at, at + 1200)
    expect(branch, '同意站必须用统一的 StageHead').toContain('<StageHead')
    // ⚠️ 只断言「有 StageHead」咬不住「又加了一个自己的标题」的变异（M685 第一次没咬住）：
    // 必须同时断言**同意站分支里没有别的标题元素**。
    expect(branch, '同意站不许在 StageHead 之外再写一个标题').not.toMatch(/className=\{css\.pageTitle\}/)
    expect(branch, '同意站不许在 StageHead 之外再写一个 h1').not.toMatch(/<h1[\s>]/)
    expect(gateSrc, '同意屏不许再自己写页头').not.toMatch(/className=\{css\.title\}/)
    expect(gateSrc, '同意屏不许再自己写 kicker').not.toMatch(/className=\{css\.kicker\}/)
  })

  it('④ 不再自带背景（它渲染在启动页外壳内部，两层背景叠在一起）', () => {
    expect(block('.shell'), '同意屏外壳不许再画背景').not.toMatch(/background(?!-color):/)
  })
})
