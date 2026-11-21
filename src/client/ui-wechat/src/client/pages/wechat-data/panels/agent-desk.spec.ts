/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  api.get.mockResolvedValue({ control: { killed: false, shadow: true, quietStart: '', quietEnd: '', cooldownMs: 0, hourCap: 80, dayCap: 400, proactiveHourCap: 1, handoff: false, updatedAt: 1 }, memories: [], promises: [], audit: [], reconcile: { expected: 0, executed: 0, skipped: 0, delta: 0 }, drafts: [{ id: 3, chatName: 'fixture chat', targetName: 'fixture target', text: 'fixture draft', error: '' }], proposals: [{ id: 5, decision: 'hold', reasonCode: 'fixture', body: 'fixture proposal', status: 'open', createdAt: 1 }] })
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