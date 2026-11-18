/**
 * 右栏消息分析面板。
 *
 * ## 单聊与群聊是两套问题，不是同一张卡换个标题
 *
 *  · **单聊**：他这段话想要什么、情绪如何、我该怎么回；
 *  · **群聊**：这条消息是否在找我、他在群里做的是什么动作、我该不该接话、
 *    公开回还是私聊。
 *
 * 旧实现把「对方意图 / 对话温度 / 建议动作」硬套到群聊，于是「@我 报价多少」
 * 会被判成「想确认你的态度」。这里按 `scope` 分两套排版。
 *
 * 组件本身不发请求：`useInlineAnalysis` 负责选中即分析、排队与缓存，
 * 这里只消费状态，保证展示层可独立测试。
 *
 * 边界：只做研判，不生成可直接发送的候选回复 —— 那是「推荐回复」板块的职责，
 * 两块由 `ChatRightPanel` 按模式二选一渲染。
 */
import type { MessageAnalysis, MessageAnalysisResult, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { Avatar } from './chats-support.tsx'
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
  /** 选中消息的分析状态。 */
  entry: InlineAnalysisEntry | undefined
  /** 当前目标消息；用于在分析完成前就展示发送者与原文。 */
  message?: WechatMessage
  /** 发送者展示名与真实 username。群聊时必须是消息发送者，而不是群本身。 */
  speaker?: AnalysisSpeaker
  /** 群聊消息标出发送者身份；单聊用「对方」。 */
  isGroup?: boolean
  /** 当前是否正在跳缓存重算。 */
  refreshing?: boolean
  /** 失败后重试。 */
  onRetry?: (localId: number) => void
  /** 忽略缓存后重新分析。 */
  onRefresh?: (localId: number) => void
}

const CONFIDENCE_LABEL: Record<MessageAnalysis['confidence'], string> = {
  high: '把握较大',
  medium: '倾向明显',
  low: '信息有限',
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
  const done = entry?.state === 'done' ? entry.result : undefined
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
        <span>读取当前会话的前文并调用对话模型，通常需要一到几秒。</span>
      </div>
    </div>
  )
}

/** 一张「标签 + 一句话」的发现卡：两套版式共用。 */
function FindingCard(props: {
  label: string
  value: string
  detail?: string
  tone?: 'brand' | 'warn'
}): React.JSX.Element {
  return (
    <section className={css.findingCard}>
      <div className={css.cardLabel}>{props.label}</div>
      <strong className={css.cardValue} data-tone={props.tone}>{props.value}</strong>
      {props.detail !== undefined && props.detail !== '' && (
        <p className={css.altLine}>{props.detail}</p>
      )}
    </section>
  )
}

/** 建议动作卡：单聊说「怎么回」，群聊还要说「要不要接、在哪接」。 */
function ActionCard(props: {
  analysis: MessageAnalysis
  isGroup: boolean
}): React.JSX.Element {
  const { analysis, isGroup } = props
  const { action } = analysis
  const channelText = action.channel === 'public'
    ? '建议在群里回'
    : action.channel === 'private'
      ? '建议私聊'
      : '群里回或私聊都行'
  return (
    <section className={css.actionCard}>
      <div className={css.actionTop}>
        <div>
          <div className={css.cardLabel}>{isGroup ? '要不要接话' : '建议动作'}</div>
          <strong>{action.shouldReply ? action.title : '这条可以不用回'}</strong>
        </div>
        {isGroup && action.shouldReply && <span>{channelText}</span>}
      </div>
      <p>{action.guidance}</p>
      {action.avoid !== '' && <div className={css.avoid}><b>避免</b>{action.avoid}</div>}
    </section>
  )
}

function AnalysisBody(props: {
  targetId: number
  analysis: MessageAnalysis
  done: MessageAnalysisResult
  onRefresh?: (localId: number) => void
}): React.JSX.Element {
  const { targetId, analysis, done, onRefresh } = props
  const isGroup = analysis.scope === 'group'
  return (
    <>
      <section className={css.hero}>
        <div className={css.heroTop}>
          <span className={css.eyebrow}>{isGroup ? '群聊研判' : '研判结论'}</span>
          <span className={css.confidence} data-tone={analysis.confidence}>
            {CONFIDENCE_LABEL[analysis.confidence]}
          </span>
        </div>
        <p className={css.headline}>{analysis.headline}</p>
        {done.lowConfidence === true && (
          <p className={css.caution}>消息本身很短，判断主要来自前文，仅供参考。</p>
        )}
      </section>

      {isGroup && analysis.addressed !== undefined && (
        <section className={css.actionCard} data-tone={analysis.addressed.targeted ? 'brand' : undefined}>
          <div className={css.actionTop}>
            <div>
              <div className={css.cardLabel}>是否在找你</div>
              <strong>{analysis.addressed.targeted ? '在找你' : '不像是针对你'}</strong>
            </div>
          </div>
          <p>{analysis.addressed.reason}</p>
        </section>
      )}

      <div className={css.findingGrid}>
        <FindingCard
          label={isGroup ? '发言性质' : '对方意图'}
          value={analysis.intent.label}
          detail={analysis.intent.detail}
        />
        <FindingCard
          label={isGroup ? '群里氛围' : '情绪状态'}
          value={analysis.mood.label}
          detail={analysis.mood.detail}
          tone={analysis.mood.label === '紧张' || analysis.mood.label === '不悦' ? 'warn' : 'brand'}
        />
      </div>

      <ActionCard analysis={analysis} isGroup={isGroup} />

      {analysis.signals.length > 0 && (
        <div className={css.signalGrid} aria-label="关键信号">
          {analysis.signals.map((signal, index) => (
            <span key={String(index)} className={css.signal}>{signal}</span>
          ))}
        </div>
      )}

      {analysis.evidence.length > 0 && (
        <details className={css.details}>
          <summary>判断依据 · 引用了 {String(analysis.evidence.length)} 处原话</summary>
          <ul className={css.evidenceList}>
            {analysis.evidence.map((line, index) => (
              <li key={String(index)}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <div className={css.resultMeta}>
        <span>
          {done.model === '' ? '对话模型' : done.model}
          {done.fromVoice ? ' · 语音转写' : ''}
          {done.cached ? ' · 命中缓存' : ' · ' + String(done.elapsedMs) + 'ms'}
        </span>
        {onRefresh !== undefined && (
          <button type="button" className={css.textBtn} onClick={() => { onRefresh(targetId) }}>
            重新分析
          </button>
        )}
      </div>

      <p className={css.disclaimer}>
        分析结果由当前对话模型生成，只依据本会话的上下文，不代表事实；判断把握不足时以你的判断为准。
      </p>
    </>
  )
}

/**
 * 渲染消息分析区。
 * @param props - 选中消息、分析状态与重试/重算回调。
 */
export function ChatAnalysisPanel(props: ChatAnalysisPanelProps): React.JSX.Element {
  const { targetId, entry, message, speaker, isGroup, refreshing, onRetry, onRefresh } = props
  const done = entry?.state === 'done' ? entry.result : undefined
  const analysis = done?.analysis

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
              <span>文字</span><span>语音转写</span><span>单聊·群聊</span>
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

            {done !== undefined && analysis !== undefined && (
              <AnalysisBody
                targetId={targetId}
                analysis={analysis}
                done={done}
                {...(onRefresh === undefined ? {} : { onRefresh })}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
