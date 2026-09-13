/**
 * 微信数据总览 — 太空舱版。一屏纵览微信数据资产：核心统计、趋势/热度/新鲜度、
 * 资金快照、清理建议、风险提示与战术分析。数据经 DSH 后端 Remote（node:sqlite），
 * 只读统计、无 HTTP。保留全部既有内容，新增扩展洞察。
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
import { LazyMount, useWechatDataUpdated } from './hooks.tsx'

// 地图面板与 GeoJSON/ECharts 较重：进入可视区附近时才按需加载对应代码块。
const WorldMapPanel = lazy(() => import('./WorldMap.tsx').then(m => ({ default: m.WorldMapPanel })))
import { CalendarHeatmap } from './CalendarHeatmap.tsx'
import type { LedgerSnapshot, OverviewInsights, OverviewMomentsAuthor, OverviewSnapshot, StorageSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, PanelHeader, StatCard } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './overview.module.css'
import { fmtBytes, fmtClockMs } from '../utils/format.ts'

/** Format a signed delta with an arrow. */
function deltaArrow(n: number): { text: string; cls: string | undefined } {
  if (n > 0) return { text: `▲ ${n.toLocaleString()}`, cls: css.deltaUp }
  if (n < 0) return { text: `▼ ${(n * -1).toLocaleString()}`, cls: css.deltaDown }
  return { text: '— 持平', cls: kitCss.textCaption }
}

/** Download a text payload as a file via a temporary object URL. */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 2000)
}
/** Recursively copy computed styles from a source element into a detached clone. */
function inlineComputedStyles(src: Element, dst: Element): void {
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
async function imageToDataUrl(img: HTMLImageElement): Promise<string | null> {
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
async function exportableClone(src: HTMLElement, clone: HTMLElement): Promise<void> {
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
async function exportElementImage(el: HTMLElement, format: 'png' | 'jpg', filename: string): Promise<void> {
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
function buildOverviewReport(
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
    p('## 朋友圈活跃作者 Top 20')
    p('')
    p('| # | 头像 | 作者 | 条数 |')
    p('| :-- | :-- | :-- | :-- |')
    data.moments_authors.slice(0, 20).forEach((a, i) => {
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

/** 朋友圈活跃作者头像：组件挂载（进入可视区）后才请求头像，避免批量预取。 */
function AuthorAvatar({ author }: { author: OverviewMomentsAuthor }): React.JSX.Element {
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

const CACHE_BASE = 'dsh-wechat-overview-base-v1'
const CACHE_INSIGHTS = 'dsh-wechat-overview-insights-v1'
const CACHE_LEDGER = 'dsh-wechat-overview-ledger-v1'
const CACHE_STOR = 'dsh-wechat-overview-storage-v1'
const CACHE_TIME = 'dsh-wechat-overview-last-updated-v1'

function readCache(key: string): unknown {
  try {
    const s = localStorage.getItem(key)
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** Cards with icon, value, label, and target tab. */
const CARDS: ReadonlyArray<{ key: string; label: string; icon: string; tab: string }> = [
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
const MSG_BUCKETS: ReadonlyArray<{ label: string; key: keyof OverviewInsights['messages'] }> = [
  { label: '文本', key: 'text' },
  { label: '图片', key: 'image' },
  { label: '视频', key: 'video' },
  { label: '链接/文件/卡片', key: 'rich' },
  { label: '系统消息', key: 'system' },
]

/** 骨架行：带微光扫过的占位条。 */
function SkLine({ width = '100%', height = 12, className }: {
  width?: string
  height?: number
  className?: string
}): React.JSX.Element {
  return <span className={`${css.skLine} ${className ?? ''}`} style={{ width, height }} />
}

/** 骨架统计项：数值占位 + 真实标签。 */
function SkMetric({ label }: { label: string }): React.JSX.Element {
  return (
    <div className={css.metric}>
      <SkLine width="72%" height={16} />
      <span className={kitCss.textCaption}>{label}</span>
    </div>
  )
}

/** 骨架条形项：标签 + “真实”的条形轨道。 */
function SkBar({ label, width = '80%' }: { label: string; width?: string }): React.JSX.Element {
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
function SkeletonOverview(): React.JSX.Element {
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
            <SkLine width="120px" height="28px" />
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
function OvIcon({ name }: { name: string }): React.JSX.Element {
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
function OvSection({ icon, title, action, children, span, className }: {
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
  const [notice, setNotice] = useState<string | null>(null)
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
      else setNotice('后台刷新失败，当前显示缓存数据：' + (e as Error).message)
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
      setNotice('已归档 ' + String(r.count) + ' 条消息 → ' + r.path)
      setTimeout(() => { setNotice(null) }, 6000)
    } catch (e) {
      setNotice('归档失败: ' + (e as Error).message)
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
          setNotice('图片导出失败: ' + (e as Error).message)
          return
        }
      }
    }
    setNotice('已导出报告')
    setTimeout(() => { setNotice(null) }, 2500)
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
              <LazyMount placeholder={<div className={kitCss.emptyInline}>地图进入可视区后加载…</div>}>
                <Suspense fallback={<div className={kitCss.emptyInline}>地图资源加载中…</div>}>
                  <WorldMapPanel />
                </Suspense>
              </LazyMount>
            </OvSection>

            {extras && (
              <>
                <OvSection span={css.ovSpan5} className={css.ovTrend} icon="trend" title="轨道趋势">
                  <div className={css.trendGrid}>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.messages7.toLocaleString()}</span><span className={kitCss.textCaption}>近 7 天消息</span><span className={deltaArrow(extras.trends.messages7Delta).cls}>{deltaArrow(extras.trends.messages7Delta).text}</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.messages30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天消息</span><span className={deltaArrow(extras.trends.messages30Delta).cls}>{deltaArrow(extras.trends.messages30Delta).text}</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.activeContacts30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天活跃好友</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{extras.trends.activeGroups30.toLocaleString()}</span><span className={kitCss.textCaption}>近 30 天活跃群</span></div>
                    <div className={css.trendCell}><span className={css.metricValue}>{fmtBytes(extras.trends.storageBytes30)}</span><span className={kitCss.textCaption}>近 30 天新增媒体</span></div>
                  </div>
                </OvSection>
                {extras.heatmap.length > 0 && (
                  <OvSection span={css.ovSpan7} className={css.ovHeat} icon="heat" title="消息热度 · 近 90 天">
                    <CalendarHeatmap data={extras.heatmap} />
                  </OvSection>
                )}
              </>
            )}

            <OvSection span={css.ovSpan6} icon="storage" title={`存储构成 Top ${data.storage.categories.length}`} action={<button type="button" className={css.panelGo} onClick={() => { go('storage') }}>详情 →</button>}>
              {data.storage.categories.length === 0
                ? <div className={kitCss.emptyInline}>暂无媒体资源记录</div>
                : <div className={css.catList}>{data.storage.categories.slice(0, 4).map(c => (
                    <div key={c.label} className={css.cat}>
                      <div className={css.catRow}><span className={css.catLabel}>{c.label}</span><span className={css.catMeta}>{c.count.toLocaleString()} 项 · {fmtBytes(c.size)}</span></div>
                      <div className={css.bar}><div className={css.barFill} style={{ width: `${(c.size / Math.max(1, data.storage.categories[0]?.size ?? 1)) * 100}%` }} /></div>
                    </div>
                  ))}</div>}
            </OvSection>

            <OvSection span={css.ovSpan6} icon="revoke" title="撤回消息痕迹" action={<button type="button" className={css.panelGo} onClick={() => { go('revoked') }}>详情 →</button>}>
              <div className={css.revoke}>
                <span className={css.revokeValue}>{data.revoked.toLocaleString()}</span>
                <span className={kitCss.textMeta}>条被撤回消息的元数据痕迹（发送者/时间/类型可查）</span>
                <p className={css.revokeNote}>微信 4.x 防撤回机制在本地保留的删除缓存，可用于回顾"谁撤回了什么"。</p>
              </div>
            </OvSection>

            <OvSection span={css.ovSpan6} icon="ledger" title={`资金快照 · ${ledger?.month ?? ''}`} action={<button type="button" className={css.panelGo} onClick={() => { go('ledger') }}>详情 →</button>}>
              {ls ? (
                <div className={css.metricGrid}>
                  <div className={css.metric}><span className={css.metricValue}>¥{ls.totalAmountIn.toFixed(2)}</span><span className={kitCss.textCaption}>收入</span></div>
                  <div className={css.metric}><span className={css.metricValue}>¥{ls.totalAmountOut.toFixed(2)}</span><span className={kitCss.textCaption}>支出</span></div>
                  <div className={css.metric}><span className={css.metricValue}>{ls.transfers.toLocaleString()}</span><span className={kitCss.textCaption}>转账次数</span></div>
                  <div className={css.metric}><span className={css.metricValue}>{ls.redpacketsSent + ls.redpacketsReceived}</span><span className={kitCss.textCaption}>红包收/发</span></div>
                </div>
              ) : <div className={kitCss.emptyInline}>暂无资金记录</div>}
            </OvSection>

            <OvSection span={css.ovSpan6} icon="storage" title="存储清理建议" action={<button type="button" className={css.panelGo} onClick={() => { go('storage') }}>详情 →</button>}>
              <div className={css.metricGrid}>
                <div className={css.metric}><span className={css.metricValue}>{fmtBytes(stor?.total_size ?? 0)}</span><span className={kitCss.textCaption}>媒体占用</span></div>
                <div className={css.metric}><span className={css.metricValue}>{(stor?.total_count ?? 0).toLocaleString()}</span><span className={kitCss.textCaption}>媒体项</span></div>
                <div className={css.metric}><span className={css.metricValue}>{largeFiles.length}</span><span className={kitCss.textCaption}>超大文件</span></div>
              </div>
            </OvSection>

            {ins && (
              <>
                <OvSection span={css.ovSpan7} className={css.ovTall} icon="insight" title="交互画像 · 基于消息时间与类型">
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
                <OvSection span={css.ovSpan5} icon="relation" title="关系浓度 · 好友活跃与对话 Top">
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

            <OvSection span={css.ovSpan7} icon="moments" title="朋友圈活跃 Top 20" action={<button type="button" className={css.panelGo} onClick={() => { go('moments') }}>详情 →</button>}>
              {data.moments_authors.length === 0 ? <div className={kitCss.emptyInline}>暂无朋友圈活跃作者</div> : (
                <div className={css.authors}>
                  {data.moments_authors.slice(0, 20).map((a, i) => (
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

            <div className={css.ovSpan5}>
              {ins && (
                <OvSection span="" icon="content" title="内容构成与资产">
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
              <OvSection span="" icon="risk" title="风险与隐私提示" action={<button type="button" className={css.panelGo} onClick={() => { go('privacytrust') }}>详情 →</button>}>
                <div className={css.riskRow}>
                  <span className={css.riskItem}>撤回消息 <b>{data.revoked.toLocaleString()}</b> 条</span>
                  <span className={css.riskItem}>转账/红包异常 <b>{warnCount}</b> 条</span>
                  <span className={css.riskItem}>建议定期运行「隐私体检」扫描</span>
                </div>
              </OvSection>
              {ins && (
                <OvSection span="" icon="health" title="数据健康">
                  <div className={css.healthGrid}>
                    <div className={css.healthItem}><span className={css.healthValue}>{ins.health.dbFiles}</span><span className={kitCss.textCaption}>数据库文件</span></div>
                    <div className={css.healthItem}><span className={css.healthValue}>{fmtBytes(ins.health.dbBytes)}</span><span className={kitCss.textCaption}>解密数据体积</span></div>
                    <div className={css.healthItem}><span className={css.healthValue}>{ins.health.ok ? '正常' : '异常'}</span><span className={kitCss.textCaption}>数据可读性</span></div>
                    <div className={css.healthItem}>
                      <span className={css.healthValue}>{ins.time.lastActive ? new Date(ins.time.lastActive * 1000).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                      <span className={kitCss.textCaption}>最近活跃</span>
                    </div>
                    {extras && (
                      <div className={css.healthItem}>
                        <span className={css.healthValue}>{extras.freshness.walPending ? '待落库' : '已落库'}</span>
                        <span className={kitCss.textCaption}>WAL 落库状态</span>
                      </div>
                    )}
                  </div>
                </OvSection>
              )}
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  )
}
