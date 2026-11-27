// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuleFormDialog } from './message-list-dialogs.tsx'
import type { RuleForm } from './message-list-view.ts'

/**
 * 托管实例清单由主进程提供；这里只替换「取清单」这一个调用，
 * 其余 `api-apps` 导出保持真实（本 spec 不会触发它们）。
 */
const appsMocks = vi.hoisted(() => ({
  webhookTargets: vi.fn(async (): Promise<unknown> => ({ ok: true, licensed: true, targets: [] })),
}))

vi.mock('../api-apps.ts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api-apps.ts')
  return { ...actual, apiAppsWebhookTargets: appsMocks.webhookTargets }
})

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

/** 渲染并暴露 onChange，用来断言「选实例后表单变成什么」。 */
async function renderWith(value: RuleForm): Promise<{
  text: string
  html: HTMLDivElement
  change: (next: RuleForm) => void
  selected: () => string
}> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  let latest = value
  const change = (next: RuleForm): void => {
    latest = next
    act(() => {
      root.render(createElement(RuleFormDialog, {
        form: next,
        saving: false,
        onChange: change,
        onClose: () => {},
        onSubmit: () => {},
      }))
    })
  }
  act(() => {
    root.render(createElement(RuleFormDialog, {
      form: value,
      saving: false,
      onChange: change,
      onClose: () => {},
      onSubmit: () => {},
    }))
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return {
    text: document.body.textContent ?? '',
    html: host,
    change,
    selected: () => (latest.appInstanceId ?? ''),
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
})

describe('Webhook 规则表单来源适配', () => {
  it('规则表单不再编辑问候语', async () => {
    const text = await render(form('first_trigger'))
    expect(text).not.toContain('首次触发文本（问候语）')
    expect(text).toContain('下游 Webhook 地址')
  })
})

describe('下游地址选托管应用', () => {
  const TARGET = {
    id: 'inst-1',
    name: '客服号 A',
    seat: 1,
    enabled: true,
    running: true,
    ready: true,
    usable: true,
    maskedUrl: 'http://127.0.0.1:50975/webhook/***',
  }

  beforeEach(() => {
    appsMocks.webhookTargets.mockResolvedValue({ ok: true, licensed: true, targets: [TARGET] })
  })

  afterEach(() => {
    appsMocks.webhookTargets.mockReset()
  })

  it('没有实例时只给手填，并说明去「应用托管」启动', async () => {
    appsMocks.webhookTargets.mockResolvedValue({ ok: true, licensed: true, targets: [] })
    const text = await render(form())
    expect(text).toContain('托管应用环境（可选）')
    expect(text).toContain('还没有可用的托管实例')
  })

  it('选中实例后地址框变为只读脱敏值，表单记下实例 id', async () => {
    const view = await renderWith(form())
    const select = document.querySelector('select')
    expect(select, '找不到托管实例下拉').not.toBeNull()
    act(() => {
      select!.value = 'inst-1'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(view.selected()).toBe('inst-1')
    // 地址输入框只读：真实地址由主进程现取，渲染层只有脱敏串。
    const input = document.querySelector('input[value="http://127.0.0.1:50975/webhook/***"]')
    expect(input?.hasAttribute('readonly')).toBe(true)
    expect(document.body.textContent ?? '').toContain('实例重启换了端口会自动同步到这条规则')
  })

  it('切回手填时清空脱敏地址，避免把 *** 当成真实地址提交', async () => {
    const bound = form()
    bound.appInstanceId = 'inst-1'
    bound.webhookUrl = 'http://127.0.0.1:50975/webhook/***'
    const view = await renderWith(bound)
    const select = document.querySelector('select')
    act(() => {
      select!.value = ''
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(view.selected(), '切回手填应解除实例绑定').toBe('')
    expect(view.text).toContain('不使用')
  })

  it('编辑一条已绑定的规则时，输入框保持只读并给出同步说明', async () => {
    const bound = form()
    bound.appInstanceId = 'inst-1'
    bound.webhookUrl = 'http://127.0.0.1:50975/webhook/***'
    const text = await render(bound)
    expect(text).toContain('地址由该托管实例提供')
    expect(text).toContain('自动同步')
  })

  it('实例已被删除时给出手填兜底项，而不是静默变成别的实例', async () => {
    const orphan = form()
    orphan.appInstanceId = 'inst-gone'
    orphan.webhookUrl = 'http://127.0.0.1:1/webhook/***'
    const text = await render(orphan)
    expect(text).toContain('实例已删除')
  })
})

