/**
 * 社交图谱高清海报（2026-10-18 重设计）。
 *
 * 目标：导出「可直接发朋友圈」的作品级图，信息层级清楚、留白有节奏、任何比例都不裁切。
 *
 * ## 版式（三种画幅共用一套视觉语言）
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ ▌tag 标题                              3 个 KPI │  刊头：左侧品牌条 + 标题，右侧数据胶囊
 *   │   subtitle                                       │
 *   ├──────────────────────────────────────────────┤
 *   │  关系图谱  · 中心：我 · 仅好友      [图例 chips]  │  图谱卡：内嵌标题行 + 图例，图按框等比 contain
 *   │                  （图谱）                        │
 *   ├───────────────────────┬──────────────────────┤
 *   │  最亲近 TOP（排名条）    │  圈子概览（色点+成员）     │  洞察双卡：竖版为排行/两列网格，横版为紧凑条
 *   ├───────────────────────┴──────────────────────┤
 *   │             由 DSH 本地生成 · 日期               │  页脚
 *   └──────────────────────────────────────────────┘
 *
 * ## 与旧版的差异（都是实测能看出来的问题）
 *
 *  1. **修裁切 bug**：旧版图谱层固定按 16:9（1184×360）渲染，再 contain 进 3:4/1:1 的
 *     竖框 —— 宽度溢出后左右被裁掉。现在宿主按目标框的宽高比渲染图层（见 graph-canvas-host
 *     `renderPoster`），这里只做等比 contain。
 *  2. **排版重做**：KPI 从「整行大卡」改为右侧胶囊；图谱卡带内部标题与图例；底部
 *     「最亲近 TOP / 圈子概览」两张卡并排（竖版排行条，横版紧凑条），不再是两行散块。
 *  3. **主题**：每套风格补 accent 强调色，标题品牌条 / 排名徽章 / 柱条 / 图例共用同一强调色。
 *
 * ## 画幅（逻辑像素，buildPoster 默认再放大到 8K 内）
 *
 *   · 1:1 方图   1080 × 1080（朋友圈九宫格/头像位）
 *   · 3:4 竖版   1080 × 1440（朋友圈主图，信息量最大）
 *   · 16:9 横版  1280 × 720（聊天/网页分享）
 *
 * @module panels/graph-poster
 */

export type PosterRatio = '1:1' | '3:4' | '16:9'
export type PosterStyle = 'light' | 'dark' | 'neon'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PosterLayout {
  width: number
  height: number
  /** 刊头（标题/tag/副标题）与右侧 KPI 胶囊 */
  masthead: Rect
  stats: Rect
  /** 图谱卡（含内部标题行） */
  graphCard: Rect
  /** 图谱真正绘制的区域（图谱卡内，扣掉标题行与内边距） */
  graphArea: Rect
  /** 底部两张洞察卡 */
  relations: Rect
  communities: Rect
  /** 页脚基线 */
  footerY: number
}

/** 画幅基准尺寸与区块位置（逻辑像素；48 为统一外边距）。 */
const BASE: Record<PosterRatio, PosterLayout> = {
  '1:1': {
    width: 1080,
    height: 1080,
    masthead: { x: 48, y: 40, w: 984, h: 108 },
    stats: { x: 576, y: 58, w: 456, h: 76 },
    graphCard: { x: 48, y: 158, w: 984, h: 560 },
    graphArea: { x: 72, y: 224, w: 936, h: 470 },
    relations: { x: 48, y: 734, w: 536, h: 252 },
    communities: { x: 604, y: 734, w: 428, h: 252 },
    footerY: 1036,
  },
  '3:4': {
    width: 1080,
    height: 1440,
    masthead: { x: 48, y: 44, w: 984, h: 124 },
    stats: { x: 576, y: 66, w: 456, h: 80 },
    graphCard: { x: 48, y: 178, w: 984, h: 800 },
    graphArea: { x: 72, y: 246, w: 936, h: 710 },
    relations: { x: 48, y: 994, w: 536, h: 300 },
    communities: { x: 604, y: 994, w: 428, h: 300 },
    footerY: 1368,
  },
  '16:9': {
    width: 1280,
    height: 720,
    masthead: { x: 48, y: 26, w: 1120, h: 92 },
    stats: { x: 796, y: 40, w: 436, h: 64 },
    // 横版用「左图谱 + 右洞察」双栏：图谱区接近方形（圆形关系图不再被摊成细条），
    // 右侧上下两张卡把画布填满，底部只留页脚。
    graphCard: { x: 48, y: 126, w: 760, h: 520 },
    graphArea: { x: 72, y: 188, w: 712, h: 434 },
    relations: { x: 824, y: 126, w: 408, h: 250 },
    communities: { x: 824, y: 390, w: 408, h: 256 },
    footerY: 704,
  },
}

/**
 * 取某画幅的版式。
 *
 * 旧实现会在圈子变多时把画布拉高；新设计把圈子收进固定高度的「圈子概览」卡（超出省略），
 * 画幅保持标准尺寸便于分享。`communityCount` 保留参数只为兼容既有调用。
 * @param ratio - 画幅。
 * @param communityCount - 圈子数量（>8 时由调用方截断；布局不随其变化）。
 * @returns 版式矩形。
 */
export function getPosterLayout(ratio: PosterRatio, communityCount = 0): PosterLayout {
  void communityCount
  return BASE[ratio]
}

export interface PosterStatItem {
  label: string
  value: string
}

export interface PosterRelation {
  name: string
  msg: number
  /** 圆形头像精灵（可选，缺失时画灰底圆） */
  sprite?: HTMLCanvasElement | null
}

export interface PosterCommunity {
  color: string
  count: number
  /** 前两个成员名（用于「xx 等 N 人」） */
  names: string
}

/** 图例小样：线段 / 色点。 */
export interface PosterLegendItem {
  kind: 'line' | 'dot'
  color: string
  label: string
}

export interface PosterTheme {
  /** 背景渐变（从上到下） */
  bgTop: string
  bgBottom: string
  /** 点阵装饰 */
  dot: string
  /** 右上光斑 */
  glow: string
  /** 强调色（品牌条/排名/柱条/图例） */
  accent: string
  /** 强调色低透明底 */
  accentSoft: string
  /** tag 文字 */
  tag: string
  /** 标题 */
  title: string
  /** 副标题 */
  subtitle: string
  /** 统计胶囊 */
  statCardBg: string
  statCardBorder: string
  statLabel: string
  statValue: string
  /** 卡片（图谱/洞察） */
  cardBg: string
  cardBorder: string
  /** 卡内标题行 */
  cardTitle: string
  cardMeta: string
  /** 榜单/柱条底槽 */
  track: string
  /** 图例/页脚 */
  legend: string
  footer: string
}

export const POSTER_THEMES: Record<PosterStyle, PosterTheme> = {
  light: {
    bgTop: '#f5f7fd', bgBottom: '#e8edf9',
    dot: 'rgba(61,107,242,0.05)',
    glow: 'rgba(61,107,242,0.12)',
    accent: '#3d6bf2', accentSoft: 'rgba(61,107,242,0.10)',
    tag: '#5f6c92', title: '#161d2e', subtitle: '#6b7594',
    statCardBg: 'rgba(255,255,255,0.96)', statCardBorder: 'rgba(22,29,46,0.07)',
    statLabel: '#7f8aae', statValue: '#161d2e',
    cardBg: '#ffffff', cardBorder: 'rgba(22,29,46,0.09)',
    cardTitle: '#1b2233', cardMeta: '#8a94b8', track: 'rgba(22,29,46,0.07)',
    legend: '#7f8aae', footer: '#9aa4bf',
  },
  dark: {
    bgTop: '#0b1120', bgBottom: '#131b2e',
    dot: 'rgba(96,150,230,0.06)',
    glow: 'rgba(47,212,245,0.14)',
    accent: '#2fd4f5', accentSoft: 'rgba(47,212,245,0.12)',
    tag: '#5c7ba6', title: '#e8eef7', subtitle: '#8aa0c0',
    statCardBg: 'rgba(19,28,47,0.92)', statCardBorder: 'rgba(140,170,220,0.14)',
    statLabel: '#7d92b3', statValue: '#eef3fa',
    cardBg: 'rgba(12,18,32,0.92)', cardBorder: 'rgba(140,170,220,0.16)',
    cardTitle: '#e8eef7', cardMeta: '#7d92b3', track: 'rgba(140,170,220,0.12)',
    legend: '#7d92b3', footer: '#5f7396',
  },
  neon: {
    bgTop: '#0a0618', bgBottom: '#170d30',
    dot: 'rgba(190,80,255,0.07)',
    glow: 'rgba(0,240,255,0.15)',
    accent: '#b26bff', accentSoft: 'rgba(178,107,255,0.14)',
    tag: '#8b6cc8', title: '#f3ecff', subtitle: '#9a8acb',
    statCardBg: 'rgba(24,14,48,0.94)', statCardBorder: 'rgba(190,120,255,0.20)',
    statLabel: '#8f7bc4', statValue: '#f6f0ff',
    cardBg: 'rgba(16,9,34,0.94)', cardBorder: 'rgba(190,120,255,0.22)',
    cardTitle: '#f3ecff', cardMeta: '#8f7bc4', track: 'rgba(190,120,255,0.14)',
    legend: '#8f7bc4', footer: '#6d5a9e',
  },
}

export interface PosterInput {
  /** 已渲染好的图谱图层（按目标框比例渲染，未污染画布） */
  graphLayer: HTMLCanvasElement
  ratio: PosterRatio
  style: PosterStyle
  tag: string
  title: string
  subtitle: string
  /** 图谱卡内标题行右侧的元信息（如「中心：我 · 仅好友 · 节点 87」） */
  graphMeta?: string
  stats: PosterStatItem[]
  topRelations?: PosterRelation[]
  communities?: PosterCommunity[]
  /** 图例小样；缺省时退回 legend 文本 */
  legendItems?: PosterLegendItem[]
  /** 旧接口：整段图例文本（无 legendItems 时绘制在页脚上方） */
  legend?: string
  footer: string
  /** 头像模糊强度(px,0=关闭):只糊头像位图;名字/消息数保持清晰（与画布同一口径） */
  blurNodes?: number
  /** 输出倍率（默认 7，上限 8K） */
  scale?: number
}

const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** 文本截断（按像素宽逐字裁，末尾加省略号）。 */
function ellipsis(text: string, maxPx: number, font: string, ctx: CanvasRenderingContext2D): string {
  if (maxPx <= 0) return ''
  ctx.save()
  ctx.font = font
  let t = text
  while (t.length > 1 && ctx.measureText(t).width > maxPx) t = t.slice(0, -1)
  ctx.restore()
  return t.length < text.length ? t.slice(0, -1) + '…' : text
}

/** 数字格式化：≥1 万显示 x.x万。 */
function fmtCount(n: number): string {
  if (n >= 10000) {
    const v = n / 10000
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}万`
  }
  return String(n)
}

/** 背景：渐变 + 点阵 + 右上光斑。 */
function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, th: PosterTheme): void {
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, th.bgTop)
  bg.addColorStop(1, th.bgBottom)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = th.dot
  for (let y = 24; y < H; y += 38) {
    for (let x = 24; x < W; x += 38) {
      ctx.beginPath()
      ctx.arc(x, y, 1.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  const glow = ctx.createRadialGradient(W - 110, 70, 10, W - 110, 70, 320)
  glow.addColorStop(0, th.glow)
  glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow
  ctx.fillRect(W - 480, 0, 480, 480)
}

/** 刊头：左侧品牌条 + tag 胶囊 + 标题 + 副标题（tag 与标题共用品牌条）。 */
function drawMasthead(ctx: CanvasRenderingContext2D, layout: PosterLayout, input: PosterInput, th: PosterTheme): void {
  const m = layout.masthead
  const compact = input.ratio === '16:9'
  const tagY = m.y + (compact ? 8 : 10)
  const barH = compact ? 58 : 68
  ctx.fillStyle = th.accent
  roundRect(ctx, m.x, tagY, 6, barH, 3)
  ctx.fill()

  const textX = m.x + 20
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  // tag 胶囊
  const tagFont = `600 ${compact ? 15 : 16}px ${FONT}`
  const tagW = ctx.measureText(input.tag).width
  ctx.font = tagFont
  ctx.fillStyle = th.accentSoft
  roundRect(ctx, textX, tagY, tagW + 22, compact ? 26 : 28, 14)
  ctx.fill()
  ctx.fillStyle = th.accent
  ctx.fillText(input.tag, textX + 11, tagY + (compact ? 19 : 20))

  // 标题
  ctx.fillStyle = th.title
  ctx.font = `700 ${compact ? 38 : 46}px ${FONT}`
  ctx.fillText(input.title, textX, tagY + (compact ? 64 : 76))
  // 副标题
  ctx.fillStyle = th.subtitle
  ctx.font = `400 ${compact ? 17 : 20}px ${FONT}`
  const subMax = layout.stats.x - textX - 24
  ctx.fillText(ellipsis(input.subtitle, subMax, `400 ${compact ? 17 : 20}px ${FONT}`, ctx), textX, tagY + (compact ? 90 : 106))
}

/** 刊头右侧：KPI 胶囊（label 上 / value 下）。 */
function drawStats(ctx: CanvasRenderingContext2D, layout: PosterLayout, input: PosterInput, th: PosterTheme): void {
  const s = layout.stats
  const items = input.stats.slice(0, 3)
  if (items.length === 0) return
  const gap = 12
  const cardW = (s.w - gap * (items.length - 1)) / items.length
  items.forEach((item, i) => {
    const x = s.x + i * (cardW + gap)
    roundRect(ctx, x, s.y, cardW, s.h, 18)
    ctx.fillStyle = th.statCardBg
    ctx.fill()
    ctx.strokeStyle = th.statCardBorder
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = th.statLabel
    ctx.font = `500 ${layout.width >= 1200 ? 15 : 16}px ${FONT}`
    ctx.fillText(item.label, x + cardW / 2, s.y + (layout.width >= 1200 ? 26 : 30))
    ctx.fillStyle = th.statValue
    ctx.font = `700 ${layout.width >= 1200 ? 28 : 32}px ${FONT}`
    ctx.fillText(item.value, x + cardW / 2, s.y + s.h - (layout.width >= 1200 ? 16 : 18))
  })
}

/** 图例 chips（线段 / 色点 + 文案），返回总宽度。 */
function drawLegendChips(
  ctx: CanvasRenderingContext2D, x: number, y: number, maxW: number, items: PosterLegendItem[], th: PosterTheme,
): number {
  const font = `400 13px ${FONT}`
  ctx.font = font
  const gap = 14
  let cx = x
  for (const it of items) {
    const labelW = ctx.measureText(it.label).width
    const chipW = 16 + 6 + labelW
    if (cx + chipW > x + maxW) break
    ctx.save()
    if (it.kind === 'dot') {
      ctx.beginPath()
      ctx.arc(cx + 4, y - 4, 4, 0, Math.PI * 2)
      ctx.fillStyle = it.color
      ctx.fill()
    } else {
      ctx.strokeStyle = it.color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, y - 4)
      ctx.lineTo(cx + 10, y - 4)
      ctx.stroke()
    }
    ctx.fillStyle = th.legend
    ctx.fillText(it.label, cx + 16, y)
    ctx.restore()
    cx += chipW + gap
  }
  return cx - x
}

/** 图谱卡：外卡 + 内部标题行（左标题/元信息，右图例）+ 等比 contain 的图谱层。
 *  @param legendInCard - 图例画在卡内标题行右侧（宽卡）还是由调用方画在卡外下方（窄卡）。 */
function drawGraphCard(
  ctx: CanvasRenderingContext2D, layout: PosterLayout, input: PosterInput, th: PosterTheme, legendInCard: boolean,
): void {
  const card = layout.graphCard
  const area = layout.graphArea
  roundRect(ctx, card.x, card.y, card.w, card.h, 26)
  ctx.fillStyle = th.cardBg
  ctx.fill()
  ctx.strokeStyle = th.cardBorder
  ctx.lineWidth = 1.5
  ctx.stroke()

  // 标题行
  const headY = card.y + 26
  ctx.textAlign = 'left'
  ctx.beginPath()
  ctx.arc(card.x + 30, headY - 6, 4, 0, Math.PI * 2)
  ctx.fillStyle = th.accent
  ctx.fill()
  ctx.fillStyle = th.cardTitle
  ctx.font = `600 18px ${FONT}`
  ctx.fillText('关系图谱', card.x + 42, headY)
  const metaX = card.x + 42 + ctx.measureText('关系图谱').width + 14
  if (input.graphMeta) {
    ctx.fillStyle = th.cardMeta
    ctx.font = `400 14px ${FONT}`
    // 宽卡把图例画在标题行右侧；窄卡（16:9 左栏）图例画到卡外，这里只留元信息
    let legendW = 0
    if (legendInCard) {
      const legendItems = input.legendItems ?? []
      ctx.save()
      ctx.font = `400 13px ${FONT}`
      for (const it of legendItems) legendW += 16 + 6 + ctx.measureText(it.label).width + 14
      ctx.restore()
    }
    const metaMax = card.x + card.w - 30 - legendW - 24 - metaX
    ctx.fillText(ellipsis(input.graphMeta, metaMax, `400 14px ${FONT}`, ctx), metaX, headY)
    if (legendInCard && legendW > 0) {
      ctx.save()
      drawLegendChips(ctx, card.x + card.w - 30 - legendW + 14, headY, legendW, input.legendItems ?? [], th)
      ctx.restore()
    }
  }

  // 图谱层：等比 contain（不拉伸、不裁切；宿主按区域比例渲染图层）
  ctx.save()
  roundRect(ctx, area.x, area.y, area.w, area.h, 18)
  ctx.clip()
  const layerAspect = input.graphLayer.width / input.graphLayer.height
  const boxAspect = area.w / area.h
  let gx = area.x
  let gy = area.y
  let gw = area.w
  let gh = area.h
  if (layerAspect > boxAspect) {
    gh = area.w / layerAspect
    gy = area.y + (area.h - gh) / 2
  } else {
    gw = area.h * layerAspect
    gx = area.x + (area.w - gw) / 2
  }
  ctx.drawImage(input.graphLayer, gx, gy, gw, gh)
  ctx.restore()
}

/** 「最亲近 TOP」：竖版用排名条（含消息量柱），横版用紧凑头像条。 */
function drawRelations(ctx: CanvasRenderingContext2D, rect: Rect, input: PosterInput, th: PosterTheme): void {
  const rels = (input.topRelations ?? []).slice(0, 5)
  if (rels.length === 0) return
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 22)
  ctx.fillStyle = th.cardBg
  ctx.fill()
  ctx.strokeStyle = th.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.fillStyle = th.cardTitle
  ctx.font = `600 17px ${FONT}`
  ctx.fillText('最亲近 TOP', rect.x + 20, rect.y + 30)

  const maxMsg = Math.max(1, ...rels.map(r => r.msg))
  const compact = rect.h < 160
  if (compact) {
    // 横版：5 个等分小格（头像 + 名字 + 消息量）。所有基线都按卡片高度算，
    // 旧版写死偏移会在 16:9 的矮卡里把名字/数字画到卡片外、压住页脚。
    const n = rels.length
    const itemW = (rect.w - 24) / n
    const avR = Math.max(13, Math.min(17, (rect.h - 62) / 2))
    const avY = rect.y + 30 + avR + 10
    rels.forEach((rel, i) => {
      const cx = rect.x + 12 + itemW * (i + 0.5)
      ctx.save()
      if (rel.sprite) {
        ctx.beginPath()
        ctx.arc(cx, avY, avR, 0, Math.PI * 2)
        ctx.clip()
        const blurPx = input.blurNodes ?? 0
        if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`
        ctx.drawImage(rel.sprite, cx - avR, avY - avR, avR * 2, avR * 2)
        if (blurPx > 0) ctx.filter = 'none'
      } else {
        ctx.beginPath()
        ctx.arc(cx, avY, avR, 0, Math.PI * 2)
        ctx.fillStyle = th.track
        ctx.fill()
      }
      ctx.restore()
      ctx.textAlign = 'center'
      ctx.fillStyle = th.cardTitle
      ctx.font = `500 13px ${FONT}`
      ctx.fillText(ellipsis(rel.name, itemW - 12, `500 13px ${FONT}`, ctx), cx, avY + avR + 14)
      ctx.fillStyle = th.cardMeta
      ctx.font = `400 12px ${FONT}`
      ctx.fillText(fmtCount(rel.msg), cx, avY + avR + 28)
    })
    return
  }

  // 竖版：排名 + 头像 + 名字 + 消息量柱 + 数值
  const rowTop = rect.y + 44
  const rowH = (rect.h - 44 - 12) / rels.length
  rels.forEach((rel, i) => {
    const cy = rowTop + rowH * i + rowH / 2
    // 排名徽章
    ctx.beginPath()
    ctx.arc(rect.x + 28, cy, 11, 0, Math.PI * 2)
    ctx.fillStyle = i < 3 ? th.accentSoft : th.track
    ctx.fill()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = i < 3 ? th.accent : th.cardMeta
    ctx.font = `700 12px ${FONT}`
    ctx.fillText(String(i + 1), rect.x + 28, cy + 0.5)
    // 头像
    const avR = 15
    const ax = rect.x + 62
    ctx.save()
    if (rel.sprite) {
      ctx.beginPath()
      ctx.arc(ax, cy, avR, 0, Math.PI * 2)
      ctx.clip()
      const blurPx = input.blurNodes ?? 0
      if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`
      ctx.drawImage(rel.sprite, ax - avR, cy - avR, avR * 2, avR * 2)
      if (blurPx > 0) ctx.filter = 'none'
    } else {
      ctx.beginPath()
      ctx.arc(ax, cy, avR, 0, Math.PI * 2)
      ctx.fillStyle = th.track
      ctx.fill()
    }
    ctx.restore()
    // 名字
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = th.cardTitle
    ctx.font = `500 15px ${FONT}`
    // 名字：固定列宽（150），超长省略 —— 旧版把「最大可用宽」当实际宽，长名字会画到柱条下面。
    const nameMax = 150
    const barX = rect.x + 86 + nameMax + 12
    const barW = Math.max(30, rect.x + rect.w - 84 - barX)
    ctx.fillText(ellipsis(rel.name, nameMax, `500 15px ${FONT}`, ctx), rect.x + 86, cy)
    // 柱条
    roundRect(ctx, barX, cy - 3, barW, 6, 3)
    ctx.fillStyle = th.track
    ctx.fill()
    roundRect(ctx, barX, cy - 3, Math.max(4, barW * (rel.msg / maxMsg)), 6, 3)
    ctx.fillStyle = th.accent
    ctx.fill()
    // 数值
    ctx.textAlign = 'right'
    ctx.fillStyle = th.cardMeta
    ctx.font = `500 13px ${FONT}`
    ctx.fillText(fmtCount(rel.msg), rect.x + rect.w - 20, cy)
  })
}

/** 「圈子概览」：竖版两列网格，横版两列紧凑列表。 */
function drawCommunities(ctx: CanvasRenderingContext2D, rect: Rect, input: PosterInput, th: PosterTheme): void {
  const comms = (input.communities ?? []).slice(0, 8)
  if (comms.length === 0) return
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 22)
  ctx.fillStyle = th.cardBg
  ctx.fill()
  ctx.strokeStyle = th.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.fillStyle = th.cardTitle
  ctx.font = `600 17px ${FONT}`
  ctx.fillText('圈子概览', rect.x + 20, rect.y + 30)
  ctx.fillStyle = th.cardMeta
  ctx.font = `400 13px ${FONT}`
  const countLabel = `${String(comms.length)} 个圈子`
  ctx.fillText(countLabel, rect.x + rect.w - 20 - ctx.measureText(countLabel).width, rect.y + 30)

  const cols = 2
  const contentTop = rect.y + 48
  const contentH = rect.h - 48 - 10
  const rows = Math.max(1, Math.ceil(comms.length / cols))
  const rowH = contentH / rows
  const colW = (rect.w - 28) / cols
  comms.forEach((c, i) => {
    const col = Math.floor(i / rows)
    const row = i % rows
    const x = rect.x + 14 + col * colW
    const cy = contentTop + row * rowH + rowH / 2
    ctx.beginPath()
    ctx.arc(x + 4, cy, 5, 0, Math.PI * 2)
    ctx.fillStyle = c.color
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.fillStyle = th.cardTitle
    ctx.font = `500 13px ${FONT}`
    const suffix = c.count > 2 ? ' 等' : ''
    const label = `${String(c.count)} 人 · ${c.names}${suffix}`
    ctx.fillText(ellipsis(label, colW - 26, `500 13px ${FONT}`, ctx), x + 14, cy + 0.5)
  })
}

/** 页脚：生成信息居中 + 右上角品牌小字。 */
function drawFooter(ctx: CanvasRenderingContext2D, layout: PosterLayout, input: PosterInput, th: PosterTheme): void {
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = th.footer
  ctx.font = `400 17px ${FONT}`
  ctx.fillText(input.footer, layout.width / 2, layout.footerY)
  ctx.textAlign = 'right'
  ctx.fillStyle = th.footer
  ctx.font = `600 12px ${FONT}`
  ctx.fillText('DSH · SHARE CARD', layout.width - 48, layout.height - 26)
}

/**
 * 渲染海报（返回高分辨率 canvas，未污染，可直接 toBlob/toDataURL）。
 * @param input - 海报内容（图谱层、画幅、风格、标题、统计、榜单、圈子、图例、页脚）。
 * @returns 海报 canvas。
 */
export function buildPoster(input: PosterInput): HTMLCanvasElement {
  const layout = getPosterLayout(input.ratio, input.communities?.length ?? 0)
  const th = POSTER_THEMES[input.style]
  const scale = Math.max(1, Math.min(input.scale ?? 7, 8192 / Math.max(layout.width, layout.height)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(layout.width * scale))
  canvas.height = Math.max(1, Math.round(layout.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建海报画布')
  ctx.setTransform(scale, 0, 0, scale, 0, 0)

  drawBackground(ctx, layout.width, layout.height, th)
  drawMasthead(ctx, layout, input, th)
  drawStats(ctx, layout, input, th)
  // 宽卡（方图/竖版）图例在卡内标题行；窄卡（16:9 左栏）把图例放到图谱卡下方一行，
  // 否则「中心 / 口径」元信息会被图例挤成省略号。
  const legendInCard = layout.graphCard.w >= 900
  drawGraphCard(ctx, layout, input, th, legendInCard)
  if (!legendInCard && (input.legendItems?.length ?? 0) > 0) {
    drawLegendChips(ctx, layout.graphCard.x, layout.graphCard.y + layout.graphCard.h + 28, layout.width - 96, input.legendItems ?? [], th)
  }
  drawRelations(ctx, layout.relations, input, th)
  drawCommunities(ctx, layout.communities, input, th)
  drawFooter(ctx, layout, input, th)
  return canvas
}

/** 海报 canvas → data URL（部分浏览器 PNG 大图内存有限，用 toBlob 后转）。 */
export function posterToDataUrl(canvas: HTMLCanvasElement, format: 'png' | 'jpeg' = 'png'): Promise<string> {
  return new Promise((res, rej) => {
    canvas.toBlob(
      (b) => {
        if (!b) { rej(new Error('海报生成失败')); return }
        const fr = new FileReader()
        fr.onload = () => { res(fr.result as string) }
        fr.onerror = () => { rej(fr.error ?? new Error('读取失败')) }
        fr.readAsDataURL(b)
      },
      format === 'jpeg' ? 'image/jpeg' : 'image/png',
      format === 'jpeg' ? 0.95 : undefined,
    )
  })
}
