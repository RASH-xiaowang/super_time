/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const caps = vi.hoisted(() => ({ desktop: true, full: false }))
vi.mock('../api-core.ts', async importOriginal => ({ ...await importOriginal<object>(), runtimeCapabilities: () => ({ isDesktop: caps.desktop, isBrowser: !caps.desktop, desktopEquivalent: caps.full }) }))
const api = vi.hoisted(() => ({ get: vi.fn(), status: vi.fn(), send: vi.fn(), draft: vi.fn(), save: vi.fn(), write: vi.fn(), del: vi.fn(), promise: vi.fn() }))
vi.mock('../api-agent-desk.ts', () => ({ apiGetAgentDesk: api.get, apiSetAgentProposalStatus: api.status, apiSendAgentProposal: api.send, apiSendAgentDraft: api.draft, apiSaveAgentControl: api.save, apiWriteAgentMemory: api.write, apiDeleteAgentMemory: api.del, apiAddAgentPromise: api.promise }))
import { AgentDeskPanel } from './AgentDesk.tsx'
let host: HTMLDivElement, root: Root
const click = async (label: string): Promise<void> => {
  const b = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  expect(b, label).toBeDefined()
  await act(async () => { b!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
}
beforeEach(async () => {
  vi.clearAllMocks()
  caps.desktop = true; caps.full = false
  api.get.mockResolvedValue({ control: { killed: false, shadow: true, quietStart: '', quietEnd: '', cooldownMs: 0, hourCap: 80, dayCap: 400, proactiveHourCap: 1, handoff: false, updatedAt: 1 }, memories: [{ id: 7, text: 'fixture memory', status: 'active' }], promises: [], audit: [], reconcile: { expected: 0, executed: 0, skipped: 0, delta: 0 }, drafts: [{ id: 3, chatName: 'fixture chat', targetName: 'fixture target', text: 'fixture draft', error: '' }], proposals: [{ id: 5, decision: 'hold', reasonCode: 'fixture', body: 'fixture proposal', status: 'open', createdAt: 1 }] })
  for (const fn of [api.status, api.send, api.draft, api.save, api.write, api.del, api.promise]) fn.mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(createElement(AgentDeskPanel)); await Promise.resolve() })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
describe('AgentDesk explicit action separation (mock API only)', () => {
  it('loading a proposal does not send or mark it accepted', () => {
    expect(host.textContent).toContain('fixture proposal')
    expect(api.send).not.toHaveBeenCalled(); expect(api.draft).not.toHaveBeenCalled(); expect(api.status).not.toHaveBeenCalled()
  })
  it('only mark accepted never invokes either send endpoint', async () => {
    await click('只标记采纳')
    expect(api.status).toHaveBeenCalledWith(5, 'accepted')
    expect(api.send).not.toHaveBeenCalled(); expect(api.draft).not.toHaveBeenCalled()
  })
  it('proposal Webhook send calls only its explicit endpoint and target', async () => {
    await click('Webhook 发送')
    expect(api.send).toHaveBeenCalledWith(5, '文件传输助手')
    expect(api.status).not.toHaveBeenCalled(); expect(api.draft).not.toHaveBeenCalled()
  })
  it('draft Webhook send is separate from proposal/accept actions', async () => {
    await click('用 Webhook 发送')
    expect(api.draft).toHaveBeenCalledWith(3)
    expect(api.send).not.toHaveBeenCalled(); expect(api.status).not.toHaveBeenCalled()
  })
})

describe('AgentDesk visible operation feedback', () => {
  it.each(['保存', '紧急停止自动回复', '删除', '只标记采纳', '忽略'])('%s reports success without implicit sends', async label => {
    await click(label)
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/已/)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(api.send).not.toHaveBeenCalled(); expect(api.draft).not.toHaveBeenCalled()
  })
  it.each(['保存', '紧急停止自动回复', '删除', '只标记采纳', '忽略'])('%s reports rejection instead of unhandled promises or false success', async label => {
    const target = label === '删除' ? api.del : label === '只标记采纳' || label === '忽略' ? api.status : api.save
    target.mockRejectedValueOnce(new Error('fixture operation denied'))
    await click(label)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('fixture operation denied')
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(api.send).not.toHaveBeenCalled(); expect(api.draft).not.toHaveBeenCalled()
  })
  it('disables controls while pending and suppresses repeat actions', async () => {
    let finish: (() => void) | undefined
    api.save.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await click('保存')
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toContain('保存设置…')
    expect([...host.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
    await click('保存')
    expect(api.save).toHaveBeenCalledTimes(1)
    await act(async () => { finish?.(); await Promise.resolve() })
    expect(host.querySelector('[aria-busy="true"]')).toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toContain('设置已保存')
  })
  it('distinguishes a successful write from a failed list refresh', async () => {
    api.get.mockRejectedValueOnce(new Error('fixture refresh failed'))
    await click('保存')
    expect(api.save).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已完成，但列表刷新失败')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('fixture refresh failed')
  })
  it.each([false, true])('never calls Agent RPCs in browser, including fullAccess=%s', async full => {
    await act(async () => root.unmount())
    caps.desktop = false; caps.full = full; api.get.mockClear()
    root = createRoot(host)
    await act(async () => { root.render(createElement(AgentDeskPanel)); await Promise.resolve() })
    expect(host.textContent).toContain('仅桌面 IPC')
    expect(api.get).not.toHaveBeenCalled()
    for (const method of [api.save, api.write, api.del, api.promise, api.status, api.send, api.draft]) expect(method).not.toHaveBeenCalled()
  })
})
