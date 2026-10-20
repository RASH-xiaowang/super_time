/**
 * 区县地图的着色逻辑守卫（2026-10-17 修复「国内的县区地图内容没有做好」）。
 *
 * ## 问题
 *
 * `CityMap` 原先写 `childByKey={() => null}` —— **所有区县恒为 0**，
 * `visualMap` 把它们全涂成起点色，看起来就是「一张同色地图，没有信息」。
 *
 * ## 事实（数据层）
 *
 * 区域快照的层级是 `世界 → 国家 → 省 → 市 → 好友`，**没有独立的区县字段**
 * （微信 `extra_buffer` 只有 field 5/6/7 = 国家/省/市）。但**直辖市的「市」字段
 * 实际存的是区名**（北京/朝阳区、上海/徐汇区 —— 见 `region.ts` 的 `CITY_ALIAS`）。
 *
 * 所以：
 *   · **直辖市**（北京/上海/天津/重庆）：`node.children` 就是区 ⇒ 区县能着色；
 *   · **普通城市**（南宁/广州…）：`node.children` 为空 ⇒ 不画同色地图，
 *     改为一句明确说明「本机数据只到市级」。
 *
 * ## 判据口径
 *
 * 这里**不渲染 React**（`CityMap` 依赖 ECharts 与 DOM），而是钉住：
 *   ① 源码里 `childByKey` 必须真的用 `node.children` 匹配（不是 `() => null`）；
 *   ② 匹配函数复用 `provinceCityChild`（去掉「市/区/县」后缀再比）；
 *   ③ 无区县数据时有明确提示分支（不是静默画同色地图）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { provinceCityChild } from './province-map-data.ts'
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const RAW = readFileSync(join(HERE, 'CityMap.tsx'), 'utf8')
/**
 * 剥掉注释再断言。
 *
 * ⚠️ 必须剥：本文件的注释里**故意**写了历史写法（`childByKey={() => null}`），
 * 那是给下一个人看「为什么改成现在这样」的。不剥的话 `not.toContain` 会被自己的注释咬到
 * （本仓踩过多次）。
 */
const CITY = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** 造一个最小 RegionNode。 */
function node(name: string, count: number, children: RegionNode[] = []): RegionNode {
  return { key: name, name, count, children, friends: [] }
}

describe('区县匹配：直辖市能着色，普通城市走提示', () => {
  it('直辖市的区能匹配上（北京 › 朝阳区）', () => {
    const beijing = node('北京', 3, [node('朝阳区', 2), node('大兴区', 1)])
    expect(provinceCityChild(beijing.children, '朝阳区')?.count).toBe(2)
    expect(provinceCityChild(beijing.children, '大兴区')?.count).toBe(1)
    // 没有好友的区匹配不到（返回 null ⇒ value 0，这是对的）
    expect(provinceCityChild(beijing.children, '海淀区')).toBeNull()
  })

  it('后缀差异也能匹配（数据里是「朝阳区」，GeoJSON 里是「朝阳区」/「朝阳」）', () => {
    const beijing = node('北京', 3, [node('朝阳区', 2)])
    expect(provinceCityChild(beijing.children, '朝阳区')?.count).toBe(2)
    expect(provinceCityChild(beijing.children, '朝阳')?.count).toBe(2)
  })

  it('普通城市没有区县子节点 ⇒ 匹配恒为 null（此时应走提示分支，不是画同色地图）', () => {
    const nanning = node('南宁', 32)
    expect(nanning.children.length).toBe(0)
    expect(provinceCityChild(nanning.children, '青秀区')).toBeNull()
    expect(provinceCityChild(nanning.children, '兴宁区')).toBeNull()
  })
})

describe('CityMap 源码：childByKey 必须真的用 node.children', () => {
  it('不再写死 `() => null`（那是「所有区县恒为 0」的根因）', () => {
    expect(CITY, 'CityMap 又退回 `childByKey={() => null}` 了 —— 区县会全部恒为 0')
      .not.toContain('childByKey={() => null}')
  })

  it('childByKey 用 provinceCityChild 匹配 node.children', () => {
    expect(CITY, 'childByKey 没有用 node.children 匹配').toMatch(/provinceCityChild\(node\.children,\s*key\)/)
    expect(CITY, '没有引入 provinceCityChild').toContain('provinceCityChild')
  })

  it('无区县数据时有明确提示分支（不是静默画一张同色地图）', () => {
    expect(CITY, '缺「无区县数据」判据').toMatch(/const hasDistricts = node\.children\.length > 0/)
    expect(CITY, '缺「无区县数据」提示分支').toMatch(/if \(!hasDistricts\)/)
    expect(CITY, '提示文案没说清「数据只到市级」').toContain('本机微信数据只记录到「市」一级')
  })

  it('提示分支里仍显示该城市的好友数（不是一句干巴巴的「无数据」）', () => {
    expect(CITY).toMatch(/\{node\.name\}\s*·\s*\{node\.count\}\s*位好友/)
  })

  /**
   * 直辖市的「市」字段实际是区名（`北京 › 朝阳区`）—— 这一层**再往下是街道**，
   * DataV 没有街道数据，请求 `110105_full` 会 404。所以必须识别「已经是区县」并停下。
   */
  it('识别「节点本身已是区县」并停止下钻（否则直辖市的区会 404）', () => {
    expect(CITY, '缺「区县叶子」判据').toMatch(/const isDistrictLeaf = DISTRICT_SUFFIX\.test\(node\.name\)/)
    expect(CITY, '缺「区县叶子」提示分支').toMatch(/if \(isDistrictLeaf\)/)
    expect(CITY, '区县叶子分支里没说明「已是最细一级」').toContain('已是最细一级')
    // 区县叶子时不该再去请求下级 GeoJSON。
    expect(CITY, '区县叶子时仍在请求下级 GeoJSON').toMatch(/if \(isDistrictLeaf\) return/)
  })
})
