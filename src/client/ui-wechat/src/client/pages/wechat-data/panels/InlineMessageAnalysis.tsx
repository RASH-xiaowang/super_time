/**
 * 消息下方的**逐条分析**（紧凑版）。
 *
 * 形态约束：它挂在**每一条**对方消息下面，所以默认只能占一行 ——
 * 摘要给「紧张度 + 意图 Top1 + 最该做的动作」，点「详情」才展开全部命题的分布。
 * 展开时也不用大卡片，而是紧凑的概率条列表（避免把消息流撑散）。
 */
import { useState } from 'react'
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import css from './inline-analysis.module.css'

/** 一条命题的紧凑渲染：noul 走两端、choice 走概率条、score 走刻度。 */
function AnswerLine({ a }: { a: LayaAnswer }): React.JSX.Element {
  if (a.kind === 'noul') {
    const top = a.options[0]
    return (
      <div className={css.line}>
        <span className={css.q}>{a.question}</span>
        <span className={css.v}>{top === undefined ? '' : `${top.label} ${(top.probability * 100).toFixed(0)}%`}</span>
      </div>
    )
  }
  if (a.kind === 'score') {
    const max = a.scale ?? 10
    const filled = Math.round(((a.score ?? 0) / max) * 10)
    return (
      <div className={css.line}>
        <span className={css.q}>{a.question}</span>
        <span className={css.v}>
          <span className={css.num}>{(a.score ?? 0).toFixed(1)}</span> / {max}
          <span className={css.gauge}>
            {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < filled ? css.tickOn : css.tick} />)}
          </span>
        </span>
      </div>
    )
  }
  return (
    <div className={css.line}>
      <span className={css.q}>{a.question}</span>
      <span className={css.bars}>
        {a.options.slice(0, 4).map((o, i) => (
          <span key={o.key} className={css.barRow}>
            <span className={i === 0 ? css.barLabelTop : css.barLabel}>{o.label}</span>
            <span className={css.bar}><span className={css.fill} style={{ width: `${Math.max(1, o.probability * 100)}%` }} /></span>
            <span className={i === 0 ? css.pctTop : css.pct}>{(o.probability * 100).toFixed(0)}%</span>
          </span>
        ))}
      </span>
    </div>
  )
}

export interface InlineMessageAnalysisProps {
  /** undefined = 这条还没轮到（不渲染任何东西，避免刷屏）。 */
  entry: InlineAnalysisEntry | undefined
}

export function InlineMessageAnalysis({ entry }: InlineMessageAnalysisProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (entry === undefined) return null

  if (entry.state === 'pending') {
    return <div className={css.wrap}><span className={css.muted}>本地分析中…</span></div>
  }
  if (entry.state === 'error') {
    return <div className={css.wrap}><span className={css.err}>本地分析：{entry.error}</span></div>
  }

  const score = entry.answers.find((a) => a.kind === 'score')
  const intent = entry.answers.find((a) => a.qid === 'real_intent')
  const action = entry.answers.find((a) => a.qid === 'best_action')
  const iTop = intent?.options[0]
  const aTop = action?.options[0]

  return (
    <div className={css.wrap}>
      <div className={css.summary}>
        <span className={css.badge}>
          本地分析
          {entry.fromVoice ? ' · 语音转写' : ''}
          {entry.cached ? ' · 缓存' : ` · ${entry.inferenceMs}ms`}
        </span>
        {score !== undefined && (
          <span className={css.item}>紧张 <b>{(score.score ?? 0).toFixed(1)}</b>/{score.scale ?? 10}</span>
        )}
        {iTop !== undefined && <span className={css.item}>{iTop.label} <b>{(iTop.probability * 100).toFixed(0)}%</b></span>}
        {aTop !== undefined && <span className={css.item}>该做：{aTop.label} <b>{(aTop.probability * 100).toFixed(0)}%</b></span>}
        <button type="button" className={css.more} onClick={() => { setOpen((v) => !v) }}>
          {open ? '收起' : '详情'}
        </button>
      </div>
      {entry.fromVoice && entry.sourceText !== '' && (
        <div className={css.transcript}>转写：{entry.sourceText}</div>
      )}
      {open && (
        <div className={css.detail}>
          {entry.answers.map((a) => <AnswerLine key={a.qid} a={a} />)}
        </div>
      )}
    </div>
  )
}
