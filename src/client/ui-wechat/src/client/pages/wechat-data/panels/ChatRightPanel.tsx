/**
 * 聊天界面**右栏**：一个「回复助手」面板，同时容纳研判与候选回复，外加一屏「详情」。
 *
 * ## 为什么是一个面板而不是两个
 *
 * 「推荐回复」与「消息分析」本来是同一件事的两面：都读当前会话、都用对话模型、
 * 都要看「这条消息 + 前文」。此前是两个并列入口 + 两套壳体 + 两套滚动区，
 * 用户要来回开菜单才知道另一块在哪；窄屏下两块还会互相挤压。
 *
 * 现在只有一个入口、一个面板、**一个滚动区**，纵向两段：
 *
 * ```
 * ┌──────────────────────────────────┐
 * │ 回复助手                   ⓘ  ✕ │  面板级头部（ⓘ = 详情）
 * ├──────────────────────────────────┤
 * │ 这条消息怎么理解                  │  段标题
 * │  [分析对象] [结论] [意图|氛围] [建议] │
 * │ ──────────────────────────────── │  段分隔
 * │ 可以这样回                        │  段标题（群聊没有这一段）
 * │  [依据] [知识库]                  │
 * │  [候选 1              复制]      │
 * └──────────────────────────────────┘
 * ```
 *
 * 上段是**判断**（要不要接、他什么意思），下段是**动作**（照着发的话）。读的顺序
 * 与做的顺序一致，所以上段在下段之前。
 *
 * ## 详情屏为什么用 `hidden` 而不是换 return
 *
 * 点「详情」若把主视图卸载，`ReplySuggest` 会重新挂载并**再发一次模型请求** ——
 * 用户只是想看一眼过程，却要再等一次、再付一次钱。两屏同时挂载、用 `hidden`
 * 切换，候选与研判都原地保留（`SessionAsk` 用的是同一套办法）。
 *
 * ## 为什么只用一个滚动区
 *
 * 两段各自滚动时，滚轮到底会把指针「卡」在分界处，400px 宽的栏里尤其难受。
 * 做法是把外层容器设为**块级**滚动（`display: block`），两段自然按内容高度堆叠、
 * 不自己开窗 —— 内部组件原有的 `flex: 1 1 auto; overflow-y: auto` 在块级父容器里
 * 不会产生第二个滚动条。
 *
 * ## 群聊
 *
 * 群里「替我说一句」没有对象（接给谁？），因此不渲染下段，只保留研判；
 * 段标题也随之省略，面板标题直接叫「消息分析」。
 *
 * 「AI 问答」打开时仍然**顶替**整个右栏（见 `chats-view.tsx` 的挂载条件）——
 * 那份面板自己带外壳，不走本组件。
 */
import { useState } from 'react'
import { ChatAnalysisPanel, type AnalysisSpeaker } from './ChatAnalysisPanel.tsx'
import { ReplySuggest, type ReplyTarget } from './ReplySuggest.tsx'
import { ChatRightDetail } from './chat-right-detail.tsx'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import type { ReplyTrace, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import shell from './session-ask.module.css'
import css from './chat-right-panel.module.css'

/** `ChatRightPanelProps` 的字段说明见各成员注释。 */
export interface ChatRightPanelProps {
  /** 目标会话（推荐回复的读取范围就是它）。 */
  target: ReplyTarget
  /** 关闭整个右栏面板。 */
  onClose: () => void
  /**
   * 是否渲染「可以这样回」那一段。
   * 只有单聊为 true —— 群里「替我说一句」没有对象，研判才是唯一有意义的产出。
   */
  allowSuggest: boolean
  /** 分析段：选中消息的 `localId`（`null` = 还没选）。 */
  analysisTargetId: number | null
  /** 分析段：该消息的分析条目（来自消息流那份 `useInlineAnalysis` 缓存）。 */
  analysisEntry: InlineAnalysisEntry | undefined
  /** 分析段：当前目标消息，用于在结果返回前展示发送者与原文。 */
  analysisMessage?: WechatMessage
  /** 分析段：发送者信息。群聊必须是消息发送者。 */
  analysisSpeaker?: AnalysisSpeaker
  /** 分析段：当前会话是否群聊。 */
  analysisIsGroup?: boolean
  /** 当前是否正在跳过缓存重算。 */
  analysisRefreshing?: boolean
  /** 失败后重试当前消息。 */
  onRetryAnalysis?: (localId: number) => void
  /** 跳过缓存重新分析当前消息。 */
  onRefreshAnalysis?: (localId: number) => void
}

/** 段标题：一条细字 + 一句说明，用来分开「判断」与「动作」。 */
function SectionHead(props: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className={css.sectionHead}>
      <span className={css.sectionTitle}>{props.title}</span>
      {props.hint !== undefined && <span className={css.sectionHint}>{props.hint}</span>}
    </div>
  )
}

/**
 * Render the merged「回复助手」right panel.
 * @param props - see `ChatRightPanelProps`.
 * @returns panel element tree.
 */
export function ChatRightPanel(props: ChatRightPanelProps): React.JSX.Element {
  const {
    target, onClose, allowSuggest,
    analysisTargetId, analysisEntry, analysisMessage, analysisSpeaker,
    analysisIsGroup, analysisRefreshing, onRetryAnalysis, onRefreshAnalysis,
  } = props

  /** 是否在「详情」视图（本面板的第二屏，不卸载主视图）。 */
  const [detailOpen, setDetailOpen] = useState(false)
  /** 推荐回复那一次调用的留痕，由 `ReplySuggest` 取完候选后上报。 */
  const [replyTrace, setReplyTrace] = useState<ReplyTrace | undefined>(undefined)

  const title = allowSuggest ? '回复助手' : '消息分析'

  return (
    <div
      className={shell.panel}
      data-side-panel-view=""
      data-reply-assistant=""
      {...(detailOpen ? { 'data-detail': 'open' } : {})}
      aria-label={detailOpen ? title + ' · 详情' : title}
    >
      <div className={shell.head}>
        <div className={shell.title}>{detailOpen ? title + ' · 详情' : title}</div>
        <div className={shell.headActions}>
          {detailOpen ? (
            <button
              type="button"
              className={shell.iconBtn}
              title="关闭详情" aria-label="关闭详情"
              onClick={() => { setDetailOpen(false) }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ) : (
            /*
              「详情」= 这一屏的背面：把分析与候选的**过程**摊开（上下文、提示词、
              模型原始输出）。放在关闭按钮左边，因为它是「同一屏的另一种看法」，
              而不是面板级动作。
            */
            <button
              type="button"
              className={shell.iconBtn}
              title="详情：看分析与推荐的思考过程"
              aria-label="详情"
              onClick={() => { setDetailOpen(true) }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5" /><path d="M12 8h.01" />
              </svg>
            </button>
          )}
          <button type="button" className={shell.iconBtn} title="收起整个右栏" aria-label="收起整个右栏" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/*
        主视图。`hidden` 而不是卸载：点开详情再返回，候选与研判都原地保留，
        不会因为一次「看一眼过程」再付一次模型调用。
      */}
      <div className={css.scroll} hidden={detailOpen}>
        <section className={css.section} aria-label="这条消息怎么理解">
          {/* 群聊只有这一段，标题写了反而重复面板标题。 */}
          {allowSuggest && <SectionHead title="这条消息怎么理解" hint="点消息可切换分析对象" />}
          <ChatAnalysisPanel
            targetId={analysisTargetId}
            entry={analysisEntry}
            message={analysisMessage}
            speaker={analysisSpeaker}
            isGroup={analysisIsGroup}
            refreshing={analysisRefreshing}
            onRetry={onRetryAnalysis}
            onRefresh={onRefreshAnalysis}
          />
        </section>

        {allowSuggest && (
          <section className={css.section} aria-label="可以这样回">
            <SectionHead title="可以这样回" hint="复制后到微信里粘贴" />
            {/*
              把当前分析对象传下去：上段研判的是这条消息，下段推荐的也该是回这条。
              后端因此只取「目标消息及其之前」的窗口 —— 输入更小，候选出得更快。
            */}
            <ReplySuggest
              target={target}
              targetLocalId={analysisTargetId}
              onTrace={setReplyTrace}
            />
          </section>
        )}
      </div>

      {/* 详情屏：同样保活，只在第一次打开时挂载（`hidden` 需要元素存在）。 */}
      {detailOpen && (
        <div className={css.scroll}>
          <ChatRightDetail
            analysisTargetId={analysisTargetId}
            analysisEntry={analysisEntry}
            {...(analysisSpeaker === undefined ? {} : { analysisSpeaker })}
            {...(analysisMessage === undefined
              ? {}
              : { analysisSourceText: analysisMessage.displayText ?? '' })}
            replyTrace={replyTrace}
            showReply={allowSuggest}
            onBack={() => { setDetailOpen(false) }}
          />
        </div>
      )}
    </div>
  )
}
