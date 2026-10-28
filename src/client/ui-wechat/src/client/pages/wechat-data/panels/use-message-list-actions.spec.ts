// @vitest-environment jsdom
/**
 * 消息列表监听开关的行为守卫。
 *
 * 重点覆盖三件事：没有令牌时不假装开启、配置成功但服务未启动时给出警告、
 * 关闭监听不依赖前置状态查询。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronApi, RemoteAccessState } from '../../../electron-api.ts'

const mocks = vi.hoisted(() => ({
  refreshWebhookInfo: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiDeleteMessageListRule: vi.fn(),
  apiInsertMessageListRecord: vi.fn(),
  apiResendMessageListRecord: vi.fn(),
  apiSaveMessageListRule: vi.fn(),
}))

import { useMessageListActions } from './use-message-list-actions.ts'

function remoteState(patch: Partial<RemoteAccessState> = {}): RemoteAccessState {
  return {
    running: true,
    port: 5032,
    configuredPort: 5032,
    address: '192.168.1.10',
    addresses: ['192.168.1.10'],
    enabled: true,
    hasToken: true,
    tokenMasked: 'abcd…wxyz',
    ...patch,
  }
}

let host: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useMessageListActions> | null = null
let mounted = false

function Probe(): React.JSX.Element {
  latest = useMessageListActions({
    refreshRecords: async () => {},
    refreshRules: async () => {},
    refreshWebhookInfo: mocks.refreshWebhookInfo,
  })
  return createElement('div')
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mounted = true
  act(() => { root.render(createElement(Probe)) })
  await flush()
}

function installRemoteAccess(overrides: {
  state?: () => Promise<Awaited<ReturnType<ElectronApi['remoteAccess']['state']>>>
  toggle?: (enabled: boolean) => Promise<Awaited<ReturnType<ElectronApi['remoteAccess']['toggle']>>>
}): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      remoteAccess: {
        state: overrides.state ?? vi.fn(),
        toggle: overrides.toggle ?? vi.fn(),
      },
    } as unknown as ElectronApi,
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  latest = null
  mocks.refreshWebhookInfo.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  if (mounted) act(() => { root.unmount() })
  host.remove()
  latest = null
  mounted = false
  delete window.electronAPI
})

describe('消息列表监听开关', () => {
  it('没有访问令牌时提示先生成，不调用开关', async () => {
    const state = vi.fn().mockResolvedValue({
      ok: true,
      value: remoteState({ running: false, enabled: false, hasToken: false }),
    })
    const toggle = vi.fn()
    installRemoteAccess({ state, toggle })
    await mount()

    await act(async () => { await latest?.toggleListening(true) })

    expect(toggle).not.toHaveBeenCalled()
    expect(mocks.refreshWebhookInfo).not.toHaveBeenCalled()
    expect(latest?.notice?.kind).toBe('warn')
    expect(latest?.notice?.text).toContain('生成访问令牌')
  })

  it('开启成功后刷新 Webhook 信息', async () => {
    const state = vi.fn().mockResolvedValue({ ok: true, value: remoteState({ running: false, enabled: false }) })
    const toggle = vi.fn().mockResolvedValue({ ok: true, value: remoteState() })
    installRemoteAccess({ state, toggle })
    await mount()

    await act(async () => { await latest?.toggleListening(true) })

    expect(toggle).toHaveBeenCalledWith(true)
    expect(mocks.refreshWebhookInfo).toHaveBeenCalledTimes(1)
    expect(latest?.notice?.kind).toBe('ok')
    expect(latest?.listeningBusy).toBe(false)
  })

  it('配置已开启但服务未运行时给出警告', async () => {
    const state = vi.fn().mockResolvedValue({ ok: true, value: remoteState({ running: false, enabled: false }) })
    const toggle = vi.fn().mockResolvedValue({
      ok: true,
      value: remoteState({ running: false }),
    })
    installRemoteAccess({ state, toggle })
    await mount()

    await act(async () => { await latest?.toggleListening(true) })

    expect(latest?.notice?.kind).toBe('warn')
    expect(latest?.notice?.text).toContain('监听未启动')
  })

  it('关闭监听不查询前置状态，并同步刷新 Webhook 信息', async () => {
    const state = vi.fn()
    const toggle = vi.fn().mockResolvedValue({
      ok: true,
      value: remoteState({ running: false, enabled: false }),
    })
    installRemoteAccess({ state, toggle })
    await mount()

    await act(async () => { await latest?.toggleListening(false) })

    expect(state).not.toHaveBeenCalled()
    expect(toggle).toHaveBeenCalledWith(false)
    expect(mocks.refreshWebhookInfo).toHaveBeenCalledTimes(1)
    expect(latest?.notice?.kind).toBe('ok')
  })
})
