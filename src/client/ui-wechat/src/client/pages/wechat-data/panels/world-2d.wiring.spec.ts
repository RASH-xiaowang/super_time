/**
 * 世界层「**2D 平面地图**」的接线判据（2026-09-28 反转，原为 2026-09-27 的等距立体守卫）。
 *
 * ── 反转理由（别删这段，它是这条守卫存在的合法性来源）────────────────────
 * 2026-09-27 把世界层从扁平 ECharts 换成了自绘的**等距立体**（斜板 + 拔起的发光柱 +
 * 真 3D 地形 + 镜头推近）。2026-09-28 用户要求改回二维：「移除所有 3D 效果及相关交互
 * （如旋转、倾斜、缩放透视等）」，并明确「确保地图能正确渲染，国家与地区边界清晰、
 * 标签准确对齐」。
 *
 * 自绘 canvas 那套的失效模式恰恰是用户报的那个「显示不出来」：它要自己量容器
 * （`getBoundingClientRect`）和从 CSS 令牌解析颜色，两者任一拿不到就是**一片空白**，
 * 而且不报错。ECharts 那条路（中国/省/市三层一直在用）自带 ResizeObserver 自适应与
 * 2D 投影，所以世界层退回它 —— 本文件钉的就是「退回来了，而且没漏掉任何 3D 残留」。
 *
 * ── 钉住的四件事 ────────────────────────────────────────────────────────
 *  ① 世界层渲染 `GeoEchartsMap`（2D），且空节点兜底、失败回退、国名解析都在；
 *  ② 仓库里**没有任何 3D 渲染残留**：倾斜 / 地形 / 镜头飞行 / 等距投影 的文件与符号全没了；
 *  ③ 底图仍只从 `world-map-data.ts#fetchFirstJson` 拿（2026-09-30 起那里不再判
 *     任何出网闸门；现在渲染层改经 `apiGetMapGeoJson` 走后端固定白名单代理）；
 *  ④ 中国 / 省 / 市三层没被误伤，仍走同一个 `GeoEchartsMap`。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const MAP = readStripped(join(HERE, 'WorldMap.tsx'))
const DATA = readStripped(join(HERE, 'world-map-data.ts'))

/** 被 2026-09-28 那次「改回 2D」删掉的 3D 专属文件：一个都不许回来。 */
const REMOVED_3D_FILES = [
  'WorldIsoMap.tsx',
  'world-iso.ts',
  'world-iso-draw.ts',
  'world-terrain.ts',
  'world-fly.ts',
  'use-terrain.ts',
] as const

/** 3D 时代的符号：出现在这些文件的源码里就说明 3D 又长回来了。 */
const FORBIDDEN_3D_SYMBOLS = [
  'ISO_TILT',
  'drawIsoScene',
  'useTerrain',
  'useCameraFly',
  'flyToPose',
  'map3D',
] as const

describe('世界层：2D 平面渲染器接得对', () => {
  it('世界层用 GeoEchartsMap（2D），空节点兜底 / 失败回退 / 国名解析都在', () => {
    expect(MAP, '世界层没接 GeoEchartsMap（2D 渲染器）').toContain('<GeoEchartsMap')
    expect(MAP, '世界层还在用自绘的 3D 渲染器').not.toContain('<WorldIsoMap')
    expect(MAP, '没给 world 这个 registerMap key（ECharts 会找不到地图）').toContain('mapName="world"')
    expect(MAP, '缺空世界节点兜底（先渲染地图那条口径）').toContain('node={map?.world ?? EMPTY_WORLD}')
    expect(MAP, '底图失败的回退没了（应走 fallbackWorldEcharts）').toContain('onFallback={fallbackWorldEcharts}')
    expect(MAP, '国家名解析没接上（下钻会失联）').toContain('featureName={worldFeatureName}')
  })

  it('3D 时代的文件一个都没留下', () => {
    for (const f of REMOVED_3D_FILES) {
      expect(existsSync(join(HERE, f)), `${f} 又回来了？世界层已改回 2D，这些是纯 3D 的`).toBe(false)
    }
    // 反例自证：本判据不是恒真 —— 拿一个确定存在的文件打样。
    expect(existsSync(join(HERE, 'WorldMap.tsx')), '连 WorldMap.tsx 都找不到 ⇒ 上面的 existsSync 判据是空跑').toBe(true)
  })

  it('源码里没有 3D 残留符号（倾斜 / 地形 / 镜头飞行 / 等距投影）', () => {
    // ⚠️ 别用 `findRoot(HERE)` —— 它返回的是**仓库根目录字符串**，不是文件列表；
    //    拿它做 `for (const f of files)` 会逐个字符遍历，扫描整段恒真。
    //    （2026-09-28 变异测试抓出来的：往 WorldMap.tsx 里塞 ISO_TILT，这条竟然还是绿的。）
    const here = readdirSync(HERE).filter((n) => n.endsWith('.ts') || n.endsWith('.tsx'))
    atLeast(here.length, 30, 'panels 下的 ts/tsx 文件数（低于下限说明扫描没生效）')
    const hits: string[] = []
    for (const name of here) {
      // 守卫自己会写出这些词，跳过自己。
      if (name === 'world-2d.wiring.spec.ts') continue
      const src = readStripped(join(HERE, name))
      for (const sym of FORBIDDEN_3D_SYMBOLS) {
        if (src.includes(sym)) hits.push(`${name} → ${sym}`)
      }
    }
    expect(hits, `发现 3D 残留（用户要求移除全部 3D 效果）：\n  ${hits.join('\n  ')}`).toEqual([])
  })

  it('底图只从取数口拿，且经后端代理（不再判任何闸门、不再裸 fetch）', () => {
    expect(DATA, 'fetchFirstJson 不在原来的文件里了？').toContain('export async function fetchFirstJson')
    // 2026-09-30：mapTilesBlocked() 随底图开关一起删除；随后渲染层裸 fetch 也收口到后端。
    expect(DATA, 'fetchFirstJson 没有经后端代理取数').toMatch(/async function fetchFirstJson[\s\S]{0,240}await apiGetMapGeoJson\(urls\)/)
    expect(DATA, '渲染层又直接 fetch 地图地址').not.toMatch(/\bawait fetch\(/)
    expect(DATA, 'mapTilesBlocked 已删除，fetchFirstJson 里不该再有闸门').not.toContain('mapTilesBlocked')
  })

  it('中国 / 省 / 市三层没被误伤，仍走 ECharts', () => {
    for (const f of ['ChinaMap.tsx', 'ProvinceMap.tsx', 'CityMap.tsx']) {
      expect(readStripped(join(HERE, f)).includes("from './GeoEchartsMap.tsx'"), `${f} 不该改：它还在用 GeoEchartsMap`).toBe(true)
    }
  })
})

describe('世界层 2D：防空转 + 反例自证', () => {
  it('扫到的源码足够长，且改名 / 塞回 3D 都能被判出来', () => {
    atLeast(MAP.length, 4000, 'WorldMap.tsx 源码')
    // ⚠️ `findRoot(HERE)` 返回的是**仓库根目录字符串**，不是文件列表 —— 拿它 `.length`
    //    量到的是路径长度，当"文件数哨兵"毫无意义（原先这里就是这么写错的）。
    //    真要量扫描面，用 `readdirSync` 那条用例里的 `atLeast(here.length, 30, …)`。
    expect(existsSync(join(findRoot(HERE), 'package.json')), 'findRoot 没找到仓库根 ⇒ 它的返回值不可信').toBe(true)

    // 反例①：把世界层的组件名改掉（split/join 换全部出现，别用 replace(第一处)）。
    // ⚠️ 新名字**不能含旧串**：`<GeoEchartsMapX` 仍然 includes `<GeoEchartsMap` —— 本仓踩过这个坑
    // （"X+后缀当改名"），所以换成前后都不搭界的写法。
    const renamed = MAP.split('<GeoEchartsMap').join('<FlatRegionView')
    expect(renamed.includes('<GeoEchartsMap'), '改名后仍命中 ⇒ 反例是自欺').toBe(false)
    expect(renamed.includes('<FlatRegionView'), '改名没生效 ⇒ 上面那条是空跑').toBe(true)

    // 反例②：塞回一个 3D 符号，上面那条扫描必须能判出来。
    const polluted = MAP + '\nconst tilt = ISO_TILT\n'
    expect(FORBIDDEN_3D_SYMBOLS.some((s) => polluted.includes(s)), '塞了 ISO_TILT 之后判据没反应 ⇒ 那条是恒真').toBe(true)
    // 反例③：确认扫描清单本身非空（清单空了等于没扫）。
    atLeast(FORBIDDEN_3D_SYMBOLS.length, 3, '禁用符号清单长度')
    atLeast(REMOVED_3D_FILES.length, 3, '已删文件清单长度')
  })
})
