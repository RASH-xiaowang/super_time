/**
 * 右栏「回复助手」的**详情视图**：把两块内容各自的过程摊开。
 *
 * ## 为什么要单独一屏
 *
 * 主视图回答「怎么理解」和「可以怎么回」，但它对结论只有一个把握度标签。
 * 用户想追问「你凭什么这么说」「模型到底看到了什么」时，需要的是：
 *   · 送进模型的上下文（逐条带时间与发言人）；
 *   · 实际发出的 system / user 提示词（隐私闸之后的那一版）；
 *   · 知识库命中了哪些片段（推荐回复才有）；
 *   · 模型的**原始输出**（解析前）—— 这是「思考过程」最直接的证据；
 *   · 模型标识与真实耗时。
 *
 * 这些数据本来就在后端：分析走 `MessageAnalysisResult.trace`（并随缓存落库），
 * 推荐回复走 `ReplySuggestResult.trace`。这里只做排版，**不发任何请求**。
 *
 * ## 排版约束
 *
 * 右栏只有 320–420px 宽，而上下文与提示词动辄几千字。因此：
 *   · 大段文本一律放进可折叠的 `<details>`；
 *   · 展开后限高滚动（32vh），不把整屏顶长；
 *   · 用等宽字体展示提示词与原始输出，时间前缀与「发言人：」才对得齐。
 *
 * @module panels/chat-right-detail
 */
import type { ReplyTrace } from '@deepseek-ai/dsh-wechat-data/types'
import type { AnalysisSpeaker } from './ChatAnalysisPanel.tsx'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import css from './chat-right-detail.module.css'

/** 一块留痕的展示参数。 */
interface TraceBlockProps {
  trace: ReplyTrace | undefined
  /** 缺失时的说明：区分「还没算」与「旧缓存没有留痕」。 */
  emptyHint: string
}

function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return ms < 1000 ? String(Math.round(ms)) + ' ms' : (ms / 1000).toFixed(1) + ' s'
}

/** 大段文本块：默认折叠、展开后限高滚动。 */
function TextBlock(props: {
  title: string
  value: string
  open?: boolean
  empty?: string
}): React.JSX.Element {
  const empty = props.value.trim() === ''
  const text = empty ? (props.empty ?? '（空）') : props.value
  return (
    <details className={css.block} open={props.open === true && !empty}>
      <summary className={css.blockHead}>
        {props.title}
        <span className={css.blockMeta}>{empty ? '无' : String(props.value.length) + ' 字'}</span>
      </summary>
      <pre className={css.pre} data-empty={empty ? 'true' : undefined}>{text}</pre>
    </details>
  )
}

/** 一组留痕（模型、耗时、上下文、提示词、原始输出）。 */
function TraceBlock(props: TraceBlockProps): React.JSX.Element {
  const { trace, emptyHint } = props
  if (trace === undefined) return <p className={css.muted}>{emptyHint}</p>
  return (
    <div className={css.trace}>
      <dl className={css.meta}>
        <div className={css.metaRow}>
          <dt>模型</dt>
          <dd>{trace.model === '' ? '未记录' : trace.model}</dd>
        </div>
        <div className={css.metaRow}>
          <dt>耗时</dt>
          <dd>{durationText(trace.elapsedMs)}</dd>
        </div>
        <div className={css.metaRow}>
          <dt>上下文</dt>
          <dd>{String(trace.contextLines.length)} 条</dd>
        </div>
        {trace.redacted && (
          <div className={css.metaRow}>
            <dt>隐私闸</dt>
            <dd>提示词已脱敏（下面是实际发出的版本）</dd>
          </div>
        )}
      </dl>

      <TextBlock title="上下文（送给模型的历史对话）" value={trace.contextLines.join('\n')} open />
      {trace.kbSnippets.length > 0 && (
        <TextBlock title="知识库命中" value={trace.kbSnippets.join('\n\n')} />
      )}
      <TextBlock title="系统提示词" value={trace.systemPrompt} />
      <TextBlock title="本轮提问提示词" value={trace.userPrompt} />
      {/* 原始输出放在最后并强调：它是「为什么得出这个结论」的唯一直接证据。 */}
      <TextBlock
        title="模型原始输出"
        value={trace.rawOutput}
        open
        empty="模型没有返回内容"
      />
    </div>
  )
}

export interface ChatRightDetailProps {
  /** 当前分析目标消息的 localId；`null` = 还没选。 */
  analysisTargetId: number | null
  /** 该消息的分析条目（含 `trace`）。 */
  analysisEntry: InlineAnalysisEntry | undefined
  /** 分析对象是谁（让详情也能自证「在说哪一条」）。 */
  analysisSpeaker?: AnalysisSpeaker
  /** 被分析的那条消息原文。 */
  analysisSourceText?: string
  /** 推荐回复那一次的留痕；群聊没有这一段。 */
  replyTrace: ReplyTrace | undefined
  /** 是否展示推荐回复那一段。 */
  showReply: boolean
  /** 返回主视图。 */
  onBack: () => void
}

/**
 * 渲染详情视图。
 * @param props - 见 `ChatRightDetailProps`。
 * @returns 详情视图元素树（不含面板外壳）。
 */
export function ChatRightDetail(props: ChatRightDetailProps): React.JSX.Element {
  const { analysisTargetId, analysisEntry, analysisSpeaker, analysisSourceText, replyTrace, showReply, onBack } = props
  const done = analysisEntry?.state === 'done' ? analysisEntry.result : undefined
  const analysisTrace = done?.trace
  const analysisEmptyHint = analysisTargetId === null
    ? '还没有选中消息：回到主视图点一条对方消息。'
    : analysisEntry === undefined || analysisEntry.state === 'pending'
      ? '正在分析，完成后这里会出现过程记录。'
      : analysisEntry.state === 'error'
        ? '这次分析失败了，没有过程可以展示。'
        : '这条记录没有过程留痕（功能上线前的旧记录）。'

  return (
    <div className={css.body} aria-label="回复详情">
      <div className={css.introRow}>
        <button type="button" className={css.backBtn} onClick={onBack}>
          ← 返回
        </button>
        <span className={css.introHint}>这里只展示过程，不发任何请求</span>
      </div>

      <section className={css.section} aria-label="分析的思考过程">
        <div className={css.sectionHead}>
          <span className={css.sectionTitle}>分析过程</span>
          {analysisSpeaker !== undefined && (
            <span className={css.sectionHint}>对象：{analysisSpeaker.name}</span>
          )}
        </div>
        {analysisSourceText !== undefined && analysisSourceText !== '' && (
          <p className={css.quote}>{analysisSourceText}</p>
        )}
        <TraceBlock trace={analysisTrace} emptyHint={analysisEmptyHint} />
      </section>

      {showReply && (
        <section className={css.section} aria-label="推荐回复的思考过程">
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>推荐回复过程</span>
          </div>
          <TraceBlock
            trace={replyTrace}
            emptyHint="还没有生成候选回复：回到主视图等它取完，或点「换一批」。"
          />
        </section>
      )}
    </div>
  )
}
