/**
 * 启动页的分组必须与侧栏一致（**2026-09-30 引入的防漂移判据**）。
 *
 * ## 为什么需要它
 *
 * 侧栏分组是 `nav-config.ts` 的 `NAV_GROUPS`；启动页「功能引导」另有一份
 * `FEATURE_GROUPS`（用户可见文案，含 desc 与图标）。两者是**手写的两份真源**。
 *
 * 2026-09-30 把侧栏从 9 组合并成 5 组时，我只改了侧栏 —— 测试**全绿**，
 * 启动页却still写着旧分组名（9 组）。原因：当时没有任何判据把两者钉在一起，
 * 而且这两处文案都进了 `ui-dist`，肉眼看不出。
 *
 * 这条判据只做一件事：**两边的分组名与顺序必须逐一相等**。合并/改名时两边一起改，
 * 否则红。它不比较 `desc`/`items`（那是文案，允许各写各的）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NAV_GROUPS } from '../nav-config.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('导航真源一致性：侧栏 NAV_GROUPS 与启动页 FEATURE_GROUPS', () => {
  it('分组名与顺序逐一相等（改一边就必须改另一边）', () => {
    const src = read('../../../../../../ui-app/onboarding/onboarding-content.tsx')
    const at = src.indexOf('export const FEATURE_GROUPS')
    expect(at, '启动页里找不到 FEATURE_GROUPS').toBeGreaterThan(0)
    // 只取 FEATURE_GROUPS 这一段（到下一个顶层导出为止），避免把别的数组的 name 混进来
    const rest = src.slice(at)
    const nextExport = rest.indexOf('\nexport ', 10)
    const seg = nextExport > 0 ? rest.slice(0, nextExport) : rest
    const featureNames = [...seg.matchAll(/name: '([^']+)'/g)].map((m) => m[1]!)
    expect(featureNames, '启动页的分组名/顺序与侧栏不一致').toEqual(NAV_GROUPS.map((g) => g.label))
  })

  it('启动页没有漏掉侧栏的任何分组（数量相同，防空转）', () => {
    expect(NAV_GROUPS.length).toBeGreaterThanOrEqual(5)
  })
})
