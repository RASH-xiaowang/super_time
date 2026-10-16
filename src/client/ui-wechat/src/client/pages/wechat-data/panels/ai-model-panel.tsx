/**
 * AI 大模型里的**可折叠模型面板**外壳（2026-09-30 重做）。
 *
 * 用户要求把「对话模型 / 嵌入模型 / 重排序模型」划成三个独立板块，并给每块加可折叠的
 * 展开 / 收起按钮图标。这一层只管**外壳与交互**（标题、副标题、状态徽标、折叠箭头、
 * 展开体），内容由调用方传进来 —— 三块的结构因此严格一致，不会各写一套标题栏。
 *
 * 交互约定（对齐仓库既有的折叠件，不另发明）：
 *   · 整个标题栏是**一个真 `<button>`**：键盘可达（Enter/Space）、`aria-expanded` 表明状态；
 *   · 折叠时**不渲染**展开体（不是 CSS 隐藏）—— 与 `ui-ask-smoke` 钉的那条一致：
 *     「折叠必须是真不渲染」，否则隐藏的输入框仍会被读到、仍会参与表单语义；
 *   · 箭头图标用 `data-open` 旋转 180°，`title` 与 `aria-label` 都写清"展开/收起哪一块"。
 */
import type { ReactNode } from 'react'
import css from './ai-model.module.css'

export interface AiModelPanelProps {
  /** 面板标识（同时是 DOM 锚点 `data-model-panel`，真机 e2e 用它定位）。 */
  id: 'chat' | 'embed' | 'rerank'
  /** 板块标题（对话模型 / 嵌入模型 / 重排序模型）。 */
  title: string
  /** 一句话说明这块管什么（首次看的人不需要猜）。 */
  subtitle: string
  /** 右上角状态：文字 + 语气（ok=已配置、idle=未配置、warn=配了但有注意点）。 */
  status: { text: string; tone: 'ok' | 'idle' | 'warn' }
  /** 展开态。 */
  open: boolean
  /** 切换展开态。 */
  onToggle: () => void
  /** 展开时渲染的内容。 */
  children: ReactNode
}

/**
 * 渲染一个可折叠的模型面板。
 * @param props - 标识 / 标题 / 副标题 / 状态 / 展开态与切换回调 / 内容。
 * @returns 面板元素。
 */
export function AiModelPanel({ id, title, subtitle, status, open, onToggle, children }: AiModelPanelProps): React.JSX.Element {
  return (
    <section className={css.panelCard} data-model-panel={id} data-open={open || undefined}>
      <button
        type="button"
        className={css.panelHead}
        data-model-panel-toggle={id}
        aria-expanded={open}
        aria-controls={`ai-model-panel-${id}`}
        onClick={onToggle}
        title={open ? `收起「${title}」` : `展开「${title}」`}
      >
        <span className={css.panelHeadText}>
          <span className={css.panelTitle}>{title}</span>
          <span className={css.panelSub}>{subtitle}</span>
        </span>
        <span className={css.panelStatus} data-tone={status.tone}>{status.text}</span>
        <span className={css.panelCaret} data-open={open || undefined} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className={css.panelBody} id={`ai-model-panel-${id}`}>
          {children}
        </div>
      )}
    </section>
  )
}
