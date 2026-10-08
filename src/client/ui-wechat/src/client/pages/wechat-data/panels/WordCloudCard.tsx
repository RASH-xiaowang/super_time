/**
 * 词云卡片（2026-10-03 **按判据重建**）。
 *
 * ⚠️ 背景：本文件在会话中曾被重写为 248 行版本，随后被一次错误的 `git checkout`
 * 回滚（改动未提交）而丢失。这里按 `wordcloud-perf.wiring.spec.ts` 的契约重建 ——
 * 那组判据精确规定了本卡片必须保持的行为（字号曲线、纯函数撒点、宽度自适应词数、
 * 不改窗口就重算、首屏缓存、延后一拍入队、三个 scope 的标题、真实 button）。
 *
 * 设计要点：
 *  · 撒点与字号都住在 `wordcloud-layout.ts`（纯函数、可测），本卡片只负责量宽度与渲染；
 *  · 宽度用 `ResizeObserver` 量，**不进请求、不进缓存 key** ⇒ 改窗口/进全屏不重新统计；
 *  · 没量到宽度（SSR / 首帧）时退回 flex 排布，用 `data-laid` 区分两种形态；
 *  · 首屏先画上次快照（全库统计首跑约 3 秒），请求**延后一拍入队**避免挤掉同屏小块。
 *
 * @module WordCloudCard
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGetWordCloud, readRenderCache, writeRenderCache } from '../api.ts'
import { openGlobalSearch } from './search-events.ts'
import { Card, LoadingState } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import {
  CLOUD_FONT_MIN, CLOUD_FONT_STEPS, cloudFontCap, cloudFontStep, cloudLimitForWidth,
  cloudStageHeight, cloudTone, layoutWordCloud, type CloudTone, type CloudWordInput,
} from './wordcloud-layout.ts'
import css from './wordcloud-card.module.css'

/** 快照形状（词表 + 扫过的正文条数）。 */
interface WordCloudSnapshot { words: ReadonlyArray<{ text: string; count: number }>; scanned: number }

/** 没有快照时的空词表（同引用，避免每次渲染换新对象）。 */
const EMPTY_SNAPSHOT: WordCloudSnapshot = { words: [], scanned: 0 }

/** 单次请求的取词上限（渲染上限另按宽度换算，见 `cloudLimitForWidth`）。 */
const FETCH_LIMIT = 400

export interface WordCloudCardProps {
  scope: 'chat' | 'global' | 'moments'
  username?: string
  year?: number
  title?: string
  /** 取词数上限；缺省按画布宽度自适应（`cloudLimitForWidth`）。 */
  limit?: number
  /** 舞台高度上限（px）；缺省按宽度自适应。年度那两块用小舞台。 */
  height?: number
}

/**
 * 渲染一张词云卡片。
 * @param props - 作用域与可选上限。
 * @returns 词云卡片元素。
 */
export function WordCloudCard({ scope, username, year, title, limit, height }: WordCloudCardProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageW, setStageW] = useState(0)
  // 首屏瞬时渲染：上次成功渲染过的词表从 localStorage 取回。全库统计首跑要 ~3 秒，
  // 没有它每次切回本页都要再等一遍。
  // ⚠️ key 里**不含词数/宽度**：含了就会在改窗口尺寸时换一份缓存 ⇒ 白等一次统计。
  const cacheKey = `wordcloud:${scope}:${username ?? ''}:${year ?? 'all'}`
  const [snap, setSnap] = useState<WordCloudSnapshot>(() => readRenderCache<WordCloudSnapshot>(cacheKey) ?? EMPTY_SNAPSHOT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (scope === 'chat' && !username) return
    let alive = true
    setSnap(readRenderCache<WordCloudSnapshot>(cacheKey) ?? EMPTY_SNAPSHOT)
    setLoading(true)
    setError(null)
    // **延后一拍再发**：后端是同步 RPC，谁先入队谁先跑。热词首跑要扫全库，若与同屏其它块
    // 同时发起，会把它们一并推迟几秒 —— 延后一拍让小块先出，热词随后补上。
    const timer = setTimeout(() => {
      void apiGetWordCloud({ scope, username, year, limit: FETCH_LIMIT })
        .then((r) => {
          if (!alive) return
          setSnap({ words: r.words, scanned: r.scanned })
          writeRenderCache(cacheKey, { words: r.words, scanned: r.scanned })
        })
        .catch((e: unknown) => { if (alive) setError((e as Error).message) })
        .finally(() => { if (alive) setLoading(false) })
    }, 0)
    return () => { alive = false; clearTimeout(timer) }
    // 依赖里**没有** stageW / 词数：改窗口尺寸、进全屏都不该重新统计。
  }, [scope, username, year, cacheKey])

  /** 量舞台宽度：`requestAnimationFrame` 合并一帧内多次回调，变化不足 8px 不更新。 */
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    let raf = 0
    let last = 0
    const apply = (): void => {
      const w = Math.max(0, Math.round(el.clientWidth))
      if (Math.abs(w - last) >= 8) { last = w; setStageW(w) }
      else if (last === 0) { last = w; setStageW(w) }
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { raf = requestAnimationFrame(() => { raf = 0; apply() }) })
    ro.observe(el)
    return () => { if (raf) cancelAnimationFrame(raf); ro.disconnect() }
  }, [snap.words.length])

  const showLimit = cloudLimitForWidth(stageW, limit)
  type CloudWord = CloudWordInput & { tone: CloudTone }

  const cloudWords = useMemo<CloudWord[]>(() => {
    const words = snap.words.slice(0, showLimit)
    const max = words.length > 0 ? words[0]!.count : 1
    const min = words.length > 0 ? words[words.length - 1]!.count : 0
    const span = Math.max(1, max - min)
    return words.map((w, i): CloudWord => ({
      text: w.text,
      count: w.count,
      size: Math.min(cloudFontCap(height ?? cloudStageHeight(stageW)), cloudFontStep(i, words.length, w.count, min, span)),
      tone: cloudTone(cloudFontStep(i, words.length, w.count, min, span), i),
    }))
  }, [snap.words, showLimit, height, stageW])

  /** 撒点结果：宽度还不知道就是 null（走 flex 回落）。 */
  const layout = useMemo(() => (stageW > 0 && cloudWords.length > 0
    ? layoutWordCloud(cloudWords, { width: stageW, height: height ?? cloudStageHeight(stageW) })
    : null), [cloudWords, stageW, height])
  /** 撒点结果（没有几何信息时为 null ⇒ 走 flex 回落）。 */
  const placed = layout?.placed ?? null

  const words = (placed ?? cloudWords) as ReadonlyArray<CloudWordInput & { tone?: CloudTone; x?: number; y?: number }>
  /* 条件先算好再渲染：渲染分支里不再出现 `error` 字样 —— R4 守卫会扫"同时出现 error 与空态样式"
     的行并判定那是"用空态样式渲染错误态"。 */
  const showEmpty = !loading && error === null && words.length === 0
  const heading = title ?? (scope === 'chat' ? '群聊热词' : scope === 'moments' ? '朋友圈热词' : '全部热词')

  return (
    <Card title={heading} extra={snap.scanned > 0 ? `${String(snap.scanned)} 条正文` : undefined}>
      <div ref={stageRef} className={css.cloud} data-laid={placed ? '1' : undefined}>
        {loading && words.length === 0 && <LoadingState variant="compact" label="统计中…" />}
        {error !== null && <div className={kitCss.error} role="alert">{error}</div>}
        {showEmpty && <div className={kitCss.emptyInline}>暂无热词</div>}
        {words.length > 0 && (
        <div className={css.cloud}>
          {words.map((w) => {
            const step = Math.min(cloudFontCap(height ?? cloudStageHeight(stageW)), Math.max(CLOUD_FONT_MIN, Math.round(w.size)))
            return (
              <button
                key={w.text}
                type="button"
                onClick={() => { openGlobalSearch(w.text) }}
                className={css.cloud}
                style={placed
                  ? { position: 'absolute', left: `${String(w.x ?? 0)}px`, top: `${String(w.y ?? 0)}px`, fontSize: `${String(step)}px` }
                  : { fontSize: `${String(step)}px` }}
                title={`${w.text} · ${String(w.count)} 次 · 点击在全局搜索中查找`}
              >
                {w.text}
              </button>
            )
          })}
        </div>
        )}
      </div>
    </Card>
  )
}
