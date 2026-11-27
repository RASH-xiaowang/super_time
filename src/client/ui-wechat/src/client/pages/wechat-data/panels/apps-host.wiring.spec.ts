/**
 * 应用托管面板的接线判据（2026-11-24）。
 * @vitest-environment jsdom
 *
 * 面板是「授权 → 席位 → 实例」的唯一可读面，重点验证三件事：
 *   ① 没授权时给的是**可操作的原因**，而不是空白或「加载失败」；
 *   ② 席位/运行态来自 summary，不自己臆造；
 *   ③ 能力勾选只列证书允许的位，避免界面先答应、主进程再拒绝。
 *
 * 走 jsdom + mock `api-apps`：真实 IPC 由 `apps-host-ipc.spec.ts` 覆盖，
 * 这里只关心渲染结果。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppsSummary } from '../../../electron-api.ts'

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
}))

vi.mock('../api-apps.ts', () => ({
  apiAppsSummary: mocks.summary,
  apiAppsCreate: vi.fn(async () => ({ ok: true })),
  apiAppsUpdate: vi.fn(async () => ({ ok: true })),
  apiAppsRemove: vi.fn(async () => ({ ok: true })),
  apiAppsDeploy: vi.fn(async () => ({ ok: true })),
  apiAppsStart: vi.fn(async () => ({ ok: true })),
  apiAppsStop: vi.fn(async () => ({ ok: true })),
  apiAppsRestart: vi.fn(async () => ({ ok: true })),
  apiAppsStatus: vi.fn(async () => ({ ok: true })),
  apiAppsLogs: vi.fn(async () => ({ ok: true, text: '' })),
  apiAppsOpenDir: vi.fn(async () => ({ ok: true })),
  apiAppsSeedCaps: vi.fn(async () => ({ ok: true })),
  apiAppsPushTicket: vi.fn(async () => ({ ok: true })),
  emptyAppsSummary: () => baseSummary(false),
  onAppsEvent: () => () => undefined,
}))

import { AppsHostPanel } from './AppsHost.tsx'

function baseSummary(licensed: boolean): AppsSummary {
  return {
    ok: true,
    licensed,
    error: licensed ? '' : '当前授权未包含「应用托管」功能',
    code: licensed ? '' : 'FEATURE_DENIED',
    license: {
      state: licensed ? 'licensed' : 'licensed',
      licensed,
      code: licensed ? 'OK' : 'FEATURE_DENIED',
      reason: '',
      daysToExpiry: 200,
      licenseId: 'lic-abcdef12',
      expiresAt: '2027-06-01T00:00:00.000Z',
    },
    entitlement: licensed
      ? { maxInstances: 2, caps: ['search', 'send'], maxJobsPerHour: 60, standalone: false }
      : null,
    seats: { used: 1, max: licensed ? 2 : 0 },
    broker: {
      running: true,
      pipePath: '\\\\.\\pipe\\supertime-app-v1-test',
      connections: 1,
      tickets: 3,
      denied: 0,
      lastDeniedCode: '',
      lastTicketAt: Date.now(),
      graceMs: 900000,
    },
    sourceExe: 'C:/apps/SuperLanguage.exe',
    instances: licensed
      ? [{
        id: 'inst-1',
        appId: 'superlanguage',
        name: '客服号 A',
        seat: 1,
        enabled: true,
        mode: 'local',
        host: '',
        caps: ['search', 'send'],
        maxJobsPerHour: 60,
        dir: 'C:/state/apps/superlanguage/inst-1',
        exeVersion: '1.0.0',
        exeSha256: 'a'.repeat(64),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastLeaseAt: Date.now(),
        lastSeenAt: Date.now(),
        lastError: '',
        live: { ok: true, running: true, deployed: true, tokenMasked: 'abcd***wxyz', details: { queue: { queued: 2, running: 0 } } },
      }]
      : [],
  }
}

let host: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(): Promise<HTMLDivElement> {
  await act(async () => {
    root.render(createElement(AppsHostPanel))
  })
  await flush()
  return host
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mocks.summary.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('应用托管面板', () => {
  it('没有授权时给出具体原因与下一步，且新增按钮不可用', async () => {
    mocks.summary.mockResolvedValue(baseSummary(false))
    const node = await mount()
    const text = node.textContent ?? ''
    expect(text).toContain('应用托管不可用')
    expect(text).toContain('签发台')
    expect(text).toContain('授权状态：licensed')
    const add = [...node.querySelectorAll('button')].find((item) => item.textContent?.includes('新增实例'))
    expect(add?.disabled, '未授权时不能新建实例').toBe(true)
  })

  it('已授权时展示席位、运行态与实例卡片', async () => {
    mocks.summary.mockResolvedValue(baseSummary(true))
    const node = await mount()
    const text = node.textContent ?? ''
    expect(text).toContain('1 / 2')
    expect(text).toContain('客服号 A')
    expect(text).toContain('运行中')
    expect(text).toContain('席位 1')
    expect(text).toContain('2 待发 / 0 执行中')
    // 能力勾选只列证书允许的两项；未授权的「附件发送」不应出现。
    const labels = [...node.querySelectorAll('label')].map((item) => item.textContent ?? '')
    expect(labels.some((label) => label.includes('文本发送'))).toBe(true)
    expect(labels.some((label) => label.includes('附件发送'))).toBe(false)
  })

  it('找不到程序时明确提示构建或安装路径', async () => {
    const summary = baseSummary(true)
    summary.sourceExe = ''
    mocks.summary.mockResolvedValue(summary)
    const node = await mount()
    expect(node.textContent).toContain('未找到 SuperLanguage.exe')
    expect(node.textContent).toContain('resources/apps/superlanguage')
  })
})
