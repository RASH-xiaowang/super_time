
/**
 * 世界层必须**先出地图、数据随后叠加**（2026-09-26 用户要求）。
 *
 * 起因：用户看「世界板块」时那块长时间不出东西。查下来 `WorldMap.tsx` 的**每一个**地图分支
 * 都以 `map &&` 为前置（`map` = `apiGetRegionMap()` 的结果），而世界层的底图
 * （经纬网格 `graticule` + 大陆轮廓 `backdropPaths`）**是模块级静态常量、不依赖任何数据**。
 * 于是数据到位之前整块区域是空的 —— 明明可以立刻画出来的东西在等数据。
 *
 * 改法：世界层 SVG 分支去掉 `map &&`（`located` 为空时自然只有底图），并把两处
 * 「必须有数据才成立」的判断补齐：
 *  ① `showWorldEcharts` 连带要求 `map !== null` —— 否则 GeoJSON 比数据先到时会切到 ECharts
 *     而 ECharts 那支又被 `map &&` 挡住 ⇒ **两边都不画，比改之前更空**；
 *  ② `located` 空提示必须要求 `map !== null` —— 否则「还在加载」会被说成「没有可定位的地区
 *     数据」（本仓对这类「把读不到渲染成没有」有明确纪律）。
 *
 * 下钻层级（ECharts 世界 / 中国 / 省 / 市）**仍然保留** `map &&`：那些视图渲染的就是数据本身，
 * 没有数据确实无从画起。本文件把这条边界也钉住，免得有人顺手删干净。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, readStripped, sliceBetween } from './wiring-kit.ts'

const HERE = import.meta.dirname
const MAP = readStripped(join(HERE, 'WorldMap.tsx'))

describe('世界层：底图不等数据', () => {
  it('世界层 SVG 分支不再以 `map` 为前提', () => {
    expect(MAP, '世界层 SVG 分支丢了').toContain('{showGeoMap && (')
    // 反例：退回「等数据才画」——那正是用户报的现象
    expect(MAP.includes('{map && showGeoMap && ('), '世界层不许再等 map').toBe(false)
  })

  it('底图确实是静态的（这是「能先画」的前提，别把数据塞进来）', () => {
    expect(MAP, 'graticule 必须仍然是模块级常量').toMatch(/const graticule\s*(:|=)/)
    // 世界层那段 SVG 里不许出现**读数据**的写法（`map?.xxx` / `map.xxx`）。
    // 它只该用 graticule / backdropPaths / view 这些与数据无关的东西。
    const svgBranch = sliceBetween(MAP, '{showGeoMap && (', '      {map && showWorldEcharts && (', '世界层 SVG 分支')
    expect(/\bmap\s*\??\.[A-Za-z_]/.test(svgBranch), '底图分支不许读数据').toBe(false)
    expect(svgBranch.includes('graticule.map'), '底图要用静态经纬网').toBe(true)
    expect(svgBranch.includes('backdropPaths.map'), '底图要用静态大陆轮廓').toBe(true)
    atLeast(svgBranch.length, 1500, '世界层 SVG 分支的源码长度')
  })

  it('showWorldEcharts 必须连 data 一起要求（否则 GeoJSON 先到反而两边都不画）', () => {
    expect(MAP, '缺 map !== null 保护').toMatch(/const showWorldEcharts = worldEchartsReady && map !== null/)
  })

  it('「没有可定位的地区数据」只在数据真的到了之后才说', () => {
    expect(MAP).toMatch(/\{map !== null && located\.length === 0 && \(/)
    expect(MAP.includes('{located.length === 0 && ('), '不许把「加载中」说成「没有」').toBe(false)
  })

  it('加载态提示还在（先出底图 ≠ 不告诉用户数据在加载）', () => {
    expect(MAP).toMatch(/\{!map && !error && <div className=\{css\.loading\}>正在解析好友地区…/)
  })
})

describe('边界：下钻层级仍然要有数据', () => {
  it('ECharts 世界 / 中国 / 省 三个分支保留 map 前置', () => {
    for (const keep of ['{map && showWorldEcharts && (', '{map && showChinaEcharts && (', '{map && showProvinceMap &&']) {
      expect(MAP, `下钻分支的前置被删了：${keep}`).toContain(keep)
    }
  })

  it('防空转：真读到了文件', () => {
    atLeast(MAP.length, 8000, 'WorldMap.tsx 源码')
  })
})
