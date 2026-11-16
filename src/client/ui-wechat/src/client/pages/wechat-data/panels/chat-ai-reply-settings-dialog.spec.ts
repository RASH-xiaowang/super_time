// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatAiReplySettingsDialog } from './chat-ai-reply-settings-dialog.tsx'

const kbScope = vi.hoisted(() => ({
  state: {
    kbId: 1,
    kbs: [{ id: 1, name: '客服知识库' }, { id: 2, name: '产品库' }],
    readError: null as string | null,
    loading: false,
  },
}))

vi.mock('./kb-scope.ts', () => ({
  useKbScope: () => kbScope.state,
}))

let host: HTMLDivElement
let root: Root

function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')]
    .find((item) => item.textContent?.trim() === text)
  if (!(match instanceof HTMLButtonElement)) throw new Error('找不到按钮：' + text)
  return match
}

async function render(input: {
  onSave: (draft: {
    name: string
    prompt: string
    splitReply: boolean
    kbEnabled: boolean
    kbId: number
  }) => Promise<boolean>
  onClose?: () => void
  saving?: boolean
  chatUsername?: string
  initialSplitReply?: boolean
  initialKbEnabled?: boolean
  initialKbId?: number
  initialWebhook?: { configured: boolean; endpoint: string }
  onLoadWebhook?: (options: { chatUsername: string; chatName?: string }) => Promise<{
    configured: boolean
    endpoint: string
  }>
  onSaveWebhook?: (options: {
    chatUsername: string
    chatName?: string
    webhookUrl: string
  }) => Promise<{ ok: boolean; configured: boolean; endpoint: string; error?: string }>
}): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => {
    root.render(createElement(ChatAiReplySettingsDialog, {
      open: true,
      chatUsername: input.chatUsername ?? 'wxid_peer',
      chatName: '小王',
      initialName: '温柔客服',
      initialPrompt: '先回应情绪，再给下一步。',
      initialSplitReply: input.initialSplitReply ?? true,
      initialKbEnabled: input.initialKbEnabled ?? false,
      initialKbId: input.initialKbId ?? 0,
      ...(input.initialWebhook === undefined ? {} : { initialWebhook: input.initialWebhook }),
      ...(input.onLoadWebhook === undefined ? {} : { onLoadWebhook: input.onLoadWebhook }),
      ...(input.onSaveWebhook === undefined ? {} : { onSaveWebhook: input.onSaveWebhook }),
      saving: input.saving === true,
      onClose: input.onClose ?? (() => {}),
      onSave: input.onSave,
    }))
  })
  await act(async () => { await Promise.resolve() })
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
})

describe('AI 回复人格设置弹窗', () => {
  it('展示当前人格并可保存', async () => {
    const onSave = vi.fn(async () => true)
    const onClose = vi.fn()
    await render({ onSave, onClose })
    expect(document.body.textContent).toContain('小王')
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('温柔客服')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value)
      .toBe('先回应情绪，再给下一步。')

    await act(async () => {
      button('保存设置').click()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledWith({
      name: '温柔客服',
      prompt: '先回应情绪，再给下一步。',
      splitReply: true,
      kbEnabled: false,
      kbId: 0,
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('恢复内置人格只清空草稿，显式保存后才提交空值', async () => {
    const onSave = vi.fn(async () => true)
    await render({ onSave })
    await act(async () => { button('恢复内置人格').click() })
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('')
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('')

    await act(async () => {
      button('保存设置').click()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledWith({
      name: '',
      prompt: '',
      splitReply: true,
      kbEnabled: false,
      kbId: 0,
    })
  })

  it('长回复分段开关随草稿保存', async () => {
    const onSave = vi.fn(async () => true)
    await render({ onSave })
    const toggle = document.querySelector('input[role="switch"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await act(async () => { toggle.click() })
    await act(async () => {
      button('保存设置').click()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledWith({
      name: '温柔客服',
      prompt: '先回应情绪，再给下一步。',
      splitReply: false,
      kbEnabled: false,
      kbId: 0,
    })
  })

  it('勾选知识库后自动落到当前作用域的库，并随草稿保存', async () => {
    const onSave = vi.fn(async () => true)
    await render({ onSave })
    const check = document.querySelector('input[aria-label="知识库参与回复"]') as HTMLInputElement
    expect(check.checked).toBe(false)
    await act(async () => {
      check.click()
      await Promise.resolve()
    })
    const select = document.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('1')
    expect(select.disabled).toBe(false)
    await act(async () => {
      button('保存设置').click()
      await Promise.resolve()
    })
    expect(onSave).toHaveBeenCalledWith({
      name: '温柔客服',
      prompt: '先回应情绪，再给下一步。',
      splitReply: true,
      kbEnabled: true,
      kbId: 1,
    })
  })

  it('勾选知识库但没有可选库时阻止保存并提示', async () => {
    const onSave = vi.fn(async () => true)
    const original = kbScope.state
    kbScope.state = { kbId: 1, kbs: [], readError: null, loading: false }
    try {
      await render({ onSave })
      const check = document.querySelector('input[aria-label="知识库参与回复"]') as HTMLInputElement
      await act(async () => {
        check.click()
        await Promise.resolve()
      })
      await act(async () => {
        button('保存设置').click()
        await Promise.resolve()
      })
      expect(onSave).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('请选择参与回复的知识库')
    } finally {
      kbScope.state = original
    }
  })

  it('保存中禁用关闭与重复提交', async () => {
    const onSave = vi.fn(async () => true)
    const onClose = vi.fn()
    await render({ onSave, onClose, saving: true })
    expect(button('取消').disabled).toBe(true)
    expect(button('保存中…').disabled).toBe(true)
    expect(button('恢复内置人格').disabled).toBe(true)
  })

  it('默认 Webhook 按当前会话读取，并显示脱敏端点', async () => {
    const onLoadWebhook = vi.fn(async () => ({
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
    }))
    await render({ onSave: async () => true, onLoadWebhook })
    expect(onLoadWebhook).toHaveBeenCalledWith({
      chatUsername: 'wxid_peer',
      chatName: '小王',
    })
    expect((document.querySelector('input[aria-label="默认大肥鱼 Webhook 地址"]') as HTMLInputElement).value)
      .toBe('http://192.168.1.4:17890/webhook/***')
    expect(document.body.textContent).toContain('已配置')
  })

  it('输入新地址后保存时携带会话作用域，成功后回显脱敏值', async () => {
    const onSaveWebhook = vi.fn(async () => ({
      ok: true,
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
    }))
    await render({
      onSave: async () => true,
      initialWebhook: {
        configured: true,
        endpoint: 'http://192.168.1.4:17890/webhook/***',
      },
      onSaveWebhook,
    })
    const input = document.querySelector('input[aria-label="默认大肥鱼 Webhook 地址"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 'http://192.168.1.4:17890/webhook/new-token')
    })
    await act(async () => {
      button('保存 Webhook').click()
      await Promise.resolve()
    })
    expect(onSaveWebhook).toHaveBeenCalledWith({
      chatUsername: 'wxid_peer',
      chatName: '小王',
      webhookUrl: 'http://192.168.1.4:17890/webhook/new-token',
    })
    expect(input.value).toBe('http://192.168.1.4:17890/webhook/***')
  })

  it('空值或脱敏值不会覆盖原 token', async () => {
    const onSaveWebhook = vi.fn(async () => ({
      ok: true,
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
    }))
    await render({
      onSave: async () => true,
      initialWebhook: {
        configured: true,
        endpoint: 'http://192.168.1.4:17890/webhook/***',
      },
      onSaveWebhook,
    })
    const input = document.querySelector('input[aria-label="默认大肥鱼 Webhook 地址"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, '')
    })
    await act(async () => {
      button('保存 Webhook').click()
    })
    expect(onSaveWebhook).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('不会覆盖已保存的 token')
  })

  it('拒绝非 Feather 路径，避免任意路径密钥被回显', async () => {
    const onSaveWebhook = vi.fn(async () => ({
      ok: true,
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
    }))
    await render({ onSave: async () => true, onSaveWebhook })
    const input = document.querySelector('input[aria-label="默认大肥鱼 Webhook 地址"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 'http://192.168.1.4:17890/hooks/super-secret')
    })
    await act(async () => {
      button('保存 Webhook').click()
    })
    expect(onSaveWebhook).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('/webhook/<token>')
  })

  it('默认地址已保存但规则绑定失败时，仍回显脱敏配置并提示错误', async () => {
    const onSaveWebhook = vi.fn(async () => ({
      ok: false,
      configured: true,
      endpoint: 'http://192.168.1.4:17890/webhook/***',
      error: '默认 Webhook 已保存，但规则绑定失败',
    }))
    await render({ onSave: async () => true, onSaveWebhook })
    const input = document.querySelector('input[aria-label="默认大肥鱼 Webhook 地址"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 'http://192.168.1.4:17890/webhook/new-token')
    })
    await act(async () => {
      button('保存 Webhook').click()
      await Promise.resolve()
    })
    expect(input.value).toBe('http://192.168.1.4:17890/webhook/***')
    expect(document.body.textContent).toContain('已配置')
    expect(document.body.textContent).toContain('规则绑定失败')
  })

  it('保存请求未完成时阻止重复点击', async () => {
    let resolveSave!: (value: { ok: boolean; configured: boolean; endpoint: string }) => void
    const onSaveWebhook = vi.fn(() => new Promise<{
      ok: boolean
      configured: boolean
      endpoint: string
    }>((resolve) => { resolveSave = resolve }))
    await render({ onSave: async () => true, onSaveWebhook })
    const input = document.querySelector('input[aria-label="默认大肥鱼 Webhook 地址"]') as HTMLInputElement
    await act(async () => {
      setInputValue(input, 'http://192.168.1.4:17890/webhook/another-token')
    })
    await act(async () => {
      const saveButton = button('保存 Webhook')
      saveButton.click()
      saveButton.click()
      await Promise.resolve()
    })
    expect(onSaveWebhook).toHaveBeenCalledTimes(1)
    expect(button('保存中…').disabled).toBe(true)
    await act(async () => {
      resolveSave({
        ok: true,
        configured: true,
        endpoint: 'http://192.168.1.4:17890/webhook/***',
      })
      await Promise.resolve()
    })
  })
})
