/**
 * 词云卡片（界面优化阶段 4）：CSS 词云——零依赖、DOM 天然可交互。
 *
 * 选型说明：echarts-wordcloud 的 peerDependency 只认 echarts 5（本项目用 6，兼容风险实打实），
 * 而 flex-wrap + 权重字号的 DOM 词云零依赖、hover/点击是真实元素事件，不引 canvas 命中检测。
 *
 * 交互：hover 显示精确次数（title + 卡片内计数条）；字号六档按权重分位映射，颜色三阶
 * （cyan/blue/purple）随权重。**跨面板搜索跳转待 shell 提供 query 通道后接入**
 * （global-search 是受控组件、由顶栏 shell 管理状态，直接传 query 需要全局通道，首期不接半成品）。
 */
import { useEffect, useState } from 'react'
import { apiGetWordCloud } from '../api.ts'
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
export function WordCloudCard({ scope, username, year, title, limit }: WordCloudCardProps): React.JSX.Element {
  const [words, setWords] = useState<Array<{ text: string; count: number }>>([])
  const [scanned, setScanned] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (scope === 'chat' && !username) return
    let alive = true
    setLoading(true)
    setError(null)
    void apiGetWordCloud({ scope, username, year, limit })
      .then((r) => { if (alive) { setWords(r.words); setScanned(r.scanned) } })
      .catch((e: unknown) => { if (alive) setError((e as Error).message) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [scope, username, year, limit])

  const max = words.length > 0 ? words[0]!.count : 1
  const min = words.length > 0 ? words[words.length - 1]!.count : 1
  const span = Math.max(1, max - min)
  const heading = title ?? (scope === 'chat' ? '群聊热词' : scope === 'moments' ? '朋友圈热词' : year ? `${year} 年热词` : '全部热词')

  return (
    <Card title={heading} extra={words.length > 0 ? <span className={kitCss.textCaption}>{scanned.toLocaleString()} 条正文</span> : undefined}>
      {loading && <div className={kitCss.emptyInline}>统计中…</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {!loading && !error && words.length === 0 && <div className={kitCss.emptyInline}>暂无足够文本（每个词至少出现 2 次）</div>}
      {!loading && words.length > 0 && (
        <div className={css.cloud} aria-label={`${heading}词云`}>
          {words.map((w, i) => {
            const t = (w.count - min) / span
            const fontStep = FONT_STEPS[Math.min(FONT_STEPS.length - 1, Math.floor(t * FONT_STEPS.length))] ?? FONT_STEPS[0]!
            const tone = TONES[Math.min(TONES.length - 1, Math.floor((1 - i / words.length) * TONES.length))] ?? TONES[0]!
            return (
              <span
                key={w.text}
                className={css[tone]}
                style={{ fontSize: `${fontStep}px` }}
                title={`${w.text} · ${w.count} 次`}
              >
                {w.text}
              </span>
            )
          })}
        </div>
      )}
    </Card>
  )
}
