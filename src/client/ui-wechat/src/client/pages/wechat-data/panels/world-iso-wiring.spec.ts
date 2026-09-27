/**
 * 世界层「扁平二维 → 等距立体」这次换渲染器的接线判据（2026-09-27）。
 *
 * 三件必须钉住的事：
 *  ① 世界层用 `WorldIsoMap`，且**仍带空节点兜底与失败回退**（"先渲染世界地图"那两条口径不能丢）；
 *  ② 底图仍然只从 `world-map-data.ts#fetchFirstJson` 拿（出网闸门在那里；
 *     `s07-outbound-switches` 扫的是文件集合，这里钉的是"这个组件确实走那条路"）；
 *  ③ 中国/省/市三层**没被误伤**，仍走 ECharts（`ChinaMap`/`ProvinceMap`/`CityMap` 都还引它）——
 *     换世界层时最容易顺手把 ECharts 那条链一起拆掉。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const MAP = readStripped(join(HERE, 'WorldMap.tsx'))
const ISO = readStripped(join(HERE, 'WorldIsoMap.tsx'))
const DATA = readStripped(join(HERE, 'world-map-data.ts'))

describe('世界层：等距立体渲染器接得对', () => {
  it('世界层用 WorldIsoMap，且空节点兜底与失败回退都在', () => {
    expect(MAP, '世界层没接 WorldIsoMap').toContain('<WorldIsoMap')
    expect(MAP, '世界层还在用扁平 ECharts 地图').not.toContain('<GeoEchartsMap')
    expect(MAP, '缺空世界节点兜底（先渲染地图那条口径）').toContain('node={map?.world ?? EMPTY_WORLD}')
    expect(MAP, '底图失败的回退没了（应走 fallbackWorldEcharts）').toContain('onFallback={fallbackWorldEcharts}')
    expect(MAP, '国家名解析没接上（下钻会失联）').toContain('featureName={worldFeatureName}')
  })

  it('底图只从受闸门的取数口拿：组件里不许自己发 fetch', () => {
    expect(ISO, '没走 fetchFirstJson ⇒ 绕过了出网闸门').toContain('fetchFirstJson')
    const bare = /\bfetch\(/.test(ISO)
    expect(bare, 'WorldIsoMap 自己发了 fetch：闸门在 world-map-data.ts，绕过去就漏了').toBe(false)
    expect(DATA, 'fetchFirstJson 不在原来的文件里了？').toContain('export async function fetchFirstJson')
  })

  it('中国 / 省 / 市三层没被误伤，仍走 ECharts', () => {
    for (const f of ['ChinaMap.tsx', 'ProvinceMap.tsx', 'CityMap.tsx']) {
      expect(readStripped(join(HERE, f)).includes("from './GeoEchartsMap.tsx'"), `${f} 不该改：它还在用 GeoEchartsMap`).toBe(true)
    }
  })

  it('防空转 + 反例自证（改名 / 去掉 import 都要报）', () => {
    atLeast(MAP.length, 5000, 'WorldMap.tsx 源码')
    atLeast(ISO.length, 4000, 'WorldIsoMap.tsx 源码')
    // 反例①：把世界层的组件名改掉（用 split/join 换全部出现，别用 replace(第一处)）。
    // ⚠️ 新名字**不能含旧串**：`<WorldIsoMapX` 仍然 includes `<WorldIsoMap` —— 本仓踩过这个坑
    // （"X+后缀当改名"），所以换成前后都不搭界的写法。
    const renamed = MAP.split('<WorldIsoMap').join('<IsoGlobeView')
    expect(renamed.includes('<WorldIsoMap'), '改名后仍命中 ⇒ 反例是自欺').toBe(false)
    expect(renamed.includes('<IsoGlobeView'), '改名没生效 ⇒ 上面那条是空跑').toBe(true)
    // 反例②：把取数口换成裸 fetch，上面那条必须能判出来
    const swapped = ISO.split('fetchFirstJson').join('fetch')
    expect(/\bfetch\(/.test(swapped), '把取数口换成裸 fetch 之后判据没反应 ⇒ 那条是恒真').toBe(true)
    expect(findRoot(HERE).length).toBeGreaterThan(3)
  })
})
