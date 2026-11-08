// @vitest-environment jsdom
/** Long completed answers collapse by default; short answers stay expanded. */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnswerRunView } from './AnswerRunView.tsx'

let host: HTMLDivElement
let root: Root

function render(text: string): void {
  act(() => {
    root.render(createElement(AnswerRunView, {
      turn: { role: 'assistant', text, status: 'ok' },
    }))
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

describe('AnswerBody auto-collapse threshold', () => {
  it('collapses a roughly 500-character answer and leaves a short answer expanded', () => {
    render('这是一段需要自动折叠的长回答内容。'.repeat(36))
    const longBody = host.querySelector('[class*="answerBody"]')
    expect(longBody?.getAttribute('data-collapsed')).toBe('true')
    expect(host.textContent).toContain('展开全文')

    render('短回答直接展示，不占用展开操作。')
    const shortBody = host.querySelector('[class*="answerBody"]')
    expect(shortBody?.getAttribute('data-collapsed')).toBeNull()
    expect(host.textContent).not.toContain('展开全文')
  })
})
