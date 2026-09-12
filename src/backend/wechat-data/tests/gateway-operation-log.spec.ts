// @vitest-environment node
/**
 * Composition test for the operation-log wiring in WechatDataGateway:
 * mutating @Remote methods append metadata-only rows into the operation log.
 * A stub Context lets us instantiate the gateway against a scratch data root
 * without booting the full host (no llm / agentDefaultModel needed for the
 * methods under test), and we dispose the real-time sync / scheduler timers
 * it registers through ctx.effect.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { listOperations } from '../src/query/operation-log.ts'

let root = ''
let decrypted = ''
let decoded = ''
let disposers: Array<() => void> = []

/** Minimal Cordis Context surface the gateway touches at construction/test time. */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wechat-oplog-'))
  decrypted = join(root, 'decrypted')
  decoded = join(root, 'decoded_images')
  await mkdir(decrypted, { recursive: true })
  await mkdir(decoded, { recursive: true })
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_test')
})

afterEach(async () => {
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('wechat-data operation-log wiring', () => {
  it('records a fail row when verifyImageKey runs without a configured key', () => {
    const gw = new WechatDataGateway(fakeCtx())
    const r = gw.verifyImageKey()
    expect(r.verified).toBe(false)
    const snap = listOperations(decrypted)
    expect(snap.items.length).toBeGreaterThanOrEqual(1)
    const first = snap.items[0]!
    expect(first.category).toBe('keys')
    expect(first.action).toBe('verify_image_key')
    expect(first.status).toBe('fail')
  })

  it('records an ok row when saveWechatConfig succeeds', () => {
    const gw = new WechatDataGateway(fakeCtx())
    const r = gw.saveWechatConfig({ patch: { api_enabled: true } })
    expect(r.ok).toBe(true)
    const snap = listOperations(decrypted)
    const row = snap.items[0]!
    expect(row.category).toBe('settings')
    expect(row.action).toBe('save_wechat_config')
    expect(row.status).toBe('ok')
  })

  it('records its own clear action after clearOperationLog', () => {
    const gw = new WechatDataGateway(fakeCtx())
    gw.verifyImageKey()
    gw.clearOperationLog()
    const snap = listOperations(decrypted)
    expect(snap.total).toBe(1)
    expect(snap.items[0]!.action).toBe('clear_operation_log')
  })
})
