/**
 * 朋友圈洞察面板 — 我的朋友圈：发布/获赞/评论统计、互动榜、月度分布、热词、足迹。
 * 全部基于本机 sns.db 离线计算。
 *
 * 布局（2026-11-19 起：内联 KPI 条 + 等宽瀑布流画布上的 6 张卡）：
 *   ├ 内联 KPI 条（40–46px）：发布 / 获赞 / 评论 / 定位点 / 那年今天 / 未读提醒 / 提醒人数
 *   ├ 点赞最多        ← 画布卡
 *   ├ 评论最多        ← 画布卡
 *   ├ 朋友圈热词      ← 画布卡（词云）
 *   ├ 月度发布分布    ← 画布卡（热力格）
 *   ├ 朋友圈足迹      ← 画布卡（地图）
 *   └ 打卡最多的地方  ← 画布卡
 *
 * KPI 条留在画布外：它是「一眼看的几个数」的横条，不该变成可拖拽的卡。
 *
 * 为什么是 6 张独立卡而不是几张合并卡：本页每块内容都是**图形或榜单**，
 * 各自需要展示面积、高度互不相同（词云 320px、地图 220px、榜单约 10 行）。
 * 合进一张卡就得让它们共用高度 —— 旧的两行栅格正是这么做的，结果矮的那块下方一片空白。
 * 拆到画布上之后每张卡按内容取高、按最短列落位，用户还能各自拖动。
 */
import { useCallback } from 'react'
import { apiGetMomentsInsights } from '../api.ts'
import { useFreshData } from './use-fresh-data.ts'
import type { MomentsInsightsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { LoadingState } from '../ui/kit.tsx'
import { CardCanvas } from './card-canvas.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import { FootprintMap } from './FootprintMap.tsx'
import kitCss from '../ui/kit.module.css'
import css from './moments-insights.module.css'
import { useWechatDataUpdated } from './hooks.tsx'
import { WordCloudCard } from './WordCloudCard.tsx'
import { MonthlyByYear } from './moments-monthly.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'

/** 一行「名称 + 数字」的紧凑列表项。 */
function Row({ name, username, count, title, tone }: {
  name: string
  username?: string
  count: React.ReactNode
  title?: string
  tone?: 'warn'
}): React.JSX.Element {
  return (
    <div className={css.row} title={title}>
      {username
        ? <IdentityName className={css.rowName} name={name} username={username} size={20}>{name}</IdentityName>
        : <span className={css.rowName}>{name}</span>}
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
    <div className={`${kitCss.panelShell} ${css.panel}`}>
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

          {/* 四张卡改用**等宽瀑布流画布**（2026-11-19，与「年度报告」「数据总览」同一套）。
              旧写法是两行 `gridTop`/`gridBottom` + `flex: 1 1 0` 拉伸：卡片被拉成等宽等高，
              结果「互动 Top」只有 10 行却占满整行高度、热词卡下方大片空白（用户截图）。
              画布下每张卡按内容取高、按最短列落位。

              2026-11-19 二次调整（用户要求）：
                · 「互动 Top」拆成「点赞最多」「评论最多」两张独立卡 —— 一个卡里塞两个榜，
                  两张榜的落位被绑死、谁也不能单独拖动或换列；拆开后各自按内容取高。
                · 「朋友圈足迹」拆成「朋友圈足迹（地图）」与「打卡最多的地方」两张卡 ——
                  地图是固定 220px 高的 ECharts 画布，打卡榜是纯文本排行，
                  两者本来就没有共享的尺寸约束。 */}
          <CardCanvas year={0} scope="moments-insights">
            <CanvasCard
              id="moments-liked"
              title="点赞最多"
              extra={<span className={kitCss.textCaption}>{topItems ? `${String(topItems.rows)} 条提醒` : ''}</span>}
            >
              {data.likedBy.length === 0 ? <div className={css.empty}>暂无点赞数据</div> : (
                <div className={css.list}>
                  {data.likedBy.slice(0, 5).map(r => (
                    <Row
                      key={r.username || r.nickname}
                      name={withEnterprise(r.nickname || r.username, r.enterpriseName)}
                      username={r.username}
                      count={r.count}
                    />
                  ))}
                </div>
              )}
            </CanvasCard>

            <CanvasCard id="moments-commented" title="评论最多">
              {data.commenters.length === 0 ? <div className={css.empty}>暂无评论数据</div> : (
                <div className={css.list}>
                  {data.commenters.slice(0, 5).map(r => (
                    <Row
                      key={r.username || r.nickname}
                      name={withEnterprise(r.nickname || r.username, r.enterpriseName)}
                      username={r.username}
                      count={r.count}
                    />
                  ))}
                </div>
              )}
            </CanvasCard>

            {/* 词云用**显式高度**而不是 `fill`：`fill` 靠「量卡片根高度」反推舞台高度，
                而画布卡的高度又由 `CardCanvas` 量 `offsetHeight` 得到 —— 会形成循环依赖。
                320px 是词云铺得开、又不至于让卡独占一屏的值。
                占 2 列：词云是唯一「越宽越好读」的图形 —— 同样词量下两列宽时字号能大一档、
                排布也更接近圆形而不是一根竖条。窄屏下画布会自动收敛到容器列数。 */}
            <WordCloudCard scope="moments" canvasId="moments-words" canvasCols={2} height={320} />

            <CanvasCard id="moments-monthly" title="月度发布分布" extra={<span className={kitCss.textCaption}>按年分组 · 12 个月</span>}>
              <MonthlyByYear monthly={data.monthly} />
            </CanvasCard>

            {/* 足迹拆两张卡：地图（固定 220px 高的 ECharts 画布）与打卡榜没有共享的尺寸约束。
                地图占 2 列：它是横长的地理图形，一列宽时只剩一条窄缝，省份与标注都看不清。 */}
            <CanvasCard
              id="moments-map"
              cols={2}
              title="朋友圈足迹"
              extra={<span className={kitCss.textCaption}>{geo ? `${String(geo.pointList?.length ?? 0)} 个定位点` : ''}</span>}
            >
              {!geo || (geo.pointList?.length ?? 0) === 0 ? (
                <div className={css.empty}>没有带位置的朋友圈，无法绘制足迹</div>
              ) : (
                <div className={css.footMap}><FootprintMap points={geo.pointList} cities={geo.cities.length} height={420} /></div>
              )}
            </CanvasCard>

            <CanvasCard
              id="moments-places"
              title="打卡最多的地方"
              extra={<span className={kitCss.textCaption}>{geo ? `${String(geo.places.length)} 个地点` : ''}</span>}
            >
              {!geo || geo.places.length === 0 ? (
                <div className={css.empty}>没有带位置的朋友圈，无打卡排行</div>
              ) : (
                <div className={css.list}>
                  {geo.places.slice(0, 6).map(p => (
                    <BarRow key={p.name} name={p.name} count={p.count} max={placeMax} />
                  ))}
                </div>
              )}
            </CanvasCard>
          </CardCanvas>
        </>
      )}
    </div>
  )
}
