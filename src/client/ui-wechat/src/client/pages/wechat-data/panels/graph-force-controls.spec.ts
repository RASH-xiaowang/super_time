/**
 * 力度滑杆的范围、步长与显示倍率。
 *
 * 这里的约束不是视觉细节：范围超出 FA2 的钳制窗口时，滑杆两端会继续变化但图谱不动；
 * 步长与默认值不对齐时，浏览器会把受控 input 的初始值吸附到附近档位，第一次拖动会跳。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GRAPH_SETTINGS,
  GRAPH_FORCE_CONTROLS,
  GRAPH_FORCE_KEYS,
  formatGraphForceMultiplier,
  graphForceMultiplier,
} from './graph-model.ts'

describe('力度滑杆参数', () => {
  it('默认值位于范围内，且正好落在步长格点上', () => {
    for (const key of GRAPH_FORCE_KEYS) {
      const control = GRAPH_FORCE_CONTROLS[key]
      const value = DEFAULT_GRAPH_SETTINGS[key]
      expect(value).toBeGreaterThanOrEqual(control.min)
      expect(value).toBeLessThanOrEqual(control.max)
      const defaultStep = (value - control.min) / control.step
      const maxStep = (control.max - value) / control.step
      expect(Math.abs(defaultStep - Math.round(defaultStep))).toBeLessThan(1e-9)
      expect(Math.abs(maxStep - Math.round(maxStep))).toBeLessThan(1e-9)
    }
  })

  it('显示倍率以默认值为 1×，四舍五入后格式稳定', () => {
    for (const key of GRAPH_FORCE_KEYS) {
      expect(graphForceMultiplier(key, DEFAULT_GRAPH_SETTINGS[key])).toBe(1)
      expect(formatGraphForceMultiplier(key, DEFAULT_GRAPH_SETTINGS[key])).toBe('1.00×')
      expect(formatGraphForceMultiplier(key, GRAPH_FORCE_CONTROLS[key].max)).toBe('4.00×')
      expect(formatGraphForceMultiplier(key, GRAPH_FORCE_CONTROLS[key].min)).toBe('0.25×')
    }
  })

  it('六个力度键各有一份范围，没有遗漏或重复', () => {
    expect(new Set(GRAPH_FORCE_KEYS).size).toBe(6)
    expect(Object.keys(GRAPH_FORCE_CONTROLS).sort()).toEqual([...GRAPH_FORCE_KEYS].sort())
  })
})
