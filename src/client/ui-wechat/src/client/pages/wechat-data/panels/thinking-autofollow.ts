/**
 * Scroll-following state for a live reasoning view.
 *
 * This module has no React dependency. The caller owns the scroll element and
 * invokes `onScroll` plus `onContentUpdate` at the corresponding lifecycle
 * points.
 */

/** Distance from the bottom that still counts as "follow the latest output". */
export const THINKING_AUTOFOLLOW_THRESHOLD_PX = 48

export interface ThinkingScrollElement {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

export interface ThinkingAutoFollowSnapshot {
  readonly following: boolean
  readonly nearBottom: boolean
  readonly showJumpToLatest: boolean
}

export interface ThinkingAutoFollowResult extends ThinkingAutoFollowSnapshot {
  readonly scrolled: boolean
}

export interface ThinkingAutoFollowController {
  /** Last state observed from a scroll or content-update call. */
  getSnapshot: () => ThinkingAutoFollowSnapshot
  /** Call from the scroll container's scroll handler. */
  onScroll: () => ThinkingAutoFollowSnapshot
  /** Call after reasoning text has rendered and the container may have grown. */
  onContentUpdate: () => ThinkingAutoFollowResult
  /** Call from an explicit "back to latest" action. */
  jumpToLatest: () => ThinkingAutoFollowResult
  /** Call when the run completes so a later run starts in following mode. */
  reset: () => ThinkingAutoFollowSnapshot
}

interface ScrollMetrics {
  readonly scrollTop: number
  readonly maxScrollTop: number
  readonly distanceFromBottom: number
  readonly overflowing: boolean
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizedThreshold(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, value)
    : THINKING_AUTOFOLLOW_THRESHOLD_PX
}

function metricsOf(element: ThinkingScrollElement): ScrollMetrics {
  const scrollHeight = nonNegative(element.scrollHeight)
  const clientHeight = nonNegative(element.clientHeight)
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  const scrollTop = nonNegative(element.scrollTop)
  return {
    scrollTop,
    maxScrollTop,
    distanceFromBottom: Math.max(0, maxScrollTop - scrollTop),
    overflowing: maxScrollTop > 1,
  }
}

/**
 * Pure proximity check. A missing element is deliberately not "near"; a
 * jsdom-like element with all-zero metrics is treated as already at bottom.
 */
export function isThinkingNearBottom(
  element: ThinkingScrollElement | null | undefined,
  threshold = THINKING_AUTOFOLLOW_THRESHOLD_PX,
): boolean {
  if (!element) return false
  return metricsOf(element).distanceFromBottom <= normalizedThreshold(threshold)
}

/**
 * Move an injected scroll element to its latest position.
 * @returns Whether scrollTop changed.
 */
export function scrollThinkingToLatest(
  element: ThinkingScrollElement | null | undefined,
): boolean {
  if (!element) return false
  const target = metricsOf(element).maxScrollTop
  if (Math.abs(nonNegative(element.scrollTop) - target) < 0.5) return false
  element.scrollTop = target
  return true
}

/**
 * Build a small state machine for live reasoning auto-follow.
 *
 * An upward scroll pauses following immediately, even while still inside the
 * proximity threshold. Scrolling back near the bottom resumes it on the next
 * downward or bottom-scroll event.
 */
export function createThinkingAutoFollow(
  resolveElement: () => ThinkingScrollElement | null | undefined,
  threshold = THINKING_AUTOFOLLOW_THRESHOLD_PX,
): ThinkingAutoFollowController {
  const limit = normalizedThreshold(threshold)
  let following = true
  let nearBottom = true
  let showJumpToLatest = false
  let lastScrollTop: number | null = null

  const snapshot = (): ThinkingAutoFollowSnapshot => ({
    following,
    nearBottom,
    showJumpToLatest,
  })

  const withoutElement = (): ThinkingAutoFollowSnapshot => {
    showJumpToLatest = false
    return snapshot()
  }

  const result = (scrolled: boolean): ThinkingAutoFollowResult => ({
    ...snapshot(),
    scrolled,
  })

  const syncAfterScroll = (
    element: ThinkingScrollElement,
  ): ThinkingAutoFollowSnapshot => {
    const metrics = metricsOf(element)
    const movedUp = lastScrollTop !== null && metrics.scrollTop < lastScrollTop - 0.5
    const isNear = metrics.distanceFromBottom <= limit

    following = movedUp ? false : isNear
    nearBottom = isNear
    showJumpToLatest = !following && !isNear && metrics.overflowing
    lastScrollTop = metrics.scrollTop
    return snapshot()
  }

  return {
    getSnapshot: snapshot,

    onScroll: () => {
      const element = resolveElement()
      return element ? syncAfterScroll(element) : withoutElement()
    },

    onContentUpdate: () => {
      const element = resolveElement()
      if (!element) return result(false)

      if (following) {
        const scrolled = scrollThinkingToLatest(element)
        const target = metricsOf(element).maxScrollTop
        following = true
        nearBottom = true
        showJumpToLatest = false
        lastScrollTop = target
        return result(scrolled)
      }

      const metrics = metricsOf(element)
      nearBottom = metrics.distanceFromBottom <= limit
      showJumpToLatest = metrics.overflowing && !nearBottom
      lastScrollTop = metrics.scrollTop
      return result(false)
    },

    jumpToLatest: () => {
      const element = resolveElement()
      if (!element) return result(false)

      const scrolled = scrollThinkingToLatest(element)
      following = true
      nearBottom = true
      showJumpToLatest = false
      lastScrollTop = metricsOf(element).maxScrollTop
      return result(scrolled)
    },

    reset: () => {
      following = true
      nearBottom = true
      showJumpToLatest = false
      lastScrollTop = null
      return snapshot()
    },
  }
}
