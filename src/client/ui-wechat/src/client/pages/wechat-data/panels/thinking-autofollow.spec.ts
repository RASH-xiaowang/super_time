// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  THINKING_AUTOFOLLOW_THRESHOLD_PX,
  createThinkingAutoFollow,
  isThinkingNearBottom,
} from './thinking-autofollow.ts'

function scrollBox(
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
): { scrollTop: number; scrollHeight: number; clientHeight: number } {
  return { scrollTop, scrollHeight, clientHeight }
}

describe('thinking autofollow', () => {
  it('follows when near the bottom, including the threshold boundary', () => {
    const atBoundary = scrollBox(1000, 300, 700 - THINKING_AUTOFOLLOW_THRESHOLD_PX)
    expect(isThinkingNearBottom(atBoundary)).toBe(true)
    const onePixelBeyond = scrollBox(1000, 300, 700 - THINKING_AUTOFOLLOW_THRESHOLD_PX - 1)
    expect(isThinkingNearBottom(onePixelBeyond)).toBe(false)

    const element = scrollBox(1000, 300, 652)
    const autoFollow = createThinkingAutoFollow(() => element)
    expect(autoFollow.onScroll().following).toBe(true)

    element.scrollHeight = 1200
    const update = autoFollow.onContentUpdate()
    expect(update).toMatchObject({
      following: true,
      nearBottom: true,
      showJumpToLatest: false,
      scrolled: true,
    })
    expect(element.scrollTop).toBe(900)

    // jsdom reports zero for all scroll metrics. It must be safe and stay in
    // following mode rather than showing a false "jump to latest" affordance.
    const jsdomLike = scrollBox(0, 0, 0)
    const jsdomFollow = createThinkingAutoFollow(() => jsdomLike)
    expect(isThinkingNearBottom(jsdomLike)).toBe(true)
    expect(jsdomFollow.onContentUpdate()).toMatchObject({
      following: true,
      showJumpToLatest: false,
      scrolled: false,
    })
  })

  it('stops following on an upward scroll and does not pull the user back', () => {
    const element = scrollBox(1000, 300, 700)
    const autoFollow = createThinkingAutoFollow(() => element)
    autoFollow.onScroll()

    // Ten pixels up is still within the proximity threshold, but user intent
    // takes precedence and pauses following immediately.
    element.scrollTop = 690
    expect(autoFollow.onScroll()).toMatchObject({
      following: false,
      nearBottom: true,
    })

    element.scrollHeight = 1200
    const update = autoFollow.onContentUpdate()
    expect(element.scrollTop).toBe(690)
    expect(update).toMatchObject({
      following: false,
      nearBottom: false,
      showJumpToLatest: true,
      scrolled: false,
    })
  })

  it('resumes following after the user returns to the bottom', () => {
    const element = scrollBox(1000, 300, 700)
    const autoFollow = createThinkingAutoFollow(() => element)
    autoFollow.onScroll()

    element.scrollTop = 100
    autoFollow.onScroll()
    element.scrollTop = 700
    expect(autoFollow.onScroll()).toMatchObject({
      following: true,
      nearBottom: true,
      showJumpToLatest: false,
    })

    element.scrollHeight = 1200
    expect(autoFollow.onContentUpdate()).toMatchObject({
      following: true,
      nearBottom: true,
      showJumpToLatest: false,
      scrolled: true,
    })
    expect(element.scrollTop).toBe(900)
  })

  it('is safe without a scroll element and can reset a paused run', () => {
    expect(isThinkingNearBottom(null)).toBe(false)

    const autoFollow = createThinkingAutoFollow(() => null)
    expect(autoFollow.onScroll()).toEqual({
      following: true,
      nearBottom: true,
      showJumpToLatest: false,
    })
    expect(autoFollow.onContentUpdate()).toMatchObject({
      following: true,
      showJumpToLatest: false,
      scrolled: false,
    })
    expect(autoFollow.jumpToLatest()).toMatchObject({
      following: true,
      showJumpToLatest: false,
      scrolled: false,
    })
    expect(autoFollow.reset()).toMatchObject({
      following: true,
      showJumpToLatest: false,
    })
  })

  it('reset clears an explicit pause for the next run', () => {
    const element = scrollBox(1000, 300, 700)
    const autoFollow = createThinkingAutoFollow(() => element)
    autoFollow.onScroll()
    element.scrollTop = 100
    expect(autoFollow.onScroll().following).toBe(false)

    expect(autoFollow.reset()).toMatchObject({
      following: true,
      nearBottom: true,
      showJumpToLatest: false,
    })
    element.scrollHeight = 1200
    expect(autoFollow.onContentUpdate()).toMatchObject({
      following: true,
      scrolled: true,
    })
    expect(element.scrollTop).toBe(900)
  })
})
