// @vitest-environment jsdom
/**
 * Trace-specific behavior for AnswerRunView: focus retention, per-round
 * ordering, legacy reasoning fallback, and multi-segment round collapsing.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnswerRunView, type AnswerRunViewProps } from './AnswerRunView.tsx'
import type { AskTurn } from './use-ask.ts'

let host: HTMLDivElement
let root: Root

const turn = (over: Partial<AskTurn> = {}): AskTurn => ({
  role: 'assistant',
  text: '回答正文',
  status: 'ok',
  ...over,
})

function render(props: AnswerRunViewProps): void {
  act(() => { root.render(createElement(AnswerRunView, props)) })
}

function rerender(props: AnswerRunViewProps): void {
  render(props)
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')]
    .find(item => item.textContent?.includes(label))
  expect(found, `找不到按钮：${label}`).toBeDefined()
  return found as HTMLButtonElement
}

function click(label: string): void {
  act(() => { button(label).click() })
}

function processBody(): HTMLElement {
  const found = host.querySelector('[class*="processBody"]')
  expect(found).not.toBeNull()
  return found as HTMLElement
}

function expandAllThinking(): void {
  const toggles = [...host.querySelectorAll<HTMLButtonElement>('[data-thinking-toggle]')]
  expect(toggles.length).toBeGreaterThan(0)
  act(() => {
    for (const toggle of toggles) {
      if (toggle.getAttribute('aria-expanded') === 'false') toggle.click()
    }
  })
}

const runningStages = (callId: string) => [{
  key: 'tool:search_messages',
  label: 'search_messages',
  status: 'running' as const,
  phase: 'called' as const,
  callId,
  toolName: 'search_messages',
}]

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('AnswerRunView 执行轨迹', () => {
  it('正文到达自动收起轨迹时，把焦点交还执行轨迹按钮', () => {
    const stages = runningStages('call-focus')
    render({ streaming: true, reasoning: '先确认上下文。', stages })
    const toolButton = host.querySelector('button[class*="toolHead"]') as HTMLButtonElement
    act(() => { toolButton.focus() })
    expect(document.activeElement).toBe(toolButton)

    rerender({ streaming: true, text: '正文到达', reasoning: '先确认上下文。', stages })

    const processButton = host.querySelector('button[class*="processHead"]') as HTMLButtonElement
    expect(processButton.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(processButton)
  })

  it('浏览器在隐藏轨迹时先清空焦点，仍会把焦点交还执行轨迹按钮', () => {
    const stages = runningStages('call-focus-lost')
    render({ streaming: true, reasoning: '先确认上下文。', stages })
    const toolButton = host.querySelector('button[class*="toolHead"]') as HTMLButtonElement
    act(() => { toolButton.focus() })
    act(() => { toolButton.blur() })
    expect(document.activeElement).toBe(document.body)

    rerender({ streaming: true, text: '正文到达', reasoning: '先确认上下文。', stages })

    const processButton = host.querySelector('button[class*="processHead"]') as HTMLButtonElement
    expect(processButton.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(processButton)
  })

  it('每一轮思考都渲染在对应工具调用之后', () => {
    render({
      turn: turn({
        text: '最终结论。',
        reasoningSegments: [
          { key: 'r1', round: 1, phase: 'tool_selection', text: '第一轮检索思路' },
          { key: 'r2', round: 2, phase: 'tool_selection', text: '第二轮核对思路' },
        ],
        stages: [{
          key: 'tool:search_messages',
          label: 'search_messages',
          status: 'done',
          phase: 'completed',
          round: 1,
          callId: 'call-1',
          toolName: 'search_messages',
          detail: '2 条命中',
          hits: 2,
        }, {
          key: 'tool:get_session_messages',
          label: 'get_session_messages',
          status: 'done',
          phase: 'completed',
          round: 2,
          callId: 'call-2',
          toolName: 'get_session_messages',
          detail: '读取 8 条上下文',
        }],
      }),
    })
    click('执行轨迹')
    expandAllThinking()
    const content = processBody().textContent ?? ''
    const firstTool = content.indexOf('消息检索')
    const firstThought = content.indexOf('第一轮检索思路')
    const secondTool = content.indexOf('读取会话消息')
    const secondThought = content.indexOf('第二轮核对思路')
    expect(firstTool).toBeGreaterThan(-1)
    expect(firstThought).toBeGreaterThan(firstTool)
    expect(secondTool).toBeGreaterThan(firstThought)
    expect(secondThought).toBeGreaterThan(secondTool)
    const groups = host.querySelectorAll('section[class*="traceGroup"]')
    expect(groups[0]?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(groups[1]?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(host.querySelector('[data-variant="trace"]')?.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('旧版单段思考与分轮工具混排时，仍显示在所有工具轮次之后', () => {
    render({
      turn: turn({
        text: '最终结论。',
        reasoning: '旧版整轮思考',
        stages: [{
          key: 'tool:search_messages',
          label: 'search_messages',
          status: 'done',
          phase: 'completed',
          round: 1,
          callId: 'call-legacy',
          toolName: 'search_messages',
          detail: '2 条命中',
        }],
      }),
    })
    click('执行轨迹')
    expandAllThinking()

    const content = processBody().textContent ?? ''
    expect(content.indexOf('消息检索')).toBeGreaterThan(-1)
    expect(content.indexOf('旧版整轮思考')).toBeGreaterThan(content.indexOf('消息检索'))
  })

  it('同一 round 的多个 segmentId 只渲染一份思考，并按稳定顺序合并', () => {
    render({
      streaming: true,
      text: '',
      reasoningSegments: [
        { key: 'r1b', round: 1, phase: 'tool_selection', text: '第二段思考' },
        { key: 'r1a', round: 1, phase: 'tool_selection', text: '第一段思考' },
      ],
      stages: [{
        key: 'answer:round:1',
        label: '工具选择（第 1 轮）',
        status: 'running',
        round: 1,
      }],
    })

    const thoughts = host.querySelectorAll('[data-variant="trace"]')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]?.getAttribute('data-thinking-state')).toBe('closed')
    expect(thoughts[0]?.textContent).not.toContain('第一段思考')
    expandAllThinking()
    expect(thoughts[0]?.textContent).toContain('第一段思考')
    expect(thoughts[0]?.textContent).toContain('第二段思考')
    expect((thoughts[0]?.textContent ?? '').indexOf('第一段思考'))
      .toBeLessThan((thoughts[0]?.textContent ?? '').indexOf('第二段思考'))
  })
})
