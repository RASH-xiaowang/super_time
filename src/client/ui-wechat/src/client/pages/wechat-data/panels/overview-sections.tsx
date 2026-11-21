/**
 * 「数据总览」的**卡片区块**（M22 拆分；2026-10-19 微信化精简）。
 *
 * ## 职责
 *
 * `overview-panel.tsx#OverviewPanel` 只负责取数、状态与版式编排；本文件放每张卡的
 * 内容与文案（按语义拆成独立组件）。
 *
 * ## 信息层级（2026-10-19 微信化改版）
 *
 * 默认只呈现 **6 张卡**：趋势 / 热度 / 关系与地区 / 内容 / 存储 / 资金，
 * 其余分析（交互画像、全局热词、好友地区榜、朋友圈作者、撤回、数据健康）
 * 收进「更多分析」折叠区 —— 页头不再堆 8 个 KPI + 14 张卡片墙。
 *
 *   · `KpiSection`              —— KPI 4 项（会话 / 消息 / 好友 / 群聊）
 *   · `TrendSection`            —— 近 7/30 天趋势
 *   · `HeatmapSection`          —— 消息热度 · 近 90 天
 *   · `RelationSection`         —— 关系浓度 + 世界地图 + 对话 Top
 *   · `ContentAssetsSection`    —— 消息构成 + 内容资产
 *   · `StorageCompositionSection` —— 存储构成 + 清理建议（媒体占用/超大文件）
 *   · `LedgerSection`           —— 资金快照
 *   · `MoreAnalysis`            —— 折叠的「更多分析」
 *   · `InteractionSection` / `WordCloudSection` / `MomentsAuthorsSection` /
 *     `RevokedSection` / `HealthSection` —— 折叠区内容
 *
 * ## 纪律
 *
 * · **数据口径/跳转回调/`data-*` 探针不变**：这里只负责卡片内容与文案，取数仍在面板本体。
 * · 卡片位置由调用点传入 Bootstrap `className`，属于面板级布局；本页不造栅格。
 * · 主色只出现在数值/选中/主按钮；不铺彩色底、不做渐变/发光。
 *
 * @module overview-sections
 */

import { Suspense, useState } from 'react'
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { LazyMount } from './hooks.tsx'
import { LoadingState, StatCard } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'
import { fmtBytes } from '../utils/format.ts'
import { deltaArrow, WorldMapPanel } from './overview-export.ts'
import { AuthorAvatar, CalendarHeatmapGate, CARDS, MSG_BUCKETS, OvIcon, OvSection } from './overview-parts.tsx'
import { WordCloudCard } from './WordCloudCard.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'

/**
 * KPI 条：4 项 kit `StatCard`（手机 2 列 / ≥sm 4 列）。
 *
 * 只剩会话 / 消息 / 好友 / 群聊 —— 公众号、朋友圈、收藏、表情、媒体占用
 * 分别在「内容」与「存储」卡里，避免同页重复统计。
 * 容器保留 `data-st-ov-hero` —— overview-layout-audit 的就绪判据靠它。
 */
export function KpiSection({ data, ins, onGo }: {
  data: OverviewSnapshot
  ins: OverviewInsights | null
  onGo: (tab: string) => void
}): React.JSX.Element {
  return (
    <div className="row g-2" data-st-ov-hero="1">
      {CARDS.map((card) => {
        const value = card.key === 'messages'
          ? (ins ? ins.messages.total.toLocaleString() : '—')
          : (data[card.key as keyof OverviewSnapshot] as number).toLocaleString()
        return (
          <div key={card.key} className="col-6 col-sm-3">
            <a
              className={css.ovKpiLink}
              href={`#${card.tab}`}
              title={`查看${card.label}`}
              onClick={(event) => { event.preventDefault(); onGo(card.tab) }}
            >
              <StatCard icon={<OvIcon name={card.icon} />} value={value} label={card.label} />
            </a>
          </div>
        )
      })}
    </div>
  )
}

/** 近 7/30 天趋势：消息、活跃好友/群、新增媒体。 */
export function TrendSection({ extras }: { extras: NonNullable<OverviewInsights['extras']> }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-trend" zone="近期" icon="trend" title="近 30 天趋势">
      <div className={css.trendGrid}>
        <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.messages7.toLocaleString()}</span><span className={kitCss.textCaption}>近 7 天消息</span><span className={deltaArrow(extras.trends.messages7Delta).cls}>{deltaArrow(extras.trends.messages7Delta).text}</span></div>
        <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.messages30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天消息</span><span className={deltaArrow(extras.trends.messages30Delta).cls}>{deltaArrow(extras.trends.messages30Delta).text}</span></div>
        <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.activeContacts30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天活跃好友</span></div>
        <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.activeGroups30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天活跃群</span></div>
        <div className={css.trendCell}><span className={css.metricValue}>{fmtBytes(extras.trends.storageBytes30)}</span><span className={kitCss.textCaption}>近 30 天新增媒体</span></div>
      </div>
    </OvSection>
  )
}

/** 消息热度 · 近 90 天（日历热力，按需加载）。 */
export function HeatmapSection({ heatmap }: { heatmap: Array<{ d: string; count: number }> }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-heat" zone="近期" icon="heat" title="消息热度 · 近 90 天">
      <div className={css.ovHeatBody}><CalendarHeatmapGate data={heatmap} /></div>
    </OvSection>
  )
}

/**
 * 世界地图（进入可视区后加载）。
 *
 * 2026-11-19 用户要求：**拆成独立卡片**，并且比其它卡大两倍。
 * 此前它并进「关系与地区」卡里当可视化，一列宽时地图框被压成一条窄横条
 * （实测约 220px 高、里面只有一句"滚轮缩放"），等于看不见。
 *
 * 现在它是独立卡、`cols={2}`（跨两列 ⇒ 宽度是普通卡的两倍）。
 * `WorldMapBody` 保留原样只作内容体，卡片外壳由 {@link WorldMapSection} 给。
 */
export function WorldMapBody(): React.JSX.Element {
  return (
    <div className={`${css.worldMapBox} ${css.worldMapFlex}`}>
      {/* `rootMargin` 1200px：手机档总览内容高达数千像素，600px 预取会「滚到了还没出来」。 */}
      <LazyMount rootMargin="1200px 0px" placeholder={<div className={kitCss.emptyInline}>地图进入可视区后加载…</div>}>
        <Suspense fallback={<LoadingState variant="compact" label="地图资源加载中…" />}>
          <WorldMapPanel />
        </Suspense>
      </LazyMount>
    </div>
  )
}

/**
 * 世界地图卡片（独立、跨两列、高度约两张普通卡）。
 * @returns 与其它卡同一套外壳，但宽高都翻倍。
 */
export function WorldMapSection(): React.JSX.Element {
  return (
    <OvSection canvasId="ov-worldmap" zone="人与关系" icon="world" title="好友世界地图" cols={2}>
      {/* 独立成卡后父容器不再是"关系卡"的 flex 列 —— 地图盒需要明确高度，
          否则 `.worldMapFlex` 的 `height:auto` 会把它塌成 min-height(220px)。 */}
      <div className={css.worldMapSolo}>
        <WorldMapBody />
      </div>
    </OvSection>
  )
}

/** 关系浓度 + 对话 Top（世界地图已拆成独立卡）。 */
/**
 * 关系规模（**只讲「我认识多少人」**）。
 *
 * 2026-11-19 拆分：原名「关系与地区」，装了三件不同的事 ——
 * 关系规模、好友世界地图、对话 Top 8。地图先拆出去（`WorldMapSection`），
 * 这里再把「对话 Top 8」拆成独立的 {@link TopChatsSection}。
 * 现在本卡只回答一个问题：**我有多少联系人、其中多少是活的**。
 * 名字也跟着改准 —— 地图与地区榜都搬走了，再叫「关系与地区」是假的。
 */
export function RelationSection({ ins }: { ins: OverviewInsights }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-relation" zone="人与关系" icon="relation" title="关系规模">
      <div className={css.metricGrid}>
        <div className={css.metric}><span className={css.metricValue}>{ins.relations.total}</span><span className={kitCss.textCaption}>好友总数</span></div>
        <div className={css.metric}><span className={css.metricValue}>{ins.relations.active}</span><span className={kitCss.textCaption}>有消息往来</span></div>
        <div className={css.metric}><span className={css.metricValue}>{ins.relations.silent}</span><span className={kitCss.textCaption}>沉默好友(无消息)</span></div>
        <div className={css.metric}><span className={css.metricValue}>{ins.relations.groupsWithMsg}</span><span className={kitCss.textCaption}>有消息的群</span></div>
      </div>
    </OvSection>
  )
}

/**
 * 对话 Top 8（**只讲「我跟谁聊得最多」**）。
 *
 * 从「关系与地区」拆出来：它是**排行**，与上面那组"规模统计"是两件事
 * （一个回答"认识多少"，一个回答"跟谁最密"）。混在一张卡里时，
 * 8 行排行把卡撑得很长，而 4 个指标只占顶部一小块。
 * @param props.onOpenChat - 点击某一行跳转到该会话。
 */
export function TopChatsSection({ ins, onOpenChat }: {
  ins: OverviewInsights
  onOpenChat: (username: string) => void
}): React.JSX.Element {
  const max = Math.max(1, ...ins.relations.top.map(x => x.count))
  return (
    <OvSection canvasId="ov-top-chats" zone="人与关系" icon="chat" title="对话 Top 8">
      {ins.relations.top.length === 0 ? (
        <div className={kitCss.emptyInline}>还没有可排行的会话</div>
      ) : (
        <div className={css.topList}>
          {ins.relations.top.slice(0, 8).map((t, i) => (
            <button key={t.username} type="button" className={css.topRow} onClick={() => { onOpenChat(t.username) }} title={`与「${withEnterprise(t.name, t.enterpriseName)}」的对话`}>
              <span className={css.topRank}>{i + 1}</span>
              <IdentityName
                className={css.topIdentity}
                textClassName={css.topName}
                name={t.name}
                username={t.username}
                size={24}
                title={t.username}
              >
                {withEnterprise(t.name, t.enterpriseName)}
              </IdentityName>
              <div className={css.topTrack}><div className={css.topFill} style={{ width: `${(t.count / max) * 100}%` }} /></div>
              <span className={css.topCount}>{t.count} 条</span>
            </button>
          ))}
        </div>
      )}
    </OvSection>
  )
}

/**
 * 消息构成（**只讲「消息本身怎么构成」**：收发比 + 类型分布）。
 *
 * 2026-11-19 拆分：原名「内容构成与资产」，装了两件互不相干的事 ——
 * 消息的构成（收发 / 图片 / 语音 / 文件…），以及**内容资产盘点**
 * （朋友圈、公众号、收藏、表情）。前者是"聊天里都是什么"，后者是"我攒了什么"，
 * 混在一起时用户看下半截会忘了上半截在说什么。资产已拆成 {@link AssetsOverviewSection}。
 */
export function ContentSection({ ins }: { ins: OverviewInsights }): React.JSX.Element {
  const total = Math.max(1, ins.messages.total)
  const sentPct = Math.min(100, Math.max(0, Math.round((ins.messages.sent / total) * 100)))
  const bucketMax = Math.max(1, ...MSG_BUCKETS.map(b => ins.messages[b.key] ?? 0))
  return (
    <OvSection canvasId="ov-content" zone="内容与存储" icon="content" title="消息构成">
      <div className={css.mixLine}>
        <span>消息 <b>{ins.messages.total.toLocaleString()}</b> 条</span>
        <span>发出 <b>{ins.messages.sent.toLocaleString()}</b></span>
        <span>收到 <b>{ins.messages.received.toLocaleString()}</b></span>
      </div>
      <span className={css.mixTrack} aria-hidden="true">
        <span className={css.mixSent} style={{ width: `${sentPct}%` }} />
        <span className={css.mixRecv} style={{ flex: 1 }} />
      </span>
      <div className={css.catList}>
        {MSG_BUCKETS.map((x) => {
          const n = ins.messages[x.key]
          return <div key={x.label} className={css.cat}><div className={css.catRow}><span className={css.catLabel}>{x.label}</span><span className={css.catMeta}>{n.toLocaleString()} 条</span></div><div className={css.bar}><div className={css.barFill} style={{ width: `${(n / bucketMax) * 100}%` }} /></div></div>
        })}
      </div>
    </OvSection>
  )
}

/**
 * 内容资产盘点（**只讲「我攒了什么」**：朋友圈 / 公众号 / 收藏 / 表情）。
 *
 * 从「内容构成与资产」拆出。这四项的共同点是**它们不是聊天消息**，
 * 而是这个账号里的长期沉淀（跨年累积），与"这一年发了多少条消息"完全不同层次。
 * @param props.official - 公众号/服务号会话数。
 */
export function AssetsOverviewSection({ ins, official }: {
  ins: OverviewInsights
  official: number
}): React.JSX.Element {
  return (
    <OvSection canvasId="ov-assets" zone="内容与存储" icon="asset" title="内容资产">
      <div className={css.assetGrid}>
        <div className={css.assetItem}>
          <span className={css.assetLabel}>朋友圈</span>
          <span className={css.assetValue}>{ins.moments.total}</span>
          <span className={css.assetHint}>图 {ins.moments.images} · 赞 {ins.moments.likes} · 评 {ins.moments.comments}</span>
        </div>
        <div className={css.assetItem}>
          <span className={css.assetLabel}>公众号/服务号</span>
          <span className={css.assetValue}>{official}</span>
          <span className={css.assetHint}>个公众号/服务号会话</span>
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
      </div>
    </OvSection>
  )
}

/** 存储构成 Top N（按体积排序）+ 媒体占用/超大文件。 */
export function StorageCompositionSection({ categories, stor, largeFileCount, onGo, className }: {
  categories: OverviewSnapshot['storage']['categories']
  stor: StorageSnapshot | null
  largeFileCount: number
  onGo: (tab: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <OvSection canvasId="ov-storage" zone="内容与存储" icon="storage" title={`存储构成 Top ${categories.length}`} action={<button type="button" className={css.panelGo} onClick={() => { onGo('storage') }}>详情 →</button>}>
      <div className={css.metricGrid}>
        <div className={css.metric}><span className={css.metricValue}>{fmtBytes(stor?.total_size ?? 0)}</span><span className={kitCss.textCaption}>媒体占用</span></div>
        <div className={css.metric}><span className={css.metricValue}>{(stor?.total_count ?? 0).toLocaleString()}</span><span className={kitCss.textCaption}>媒体项</span></div>
        <div className={css.metric}><span className={css.metricValue}>{largeFileCount}</span><span className={kitCss.textCaption}>超大文件</span></div>
      </div>
      {categories.length === 0
        ? <div className={kitCss.emptyInline}>暂无媒体资源记录</div>
        : <div className={css.catList}>{[...categories]
            .sort((a, b) => b.size - a.size)
            .map(c => (
            <div key={c.label} className={css.cat}>
              <div className={css.catRow}><span className={css.catLabel}>{c.label}</span><span className={css.catMeta}>{c.count.toLocaleString()} 项 · {fmtBytes(c.size)}</span></div>
              <div className={css.bar}><div className={css.barFill} style={{ width: `${(c.size / Math.max(1, ...categories.map(x => x.size))) * 100}%` }} /></div>
            </div>
          ))}</div>}
    </OvSection>
  )
}

/** 资金快照。 */
export function LedgerSection({ ledger, onGo, className }: {
  ledger: LedgerSnapshot | null
  onGo: (tab: string) => void
  className?: string
}): React.JSX.Element {
  const ls = ledger?.summary
  return (
    <OvSection canvasId="ov-ledger" zone="内容与存储" icon="ledger" title={`资金快照${ledger?.month ? ` · ${ledger.month}` : ''}`} action={<button type="button" className={css.panelGo} onClick={() => { onGo('ledger') }}>详情 →</button>}>
      {ledger?.readError && (
        <div className={kitCss.error} role="alert">
          资金台账读取不完整：{ledger.readError}
        </div>
      )}
      {ls ? (
        <>
          <div className={css.metricGrid} data-st-ledger-money="1">
            <div className={css.metric}><span className={css.metricValue}>¥{ls.totalAmountIn.toFixed(2)}</span><span className={kitCss.textCaption}>已知收入</span></div>
            <div className={css.metric}><span className={css.metricValue}>¥{ls.totalAmountOut.toFixed(2)}</span><span className={kitCss.textCaption}>已知支出</span></div>
            <div className={css.metric}><span className={css.metricValue}>{ls.transfers.toLocaleString()}</span><span className={kitCss.textCaption}>转账次数</span></div>
            <div className={css.metric}><span className={css.metricValue}>{ls.redpacketsSent + ls.redpacketsReceived}</span><span className={kitCss.textCaption}>红包收/发</span></div>
          </div>
          {(ls.amountUnknownCount ?? 0) > 0 && (
            <div className={kitCss.emptyInline}>
              另有 {ls.amountUnknownCount} 笔金额未知，未计入以上合计。
            </div>
          )}
        </>
      ) : <div className={kitCss.emptyInline}>暂无资金记录</div>}
    </OvSection>
  )
}

/** 全局热词。 */
export function WordCloudSection(): React.JSX.Element {
  return (
    <OvSection canvasId="ov-wordcloud" zone="更多分析" icon="content" title="全局热词">
      <WordCloudCard scope="global" limit={60} />
    </OvSection>
  )
}

/** 交互画像 · 基于消息时间与类型。 */
export function InteractionSection({ ins }: { ins: OverviewInsights }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-interaction" zone="更多分析" icon="insight" title="交互画像 · 基于消息时间与类型">
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
  )
}

/** 朋友圈活跃 Top 10。 */
export function MomentsAuthorsSection({ authors, onOpenMoments, onGo }: { authors: OverviewMomentsAuthor[]; onOpenMoments: (username: string) => void; onGo: (tab: string) => void }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-moments" zone="更多分析" icon="moments" title="朋友圈活跃 Top 10" action={<button type="button" className={css.panelGo} onClick={() => { onGo('moments') }}>详情 →</button>}>
      {authors.length === 0 ? <div className={kitCss.emptyInline}>暂无朋友圈活跃作者</div> : (
        <div className={css.authors}>
          {authors.slice(0, 10).map((a, i) => (
            <button key={a.username} type="button" className={css.author} onClick={() => { onOpenMoments(a.username) }} title={`${withEnterprise(a.name, a.enterpriseName)} 共发布 ${a.posts} 条`}>
              <span className={css.authorRank}>{i + 1}</span>
              <LazyMount placeholder={<span className={css.authorAvatarFallback}>{(a.name || '?').slice(0, 1)}</span>} rootMargin="300px 0px"><AuthorAvatar author={a} /></LazyMount>
              <span className={css.authorName}>{withEnterprise(a.name, a.enterpriseName)}</span>
              <span className={css.authorPosts}>{a.posts} 条</span>
            </button>
          ))}
        </div>
      )}
    </OvSection>
  )
}

/** 撤回消息痕迹 · 风险提示。 */
export function RevokedSection({ revoked, warnCount, onGo }: { revoked: number; warnCount: number; onGo: (tab: string) => void }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-revoked" zone="更多分析" icon="revoke" title="撤回消息痕迹 · 风险提示" action={<button type="button" className={css.panelGo} onClick={() => { onGo('revoked') }}>详情 →</button>}>
      <div className={css.metricGrid}>
        <div className={css.metric}><span className={css.metricValue}>{revoked.toLocaleString()}</span><span className={kitCss.textCaption}>撤回消息（可回溯）</span></div>
        <div className={css.metric}><span className={css.metricValue}>{warnCount}</span><span className={kitCss.textCaption}>转账/红包异常</span></div>
      </div>
      <p className={css.revokeNote}>微信 4.x 防撤回机制在本地保留的删除缓存，可用于回顾「谁撤回了什么」。建议定期运行 <button type="button" className={css.panelGo} onClick={() => { onGo('privacytrust') }}>隐私体检</button>：扫描敏感信息、资金往来与文件存储占用。</p>
    </OvSection>
  )
}

/** 数据健康。 */
export function HealthSection({ ins, extras }: { ins: OverviewInsights; extras: OverviewInsights['extras'] }): React.JSX.Element {
  return (
    <OvSection canvasId="ov-health" zone="更多分析" icon="health" title="数据健康">
      <div className={css.healthGrid}>
        <div className={css.healthItem}><span className={css.healthValue}>{ins.health.dbFiles}</span><span className={kitCss.textCaption}>数据库文件</span></div>
        <div className={css.healthItem}><span className={css.healthValue}>{fmtBytes(ins.health.dbBytes)}</span><span className={kitCss.textCaption}>解密数据体积</span></div>
        <div className={css.healthItem}><span className={css.healthValue}>{ins.health.ok ? '正常' : '异常'}</span><span className={kitCss.textCaption}>数据可读性</span></div>
        <div className={css.healthItem}>
          {/* lastActive 后端已经 `toLocaleString('zh-CN')` 成字符串了（overview-insights.ts:325）。 */}
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
  )
}
