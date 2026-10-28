/**
 * 思考过程区块：实时跟随、暂停跟随与完成后折叠。
 *
 * 单独拆出以保持共享运行视图在文件行数棘轮内，交互仍由同一套
 * thinking-autofollow 状态机驱动。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { formatAskRunDuration } from './ask-run-model.ts'
import {
  createThinkingAutoFollow,
  type ThinkingAutoFollowSnapshot,
} from './thinking-autofollow.ts'
import css from './answer-run.module.css'
import processCss from './answer-run-process.module.css'

const THINKING_PREVIEW_CHARS = 600

function thinkingSnapshotEquals(
  current: ThinkingAutoFollowSnapshot,
  next: ThinkingAutoFollowSnapshot,
): boolean {
  return current.following === next.following
    && current.nearBottom === next.nearBottom
    && current.showJumpToLatest === next.showJumpToLatest
}

export function ThinkingSection({ text, live, duration }: {
  text: string
  live: boolean
  duration?: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [autoFollow] = useState(() => createThinkingAutoFollow(() => textRef.current))
  const [followSnapshot, setFollowSnapshot] = useState<ThinkingAutoFollowSnapshot>(
    () => autoFollow.getSnapshot(),
  )
  const textId = useId()
  const long = text.length > THINKING_PREVIEW_CHARS || text.split('\n').length > 10
  const durationText = formatAskRunDuration(duration)

  useEffect(() => {
    if (!live || !long) return
    const next = autoFollow.onContentUpdate()
    setFollowSnapshot(current => thinkingSnapshotEquals(current, next) ? current : next)
  }, [autoFollow, live, long, text])

  useEffect(() => {
    if (live) return
    const next = autoFollow.reset()
    setFollowSnapshot(current => thinkingSnapshotEquals(current, next) ? current : next)
  }, [autoFollow, live])

  const scrollToLatest = (): void => {
    const next = autoFollow.jumpToLatest()
    setFollowSnapshot(current => thinkingSnapshotEquals(current, next) ? current : next)
  }

  return (
    <section className={processCss.section} data-status={live ? 'running' : undefined}>
      <div className={processCss.sectionHead}>
        {live && <span className={processCss.liveDot} aria-hidden="true" />}
        <span className={processCss.sectionTitle}>思考过程</span>
        <span className={processCss.sectionSummary}>
          {[
            live ? '思考中' : '',
            durationText ? `耗时 ${durationText}` : '',
            long ? `${String(text.length)} 字` : '',
          ].filter(Boolean).join(' · ')}
        </span>
      </div>
      <div className={processCss.sectionBody}>
        <div
          id={textId}
          ref={textRef}
          className={processCss.thinkingText}
          data-live={live || undefined}
          data-clamp={long && !live && !expanded ? true : undefined}
          data-scroll={live && long ? true : undefined}
          role={live && long ? 'region' : undefined}
          aria-label={live && long ? '实时思考过程，可滚动查看最新内容' : undefined}
          tabIndex={live && long ? 0 : undefined}
          onScroll={live && long
            ? () => {
              const next = autoFollow.onScroll()
              setFollowSnapshot(current => thinkingSnapshotEquals(current, next) ? current : next)
            }
            : undefined}
        >
          {text}
        </div>
        {live && long && followSnapshot.showJumpToLatest && (
          <button
            type="button"
            className={`${css.moreButton} ${processCss.thinkingJump}`}
            onClick={scrollToLatest}
          >
            回到最新
          </button>
        )}
        {!live && long && (
          <button
            type="button"
            className={css.moreButton}
            onClick={() => { setExpanded(value => !value) }}
            aria-expanded={expanded}
            aria-controls={textId}
          >
            {expanded ? '收起思考' : `展开完整思考（共 ${String(text.length)} 字）`}
          </button>
        )}
      </div>
    </section>
  )
}
