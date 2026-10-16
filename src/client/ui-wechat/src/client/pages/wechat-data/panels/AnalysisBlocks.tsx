/**
 * 本地决策分析的**答案块**渲染 —— 一条命题一个块，供右栏「分析」区块使用。
 *
 * 为什么单独一个文件：`AnswerBlock` 原来跟消息流里的逐条内嵌卡同住
 * `InlineMessageAnalysis.tsx`。内嵌卡按用户要求移除（2026-09-26）之后，若继续挂在那
 * 文件名下，名字指向的组件已经不存在了 —— 阅读的人会以为还有个内嵌卡在用这套渲染。
 * 所以把它单独拎出来，文件名与内容对齐。样式在 `analysis-blocks.module.css`。
 *
 * 三种题型各有读法：
 *   · `noul`  —— 两端结论 + 概率条（是 / 不是）
 *   · `score` —— 数值 + 10 格刻度
 *   · `choice` —— 选项条列表（前 4 项，其余合并成一行）
 */
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'
import css from './analysis-blocks.module.css'

/**
 * 选项短名表：只覆盖 `criteria` 的键（后端 `laya/presets.ts`）。
 *
 * 「先搜索历史聊天记录，确认对方之前说过什么」有 20 字，在选项标签这种窄版面必然被截断。
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
 * @param props.a - 后端给出的一条命题答案。
 * @returns 该命题的块元素。
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

  // choice：条目最多也最高，排到最后一行正好与同高的成对（见调用方的排序）
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
