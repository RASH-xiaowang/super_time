/**
 * ClawBot 对话流（C1，2026-10-13）：把「接入会话」读成一段对话，而不是一张审计表。
 *
 * ## 读法纪律（docs/CLAWBOT-THREAD-REDESIGN.html §3.2）
 *
 * - **正序、贴底**：后端仍按 `id DESC` 分页（零后端改动），渲染时把已加载行反转成正序；
 *   新消息出现在底部。滚动在底部时自动贴底；不在底部时由外层浮一条「N 条新消息 ↓」，
 *   点击才跳（不打断阅读）—— 贴底与浮标的状态在外层（滚动容器归它），本组件只负责渲染；
 * - **气泡**：入站左、出站右；方向不靠 Badge，靠左右与描边色；
 * - **时间分隔条**：相邻消息间隔 > 30 分钟插一条居中时间戳；
 * - **比例护栏**：气泡 max-width 按面板档（86/72/64%）+ min-width 120px（G7），
 *   正文 overflow-wrap: anywhere —— 长文不再把列压塌（P0 的对话流解法）。
 *
 * ## 媒体呈现的家在这里
 *
 * `useClawbotMediaAccess` / `MediaCell` 从 clawbot-chat.tsx 搬进来：对话流是媒体的主消费者
 *（缩图 / 占位 / 动作按钮都在气泡里），明细表格复用同一套。搬文件不搬语义 ——
 * `clawbot-ui.wiring.spec.ts` 的媒体断言改读 chat + thread 的 union（组件搬家守卫不失效）。
 *
 * @module panels/clawbot-thread
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClawbotMessage, ClawbotMediaResult } from '@deepseek-ai/dsh-wechat-data/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { apiGetClawbotMedia, apiOpenPath } from '../api.ts'
import { fmtBytes } from '../utils/format.ts'
import css from './clawbot.module.css'
import { desktopActionProps } from '../ui/desktop-only.tsx'

/** 距底这个像素数内算「贴在底部」（贴底语义的判定带）。 */
const AT_BOTTOM_PX = 40

/**
 * 对话流的滚动纪律（模块级 hook：让 ClawbotChatView 留在 250 行棘轮线内）。
 *
 * 四件事，都只围绕「唯一滚动容器」这一个 div：
 *  · **首屏贴底**：对话从最新一条读起；
 *  · **实时新增**：贴底则继续贴底；不在底部则浮标计数（`pendingNew`），点击才跳，不打断阅读；
 *  · **加载更多**：更旧的页追加在**顶部**，`beginLoadMore` 记住追加前高度、行集落地后补回
 *    scrollTop（读的位置不跳）；
 *  · **内容长高**：缩略图异步加载、气泡换行会让内容在行集不变时长高 —— 首屏的贴底跑在
 *    图片加载之前，只靠行集效应会差一截（实测差 396px），用 ResizeObserver 补上；
 *    用户一旦上滚就不与之争（atBottomRef 假）。
 * @param rowsLength - 已加载行数（变化即触发滚动纪律）。
 * @returns 滚动容器 ref / 内容 ref / 滚动监听 / 浮标计数与清零 / 贴底 / 加载更多锚。
 */
export function useConversationScroll(rowsLength: number): {
  scrollRef: React.RefObject<HTMLDivElement>
  contentRef: (node: HTMLDivElement | null) => void
  onScroll: () => void
  pendingNew: number
  clearPending: () => void
  scrollToEnd: () => void
  beginLoadMore: () => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 是否贴在底部；用 ref —— 滚动不该触发重渲染。 */
  const atBottomRef = useRef(true)
  const [pendingNew, setPendingNew] = useState(0)
  const prevLenRef = useRef(0)
  const anchorRef = useRef<{ active: boolean, height: number }>({ active: false, height: 0 })
  const roRef = useRef<ResizeObserver | null>(null)

  const scrollToEnd = useCallback((): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  /** 滚动监听：只更新 ref 与浮标清零，不触发重渲染。 */
  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (el === null) return
    const at = el.scrollHeight - el.clientHeight - el.scrollTop <= AT_BOTTOM_PX
    atBottomRef.current = at
    if (at) setPendingNew(0)
  }, [])

  const contentRef = useCallback((node: HTMLDivElement | null): void => {
    roRef.current?.disconnect()
    roRef.current = null
    if (node === null) return
    const ro = new ResizeObserver(() => { if (atBottomRef.current) scrollToEnd() })
    ro.observe(node)
    roRef.current = ro
  }, [scrollToEnd])

  useEffect(() => () => { roRef.current?.disconnect() }, [])

  useEffect(() => {
    const el = scrollRef.current
    const prev = prevLenRef.current
    const delta = rowsLength - prev
    prevLenRef.current = rowsLength
    if (el === null) return
    if (anchorRef.current.active) {
      el.scrollTop += el.scrollHeight - anchorRef.current.height
      anchorRef.current.active = false
      return
    }
    if (prev === 0) { scrollToEnd(); return }
    if (delta > 0) {
      if (atBottomRef.current) scrollToEnd()
      else setPendingNew((n) => n + delta)
    }
  }, [rowsLength, scrollToEnd])

  /** 加载更多前调用：记住当前高度，行集落地后补回 scrollTop。 */
  const beginLoadMore = useCallback((): void => {
    const el = scrollRef.current
    anchorRef.current = el === null ? { active: false, height: 0 } : { active: true, height: el.scrollHeight }
  }, [])

  const clearPending = useCallback((): void => { setPendingNew(0) }, [])

  return { scrollRef, contentRef, onScroll, pendingNew, clearPending, scrollToEnd, beginLoadMore }
}

/** 相邻消息超过这个间隔就插一条时间分隔条（对话 UI 的常规节奏）。 */
const SEP_GAP_MS = 30 * 60_000

/** 附件类型的展示标签（气泡媒体副行用）。 */
const KIND_LABEL: Record<string, string> = { image: '图片', voice: '语音', video: '视频', file: '文件' }

/**
 * 体积展示：复用全仓唯一的 `fmtBytes`（`utils/format.ts`；第二份实现会被
 * `format-single-source.spec.ts` 咬住）。附件体积是协议自带的**密文提示值**
 * （`mid_size` / `voice_size` / ... ≈ 明文 + 填充），展示时统一加「约」——
 * 不谎称是精确的本地文件大小。
 * @param n - 字节数。
 * @returns 如 `约 1.2 KB`。
 */
function approxBytes(n: number): string {
  return `约 ${fmtBytes(n)}`
}

/**
 * 附件取数状态与动作（结果按行 id 缓存，失败也缓存 —— 重渲染不重复打后端）。
 *
 * 后端的**自动取回队列**已经把字节下载解密好了；这里的 `load` 通常只是一次本地
 * 缓存读（图片拿 dataUrl；非图片拿路径）。`reload` 供失败后重试（先清缓存再取）。
 * @param notice - 面板的瞬时提示出口（失败原因展示用；只用到 `flash`）。
 * @returns 缓存 / 进行中集合 / 取数 / 重试 / 打开 / 放大预览状态。
 */
export function useClawbotMediaAccess(notice: { flash: (text: string, ms?: number) => void }): {
  by: Record<number, ClawbotMediaResult>
  busy: ReadonlySet<number>
  load: (row: ClawbotMessage) => Promise<ClawbotMediaResult | null>
  reload: (row: ClawbotMessage) => Promise<void>
  open: (row: ClawbotMessage) => Promise<void>
  zoom: { src: string, name: string | null } | null
  setZoom: (z: { src: string, name: string | null } | null) => void
} {
  const [by, setBy] = useState<Record<number, ClawbotMediaResult>>({})
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())
  const [zoom, setZoom] = useState<{ src: string, name: string | null } | null>(null)

  /** 取一条（缓存优先）；后端自动取回没成功时会在这里补一次网络取数。 */
  const load = useCallback(async (row: ClawbotMessage): Promise<ClawbotMediaResult | null> => {
    const got = by[row.id]
    if (got !== undefined) return got
    if (busy.has(row.id)) return null
    setBusy((prev) => { const n = new Set(prev); n.add(row.id); return n })
    try {
      const r = await apiGetClawbotMedia({ id: row.id })
      setBy((prev) => ({ ...prev, [row.id]: r }))
      if (!r.ok) notice.flash('✗ ' + (r.error ?? '取附件失败'))
      return r
    } catch (e) {
      notice.flash('✗ 取附件失败：' + (e as Error).message)
      return null
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(row.id); return n })
    }
  }, [by, busy, notice])

  /** 失败后重试：**绕过失败缓存**直接再取一次（成功后照常进缓存）。 */
  const reload = useCallback(async (row: ClawbotMessage): Promise<void> => {
    if (busy.has(row.id)) return
    setBusy((prev) => { const n = new Set(prev); n.add(row.id); return n })
    try {
      const r = await apiGetClawbotMedia({ id: row.id })
      setBy((prev) => ({ ...prev, [row.id]: r }))
      if (!r.ok) notice.flash('✗ ' + (r.error ?? '取附件失败'))
    } catch (e) {
      notice.flash('✗ 取附件失败：' + (e as Error).message)
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(row.id); return n })
    }
  }, [busy, notice])

  /** 非图片附件（语音/视频/文件）：取回后交给系统默认应用打开。 */
  const open = useCallback(async (row: ClawbotMessage): Promise<void> => {
    const r = await load(row)
    if (r === null || !r.ok) return // load 已提示失败
    if (r.path === undefined) { notice.flash('✗ 附件没有落盘路径'); return }
    try {
      await apiOpenPath(r.path)
    } catch {
      notice.flash('✗ 无法打开文件（可用资源管理器到缓存目录查看）')
    }
  }, [load, notice])

  return { by, busy, load, reload, open, zoom, setZoom }
}

/**
 * 附件单元格（气泡内 / 明细表格「正文」列共用）——按附件类型给不同形态：
 *
 * - **图片**：直接一枚缩图（84px 高、圆角描边、悬停高亮、点击放大）——**不再**显示
 *   `[图片]` 占位文字；取回中/失败（可点重试）各有独立形态（虚线框 / 琥珀色重试框）。
 * - **语音 / 视频 / 文件**：主行 = 转写或文件名 + 动作按钮（播放 / 打开），
 *   副行 = 类型标签与「约」体积；失败标 ⚠️（悬浮看原因）。
 * - 图片小图是**出现即自动取**（后端已自动下载好，这里通常只是一次本地缓存读）。
 * @param props.row - 当前行。
 * @param props.media - {@link useClawbotMediaAccess} 的句柄。
 * @param props.text - 已按打码开关处理过的正文。
 * @returns 单元格元素。
 */
export function MediaCell({ row, media, text }: {
  row: ClawbotMessage
  media: ReturnType<typeof useClawbotMediaAccess>
  text: string
}): React.JSX.Element {
  const info = row.media
  /* v8 ignore next -- 调用方只在 media 非空时渲染本组件。 */
  if (info === null) return <span className={css.textBody} title={text}>{text}</span>
  const got = media.by[row.id]
  const isBusy = media.busy.has(row.id)

  // 图片自动取小图（依赖变化只造成廉价的重查；load 自带缓存短路）。
  useEffect(() => {
    if (info.kind !== 'image') return
    if (got === undefined && !isBusy) void media.load(row)
  }, [info.kind, got, isBusy, media, row])

  const sizeHint = info.size !== null ? approxBytes(info.size) : ''
  const meta = [KIND_LABEL[info.kind] ?? info.kind, sizeHint].filter((s) => s !== '').join(' · ')

  if (info.kind === 'image') {
    return (
      <div className={css.contentStack}>
        {got?.dataUrl !== undefined
          ? (
            <button
              type="button"
              className={css.thumbBtn}
              title="点击查看大图"
              onClick={() => { if (got?.dataUrl !== undefined) media.setZoom({ src: got.dataUrl, name: got.name ?? null }) }}
            >
              <img className={css.thumbImg} src={got.dataUrl} alt="附件图片" />
            </button>
            )
          : isBusy
            ? <div className={css.thumbBox}>取回中…</div>
            : got !== undefined && !got.ok
              ? <button type="button" className={css.thumbBoxRetry} title={got.error ?? ''} onClick={() => { void media.reload(row) }}>⚠️ 重试</button>
              : <div className={css.thumbBox}>等待取回…</div>}
        <span className={css.mediaMeta}>{meta}</span>
      </div>
    )
  }

  // 语音 / 视频 / 文件：转写（或文件名）当主行，动作按钮在右。
  const label = info.kind === 'file' ? (info.name ?? text) : text
  return (
    <div className={css.contentStack}>
      <div className={css.mediaRow}>
        <span className={css.mediaName} title={label}>{label}</span>
        <Button size="sm" variant="outline" disabled={isBusy} onClick={() => { void media.open(row) }} {...desktopActionProps()}>
          {isBusy ? (info.kind === 'voice' ? '解码中…' : '取回中…') : (info.kind === 'voice' ? '播放' : '打开')}
        </Button>
        {got !== undefined && !got.ok && <span className={css.mediaErr} title={got.error ?? ''}>⚠️</span>}
      </div>
      <span className={css.mediaMeta}>{meta}</span>
    </div>
  )
}

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 分隔条标签：同日 HH:MM，跨日 MM-DD HH:MM（分隔条本身已经标出了「换了一段」。） */
function sepLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay
    ? `${p2(d.getHours())}:${p2(d.getMinutes())}`
    : `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 气泡 meta 行：时刻 · 字数（类型对纯文本行恒为 text、无信息量；媒体行的类型在媒体副行里）。 */
function bubbleMeta(r: ClawbotMessage): string {
  const d = new Date(r.ts)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} · ${r.content.length} 字`
}

/**
 * 对话流：把已加载行（后端 DESC）反转成正序渲染成气泡时间线。
 *
 * 滚动容器归外层（.msgList）：贴底、浮标、加载更多哨兵都由外层摆 —— 本组件是纯渲染，
 * 不持滚动状态（否则「谁滚」又有两处，B0 的单一滚动容器纪律会被拆）。
 * @param props.rows - 已加载行（后端顺序，DESC）。
 * @param props.show - 展示层打码函数（库里与导出仍是原文）。
 * @param props.media - {@link useClawbotMediaAccess} 的句柄。
 * @returns 时间线元素。
 */
export function ClawbotThread({ rows, show, media }: {
  rows: readonly ClawbotMessage[]
  show: (text: string) => string
  media: ReturnType<typeof useClawbotMediaAccess>
}): React.JSX.Element {
  // 正序 = 把 DESC 的已加载行反转（零后端改动；loadMore 追加的更旧行落在渲染序列头部）。
  const asc = useMemo(() => rows.slice().reverse(), [rows])
  return (
    <div className={css.thread}>
      {asc.map((r, i) => {
        const prev = asc[i - 1]
        const sep = prev === undefined || r.ts - prev.ts > SEP_GAP_MS
        const out = r.direction === 'out'
        return (
          <Fragment key={r.id}>
            {sep && <span className={css.daySep}>{sepLabel(r.ts)}</span>}
            <div className={out ? `${css.bubbleRow} ${css.bubbleRowOut}` : css.bubbleRow}>
              <div className={out ? `${css.bubble} ${css.bubbleOut}` : css.bubble}>
                {r.media === null
                  ? <span className={css.bubbleText}>{show(r.content)}</span>
                  : <MediaCell row={r} media={media} text={show(r.content)} />}
                <span className={css.bubbleMeta}>{bubbleMeta(r)}</span>
              </div>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}
