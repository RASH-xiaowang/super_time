/**
 * 聊天界面**右栏**的合并面板：上半「推荐回复」、下半「分析」，**共用一个面板容器**。
 *
 * 为什么合并（2026-09-25 产品调整）：两块内容读取的都是**当前会话**，但一个占一栏时
 * 每一栏都过窄 —— 分析被拆到左栏之后，消息区两侧各挂一块，「选中消息 → 看分析」的眼睛
 * 还要跨过整个消息流。合成一块之后：分析紧贴在推荐回复下方、与它同一套边框/底色/滚动条，
 * 点选消息就在这块面板的下半部分展开。
 *
 * 组件分工：
 *   · 本文件 —— **唯一**的面板外壳（`.panel` / `.head` / 关闭）+ 上下分区与分隔线；
 *   · `ReplySuggest` / `ChatAnalysisPanel` —— 只渲染各自区块的内容，不再自带外壳
 *     （以前各自带一份 `.panel`，合并时会出现「面板套面板」的双层边框）。
 *
 * 「AI 问答」打开时仍然**顶替**整个右栏（见 `chats-view.tsx` 的挂载条件）——
 * 那份面板自己带外壳，不走本组件。
 */
import { ChatAnalysisPanel } from './ChatAnalysisPanel.tsx'
import { ReplySuggest, type ReplyTarget } from './ReplySuggest.tsx'
import type { InlineAnalysisEntry } from './use-inline-analysis.ts'
import shell from './session-ask.module.css'
import css from './chat-right-panel.module.css'

/** `ChatRightPanelProps` 的字段说明见各成员注释。 */
export interface ChatRightPanelProps {
  /** 目标会话（推荐回复的读取范围就是它）。 */
  target: ReplyTarget
  /** 关闭整个右栏面板（两块一起收起）。 */
  onClose: () => void
  /** 上区「推荐回复」是否显示（只有单聊才可能为 true —— 群聊里「回一句」不成立）。 */
  showSuggest: boolean
  /** 下区「分析」是否显示（群聊也能单独开）。 */
  showAnalysis: boolean
  /** 分析区：选中消息的 `localId`（`null` = 还没选）。 */
  analysisTargetId: number | null
  /** 分析区：该消息的分析条目（来自消息流那份 `useInlineAnalysis` 缓存）。 */
  analysisEntry: InlineAnalysisEntry | undefined
  /** 分析区：取消选中。 */
  onClearAnalysis: () => void
}

/**
 * Render the merged「推荐回复 + 分析」right panel.
 * @param props - see `ChatRightPanelProps`.
 * @returns panel element tree.
 */
export function ChatRightPanel(props: ChatRightPanelProps): React.JSX.Element {
  const { target, onClose, showSuggest, showAnalysis, analysisTargetId, analysisEntry, onClearAnalysis } = props

  // 标题跟着**实际显示的内容**走：只开了分析还写「推荐回复」，会让人以为上区被吃掉了。
  const title = showSuggest && showAnalysis ? '推荐回复与分析' : showSuggest ? '推荐回复' : '分析'

  return (
    <div className={shell.panel} aria-label={title}>
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

      {/* 两块各自条件渲染（2026-09-26 起可在消息头部的按钮排里独立折叠）。
          只剩一块时不再画分隔线 —— 单块面板里一条孤零零的横线只会让人以为下面还有内容。 */}
      {showSuggest && (
        <div className={css.top}>
          <ReplySuggest target={target} />
        </div>
      )}

      {showSuggest && showAnalysis && <div className={css.divider} />}

      {showAnalysis && (
        <ChatAnalysisPanel
          targetId={analysisTargetId}
          entry={analysisEntry}
          onClear={onClearAnalysis}
        />
      )}
    </div>
  )
}
