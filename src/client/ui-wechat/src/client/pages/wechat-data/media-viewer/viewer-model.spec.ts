/**
 * 统一资源查看器纯逻辑判据（2026-10-21）。
 *
 * 这族坏法都是「不报错、只觉得怪」：缩到 0.3 倍、翻到最后一张变空、预取把相邻全拉进来。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  counterText,
  DEFAULT_MAX_ZOOM,
  DEFAULT_MIN_ZOOM,
  neighborIndexes,
  percentOf,
  wrapIndex,
  zoomStep,
} from './viewer-model.ts'

describe('clampZoom / zoomStep：缩放不许越界', () => {
  it('钳在默认区间内，非有限值回 1', () => {
    expect(clampZoom(0.01)).toBe(DEFAULT_MIN_ZOOM)
    expect(clampZoom(99)).toBe(DEFAULT_MAX_ZOOM)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(2)).toBe(2)
  })

  it('步长 1.25×，边界处不再变化', () => {
    expect(zoomStep(1, 1)).toBe(1.25)
    expect(zoomStep(1.25, -1)).toBe(1)
    expect(zoomStep(DEFAULT_MAX_ZOOM, 1)).toBe(DEFAULT_MAX_ZOOM)
    expect(zoomStep(DEFAULT_MIN_ZOOM, -1)).toBe(DEFAULT_MIN_ZOOM)
  })

  it('自定义区间（朋友圈 1–5）同样生效', () => {
    expect(clampZoom(0.2, 1, 5)).toBe(1)
    expect(clampZoom(9, 1, 5)).toBe(5)
    expect(zoomStep(4.5, 1, 1, 5)).toBe(5)
  })
})

describe('wrapIndex / counterText：翻页循环且不越界', () => {
  it('首尾循环', () => {
    expect(wrapIndex(5, 0, -1)).toBe(4)
    expect(wrapIndex(5, 4, 1)).toBe(0)
    expect(wrapIndex(5, 2, 7)).toBe(4)
    expect(wrapIndex(0, 3, 1)).toBe(0)
  })

  it('计数从 1 开始；空集合 0/0', () => {
    expect(counterText(0, 3)).toBe('1 / 3')
    expect(counterText(2, 3)).toBe('3 / 3')
    expect(counterText(-1, 3)).toBe('3 / 3')
    expect(counterText(0, 0)).toBe('0 / 0')
  })

  it('百分比文案', () => {
    expect(percentOf(1)).toBe('100%')
    expect(percentOf(1.256)).toBe('126%')
    expect(percentOf(Number.NaN)).toBe('100%')
  })
})

describe('neighborIndexes：只预取左右相邻', () => {
  it('默认各一张，循环且去重', () => {
    expect(neighborIndexes(5, 2)).toEqual([1, 3])
    expect(neighborIndexes(5, 0)).toEqual([4, 1])
    expect(neighborIndexes(2, 0)).toEqual([1])
    expect(neighborIndexes(1, 0)).toEqual([])
    expect(neighborIndexes(0, 0)).toEqual([])
  })

  it('radius 可控，条目少时不重复自己', () => {
    expect(neighborIndexes(4, 0, 2)).toEqual([3, 1, 2])
    expect(neighborIndexes(3, 0, 5)).toEqual([2, 1])
    expect(neighborIndexes(5, 2, 0)).toEqual([])
  })
})
