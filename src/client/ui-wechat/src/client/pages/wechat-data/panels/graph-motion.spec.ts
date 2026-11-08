/**
 * 参数变化时的坐标过渡：连续性、固定节点与结束落点。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  LAYOUT_TRANSITION_MS,
  PARAM_PREVIEW_BLEND,
  blendPositions,
  createPositionMotion,
  forcePreviewIntervalMs,
  smoothStep,
  stepPositionMotion,
  type PositionMotion,
} from './graph-motion.ts'

describe('力度预览插值', () => {
  it('小图逐帧预览，大图按规模降频且随实测耗时自适应', () => {
    expect(forcePreviewIntervalMs({ nodeCount: 290 })).toBe(0)
    expect(forcePreviewIntervalMs({ nodeCount: 501 })).toBe(24)
    expect(forcePreviewIntervalMs({ nodeCount: 1201 })).toBe(48)
    expect(forcePreviewIntervalMs({ nodeCount: 2501 })).toBe(80)
    expect(forcePreviewIntervalMs({ nodeCount: 5001 })).toBe(120)
    expect(forcePreviewIntervalMs({ nodeCount: 100, elapsedMs: 9 })).toBe(18)
    expect(forcePreviewIntervalMs({ nodeCount: 100, elapsedMs: 10_000 })).toBe(160)
  })

  it('每帧只靠近目标一部分，不会直接把节点瞬移到布局结果', () => {
    const current = new Map([['a', { x: 0, y: 0 }]])
    const moved = blendPositions(current, new Map([['a', { x: 100, y: 50 }]]), PARAM_PREVIEW_BLEND)
    expect(moved).toBe(1)
    expect(current.get('a')?.x).toBeCloseTo(100 * PARAM_PREVIEW_BLEND, 9)
    expect(current.get('a')?.y).toBeCloseTo(50 * PARAM_PREVIEW_BLEND, 9)
  })

  it('固定节点保持原位，新节点直接落到目标处', () => {
    const current = new Map([['fixed', { x: 10, y: 20 }]])
    blendPositions(
      current,
      new Map([['fixed', { x: 90, y: 80 }], ['new', { x: 30, y: 40 }]]),
      0.5,
      new Set(['fixed']),
    )
    expect(current.get('fixed')).toEqual({ x: 10, y: 20 })
    expect(current.get('new')).toEqual({ x: 30, y: 40 })
  })
})

describe('完整布局过渡', () => {
  const target = new Map([
    ['a', { x: 100, y: -40 }],
    ['fixed', { x: 20, y: 20 }],
  ])
  const start = new Map([
    ['a', { x: 0, y: 0 }],
    ['fixed', { x: 20, y: 20 }],
  ])

  function motion(): PositionMotion {
    return createPositionMotion(start, target, 1000, 200, new Set(['fixed']))
  }

  it('smoothStep 两端速度为零且单调', () => {
    expect(smoothStep(0)).toBe(0)
    expect(smoothStep(1)).toBe(1)
    let previous = -1
    for (let i = 0; i <= 20; i++) {
      const value = smoothStep(i / 20)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
    // 开始与结束附近的变化量明显小于中段
    expect(smoothStep(0.1)).toBeLessThan(0.1)
    expect(1 - smoothStep(0.9)).toBeLessThan(0.1)
  })

  it('推进过程连续，结束时精确落到目标；固定节点始终不动', () => {
    const current = new Map(start)
    const state = motion()
    let previousX = current.get('a')?.x ?? 0
    for (const now of [1020, 1060, 1100, 1140, 1180, 1200]) {
      const stepped = stepPositionMotion(current, state, now)
      const x = current.get('a')?.x ?? 0
      expect(x).toBeGreaterThanOrEqual(previousX)
      expect(stepped.maxDelta).toBeGreaterThanOrEqual(0)
      previousX = x
    }
    expect(stepPositionMotion(current, state, 1200).done).toBe(true)
    expect(current.get('a')).toEqual(target.get('a'))
    expect(current.get('fixed')).toEqual({ x: 20, y: 20 })
  })

  it('非法时长回退到默认值，不会让过渡永远走不完', () => {
    const state = createPositionMotion(start, target, 0, Number.NaN)
    expect(state.durationMs).toBe(LAYOUT_TRANSITION_MS)
  })
})
