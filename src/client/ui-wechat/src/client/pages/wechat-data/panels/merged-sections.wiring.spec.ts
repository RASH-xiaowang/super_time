/**
 * 合并组（`MergedSections`）的结构不变量。
 *
 * ── 为什么值得一条守卫 ────────────────────────────────────────────────────
 * 合并组是「多个可路由 tab 收进一个侧栏项」的机制：`nav-config.ts` 把被吸收的 tab 标
 * `hidden`，`renderTab` 用 `<MergedSections sections={[{key, label, render}]}>` 把它们
 * 挂成段条。这条链上有三处**不会报错**的断裂方式：
 *
 *  ① **分段 key 写错**（拼成 `kbFiles`、或引用一个早已改名的 tab）→ `sections.find`
 *     找不到就退回第一段，用户点深链 `#mediaassets` 会静默落在「文件资产」上；
 *  ② **同一组里 key 重复** → `find` 永远取到前一个，后一段不可达；
 *  ③ **注释里的组数**与实际差着数（历史实录：注释写「六组」「七组」，实际 8 组）。
 *
 * 所以这里从 `nav-config.ts` 取真源（`WechatTab` 联合），再要求每个分段 key 都在其中。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, readText, sliceBetween } from './wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const NAV = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'nav-config.ts')
const WDP = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx')
const KB_SHELL = join(HERE, 'KbShell.tsx')

const nav = readStripped(NAV)
const tabs = new Set(
  [...sliceBetween(nav, 'export type WechatTab =', 'export interface NavItem', 'WechatTab 联合')
    .matchAll(/'([a-z]+)'/g)].map((m) => m[1] ?? ''),
)

/** 某个文件里所有 `{ key: 'x', label: … }` 形式的分段（段条项的写法）。 */
function sectionKeys(file: string): string[] {
  return [...readStripped(file).matchAll(/\{ key: '([a-z]+)', label:/g)].map((m) => m[1] ?? '')
}

const wdpKeys = sectionKeys(WDP)
const kbKeys = sectionKeys(KB_SHELL)
const allKeys = [...wdpKeys, ...kbKeys]

describe('合并组 · 分段 key 必须是真实可路由的 tab', () => {
  it('真源可解析（防空转）', () => {
    atLeast(tabs.size, 30, 'WechatTab 的成员数')
    atLeast(allKeys.length, 14, '合并组的分段数（低于下限说明扫描失效）')
  })

  it('每个分段 key 都在 WechatTab 里（写错会静默落回第一段）', () => {
    const bad = allKeys.filter((k) => !tabs.has(k))
    expect(bad, `这些分段 key 不是可路由的 tab（深链会静默落回第一段）：${bad.join(', ')}`).toEqual([])
  })

  it('同一组内 key 不重复（重复会让后一段不可达）', () => {
    // 每组的分段在源码里是连续的一段，所以按「相邻出现」判重足够：
    // 真重复（同组内相邻两次同 key）才是缺陷，跨两组同 key 不可能（tab 唯一）。
    const dup: string[] = []
    for (let i = 1; i < allKeys.length; i++) {
      if (allKeys[i] === allKeys[i - 1]) dup.push(allKeys[i] ?? '')
    }
    expect(dup, `同一组里出现重复的分段 key：${dup.join(', ')}`).toEqual([])
  })
})

describe('合并组 · 注释里的组数要与代码一致', () => {
  it('「共 N 组」的 N == 两处 <MergedSections 的出现次数之和', () => {
    // ⚠️ 计数必须用**剥注释**的文本：`WechatDataPanel.tsx` 的一句提示注释里
    // 就写着 `grep -c "<MergedSections"`，用原文数会把那句话也算成一次（实测 8 → 9）。
    const n = [...readStripped(WDP).matchAll(/<MergedSections/g)].length
      + [...readStripped(KB_SHELL).matchAll(/<MergedSections/g)].length
    atLeast(n, 5, '合并组总数')

    // 而「共 N 组」这句本身就在注释里，所以这一侧要用**原文**读。
    const stated = /共 (\d+) 组/.exec(readText(WDP))?.[1]
    expect(stated, 'WechatDataPanel 里找不到「共 N 组」这句 —— 组数注释放哪了？').toBeTruthy()
    expect(stated, `注释写「共 ${stated} 组」，实际 ${n} 组（历史上这里写过「六组」，差两组）`).toBe(String(n))
  })
})
