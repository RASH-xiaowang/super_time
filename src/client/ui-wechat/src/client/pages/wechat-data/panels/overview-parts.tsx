/**
 * `Overview.tsx` 的「小组件与骨架屏：作者头像、缓存、骨架行/指标/条、分组标题」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module overview-partsx
 */

import { Suspense, useEffect, useRef, useState } from 'react'
import {
  apiExportAllSessions,
  apiGetLedger,
  apiGetOverview,
  apiGetOverviewInsights,
  apiGetStorageStats,
  apiGetAvatar,
} from '../api.ts'
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { CACHE_BASE, CACHE_INSIGHTS, CACHE_LEDGER, CACHE_STOR, CACHE_TIME } from './overview-cache-keys.ts'
import { Card, LoadingState } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'
import { CalendarHeatmapPanel } from './overview-export.ts'

/** 给总览里的日历热力一个独立 Suspense，主面板不必为懒加载多包一层 JSX。 */
export function CalendarHeatmapGate(props: React.ComponentProps<typeof CalendarHeatmapPanel>): React.JSX.Element {
  return (
    <Suspense fallback={<LoadingState variant="compact" label="日历热力资源加载中…" />}>
      <CalendarHeatmapPanel {...props} />
    </Suspense>
  )
}

/** 朋友圈活跃作者头像：组件挂载（进入可视区）后才请求头像，避免批量预取。 */
export function AuthorAvatar({ author }: { author: OverviewMomentsAuthor }): React.JSX.Element {
  const [src, setSrc] = useState<string>('')
  useEffect(() => {
    let alive = true
    void apiGetAvatar({ username: author.username })
      .then((r) => {
        if (!alive) return
        setSrc(r.kind === 'data' ? (r.data ?? '') : '')
      })
      .catch(() => { /* keep letter fallback */ })
    return () => { alive = false }
  }, [author.username])
  if (src) return <img className={css.authorAvatar} src={src} alt="" loading="lazy" />
  return <span className={css.authorAvatarFallback}>{(author.name || '?').slice(0, 1)}</span>
}

export { CACHE_BASE, CACHE_INSIGHTS, CACHE_LEDGER, CACHE_STOR, CACHE_TIME } from './overview-cache-keys.ts'
/** 折起来的卡片标题（设计稿每张卡右上角那个「折叠」）。 */
export const OV_COLLAPSED_KEY = 'dsh-wechat-ov-collapsed-v1'

/** 已折叠的卡片标题集合。读不出来就当全展开 —— 宁可多显示，也不要因为一条坏记录把内容藏起来。 */
export function readCollapsed(): Set<string> {
  const raw = readCache(OV_COLLAPSED_KEY)
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
}

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

/**
 * KPI 条只保留 4 项（2026-10-19 微信化改版）：
 * 会话 / 消息 / 好友 / 群聊 —— 其余指标（公众号、朋友圈、收藏、表情、媒体占用）
 * 已经分别落在「内容构成」与「存储构成」卡里，不再在页头重复一遍。
 * 图标走 `OvIcon`（单色描边），不再用 emoji。
 */
export const CARDS: ReadonlyArray<{ key: string; label: string; icon: string; tab: string }> = [
  { key: 'sessions', label: '会话', icon: 'chat', tab: 'chats' },
  { key: 'messages', label: '消息', icon: 'message', tab: 'chats' },
  { key: 'contacts', label: '好友', icon: 'relation', tab: 'contacts' },
  { key: 'groups', label: '群聊', icon: 'group', tab: 'contacts' },
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

/** 骨架屏：保留总览的真实栏目/标签，仅数值与内容用骨架占位。
 *
 * 2026-10-19 起与「4 KPI + 6 卡 + 更多分析」的新结构保持一致：
 * 不再画 14 张卡片的占位墙（加载完布局会整体跳变）。
 */
export function SkeletonOverview(): React.JSX.Element {
  return (
    <div className={css.skeleton} aria-label="正在加载微信数据总览" aria-busy="true">
      {/* KPI 条：4 格 */}
      <div className="row g-2">
        {CARDS.map(card => (
          <div key={card.key} className="col-6 col-sm-3">
            <div className={css.skeletonStat}>
              <SkLine width="52%" height={18} />
              <span className={kitCss.textCaption}>{card.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 趋势 + 热力 */}
      <div className={css.skeletonRows}>
        <div className={css.skeletonCard}>
          <SkLine width="36%" height={12} />
          <div className={css.skeletonGrid}>
            {['近 7 天消息', '近 30 天消息', '近 30 天活跃好友', '近 30 天活跃群'].map(label => (
              <div key={label} className={css.skeletonCell}>
                <SkLine width="48%" height={16} />
                <span className={kitCss.textCaption}>{label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={css.skeletonCard}>
          <SkLine width="30%" height={12} />
          <div className={css.skeletonMap} />
        </div>
      </div>

      {/* 关系 + 内容 */}
      <div className={css.skeletonRows}>
        <div className={css.skeletonCard}>
          <SkLine width="32%" height={12} />
          <div className={css.skeletonMap} />
        </div>
        <div className={css.skeletonCard}>
          <SkLine width="28%" height={12} />
          <div className={css.skeletonGrid}>
            {['文本', '图片', '视频', '链接/文件', '系统消息'].map(label => (
              <SkBar key={label} label={label} width="60%" />
            ))}
          </div>
        </div>
      </div>

      {/* 存储 + 资金 */}
      <div className={css.skeletonRows}>
        <div className={css.skeletonCard}>
          <SkLine width="34%" height={12} />
          <div className={css.skStack}>
            <SkBar label="图片" width="72%" />
            <SkBar label="视频" width="58%" />
            <SkBar label="语音" width="42%" />
          </div>
        </div>
        <div className={css.skeletonCard}>
          <SkLine width="30%" height={12} />
          <div className={css.metricGrid}>
            <SkMetric label="收入" />
            <SkMetric label="支出" />
            <SkMetric label="转账次数" />
          </div>
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
    case 'chat': return <svg {...p}><path d="M21 12a8.5 8.5 0 0 1-12.3 7.6L4 21l1.4-4.7A8.5 8.5 0 1 1 21 12Z" /></svg>
    case 'message': return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
    case 'group': return <svg {...p}><circle cx="9" cy="8" r="3.2" /><circle cx="17" cy="9" r="2.4" /><path d="M3 20c0-3.4 2.6-5.8 6-5.8s6 2.4 6 5.8M14.5 16.8c2.2-.4 4.7.7 5.5 3.2" /></svg>
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

/** 新总览统一卡片：图标 + 标题 + 操作 + 内容（基于 kit `Card`，与其他页签同一套卡片外观）。 */
export function OvSection({ icon, title, action, children, className }: {
  icon: string
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  /** 版式类名（Bootstrap `col-*`）—— 由调用点决定这张卡在栅格行里的位置 */
  className?: string
}): React.JSX.Element {
  // 「折叠」按**标题**记进 localStorage：同一张卡在刷新/切页签之后仍是用户放下的样子。
  // 记标题而不是下标 —— 下标会随卡片增删整体漂移，把"折起来的资产"读到"数据健康"上。
  const key = String(title)
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed().has(key))
  const toggle = (): void => {
    setCollapsed((prev) => {
      const next = !prev
      const set = readCollapsed()
      if (next) set.add(key)
      else set.delete(key)
      writeCache(OV_COLLAPSED_KEY, [...set])
      return next
    })
  }
  return (
    <div className={[css.ovCol, className].filter(Boolean).join(' ')}>
      <Card
        className={css.ovSectionCard}
        title={<><span className={css.ovIcon}><OvIcon name={icon} /></span>{title}</>}
        extra={(
          <>
            {action}
            <button
              type="button"
              className={css.ovCollapse}
              aria-expanded={!collapsed}
              onClick={toggle}
              title={collapsed ? `展开「${key}」` : `折叠「${key}」`}
            >
              {collapsed ? '展开 +' : '折叠 —'}
            </button>
          </>
        )}
      >
        <div className={css.ovSectionBd} hidden={collapsed}>{children}</div>
      </Card>
    </div>
  )
}
