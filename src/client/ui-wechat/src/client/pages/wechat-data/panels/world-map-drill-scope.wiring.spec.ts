/**
 * 下钻地图的**覆盖范围**守卫（2026-10-17）。
 *
 * ## 为什么值得钉
 *
 * 用户问过「其他国家地区的下钻省市内容也做好本地化了吗？」—— 答案是
 * **其他国家根本没有省市下钻**，所以不存在「没本地化」的问题。但这条事实
 * 只写在 `WorldMap.tsx` 的两行三元表达式里，很容易被误读成「漏做了」。
 *
 * ## 事实（源码判据）
 *
 * `WorldMap.tsx` 的 `provinceNode` / `cityNode` 都要求 `path[0]?.key === '中国'`：
 *
 *   · `path = [中国]`            → `chinaMode`，渲染中国省级地图（本地 `drill/100000.json`）
 *   · `path = [中国, 广西]`      → `provinceNode`，渲染省→市地图（本地 `drill/450000.json`）
 *   · `path = [中国, 广西, 南宁]` → `cityNode`，渲染市→区地图（本地 `drill/450100.json`）
 *   · `path = [美国]` / `[美国, 加利福尼亚]` → **两者都是 null**，仍渲染世界地图
 *     （只是高亮该国家）+ 两侧好友栏，**不请求任何省市 GeoJSON**
 *
 * 所以「本地化」的覆盖范围 = 中国全境（34 省级 + 329 地级市），
 * 其他国家**没有下钻层级**，自然也不需要省市数据。
 *
 * ## 为什么其他国家不做下钻
 *
 * 区域快照（`query/region-map.ts`）里，只有「中国」有多个省级子节点；
 * 其他国家（冰岛 / 爱尔兰 / 新加坡…）都只有 **1 个**子节点（就是城市本身）。
 * 没有「省」这一层，下钻就没有意义 —— 点进去只会看到同一个点。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAP = readFileSync(join(HERE, 'WorldMap.tsx'), 'utf8')

/** 取 `const X = ...` 那一行（到行尾）。 */
function lineOf(name: string): string {
  const m = new RegExp(`const ${name} = ([^\\n]+)`).exec(MAP)
  return m?.[1] ?? ''
}

describe('下钻地图的覆盖范围：只有中国有省市层级', () => {
  it('`provinceNode` 要求 `path[0].key === 中国`（其他国家不进省层）', () => {
    const line = lineOf('provinceNode')
    expect(line, '切不出 provinceNode 的判据 ⇒ 下面的断言会空转').toBeTruthy()
    expect(line, 'provinceNode 不再限定中国 —— 其他国家会去请求不存在的省界数据').toContain("path[0]?.key === '中国'")
    expect(line, 'provinceNode 必须是 level === 2').toContain('level === 2')
  })

  it('`cityNode` 要求 `path[0].key === 中国`（其他国家不进市层）', () => {
    const line = lineOf('cityNode')
    expect(line, '切不出 cityNode 的判据').toBeTruthy()
    expect(line, 'cityNode 不再限定中国 —— 其他国家会去请求不存在的区县数据').toContain("path[0]?.key === '中国'")
    expect(line, 'cityNode 必须是 level === 3').toContain('level === 3')
  })

  it('非中国的国家层仍渲染世界地图（不是空白，也不是 treemap）', () => {
    // shouldShowWorldEcharts 的判据：ready && (onWorldMap || (!chinaMode && !provinceMode && !cityMode))
    const fn = /function shouldShowWorldEcharts\([^)]*\)[^{]*\{([^}]*)\}/.exec(MAP)?.[1] ?? ''
    expect(fn, '切不出 shouldShowWorldEcharts 的函数体').toBeTruthy()
    expect(fn, '非中国国家层必须继续显示世界地图（否则下钻后一片空白）')
      .toMatch(/!chinaMode\s*&&\s*!provinceMode\s*&&\s*!cityMode/)
  })

  it('本地下钻数据覆盖中国全部省级（34 个 adcode 文件都在）', () => {
    /*
     * ⚠️ 下钻数据在**后端**的 resources 下（`src/backend/wechat-data/resources/geo/drill/`），
     * 不在前端目录 —— 它由 `scripts/fetch-drill-geo.mjs` 生成、随包分发、由后端读取。
     * 本文件在 `src/client/ui-wechat/src/client/pages/wechat-data/panels/`，上 8 层到仓库根。
     */
    const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
    const drillDir = join(ROOT, 'src', 'backend', 'wechat-data', 'resources', 'geo', 'drill')
    const china = JSON.parse(readFileSync(join(drillDir, '100000.json'), 'utf8')) as {
      features?: Array<{ properties?: { adcode?: unknown } }>
    }
    const codes = (china.features ?? [])
      .map((f) => String(f.properties?.adcode ?? ''))
      .filter((c) => /^\d{6}$/.test(c))
    expect(codes.length, '中国省级要素数不对').toBeGreaterThanOrEqual(34)
    // 抽查几个代表性省份（含港澳台）的本地文件都在。
    for (const [code, label] of [
      ['110000', '北京'], ['310000', '上海'], ['440000', '广东'],
      ['450000', '广西'], ['650000', '新疆'], ['810000', '香港'],
      ['820000', '澳门'], ['710000', '台湾'],
    ] as const) {
      expect(codes, `中国省级数据里缺 ${label}（${code}）`).toContain(code)
    }
  })
})
