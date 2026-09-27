/**
 * 文档一致性：把散落各处的**手写计数**绑到真源上。
 *
 * ── 为什么值得一条守卫 ────────────────────────────────────────────────────
 * 这个仓库的数字曾经四处漂移，而且是**互相加剧**的：
 *   · `docs/API.md` 自动生成（真源），但 `src/client/README.md` 手写 158、
 *     `docs/KB-COMPLETION-PLAN.md` 手写 150、`gateway-core.ts` 注释写 161、
 *     `OnboardingShell.tsx` 又写 172 —— 四个数字，没人知道哪个对；
 *   · `docs/KB-MODEL-CONFIG.md` 甚至把"README 那行是过期的 150"当成了当前事实记录下来；
 *   · 页面结构同理：`WechatDataPanel.tsx` 的头注释写「8 组 / 32 页签」，
 *     而 `nav-config.ts` 里是 9 组 / 37 页签。
 * 这些数字是下游读者的**唯一线索**，所以本守卫的做法是——**不钉死任何数字**，
 * 而是每次从真源现算，再要求每一处手写值与真源相等。接口/导航一变，
 * 所有需要跟着改的地方会一起转红，而不是等下一个人读到时才发现。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const read = (...p: string[]): string => readText(join(ROOT, ...p))

const NAV = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts']
const WDP = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx']
const SHELL = ['src', 'client', 'ui-app', 'onboarding', 'OnboardingShell.tsx']
const README = ['src', 'client', 'README.md']
const API_MD = ['docs', 'API.md']
const KB_PLAN = ['docs', 'KB-COMPLETION-PLAN.md']
const BK_README = ['src', 'backend', 'wechat-data', 'README.md']

describe('远端接口计数：docs/API.md 是唯一真源', () => {
  const apiMd = read(...API_MD)
  const m = /当前共 \*\*(\d+)\*\* 个 Remote 方法/.exec(apiMd)
  const nRemote = Number(m?.[1] ?? 0)

  it('真源本身可解析（防空转）', () => {
    atLeast(nRemote, 100, 'docs/API.md 里的 Remote 数')
  })

  it('每个手写计数都等于 docs/API.md 的数字', () => {
    // OnboardingShell 的 TELEMETRY 卡（用户可见的契约声明）
    const shellVal = /k: 'REMOTE API', v: '(\d+)'/.exec(readStripped(join(ROOT, ...SHELL)))?.[1]
    expect(shellVal, `OnboardingShell 的 REMOTE API 计数与 docs/API.md（${nRemote}）不一致`).toBe(String(nRemote))

    // 前端 README 的头行
    const readmeVal = /(\d+) 个 Remote 方法/.exec(read(...README))?.[1]
    expect(readmeVal, `src/client/README.md 的 Remote 计数与 docs/API.md（${nRemote}）不一致`).toBe(String(nRemote))

    // KB 完成计划里的计数契约那一条
    const kbVal = /Remote \*\*(\d+)\*\*/.exec(read(...KB_PLAN))?.[1]
    expect(kbVal, `docs/KB-COMPLETION-PLAN.md 的 Remote 计数与 docs/API.md（${nRemote}）不一致`).toBe(String(nRemote))

    // 后端 README 的概览句
    const bkVal = /（当前 (\d+) 个）/.exec(read(...BK_README))?.[1]
    expect(bkVal, `src/backend/wechat-data/README.md 的 Remote 计数与 docs/API.md（${nRemote}）不一致`).toBe(String(nRemote))
  })

  it('源码注释里的计数也要对（注释是下一轮读者的入口）', () => {
    const gc = read('src', 'backend', 'wechat-data', 'src', 'gateway-core.ts')
    const gcVal = /(\d+) 个 `@Remote` 方法/.exec(gc)?.[1]
    expect(gcVal, `gateway-core.ts 头注的计数与 docs/API.md（${nRemote}）不一致`).toBe(String(nRemote))

    const kb = read('src', 'backend', 'wechat-data', 'src', 'remotes', 'kb.ts')
    const kbSrcVal = /(\d+) 个 `@Remote` 方法的巨型类/.exec(kb)?.[1]
    expect(kbSrcVal, `remotes/kb.ts 头注的计数与 docs/API.md（${nRemote}）不一致`).toBe(String(nRemote))
  })
})

describe('导航计数：nav-config.ts 是唯一真源', () => {
  const nav = readStripped(join(ROOT, ...NAV))

  /** `WechatTab` 联合的成员数 = 可路由页签总数。 */
  const union = sliceBetween(nav, 'export type WechatTab =', 'export interface NavItem', 'WechatTab 联合')
  const tabs = [...union.matchAll(/'([a-z]+)'/g)].map((x) => x[1] ?? '')

  /** `hidden: true` 的条目数（可路由但不进侧栏）。 */
  const nHidden = [...nav.matchAll(/hidden: true/g)].length

  /** 侧栏**体**里渲染的入口数 = 总数 − 隐藏 − `settings`（它渲染在底栏专属按钮上）。 */
  const visibleInBody = tabs.length - nHidden - 1

  /** `NAV_GROUPS` 顶层的分组（`label` 后紧跟 `items: [`）。 */
  const groups = [...nav.matchAll(/^ {4}label: '([^']+)',\n {4}items: \[/gm)].map((x) => x[1] ?? '')

  it('真源可解析（防空转）', () => {
    atLeast(tabs.length, 30, 'WechatTab 联合成员数')
    atLeast(groups.length, 5, 'NAV_GROUPS 的分组数')
  })

  it('页签与侧栏可见数与真源一致', () => {
    const shell = readStripped(join(ROOT, ...SHELL))
    const shellModules = /k: 'MODULES', v: '(\d+)'/.exec(shell)?.[1]
    expect(shellModules, `OnboardingShell 的 MODULES ${shellModules} ≠ 真源算出的侧栏可见数 ${visibleInBody}`)
      .toBe(String(visibleInBody))

    const wdp = read(...WDP) // 用 readText：这段是块注释，剥了注释就什么都没了
    const wdpTabs = /\*\*(\d+)\*\*（其余 (\d+) 项/.exec(wdp)
    expect(wdpTabs?.[1], `WechatDataPanel 头注的页签数 ≠ 真源 ${tabs.length}`).toBe(String(tabs.length))
    expect(wdpTabs?.[2], `WechatDataPanel 头注的隐藏项数 ≠ 真源 ${nHidden}`).toBe(String(nHidden))
  })

  it('分组数一致（README 与主容器头注都写了它）', () => {
    const readmeGroups = /侧栏按 (\d+) 个分组组织/.exec(read(...README))?.[1]
    expect(readmeGroups, `src/client/README.md 的分组数 ≠ 真源 ${groups.length}`).toBe(String(groups.length))

    const wdpGroups = /\*\*(\d+) 组\*\*/.exec(read(...WDP))?.[1]
    expect(wdpGroups, `WechatDataPanel 头注的分组数 ≠ 真源 ${groups.length}`).toBe(String(groups.length))
  })
})
