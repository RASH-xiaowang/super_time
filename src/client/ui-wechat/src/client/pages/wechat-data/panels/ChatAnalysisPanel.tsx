/**
 * 右栏（推荐回复**下方**）的「分析」区块 —— 显示**选中的那条消息**的本地决策分析。
 *
 * 2026-09-25 从「独立面板（左栏）」改成「区块」：外壳与头部归 `ChatRightPanel`，
 * 本文件只出内容，自己保留一行区块标题（「分析」+ 取消选中）。
 * 为什么从左边搬下来（产品要求）：两块读的都是当前会话，分成左右两栏时
 * 「点消息 → 看分析」的视线要跨过整个消息流；合到一块后分析就贴在手边。
 *
 * 与消息流**逐条推理**的关系：推理仍按可见窗口逐条跑（结果落库缓存），但**展示只在这里**
 * —— 2026-09-26 按用户要求移除了消息流里的逐条内嵌卡（每条消息下再铺一块六命题卡，
 * 消息流被撑得过长），改成「点哪条看哪条」：本区把选中的那条**六项命题全列**，
 * 单列铺开方便逐项细看。块渲染复用 `AnalysisBlocks.tsx` 的 `AnswerBlock`。
 *
 * 数据来自 `useInlineAnalysis` 的按会话缓存（按 localId 取），本区**不自己发请求**：
 * 所以只有消息流已经算过的那条才有内容，没算过的如实说「还没轮到它」——
 * 与「模型缺失是正常路径」同一姿态，不假装有结果。
 *
 * 样式复用 `session-ask.module.css` 的头部与滚动区（与「推荐回复」「AI 问答」同一处视觉语言）；
 * 滚动条在那里显式声明为无边框细条，不依赖全局主题的作用域。
 */
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'
import { AnswerBlock } from './AnalysisBlocks.tsx'
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
  /** W3-11.5：本批分析进度（没有批在跑时为 null）—— 让「本地分析中…」变成可读的等待。 */
  progress?: { done: number; total: number } | null
  /** W3-11.5：停止当前那批分析（不给就没有停止按钮）。 */
  onCancel?: () => void | Promise<void>
  /** W3-11.5：「已停止（算出 N/M）」的收尾回执。 */
  stopped?: { done: number; total: number } | null
  /** W3-11.5：停止没停上的原因（空串 / 不给 = 没有问题）。 */
  stopError?: string
  /**
   * W3-11.5 收尾：重试这一条（不给就没有重试按钮）。
   *
   * 为什么需要它：逐条失败（语音没转写、取不到这条消息）此前**只能等下一次自动重跑** ——
   * 而自动重跑要等这条消息重新进入可见窗口，用户盯着「分析失败」干等。
   */
  onRetry?: (localId: number) => void
}

/** 摘要里的一个小指标。 */
function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <span className={css.stat}>{label} <b>{value}</b></span>
}

export function ChatAnalysisPanel(props: ChatAnalysisPanelProps): React.JSX.Element {
  const { targetId, entry, onClear, progress, onCancel, stopped, stopError, onRetry } = props
  const done = entry !== undefined && entry.state === 'done' ? entry : null

  // 排序：短的命题（noul/score）在前、choice 在后 —— 单列里也让结论先露头
  const ordered: LayaAnswer[] = done === null ? [] : [
    ...done.answers.filter((a) => a.kind !== 'choice'),
    ...done.answers.filter((a) => a.kind === 'choice'),
  ]
  const score = done?.answers.find((a) => a.kind === 'score')
  const intent = done?.answers.find((a) => a.qid === 'real_intent')?.options[0]
  const action = done?.answers.find((a) => a.qid === 'best_action')?.options[0]

  return (
    <div className={css.sec} aria-label="分析">
      <div className={shell.head}>
        <div className={shell.title}>分析</div>
        <div className={shell.headActions}>
          {/* W3-11.5：停止按钮只在**真有批在跑**时出现。取消只在每条之间生效，
              所以点了之后最多再等一条的推理时长（单条 0.5–9s），文案里写明了这一点。 */}
          {progress !== null && progress !== undefined && onCancel !== undefined && (
            <button type="button" className={shell.iconBtn} title="停止分析（最多再等当前这一条算完）" aria-label="停止分析" onClick={() => { void onCancel() }}>■</button>
          )}
          {targetId !== null && (
            <button type="button" className={shell.iconBtn} title="取消选中" aria-label="取消选中" onClick={onClear}>×</button>
          )}
        </div>
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
          <div className={css.empty}>
            <div className={css.emptySub}>
              本地分析中…{progress ? `（${progress.done}/${progress.total}）` : ''}
            </div>
          </div>
        )}
        {/* W3-11.5：停止不是失败 —— 已算完的那部分留在上面，收尾在这里说清算了多少。 */}
        {stopped !== null && stopped !== undefined && (
          <div className={css.empty}><div className={css.emptySub}>已停止（算出 {stopped.done}/{stopped.total} 条，已算的都已存下）</div></div>
        )}
        {stopError !== undefined && stopError !== '' && (
          <div className={css.empty}><div className={css.emptySub}>没能停止：{stopError}</div></div>
        )}
        {entry !== undefined && entry.state === 'error' && (
          <div className={css.empty}>
            <div className={css.emptySub}>分析失败：{entry.error}</div>
            {/* W3-11.5 收尾：失败必须给出路。原先只能等下一次自动重跑，
                而那要等这条消息重新滚进可见窗口 —— 用户看着干等。 */}
            {onRetry !== undefined && targetId !== null && (
              <button type="button" className={css.emptyAction} onClick={() => { onRetry(targetId) }}>
                重试这一条
              </button>
            )}
          </div>
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
            {/* 极短消息（「啥」「好，」）上同一模型的选项分布接近均匀 —— 那一栏的答案随机性很大。
                这里如实标注「判断主要来自上下文」，让用户知道该看的是上下文而不是这句话本身；
                **不改判断结果本身**，也不隐藏它。判据在后端 `isLowConfidenceText`。 */}
            {done.lowConfidence === true && (
              <div className={css.source} title="这条消息本身很短，选项分布接近均匀；换个上下文可能给出别的答案">
                信息不足，仅供参考（判断主要来自上下文）
              </div>
            )}
            <div className={css.blocks}>
              {ordered.map((a) => <AnswerBlock key={a.qid} a={a} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
