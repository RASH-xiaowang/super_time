/**
 * ClawBot 面板接线守卫（侧栏条目 + 主容器注册 + 解绑文案）。
 *
 * 计数（17/38）与导航真源的**全面**对齐由 `docs-consistency.wiring.spec.ts` 守；
 * 这里守的是这一条新入口本身接上了没有——它是最典型的静默失效点：
 * 导航里加了条目但主容器没有 `case`，界面就是一块「正在重构中」的占位。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoot, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const ROOT = findRoot(import.meta.dirname)
const read = (...p: string[]): string => readText(join(ROOT, ...p))

const NAV = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts']
const WDP = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx']

describe('ClawBot 导航与面板注册', () => {
  it('nav-config：clawbot 条目存在、可见、图标是 filled(<path d=…>)', () => {
    const nav = read(...NAV)
    const line = nav.split('\n').find((l) => l.includes("tab: 'clawbot'"))
    expect(line, 'nav-config 里没有 clawbot 条目').toBeTruthy()
    expect(line, 'clawbot 不该是 hidden（它要有自己的侧栏入口）').not.toContain('hidden')
    expect(line, '图标必须包 filled() 且写 <path d="…"/>（裸 path 数据会静默空白）').toMatch(/filled\('<path [^>]*d="/)
    // 2026-10-17：侧栏显示名是「ClawBot集群」（它管的是多个实例，叫「ClawBot」会让人以为只有一个号）。
    expect(line, '侧栏显示名不是「ClawBot集群」（改名被回退了？）').toContain("label: 'ClawBot集群'")
    // 挂在「行动与维护」分组里
    const group = sliceBetween(nav, "label: '行动与维护'", "],\n  },", '行动与维护分组')
    expect(group, 'clawbot 不在「行动与维护」分组里').toContain("tab: 'clawbot'")
  })

  it('WechatTab 联合收录 clawbot（否则深链与类型都对不上）', () => {
    const nav = readStripped(join(ROOT, ...NAV))
    const union = sliceBetween(nav, 'export type WechatTab =', 'export interface NavItem', 'WechatTab 联合')
    expect(union).toContain("'clawbot'")
    // 计数：总数 39 / hidden 23 / 侧栏可见 15（与 docs-consistency 的真源算法一致）
    // ⚠️ 2026-10-17：hidden 20 → 23（朋友圈洞察 / 通话记录 / 隐私体检 三块并入别的入口），
    // 侧栏可见 17 → 14；2026-10-19：新增「任务信息」可见入口（14 → 15、页签 38 → 39）。
    const tabs = [...union.matchAll(/'([a-z]+)'/g)].map((x) => x[1] ?? '')
    const nHidden = [...nav.matchAll(/hidden: true/g)].length
    expect(tabs.length, `可路由页签应为 39，实测 ${String(tabs.length)}`).toBe(39)
    expect(nHidden, `hidden 项应为 23，实测 ${String(nHidden)}`).toBe(23)
    expect(tabs.length - nHidden - 1, '侧栏可见项应为 15').toBe(15)
  })

  it('主容器注册了 clawbot → ClawBotPanel（没有 case 的话界面只剩占位）', () => {
    const wdp = read(...WDP)
    expect(wdp).toContain("import {\n  AnnualPanel,")
    expect(wdp).toContain("ClawBotPanel,\n")
    expect(wdp).toContain("} from './panel-loaders.tsx'")
    expect(wdp).toMatch(/case 'clawbot': return <ClawBotPanel \/>/)
  })

  it('解绑确认的措辞与 D-4 一致（接入会话不会被删除）', () => {
    const settings = read('src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'clawbot-settings.tsx')
    expect(settings, '解绑弹窗必须写明会话保留').toContain('接入会话不会被删除')
  })
})
