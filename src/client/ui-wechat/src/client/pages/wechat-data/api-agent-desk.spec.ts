/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ deleteAgentMemory: vi.fn(), addAgentPromise: vi.fn(), setAgentProposalStatus: vi.fn() }))
vi.mock('./api-core.ts', () => ({ remote: () => calls, unwrap: (result: unknown) => result }))
import { apiDeleteAgentMemory, apiAddAgentPromise, apiSetAgentProposalStatus } from './api-agent-desk.ts'
afterEach(() => vi.clearAllMocks())
describe('Agent write result failures are not shown as success', () => {
  const operations = [
    { method: calls.deleteAgentMemory, invoke: () => apiDeleteAgentMemory(1), error: '记忆没有删除' },
    { method: calls.addAgentPromise, invoke: () => apiAddAgentPromise('fixture', 1), error: '承诺没有保存' },
    { method: calls.setAgentProposalStatus, invoke: () => apiSetAgentProposalStatus(1, 'accepted'), error: '提案状态没有更新' },
  ]
  for (const operation of operations) {
    it(operation.error, async () => {
      operation.method.mockResolvedValueOnce({ ok: false })
      await expect(operation.invoke()).rejects.toThrow(operation.error)
      operation.method.mockResolvedValueOnce({ ok: true })
      await expect(operation.invoke()).resolves.toBeUndefined()
    })
  }
})
