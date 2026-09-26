/**
 * 词云卡片（界面优化阶段 4）：CSS 词云——零依赖、DOM 天然可交互。
 *
 * 选型说明：echarts-wordcloud 的 peerDependency 只认 echarts 5（本项目用 6，兼容风险实打实），
 * 而 flex-wrap + 权重字号的 DOM 词云零依赖、hover/点击是真实元素事件，不引 canvas 命中检测。
 *
 * 交互：hover 显示精确次数（title + 卡片内计数条）；字号六档按权重分位映射，颜色三阶
 * （cyan/blue/purple）随权重。**点击一个词 → 全局搜索该词**（R11，2026-09-25 接入）：
 * 走 `search-events.ts` 的 window 事件（不引全局状态库）——`WechatDataPanel` 收到后开导航条、
 * 聚焦输入框、把词种进 `searchQuery`，剩下的交给既有 debounce 搜索链路。词元素用 `<button>`
 * 而不是带 onClick 的 span：键盘可达（Tab + Enter）在 60 个交互目标上是硬要求。
 */
import { useEffect, useState } from 'react'
import { apiGetWordCloud, readRenderCache, writeRenderCache } from '../api.ts'
import { openGlobalSearch } from './search-events.ts'
import { Card } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './wordcloud-card.module.css'

export interface WordCloudCardProps {
  /** 统计范围：global=全部消息 / chat=单会话 / moments=朋友圈正文。 */
  scope: 'global' | 'chat' | 'moments'
  /** scope=chat 时的会话 username。 */
  username?: string
  /** scope=global 时的年份（缺省=全部年份）。 */
  year?: number
  /** 卡片标题（默认按 scope 生成）。 */
  title?: string
  /** 词数上限（默认 60）。 */
  limit?: number
}

/** 权重 → 字号档（六档，min 归一后分位）。 */
const FONT_STEPS = [12, 14, 16, 18, 22, 28] as const
/** 权重 → 颜色阶（三阶主题色）。 */
const TONES = ['low', 'mid', 'high'] as const

/**
 * 渲染一张词云卡片。
 * @param props - 范围与展示参数。
 * @returns 卡片元素。
 */
/** 一次词云结果（词表 + 统计到的正文条数）。 */
interface WordCloudSnapshot {
  words: Array<{ text: string; count: number }>
  scanned: number
}

/** 无缓存时的初值（同一引用，避免每次渲染新建对象）。 */
const EMPTY_SNAPSHOT: WordCloudSnapshot = { words: [], scanned: 0 }

export function WordCloudCard({ scope, username, year, title, limit }: WordCloudCardProps): React.JSX.Element {
  // 首屏瞬时渲染：上次成功渲染过的词表从 localStorage 取回。全库统计首跑要 ~3 秒
  // （优化前 15 秒），没有它每次切回本页都要再等一遍。
  const cacheKey = `wordcloud:${scope}:${username ?? ''}:${year ?? 'all'}:${Math.min(Math.max(1, limit ?? 60), 200)}`
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
    // 同时发起，会把它们一并推迟几秒 —— 实测「世界板块」自身只要 13ms，排在热词后面却等到
    // 17,008ms（`working/probe-queue-out.txt`）。延后一拍让小块先出，热词随后补上。
    const timer = setTimeout(() => {
      void apiGetWordCloud({ scope, username, year, limit })
        .then((r) => {
          if (!alive) return
          setSnap({ words: r.words, scanned: r.scanned })
          writeRenderCache(cacheKey, { words: r.words, scanned: r.scanned })
        })
        .catch((e: unknown) => { if (alive) setError((e as Error).message) })
        .finally(() => { if (alive) setLoading(false) })
    }, 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [scope, username, year, limit, cacheKey])

  const words = snap.words
  const scanned = snap.scanned
  const max = words.length > 0 ? words[0]!.count : 1
  const min = words.length > 0 ? words[words.length - 1]!.count : 1
  const span = Math.max(1, max - min)
  const heading = title ?? (scope === 'chat' ? '群聊热词' : scope === 'moments' ? '朋友圈热词' : year ? `${year} 年热词` : '全部热词')

  return (
    <Card title={heading} extra={words.length > 0 ? <span className={kitCss.textCaption}>{scanned.toLocaleString()} 条正文</span> : undefined}>
      {/* 有旧快照时不要用「统计中」盖住它 —— 首屏缓存的意义就是立刻有内容可看 */}
      {loading && words.length === 0 && <div className={kitCss.emptyInline}>统计中…</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {!loading && !error && words.length === 0 && <div className={kitCss.emptyInline}>暂无足够文本（每个词至少出现 2 次）</div>}
      {words.length > 0 && (
        <div className={css.cloud} aria-label={`${heading}词云`}>
          {words.map((w, i) => {
            const t = (w.count - min) / span
            const fontStep = FONT_STEPS[Math.min(FONT_STEPS.length - 1, Math.floor(t * FONT_STEPS.length))] ?? FONT_STEPS[0]!
            const tone = TONES[Math.min(TONES.length - 1, Math.floor((1 - i / words.length) * TONES.length))] ?? TONES[0]!
            return (
              <button
                key={w.text}
                type="button"
                className={css[tone]}
                style={{ fontSize: `${fontStep}px` }}
                title={`${w.text} · ${w.count} 次 · 点击在全局搜索中查找`}
                onClick={() => { openGlobalSearch(w.text) }}
              >
                {w.text}
              </button>
            )
          })}
        </div>
      )}
    </Card>
  )
}
