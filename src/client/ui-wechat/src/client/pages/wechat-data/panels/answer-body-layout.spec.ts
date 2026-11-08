// @vitest-environment jsdom
/**
 * Long AI answers must expose a readable lead and separate chronology rows.
 * This guards the exact regression seen in real chats: literal `•` bullets
 * arriving from the model were rendered as one dense paragraph.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnswerBody } from './AnswerBody.tsx'

let host: HTMLDivElement
let root: Root

function render(text: string): void {
  act(() => {
    root.render(createElement(AnswerBody, { text }))
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

describe('AnswerBody structured layout', () => {
  it('renders the conclusion as a lead and Unicode bullets as dated rows', () => {
    render([
      '先说结论：最近主要在处理贵州评估和审批任务。',
      '• 2026-10-29：机器人完成一批报价评估。[1]',
      '• 2026-10-30：批量处理车辆评估。[2]',
    ].join('\n'))

    const lead = host.querySelector('p[data-answer-lead]')
    expect(lead?.textContent).toBe('先说结论：最近主要在处理贵州评估和审批任务。')

    const items = host.querySelectorAll('li')
    expect(items).toHaveLength(2)
    expect(items[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-29')
    expect(items[0]?.textContent).toContain('机器人完成一批报价评估')
    expect(host.textContent).not.toContain('• 2026-10-29')
  })
})
