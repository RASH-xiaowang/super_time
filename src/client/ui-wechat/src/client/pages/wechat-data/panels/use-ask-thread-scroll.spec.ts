import { describe, expect, it } from 'vitest'
import {
  ASK_THREAD_STICK_THRESHOLD_PX,
  askThreadContentRevision,
  resolveAskThreadScrollTop,
  resolveAskThreadStickToBottom,
} from './use-ask-thread-scroll.ts'

interface Box {
  top: number
}

function body(scrollTop = 40, scrollHeight = 1200): {
  scrollTop: number
  scrollHeight: number
  getBoundingClientRect: () => Box
} {
  return {
    scrollTop,
    scrollHeight,
    getBoundingClientRect: () => ({ top: 100 }),
  }
}

function run(top: number, hasAnswer: boolean): {
  getBoundingClientRect: () => Box
  querySelector: (selector: string) => object | null
} {
  return {
    getBoundingClientRect: () => ({ top }),
    querySelector: (selector) => selector === '[aria-label="AI 回答"]' && hasAnswer ? {} : null,
  }
}

describe('resolveAskThreadScrollTop', () => {
  it('无正文时仍跟随最新过程内容滚动到底部', () => {
    expect(resolveAskThreadScrollTop({
      body: body(40, 1600) as unknown as HTMLElement,
      latestRun: run(260, false) as unknown as HTMLElement,
      asking: true,
      stickToBottom: true,
    })).toBe(1600)
  })

  it('有正文且仍在生成时跟随最新内容', () => {
    expect(resolveAskThreadScrollTop({
      body: body(40, 1600) as unknown as HTMLElement,
      latestRun: run(260, true) as unknown as HTMLElement,
      asking: true,
      stickToBottom: true,
    })).toBe(1600)
  })

  it('完成后贴底用户回到本轮起点，先看到状态和主回答', () => {
    expect(resolveAskThreadScrollTop({
      body: body() as unknown as HTMLElement,
      latestRun: run(260, true) as unknown as HTMLElement,
      asking: false,
      stickToBottom: true,
    })).toBe(192)
  })

  it('用户主动上翻时不再拉回底部', () => {
    expect(resolveAskThreadScrollTop({
      body: body() as unknown as HTMLElement,
      latestRun: run(260, true) as unknown as HTMLElement,
      asking: false,
      stickToBottom: false,
    })).toBeNull()
  })

  it('回复过程中用户上翻后也不会被新的流式内容拉回', () => {
    expect(resolveAskThreadScrollTop({
      body: body(40, 1600) as unknown as HTMLElement,
      latestRun: run(260, true) as unknown as HTMLElement,
      asking: true,
      stickToBottom: false,
    })).toBeNull()
  })
})

describe('askThreadContentRevision', () => {
  it('正文、思考或阶段终态变化时产生新版本', () => {
    const base = { text: '回答', reasoning: '', stages: [{ key: 'tool:search', status: 'running' }] }
    const first = askThreadContentRevision(base)
    expect(askThreadContentRevision({ ...base, text: '回答继续增长' })).not.toBe(first)
    expect(askThreadContentRevision({ ...base, reasoning: '开始思考' })).not.toBe(first)
    expect(askThreadContentRevision({
      ...base,
      stages: [{ key: 'tool:search', status: 'done' }],
    })).not.toBe(first)
  })
})

describe('resolveAskThreadStickToBottom', () => {
  const metrics = (scrollTop: number) => ({
    scrollTop,
    scrollHeight: 1_000,
    clientHeight: 400,
  })

  it('从底部向上滚动后立即停止跟随，即使仍在旧的 48px 容差内', () => {
    expect(resolveAskThreadStickToBottom({
      metrics: metrics(580),
      previousScrollTop: 600,
    })).toBe(false)
  })

  it('停在底部附近且没有上移时保持跟随', () => {
    expect(resolveAskThreadStickToBottom({
      metrics: metrics(580),
      previousScrollTop: 580,
      threshold: ASK_THREAD_STICK_THRESHOLD_PX,
    })).toBe(true)
  })

  it('从上方重新滚回底部附近时恢复跟随', () => {
    expect(resolveAskThreadStickToBottom({
      metrics: metrics(590),
      previousScrollTop: 420,
    })).toBe(true)
  })

  it('向下滚动但仍远离底部时不误恢复跟随', () => {
    expect(resolveAskThreadStickToBottom({
      metrics: metrics(420),
      previousScrollTop: 300,
    })).toBe(false)
  })
})
