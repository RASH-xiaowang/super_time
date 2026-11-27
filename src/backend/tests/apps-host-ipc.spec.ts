/**
 * `apps:*` 的失败方向判据。
 *
 * 这些频道是「Super Time 授权了才能用 SuperLanguage」在渲染层的唯一入口，
 * 所以判据只钉三件事：
 *   ① 授权不通过时，部署/启动/发送一律拒绝（fail-closed），且不碰 host；
 *   ② 摘要频道永远可读，并把具体拒绝码带回界面；
 *   ③ 能力/配额只能收窄，不能借 IPC 提权。
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { createAppRegistry } = require(join(ROOT, 'src', 'backend', 'app-registry.js')) as {
  createAppRegistry: (deps: Record<string, unknown>) => Registry
}
const { registerAppsIpc } = require(join(ROOT, 'src', 'backend', 'ipc-apps.js')) as {
  registerAppsIpc: (deps: Record<string, unknown>) => void
}

interface Registry {
  list: () => Array<{ id: string, caps: string[], maxJobsPerHour: number }>
  create: (input: Record<string, unknown>) => { ok: boolean, instance?: { id: string, caps: string[], maxJobsPerHour: number } }
  get: (id: string) => { id: string } | null
  update: (id: string, patch: Record<string, unknown>) => { ok: boolean, instance?: { caps: string[], maxJobsPerHour: number } }
  instanceKey: (id: string) => string
}

const CAPS = ['search', 'send', 'attachments', 'mention']
let stateDir = ''
let registry: Registry
let handlers: Map<string, (event: unknown, input?: unknown) => unknown>
let entitlement: { ok: boolean, code?: string, message?: string, maxInstances?: number, caps?: string[], maxJobsPerHour?: number }
let hostCalls: string[]
/** 主进程代写后端的调用记录（method + 参数）。 */
let backendCalls: Array<{ method: string, args: unknown[] }>
/** `apps:start` 触发的规则同步会读这份清单。 */
let listedRules: Array<Record<string, unknown>>
interface FakeHost {
  status: (id: string) => Promise<Record<string, unknown>>
  sourceExe: () => string
  deploy: (id: string) => Record<string, unknown>
  start: (id: string) => Promise<Record<string, unknown>>
  stop: (id: string) => Promise<Record<string, unknown>>
  proxy: (id: string, action: string) => Promise<Record<string, unknown>>
  remove: (id: string) => Promise<Record<string, unknown>>
  logs: () => Record<string, unknown>
  instanceDirOf: () => string
  /** 「下游地址选托管应用」用：实例当前的 /webhook 地址（空串 = 未就绪）。 */
  webhookUrlOf: (instance: unknown) => string
  redactEndpoint: (url: string) => string
  isRunning: (id: string) => boolean
}
let host: FakeHost

function okEntitlement() {
  return { ok: true, maxInstances: 3, caps: CAPS, maxJobsPerHour: 120, standalone: false }
}

function build() {
  handlers = new Map()
  hostCalls = []
  backendCalls = []
  listedRules = []
  host = {
    status: async (id: string) => {
      hostCalls.push('status:' + id)
      return { ok: true, running: false, deployed: true, error: '' }
    },
    sourceExe: () => 'C:/apps/SuperLanguage.exe',
    deploy: (id: string) => {
      hostCalls.push('deploy:' + id)
      return { ok: true }
    },
    start: async (id: string) => {
      hostCalls.push('start:' + id)
      return { ok: true }
    },
    stop: async (id: string) => {
      hostCalls.push('stop:' + id)
      return { ok: true }
    },
    proxy: async (id: string, action: string) => {
      hostCalls.push('proxy:' + id + ':' + action)
      return { ok: true }
    },
    remove: async (id: string) => {
      hostCalls.push('remove:' + id)
      return { ok: true }
    },
    logs: () => ({ ok: true, text: '' }),
    instanceDirOf: () => 'C:/apps/inst',
    webhookUrlOf: () => 'http://127.0.0.1:50975/webhook/' + 'a'.repeat(32),
    redactEndpoint: (url: string) => url.replace(/(\/webhook\/)[^/]+/i, '$1***'),
    isRunning: () => true,
  }
  registerAppsIpc({
    ipcMain: { handle: (channel: string, fn: (event: unknown, input?: unknown) => unknown) => { handlers.set(channel, fn) } },
    ipcTrust: { wrap: (_channel: string, fn: (event: unknown, input?: unknown) => unknown) => fn },
    app: { getPath: () => stateDir },
    shell: { openPath: () => '' },
    licenseService: {
      getLicenseStatus: () => ({ state: 'licensed', licensed: true, payload: { licenseId: 'lic-1', features: ['wechat-data'] } }),
      getAppEntitlement: () => entitlement,
    },
    APP_VERSION: '1.0.0',
    registry,
    broker: { status: () => ({ running: true }) },
    host,
    // 「下游地址选托管应用」的后端代写入口：记录调用，返回成功信封。
    callBackend: async (method: string, args: unknown[]) => {
      backendCalls.push({ method, args })
      if (method === 'listMessageListRules') {
        return { ok: true, value: { items: listedRules, total: listedRules.length } }
      }
      return { ok: true, value: { ok: true, id: 7, backfilled: 0 } }
    },
  })
}

function call(channel: string, input?: unknown): Promise<Record<string, unknown>> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('未注册的频道：' + channel)
  return Promise.resolve(fn({}, input) as Record<string, unknown>)
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'supertime-ipc-apps-'))
  registry = createAppRegistry({ stateDir, defaultCaps: CAPS, defaultMaxJobsPerHour: 120 })
  entitlement = okEntitlement()
  build()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('应用托管 IPC', () => {
  it('授权不通过时部署/启动/发送全部拒绝，且不调用 host', async () => {
    entitlement = { ok: false, code: 'FEATURE_DENIED', message: '当前授权未包含应用托管' }
    const created = await call('apps:create', { name: 'A' })
    expect(created.ok).toBe(false)
    expect(created.code).toBe('FEATURE_DENIED')

    for (const channel of ['apps:deploy', 'apps:start']) {
      const result = await call(channel, { id: 'x' })
      expect(result.ok, channel).toBe(false)
    }
    expect((await call('apps:proxy', { id: 'x', action: 'sendMessage', payload: {} })).ok).toBe(false)
    expect(hostCalls.filter((item) => !item.startsWith('status:')), '拒绝时不能碰 host').toEqual([])
  })

  it('摘要频道永远可读，并带回拒绝码与授权状态', async () => {
    entitlement = { ok: false, code: 'EXPIRED', message: '许可证已过期' }
    const summary = await call('apps:summary')
    expect(summary.ok).toBe(true)
    expect(summary.licensed).toBe(false)
    expect(summary.code).toBe('EXPIRED')
    expect(summary.error).toBe('许可证已过期')
    expect(summary.seats).toMatchObject({ used: 0, max: 0 })
    // 功能位被拒时许可证本身可能有效：面板要显示真实状态，不能是 unknown。
    expect(summary.license).toMatchObject({ state: 'licensed', licensed: true, licenseId: 'lic-1' })
  })

  it('授权通过时 start 走 host；读接口在授权失效后仍然可用', async () => {
    const created = await call('apps:create', { name: '客服号' })
    expect(created.ok).toBe(true)
    const id = (created.instance as { id: string }).id
    expect((await call('apps:start', { id })).ok).toBe(true)
    expect(hostCalls).toContain('start:' + id)

    entitlement = { ok: false, code: 'EXPIRED', message: '过期' }
    expect((await call('apps:status', { id })).ok).toBe(true)
    expect((await call('apps:logs', { id })).ok).toBe(true)
  })

  it('能力与配额只能收窄到证书允许的范围', async () => {
    entitlement = { ...okEntitlement(), caps: ['send'], maxJobsPerHour: 30 }
    const created = await call('apps:create', { name: '收窄' })
    const id = (created.instance as { id: string }).id
    const updated = await call('apps:update', {
      id,
      patch: { caps: ['send', 'attachments', 'mention'], maxJobsPerHour: 9999 },
    })
    expect(updated.ok).toBe(true)
    expect(updated.instance).toMatchObject({ caps: ['send'], maxJobsPerHour: 30 })
  })
})

describe('下游地址选托管应用', () => {
  it('候选清单只给脱敏地址，未就绪的实例不可选', async () => {
    const created = await call('apps:create', { name: '客服号 A' })
    const id = (created.instance as { id: string }).id
    const targets = await call('apps:webhook-targets')
    expect(targets.ok).toBe(true)
    const list = targets.targets as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id,
      name: '客服号 A',
      seat: 1,
      ready: true,
      usable: true,
      maskedUrl: 'http://127.0.0.1:50975/webhook/***',
    })
    // 关键：真实令牌绝不出现。
    expect(JSON.stringify(list)).not.toContain('a'.repeat(32))

    // 未启动（解析不出地址）→ 不可选
    host.webhookUrlOf = () => ''
    const down = await call('apps:webhook-targets')
    expect((down.targets as Array<Record<string, unknown>>)[0]).toMatchObject({ ready: false, usable: false })
  })

  it('保存规则时由主进程换成真实地址，并把实例 id 一起写下去', async () => {
    const created = await call('apps:create', { name: '客服号 A' })
    const id = (created.instance as { id: string }).id
    const saved = await call('apps:save-rule', {
      instanceId: id,
      rule: { chatName: '客户群', targetName: '张三', greetingText: '您好', note: '', enabled: true },
    })
    expect(saved.ok).toBe(true)
    expect(saved.id).toBe(7)
    expect(saved.maskedUrl).toBe('http://127.0.0.1:50975/webhook/***')
    const write = backendCalls.find((item) => item.method === 'saveMessageListRule')
    expect(write).toBeTruthy()
    expect(write!.args[0]).toMatchObject({
      chatName: '客户群',
      targetName: '张三',
      webhookUrl: 'http://127.0.0.1:50975/webhook/' + 'a'.repeat(32),
      appInstanceId: id,
    })
    // 普通保存路径不会带 keepManagedBy；只有同步地址才带。
    expect((write!.args[0] as Record<string, unknown>).keepManagedBy).toBeUndefined()
  })

  it('实例未运行 / 未授权时拒绝代写，且不碰后端', async () => {
    const created = await call('apps:create', { name: '客服号 A' })
    const id = (created.instance as { id: string }).id
    host.webhookUrlOf = () => ''
    const notReady = await call('apps:save-rule', { instanceId: id, rule: { webhookUrl: '' } })
    expect(notReady.ok).toBe(false)
    expect(notReady.code).toBe('APP_NOT_READY')

    host.webhookUrlOf = () => 'http://127.0.0.1:1/webhook/' + 'b'.repeat(32)
    entitlement = { ok: false, code: 'FEATURE_DENIED', message: '未开通应用托管' }
    const denied = await call('apps:save-rule', { instanceId: id, rule: {} })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('FEATURE_DENIED')
    expect(backendCalls.filter((item) => item.method === 'saveMessageListRule')).toEqual([])
  })

  it('实例启动后把引用它的规则地址同步到新端口（保留 managed_by）', async () => {
    const created = await call('apps:create', { name: '客服号 A' })
    const id = (created.instance as { id: string }).id
    listedRules = [
      { id: 11, appInstanceId: id, chatName: '客户群', targetName: '张三', webhookUrl: 'http://127.0.0.1:1/webhook/***', greetingText: '您好', note: '', enabled: true },
      { id: 12, appInstanceId: '', chatName: '手填', targetName: '李四', webhookUrl: 'http://192.0.2.1/hook', greetingText: '你好', note: '', enabled: true },
    ]
    const started = await call('apps:start', { id })
    expect(started.ok).toBe(true)
    expect(started.rulesSynced).toBe(1)
    const writes = backendCalls.filter((item) => item.method === 'saveMessageListRule')
    expect(writes).toHaveLength(1)
    const first = writes[0]
    expect(first).toBeTruthy()
    expect(first!.args[0]).toMatchObject({
      id: 11,
      webhookUrl: 'http://127.0.0.1:50975/webhook/' + 'a'.repeat(32),
      appInstanceId: id,
      keepManagedBy: true,
    })
  })
})
