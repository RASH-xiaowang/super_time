/** @vitest-environment node */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { REMOTE_ARG_SCHEMA_OVERLAY } from '../wechat-data/src/remote-arg-schema-overlay.ts'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const policy = require(resolve(ROOT, 'src/backend/http-remote-policy.js')) as {
  AGENT_DESKTOP_ONLY_METHODS: Set<string>
  LOCAL_ONLY_METHODS: Set<string>
  isHttpCallAllowed: (method: string, fullAccess: boolean) => boolean
}
const names = ['getAgentDesk', 'saveAgentControl', 'writeAgentMemory', 'deleteAgentMemory', 'addAgentPromise', 'setAgentProposalStatus', 'sendAgentDraft', 'sendAgentProposal']
const args: Record<string, object | undefined> = {
  getAgentDesk: undefined, saveAgentControl: { killed: true },
  writeAgentMemory: { scope: 'user', scopeKey: 'self', kind: 'semantic', text: 'synthetic fixture' },
  deleteAgentMemory: { id: 1 }, addAgentPromise: { text: 'fixture promise', dueAt: 1 },
  setAgentProposalStatus: { id: 1, status: 'accepted' }, sendAgentDraft: { id: 1 },
  sendAgentProposal: { id: 1, target: 'synthetic recipient' },
}
describe('Agent v41 desktop IPC boundary', () => {
  it('denies all eight HTTP methods before dispatch, including fullAccess sessions', () => {
    expect([...policy.AGENT_DESKTOP_ONLY_METHODS].sort()).toEqual([...names].sort())
    const dispatch = vi.fn()
    for (const method of names) for (const fullAccess of [false, true]) {
      expect(policy.LOCAL_ONLY_METHODS.has(method), method).toBe(true)
      const allowed = policy.isHttpCallAllowed(method, fullAccess)
      if (allowed) dispatch(method, args[method])
      expect(allowed, `${method} fullAccess=${String(fullAccess)}`).toBe(false)
    }
    expect(dispatch).not.toHaveBeenCalled()
    const server = readFileSync(resolve(ROOT, 'src/backend/http-server.js'), 'utf8')
    const call = server.slice(server.indexOf('async function handleCall('))
    expect(call).toContain('if (!isHttpCallAllowed(method, fullAccess)) {')
    expect(call.indexOf('isHttpCallAllowed(method, fullAccess)')).toBeLessThan(call.indexOf('beginMutation(method)'))
    expect(call.indexOf('code: REMOTE_DENIED_CODE')).toBeLessThan(call.indexOf('beginMutation(method)'))
    expect(call).not.toContain('if (!fullAccess && !isRemoteSafe(method))')
  })
  it('does not revoke unrelated existing fullAccess or remote-safe methods', () => {
    expect(policy.isHttpCallAllowed('getSessions', false)).toBe(true)
    expect(policy.isHttpCallAllowed('getSessions', true)).toBe(true)
    expect(policy.isHttpCallAllowed('getWechatConfig', true)).toBe(true)
    expect(policy.isHttpCallAllowed('not-a-method', false)).toBe(false)
  })
  it('has exactly one source schema and gateway declaration for each method', () => {
    const gateway = readFileSync(resolve(ROOT, 'src/backend/wechat-data/src/gateway-chat-ai-reply.ts'), 'utf8')
    for (const method of names) {
      expect(gateway.split("@Remote('" + method + "')")).toHaveLength(2)
      const entries = REMOTE_ARG_SCHEMA_OVERLAY.filter(e => e.method === method)
      expect(entries, method).toHaveLength(1)
      const parameters = entries[0]?.parameters ?? []
      if (method === 'getAgentDesk') expect(parameters).toHaveLength(0)
      else {
        expect(parameters).toHaveLength(1)
        const schema = parameters[0]?.codec.schema as { safeParse: (value: unknown) => { success: boolean } }
        expect(schema.safeParse(args[method]).success, method).toBe(true)
        const bad = method === 'saveAgentControl' ? { hourCap: -1 } : method === 'writeAgentMemory' ? { ...args[method], text: 'x'.repeat(501) } : method === 'addAgentPromise' ? { text: '', dueAt: -1 } : { id: 0 }
        expect(schema.safeParse(bad).success, method).toBe(false)
      }
    }
  })
})