/**
 * 聊天界面**左侧的「分析」面板** —— 显示**选中的那条消息**的本地决策分析。
 *
 * 与消息流里的内嵌卡（`InlineMessageAnalysis`）是同一内容源的两种展示：
 * 内嵌卡跟着每条消息走（滚到哪看到哪、默认收起一行摘要），本面板把**选中的那条摊开**
 * —— 窄栏单列、六项命题全部展开，方便逐项细看。两处**复用同一个 `AnswerBlock`**，
 * 避免慢慢长歪。
 *
 * 数据来自 `useInlineAnalysis` 的按会话缓存（按 localId 取），本面板**不自己发请求**：
 * 所以只有消息流已经算过的那条才有内容，没算过的如实说「还没轮到它」——
 * 与「模型缺失是正常路径」同一姿态，不假装有结果。
 *
 * 面板外壳与滚动区复用 `session-ask.module.css`（与「推荐回复」「AI 问答」同一处视觉语言）；
 * 滚动条在那里显式声明为无边框细条，不依赖全局主题的作用域。
 */
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'
import { AnswerBlock } from './InlineMessageAnalysis.tsx'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import shell from './session-ask.module.css'
import css from './chat-analysis-panel.module.css'

export interface ChatAnalysisPanelProps {
  /** 选中消息的 localId；`null` = 还没选。 */
  targetId: number | null
  /** 该消息的分析条目（来自 `useInlineAnalysis`）。未选中/还没轮到它是 `undefined`。 */
  entry: InlineAnalysisEntry | undefined
  /** 取消选中。 */
  onClear: () => void
}

/** 摘要里的一个小指标。 */
function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <span className={css.stat}>{label} <b>{value}</b></span>
}

export function ChatAnalysisPanel(props: ChatAnalysisPanelProps): React.JSX.Element {
  const { targetId, entry, onClear } = props
  const done = entry !== undefined && entry.state === 'done' ? entry : null

  // 与内嵌卡同一套排序：短的命题（noul/score）在前、choice 在后 —— 单列里也让结论先露头
  const ordered: LayaAnswer[] = done === null ? [] : [
    ...done.answers.filter((a) => a.kind !== 'choice'),
    ...done.answers.filter((a) => a.kind === 'choice'),
  ]
  const score = done?.answers.find((a) => a.kind === 'score')
  const intent = done?.answers.find((a) => a.qid === 'real_intent')?.options[0]
  const action = done?.answers.find((a) => a.qid === 'best_action')?.options[0]

  return (
    <div className={shell.panel} aria-label="分析">
      <div className={shell.head}>
        <div className={shell.title}>分析</div>
        {targetId !== null && (
          <div className={shell.headActions}>
            <button type="button" className={shell.iconBtn} title="取消选中" aria-label="取消选中" onClick={onClear}>×</button>
          </div>
        )}
      </div>
      <div className={shell.body}>
        {targetId === null && (
          <div className={css.empty}>
            <div className={css.emptyTitle}>点选一条消息</div>
            <div className={css.emptySub}>在消息流里点一下对方的文本或语音消息，这里展开它的六项本地决策分析。</div>
          </div>
        )}
        {targetId !== null && entry === undefined && (
          <div className={css.empty}>
            <div className={css.emptyTitle}>还没轮到这条</div>
            <div className={css.emptySub}>分析是按可见窗口按需跑并落库缓存的 —— 消息流滚到它、算完之后这里就有内容。</div>
          </div>
        )}
        {entry !== undefined && entry.state === 'pending' && (
          <div className={css.empty}><div className={css.emptySub}>本地分析中…</div></div>
        )}
        {entry !== undefined && entry.state === 'error' && (
          <div className={css.empty}><div className={css.emptySub}>分析失败：{entry.error}</div></div>
        )}
        {done !== null && (
          <>
            <div className={css.meta}>
              <span className={css.badge}>
                本地分析{entry?.state === 'done' && entry.fromVoice ? ' · 语音转写' : ''}
                {entry?.state === 'done' ? (entry.cached ? ' · 缓存' : ` · ${entry.inferenceMs}ms`) : ''}
              </span>
              {score !== undefined && <Stat label="紧张" value={`${(score.score ?? 0).toFixed(1)}/${score.scale ?? 10}`} />}
            </div>
            {intent !== undefined && <Stat label="意图" value={`${intent.label} ${(intent.probability * 100).toFixed(0)}%`} />}
            {action !== undefined && <Stat label="该做" value={`${action.label} ${(action.probability * 100).toFixed(0)}%`} />}
            {done.sourceText !== '' && <div className={css.source}>{done.sourceText}</div>}
            <div className={css.blocks}>
              {ordered.map((a) => <AnswerBlock key={a.qid} a={a} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
