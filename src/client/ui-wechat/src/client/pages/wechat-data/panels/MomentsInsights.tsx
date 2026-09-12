/**
 * 朋友圈洞察面板 — 我的朋友圈：发布/获赞/评论统计、互动 Top、月度分布、
 * 那年今天。全部基于本机 sns.db 离线计算。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetMomentsInsights, readRenderCache, writeRenderCache } from '../api.ts'
import type { MomentsInsightsSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import { FootprintMap } from './FootprintMap.tsx'
import kitCss from '../ui/kit.module.css'
import css from './moments-insights.module.css'
import { useWechatDataUpdated } from './hooks.tsx'

function fmtTs(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Render the moments insights panel.
 * @returns the insights element tree.
 */
export function MomentsInsightsPanel(): React.JSX.Element {
  const [data, setData] = useState<MomentsInsightsSnapshot | null>(() => readRenderCache<MomentsInsightsSnapshot>('moments-insights'))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const fresh = await apiGetMomentsInsights()
      setData(fresh)
      writeRenderCache('moments-insights', fresh)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // 数据落地后重载：冷启动时后端同步要跑 2–3 分钟，期间首次请求可能返回空快照，
  // 页面会停在「0 / 暂无数据」而并非真的没有数据（实测该事件在同步期约每 10 秒一次）。
  // 仅在**当前还没有数据**时重载：面板一旦拿到数据就不再重复付费，
  // 也避免那几个「loading 时隐藏内容」的面板每约 10 秒白闪一次。
  useWechatDataUpdated(() => { if (!data) void load() })

  const maxMonthly = data && data.monthly.length > 0 ? Math.max(...data.monthly.map(m => m.count)) : 1

  return (
    <div className={kitCss.panelShell}>
      <PanelHeader title="朋友圈洞察" desc="我的发布/获赞/评论统计 · 互动 Top · 那年今天" />

      {/* 正文独立滚动：页头保持可见（见 kit.module.css 的 .panelBody） */}
      <div className={kitCss.panelBody}>
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <div className={kitCss.emptyInline}>统计中…</div>}

      {data && !loading && (
        <>
          <StatGrid>
            <StatCard icon="📝" value={data.posts} label="发布" />
            <StatCard icon="❤️" value={data.likes} label="获赞" tone="green" />
            <StatCard icon="💬" value={data.comments} label="评论" tone="purple" />
          </StatGrid>

          <div className={kitCss.cardGrid}>
            <Card title="点赞最多的人">
              {data.likedBy.length === 0 ? <div className={kitCss.emptyInline}>暂无点赞数据</div> : (
                <div className={css.list}>
                  {data.likedBy.slice(0, 5).map(r => (
                    <div key={r.username || r.nickname} className={css.row}>
                      <span className={css.rowName}>{r.nickname || r.username}</span>
                      <span className={css.rowCount}>{r.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="评论最多的人">
              {data.commenters.length === 0 ? <div className={kitCss.emptyInline}>暂无评论数据</div> : (
                <div className={css.list}>
                  {data.commenters.slice(0, 5).map(r => (
                    <div key={r.username || r.nickname} className={css.row}>
                      <span className={css.rowName}>{r.nickname || r.username}</span>
                      <span className={css.rowCount}>{r.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className={kitCss.cardGrid}>
            <Card
              title="新动态提醒"
              extra={<span className={kitCss.textCaption}>{data.topItems ? `${data.topItems.rows} 条提醒 · ${data.topItems.users} 人` : ''}</span>}
            >
              {!data.topItems || data.topItems.rows === 0 ? (
                <div className={kitCss.emptyInline}>本机没有「朋友的新动态」提醒记录</div>
              ) : (
                <div className={css.list}>
                  <div className={css.row}>
                    <span className={css.rowName}>还没看的提醒</span>
                    <span className={css.rowCount} data-tone={data.topItems.unread > 0 ? 'warn' : undefined}>{data.topItems.unread}</span>
                  </div>
                  <div className={css.row}>
                    <span className={css.rowName} title="提醒过、但现在时间线里已经没有这条（被作者删除或设为私密）">已不可见的提醒</span>
                    <span className={css.rowCount}>{data.topItems.vanished}</span>
                  </div>
                  <div className={`${css.todayRow} ${css.todayRowPad}`}>
                    <span className={kitCss.textCaption}>
                      口径：来自 sns.db 的 SnsTopItem_1（微信自己的提醒清单）；本机该表的 summary 字段恒为空，
                      last_read_time 全量同一时刻，故不据此推算阅读延迟。
                    </span>
                  </div>
                </div>
              )}
            </Card>

            <Card title="最常进入提醒的人" extra={<span className={kitCss.textCaption}>按提醒条数</span>}>
              {!data.topItems || data.topItems.top.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无数据</div>
              ) : (
                <div className={css.list}>
                  {data.topItems.top.slice(0, 8).map(r => (
                    <div key={r.username} className={css.row} title={r.username}>
                      <span className={css.rowName}>{r.name || r.username}</span>
                      <span className={css.rowCount}>
                        {r.count}
                        {r.unread > 0 && <span className={css.badgeWarn}>未读 {r.unread}</span>}
                        {r.vanished > 0 && <span className={css.badgeMuted}>消失 {r.vanished}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className={kitCss.cardGrid}>
            <Card
              title="朋友圈足迹"
              extra={<span className={kitCss.textCaption}>{data.geo ? `${data.geo.points} 条带坐标` : ''}</span>}
            >
              {!data.geo || data.geo.points === 0 ? (
                <div className={kitCss.emptyInline}>没有带位置的朋友圈</div>
              ) : (
                <div className={css.list}>
                  <div className={css.row}>
                    <span className={css.rowName}>到过的城市</span>
                    <span className={css.rowCount}>{data.geo.cities.length}</span>
                  </div>
                  {data.geo.countries.length > 0 && (
                    <div className={css.row}>
                      <span className={css.rowName}>国家 / 地区</span>
                      <span className={css.rowCount}>{data.geo.countries.map(c => c.country).join(' · ')}</span>
                    </div>
                  )}
                  {data.geo.cities.slice(0, 8).map(c => (
                    <div key={c.city} className={css.monthRow}>
                      <span className={css.monthLabel}>{c.city}</span>
                      <div className={css.monthTrack}>
                        <div className={css.monthFill} style={{ width: `${Math.round((c.count / Math.max(1, data.geo!.cities[0]?.count ?? 1)) * 100)}%` }} />
                      </div>
                      <span className={css.monthCount}>{c.count}</span>
                    </div>
                  ))}
                  <div className={`${css.todayRow} ${css.todayRowPad}`}>
                    <span className={kitCss.textCaption}>
                      口径：位置取自每条朋友圈 XML 的 &lt;location city/poiName/经纬度&gt;；
                      微信把 latitude/longitude 两个属性写反了（本机 490 条里 485 条 latitude&gt;90），后端已换回。
                    </span>
                  </div>
                </div>
              )}
            </Card>

            <Card title="打卡最多的地方" extra={<span className={kitCss.textCaption}>按朋友圈条数</span>}>
              {!data.geo || data.geo.places.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无数据</div>
              ) : (
                <div className={css.list}>
                  {data.geo.places.slice(0, 8).map(p => (
                    <div key={p.name} className={css.row} title={p.name}>
                      <span className={css.rowName}>{p.name}</span>
                      <span className={css.rowCount}>{p.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card
            title="足迹地图"
            extra={<span className={kitCss.textCaption}>{data.geo ? `${data.geo.pointList?.length ?? 0} 个定位点` : ''}</span>}
          >
            {!data.geo || (data.geo.pointList?.length ?? 0) === 0 ? (
              <div className={kitCss.emptyInline}>没有带位置的朋友圈，无法绘制足迹</div>
            ) : (
              <FootprintMap points={data.geo.pointList} cities={data.geo.cities.length} />
            )}
          </Card>

          <div className={kitCss.cardGrid}>
            <Card title="月度发布分布">
              {data.monthly.length === 0 ? <div className={kitCss.emptyInline}>暂无发布数据</div> : (
                <div className={css.monthly}>
                  {data.monthly.map(m => (
                    <div key={m.month} className={css.monthRow}>
                      <span className={css.monthLabel}>{m.month}</span>
                      <div className={css.monthTrack}><div className={css.monthFill} style={{ width: `${Math.round((m.count / maxMonthly) * 100)}%` }} /></div>
                      <span className={css.monthCount}>{m.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title="那年今天">
              {data.today.length === 0 ? <div className={kitCss.emptyInline}>今天没有历史朋友圈</div> : (
                <div className={css.todayList}>
                  {data.today.map(t => (
                    <div key={t.tid} className={css.todayRow}>
                      <span className={css.todayTime}>{fmtTs(t.ts)}</span>
                      <span className={css.todayText}>{t.text || '（无文字）'}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
      </div>
    </div>
  )
}
