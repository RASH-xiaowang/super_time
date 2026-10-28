/**
 * 右栏消息分析：把单条消息的本地模型读数排成一份可行动简报。
 *
 * 页面分三层，而不是把六道模型命题平铺出来：
 *   1. 分析对象：发送者、时间、原文 / 语音转写；
 *   2. 结论：一句谨慎的判断 + 意图、温度、建议动作；
 *   3. 依据：三项关键信号和可展开的完整模型读数。
 *
 * 组件本身不发请求。`useInlineAnalysis` 负责「选中即分析」、排队、缓存与重试，
 * 这里只消费状态，保证展示层可以独立测试。
 */
import type { LayaAnswer, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { Avatar } from './chats-support.tsx'
import { AnswerBlock } from './AnalysisBlocks.tsx'
import { AnalysisReplySuggest } from './AnalysisReplySuggest.tsx'
import { buildAnalysisBrief } from './analysis-brief.ts'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import { fmtDateTimeSec } from '../utils/format.ts'
import { withEnterprise } from './enterprise-identity.ts'
import shell from './session-ask.module.css'
import css from './chat-analysis-panel.module.css'

export interface AnalysisSpeaker {
  name: string
  username: string
  enterpriseName?: string
}

export interface ChatAnalysisPanelProps {
  /** 选中消息的 localId；`null` = 尚未选择。 */
  targetId: number | null
  /** 选中消息的本地分析状态。 */
  entry: InlineAnalysisEntry | undefined
  /** 当前目标消息；用于在分析完成前就展示发送者与原文。 */
  message?: WechatMessage
  /** 发送者展示名与真实 username。群聊时必须是消息发送者，而不是群本身。 */
  speaker?: AnalysisSpeaker
  /** 群聊消息标出发送者身份；单聊用「对方」。 */
  isGroup?: boolean
  /** 当前是否正在跳缓存重算。 */
  refreshing?: boolean
  /** 当前会话 username；用于生成针对分析目标的推荐回复。 */
  replyUsername?: string
  /** 失败后重试。 */
  onRetry?: (localId: number) => void
  /** 忽略缓存后重新分析。 */
  onRefresh?: (localId: number) => void
}

function previewOf(message: WechatMessage | undefined, sourceText: string): string {
  if (sourceText.trim() !== '') return sourceText.trim()
  return String(
    message?.displayText
      ?? message?.strContent
      ?? message?.msgContent
      ?? '',
  ).trim()
}

function MessageSubject(props: {
  targetId: number
  message?: WechatMessage
  entry?: InlineAnalysisEntry
  speaker?: AnalysisSpeaker
  isGroup?: boolean
}): React.JSX.Element {
  const { targetId, message, entry, speaker, isGroup } = props
  const done = entry?.state === 'done' ? entry : undefined
  const text = previewOf(message, done?.sourceText ?? '')
  const fromVoice = done?.fromVoice === true || message?.renderType === 'voice'

  return (
    <section className={css.subject} aria-label={`分析对象，消息 ${String(targetId)}`}>
      <div className={css.subjectTop}>
        <Avatar
          name={speaker?.name ?? (isGroup ? '群成员' : '对方')}
          username={speaker?.username ?? ''}
          size={30}
        />
        <div className={css.subjectIdentity}>
          <strong>{withEnterprise(speaker?.name || (isGroup ? '群成员' : '对方'), speaker?.enterpriseName)}</strong>
          <span>{isGroup ? '群聊消息' : '对方消息'} · {fmtDateTimeSec(message?.createTime, '时间未知')}</span>
        </div>
        <span className={css.subjectTag}>分析对象</span>
      </div>
      <div className={css.quote}>
        {text || (fromVoice ? '语音消息' : '正在读取消息内容…')}
      </div>
      {fromVoice && <span className={css.transcriptTag}>语音转写后分析</span>}
    </section>
  )
}

function LoadingState({ refreshing }: { refreshing?: boolean }): React.JSX.Element {
  return (
    <div className={css.loading}>
      <span className={shell.spinner} aria-hidden="true" />
      <div>
        <strong>{refreshing === true ? '正在重新分析' : '正在分析这条消息'}</strong>
        <span>读取当前会话的前文并运行本地模型，通常需要几秒。</span>
      </div>
    </div>
  )
}

function ProbabilityBar({ value, tone }: { value: number; tone?: 'brand' | 'warn' }): React.JSX.Element {
  const width = Math.max(2, Math.min(100, value * 100))
  return (
    <span className={css.bar} data-tone={tone}>
      <span style={{ width: `${String(width)}%` }} />
    </span>
  )
}

/**
 * 渲染消息分析区。
 * @param props - 选中消息、分析状态与重试/重算回调。
 */
export function ChatAnalysisPanel(props: ChatAnalysisPanelProps): React.JSX.Element {
  const { targetId, entry, message, speaker, isGroup, refreshing, replyUsername, onRetry, onRefresh } = props
  const done = entry?.state === 'done' ? entry : undefined
  const brief = done === undefined ? undefined : buildAnalysisBrief(done)
  const ordered: LayaAnswer[] = done === undefined
    ? []
    : [...done.answers.filter((answer) => answer.kind !== 'choice'), ...done.answers.filter((answer) => answer.kind === 'choice')]
  const tensionPercent = brief === undefined || brief.mood.tensionScale <= 0
    ? 0
    : brief.mood.tension / brief.mood.tensionScale

  return (
    <div className={css.sec} aria-label="消息分析">
      <div className={shell.body}>
        {targetId === null && (
          <div className={css.empty}>
            <span className={css.emptyIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5h16v11H8l-4 4V5Z" />
                <path d="M8 9h8M8 12h5" />
              </svg>
            </span>
            <div className={css.emptyTitle}>选一条消息，读懂言外之意</div>
            <div className={css.emptySub}>
              打开分析后会自动选择最近一条对方文本或语音；也可以直接点击聊天里的消息切换。
            </div>
            <div className={css.scopeChips}>
              <span>文字</span><span>语音转写</span><span>全程本地</span>
            </div>
          </div>
        )}

        {targetId !== null && (
          <>
            <MessageSubject
              targetId={targetId}
              message={message}
              entry={entry}
              speaker={speaker}
              isGroup={isGroup}
            />

            {(entry === undefined || entry.state === 'pending') && (
              <LoadingState refreshing={refreshing} />
            )}

            {entry?.state === 'error' && (
              <div className={css.errorBox} role="alert">
                <strong>这次没有分析成功</strong>
                <p>{entry.error}</p>
                {onRetry !== undefined && (
                  <button type="button" className={css.secondaryBtn} onClick={() => { onRetry(targetId) }}>
                    重试这条消息
                  </button>
                )}
              </div>
            )}

            {done !== undefined && brief !== undefined && (
              <>
                <section className={css.hero}>
                  <div className={css.heroTop}>
                    <span className={css.eyebrow}>研判结论</span>
                    <span className={css.confidence} data-tone={brief.confidenceTone}>
                      {brief.confidenceLabel}
                    </span>
                  </div>
                  <p className={css.headline}>{brief.headline}</p>
                  {done.lowConfidence === true && (
                    <p className={css.caution}>信息不足，仅供参考：这条消息本身很短，判断主要来自前文。</p>
                  )}
                </section>

                <div className={css.findingGrid}>
                  <section className={css.findingCard}>
                    <div className={css.cardLabel}>对方意图</div>
                    <strong className={css.cardValue}>{brief.intent.primary.label}</strong>
                    <div className={css.probabilityLine}>
                      <ProbabilityBar value={brief.intent.primary.probability} />
                      <span>{Math.round(brief.intent.primary.probability * 100)}%</span>
                    </div>
                    {brief.intent.alternative !== undefined && (
                      <p className={css.altLine}>
                        也可能是「{brief.intent.alternative.label}」
                        {' '}{Math.round(brief.intent.alternative.probability * 100)}%
                      </p>
                    )}
                  </section>

                  <section className={css.findingCard}>
                    <div className={css.cardLabel}>对话温度</div>
                    <div className={css.temperatureValue}>
                      <strong>{brief.mood.label}</strong>
                      <span>{brief.mood.tension.toFixed(1)} / {brief.mood.tensionScale}</span>
                    </div>
                    <ProbabilityBar value={tensionPercent} tone={brief.mood.tension >= 6 ? 'warn' : 'brand'} />
                    <p className={css.altLine}>{brief.mood.detail}</p>
                  </section>
                </div>

                <section className={css.actionCard}>
                  <div className={css.actionTop}>
                    <div>
                      <div className={css.cardLabel}>建议动作</div>
                      <strong>{brief.action.title}</strong>
                    </div>
                    <span>{Math.round(brief.action.probability * 100)}% 倾向</span>
                  </div>
                  <p>{brief.action.guidance}</p>
                  <div className={css.avoid}><b>避免</b>{brief.action.avoid}</div>
                </section>

                {replyUsername !== undefined && replyUsername !== '' && (
                  <AnalysisReplySuggest username={replyUsername} targetLocalId={targetId} />
                )}

                {brief.signals.length > 0 && (
                  <div className={css.signalGrid} aria-label="关键信号">
                    {brief.signals.map((signal) => (
                      <span key={signal.qid} className={css.signal} title={signal.detail}>
                        <span>{signal.label}</span>
                        <b>{Math.round(signal.probability * 100)}%</b>
                      </span>
                    ))}
                  </div>
                )}

                <div className={css.resultMeta}>
                  <span>
                    本地分析
                    {done.fromVoice ? ' · 语音转写' : ''}
                    {done.cached ? ' · 命中缓存' : ` · ${String(done.inferenceMs)}ms`}
                  </span>
                  {onRefresh !== undefined && (
                    <button type="button" className={css.textBtn} onClick={() => { onRefresh(targetId) }}>
                      重新分析
                    </button>
                  )}
                </div>

                <details className={css.details}>
                  <summary>查看底层判断 · {String(done.answers.length)} 项</summary>
                  <p className={css.detailsHint}>下面是模型原始概率，不是额外结论。</p>
                  <div className={css.blocks}>
                    {ordered.map((answer) => <AnswerBlock key={answer.qid} a={answer} />)}
                  </div>
                </details>

                <p className={css.disclaimer}>
                  结果基于本地聊天上下文，未上传到网络。概率表示模型的判断倾向，不代表事实。
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
