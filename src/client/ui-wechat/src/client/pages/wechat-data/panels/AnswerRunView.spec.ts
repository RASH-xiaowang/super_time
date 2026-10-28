// @vitest-environment jsdom
/**
 * Shared answer-run behavior: status priority, process-before-answer ordering,
 * and collapse rules for live, completed, failed and long-running turns.
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerRunView, useAnswerRunProcessState, type AnswerRunViewProps } from './AnswerRunView.tsx'
import type { AskTurn, EvidenceBundle } from './use-ask.ts'

let host: HTMLDivElement
let root: Root

const evidence = (count: number): EvidenceBundle => ({
  items: Array.from({ length: count }, (_, index) => ({
    evidenceId: `msg:${String(index)}`,
    kind: 'hit' as const,
    tool: 'search_messages',
    tools: ['search_messages'],
    source: 'msg' as const,
    name: `证据 ${String(index + 1)}`,
    time: '2026-10-26 10:00',
    snippet: `第 ${String(index + 1)} 条完整证据内容`,
    key: `a:${String(index)}`,
    locator: { type: 'message' as const, username: 'a', localId: index, key: `a:${String(index)}` },
  })),
  facts: [],
  status: 'ok',
  missing: [],
  stats: {
    count,
    messages: count,
    kb: 0,
    sessions: 1,
    candidateCount: count,
    total: count,
    hitCount: count,
    factCount: 0,
    duplicateCount: 0,
    droppedByBudget: 0,
    truncated: false,
    snippetChars: count * 10,
    sourceCounts: { msg: count, kb: 0, agg: 0, resource: 0 },
    toolCounts: { search_messages: count },
    failedTools: [],
    attemptedTools: 1,
    successfulTools: 1,
  },
  assessment: { status: 'sufficient', sufficient: true, usableItems: count, reason: '' },
})

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

function RunHarness({ completed }: { completed: boolean }): React.JSX.Element {
  const processPropsFor = useAnswerRunProcessState()
  if (completed) {
    return createElement(AnswerRunView, {
      turn: turn({ text: '完整回答', reasoning: '已完成的思考', runId: 'run-preserved' }),
      ...processPropsFor('run-preserved'),
    })
  }
  return createElement(AnswerRunView, {
    streaming: true,
    text: '部分正文',
    reasoning: '正在形成的思考',
    runId: 'run-preserved',
    ...processPropsFor('run-preserved'),
  })
}

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

describe('AnswerRunView 实时状态', () => {
  it('思考/工具阶段自动展开过程，展示计时与停止入口', () => {
    render({
      streaming: true,
      runStartedAt: Date.now() - 1600,
      reasoning: '先确认问题里的时间范围，再查消息。',
      stages: [{
        key: 'tool:search_messages',
        label: 'search_messages',
        status: 'running',
        phase: 'called',
        callId: 'call-1',
        toolName: 'search_messages',
        argumentsSummary: '{"keywords":["报价"]}',
      }],
      onStop: vi.fn(),
    })
    expect(host.querySelector('[data-phase="tool_calling"]')).not.toBeNull()
    expect(host.textContent).toContain('调用工具 · 消息检索')
    expect(host.textContent).toContain('已用')
    expect(host.textContent).toContain('正在调用工具检索原文')
    expect(host.textContent).toContain('先确认问题里的时间范围')
    expect(processBody().hidden).toBe(false)
    expect(button('停止')).toBeDefined()
  })

  it('工具重试中显示独立状态，不只报“进行中”', () => {
    render({
      streaming: true,
      reasoning: '第一轮检索无结果，调整关键词后重试。',
      stages: [{
        key: 'tool:search_messages',
        label: 'search_messages',
        status: 'running',
        phase: 'retry',
        callId: 'call-retry',
        toolName: 'search_messages',
        attempt: 2,
        maxAttempts: 3,
        argumentsSummary: '{"keywords":["合同","报价"]}',
      }],
    })
    expect(host.textContent).toContain('重试中')
    expect(host.textContent).not.toContain('进行中')
    expect(host.textContent).toContain('尝试 2/3')
  })

  it('接地核对阶段优先于生成态显示，并给出即时反馈', () => {
    render({
      streaming: true,
      text: '已经生成、等待核对的回答。',
      stages: [{
        key: 'answer:verify',
        label: '核对结果',
        status: 'running',
      }],
    })
    expect(host.querySelector('[data-phase="verifying"]')).not.toBeNull()
    expect(host.textContent).toContain('核对结果')
    expect(host.textContent).toContain('已经生成、等待核对的回答。')
  })

  it('工具全部结束后等待正文时显示准备回答，不倒退回调用工具', () => {
    render({
      streaming: true,
      reasoning: '',
      stages: [{
        key: 'tool:search_messages',
        label: 'search_messages',
        status: 'done',
        phase: 'completed',
        callId: 'call-ready',
        toolName: 'search_messages',
        hits: 2,
        detail: '2 条命中',
      }],
    })
    expect(host.querySelector('[data-phase="preparing"]')).not.toBeNull()
    expect(host.textContent).toContain('准备回答')
    expect(host.textContent).not.toContain('调用工具 ·')
    expect(host.textContent).toContain('正在准备回答')
  })

  it('正文一到就自动收起过程，但用户手动展开后保持展开', () => {
    render({
      streaming: true,
      reasoning: '先检查上下文。',
      stages: [],
    })
    expect(processBody().hidden).toBe(false)
    rerender({
      streaming: true,
      text: '开始输出正文',
      reasoning: '先检查上下文。',
      stages: [],
    })
    expect(host.querySelector('[data-phase="generating"]')).not.toBeNull()
    expect(processBody().hidden).toBe(true)
    click('思考与执行过程')
    expect(processBody().hidden).toBe(false)
    rerender({
      streaming: true,
      text: '正文继续增长',
      reasoning: '先检查上下文。',
      stages: [],
    })
    expect(processBody().hidden).toBe(false)
  })

  it('实时长思考展示完整最新内容，不沿用完成态的六行截断', () => {
    const reasoning = `开头。\n${'持续追加的思考内容。'.repeat(90)}\n最新结论。`
    render({ streaming: true, reasoning })
    const thinking = host.querySelector('[class*="thinkingText"]')
    expect(thinking?.getAttribute('data-clamp')).toBeNull()
    expect(thinking?.getAttribute('data-scroll')).toBe('true')
    expect(thinking?.getAttribute('tabindex')).toBe('0')
    expect(thinking?.getAttribute('aria-label')).toContain('实时思考过程')
    expect(thinking?.textContent).toContain('最新结论')
    const section = thinking?.closest('section')
    expect(section).not.toBeNull()
    expect([...(section?.querySelectorAll('button') ?? [])]
      .some(item => item.textContent?.includes('展开完整思考'))).toBe(false)
  })

  it('实时长思考只在接近底部时跟随；用户上翻后回到最新需主动触发', () => {
    const reasoning = `开头。\n${'持续追加的思考内容。'.repeat(90)}`
    render({ streaming: true, reasoning })
    const thinking = host.querySelector('[class*="thinkingText"]') as HTMLDivElement
    Object.defineProperty(thinking, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(thinking, 'clientHeight', { configurable: true, value: 320 })
    act(() => {
      thinking.scrollTop = 680
      thinking.dispatchEvent(new Event('scroll'))
    })
    rerender({ streaming: true, reasoning: `${reasoning}\n新增一段。` })
    expect(thinking.scrollTop).toBe(680)

    act(() => {
      thinking.scrollTop = 120
      thinking.dispatchEvent(new Event('scroll'))
    })
    expect(button('回到最新')).toBeDefined()
    rerender({ streaming: true, reasoning: `${reasoning}\n又新增一段。` })
    expect(thinking.scrollTop).toBe(120)

    click('回到最新')
    expect(thinking.scrollTop).toBe(680)
    expect([...host.querySelectorAll('button')]
      .some(item => item.textContent?.includes('回到最新'))).toBe(false)
  })

  it('流式期间 busy 只包裹回答正文，不阻断状态摘要播报', () => {
    render({ streaming: true, text: '正在生成' })
    expect(host.firstElementChild?.getAttribute('aria-busy')).toBeNull()
    expect(host.querySelector('[class*="answerCard"]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('来源尚未返回时引用角标显示生成中，而不是误报编号错误', () => {
    render({ streaming: true, text: '阶段性结论[1]' })
    const cite = host.querySelector('[class*="citeMark"]')
    expect(cite?.tagName).toBe('SPAN')
    expect(cite?.getAttribute('data-pending')).toBe('true')
    expect(cite?.getAttribute('aria-label')).toBe('第 1 条来源正在生成')
    expect(host.textContent).not.toContain('不存在')
  })
})

describe('AnswerRunView 已完成轮次', () => {
  it('正文强调按样式渲染，连续引用聚合但保留独立点击', () => {
    render({
      turn: turn({
        text: '**重点结论**[1][2]',
        citations: [
          { name: '来源一', time: '', snippet: '', username: 'a', local_id: 1 },
          { name: '来源二', time: '', snippet: '', username: 'a', local_id: 2 },
        ],
      }),
    })
    expect(host.querySelector('[class*="answerContent"] strong')?.textContent).toBe('重点结论')
    expect(host.textContent).not.toContain('**')
    const groups = host.querySelectorAll('[class*="citeGroup"]')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.querySelectorAll('[class*="citeMark"]')).toHaveLength(2)
  })

  it('思考与执行过程在正式回答之前，完成后显示耗时、首字与工具统计', () => {
    render({
      turn: turn({
        text: '结论在正文里。',
        reasoning: '先确认范围，再检索原文。',
        evidence: evidence(1),
        metrics: {
          startedAt: 1_000,
          completedAt: 4_200,
          totalMs: 3_200,
          firstTokenMs: 1_100,
          reasoningMs: 800,
          toolMs: 2_000,
        },
        stages: [{
          key: 'tool:search_messages',
          label: 'search_messages',
          status: 'done',
          phase: 'completed',
          callId: 'call-1',
          toolName: 'search_messages',
          argumentsSummary: '{"keywords":["合同"]}',
          elapsedMs: 2_000,
          hits: 4,
          detail: '返回 4 条消息命中',
        }],
        toolCalls: [{
          index: 0,
          round: 1,
          callId: 'call-1',
          name: 'search_messages',
          argumentsSummary: '{"keywords":["合同"]}',
          ok: true,
          deduplicated: false,
          attempts: 1,
          retries: 0,
          elapsedMs: 2_000,
          hits: 4,
          facts: 0,
          resultSummary: '返回 4 条消息命中',
          resultDetail: '{"tool":"search_messages","ok":true,"hits":[{"snippet":"合同已签署"}]}',
          resultTruncated: true,
        }],
      }),
    })
    expect(host.textContent).toContain('已完成')
    expect(host.textContent).toContain('总耗时 3.2s')
    expect(host.textContent).toContain('首字 1.1s')
    expect(host.textContent).toContain('思考 800ms')
    expect(host.textContent).toContain('工具耗时 2.0s')
    expect(host.querySelector('[class*="processMeta"]')?.textContent?.trim())
      .toBe('思考 800ms · 1 个工具')
    const answerAt = host.textContent?.indexOf('结论在正文里') ?? -1
    const processAt = host.textContent?.indexOf('思考与执行过程') ?? -1
    expect(processAt).toBeGreaterThan(-1)
    expect(answerAt).toBeGreaterThan(processAt)
    expect(processBody().hidden).toBe(true)
    click('思考与执行过程')
    expect(host.textContent).not.toContain('调用参数')
    click('消息检索')
    expect(host.textContent).toContain('调用参数')
    expect(host.textContent).toContain('{"keywords":["合同"]}')
    expect(host.textContent).toContain('返回 4 条消息命中')
    expect(host.textContent).toContain('结果摘要')
    expect(host.textContent).toContain('查看结构化结果（已按条数或长度截断）')
    expect(host.textContent).toContain('合同已签署')
  })

  it('失败轮次自动展开、显示完整原因并提供重试', () => {
    const retry = vi.fn()
    render({
      turn: turn({
        text: '',
        status: 'failed',
        statusReason: '模型连接超时，未生成回答',
        errorCode: 'MODEL_TIMEOUT',
        stages: [{
          key: 'tool:search_messages',
          label: 'search_messages',
          status: 'failed',
          phase: 'failed',
          callId: 'call-failed',
          toolName: 'search_messages',
          argumentsSummary: '{"query":"报价"}',
          elapsedMs: 20_000,
          deadlineExceeded: true,
          errorClass: 'timeout',
        }],
      }),
      onRetry: retry,
    })
    const alerts = host.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent).toContain('模型连接超时，未生成回答')
    expect(alerts[0]?.textContent).toContain('MODEL_TIMEOUT')
    expect(host.textContent).toContain('执行失败')
    expect(host.textContent).toContain('模型连接超时，未生成回答')
    expect(host.textContent).toContain('MODEL_TIMEOUT')
    expect(processBody().hidden).toBe(false)
    expect(host.textContent).toContain('超时')
    click('重试这一轮')
    expect(retry).toHaveBeenCalledOnce()
  })

  it('回答仍在生成时重试入口禁用且不会误触', () => {
    const retry = vi.fn()
    render({
      turn: turn({ text: '', status: 'failed', statusReason: '上一次执行失败' }),
      onRetry: retry,
      retryDisabled: true,
    })
    const action = button('重试这一轮')
    expect(action.disabled).toBe(true)
    expect(action.title).toContain('仍在生成')
    click('重试这一轮')
    expect(retry).not.toHaveBeenCalled()
  })

  it('完成态空正文显示未生成回答，不伪装成正常回答', () => {
    render({
      turn: {
        role: 'assistant',
        text: '',
      },
    })
    expect(host.textContent).toContain('状态未知')
    expect(host.textContent).toContain('本轮没有生成可展示的回答')
    expect(host.querySelector('[aria-label="AI 回答"]')).toBeNull()
  })

  it('用户先收起过程后又收到失败终态时，过程会再次自动展开', () => {
    render({
      streaming: true,
      reasoning: '先检索。',
      stages: [{
        key: 'tool:search_messages',
        label: 'search_messages',
        status: 'running',
        phase: 'called',
        callId: 'late-failure',
        toolName: 'search_messages',
      }],
    })
    expect(processBody().hidden).toBe(false)
    click('思考与执行过程')
    expect(processBody().hidden).toBe(true)
    rerender({
      turn: turn({
        text: '',
        status: 'failed',
        statusReason: '工具最终超时',
        stages: [{
          key: 'tool:search_messages',
          label: 'search_messages',
          status: 'failed',
          phase: 'failed',
          callId: 'late-failure',
          toolName: 'search_messages',
          deadlineExceeded: true,
        }],
      }),
    })
    expect(processBody().hidden).toBe(false)
    expect(host.textContent).toContain('工具最终超时')
  })

  it('旧轮次只有 trace 时仍展示脱敏参数与错误正文', () => {
    render({
      turn: turn({
        text: '降级回答',
        status: 'degraded',
        toolCalls: [{
          index: 0,
          round: 1,
          callId: 'trace-only',
          name: 'search_messages',
          argumentsSummary: '{"keywords":["旧版本"]}',
          ok: false,
          deduplicated: false,
          attempts: 2,
          retries: 1,
          elapsedMs: 1_500,
          errorClass: 'network',
          errorCode: 'TOOL_TIMEOUT',
          errorMessage: '连接检索服务超时，已返回现有证据。',
          hits: 0,
          facts: 0,
        }],
      }),
    })
    expect(processBody().hidden).toBe(false)
    expect(host.textContent).toContain('{"keywords":["旧版本"]}')
    expect(host.textContent).toContain('连接检索服务超时，已返回现有证据。')
    expect(host.textContent).toContain('TOOL_TIMEOUT')
    expect(host.textContent).toContain('重试 1 次')
    expect(host.textContent).toContain('1 个工具')
    expect(host.textContent).toContain('1 个异常')
  })

  it('同一 callId 的最终 trace 失败不被 done 阶段覆盖', () => {
    render({
      turn: turn({
        text: '保留部分回答',
        status: 'degraded',
        stages: [{
          key: 'tool:search_messages',
          label: 'search_messages',
          status: 'done',
          phase: 'completed',
          callId: 'call-conflict',
          toolName: 'search_messages',
          argumentsSummary: '{"keywords":["冲突"]}',
        }],
        toolCalls: [{
          index: 0,
          round: 1,
          callId: 'call-conflict',
          name: 'search_messages',
          argumentsSummary: '{"keywords":["冲突"]}',
          ok: false,
          deduplicated: false,
          attempts: 2,
          retries: 1,
          elapsedMs: 900,
          errorClass: 'timeout',
          errorCode: 'ETIMEDOUT',
          errorMessage: '检索服务最终超时。',
          hits: 0,
          facts: 0,
        }],
      }),
    })
    expect(host.textContent).toContain('超时')
    expect(host.querySelector('[class*="toolStatus"]')?.textContent).toBe('超时')
    expect(host.textContent).toContain('1 个异常')
    expect(processBody().hidden).toBe(false)
  })

  it('重试成功后主卡显示完成，原始尝试记录仍可展开核对', () => {
    render({
      turn: turn({
        text: '第二次检索成功。',
        status: 'ok',
        stages: [
          {
            key: 'tool:0:search_messages',
            label: 'search_messages',
            status: 'running',
            phase: 'called',
            callId: 'call-retry-success',
            toolName: 'search_messages',
            argumentsSummary: '{"keywords":["合同"]}',
            attempt: 1,
            maxAttempts: 1,
            elapsedMs: 2,
          },
          {
            key: 'tool:0:search_messages',
            label: 'search_messages',
            status: 'running',
            phase: 'retry',
            callId: 'call-retry-success',
            toolName: 'search_messages',
            argumentsSummary: '{"keywords":["合同"]}',
            attempt: 1,
            maxAttempts: 2,
            elapsedMs: 20,
            errorClass: 'timeout',
            deadlineExceeded: true,
            detail: '第 1/2 次失败，准备重试',
          },
          {
            key: 'tool:0:search_messages',
            label: 'search_messages',
            status: 'running',
            phase: 'retry',
            callId: 'call-retry-success',
            toolName: 'search_messages',
            argumentsSummary: '{"keywords":["合同"]}',
            attempt: 2,
            maxAttempts: 2,
            elapsedMs: 22,
            detail: '第 2 次尝试',
          },
          {
            key: 'tool:0:search_messages',
            label: 'search_messages',
            status: 'done',
            phase: 'completed',
            callId: 'call-retry-success',
            toolName: 'search_messages',
            argumentsSummary: '{"keywords":["合同"]}',
            attempt: 2,
            maxAttempts: 2,
            elapsedMs: 900,
            hits: 1,
            detail: '1 条命中',
          },
        ],
        toolCalls: [{
          index: 0,
          round: 1,
          callId: 'call-retry-success',
          name: 'search_messages',
          argumentsSummary: '{"keywords":["合同"]}',
          ok: true,
          deduplicated: false,
          attempts: 2,
          retries: 1,
          elapsedMs: 900,
          hits: 1,
          facts: 0,
        }],
      }),
    })
    click('思考与执行过程')
    expect(host.querySelector('[class*="toolStatus"]')?.textContent).toBe('完成')
    expect(host.textContent).not.toContain('1 个异常')
    click('消息检索')
    const historyToggle = button('查看尝试记录（4 条）')
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false')
    click('查看尝试记录（4 条）')
    expect(historyToggle.getAttribute('aria-expanded')).toBe('true')
    expect(historyToggle.getAttribute('aria-controls')).not.toBeNull()
    expect(host.textContent).toContain('第 1 次')
    expect(host.textContent).toContain('超时')
    expect(host.textContent).toContain('第 1/2 次失败，准备重试')
    expect(host.textContent).toContain('第 2 次')
    expect(host.textContent).toContain('1 条命中')
    expect(host.textContent).toContain('诊断：timeout · deadline')
  })

  it('停止或请求失败后，未收口的运行节点显示已中止而不是进行中', () => {
    const runningStage = {
      key: 'tool:0:search_messages',
      label: 'search_messages',
      status: 'running' as const,
      phase: 'called' as const,
      callId: 'call-aborted',
      toolName: 'search_messages',
      argumentsSummary: '{"keywords":["合同"]}',
      attempt: 1,
      maxAttempts: 1,
    }
    render({
      turn: turn({ text: '已生成的部分', status: 'ok', stopped: true, stages: [runningStage] }),
    })
    click('思考与执行过程')
    expect(host.textContent).toContain('已中止')
    expect(host.textContent).not.toContain('进行中')
    expect(host.querySelector('[data-status="aborted"]')).not.toBeNull()

    rerender({
      turn: turn({
        text: '',
        status: 'failed',
        statusReason: '请求中断',
        stages: [runningStage],
      }),
    })
    expect(host.textContent).toContain('已中止')
    expect(host.textContent).not.toContain('进行中')
    expect(host.querySelector('[data-status="aborted"]')).not.toBeNull()
  })

  it('停止是中性收尾而不是异常', () => {
    render({ turn: turn({ text: '已生成的部分', status: 'ok', stopped: true }) })
    expect(host.textContent).toContain('已停止')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('AnswerRunView 长内容与证据', () => {
  it('长回答默认有界展示，并可展开/收起全文', () => {
    render({ turn: turn({ text: '长回答段落。'.repeat(320) }) })
    const answer = host.querySelector('[class*="answerBody"]')
    const content = host.querySelector('[class*="answerContent"]')
    expect(answer?.getAttribute('data-collapsed')).toBe('true')
    expect(content?.textContent?.length).toBeLessThan(1300)
    const expand = button('展开全文')
    click('展开全文')
    expect(answer?.getAttribute('data-collapsed')).toBeNull()
    expect(button('收起全文')).toBe(expand)
    click('收起全文')
    expect(answer?.getAttribute('data-collapsed')).toBe('true')
  })

  it('流式正文不提前折叠，避免把新生成内容藏在预览后面', () => {
    render({
      streaming: true,
      text: '正在生成的回答。'.repeat(240),
    })
    const answer = host.querySelector('[class*="answerBody"]')
    expect(answer?.getAttribute('data-collapsed')).toBeNull()
    expect(host.textContent).not.toContain('展开全文')
  })

  it('用户手动展开后，流式完成并替换为历史轮次仍保持展开', () => {
    act(() => { root.render(createElement(RunHarness, { completed: false })) })
    expect(processBody().hidden).toBe(true)
    click('思考与执行过程')
    expect(processBody().hidden).toBe(false)
    act(() => { root.render(createElement(RunHarness, { completed: true })) })
    expect(processBody().hidden).toBe(false)
  })

  it('长思考先给有界预览，展开后保留全文', () => {
    const reasoning = '思考段落。'.repeat(180)
    render({
      turn: turn({
        text: '正文',
        status: 'degraded',
        reasoning,
        metrics: { startedAt: 1_000, completedAt: 3_000, totalMs: 2_000, reasoningMs: 1_200 },
      }),
    })
    click('思考与执行过程')
    const thinking = host.querySelector('[class*="thinkingText"]')
    expect(thinking?.getAttribute('data-clamp')).toBe('true')
    const toggle = button('展开完整思考')
    expect(toggle.getAttribute('aria-controls')).toBe(thinking?.id)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    click('展开完整思考')
    expect(thinking?.getAttribute('data-clamp')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(thinking?.textContent).toBe(reasoning)
  })

  it('证据默认显示 6 条，可展开全部且保留完整摘要', () => {
    render({
      turn: turn({
        text: '带证据的回答',
        evidence: evidence(8),
        grounding: {
          checked: 3,
          unsupported: ['240 笔'],
          cited: 2,
          repaired: true,
        },
      }),
    })
    click('思考与执行过程')
    expect(host.querySelectorAll('[class*="evidenceItem"]')).toHaveLength(6)
    expect(host.textContent).toContain('第 1 条完整证据内容')
    expect(host.textContent).toContain('未在原文找到')
    expect(host.textContent).toContain('240 笔')
    click('显示全部 8 条证据')
    expect(host.querySelectorAll('[class*="evidenceItem"]')).toHaveLength(8)
  })

  it('证据的会话名与发送者都带企业名', () => {
    const base = evidence(1)
    render({
      turn: turn({
        text: '带企业证据的回答',
        evidence: {
          ...base,
          items: [{
            ...base.items[0]!,
            enterpriseName: '甲方公司',
            sender: '李四',
            senderEnterpriseName: '乙方公司',
          }],
        },
      }),
    })
    click('思考与执行过程')
    expect(host.textContent).toContain('证据 1（企业：甲方公司）')
    expect(host.textContent).toContain('李四（企业：乙方公司）')
  })

  it('超长执行步骤使用显式折叠，不创建内层滚动区', () => {
    const detail = `阶段详情。${'这是一段用于核对的超长步骤说明。'.repeat(60)}`
    render({
      turn: turn({
        text: '回答正文',
        stages: [{
          key: 'answer:tools',
          label: '工具调用',
          status: 'done',
          detail,
        }],
      }),
    })
    click('思考与执行过程')
    const details = host.querySelector('details[class*="stageDetails"]')
    expect(details).not.toBeNull()
    expect(details?.querySelector('summary')?.textContent).toContain('查看完整步骤说明')
    expect(host.querySelector('[data-scroll="true"]')).toBeNull()
    expect(details?.textContent).toContain(detail)
  })
})
