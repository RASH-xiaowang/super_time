/**
 * 「世界板块 · 好友地区」右侧的两张榜单：**省份 Top 10** 与 **城市 Top 12**。
 *
 * 为什么要有它：总览里这块原本只有一张世界地图。实测（1440×900、228 位有地区好友）
 * 地图画布 520px 高、两侧还各有一条 240px 宽的头像栏 —— 地图以外的面积几乎全是空的，
 * 而"好友到底在哪些省/市"这个真正有用的信息一个都没露出来。榜单把这块横向空间
 * 换成可读的数据：左省份、右城市，两栏各自带条形对比。
 *
 * 数据与地图同源（`getRegionMap()` 的 世界 → 国家 → 省 → 市 树），不新增后端方法：
 *  · 省份 = 好友最多的那个国家（通常是「中国」）下的省节点，按人数排序；
 *  · 城市 = 全部省节点下的市节点汇总排序（同名城市按 key 合并）。
 *
 * 榜单是**只读展示**：地图的钻取交互仍在左边那张地图里，这里点进去没有对应页面，
 * 所以不做成按钮（假的可点性比不可点更糟）。
 */
import { useEffect, useState } from 'react'
import { apiGetRegionMap } from '../api.ts'
import type { RegionMapSnapshot, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import css from './overview.module.css'

/** 单条榜单行。 */
interface RankRow {
  key: string
  name: string
  count: number
}

/** 按人数降序取前 N，并算出条形相对宽度用的最大值。 */
function topN(rows: RankRow[], n: number): { rows: RankRow[]; max: number } {
  const sorted = [...rows].sort((a, b) => b.count - a.count).slice(0, n)
  return { rows: sorted, max: Math.max(1, sorted[0]?.count ?? 1) }
}

/** 从「世界 → 国家 → 省 → 市」树里取好友最多的国家。 */
function topCountry(world: RegionNode): RegionNode | null {
  let best: RegionNode | null = null
  for (const c of world.children) {
    if (!best || c.count > best.count) best = c
  }
  return best
}

/** 汇总所有省下面的市（同名合并），用于城市榜。 */
function allCities(country: RegionNode): RankRow[] {
  const map = new Map<string, RankRow>()
  for (const prov of country.children) {
    for (const city of prov.children) {
      const cur = map.get(city.name)
      if (cur) cur.count += city.count
      else map.set(city.name, { key: city.name, name: city.name, count: city.count })
    }
  }
  return [...map.values()]
}

/** 一栏榜单。 */
function RankColumn({ title, hint, rows, max }: {
  title: string
  hint: string
  rows: RankRow[]
  max: number
}) {
  return (
    <div className={css.regionRank}>
      <div className={css.regionRankHd}>
        <span className={css.regionRankTitle}>{title}</span>
        <span className={css.regionRankHint}>{hint}</span>
      </div>
      <div className={css.regionRows}>
        {rows.map((r, i) => (
          <div key={r.key} className={css.regionRow} title={`${r.name} · ${r.count} 位好友`}>
            <span className={css.regionRankNo}>{i + 1}</span>
            <span className={css.regionName}>{r.name}</span>
            <span className={css.regionCount}>{r.count}</span>
            <span className={css.regionBar}>
              <span className={css.regionBarFill} style={{ width: `${Math.max(6, Math.round((r.count / max) * 100))}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 好友地区榜单（省份 + 城市）。
 * @returns 两栏榜单；数据未到时显示骨架行。
 */
export function RegionBoard(): React.JSX.Element {
  const [snap, setSnap] = useState<RegionMapSnapshot | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await apiGetRegionMap()
        if (!cancelled) setSnap(s)
      } catch {
        // 地区数据取不到不该影响整块总览：地图仍在，榜单降级为一行说明。
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (failed) {
    return <div className={css.regionRank}><div className={css.regionEmpty}>地区数据暂不可用</div></div>
  }
  if (!snap) {
    return (
      <>
        <div className={css.regionRank}><div className={css.regionRankHd}><span className={css.regionRankTitle}>省份 Top 10</span></div><div className={css.regionRows}>{Array.from({ length: 8 }, (_, i) => <span key={i} className={css.skLine} style={{ width: '100%', height: 12 }} />)}</div></div>
        <div className={css.regionRank}><div className={css.regionRankHd}><span className={css.regionRankTitle}>城市 Top 12</span></div><div className={css.regionRows}>{Array.from({ length: 8 }, (_, i) => <span key={i} className={css.skLine} style={{ width: '100%', height: 12 }} />)}</div></div>
      </>
    )
  }

  const country = topCountry(snap.world)
  if (!country) {
    return <div className={css.regionRank}><div className={css.regionEmpty}>暂无好友地区信息</div></div>
  }
  const prov = topN(country.children.map(c => ({ key: c.key, name: c.name, count: c.count })), 10)
  const city = topN(allCities(country), 12)
  const pct = snap.total > 0 ? Math.round((country.count / snap.total) * 100) : 0

  return (
    <>
      <RankColumn title="省份 Top 10" hint={`${country.name} ${country.count} 位 · 占 ${pct}%`} rows={prov.rows} max={prov.max} />
      <RankColumn title="城市 Top 12" hint={`共 ${city.rows.length >= 12 ? '12+' : city.rows.length} 个城市有好友`} rows={city.rows} max={city.max} />
    </>
  )
}
