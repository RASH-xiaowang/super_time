/**
 * 聊天界面**右栏**：在「推荐回复」与「消息分析」之间二选一。
 *
 * 两块内容读取的都是当前会话，但语义不同：推荐回复面向会话最新上下文，分析面向
 * 用户点选的一条消息。此前允许同时打开，结果两套内容、两个滚动区互相挤压，且用户
 * 很难判断当前操作的是哪一块。现在由入口保证互斥，组件也只在单一模式下渲染。
 * 两块内容也互不掺杂：分析面板只做研判，不再内嵌候选回复；候选回复只在
 * 「推荐回复」模式出现（2026-11-13）。
 *
 * 组件分工：
 *   · 本文件 —— **唯一**的面板外壳（`.panel` / `.head` / 关闭）与模式分派；
 *   · `ReplySuggest` / `ChatAnalysisPanel` —— 只渲染各自区块的内容，不再自带外壳
 *     （以前各自带一份 `.panel`，合并时会出现「面板套面板」的双层边框）。
 *
 * 「AI 问答」打开时仍然**顶替**整个右栏（见 `chats-view.tsx` 的挂载条件）——
 * 那份面板自己带外壳，不走本组件；两者都与消息流并排，不覆盖聊天记录。
 */
import { ChatAnalysisPanel, type AnalysisSpeaker } from './ChatAnalysisPanel.tsx'
import { ReplySuggest, type ReplyTarget } from './ReplySuggest.tsx'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import shell from './session-ask.module.css'
import css from './chat-right-panel.module.css'

/** `ChatRightPanelProps` 的字段说明见各成员注释。 */
export interface ChatRightPanelProps {
  /** 目标会话（推荐回复的读取范围就是它）。 */
  target: ReplyTarget
  /** 关闭整个右栏面板。 */
  onClose: () => void
  /** 右栏唯一激活的内容；推荐回复只可能来自单聊，分析单聊/群聊均可。 */
  mode: 'suggest' | 'analysis'
  /** 分析区：选中消息的 `localId`（`null` = 还没选）。 */
  analysisTargetId: number | null
  /** 分析区：该消息的分析条目（来自消息流那份 `useInlineAnalysis` 缓存）。 */
  analysisEntry: InlineAnalysisEntry | undefined
  /** 分析区：当前目标消息，用于在结果返回前展示发送者与原文。 */
  analysisMessage?: WechatMessage
  /** 分析区：发送者信息。群聊必须是消息发送者。 */
  analysisSpeaker?: AnalysisSpeaker
  /** 分析区：当前会话是否群聊。 */
  analysisIsGroup?: boolean
  /** 当前是否正在跳过缓存重算。 */
  analysisRefreshing?: boolean
  /** 失败后重试当前消息。 */
  onRetryAnalysis?: (localId: number) => void
  /** 跳过缓存重新分析当前消息。 */
  onRefreshAnalysis?: (localId: number) => void
}

/**
 * Render the merged「推荐回复 + 消息分析」right panel.
 * @param props - see `ChatRightPanelProps`.
 * @returns panel element tree.
 */
export function ChatRightPanel(props: ChatRightPanelProps): React.JSX.Element {
  const {
    target, onClose, mode, analysisTargetId, analysisEntry,
    analysisMessage, analysisSpeaker, analysisIsGroup, analysisRefreshing,
    onRetryAnalysis, onRefreshAnalysis,
  } = props

  const title = mode === 'suggest' ? '推荐回复' : '消息分析'

  return (
    <div className={shell.panel} data-side-panel-view="" aria-label={title}>
      <div className={shell.head}>
        <div className={shell.title}>{title}</div>
        <div className={shell.headActions}>
          <button type="button" className={shell.iconBtn} title="收起整个右栏" aria-label="收起整个右栏" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {mode === 'suggest' && (
        <div className={css.top}>
          <ReplySuggest target={target} />
        </div>
      )}

      {mode === 'analysis' && (
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
      )}
    </div>
  )
}
