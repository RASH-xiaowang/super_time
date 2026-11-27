/**
 * 思考过程区块：默认完全折叠，用户显式展开后才渲染内容。
 *
 * 思考可能包含用户问题、联系人名称和检索线索。保持折叠不只是为了省空间，
 * 也是避免这些中间内容在回答过程中不经确认就暴露在屏幕上。
 */
import { useId, useState } from 'react'
import { formatAskRunDuration } from './ask-run-model.ts'
import css from './answer-run.module.css'
import processCss from './answer-run-process.module.css'

export function ThinkingSection({ text, live, duration, variant = 'section', label = '思考过程' }: {
  text: string
  live: boolean
  duration?: number
  variant?: 'section' | 'trace'
  label?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const headingId = useId()
  const durationText = formatAskRunDuration(duration)
  const title = !live && durationText
    ? `${label}（用时 ${durationText}）`
    : label
  const summary = text !== '' ? `${String(text.length)} 字` : ''

  return (
    <section
      className={`${processCss.section} ${variant === 'trace' ? processCss.traceThinking : ''}`}
      data-block="thinking"
      data-status={live ? 'running' : undefined}
      data-variant={variant}
      data-thinking-state={expanded ? 'open' : 'closed'}
      aria-labelledby={headingId}
    >
      <button
        type="button"
        className={processCss.sectionHead}
        data-thinking-toggle=""
        data-expanded={expanded || undefined}
        aria-expanded={expanded}
        aria-controls={bodyId}
        title={expanded ? '收起思考内容' : '展开思考内容'}
        onClick={() => { setExpanded(value => !value) }}
      >
        <svg className={processCss.sectionChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        {live && <span className={processCss.liveDot} aria-hidden="true" />}
        <span id={headingId} className={processCss.sectionTitle} role="heading" aria-level={4}>
          {title}
        </span>
        <span className={processCss.sectionSummary}>{summary}</span>
        <span className={css.srOnly}>{expanded ? '，已展开' : '，已折叠'}</span>
      </button>
      <div id={bodyId} className={processCss.sectionBody} hidden={!expanded}>
        {expanded && (
          <div className={processCss.thinkingText}>
            {text}
          </div>
        )}
      </div>
    </section>
  )
}
