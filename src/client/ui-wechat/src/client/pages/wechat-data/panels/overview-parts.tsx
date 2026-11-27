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
import { Card, LoadingState, PageBoot } from '../ui/kit.tsx'
import css from './overview.module.css'
import { CanvasCard } from './card-canvas-card.tsx'
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

/** 总览第一次打开：说明正在统计，不画灰色占位卡。 */
export function SkeletonOverview(): React.JSX.Element {
  return (
    <PageBoot
      title="正在统计微信数据"
      detail="会话、消息、联系人和资金汇总完，就会出现在这里。"
    />
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

/**
 * 新总览统一卡片：图标 + 标题 + 操作 + 内容。
 *
 * ## 只支持画布模式（2026-11-19）
 *
 * `canvasId` 是**必填**的。这不是冗余参数，而是把「卡片必须参与画布布局」这件事
 * 交给类型检查 —— 忘了传就是编译错误，不会有卡片留在文档流里压住别人。
 *
 * 之前留着"可选 + 退回栅格"的双模式，代价是**每次新增卡片都可能忘传**：
 * 2026-11-19 就因为朋友圈活跃 / 撤回痕迹 / 数据健康 / 地区榜单漏传，
 * 用户看到的是「卡片相互遮挡」。可选参数等于把这个坑留给下一个人。
 *
 * @param props.canvasId - 画布里的稳定 id（位置按它存取，改名等于换了一张卡）。
 */
export function OvSection({ icon, title, action, children, canvasId, zone, cols }: {
  icon: string
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  /** 画布里的稳定 id（**必填**，见上面的说明）。 */
  canvasId: string
  /** 分区标签（近期 / 人与关系 / 内容与存储 / 更多分析）。 */
  zone?: string
  /** 跨几列（默认 1）。世界地图这种横长内容占 2 列。 */
  cols?: number
}): React.JSX.Element {
  /**
   * 折叠功能已于 2026-11-19 按用户要求**移除**（「当前不需要这个功能了」）。
   *
   * 移除的是整套东西，不只是按钮：`useState(collapsed)`、按标题存 localStorage 的
   * 读写、`hidden={collapsed}` 的接收端、`.ovCollapse` 样式、以及 `localStorage` 里的
   * 旧键。只删按钮会留下"点了没反应的代码"和永远展开的 `hidden={false}`，
   * 那比留着一个能用的按钮更难查。
   *
   * 卡头右上角现在只剩调用点自己的 `action`（如「详情 →」）。
   */
  return (
    <CanvasCard
      id={canvasId}
      {...(cols === undefined ? {} : { cols })}
      title={<><span className={css.ovIcon}><OvIcon name={icon} /></span>{title}</>}
      {...(zone === undefined ? {} : { zone })}
      {...(action === undefined ? {} : { extra: action })}
    >
      <div className={css.ovSectionBd}>{children}</div>
    </CanvasCard>
  )
}
