/**
 * 消息下方的**逐条分析**。
 *
 * 形态（2026-09-25 按用户给的参考图定稿）：
 * - **默认展开** —— 用户要的是「每条消息下都直接看得到全部分析」，不是先给一行摘要；
 *   仍留「收起」给不想看的时候用（收起态只占一行）。
 * - **与气泡头对齐** —— 左边缘 = 头像 + 间隙，padding 与气泡同为 12px（见 module.css）。
 * - **命题句用后端原文**（图里就是完整问句「她真的在问"你记不记得"吗？」）：
 *   早先为了在 108px 窄标签列里不截断而引入的「短名标题」已撤掉 ——
 *   现在两列块每列 300px，完整问句折两行也读得顺。
 *   `SHORT` 保留给**选项与摘要行**用（那里是真的窄）。
 */
import { useState } from 'react'
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import css from './inline-analysis.module.css'

/**
 * 选项短名表：只覆盖 `criteria` 的键（后端 `laya/presets.ts`）。
 *
 * 用在两处窄版面：摘要行的「意图 / 该做」与两列块里的选项标签 ——
 * 「先搜索历史聊天记录，确认对方之前说过什么」有 20 字，在这些位置必然被截断。
 * **查不到就回落到后端原文**：后端改选项时不会崩，只是标签变长（守卫会提醒同步）。
 */
const SHORT: Record<string, string> = {
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

/**
 * 一条命题的紧凑块：命题句（后端原文）+ 结论 + 迷你条/刻度。
 *
 * 导出给左侧「分析」面板复用（`ChatAnalysisPanel.tsx`）—— 那是同一个内容的另一种排布
 * （面板窄，单列铺开），复用同一块渲染才不会让两处慢慢长歪。
 */
export function AnswerBlock({ a }: { a: LayaAnswer }): React.JSX.Element {
  if (a.kind === 'noul') {
    const top = a.options[0]
    const p = top?.probability ?? 0
    return (
      <div className={css.block}>
        <span className={css.q}>{a.question}</span>
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
      <div className={css.block}>
        <span className={css.q}>{a.question}</span>
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

  // choice：条目最多也最高，排到最后一行正好与同高的成对（见 detail 的两列网格）
  const shown = a.options.slice(0, 4)
  const rest = a.options.slice(4).reduce((sum, o) => sum + o.probability, 0)
  return (
    <div className={css.block}>
      <span className={css.q}>{a.question}</span>
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
  // **默认展开**（产品决策：挂在每条对方消息下的分析，直接看得到才有意义）
  const [open, setOpen] = useState(true)
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
          {open ? '收起' : '展开'}
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
