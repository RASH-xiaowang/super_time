// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuleFormDialog } from './message-list-dialogs.tsx'
import type { RuleForm } from './message-list-view.ts'

let host: HTMLDivElement
let root: Root

function form(recordSource?: RuleForm['recordSource']): RuleForm {
  return {
    chatName: 'ai-微信助理',
    targetName: 'ai-微信助理',
    webhookUrl: 'http://192.168.1.20:8080/reply',
    greetingText: '你好',
    note: '',
    enabled: true,
    recordSource,
  }
}

async function render(value: RuleForm): Promise<string> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root.render(createElement(RuleFormDialog, {
      form: value,
      saving: false,
      onChange: () => {},
      onClose: () => {},
      onSubmit: () => {},
    }))
  })
  await act(async () => { await Promise.resolve() })
  return document.body.textContent ?? ''
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
})

describe('Webhook 规则表单来源适配', () => {
  it('AI 回复来源不显示首次触发文本，并说明会保留已有问候语', async () => {
    const text = await render(form('ai_reply'))
    expect(text).not.toContain('首次触发文本（问候语）')
    expect(text).toContain('AI 回复来源直接使用下游 Webhook')
    expect(text).toContain('已有问候语会保留')
  })

  it('普通来源仍显示首次触发文本', async () => {
    const text = await render(form('first_trigger'))
    expect(text).toContain('首次触发文本（问候语）')
    expect(text).not.toContain('AI 回复来源直接使用下游 Webhook')
  })
})
