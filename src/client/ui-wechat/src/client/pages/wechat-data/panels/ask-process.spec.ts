// @vitest-environment jsdom
/**
 * 实时工具卡的渲染判据。
 *
 * 合并逻辑本身由 `ask-stage-merge.spec.ts` 覆盖；这里只钉住用户能看见的部分：
 * 过程默认折叠、工具卡显示中文动作/状态/尝试/耗时/命中，失败时自动展开。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AskProcess } from './AskProcess.tsx'
import type { AskStage } from './ask-stage-merge.ts'

let host: HTMLDivElement
let root: Root

function render(stages: AskStage[]): void {
  act(() => { root.render(createElement(AskProcess, { stages, streaming: true })) })
}

function clickProcessHead(): void {
  const button = host.querySelector('button[class*="processHead"]')
  expect(button).not.toBeNull()
  act(() => { (button as HTMLButtonElement).click() })
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

describe('AskProcess 实时工具卡', () => {
  it('默认折叠；展开后显示中文工具名、尝试次数、耗时与命中数', () => {
    render([{
      key: 'tool:0:search_messages',
      label: 'search_messages',
      status: 'done',
      phase: 'completed',
      callId: 'call_1',
      toolName: 'search_messages',
      argumentsSummary: '{"keywords":["合同"]}',
      attempt: 2,
      maxAttempts: 3,
      elapsedMs: 1250,
      hits: 4,
      facts: 1,
      detail: '4 条命中',
    }])
    expect(host.textContent).toContain('1 个工具')
    expect(host.textContent).not.toContain('消息检索')
    clickProcessHead()
    expect(host.textContent).toContain('消息检索')
    expect(host.textContent).toContain('完成')
    expect(host.textContent).toContain('尝试 2/3')
    expect(host.textContent).toContain('耗时 1.3s')
    expect(host.textContent).toContain('命中 4')
    expect(host.textContent).toContain('事实 1')
    expect(host.textContent).toContain('{"keywords":["合同"]}')
  })

  it('失败工具卡显示失败并默认展开错误分类', () => {
    render([{
      key: 'tool:1:search_files',
      label: 'search_files',
      status: 'failed',
      phase: 'failed',
      callId: 'call_2',
      toolName: 'search_files',
      argumentsSummary: '{"query":"报价"}',
      attempt: 3,
      maxAttempts: 3,
      elapsedMs: 20_000,
      errorClass: 'timeout',
      deadlineExceeded: true,
    }])
    clickProcessHead()
    expect(host.textContent).toContain('文件检索')
    expect(host.textContent).toContain('超时')
    expect(host.textContent).toContain('错误分类：timeout')
    expect(host.textContent).toContain('尝试 3/3')
    expect(host.textContent).toContain('耗时 20s')
  })

  it('重试中显示 retry 状态，迟到的 called 不把完成卡改回调用中', () => {
    render([
      {
        key: 'tool:2:search_kb',
        label: 'search_kb',
        status: 'done',
        phase: 'completed',
        callId: 'call_3',
        toolName: 'search_kb',
        attempt: 2,
        maxAttempts: 2,
        hits: 1,
      },
      {
        key: 'tool:2:search_kb',
        label: 'search_kb',
        status: 'running',
        phase: 'retry',
        callId: 'call_3',
        toolName: 'search_kb',
        attempt: 1,
      },
    ])
    expect(host.textContent).toContain('1 个工具')
    clickProcessHead()
    expect(host.textContent).toContain('知识库检索')
    expect(host.textContent).toContain('完成')
    expect(host.textContent).not.toContain('重试中')
  })
})
