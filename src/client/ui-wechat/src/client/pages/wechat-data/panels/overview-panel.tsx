/**
 * `Overview.tsx` 的「总览面板本体（消费上述模块）」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module overview-panelx
 */

import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import {
  apiExportAllSessions,
  apiGetLedger,
  apiGetOverview,
  apiGetOverviewInsights,
  apiGetStorageStats,
  apiGetAvatar,
} from '../api.ts'
import { LazyMount, useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { CalendarHeatmap } from './CalendarHeatmap.tsx'
import { RegionBoard } from './RegionBoard.tsx'
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'
import { fmtBytes, fmtClockMs } from '../utils/format.ts'
import { WorldMapPanel, buildOverviewReport, deltaArrow, downloadText, exportElementImage } from './overview-export.ts'
import { AuthorAvatar, CACHE_BASE, CACHE_INSIGHTS, CACHE_LEDGER, CACHE_STOR, CACHE_TIME, CARDS, MSG_BUCKETS, OvSection, SkeletonOverview, readCache, writeCache } from './overview-parts.tsx'

/**
 * Render the WeChat data overview panel (space-capsule cockpit).
 * @param props - navigation, chat and moments deep-link callbacks.
 * @returns the overview element tree.
 */
export function OverviewPanel({ onNavigate, onOpenChat, onOpenMoments }: {
  onNavigate?: (tab: string) => void
  onOpenChat?: (username: string) => void
  onOpenMoments?: (username: string) => void
} = {}): React.JSX.Element {
  // 调试：URL 带 ?skeleton=1 时强制展示骨架屏（截图/视觉验收用）。
  const debugSkeleton = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('skeleton') === '1'
  const [data, setData] = useState<OverviewSnapshot | null>(() => readCache(CACHE_BASE) as OverviewSnapshot | null)
  const [ins, setIns] = useState<OverviewInsights | null>(() => readCache(CACHE_INSIGHTS) as OverviewInsights | null)
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(() => readCache(CACHE_LEDGER) as LedgerSnapshot | null)
  const [stor, setStor] = useState<StorageSnapshot | null>(() => readCache(CACHE_STOR) as StorageSnapshot | null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 6000 / 2500)` 已由 hook 统一管理。
  // 失败类提示改前不带定时器（一直留着），所以走 hold 而不是 flash。
  const { notice, flash, hold } = useTransientNotice(6000)
  const [lastUpdated, setLastUpdated] = useState<number | null>(() => readCache(CACHE_TIME) as number | null)
  const [done, setDone] = useState(false)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const load = async (): Promise<void> => {
    const hadData = data !== null
    if (hadData) setRefreshing(true)
    else setLoading(true)
    try {
      const [base, insw] = await Promise.all([
        apiGetOverview(),
        apiGetOverviewInsights(),
      ])
      setData(base)
      setIns(insw)
      writeCache(CACHE_BASE, base)
      writeCache(CACHE_INSIGHTS, insw)
      setError(null)
      const now = Date.now()
      setLastUpdated(now)
      writeCache(CACHE_TIME, now)
      if (hadData) {
        setDone(true)
        if (doneTimer.current) clearTimeout(doneTimer.current)
        doneTimer.current = setTimeout(() => { setDone(false) }, 1600)
      }
    } catch (e) {
      if (data === null) setError((e as Error).message)
      else hold('后台刷新失败，当前显示缓存数据：' + (e as Error).message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
    // 资金/存储等较重扩展数据在后台慢慢更新并持久化，不阻塞核心刷新。
    try {
      const [lg, st] = await Promise.all([
        apiGetLedger(),
        apiGetStorageStats(),
      ])
      setLedger(lg)
      setStor(st)
      writeCache(CACHE_LEDGER, lg)
      writeCache(CACHE_STOR, st)
    } catch {
      /* 保留已有缓存/数据 */
    }
  }

  useEffect(() => { void load() }, [])
  useWechatDataUpdated(() => { void load() })
  // 朋友圈活跃作者头像改为逐行懒加载：作者卡片进入可视区附近时才请求头像。

  const go = (tab: string): void => { onNavigate?.(tab) }
  const openChat = (username: string): void => { onOpenChat?.(username) }
  const openMoments = (username: string): void => { onOpenMoments?.(username) }
  const topBase = (ins?.relations.top[0]?.count ?? 1) || 1
  const extras = ins?.extras

  const exportAll = async (): Promise<void> => {
    setExporting(true)
    try {
      const r = await apiExportAllSessions()
      flash('已归档 ' + String(r.count) + ' 条消息 → ' + r.path)
    } catch (e) {
      hold('归档失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }
  const doExport = async (format: 'md' | 'json' | 'png' | 'jpg'): Promise<void> => {
    if (!data) return
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    if (format === 'json') {
      const payload = {
        exportedAt: now.toISOString(),
        updatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        snapshot: data,
        insights: ins,
        ledger,
        storage: stor,
      }
      downloadText(`微信数据总览-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json')
    } else if (format === 'md') {
      downloadText(`微信数据总览报告-${stamp}.md`, buildOverviewReport(data, ins, ledger, stor, now, lastUpdated), 'text/markdown;charset=utf-8')
    } else {
      setExportOpen(false)
      await new Promise((r) => { setTimeout(r, 40) })
      const root = rootRef.current
      if (root) {
        try {
          await exportElementImage(root, format, `微信数据总览-${stamp}.${format}`)
        } catch (e) {
          hold('图片导出失败: ' + (e as Error).message)
          return
        }
      }
    }
    flash('已导出报告', 2500)
  }

  const ls = ledger?.summary
  const largeFiles = stor?.large_files?.slice(0, 4) ?? []
  const warnCount = ledger?.warnings.length ?? 0

  return (
    <div ref={rootRef} className={refreshing ? `${css.root} ${css.updating}` : css.root}>
      {refreshing && <div className={css.scanbar} />}
      {/* 机舱头部 */}
      <PanelHeader
        title="微信数据总览"
        desc={(
          <>
            太空舱 · 本机微信数据资产一屏纵览
            {refreshing && <><span className={css.spinner} /> 同步中…</>}
            {lastUpdated ? ` · 最后更新 ${fmtClockMs(lastUpdated)}` : ''}
          </>
        )}
        actions={(
          <>
            <button type="button" className={css.refresh} onClick={() => { void exportAll() }} disabled={exporting}>
              {exporting ? '归档中…' : '导出全部会话 ZIP'}
            </button>
            <button type="button" className={css.refresh} onClick={() => { void load() }} disabled={loading || refreshing}>
              {(loading || refreshing)
                ? <><span className={css.spinner} /> {loading ? '统计中…' : '更新中…'}</>
                : done ? '✓ 已更新' : '刷新'}
            </button>
            <div className={css.exportWrap}>
              <button type="button" className={css.refresh} onClick={() => { setExportOpen(v => !v) }} disabled={!data}>
                导出 ▾
              </button>
              {exportOpen && (
                <>
                  <div className={css.exportBackdrop} onClick={() => { setExportOpen(false) }} />
                  <div className={css.exportMenu}>
                    <button type="button" className={css.exportItem} onClick={() => { void doExport('md'); setExportOpen(false) }}>Markdown 报告</button>
                    <button type="button" className={css.exportItem} onClick={() => { void doExport('json'); setExportOpen(false) }}>JSON 数据</button>
                    <button type="button" className={css.exportItem} onClick={() => { void doExport('png'); setExportOpen(false) }}>PNG 图片</button>
                    <button type="button" className={css.exportItem} onClick={() => { void doExport('jpg'); setExportOpen(false) }}>JPG 图片</button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      />

      {/* 正文独立滚动：页头（含导出菜单）保持可见（见 kit.module.css 的 .panelBody） */}
      <div className={kitCss.panelBody}>
      {notice && <div className={css.error}>{notice}</div>}
      {!debugSkeleton && error && data !== null && <div className={css.error}>后台刷新失败（正在展示缓存数据）</div>}
      {data === null || debugSkeleton ? <SkeletonOverview /> : null}

      {!debugSkeleton && data !== null && (
        <>
          {/*
            核心指标 + 消息构成：合并为一块「资产指标条」面板。
            第一行 8 格指标（色调图标块 + 大数字 + 标签，格间 1px 分隔线）；
            第二行消息收发构成。整块约 95px，取代原先 2×4 大卡（204px）+
            独立收发条（40px）—— 这样「世界板块 · 好友地区」才能在首屏完整可见。
          */}
          <div className={css.ovHero}>
            <div className={css.ovHeroStats}>
              {CARDS.map((card) => {
                const value = card.key === 'storage'
                  ? fmtBytes(data.storage.total_size)
                  : (data[card.key as keyof OverviewSnapshot] as number).toLocaleString()
                const sub = card.key === 'storage' ? `${data.storage.total_count.toLocaleString()} 项` : undefined
                const tone = card.key === 'moments' ? 'purple'
                  : card.key === 'official' ? 'blue'
                    : card.key === 'storage' ? 'green' : 'cyan'
                return (
                  <button key={card.key} type="button" className={css.ovHeroStat} data-tone={tone} onClick={() => { go(card.tab) }} title={`查看${card.label}`}>
                    <span className={css.ovHeroIcon}>{card.icon}</span>
                    <span className={css.ovHeroText}>
                      <span className={css.ovHeroValue}>{value}</span>
                      <span className={css.ovHeroLabel}>{card.label}{sub && <em className={css.ovHeroSub}> · {sub}</em>}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {/*
              收发构成：这条口径来自 getOverviewInsights（用 real_sender_id 经分片 Name2Id 解析方向）。
              以前它只出现在「导出 Markdown 报告」里，而报告里写的是「发出 0」——
              界面上没人看得见，所以坏了很久没人发现（见 docs/wechat-schema.md §B.19）。
              现在把三个数字直接显示出来：界面上看得见，回归就没法藏。
            */}
            {ins && (
              <div className={css.ovHeroMix}>
                <span className={css.ovHeroMixIcon}>✉️</span>
                <span className={css.ovHeroMixTitle}>
                  消息 {ins.messages.total.toLocaleString()} 条 · 发出 <b>{ins.messages.sent.toLocaleString()}</b> / 收到 <b>{ins.messages.received.toLocaleString()}</b>
                </span>
                <span className={css.ovHeroMixSub}>
                  文本 {ins.messages.text.toLocaleString()} · 图片 {ins.messages.image.toLocaleString()} · 视频 {ins.messages.video.toLocaleString()} · 链接卡片 {ins.messages.rich.toLocaleString()} · 系统 {ins.messages.system.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          <div className={css.ovGrid}>
            <OvSection span={css.ovSpan12} icon="world" title="世界板块 · 好友地区">
              {/* 地图 + 省份/城市两栏榜单。此前这里只有地图：实测画布 520px 高、两侧另有两列
                  240px 的头像栏，但 228 位好友几乎都在同一个国家 —— 除了一小块紫色，
                  整块卡片都是空的。榜单把这半张卡片的面积换成真实数据（同源树，不新增查询）。 */}
              <div className={css.worldBoard}>
                <div className={css.worldMapBox}>
                  <LazyMount placeholder={<div className={kitCss.emptyInline}>地图进入可视区后加载…</div>}>
                    <Suspense fallback={<div className={kitCss.emptyInline}>地图资源加载中…</div>}>
                      <WorldMapPanel />
                    </Suspense>
                  </LazyMount>
                </div>
                <RegionBoard />
              </div>
            </OvSection>

            {extras && (
              <>
                <OvSection span={css.ovSpan4} className={css.ovTrend} icon="trend" title="轨道趋势">
                  <div className={css.trendGrid}>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.messages7.toLocaleString()}</span><span className={kitCss.textCaption}>近 7 天消息</span><span className={deltaArrow(extras.trends.messages7Delta).cls}>{deltaArrow(extras.trends.messages7Delta).text}</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.messages30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天消息</span><span className={deltaArrow(extras.trends.messages30Delta).cls}>{deltaArrow(extras.trends.messages30Delta).text}</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.activeContacts30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天活跃好友</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.activeGroups30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天活跃群</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{fmtBytes(extras.trends.storageBytes30)}</span><span className={kitCss.textCaption}>近 30 天新增媒体</span></div>
                  </div>
                </OvSection>
                {extras.heatmap.length > 0 && (
                  <OvSection span={css.ovSpan8} className={css.ovHeat} icon="heat" title="消息热度 · 近 90 天">
                    <CalendarHeatmap data={extras.heatmap} />
                  </OvSection>
                )}
              </>
            )}

            <OvSection span={css.ovSpan6} icon="storage" title={`存储构成 Top ${data.storage.categories.length}`} action={<button type="button" className={css.panelGo} onClick={() => { go('storage') }}>详情 →</button>}>
              {data.storage.categories.length === 0
                ? <div className={kitCss.emptyInline}>暂无媒体资源记录</div>
                : <div className={css.catList}>{[...data.storage.categories]
                    // 按体积降序：条形是按 size 画的，后端给的顺序按条数排，
                    // 不重排就会出现"第一行不是最长条"的别扭观感。
                    .sort((a, b) => b.size - a.size)
                    .map(c => (
                    <div key={c.label} className={css.cat}>
                      <div className={css.catRow}><span className={css.catLabel}>{c.label}</span><span className={css.catMeta}>{c.count.toLocaleString()} 项 · {fmtBytes(c.size)}</span></div>
                      <div className={css.bar}><div className={css.barFill} style={{ width: `${(c.size / Math.max(1, data.storage.categories[0]?.size ?? 1)) * 100}%` }} /></div>
                    </div>
                  ))}</div>}
            </OvSection>

            {/* 行内配对按**内容体量**而不是主题：6 栅格卡片共 8 张，自然高度分别是
                约 300(存储构成 7 条) / 270(撤回与风险) / 130(存储清理) / 130(资金) /
                464(交互画像) / 464(关系浓度) / 377(内容构成) / 377(数据健康)。
                按 300+270、130+130 配对，行内两张卡高度几乎相等，不会再靠拉伸去填，
                格子也不会被拉成"空盒子"。 */}
            {/* 撤回痕迹 + 风险提示合并为一张 6 栅格卡片：原先「风险与隐私提示」是 5 栅格底栏里
                只有一行文字的小卡（实测内容 20px、卡高 85px，几乎全是内边距）。 */}
            <OvSection span={css.ovSpan6} icon="revoke" title="撤回消息痕迹 · 风险提示" action={<button type="button" className={css.panelGo} onClick={() => { go('revoked') }}>详情 →</button>}>
              <div className={css.revoke}>
                <span className={css.revokeValue}>{data.revoked.toLocaleString()}</span>
                <span className={kitCss.textMeta}>条被撤回消息的元数据痕迹（发送者/时间/类型可查）</span>
                <p className={css.revokeNote}>微信 4.x 防撤回机制在本地保留的删除缓存，可用于回顾"谁撤回了什么"。</p>
              </div>
              <div className={css.metricGrid}>
                <div className={css.metric}><span className={css.metricValue}>{data.revoked.toLocaleString()}</span><span className={kitCss.textCaption}>撤回消息（可回溯）</span></div>
                <div className={css.metric}><span className={css.metricValue}>{warnCount}</span><span className={kitCss.textCaption}>转账/红包异常</span></div>
              </div>
              <p className={css.revokeNote}>建议定期运行 <button type="button" className={css.panelGo} onClick={() => { go('privacytrust') }}>隐私体检</button>：扫描敏感信息、资金往来与文件存储占用。</p>
            </OvSection>

            <OvSection span={css.ovSpan6} icon="storage" title="存储清理建议" action={<button type="button" className={css.panelGo} onClick={() => { go('storage') }}>详情 →</button>}>
              <div className={css.metricGrid}>
                <div className={css.metric}><span className={css.metricValue}>{fmtBytes(stor?.total_size ?? 0)}</span><span className={kitCss.textCaption}>媒体占用</span></div>
                <div className={css.metric}><span className={css.metricValue}>{(stor?.total_count ?? 0).toLocaleString()}</span><span className={kitCss.textCaption}>媒体项</span></div>
                <div className={css.metric}><span className={css.metricValue}>{largeFiles.length}</span><span className={kitCss.textCaption}>超大文件</span></div>
              </div>
            </OvSection>

            <OvSection span={css.ovSpan6} icon="ledger" title={`资金快照${ledger?.month ? ` · ${ledger.month}` : ''}`} action={<button type="button" className={css.panelGo} onClick={() => { go('ledger') }}>详情 →</button>}>
              {ls ? (
                <div className={css.metricGrid}>
                  <div className={css.metric}><span className={css.metricValue}>¥{ls.totalAmountIn.toFixed(2)}</span><span className={kitCss.textCaption}>收入</span></div>
                  <div className={css.metric}><span className={css.metricValue}>¥{ls.totalAmountOut.toFixed(2)}</span><span className={kitCss.textCaption}>支出</span></div>
                  <div className={css.metric}><span className={css.metricValue}>{ls.transfers.toLocaleString()}</span><span className={kitCss.textCaption}>转账次数</span></div>
                  <div className={css.metric}><span className={css.metricValue}>{ls.redpacketsSent + ls.redpacketsReceived}</span><span className={kitCss.textCaption}>红包收/发</span></div>
                </div>
              ) : <div className={kitCss.emptyInline}>暂无资金记录</div>}
            </OvSection>

            {ins && (
              <>
                <OvSection span={css.ovSpan6} className={css.ovTall} icon="insight" title="交互画像 · 基于消息时间与类型">
                  <div className={css.metricGrid}>
                    <div className={css.metric}><span className={css.metricValue}>{ins.messages.total.toLocaleString()}</span><span className={kitCss.textCaption}>消息总数</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.time.activeDays}</span><span className={kitCss.textCaption}>活跃天数</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.time.spanDays}</span><span className={kitCss.textCaption}>时间跨度(天)</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.time.busyHour}:00</span><span className={kitCss.textCaption}>最忙时段 · {ins.time.busyCount.toLocaleString()} 条</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.time.deepNightPct}%</span><span className={kitCss.textCaption}>深夜(23-6点)占比</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.time.weekendPct}%</span><span className={kitCss.textCaption}>周末占比</span></div>
                  </div>
                  <div className={css.hourBars}>
                    {ins.time.hourDist.map((n, h) => {
                      const max = Math.max(1, ...ins.time.hourDist)
                      return <div key={h} className={css.hourCol} title={`${h}:00 · ${n} 条`}><div className={css.hourFill} style={{ height: `${Math.max(4, (n / max) * 100)}%` }} data-hot={n === ins.time.busyCount || undefined} /><span className={css.hourLabel}>{h}</span></div>
                    })}
                  </div>
                </OvSection>
                <OvSection span={css.ovSpan6} className={css.ovTall} icon="relation" title="关系浓度 · 好友活跃与对话 Top">
                  <div className={css.metricGrid}>
                    <div className={css.metric}><span className={css.metricValue}>{ins.relations.total}</span><span className={kitCss.textCaption}>好友总数</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.relations.active}</span><span className={kitCss.textCaption}>有消息往来</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.relations.silent}</span><span className={kitCss.textCaption}>沉默好友(无消息)</span></div>
                    <div className={css.metric}><span className={css.metricValue}>{ins.relations.groupsWithMsg}</span><span className={kitCss.textCaption}>有消息的群</span></div>
                  </div>
                  {ins.relations.top.length > 0 && (
                    <div className={css.topList}>
                      {ins.relations.top.slice(0, 8).map((t, i) => (
                        <button key={t.username} type="button" className={css.topRow} onClick={() => { openChat(t.username) }} title={`与「${t.name}」的对话`}>
                          <span className={css.topRank}>{i + 1}</span>
                          <span className={css.topName}>{t.name}</span>
                          <div className={css.topTrack}><div className={css.topFill} style={{ width: `${(t.count / Math.max(1, ins.relations.top[0]?.count ?? 1)) * 100}%` }} /></div>
                          <span className={css.topCount}>{t.count} 条</span>
                        </button>
                      ))}
                    </div>
                  )}
                </OvSection>
              </>
            )}

            <OvSection span={css.ovSpan12} icon="moments" title="朋友圈活跃 Top 10" action={<button type="button" className={css.panelGo} onClick={() => { go('moments') }}>详情 →</button>}>
              {data.moments_authors.length === 0 ? <div className={kitCss.emptyInline}>暂无朋友圈活跃作者</div> : (
                <div className={css.authors}>
                  {data.moments_authors.slice(0, 10).map((a, i) => (
                    <button key={a.username} type="button" className={css.author} onClick={() => { openMoments(a.username) }} title={`${a.name} 共发布 ${a.posts} 条`}>
                      <span className={css.authorRank}>{i + 1}</span>
                      <LazyMount placeholder={<span className={css.authorAvatarFallback}>{(a.name || '?').slice(0, 1)}</span>} rootMargin="300px 0px"><AuthorAvatar author={a} /></LazyMount>
                      <span className={css.authorName}>{a.name}</span>
                      <span className={css.authorPosts}>{a.posts} 条</span>
                    </button>
                  ))}
                </div>
              )}
            </OvSection>

            {/* 末行：内容构成与资产 + 数据健康，各占 6 栅格。
                原先是一个 5 栅格的纵向列（内容构成 + 风险提示 + 数据健康），
                12 栅格里空着 7 栅格 —— 实测那一整块是 770×814px 的空白，是本面板最大的一处空档。
                现在两卡各 6 栅格并排，高度也接近（内容构成约 420px、数据健康约 400px）。 */}
            {ins && (
              <OvSection span={css.ovSpan6} icon="content" title="内容构成与资产">
                <div className={css.catList}>
                  {MSG_BUCKETS.map((x) => {
                    const n = ins.messages[x.key]
                    const max = Math.max(1, ins.messages.text)
                    return <div key={x.label} className={css.cat}><div className={css.catRow}><span className={css.catLabel}>{x.label}</span><span className={css.catMeta}>{n.toLocaleString()} 条</span></div><div className={css.bar}><div className={css.barFill} style={{ width: `${(n / max) * 100}%` }} /></div></div>
                  })}
                </div>
                <div className={css.assetGrid}>
                  <div className={css.assetItem}>
                    <span className={css.assetLabel}>朋友圈</span>
                    <span className={css.assetValue}>{ins.moments.total}</span>
                    <span className={css.assetHint}>图 {ins.moments.images} · 赞 {ins.moments.likes} · 评 {ins.moments.comments}</span>
                  </div>
                  <div className={css.assetItem}>
                    <span className={css.assetLabel}>收藏</span>
                    <span className={css.assetValue}>{ins.assets.favorites}</span>
                    <span className={css.assetHint}>条收藏内容</span>
                  </div>
                  <div className={css.assetItem}>
                    <span className={css.assetLabel}>表情</span>
                    <span className={css.assetValue}>{ins.assets.emoticons}</span>
                    <span className={css.assetHint}>个自定义表情</span>
                  </div>
                  <div className={css.assetItem}>
                    <span className={css.assetLabel}>文件</span>
                    <span className={css.assetValue}>{ins.assets.files}</span>
                    <span className={css.assetHint}>{fmtBytes(ins.assets.fileBytes)}</span>
                  </div>
                </div>
              </OvSection>
            )}
            {ins && (
              <OvSection span={css.ovSpan6} icon="health" title="数据健康">
                <div className={css.healthGrid}>
                  <div className={css.healthItem}><span className={css.healthValue}>{ins.health.dbFiles}</span><span className={kitCss.textCaption}>数据库文件</span></div>
                  <div className={css.healthItem}><span className={css.healthValue}>{fmtBytes(ins.health.dbBytes)}</span><span className={kitCss.textCaption}>解密数据体积</span></div>
                  <div className={css.healthItem}><span className={css.healthValue}>{ins.health.ok ? '正常' : '异常'}</span><span className={kitCss.textCaption}>数据可读性</span></div>
                  <div className={css.healthItem}>
                    {/* lastActive 后端已经 `toLocaleString('zh-CN')` 成字符串了（overview-insights.ts:325）。
                        早先这里当数字再乘 1000，结果是 NaN → 界面显示 Invalid Date。 */}
                    <span className={css.healthValue}>{ins.time.lastActive || '—'}</span>
                    <span className={kitCss.textCaption}>最近活跃</span>
                  </div>
                  {extras && (
                    <div className={css.healthItem}>
                      <span className={css.healthValue}>{extras.freshness.walPending ? '待落库' : '已落库'}</span>
                      <span className={kitCss.textCaption}>WAL 落库状态</span>
                    </div>
                  )}
                  <div className={css.healthItem}>
                    <span className={css.healthValue}>{(ins.time.activeDays)}/{ins.time.spanDays}</span>
                    <span className={kitCss.textCaption}>活跃天 / 时间跨度</span>
                  </div>
                </div>
              </OvSection>
            )}
          </div>
        </>
      )}
      </div>
    </div>
  )
}
