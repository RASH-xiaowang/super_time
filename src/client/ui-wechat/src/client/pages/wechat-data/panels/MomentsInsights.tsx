/**
 * 朋友圈洞察面板 — 我的朋友圈：发布/获赞/评论统计、互动 Top、月度分布、热词、足迹。
 * 全部基于本机 sns.db 离线计算。
 *
 * 布局（微信化精简：10 张卡 → 内联 KPI 条 + 4 张卡）：
 *   ├ 内联 KPI 条（40–46px）：发布 / 获赞 / 评论 / 定位点 / 那年今天 / 未读提醒 / 提醒人数
 *   ├ 互动 Top（点赞最多 + 评论最多，同卡两列）
 *   ├ 朋友圈热词
 *   ├ 月度发布分布
 *   └ 朋友圈足迹（地图 + 打卡最多的地方）
 *
 * 为什么保留这 4 张：它们各自需要一块**图形/榜单**的展示面积（双榜、词云、热力格、地图），
 * 不能用一行数字替代；其余计数（提醒、那年今天、地点）全部收进 KPI 条，不再各占一张卡。
 */
import { useCallback } from 'react'
import { apiGetMomentsInsights } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { MomentsInsightsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, LoadingState } from '../ui/kit.tsx'
import { FootprintMap } from './FootprintMap.tsx'
import kitCss from '../ui/kit.module.css'
import css from './moments-insights.module.css'
import { useWechatDataUpdated } from './hooks.tsx'
import { WordCloudCard } from './WordCloudCard.tsx'
import { MonthlyByYear } from './moments-monthly.tsx'

/** 一行「名称 + 数字」的紧凑列表项。 */
function Row({ name, count, title, tone }: {
  name: string
  count: React.ReactNode
  title?: string
  tone?: 'warn'
}): React.JSX.Element {
  return (
    <div className={css.row} title={title}>
      <span className={css.rowName}>{name}</span>
      <span className={css.rowCount} data-tone={tone}>{count}</span>
    </div>
  )
}

/** 一行「名称 + 条形 + 数字」，条宽按 `max` 归一。 */
function BarRow({ name, count, max }: { name: string; count: number; max: number }): React.JSX.Element {
  const w = Math.max(2, Math.round((count / Math.max(1, max)) * 100))
  return (
    <div className={css.barRow} title={`${name}：${String(count)} 条`}>
      <span className={css.barName}>{name}</span>
      <div className={css.barTrack}>
        <div className={css.barFill} style={{ width: `${String(w)}%` }} />
      </div>
      <span className={css.barCount}>{count}</span>
    </div>
  )
}

/** 内联 KPI：一个数字 + 一个标签。 */
function Kpi({ value, label, title }: { value: React.ReactNode; label: string; title?: string }): React.JSX.Element {
  return (
    <span className={css.kpi} title={title}>
      <span className={css.kpiValue}>{value}</span>
      <span className={css.kpiLabel}>{label}</span>
    </span>
  )
}

/**
 * Render the moments insights panel.
 * @returns the insights element tree.
 */
export function MomentsInsightsPanel(): React.JSX.Element {
  /* 2026-10-03 推广批次 2：改用共用 useFreshData —— 打开即查最新（不再预填缓存），
     成功写回缓存；失败才回退缓存并由 hook 在 error 里标注「以下为本地缓存（可能不是最新）」。 */
  const load = useCallback((): Promise<MomentsInsightsSnapshot> => apiGetMomentsInsights(), [])
  const { data, loading, error, reload } = useFreshData<MomentsInsightsSnapshot>('moments-insights', load)
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费。
  useWechatDataUpdated(() => { if (!data) void reload() })

  const geo = data?.geo
  const topItems = data?.topItems
  const placeMax = geo?.places[0]?.count ?? 1

  return (
    <div className={kitCss.panelShell}>
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <LoadingState variant="compact" label="统计中…" />}

      {data && !loading && (
        <>
          {/* 内联 KPI 条：标题已由分段条承载，这里不再重复「朋友圈洞察」。 */}
          <div className={css.insightBar}>
            <div className={css.kpiRow}>
              <Kpi value={data.posts} label="发布" />
              <Kpi value={data.likes} label="获赞" />
              <Kpi value={data.comments} label="评论" />
              <Kpi value={geo?.pointList?.length ?? 0} label="定位点" />
              <Kpi value={data.today.length} label="那年今天" />
              <Kpi value={topItems?.unread ?? 0} label="未读提醒" title="「朋友的新动态」提醒里还没看的条数" />
              <Kpi value={topItems?.users ?? 0} label="提醒人数" title="「朋友的新动态」提醒覆盖的人数" />
            </div>
            <button type="button" className={css.refreshBtn} onClick={() => { void reload() }} disabled={loading}>{loading ? '刷新中…' : '刷新'}</button>
          </div>

          {/* 两行栅格：互动 Top + 热词 / 月度分布 + 足迹。 */}
          <div className={css.gridTop}>
            <Card
              title="互动 Top"
              extra={<span className={kitCss.textCaption}>{topItems ? `${String(topItems.rows)} 条提醒` : ''}</span>}
            >
              <div className={css.topCols}>
                <div className={css.topCol}>
                  <div className={css.subTitle}>点赞最多</div>
                  {data.likedBy.length === 0 ? <div className={css.empty}>暂无点赞数据</div> : (
                    <div className={css.list}>
                      {data.likedBy.slice(0, 5).map(r => (
                        <Row key={r.username || r.nickname} name={r.nickname || r.username} count={r.count} />
                      ))}
                    </div>
                  )}
                </div>
                <div className={css.topCol}>
                  <div className={css.subTitle}>评论最多</div>
                  {data.commenters.length === 0 ? <div className={css.empty}>暂无评论数据</div> : (
                    <div className={css.list}>
                      {data.commenters.slice(0, 5).map(r => (
                        <Row key={r.username || r.nickname} name={r.nickname || r.username} count={r.count} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>

            <WordCloudCard scope="moments" fill />
          </div>

          <div className={css.gridBottom}>
            <Card title="月度发布分布" extra={<span className={kitCss.textCaption}>按年分组 · 12 个月</span>}>
              <MonthlyByYear monthly={data.monthly} />
            </Card>

            <Card
              title="朋友圈足迹"
              extra={<span className={kitCss.textCaption}>{geo ? `${String(geo.pointList?.length ?? 0)} 个定位点` : ''}</span>}
            >
              {!geo || (geo.pointList?.length ?? 0) === 0 ? (
                <div className={css.empty}>没有带位置的朋友圈，无法绘制足迹</div>
              ) : (
                <div className={css.footWrap}>
                  <div className={css.footMap}><FootprintMap points={geo.pointList} cities={geo.cities.length} /></div>
                  <div className={css.footSide}>
                    <div className={css.subTitle}>打卡最多的地方</div>
                    <div className={css.list}>
                      {geo.places.slice(0, 6).map(p => (
                        <BarRow key={p.name} name={p.name} count={p.count} max={placeMax} />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
