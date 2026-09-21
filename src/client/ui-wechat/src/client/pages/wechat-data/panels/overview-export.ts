/**
 * `Overview.tsx` 的「报告与图片导出：PNG 克隆/内联样式/下载、总览报告文本」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module overview-export
 */

import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'
import { fmtBytes, fmtClockMs } from '../utils/format.ts'

// 地图面板与 GeoJSON/ECharts 较重：进入可视区附近时才按需加载对应代码块。
export const WorldMapPanel = lazy(() => import('./WorldMap.tsx').then(m => ({ default: m.WorldMapPanel })))

/** Format a signed delta with an arrow. */
export function deltaArrow(n: number): { text: string; cls: string | undefined } {
  if (n > 0) return { text: `▲ ${n.toLocaleString()}`, cls: css.deltaUp }
  if (n < 0) return { text: `▼ ${(n * -1).toLocaleString()}`, cls: css.deltaDown }
  return { text: '— 持平', cls: kitCss.textCaption }
}

/** Download a text payload as a file via a temporary object URL. */
export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
}
/** Recursively copy computed styles from a source element into a detached clone. */
export function inlineComputedStyles(src: Element, dst: Element): void {
  const style = getComputedStyle(src)
  const el = dst as HTMLElement
  for (let i = 0; i < style.length; i++) {
    const p = style[i]
    if (p) el.style.setProperty(p, style.getPropertyValue(p))
  }
  const sc = Array.from(src.children)
  const dc = Array.from(dst.children)
  for (let i = 0; i < sc.length && i < dc.length; i++) {
    if (sc[i] instanceof Element && dc[i] instanceof Element) {
      inlineComputedStyles(sc[i] as Element, dc[i] as Element)
    }
  }
}

/** Read an image into a data URL without relying on SVG-as-image loading. */
export async function imageToDataUrl(img: HTMLImageElement): Promise<string | null> {
  const src = img.getAttribute('src') ?? ''
  if (!src || src.startsWith('data:')) return null
  if (img.complete && img.naturalWidth > 0) {
    try {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth || img.width || 1
      c.height = img.naturalHeight || img.height || 1
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
        const url = c.toDataURL('image/png')
        if (url.length > 100) return url
      }
    } catch {
      // Cross-origin without CORS: fall through to fetch below.
    }
  }
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader()
      fr.onload = () => { resolve(typeof fr.result === 'string' ? fr.result : null) }
      fr.onerror = () => { resolve(null) }
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/** Replace canvases and blob/CDN images in the clone so the foreignObject export keeps them. */
export async function exportableClone(src: HTMLElement, clone: HTMLElement): Promise<void> {
  // Capture original clone images first: the canvas replacement below inserts
  // new <img> elements, which would otherwise shift the index alignment.
  const srcImgs = Array.from(src.querySelectorAll('img'))
  const dstImgs = Array.from(clone.querySelectorAll('img'))
  // Canvas pixels are not serialized by cloneNode: turn each into an <img> data URL.
  const srcCanvases = Array.from(src.querySelectorAll('canvas'))
  const dstCanvases = Array.from(clone.querySelectorAll('canvas'))
  srcCanvases.forEach((sc, i) => {
    const dc = dstCanvases[i]
    if (!(dc instanceof HTMLCanvasElement)) return
    let url: string
    try {
      url = sc.toDataURL('image/png')
    } catch {
      return
    }
    if (!url || url.length <= 100) return
    const img = document.createElement('img')
    img.src = url
    img.alt = ''
    img.style.width = getComputedStyle(sc).width
    img.style.height = getComputedStyle(sc).height
    dc.replaceWith(img)
  })
  // Blob and cross-origin avatar <img> sources do not render inside an SVG-as-image
  // element; bake loaded images (or re-fetch) to data URLs so they survive the export.
  await Promise.all(srcImgs.map(async (si, i) => {
    const di = dstImgs[i]
    if (!(di instanceof HTMLImageElement)) return
    const url = await imageToDataUrl(si)
    if (url) di.setAttribute('src', url)
  }))
}

/** Render a DOM element (with computed styles inlined) into a PNG/JPG download. */
export async function exportElementImage(el: HTMLElement, format: 'png' | 'jpg', filename: string): Promise<void> {
  const scale = 2
  const width = Math.max(el.offsetWidth, 1)
  const fullHeight = Math.max(el.scrollHeight, el.offsetHeight, 1)
  const clone = el.cloneNode(true) as HTMLElement
  inlineComputedStyles(el, clone)
  await exportableClone(el, clone)
  clone.style.height = `${fullHeight}px`
  clone.style.overflow = 'visible'
  clone.style.maxHeight = 'none'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fullHeight}" viewBox="0 0 ${width} ${fullHeight}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => { resolve() }
    img.onerror = () => { reject(new Error('image render failed')) }
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = fullHeight * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas context unavailable')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#0a1025'
  ctx.fillRect(0, 0, width, fullHeight)
  ctx.drawImage(img, 0, 0, width, fullHeight)
  const mime = format === 'png' ? 'image/png' : 'image/jpeg'
  const dataUrl = canvas.toDataURL(mime, 0.92)
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}

/** Build a Markdown report from the loaded overview snapshots. */
export function buildOverviewReport(
  data: OverviewSnapshot,
  ins: OverviewInsights | null,
  ledger: LedgerSnapshot | null,
  stor: StorageSnapshot | null,
  generated: Date,
  lastUpdated: number | null,
  avatars: Record<string, string> = {},
): string {
  const ls = ledger?.summary
  const L: string[] = []
  const p = (s: string): void => { L.push(s) }
  p('# 微信数据总览报告')
  p('')
  p(`> 生成时间：${generated.toLocaleString('zh-CN')} · 数据更新：${lastUpdated ? new Date(lastUpdated).toLocaleString('zh-CN') : '—'}`)
  p('')
  p('## 核心统计')
  p('')
  p('| 指标 | 数值 |')
  p('| --- | --- |')
  p(`| 会话 | ${data.sessions.toLocaleString()} |`)
  p(`| 群聊 | ${data.groups.toLocaleString()} |`)
  p(`| 好友 | ${data.contacts.toLocaleString()} |`)
  p(`| 公众号/服务号 | ${data.official.toLocaleString()} |`)
  p(`| 朋友圈 | ${data.moments.toLocaleString()} |`)
  p(`| 收藏 | ${data.favorites.toLocaleString()} |`)
  p(`| 自定义表情 | ${data.emoticons.toLocaleString()} |`)
  p(`| 媒体占用 | ${fmtBytes(data.storage.total_size)}（${data.storage.total_count.toLocaleString()} 项） |`)
  p('')
  p('## 撤回与存储构成')
  p('')
  p(`- 撤回消息痕迹：${data.revoked.toLocaleString()} 条`)
  if (data.storage.categories.length > 0) {
    p('- 媒体类型：' + data.storage.categories.map(c => `${c.label} ${c.count.toLocaleString()} 项/${fmtBytes(c.size)}`).join(' · '))
  }
  p('')
  if (data.moments_authors.length > 0) {
    p('## 朋友圈活跃作者 Top 10')
    p('')
    p('| # | 头像 | 作者 | 条数 |')
    p('| :-- | :-- | :-- | :-- |')
    data.moments_authors.slice(0, 10).forEach((a, i) => {
      const img = avatars[a.username] ? `![头像](${avatars[a.username]})` : '(无头像)'
      p(`| ${i + 1} | ${img} | ${a.name} | ${a.posts} |`)
    })
    p('')
  }
  if (ins) {
    p('## 交互画像')
    p('')
    p(`- 消息总数：${ins.messages.total.toLocaleString()}（发出 ${ins.messages.sent.toLocaleString()} / 收到 ${ins.messages.received.toLocaleString()}）`)
    p(`- 活跃天数：${ins.time.activeDays} · 时间跨度：${ins.time.spanDays} 天 · 最忙 ${ins.time.busyHour}:00（${ins.time.busyCount.toLocaleString()} 条）`)
    p(`- 深夜占比：${ins.time.deepNightPct}% · 周末占比：${ins.time.weekendPct}%`)
    p(`- 消息类型：文本 ${ins.messages.text.toLocaleString()} / 图片 ${ins.messages.image.toLocaleString()} / 视频 ${ins.messages.video.toLocaleString()} / 链接卡片 ${ins.messages.rich.toLocaleString()} / 系统 ${ins.messages.system.toLocaleString()}`)
    p('')
    p('## 关系浓度')
    p('')
    p(`- 好友 ${ins.relations.total} · 有往来 ${ins.relations.active} · 沉默 ${ins.relations.silent} · 有消息的群 ${ins.relations.groupsWithMsg}`)
    if (ins.relations.top.length > 0) {
      p('- 对话 Top：' + ins.relations.top.map((t, i) => `${i + 1}.${t.name}(${t.count})`).join(' '))
    }
    p('')
    p('## 内容构成与资产')
    p('')
    p(`- 朋友圈 ${ins.moments.total}（图${ins.moments.images}/赞${ins.moments.likes}/评${ins.moments.comments}）`)
    p(`- 收藏 ${ins.assets.favorites} · 表情 ${ins.assets.emoticons} · 文件 ${ins.assets.files}（${fmtBytes(ins.assets.fileBytes)}）`)
    p('')
    p('## 数据健康')
    p('')
    p(`- 数据库文件 ${ins.health.dbFiles} · 体积 ${fmtBytes(ins.health.dbBytes)} · 可读 ${ins.health.ok ? '✅' : '⚠️'}`)
    if (ins.extras) {
      p(`- 最近同步 ${ins.extras.freshness.lastSync || '—'} · WAL ${ins.extras.freshness.walPending ? '待落库⚠️' : '正常'}`)
    }
    p('')
  }
  if (ls) {
    p('## 资金快照')
    p('')
    p(`- 收入 ¥${ls.totalAmountIn.toFixed(2)} · 支出 ¥${ls.totalAmountOut.toFixed(2)}`)
    p(`- 转账 ${ls.transfers.toLocaleString()} 次 · 红包收/发 ${ls.redpacketsSent + ls.redpacketsReceived} 个`)
    p('')
  }
  if (stor) {
    p('## 存储清理建议')
    p('')
    p(`- 媒体占用 ${fmtBytes(stor.total_size)}（${stor.total_count.toLocaleString()} 项）`)
    if (stor.large_files && stor.large_files.length > 0) {
      p('- 超大文件：' + stor.large_files.slice(0, 5).map(x => `${x.name || '(未知)'} ${fmtBytes(x.size)}`).join(' · '))
    }
    p('')
  }
  return L.join('\n')
}
