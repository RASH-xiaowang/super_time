/**
 * 深链 hash 的**行为**判据：原型键不得被当成页签 / 设置落节。
 *
 * 旧写法 `key in TAB_LABELS` 会让 `#toString` / `#__proto__` / `#constructor` 命中
 * `Object.prototype`：`TAB_LABELS.toString` 是个函数，最终会被当 React child 渲染，
 * 整棵根树随之崩掉。这里同时钉住页签与设置弹窗两条深链路径。
 */
import { describe, expect, it } from 'vitest'
import {
  TAB_LABELS,
  hashKey,
  isWechatTab,
  ownValue,
  tabFromHash,
  tabLabelOf,
  type WechatTab,
} from './nav-config.ts'

/** 与 `WechatDataPanel` 里 `DIALOG_SECTION_OF` 同形的查找表（只用于口径验证）。 */
const DIALOG_SECTIONS: Record<string, string> = { settings: 'wechat', health: 'health', privacytrust: 'privacy' }

const PROTOTYPE_KEYS = ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf', 'prototype']

describe('深链原型键', () => {
  it('hashKey 只去掉一个前导 #', () => {
    expect(hashKey('#overview')).toBe('overview')
    expect(hashKey('overview')).toBe('overview')
    expect(hashKey('#')).toBe('')
  })

  it('原型键不是页签：tabFromHash 返回 null（不进入 state / 不渲染函数）', () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(tabFromHash(`#${key}`), `#${key} 被当成了页签`).toBeNull()
      expect(isWechatTab(key), `${key} 被 isWechatTab 放行`).toBe(false)
      expect(tabLabelOf(key), `${key} 的标题应当为空串`).toBe('')
    }
    // 证明「旧写法为什么危险」：原型上确实有函数值，只认自有属性才不会漏出去。
    expect(typeof (TAB_LABELS as unknown as Record<string, unknown>).toString).toBe('function')
  })

  it('真实页签（含 hidden）仍可深链，大小写与空 hash 落回 overview 由调用方兜底', () => {
    expect(tabFromHash('#overview')).toBe('overview')
    expect(tabFromHash('overview')).toBe('overview')
    expect(tabFromHash('#kbfiles')).toBe('kbfiles')
    expect(tabFromHash('#settings')).toBe('settings')
    expect(tabFromHash('#OVERVIEW')).toBeNull()
    expect(tabFromHash('')).toBeNull()
    expect(tabLabelOf('overview')).toBe(TAB_LABELS.overview)
  })

  it('设置落节同样只查自有属性：#toString 不打开设置', () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(ownValue<string>(DIALOG_SECTIONS, hashKey(`#${key}`)), `#${key} 被当成了设置落节`).toBeUndefined()
    }
    expect(ownValue<string>(DIALOG_SECTIONS, hashKey('#settings'))).toBe('wechat')
    expect(ownValue<string>(DIALOG_SECTIONS, hashKey('#health'))).toBe('health')
  })

  it('非法深链的展示标题是空串，可以直接放进 JSX（不会出现函数 child）', () => {
    const labels: string[] = PROTOTYPE_KEYS.map((key) => tabLabelOf(key))
    expect(labels.every((label) => typeof label === 'string' && label === '')).toBe(true)
    // 类型层面也应是 string；这里排除 any 把函数偷渡进 children 的可能。
    expect(typeof tabLabelOf('constructor')).toBe('string')
  })

  it('每个真实页签的标题都是非空字符串（表本身没有原型污染）', () => {
    const tabs = Object.keys(TAB_LABELS) as WechatTab[]
    expect(tabs.length).toBeGreaterThan(20)
    for (const tab of tabs) expect(tabLabelOf(tab).length).toBeGreaterThan(0)
  })
})
