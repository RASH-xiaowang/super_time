/**
 * `Moments.tsx` 的「类型/常量/纯助手：头像与图片/视频/封面缓存上限、媒体筛选项表、时间格式化、回复目标、按日期分组，以及两个头像组件」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module moments-supportx
 */

import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { apiDecryptAllDatabases, apiExportMoments, apiExportSnsVideo, apiGetArticleCover, apiGetAvatar, apiGetMoments, apiGetMomentsAuthors, apiGetMomentsMonthly, apiGetSelfUsername, apiGetSnsImageDataUrl, apiGetSnsVideoCoverDataUrl, apiGetSnsVideoDataUrl, apiOpenPath, apiSaveFileDialog, pickDirectory, snsMediaCacheGet, snsMediaCacheGetMany, snsMediaCacheSet } from '../api.ts'
import type { MomentItem, MomentsMonthlyRow } from '@deepseek-ai/dsh-wechat-data/types'
import { cacheBounded, capRecord } from '../utils/misc.ts'
import css from './moments.module.css'

export const avatarCache = new Map<string, string>()
/** 头像缓存上限：模块级缓存生命周期等于渲染进程，必须设上限（值为 base64 data URL）。 */
export const AVATAR_CACHE_MAX = 300
/** 已解密图片 data URL 缓存上限（朋友圈缩略图）。 */
export const SNS_IMG_CACHE_MAX = 200
/**
 * 已解密视频 data URL 缓存上限。单条 .mp4 的 base64 可达数 MB，
 * 只保留最近播放的几条，否则"播放过的视频"会一直堆在 state 里。
 */
export const VIDEO_SRC_CACHE_MAX = 3
/** 公众号封面缓存上限。 */
export const ARTICLE_COVER_CACHE_MAX = 100

/** Media-type filter id + user-facing label kept in lockstep with the UI chips. */
export type MediaFilter = 'all' | 'image' | 'video' | 'link' | 'location' | 'text'
export const MEDIA_LABELS: Record<MediaFilter, string> = {
  all: '全部',
  image: '图片',
  video: '视频',
  link: '链接',
  location: '位置',
  text: '纯文字',
}

/** Stable cache key for one SNS image (md5 first, timelineId+mediaId fallback). */
export function imgKey(im: { md5?: string; timelineId?: string; id?: string }): string {
  if (im.md5) return im.md5
  if (im.timelineId && im.id) return im.timelineId + ':' + im.id
  return ''
}

/**
 * CSP 安全的图片地址助手已提取到 `../utils/url.ts`（第 41 轮）：
 * `Contacts.tsx` 的头像也需要同一条规则，而那里原先直接用快照里的 `avatarUrl`，
 * 开启远端头像后一次进入通讯录就产生 16 条 http 的 CSP 违规。
 * 全项目只保留那一份实现，这里直接 import 使用（22 处调用点不变）。
 */

/** Compact relative label for a comment timestamp (tz-safe wall clock). */
export function fmtCommentTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts * 1000
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  if (diff < 172800000) return '昨天'
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/** Format a timestamp as HH:MM for the sync status label. */
export function fmtSyncTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Find the original comment a reply targets within the same card (best effort). */
export function replyTarget(m: MomentItem, c: MomentItem['comments'][number]): MomentItem['comments'][number] | undefined {
  if (!c.to_username || c.to_username === m.username) return undefined
  for (const other of m.comments) {
    if (other.username === c.to_username && other.content) return other
  }
  return undefined
}

/** 朋友圈作者头像：本地 head_image 优先，失败回退首字色块。 */
export function MomentsAvatar({ username, name }: { username: string; name: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(avatarCache.get(username) ?? null)
  useEffect(() => {
    if (src !== null) return
    let cancelled = false
    const opts: { username: string; nickname?: string } = { username }
    if (name) opts.nickname = name
    apiGetAvatar(opts)
      .then((r) => {
        const v = r.kind === 'data' ? (r.data ?? null) : null
        cacheBounded(avatarCache, username, v ?? '', AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(v)
      })
      .catch(() => {
        cacheBounded(avatarCache, username, '', AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(null)
      })
    return () => { cancelled = true }
  }, [username, name, src])
  if (src) return <img src={src} alt="" className={css.avatarImg} loading="lazy" referrerPolicy="no-referrer" />
  return <div className={css.avatar}>{(name || '?').slice(0, 1).toUpperCase()}</div>
}

/** 16px mini avatar for likes/comments (缓存与 40px 大头像共享，避免重复请求)。 */
export function MomentsMiniAvatar({ username, name }: { username: string; name: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(avatarCache.get(username) ?? null)
  useEffect(() => {
    if (src !== null) return
    let cancelled = false
    apiGetAvatar({ username, nickname: name }).then((r) => {
      const v = r.kind === 'data' ? (r.data ?? null) : null
      cacheBounded(avatarCache, username, v ?? '', AVATAR_CACHE_MAX)
      if (!cancelled) setSrc(v)
    }).catch(() => { cacheBounded(avatarCache, username, '', AVATAR_CACHE_MAX); if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  }, [username, name, src])
  if (src) return <img src={src} alt="" className={css.miniAvatar} loading="lazy" referrerPolicy="no-referrer" />
  return <span className={css.miniAvatarFallback}>{(name || '?').slice(0, 1).toUpperCase()}</span>
}

/** 按日期分组（YYYY-MM-DD），组内保持原有顺序。 */
export function groupByDate(moments: readonly MomentItem[]): Array<{ day: string; items: MomentItem[] }> {
  const map = new Map<string, MomentItem[]>()
  for (const m of moments) {
    const d = m.ts ? new Date(m.ts * 1000) : null
    const key = d && !isNaN(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '未知日期'
    const arr = map.get(key) ?? []
    arr.push(m)
    map.set(key, arr)
  }
  return Array.from(map.entries()).map(([day, items]) => ({ day, items }))
}
