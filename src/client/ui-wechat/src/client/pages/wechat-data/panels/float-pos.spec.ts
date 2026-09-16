/**
 * 悬浮面板位置的夹取与持久化。
 *
 * 守的是「拖到哪儿都找得回来」：窗口缩小时回位、拖出边缘时夹住、存坏了当作没存过
 * （回落 CSS 默认位置，而不是把面板顶到视口外）。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { FLOAT_MARGIN, clampFloatPos, floatPosKey, parseFloatPos } from './float-pos.ts'

const view = { w: 1440, h: 900 }
const size = { w: 392, h: 320 }

describe('夹取位置', () => {
  it('正常范围内原样返回', () => {
    expect(clampFloatPos({ x: 300, y: 200 }, size, view)).toEqual({ x: 300, y: 200 })
  })

  it('超出右下角被夹回可视范围', () => {
    const r = clampFloatPos({ x: 9999, y: 9999 }, size, view)
    expect(r).toEqual({ x: view.w - size.w - FLOAT_MARGIN, y: view.h - size.h - FLOAT_MARGIN })
  })

  it('负坐标被夹到边缘空隙处', () => {
    expect(clampFloatPos({ x: -500, y: -500 }, size, view)).toEqual({ x: FLOAT_MARGIN, y: FLOAT_MARGIN })
  })

  it('面板比视口还大时仍留得住左上角（不会算出负数把把手挤出去）', () => {
    const huge = { w: 2000, h: 1200 }
    expect(clampFloatPos({ x: 0, y: 0 }, huge, view)).toEqual({ x: FLOAT_MARGIN, y: FLOAT_MARGIN })
  })

  it('窗口变小后，原先靠右下的位置会被拉回来', () => {
    const before = clampFloatPos({ x: 1000, y: 560 }, size, view)
    const after = clampFloatPos(before, size, { w: 900, h: 600 })
    expect(after.x).toBeLessThanOrEqual(900 - size.w - FLOAT_MARGIN)
    expect(after.y).toBeLessThanOrEqual(600 - size.h - FLOAT_MARGIN)
  })
})

describe('解析存档', () => {
  it('正常存档解析出坐标', () => {
    expect(parseFloatPos('{"x":12,"y":34}')).toEqual({ x: 12, y: 34 })
  })

  it('空值 / 坏 JSON / 缺字段 / 非数字 一律当作没存过', () => {
    expect(parseFloatPos(null)).toBeNull()
    expect(parseFloatPos('')).toBeNull()
    expect(parseFloatPos('not json')).toBeNull()
    expect(parseFloatPos('{"x":1}')).toBeNull()
    expect(parseFloatPos('{"x":"1","y":2}')).toBeNull()
    expect(parseFloatPos('{"x":null,"y":2}')).toBeNull()
  })

  it('NaN / Infinity 不算合法位置（否则会把面板顶到视口外）', () => {
    expect(parseFloatPos('{"x":1e999,"y":0}')).toBeNull()
  })

  it('键名按面板 id 分开', () => {
    expect(floatPosKey('setup-guide')).toBe('super-time-float-pos-setup-guide')
    expect(floatPosKey('a')).not.toBe(floatPosKey('b'))
  })
})
