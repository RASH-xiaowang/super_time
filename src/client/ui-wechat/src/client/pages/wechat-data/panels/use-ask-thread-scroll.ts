import { useEffect, type MutableRefObject, type RefObject } from 'react'

export const ASK_THREAD_STICK_THRESHOLD_PX = 48

interface AskThreadScrollInput {
  body: HTMLElement
  latestRun: HTMLElement | null
  asking: boolean
  stickToBottom: boolean
}

/**
 * Decide where the thread should sit after a run changes.
 *
 * User scrolling is authoritative: once the thread is no longer near the
 * bottom, streaming updates must not pull it back. While the user is at the
 * bottom, every streamed change keeps the newest reasoning/answer visible.
 * After completion, align the whole run so the status, collapsed process
 * summary and formal answer remain together.
 */
export function resolveAskThreadScrollTop(input: AskThreadScrollInput): number | null {
  const { body, latestRun, asking, stickToBottom } = input
  if (!stickToBottom) return null
  if (latestRun === null) return body.scrollHeight
  if (asking) return body.scrollHeight
  if (latestRun.querySelector('[aria-label="AI 回答"]') === null) {
    const bodyTop = body.getBoundingClientRect().top
    const runTop = latestRun.getBoundingClientRect().top
    return Math.max(0, body.scrollTop + runTop - bodyTop - 8)
  }
  const bodyTop = body.getBoundingClientRect().top
  const runTop = latestRun.getBoundingClientRect().top
  return Math.max(0, body.scrollTop + runTop - bodyTop - 8)
}

interface AskThreadScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Update follow mode from one real scroll event.
 *
 * Distance alone is not enough: a user who scrolls up 20px is still inside the
 * old 80px "near bottom" band, but their intent is unambiguous. Any upward
 * movement therefore pauses following immediately; only scrolling back near
 * the bottom resumes it.
 */
export function resolveAskThreadStickToBottom(input: {
  metrics: AskThreadScrollMetrics
  previousScrollTop: number | null
  threshold?: number
}): boolean {
  const { metrics, previousScrollTop } = input
  const threshold = Math.max(0, input.threshold ?? ASK_THREAD_STICK_THRESHOLD_PX)
  const scrollTop = Math.max(0, Number(metrics.scrollTop) || 0)
  const scrollHeight = Math.max(0, Number(metrics.scrollHeight) || 0)
  const clientHeight = Math.max(0, Number(metrics.clientHeight) || 0)
  if (previousScrollTop !== null && scrollTop < previousScrollTop - 1) return false
  return Math.max(0, scrollHeight - clientHeight - scrollTop) <= threshold
}

/** 流式内容版本：长度或最后一个阶段状态变化时，滚动策略需要重新评估。 */
export function askThreadContentRevision(input: {
  text: string
  reasoning: string
  stages: ReadonlyArray<{ key?: string; status?: string }>
}): string {
  const last = input.stages.at(-1)
  return [
    String(input.text.length),
    String(input.reasoning.length),
    String(input.stages.length),
    last?.key ?? '',
    last?.status ?? '',
  ].join(':')
}

/** Keep both Q&A entrances on the same thread scroll policy. */
export function useAskThreadAutoScroll(input: {
  bodyRef: RefObject<HTMLDivElement | null>
  atBottomRef: MutableRefObject<boolean>
  asking: boolean
  turns: readonly unknown[]
  contentRevision?: string
}): void {
  const { bodyRef, atBottomRef, asking, contentRevision, turns } = input

  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    let lastScrollTop = body.scrollTop
    let touchY: number | null = null

    const syncFromScroll = (): void => {
      atBottomRef.current = resolveAskThreadStickToBottom({
        metrics: {
          scrollTop: body.scrollTop,
          scrollHeight: body.scrollHeight,
          clientHeight: body.clientHeight,
        },
        previousScrollTop: lastScrollTop,
      })
      lastScrollTop = body.scrollTop
    }
    const pauseFollowing = (): void => {
      atBottomRef.current = false
      lastScrollTop = body.scrollTop
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) pauseFollowing()
    }
    const onTouchStart = (event: TouchEvent): void => {
      touchY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent): void => {
      const nextY = event.touches[0]?.clientY
      if (nextY === undefined) return
      // Finger moving down scrolls the transcript up.
      if (touchY !== null && nextY > touchY + 1) pauseFollowing()
      touchY = nextY
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        pauseFollowing()
      }
    }

    body.addEventListener('scroll', syncFromScroll, { passive: true })
    body.addEventListener('wheel', onWheel, { passive: true })
    body.addEventListener('touchstart', onTouchStart, { passive: true })
    body.addEventListener('touchmove', onTouchMove, { passive: true })
    body.addEventListener('keydown', onKeyDown)
    return () => {
      body.removeEventListener('scroll', syncFromScroll)
      body.removeEventListener('wheel', onWheel)
      body.removeEventListener('touchstart', onTouchStart)
      body.removeEventListener('touchmove', onTouchMove)
      body.removeEventListener('keydown', onKeyDown)
    }
  }, [atBottomRef, bodyRef])

  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const frame = window.requestAnimationFrame(() => {
      const runs = body.querySelectorAll<HTMLElement>('[data-answer-run]')
      const latestRun = runs.item(runs.length - 1)
      const top = resolveAskThreadScrollTop({
        body,
        latestRun: latestRun === undefined ? null : latestRun,
        asking,
        stickToBottom: atBottomRef.current === true,
      })
      if (top !== null) body.scrollTop = top
    })
    return () => { window.cancelAnimationFrame(frame) }
  }, [asking, atBottomRef, bodyRef, contentRevision, turns])
}
