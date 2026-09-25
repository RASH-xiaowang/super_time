/**
 * 消息下方的**逐条分析**（紧凑版）。
 *
 * 形态约束：它挂在**每一条**对方消息下面，所以默认只占一行 ——
 * 摘要给「紧张度 + 意图 Top1 + 最该做的动作」，点「详情」才展开全部命题。
 *
 * 2026-09-25 重做展示层（原版横跨整个消息区、标签被截断）：
 * - 宽度与气泡列对齐并收窄到 640px（见 inline-analysis.module.css）；
 * - 展开区是两列紧凑块，**按「块高」排序**（短命题在前、choice 在后）让两列配平；
 * - 标题与选项走 `SHORT` 短名表，完整文案挂在 `title` 上（悬停可见）——
 *   9–15 字的中文选项在窄块里会折行/被截断，短名才让「问题 + 结论」一眼看完。
 */
import { useState } from 'react'
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import css from './inline-analysis.module.css'

/**
 * 短名表：命题（`qid`）与选项（criteria key）共用一张表。
 *
 * 键取自后端 `laya/presets.ts`；两套键目前不重名。**后端改命题/选项时查不到就回落到原文案**，
 * 所以漂移只会表现为「标签变长」，不会崩、也不会显示错的东西。
 */
const SHORT: Record<string, string> = {
  // 命题
  literal_question: '字面提问',
  is_testing: '考验记性',
  is_upset: '对方不高兴',
  real_intent: '真实意图',
  tension: '紧张程度',
  best_action: '该做什么',
  // 真实意图的选项
  care_check: '求关注',
  memory_test: '考验记性',
  want_fight: '想吵架',
  keep_talking: '想聊下去',
  // 该做的动作
  search_history: '先查记录',
  answer_directly: '直接回答',
  admit_and_apologize: '先道歉',
  ask_back: '反问回去',
  change_topic: '转移话题',
  play_dumb: '先不回',
}

/** 取短名，查不到就回落（`title` 上始终是完整文案）。 */
function short(key: string, fallback: string): string {
  return SHORT[key] ?? fallback
}

/** 一条命题的紧凑块：标题（短名）+ 结论 + 迷你条/刻度。 */
function AnswerBlock({ a }: { a: LayaAnswer }): React.JSX.Element {
  if (a.kind === 'noul') {
    const top = a.options[0]
    const p = top?.probability ?? 0
    return (
      <div className={css.block} title={a.question}>
        <span className={css.q}>{short(a.qid, a.question)}</span>
        <span className={css.verdict}>
          <b>{top?.label ?? ''}</b>
          <em>{(p * 100).toFixed(0)}%</em>
        </span>
        <span className={css.track}>
          <span className={css.trackFill} style={{ width: `${Math.max(1, p * 100)}%` }} />
        </span>
      </div>
    )
  }

  if (a.kind === 'score') {
    const max = a.scale ?? 10
    const v = a.score ?? 0
    const filled = Math.round((v / max) * 10)
    return (
      <div className={css.block} title={a.question}>
        <span className={css.q}>{short(a.qid, a.question)}</span>
        <span className={css.verdict}>
          <b>{v.toFixed(1)}</b>
          <em>/ {max}</em>
          <span className={css.gauge}>
            {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < filled ? css.tickOn : css.tick} />)}
          </span>
        </span>
      </div>
    )
  }

  // choice：条目较多且最高，排到最后一行正好成对（见 detail 的两列网格）
  const shown = a.options.slice(0, 4)
  const rest = a.options.slice(4).reduce((sum, o) => sum + o.probability, 0)
  return (
    <div className={css.block} title={a.question}>
      <span className={css.q}>{short(a.qid, a.question)}</span>
      <span className={css.bars}>
        {shown.map((o, i) => (
          <span key={o.key} className={css.barRow}>
            <span className={css.barHead}>
              <span className={i === 0 ? css.barLabelTop : css.barLabel} title={o.label}>{short(o.key, o.label)}</span>
              <span className={i === 0 ? css.pctTop : css.pct}>{(o.probability * 100).toFixed(0)}%</span>
            </span>
            <span className={css.bar}>
              <span className={css.fill} style={{ width: `${Math.max(1, o.probability * 100)}%` }} />
            </span>
          </span>
        ))}
        {a.options.length > shown.length && (
          <span className={css.barMore}>其他 {a.options.length - shown.length} 项 合计 {(rest * 100).toFixed(0)}%</span>
        )}
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
  // 两列网格里，短块（noul/score）在前排两行、高块（choice）配成最后一行 —— 不留空洞
  const ordered = [
    ...entry.answers.filter((a) => a.kind !== 'choice'),
    ...entry.answers.filter((a) => a.kind === 'choice'),
  ]

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
        {iTop !== undefined && (
          <span className={css.item}>{short(iTop.key, iTop.label)} <b>{(iTop.probability * 100).toFixed(0)}%</b></span>
        )}
        {aTop !== undefined && (
          <span className={css.item}>该做 {short(aTop.key, aTop.label)} <b>{(aTop.probability * 100).toFixed(0)}%</b></span>
        )}
        <button type="button" className={css.more} onClick={() => { setOpen((v) => !v) }}>
          {open ? '收起' : '详情'}
        </button>
      </div>
      {entry.fromVoice && entry.sourceText !== '' && (
        <div className={css.transcript}>转写：{entry.sourceText}</div>
      )}
      {open && (
        <div className={css.detail}>
          {ordered.map((a) => <AnswerBlock key={a.qid} a={a} />)}
        </div>
      )}
    </div>
  )
}
