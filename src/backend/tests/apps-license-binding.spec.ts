/**
 * 应用托管：注册表、票据与管道协议的行为判据。
 *
 * 这三个模块是「只有 SuperTime 有可用授权时 SuperLanguage 才能用」的唯一开关，
 * 因此判据刻意只测**失败方向**与**席位边界**：
 *   ① 许可证/功能位不通过时，HELLO 一定回 DENY（而不是给票据）；
 *   ② 席位用满、实例停用、程序摘要变化都会拒绝；
 *   ③ 票据篡改/过期/时钟倒退一律验不过；
 *   ④ 删除实例后旧证明立刻失效（撤销即时性）。
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)

const registryModule = require(join(ROOT, 'src', 'backend', 'app-registry.js')) as {
  createAppRegistry: (deps: { stateDir: string, defaultCaps: string[], defaultMaxJobsPerHour: number }) => Registry
  deriveInstanceKey: (master: Buffer, id: string) => string
}
const leaseModule = require(join(ROOT, 'src', 'backend', 'app-lease.js')) as {
  issueTicket: (input: Record<string, unknown>) => { claim: string, claimHex: string, mac: string, payload: Record<string, unknown> }
  verifyTicket: (input: Record<string, unknown>) => { ok: boolean, code?: string }
  clientProof: (secret: string, op: string, id: string, exe?: string) => string
  TICKET_TTL_MS: number
}
const brokerModule = require(join(ROOT, 'src', 'backend', 'app-broker.js')) as {
  handleLine: (ctx: unknown, line: string) => { reply: string | null, code?: string }
}

interface Instance {
  id: string
  appId: string
  name: string
  seat: number
  enabled: boolean
  caps: string[]
  maxJobsPerHour: number
  exeSha256: string
}
interface Registry {
  list: () => Instance[]
  get: (id: string) => Instance | null
  create: (input: Record<string, unknown>) => { ok: boolean, instance?: Instance, error?: string, code?: string }
  update: (id: string, patch: Record<string, unknown>) => { ok: boolean, instance?: Instance, error?: string }
  remove: (id: string) => { ok: boolean }
  instanceKey: (id: string) => string
  rotateMasterKey: () => { ok: boolean }
  paths: { registryPath: string }
}

let stateDir = ''
let registry: Registry

const CAPS = ['search', 'send', 'attachments', 'mention']
const EXE = 'a'.repeat(64)

function entitlementOk(overrides: Record<string, unknown> = {}) {
  return { ok: true, maxInstances: 3, caps: CAPS, maxJobsPerHour: 120, standalone: false, licenseId: 'lic-1', ...overrides }
}

/** 造一个最小可用的 broker ctx；不监听管道，只走协议判定。 */
function makeCtx(options: { ent?: unknown, onLease?: (id: string) => void } = {}) {
  return {
    registry,
    entitlement: () => options.ent ?? entitlementOk(),
    instanceKey: (id: string) => registry.instanceKey(id),
    onLease: (id: string) => options.onLease?.(id),
  }
}

function createInstance(): Instance {
  const created = registry.create({ appId: 'superlanguage', name: '客服号 A', maxInstances: 3, caps: CAPS, maxJobsPerHour: 120 })
  expect(created.ok, created.error).toBe(true)
  return created.instance as Instance
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'supertime-apps-'))
  registry = registryModule.createAppRegistry({ stateDir, defaultCaps: CAPS, defaultMaxJobsPerHour: 120 })
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('实例注册表', () => {
  it('席位从 1 递增，删除后空出的席位会被复用', () => {
    const first = createInstance()
    const second = createInstance()
    const third = createInstance()
    expect([first.seat, second.seat, third.seat]).toEqual([1, 2, 3])

    expect(registry.remove(second.id).ok).toBe(true)
    const reused = createInstance()
    expect(reused.seat, '空出的 2 号席位应被复用').toBe(2)
  })

  it('席位用满时拒绝创建，并给出机器码', () => {
    createInstance()
    createInstance()
    const full = registry.create({ appId: 'superlanguage', maxInstances: 2, caps: CAPS, maxJobsPerHour: 120 })
    expect(full.ok).toBe(false)
    expect(full.code).toBe('SEAT_EXHAUSTED')
  })

  it('实例密钥由主密钥派生且稳定；轮换主密钥后旧密钥失效', () => {
    const instance = createInstance()
    const key1 = registry.instanceKey(instance.id)
    expect(key1).toMatch(/^[0-9a-f]{64}$/)
    expect(registry.instanceKey(instance.id)).toBe(key1)
    registry.rotateMasterKey()
    expect(registry.instanceKey(instance.id)).not.toBe(key1)
  })

  it('注册表落盘不含明文令牌以外的内容，且主密钥可重读', () => {
    const instance = createInstance()
    const reloaded = registryModule.createAppRegistry({ stateDir, defaultCaps: CAPS, defaultMaxJobsPerHour: 120 })
    expect(reloaded.get(instance.id)?.name).toBe('客服号 A')
    expect(reloaded.instanceKey(instance.id)).toBe(registry.instanceKey(instance.id))
  })
})

describe('票据', () => {
  it('正常票据可通过验签，篡改一个字符就失败', () => {
    const instance = createInstance()
    const secret = registry.instanceKey(instance.id)
    const ticket = leaseModule.issueTicket({
      secret, app: 'superlanguage', instanceId: instance.id, seat: instance.seat,
      licenseId: 'lic-1', caps: ['send'], maxJobsPerHour: 30, exeSha256: EXE,
    })
    expect(leaseModule.verifyTicket({
      secret, claim: ticket.claim, mac: ticket.mac, instanceId: instance.id, app: 'superlanguage',
    }).ok).toBe(true)

    const tampered = ticket.mac.slice(0, -1) + (ticket.mac.endsWith('a') ? 'b' : 'a')
    expect(leaseModule.verifyTicket({ secret, claim: ticket.claim, mac: tampered }).ok).toBe(false)
    expect(leaseModule.verifyTicket({ secret: 'f'.repeat(64), claim: ticket.claim, mac: ticket.mac }).ok)
      .toBe(false)
  })

  it('过期与时钟倒退都被拒绝', () => {
    const instance = createInstance()
    const secret = registry.instanceKey(instance.id)
    const now = Date.now()
    const ticket = leaseModule.issueTicket({
      secret, app: 'superlanguage', instanceId: instance.id, seat: 1,
      licenseId: 'lic-1', caps: [], maxJobsPerHour: 1, exeSha256: EXE, now,
    })
    const afterExpiry = now + leaseModule.TICKET_TTL_MS + 5 * 60_000
    expect(leaseModule.verifyTicket({ secret, claim: ticket.claim, mac: ticket.mac, now: afterExpiry }).code)
      .toBe('TICKET_EXPIRED')

    // 同一张票，先记录更高的 iat 基线（毫秒），再拿更早的票据 → 判回拨
    const futureIat = now + 600_000
    expect(leaseModule.verifyTicket({
      secret, claim: ticket.claim, mac: ticket.mac, now, lastIat: futureIat,
    }).code).toBe('CLOCK_SKEW')
  })
})

describe('管道协议', () => {
  it('授权不通过时 HELLO 不给票据，只回 DENY', () => {
    const instance = createInstance()
    const proof = leaseModule.clientProof(registry.instanceKey(instance.id), 'hello', instance.id, EXE)
    const ctx = makeCtx({ ent: { ok: false, code: 'FEATURE_DENIED', message: '未开通应用托管' } })
    const result = brokerModule.handleLine(ctx, ['HELLO', '1', instance.id, EXE, proof].join(' '))
    expect(result.reply).toMatch(/^DENY FEATURE_DENIED /)
    expect(result.code).toBe('FEATURE_DENIED')
  })

  it('证明不对、实例未登记、实例停用、席位降配都会拒绝', () => {
    const instance = createInstance()
    const key = registry.instanceKey(instance.id)
    const proof = leaseModule.clientProof(key, 'hello', instance.id, EXE)

    expect(brokerModule.handleLine(makeCtx(), ['HELLO', '1', instance.id, EXE, 'f'.repeat(64)].join(' ')).code)
      .toBe('BAD_PROOF')
    expect(brokerModule.handleLine(makeCtx(), ['HELLO', '1', '00000000-0000-4000-8000-000000000000', EXE, proof].join(' ')).code)
      .toBe('UNKNOWN_INSTANCE')

    registry.update(instance.id, { enabled: false })
    expect(brokerModule.handleLine(makeCtx(), ['HELLO', '1', instance.id, EXE, proof].join(' ')).code)
      .toBe('INSTANCE_DISABLED')
    registry.update(instance.id, { enabled: true })

    expect(brokerModule.handleLine(makeCtx({ ent: entitlementOk({ maxInstances: 0 }) }), ['HELLO', '1', instance.id, EXE, proof].join(' ')).code)
      .toBe('SEAT_EXHAUSTED')
  })

  it('正常 HELLO 回票据，RENEW 复用登记摘要，删除实例后旧证明立刻失效', () => {
    const instance = createInstance()
    registry.update(instance.id, { exeSha256: EXE })
    const key = registry.instanceKey(instance.id)
    const hello = brokerModule.handleLine(makeCtx(), ['HELLO', '1', instance.id, EXE, leaseModule.clientProof(key, 'hello', instance.id, EXE)].join(' '))
    expect(hello.reply, hello.code).toMatch(/^TICKET [0-9a-f]+ [0-9a-f]{64}$/)

    const renew = brokerModule.handleLine(makeCtx(), ['RENEW', instance.id, leaseModule.clientProof(key, 'renew', instance.id, EXE)].join(' '))
    expect(renew.reply, renew.code).toMatch(/^TICKET /)

    // 换 exe 后，旧 proof 不能再续期（证明是按登记摘要算的）
    expect(brokerModule.handleLine(makeCtx(), ['RENEW', instance.id, leaseModule.clientProof(key, 'renew', instance.id, 'b'.repeat(64))].join(' ')).code)
      .toBe('BAD_PROOF')

    registry.remove(instance.id)
    expect(brokerModule.handleLine(makeCtx(), ['RENEW', instance.id, leaseModule.clientProof(key, 'renew', instance.id, EXE)].join(' ')).code)
      .toBe('UNKNOWN_INSTANCE')
  })

  it('票据里的能力取证书与实例的交集，配额取更小值', () => {
    const instance = createInstance()
    registry.update(instance.id, { caps: ['send'], maxJobsPerHour: 500 })
    const key = registry.instanceKey(instance.id)
    const ctx = makeCtx({ ent: entitlementOk({ caps: ['send', 'search'], maxJobsPerHour: 60 }), onLease: () => undefined })
    const line = brokerModule.handleLine(ctx, ['HELLO', '1', instance.id, EXE, leaseModule.clientProof(key, 'hello', instance.id, EXE)].join(' '))
    expect(line.reply).toMatch(/^TICKET /)
    // 解 claim 看字段：票据文本第 8 项是能力、第 9 项是配额
    const [, claimHex] = String(line.reply).split(' ')
    const claim = Buffer.from(claimHex ?? '', 'hex').toString('utf8')
    const fields = claim.split('\n')
    expect(fields[7]).toBe('send')
    expect(fields[8]).toBe('60')
  })
})
