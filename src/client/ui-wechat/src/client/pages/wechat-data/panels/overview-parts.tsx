/**
 * `Overview.tsx` 的「小组件与骨架屏：作者头像、缓存、骨架行/指标/条、分组标题」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module overview-partsx
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
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'

/** 朋友圈活跃作者头像：组件挂载（进入可视区）后才请求头像，避免批量预取。 */
export function AuthorAvatar({ author }: { author: OverviewMomentsAuthor }): React.JSX.Element {
  const [src, setSrc] = useState<string>('')
  useEffect(() => {
    let alive = true
    void apiGetAvatar({ username: author.username })
      .then((r) => {
        if (!alive) return
        setSrc(r.kind === 'data' ? (r.data ?? '') : r.kind === 'url' ? (r.url ?? '') : '')
      })
      .catch(() => { /* keep letter fallback */ })
    return () => { alive = false }
  }, [author.username])
  if (src) return <img className={css.authorAvatar} src={src} alt="" loading="lazy" />
  return <span className={css.authorAvatarFallback}>{(author.name || '?').slice(0, 1)}</span>
}

export const CACHE_BASE = 'dsh-wechat-overview-base-v1'
export const CACHE_INSIGHTS = 'dsh-wechat-overview-insights-v1'
export const CACHE_LEDGER = 'dsh-wechat-overview-ledger-v1'
export const CACHE_STOR = 'dsh-wechat-overview-storage-v1'
export const CACHE_TIME = 'dsh-wechat-overview-last-updated-v1'

export function readCache(key: string): unknown {
  try {
    const s = localStorage.getItem(key)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

export function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Cards with icon, value, label, and target tab. */
export const CARDS: ReadonlyArray<{ key: string; label: string; icon: string; tab: string }> = [
  { key: 'sessions', label: '会话', icon: '💬', tab: 'chats' },
  { key: 'groups', label: '群聊', icon: '👥', tab: 'contacts' },
  { key: 'contacts', label: '好友', icon: '👤', tab: 'contacts' },
  { key: 'official', label: '公众号/服务号', icon: '📢', tab: 'bizchats' },
  { key: 'moments', label: '朋友圈', icon: '🖼️', tab: 'moments' },
  { key: 'favorites', label: '收藏', icon: '⭐', tab: 'favorites' },
  { key: 'emoticons', label: '自定义表情', icon: '😀', tab: 'emoticons' },
  { key: 'storage', label: '媒体占用', icon: '💾', tab: 'storage' },
]

/** 消息类型分布（战术三）的展示顺序。 */
export const MSG_BUCKETS: ReadonlyArray<{ label: string; key: keyof OverviewInsights['messages'] }> = [
  { label: '文本', key: 'text' },
  { label: '图片', key: 'image' },
  { label: '视频', key: 'video' },
  { label: '链接/文件/卡片', key: 'rich' },
  { label: '系统消息', key: 'system' },
]

/** 骨架行：带微光扫过的占位条。 */
export function SkLine({ width = '100%', height = 12, className }: {
  width?: string
  height?: number
  className?: string
}): React.JSX.Element {
  return <span className={`${css.skLine} ${className ?? ''}`} style={{ width, height }} />
}

/** 骨架统计项：数值占位 + 真实标签。 */
export function SkMetric({ label }: { label: string }): React.JSX.Element {
  return (
    <div className={css.metric}>
      <SkLine width="72%" height={16} />
      <span className={kitCss.textCaption}>{label}</span>
    </div>
  )
}

/** 骨架条形项：标签 + “真实”的条形轨道。 */
export function SkBar({ label, width = '80%' }: { label: string; width?: string }): React.JSX.Element {
  return (
    <div className={css.cat}>
      <div className={css.catRow}>
        <span className={css.catLabel}>{label}</span>
        <SkLine width="110px" height={9} />
      </div>
      <div className={css.bar}>
        <div className={css.skBarFill} style={{ width }} />
      </div>
    </div>
  )
}

/** 骨架屏：保留总览的真实标题/栏目/标签，仅数值与内容用骨架占位。 */
export function SkeletonOverview(): React.JSX.Element {
  return (
    <div className={css.skeleton} aria-label="正在加载微信数据总览" aria-busy="true">
      {/* Hero：核心资产 */}
      <Card title="核心资产">
        <div className={css.heroStats}>
          {CARDS.slice(0, 4).map(card => (
            <div key={card.key} className={css.skeletonStat}>
              <span className={css.quickIcon}>{card.icon}</span>
              <SkLine width="52%" height={18} />
              <span className={kitCss.textCaption}>{card.label}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* 世界板块 */}
      <Card title="世界板块 · 好友地区">
        <div className={css.skeletonMap} />
      </Card>

      {/* 轨道趋势 + 消息热度 */}
      <div className={css.cols}>
        <Card title="轨道趋势">
          <div className={css.trendGrid}>
            {['近 7 天消息', '近 30 天消息', '近 30 天活跃好友', '近 30 天活跃群', '近 30 天新增媒体'].map(label => (
              <div key={label} className={css.trendCell}>
                <SkLine width="48%" height={16} />
                <span className={kitCss.textCaption}>{label}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="消息热度 · 近 90 天">
          <div className={css.heatmapSkeleton}>
            {Array.from({ length: 90 }).map((_, i) => <i key={i} />)}
          </div>
        </Card>
      </div>

      {/* 存储构成 + 撤回 */}
      <div className={kitCss.cardGrid}>
        <Card title="存储构成 Top 4" extra={<span className={css.panelGo}>详情 →</span>}>
          <div className={css.skStack}>
            <SkBar label="图片" width="72%" />
            <SkBar label="视频" width="58%" />
            <SkBar label="语音" width="42%" />
            <SkBar label="文件" width="30%" />
          </div>
        </Card>
        <Card title="撤回消息痕迹" extra={<span className={css.panelGo}>详情 →</span>}>
          <div className={css.revoke}>
            <SkLine width="120px" height={28} />
            <span className={kitCss.textMeta}>条被撤回消息的元数据痕迹（发送者/时间/类型可查）</span>
          </div>
        </Card>
      </div>

      {/* 资金快照 + 存储清理建议 */}
      <div className={kitCss.cardGrid}>
        <Card title="资金快照" extra={<span className={css.panelGo}>详情 →</span>}>
          <div className={css.metricGrid}>
            <SkMetric label="收入" />
            <SkMetric label="支出" />
            <SkMetric label="转账次数" />
            <SkMetric label="红包收/发" />
          </div>
        </Card>
        <Card title="存储清理建议" extra={<span className={css.panelGo}>详情 →</span>}>
          <div className={css.metricGrid}>
            <SkMetric label="媒体占用" />
            <SkMetric label="媒体项" />
            <SkMetric label="超大文件" />
          </div>
        </Card>
      </div>

      {/* 交互画像 + 关系浓度 */}
      <div className={css.cols}>
        <Card title="交互画像 · 基于消息时间与类型">
          <div className={css.metricGrid}>
            <SkMetric label="消息总数" />
            <SkMetric label="活跃天数" />
            <SkMetric label="时间跨度(天)" />
            <SkMetric label="最忙时段" />
            <SkMetric label="深夜(23-6点)占比" />
            <SkMetric label="周末占比" />
          </div>
          <div className={css.hourBars}>
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} className={css.hourCol}>
                <div className={`${css.skBarFill} ${css.hourSk}`} style={{ height: `${((h % 5) + 2) * 12}%` }} />
                <span className={css.hourLabel}>{h}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="关系浓度 · 好友活跃与对话 Top">
          <div className={css.metricGrid}>
            <SkMetric label="好友总数" />
            <SkMetric label="有消息往来" />
            <SkMetric label="沉默好友(无消息)" />
            <SkMetric label="有消息的群" />
          </div>
          <div className={css.topList}>
            {[70, 55, 42, 32, 24].map((w, i) => (
              <div key={i} className={css.topRow} aria-hidden="true">
                <span className={css.topRank}>{i + 1}</span>
                <SkLine width="90px" height={11} />
                <div className={css.topTrack}><div className={css.skBarFill} style={{ width: `${w}%` }} /></div>
                <SkLine width="40px" height={11} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* 朋友圈活跃 Top 20 + 内容构成/风险/健康 */}
      <div className={css.cols}>
        <Card title="朋友圈活跃 Top 20" extra={<span className={css.panelGo}>详情 →</span>}>
          <div className={css.authors}>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className={css.author} aria-hidden="true">
                <span className={css.authorRank}>{i + 1}</span>
                <span className={css.authorAvatarFallback}>?</span>
                <SkLine width="86px" height={10} />
                <SkLine width="34px" height={10} />
              </div>
            ))}
          </div>
        </Card>
        <div className={css.colStack}>
          <Card title="内容构成与资产">
            <div className={css.skStack}>
              <SkBar label="文本" width="86%" />
              <SkBar label="图片" width="64%" />
              <SkBar label="视频" width="44%" />
              <SkBar label="链接/文件/卡片" width="32%" />
              <SkBar label="系统消息" width="24%" />
            </div>
            <div className={`${css.catRow} ${css.catRowSpaced}`}>
              <span className={css.catLabel}>资产</span>
              <SkLine width="260px" height={9} />
            </div>
          </Card>
          <Card title="风险与隐私提示" extra={<span className={css.panelGo}>详情 →</span>}>
            <div className={css.riskRow}>
              <span className={css.riskItem}>撤回消息 <SkLine width="36px" height={10} /></span>
              <span className={css.riskItem}>转账/红包异常 <SkLine width="36px" height={10} /></span>
              <span className={css.riskItem}>建议定期运行「隐私体检」扫描</span>
            </div>
          </Card>
          <Card title="数据健康">
            <div className={css.metricGrid}>
              <SkMetric label="数据库文件" />
              <SkMetric label="解密数据体积" />
              <SkMetric label="数据可读性" />
              <SkMetric label="最近活跃" />
              <SkMetric label="WAL 待落库" />
            </div>
          </Card>
        </div>
      </div>

      <div className={css.skLoadingText}><span className={css.spinner} /> 正在统计微信数据…</div>
    </div>
  )
}

/** 新总览的统一样式图标（14px 描边）。 */
export function OvIcon({ name }: { name: string }): React.JSX.Element {
  const p = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (name) {
    case 'world': return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14 0 18-3-4-3-14.5 0-18Z" /></svg>
    case 'trend': return <svg {...p}><path d="M3 20h18M4 15l4-4 4 3 5-6" /></svg>
    case 'heat': return <svg {...p}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 9h18" /></svg>
    case 'storage': return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6h.01M11 6h.01M15 6h.01" /></svg>
    case 'revoke': return <svg {...p}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></svg>
    case 'ledger': return <svg {...p}><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M8 15h4" /></svg>
    case 'insight': return <svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
    case 'relation': return <svg {...p}><circle cx="9" cy="8" r="3.5" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3.5 2.5-6 6-6s6 2.5 6 6M14 17c2.5-.5 5.5.8 6.5 3" /></svg>
    case 'moments': return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
    case 'content': return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
    case 'risk': return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M9 12l2 2 4-4" /></svg>
    case 'health': return <svg {...p}><path d="M12 21C7 17 3 13.5 3 9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 4.5-4 8-9 12Z" /></svg>
    default: return <span>•</span>
  }
}

/** 新总览统一卡片：图标 + 标题 + 操作 + 内容。 */
export function OvSection({ icon, title, action, children, span, className }: {
  icon: string
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  span: string
  className?: string
}): React.JSX.Element {
  return (
    <section className={`${css.ovCard} ${span} ${className ?? ''}`}>
      <header className={css.ovCardHd}>
        <span className={css.ovIcon}><OvIcon name={icon} /></span>
        <h3 className={css.ovTitle}>{title}</h3>
        {action && <div className={css.ovAction}>{action}</div>}
      </header>
      <div className={css.ovCardBd}>{children}</div>
    </section>
  )
}
