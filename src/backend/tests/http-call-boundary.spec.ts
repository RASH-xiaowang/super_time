/** @vitest-environment node */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(import.meta.url)
const { isHttpCallAllowed, REMOTE_DENIED_CODE } = require(resolve(ROOT, 'src/backend/http-remote-policy.js')) as { isHttpCallAllowed: (method: string, full: boolean) => boolean; REMOTE_DENIED_CODE: string }
const source = ts.createSourceFile('http-server.js', readFileSync(resolve(ROOT, 'src/backend/http-server.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const factory = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createCallHandler')
if (!factory) throw new Error('Missing actual HTTP route factory')
describe('actual HTTP call-handler denial path, injected request/body only, no network', () => {
  for (const [method, full] of [['getWechatConfig', false], ['not-a-method', false], ['not-a-method', true]] as Array<readonly [string, boolean]>) {
    it(method + ' fullAccess=' + String(full) + ' is denied before license/backend/mutation work', async () => {
      const begin = vi.fn(() => { throw new Error('POLICY_BYPASS_REACHED_MUTATION') })
      const gatedCall = vi.fn(), sendJson = vi.fn()
      const build = runInNewContext('(' + factory.getText(source) + ')', {
        allowBrowserRequest: () => true, readBody: async () => ({ method, args: [] }),
        parseCookies: () => ({ fixture: 'session' }), SESSION_COOKIE: 'fixture',
        isHttpCallAllowed, REMOTE_DENIED_CODE, sendJson, beginMutation: begin,
      }) as (deps: object, ctx: object) => { handleCall: (req: object, res: object) => Promise<void> }
      const { handleCall: handle } = build({ gatedCall }, { sessions: { isFull: () => full } })
      await expect(handle({ headers: {} }, {})).resolves.toBeUndefined()
      expect(sendJson).toHaveBeenCalledWith({}, 200, expect.objectContaining({ ok: false, error: expect.objectContaining({ code: REMOTE_DENIED_CODE, details: { method } }) }))
      expect(begin).not.toHaveBeenCalled(); expect(gatedCall).not.toHaveBeenCalled()
    })
  }
})
