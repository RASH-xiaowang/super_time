import { describe, expect, it } from 'vitest'
import { askThreadContentRevision, resolveAskThreadScrollTop } from './use-ask-thread-scroll.ts'

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
  it('无正文时把本轮状态对齐到线程顶部，避免过程详情把状态顶出视口', () => {
    expect(resolveAskThreadScrollTop({
      body: body() as unknown as HTMLElement,
      latestRun: run(260, false) as unknown as HTMLElement,
      asking: true,
      stickToBottom: true,
    })).toBe(192)
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
