// @vitest-environment jsdom
/**
 * M3 的**行为**守卫：`useChatsExport` 里那条进度/取消链路真的走得通。
 *
 * 同目录的 `m3-export-progress.wiring.spec.ts` 是源码级守卫（读正则），`scripts/export-progress-e2e.mjs`
 * 是真机验收（跑真 Electron，但**不在 CI 的门禁里**）。这一份填中间那层空：在 CI 里、可重复地证明
 * 「按 jobId 认领 / 别人的 jobId 不认领 / 中止真调 RPC / 取消不报成失败 / 收尾把槽清干净」。
 *
 * 为什么需要行为层：本次真机跑出来的第一个 bug 是「客户端把 jobId 传了、后端签名里却没这个字段」——
 * 客户端源码看着完全正确，正则守卫全绿。行为层把客户端这一半的语义钉死，
 * 另一半由 `src/backend/wechat-data/tests/export-progress-job.spec.ts` 钉。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/** `vi.mock` 的工厂在**导入阶段**执行，取不到后面才赋值的常量 ⇒ 必须放进 hoisted。 */
const mocks = vi.hoisted(() => ({
  apiExportSessionMessages: vi.fn(),
  apiCancelExportJob: vi.fn(),
  apiResolveChatHistory: vi.fn(),
  pickDirectory: vi.fn(),
}))
vi.mock('../api.ts', () => mocks)

const { useChatsExport } = await import('./chats-export.tsx')
type Hook = ReturnType<typeof useChatsExport>

const CUR = { username: 'wxid_hook', displayName: '钩子夹具' } as WechatSession
let hookRef: Hook | null = null
let host: HTMLDivElement
let root: Root

function Harness(): React.JSX.Element {
  const hook = useChatsExport({
    EXPO_TYPES: [{ key: 'text', label: '文本', types: [1] }],
    chatlogResolving: false,
    curSession: CUR,
    setChatlogResolving: () => {},
    setChatlogStack: () => {},
    setPinnedCollapsed: () => {},
  })
  hookRef = hook
  const p = hook.exportProgress
  return createElement('div', {
    'data-progress': p ? `${p.phase} ${p.done}/${p.total}` : 'none',
    'data-exporting': String(hook.exporting),
    'data-msg': hook.exportMsg ?? '',
  })
}

const attr = (name: string): string | null => host.firstElementChild?.getAttribute(name) ?? null

/** 推一条后端进度事件（面板收到的是 ui-entry 中继出来的 DOM 事件）。 */
function emitProgress(detail: { jobId?: string; phase?: string; done?: number; total?: number }): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('dsh-wechat-export-progress', { detail }))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.apiExportSessionMessages.mockReset()
  mocks.apiCancelExportJob.mockReset()
  // 默认给一个已解决的 promise：`cancelExport` 里是 `.catch()` 兜底，mock 返回 undefined 会当场炸
  mocks.apiExportSessionMessages.mockResolvedValue({ path: 'D:/x/a.txt', filename: 'a.txt', count: 3 })
  mocks.apiCancelExportJob.mockResolvedValue({ ok: true })
  hookRef = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(createElement(Harness)) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useChatsExport：导出进度与取消（行为）', () => {
  it('导出带 jobId，并按该 jobId 认领进度事件', async () => {
    let resolve!: (v: { path: string; filename: string; count: number }) => void
    mocks.apiExportSessionMessages.mockImplementation(() => new Promise((r) => { resolve = r }))
    // 启动导出：act 里的异步体必须整体 await，否则微任务会串台（React 的告警原话）
    await act(async () => { const p = hookRef?.exportSession(); await Promise.resolve() })

    const opts = mocks.apiExportSessionMessages.mock.calls[0]![0] as { jobId: string; username: string }
    expect(opts.jobId, '没传 jobId ⇒ 后端不知道该把进度推给谁').toMatch(/^chats-export-/)
    expect(opts.username).toBe('wxid_hook')
    expect(attr('data-exporting')).toBe('true')

    emitProgress({ jobId: opts.jobId, phase: 'collect', done: 1200, total: 0 })
    expect(attr('data-progress'), '第一格进度没上屏').toBe('collect 1200/0')
    emitProgress({ jobId: opts.jobId, phase: 'format', done: 8000, total: 40001 })
    expect(attr('data-progress'), '第二格进度没往前走').toBe('format 8000/40001')
    // 别人的 jobId 不认领：否则两个面板会抢同一根进度条
    emitProgress({ jobId: 'chats-export-someone-else', phase: 'write', done: 5, total: 9 })
    expect(attr('data-progress')).toBe('format 8000/40001')

    await act(async () => { resolve({ path: 'D:/x/a.xlsx', filename: 'a.xlsx', count: 40000 }) })
    expect(attr('data-msg')).toBe('已导出 40000 条 → D:/x/a.xlsx')
    // 收尾：进度行消失 + jobId 槽清空（不清的话下一次导出会认领上一次的残留）
    expect(attr('data-progress')).toBe('none')
    expect(attr('data-exporting')).toBe('false')
    emitProgress({ jobId: opts.jobId, phase: 'write', done: 1, total: 2 })
    expect(attr('data-progress'), '结束后旧 jobId 还在往进度条上写').toBe('none')
  })

  it('点「中止导出」真的调 cancelExportJob（不是只把进度条藏起来）', async () => {
    let reject!: (e: Error) => void
    mocks.apiExportSessionMessages.mockImplementation(() => new Promise((_r, j) => { reject = j }))
    // 启动导出：act 里的异步体必须整体 await，否则微任务会串台（React 的告警原话）
    await act(async () => { const p = hookRef?.exportSession(); await Promise.resolve() })
    const jobId = (mocks.apiExportSessionMessages.mock.calls[0]![0] as { jobId: string }).jobId
    emitProgress({ jobId, phase: 'collect', done: 700, total: 0 })

    act(() => { hookRef?.cancelExport() })
    expect(mocks.apiCancelExportJob).toHaveBeenCalledWith(jobId)
    // 取消只是发信号：进度行还在，终态等 RPC 回来
    expect(attr('data-progress')).toBe('collect 700/0')

    await act(async () => { reject(new Error('操作已取消')) })
    expect(attr('data-msg'), '用户自己按的中止被报成失败').toBe('已取消导出')
    expect(attr('data-progress')).toBe('none')
    expect(attr('data-exporting')).toBe('false')
  })

  it('真失败仍如实报「导出失败」，不与取消混为一谈', async () => {
    mocks.apiExportSessionMessages.mockRejectedValue(new Error('磁盘已满'))
    await act(async () => { await hookRef?.exportSession() })
    expect(attr('data-msg')).toBe('导出失败: 磁盘已满')
    expect(attr('data-exporting')).toBe('false')
    expect(attr('data-progress')).toBe('none')
  })

  it('没有任务在跑时点中止不发 RPC（不给后端造「无此任务」的错误）', () => {
    act(() => { hookRef?.cancelExport() })
    expect(mocks.apiCancelExportJob).not.toHaveBeenCalled()
  })
})
