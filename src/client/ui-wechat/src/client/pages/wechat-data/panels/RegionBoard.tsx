/**
 * 总览中的两张独立地区榜单：**省份 Top 10** 与 **城市 Top 12**。
 *
 * 为什么要有它：总览里这块原本只有一张世界地图。实测（1440×900、228 位有地区好友）
 * 地图画布 520px 高、两侧还各有一条 240px 宽的头像栏 —— 地图以外的面积几乎全是空的，
 * 而"好友到底在哪些省/市"这个真正有用的信息一个都没露出来。榜单把这块横向空间
 * 换成可读的数据：省份与城市分别展示，各自带条形对比。
 *
 * 数据与地图同源（`getRegionMap()` 的 世界 → 国家 → 省 → 市 树），不新增后端方法：
 *  · 省份 = 好友最多的那个国家（通常是「中国」）下的省节点，按人数排序；
 *  · 城市 = 全部省节点下的市节点汇总排序（同名城市按 key 合并）。
 *
 * 榜单是**只读展示**：地图的钻取交互仍在左边那张地图里，这里点进去没有对应页面，
 * 所以不做成按钮（假的可点性比不可点更糟）。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetRegionMap } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import type { RegionMapSnapshot, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import css from './overview.module.css'
import regionCss from './overview-region.module.css'
import { OvSection } from './overview-parts.tsx'

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

/** 单张榜单。 */
function RankList({ hint, rows, max }: {
  hint: string
  rows: RankRow[]
  max: number
}) {
  return (
    <div className={regionCss.regionRank}>
      <div className={regionCss.regionRankHd}>
        <span className={regionCss.regionRankHint}>{hint}</span>
      </div>
      <div className={regionCss.regionRows}>
        {/* R4：此前 rows 为空时这里是空 div，整块塌成 0 高度（「省份 Top 10」只剩标题，
            下面凭空少一块，看着像渲染失败）。补一行占位。 */}
        {rows.length === 0 && <div className={regionCss.regionEmpty}>暂无数据</div>}
        {rows.map((r, i) => (
          <div key={r.key} className={regionCss.regionRow} title={`${r.name} · ${r.count} 位好友`}>
            <span className={regionCss.regionRankNo}>{i + 1}</span>
            <span className={regionCss.regionName}>{r.name}</span>
            <span className={regionCss.regionCount}>{r.count}</span>
            <span className={regionCss.regionBar}>
              <span className={regionCss.regionBarFill} style={{ width: `${Math.max(6, Math.round((r.count / max) * 100))}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RankCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return <OvSection className="col-12" icon="world" title={title}>{children}</OvSection>
}

/**
 * 好友地区榜单（省份 + 城市）。
 * @returns 两栏榜单；数据未到时显示骨架行。
 */
export function RegionBoard(): React.JSX.Element {
  const [snap, setSnap] = useState<RegionMapSnapshot | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await apiGetRegionMap()
      setSnap(s)
      setFailed(false)
    } catch {
      // 地区数据取不到不该影响整块总览：地图仍在，榜单降级为一行说明。
      if (snap === null) setFailed(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // WAL 增量推送：新消息改变好友地区分布时静默重取。
  useWechatDataUpdated(() => { void load() })

  if (failed) {
    return (
      <>
        <RankCard title="省份 Top 10"><div className={regionCss.regionRank}><div className={regionCss.regionEmpty}>地区数据暂不可用</div></div></RankCard>
        <RankCard title="城市 Top 12"><div className={regionCss.regionRank}><div className={regionCss.regionEmpty}>地区数据暂不可用</div></div></RankCard>
      </>
    )
  }
  if (!snap) {
    return (
      <>
        {(['省份 Top 10', '城市 Top 12'] as const).map(title => (
          <RankCard key={title} title={title}>
            <div className={regionCss.regionRank}>
              <div className={regionCss.regionRows}>{Array.from({ length: 8 }, (_, i) => <span key={i} className={css.skLine} style={{ width: '100%', height: 12 }} />)}</div>
            </div>
          </RankCard>
        ))}
      </>
    )
  }

  const country = topCountry(snap.world)
  if (!country) {
    return (
      <>
        <RankCard title="省份 Top 10"><div className={regionCss.regionRank}><div className={regionCss.regionEmpty}>暂无好友地区信息</div></div></RankCard>
        <RankCard title="城市 Top 12"><div className={regionCss.regionRank}><div className={regionCss.regionEmpty}>暂无好友地区信息</div></div></RankCard>
      </>
    )
  }
  const prov = topN(country.children.map(c => ({ key: c.key, name: c.name, count: c.count })), 10)
  const city = topN(allCities(country), 12)
  const pct = snap.total > 0 ? Math.round((country.count / snap.total) * 100) : 0

  return (
    <>
      <RankCard title="省份 Top 10">
        <RankList hint={`${country.name} ${country.count} 位 · 占 ${pct}%`} rows={prov.rows} max={prov.max} />
      </RankCard>
      <RankCard title="城市 Top 12">
        <RankList hint={`共 ${city.rows.length >= 12 ? '12+' : city.rows.length} 个城市有好友`} rows={city.rows} max={city.max} />
      </RankCard>
    </>
  )
}
