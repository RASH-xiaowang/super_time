import { useEffect, type RefObject } from 'react'

interface AskThreadScrollInput {
  body: HTMLElement
  latestRun: HTMLElement | null
  asking: boolean
  stickToBottom: boolean
}

/**
 * Decide where the thread should sit after a run changes.
 *
 * While a run has no answer yet, its process panel can be taller than the
 * viewport. Scrolling to the bottom would hide the status and pending answer,
 * so keep the latest run aligned to the top instead. Once the answer exists,
 * streaming may follow the bottom; after completion, align the whole run so
 * the status, collapsed process summary and formal answer remain together.
 */
export function resolveAskThreadScrollTop(input: AskThreadScrollInput): number | null {
  const { body, latestRun, asking, stickToBottom } = input
  if (!asking && !stickToBottom) return null
  if (latestRun === null) return body.scrollHeight
  const hasAnswer = latestRun.querySelector('[aria-label="AI 回答"]') !== null
  if (!asking || !hasAnswer) {
    const bodyTop = body.getBoundingClientRect().top
    const runTop = latestRun.getBoundingClientRect().top
    return Math.max(0, body.scrollTop + runTop - bodyTop - 8)
  }
  return body.scrollHeight
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
  atBottomRef: RefObject<boolean>
  asking: boolean
  turns: readonly unknown[]
  contentRevision?: string
}): void {
  const { bodyRef, atBottomRef, asking, contentRevision, turns } = input
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
