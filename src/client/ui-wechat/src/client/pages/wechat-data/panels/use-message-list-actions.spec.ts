// @vitest-environment jsdom
/**
 * 消息列表监听开关的行为守卫。
 *
 * 重点覆盖三件事：没有令牌时不假装开启、配置成功但服务未启动时给出警告、
 * 关闭监听不依赖前置状态查询。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronApi, RemoteAccessState } from '../../../electron-api.ts'

const mocks = vi.hoisted(() => ({
  refreshRecords: vi.fn(),
  refreshWebhookInfo: vi.fn(),
  remoteAccessState: vi.fn(),
  toggleRemoteAccess: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiBatchDeleteMessageListRecords: vi.fn(),
  apiBatchResendMessageListRecords: vi.fn(),
  apiDeleteMessageListRule: vi.fn(),
  apiInsertMessageListRecord: vi.fn(),
  apiProbeMessageListWebhook: vi.fn(),
  apiQueryMessageListWebhookJob: vi.fn(),
  apiRemoteAccessState: mocks.remoteAccessState,
  apiResendMessageListRecord: vi.fn(),
  apiSaveMessageListRule: vi.fn(),
  apiToggleRemoteAccess: mocks.toggleRemoteAccess,
  apiOpenFileDialog: vi.fn(),
}))

import {
  apiBatchDeleteMessageListRecords,
  apiBatchResendMessageListRecords,
  apiProbeMessageListWebhook,
  apiQueryMessageListWebhookJob,
} from '../api.ts'
import { useMessageListActions } from './use-message-list-actions.ts'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'

const mocksApi = {
  batchDelete: vi.mocked(apiBatchDeleteMessageListRecords),
  batchResend: vi.mocked(apiBatchResendMessageListRecords),
  probe: vi.mocked(apiProbeMessageListWebhook),
  queryJob: vi.mocked(apiQueryMessageListWebhookJob),
}

function record(patch: Partial<MessageListRecord> = {}): MessageListRecord {
  return {
    id: 7,
    replyId: 'reply-7',
    chatName: '群',
    targetName: '小王',
    text: '你好',
    images: [],
    triggeredAt: 100,
    source: 'manual',
    status: 'success',
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: 'http://192.0.2.10:17890/webhook/***',
    error: '',
    attempts: 1,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  }
}

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
    refreshRecords: mocks.refreshRecords,
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
  mocks.remoteAccessState.mockImplementation(overrides.state ?? vi.fn())
  mocks.toggleRemoteAccess.mockImplementation(overrides.toggle ?? vi.fn())
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  latest = null
  mocks.refreshRecords.mockReset().mockResolvedValue(undefined)
  mocks.refreshWebhookInfo.mockReset().mockResolvedValue(undefined)
  mocks.remoteAccessState.mockReset()
  mocks.toggleRemoteAccess.mockReset()
  mocksApi.batchDelete.mockReset()
  mocksApi.batchResend.mockReset()
  mocksApi.probe.mockReset()
  mocksApi.queryJob.mockReset()
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

describe('记录行规则配置', () => {
  it('打开表单时带入记录的会话名和触发对象', async () => {
    await mount()
    act(() => {
      latest?.openRuleFormForRecord(record({
        id: 11,
        chatName: 'ai-微信助理',
        targetName: '客户 A',
        webhookUrl: '',
        status: 'pending',
        source: 'ai_reply',
      }))
    })
    expect(latest?.ruleForm).toMatchObject({
      chatName: 'ai-微信助理',
      targetName: '客户 A',
      webhookUrl: '',
      enabled: true,
      recordSource: 'ai_reply',
    })
  })
})

describe('消息列表下游诊断', () => {
  it('批量重发先去重，再用汇总结果提示并回源刷新', async () => {
    await mount()
    mocksApi.batchResend.mockResolvedValueOnce({
      ok: true,
      requested: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
      items: [
        { id: 7, status: 'success' },
        { id: 8, status: 'failed', error: 'HTTP 503' },
      ],
    })
    let accepted = false
    await act(async () => {
      accepted = await latest?.batchResend([
        record(),
        record(),
        record({ id: 8, replyId: 'reply-8' }),
      ]) ?? false
    })
    expect(accepted).toBe(true)
    expect(mocksApi.batchResend).toHaveBeenCalledWith({ ids: [7, 8] })
    expect(latest?.notice?.kind).toBe('warn')
    expect(latest?.notice?.text).toContain('成功 1 条，失败 1 条')
    expect(latest?.notice?.text).toContain('HTTP 503')
    expect(latest?.batchBusy).toBe(false)
  })

  it('批量重发 101 条按 100 条分批，后续批次失败仍保留已执行结果', async () => {
    await mount()
    const records = Array.from({ length: 101 }, (_, index) => record({
      id: index + 1,
      replyId: 'reply-' + String(index + 1),
    }))
    mocksApi.batchResend
      .mockResolvedValueOnce({
        ok: true,
        requested: 100,
        succeeded: 100,
        failed: 0,
        skipped: 0,
        items: records.slice(0, 100).map((item) => ({ id: item.id, status: 'success' })),
      })
      .mockRejectedValueOnce(new Error('IPC 断开'))

    let accepted = false
    await act(async () => {
      accepted = await latest?.batchResend(records) ?? false
    })

    expect(accepted).toBe(true)
    expect(mocksApi.batchResend.mock.calls.map((call) => call[0].ids)).toEqual([
      records.slice(0, 100).map((item) => item.id),
      [101],
    ])
    expect(mocks.refreshRecords).toHaveBeenCalledTimes(1)
    expect(latest?.notice?.kind).toBe('err')
    expect(latest?.notice?.text).toContain('成功 100 条，失败 1 条，跳过 0 条')
    expect(latest?.notice?.text).toContain('1 批接口失败')
    expect(latest?.notice?.text).toContain('IPC 断开')
  })

  it('批量重发 201 条跨三个批次聚合成功、失败与跳过', async () => {
    await mount()
    const records = Array.from({ length: 201 }, (_, index) => record({
      id: index + 1,
      replyId: 'reply-' + String(index + 1),
    }))
    mocksApi.batchResend
      .mockResolvedValueOnce({
        ok: true,
        requested: 100,
        succeeded: 100,
        failed: 0,
        skipped: 0,
        items: records.slice(0, 100).map((item) => ({ id: item.id, status: 'success' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        requested: 100,
        succeeded: 98,
        failed: 1,
        skipped: 1,
        items: [
          { id: 101, status: 'failed', error: 'HTTP 502' },
          { id: 102, status: 'skipped', error: '记录正在投递，已跳过' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        requested: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        items: [{ id: 201, status: 'success' }],
      })

    await act(async () => {
      await latest?.batchResend(records)
    })

    expect(mocksApi.batchResend.mock.calls.map((call) => call[0].ids.length)).toEqual([100, 100, 1])
    expect(mocks.refreshRecords).toHaveBeenCalledTimes(1)
    expect(latest?.notice?.kind).toBe('warn')
    expect(latest?.notice?.text).toContain('成功 199 条，失败 1 条，跳过 1 条')
    expect(latest?.notice?.text).toContain('HTTP 502')
  })

  it('批量删除先去重，用汇总结果提示并回源刷新', async () => {
    await mount()
    mocksApi.batchDelete.mockResolvedValueOnce({
      ok: true,
      requested: 2,
      removed: 1,
      skipped: 1,
      items: [
        { id: 7, status: 'removed' },
        { id: 8, status: 'skipped', error: '记录正在投递，不能删除' },
      ],
    })
    let accepted = false
    await act(async () => {
      accepted = await latest?.batchDelete([
        record(),
        record(),
        record({ id: 8, replyId: 'reply-8' }),
      ]) ?? false
    })
    expect(accepted).toBe(true)
    expect(mocksApi.batchDelete).toHaveBeenCalledWith({ ids: [7, 8] })
    expect(latest?.notice?.kind).toBe('warn')
    expect(latest?.notice?.text).toContain('已删除 1 条，跳过 1 条')
    expect(latest?.notice?.text).toContain('正在投递')
    expect(latest?.batchBusy).toBe(false)
  })

  it('批量删除 201 条按 100 条分批聚合删除、跳过与首条错误', async () => {
    await mount()
    const records = Array.from({ length: 201 }, (_, index) => record({
      id: index + 1,
      replyId: 'reply-' + String(index + 1),
    }))
    mocksApi.batchDelete
      .mockResolvedValueOnce({
        ok: true,
        requested: 100,
        removed: 100,
        skipped: 0,
        items: records.slice(0, 100).map((item) => ({ id: item.id, status: 'removed' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        requested: 100,
        removed: 99,
        skipped: 1,
        items: [
          { id: 101, status: 'removed' },
          { id: 102, status: 'skipped', error: '记录正在投递，不能删除' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        requested: 1,
        removed: 1,
        skipped: 0,
        items: [{ id: 201, status: 'removed' }],
      })

    await act(async () => {
      await latest?.batchDelete(records)
    })

    expect(mocksApi.batchDelete.mock.calls.map((call) => call[0].ids.length)).toEqual([100, 100, 1])
    expect(mocks.refreshRecords).toHaveBeenCalledTimes(1)
    expect(latest?.notice?.kind).toBe('warn')
    expect(latest?.notice?.text).toContain('已删除 200 条，跳过 1 条')
    expect(latest?.notice?.text).toContain('正在投递')
  })

  it('批量删除 101 条后续批次失败仍保留已删除结果', async () => {
    await mount()
    const records = Array.from({ length: 101 }, (_, index) => record({
      id: index + 1,
      replyId: 'reply-' + String(index + 1),
    }))
    mocksApi.batchDelete
      .mockResolvedValueOnce({
        ok: true,
        requested: 100,
        removed: 100,
        skipped: 0,
        items: records.slice(0, 100).map((item) => ({ id: item.id, status: 'removed' })),
      })
      .mockRejectedValueOnce(new Error('IPC 断开'))

    let accepted = false
    await act(async () => {
      accepted = await latest?.batchDelete(records) ?? false
    })

    expect(accepted).toBe(true)
    expect(mocksApi.batchDelete.mock.calls.map((call) => call[0].ids)).toEqual([
      records.slice(0, 100).map((item) => item.id),
      [101],
    ])
    expect(mocks.refreshRecords).toHaveBeenCalledTimes(1)
    expect(latest?.notice?.kind).toBe('err')
    expect(latest?.notice?.text).toContain('已删除 100 条，跳过 0 条')
    expect(latest?.notice?.text).toContain('1 批接口失败')
    expect(latest?.notice?.text).toContain('IPC 断开')
  })

  it('探测成功显示服务状态，失败保留可读原因', async () => {
    await mount()
    mocksApi.probe.mockResolvedValueOnce({
      ok: true,
      status: 200,
      service: 'feather',
      version: '1.0',
      endpoint: 'http://192.0.2.10:17890/webhook/***',
    })
    await act(async () => { await latest?.probeRecord(record()) })
    expect(mocksApi.probe).toHaveBeenCalledWith({ recordId: 7 })
    expect(latest?.notice?.kind).toBe('ok')
    expect(latest?.notice?.text).toContain('feather')
    expect(latest?.probeBusyId).toBeNull()

    mocksApi.probe.mockResolvedValueOnce({
      ok: false,
      endpoint: 'http://192.0.2.10:17890/webhook/***',
      error: 'HTTP 503',
    })
    await act(async () => { await latest?.probeRecord(record()) })
    expect(latest?.notice).toMatchObject({ kind: 'err' })
    expect(latest?.notice?.text).toContain('HTTP 503')
  })

  it('查询任务只使用记录已有 job id，并回源刷新', async () => {
    await mount()
    mocksApi.queryJob.mockResolvedValueOnce({
      ok: true,
      id: 'job-7',
      state: 'done',
      sentCount: 1,
      endpoint: 'http://192.0.2.10:17890/webhook/***',
    })
    await act(async () => {
      await latest?.queryJob(record({ jobId: 'job-7' }))
    })
    expect(mocksApi.queryJob).toHaveBeenCalledWith({ recordId: 7 })
    expect(latest?.notice?.kind).toBe('ok')
    expect(latest?.notice?.text).toContain('状态 done')
    expect(latest?.jobBusyId).toBeNull()
  })
})

describe('消息列表操作回执', () => {
  it('操作完成后的浮动提示在 2 秒后自动消失', async () => {
    vi.useFakeTimers()
    try {
      await mount()
      mocksApi.batchDelete.mockResolvedValueOnce({
        ok: true,
        requested: 1,
        removed: 1,
        skipped: 0,
        items: [{ id: 7, status: 'removed' }],
      })

      await act(async () => { await latest?.batchDelete([record()]) })
      expect(latest?.notice?.text).toContain('已删除 1 条')

      await act(async () => { vi.advanceTimersByTime(1999) })
      expect(latest?.notice).not.toBeNull()

      await act(async () => { vi.advanceTimersByTime(1) })
      expect(latest?.notice).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
