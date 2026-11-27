/**
 * 跨机托管（局域网实例）的判据。
 *
 * 形状：Super Time 在 A，SuperLanguage 在 B。A 写不了 B 的进程，所以
 *   ① 部署把 `broker=push` + `api-listen=lan` 写进 B 的共享目录；
 *   ② 启动只往共享目录丢一个 `.start-request`（B 上的启动器看到就拉起 exe）；
 *   ③ 票据由 A 主进程签好后 POST 到 `http://<B-ip>:<port>/api/license/lease`。
 *
 * 这里钉住这三步的事实（不真的起进程、不真的联网）。
 *
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const { createAppHost } = require(join(ROOT, 'src', 'backend', 'app-host.js')) as {
  createAppHost: (deps: Record<string, unknown>) => Host
}

const CAPS = ['search', 'send']
const PORT = 51234
const TOKEN = 'd'.repeat(32)
const REQUESTS: Array<{ url: string, body: string }> = []

interface Registry {
  create: (input: Record<string, unknown>) => { ok: boolean, instance?: Instance, error?: string, code?: string }
  get: (id: string) => Instance | null
  update: (id: string, patch: Record<string, unknown>) => { ok: boolean }
}
interface Instance { id: string, mode: 'local' | 'lan', host: string, dir: string, seat: number }
interface Host {
  deploy: (id: string, options?: { source?: string }) => { ok: boolean, dir?: string, error?: string }
  start: (id: string) => Promise<{ ok: boolean, remote?: boolean, error?: string }>
  status: (id: string) => Promise<{ running?: boolean, error?: string }>
  dispose: () => Promise<void>
}

let stateDir = ''
let lanDir = ''
let sourceExe = ''
let registry: Registry
let host: Host

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'supertime-lan-'))
  lanDir = join(stateDir, 'remote-share', 'inst-a')
  mkdirSync(lanDir, { recursive: true })
  sourceExe = join(stateDir, 'source', 'SuperLanguage.exe')
  mkdirSync(dirname(sourceExe), { recursive: true })
  writeFileSync(sourceExe, 'fake-exe')
  REQUESTS.length = 0
  registry = createAppRegistry({ stateDir, defaultCaps: CAPS, defaultMaxJobsPerHour: 60 })
  host = createAppHost({
    stateDir,
    registry,
    brokerPipe: '\\\\.\\pipe\\supertime-app-v1-test',
    isPackaged: false,
    repoRoot: stateDir,
    fetchTimeoutMs: 2000,
    startTimeoutMs: 600,
    ticketPushIntervalMs: 60_000,
    spawnFn: () => { throw new Error('局域网实例不应该 spawn 本机进程') },
    issueTicket: () => ({ ok: true, claimHex: 'aa', mac: 'bb' }),
  })
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

/**
 * 建一个指向本机临时目录的「局域网实例」。
 *
 * registry 的 create 只接受 UNC（防止用户手填相对路径），测试里先按 UNC 建，
 * 再用 update 换成本机临时目录 —— 这样能验证「按给定目录落盘」而不真的写网络路径。
 */
function lanInstance(): Instance {
  const created = registry.create({
    appId: 'superlanguage',
    name: '远端号',
    mode: 'lan',
    host: '192.168.1.20',
    dir: '\\\\PC-B\\SuperTimeApps\\inst-a',
    maxInstances: 2,
    caps: CAPS,
    maxJobsPerHour: 60,
  })
  expect(created.ok, created.error).toBe(true)
  const instance = created.instance as Instance
  const moved = registry.update(instance.id, { dir: lanDir })
  expect(moved.ok).toBe(true)
  return instance
}

describe('局域网实例的创建与部署', () => {
  it('缺 IP 或共享目录直接拒绝，并给出可操作的机器码', () => {
    const noHost = registry.create({ appId: 'superlanguage', name: 'x', mode: 'lan', dir: lanDir, maxInstances: 2 })
    expect(noHost.ok).toBe(false)
    expect(noHost.code).toBe('BAD_HOST')
    const noDir = registry.create({
      appId: 'superlanguage', name: 'x', mode: 'lan', host: '192.168.1.20', dir: 'D:\\x', maxInstances: 2,
    })
    expect(noDir.ok).toBe(false)
    expect(noDir.code).toBe('BAD_DIR')
  })

  it('部署写 broker=push 与 api-listen=lan（跨机没有命名管道可达）', () => {
    const instance = lanInstance()
    const deployed = host.deploy(instance.id, { source: sourceExe }) as {
      ok: boolean, error?: string, launcher?: boolean, launcherError?: string
    }
    expect(deployed.ok, deployed.error).toBe(true)
    const ini = readFileSync(join(lanDir, 'instance.ini'), 'utf8')
    expect(ini).toContain('broker=push')
    expect(readFileSync(join(lanDir, 'api-listen.txt'), 'utf8').trim()).toBe('lan')
    expect(existsSync(join(lanDir, 'api-token.txt'))).toBe(true)
    // 用户明确要求：点部署就把启动器一起送过去，目标机上不用再回仓库找文件。
    expect(deployed.launcher, deployed.launcherError).toBe(true)
    expect(existsSync(join(lanDir, 'superlanguage-launch-watch.cmd'))).toBe(true)
  })

  it('启动器源文件缺失时部署仍成功，但把原因如实回报', () => {
    const instance = lanInstance()
    // 显式把启动器源指到不存在的路径：模拟「只读了 exe、没有启动器」的包。
    const isolated = createAppHost({
      stateDir,
      registry,
      brokerPipe: '\\\\.\\pipe\\supertime-app-v1-test',
      isPackaged: false,
      repoRoot: join(stateDir, 'no-scripts'),
      launcherPath: join(stateDir, 'no-scripts', 'nope.cmd'),
      fetchTimeoutMs: 2000,
      startTimeoutMs: 600,
      spawnFn: () => { throw new Error('不应 spawn') },
    }) as unknown as Host
    const deployed = isolated.deploy(instance.id, { source: sourceExe }) as {
      ok: boolean, launcher?: boolean, launcherError?: string
    }
    expect(deployed.ok).toBe(true)
    expect(deployed.launcher).toBe(false)
    expect(String(deployed.launcherError ?? '')).toContain('启动器')
  })
})

describe('局域网实例的启动与票据推送', () => {
  it('实例没起来时：写启动请求 → 探到端口 → 推送票据（不 spawn 本机进程）', async () => {
    const instance = lanInstance()
    const deployed = host.deploy(instance.id, { source: sourceExe })
    expect(deployed.ok, deployed.error).toBe(true)
    writeFileSync(join(lanDir, 'api-port.txt'), String(PORT), 'utf8')
    // 目标机器上的启动器看到请求文件才会把 exe 拉起来：这里用「文件出现即视为已启动」模拟。
    const state = { up: false }
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      REQUESTS.push({ url: String(url), body: String(init?.body ?? '') })
      if (String(url).includes('/api/health') || String(url).includes('/api/status')) {
        if (!state.up) {
          if (!existsSync(join(lanDir, '.start-request'))) throw new Error('ECONNREFUSED')
          state.up = true
        }
        const body = String(url).includes('/api/status')
          ? { queue: { queued: 0, running: 0 } }
          : { ok: true, version: '1.0.0', license: { state: 'blocked' } }
        return new Response(JSON.stringify(body), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, version: '1.0.0', license: { state: 'ok' } }), { status: 200 })
    })

    const started = await host.start(instance.id)
    expect(started.ok, started.error).toBe(true)
    expect(started.remote, '跨机启动要明确标成 remote').toBe(true)
    expect(existsSync(join(lanDir, '.start-request')), '必须给目标机器留启动请求').toBe(true)

    const lease = REQUESTS.find((item) => item.url.includes('/api/license/lease'))
    expect(lease, '必须把票据推给远端实例').toBeTruthy()
    // 地址必须是「目标电脑的 IP」，不是 127.0.0.1。
    expect(lease!.url).toContain('192.168.1.20:' + String(PORT))
    expect(JSON.parse(lease!.body)).toMatchObject({ claim: 'aa', mac: 'bb' })
  })

  it('票据签发被拒时把原因落到 lastError，而不是静默', async () => {
    const instance = lanInstance()
    host.deploy(instance.id, { source: sourceExe })
    writeFileSync(join(lanDir, 'api-port.txt'), String(PORT), 'utf8')
    host = createAppHost({
      stateDir,
      registry,
      brokerPipe: '\\\\.\\pipe\\supertime-app-v1-test',
      isPackaged: false,
      repoRoot: stateDir,
      fetchTimeoutMs: 2000,
      startTimeoutMs: 600,
      ticketPushIntervalMs: 60_000,
      spawnFn: () => { throw new Error('不应 spawn') },
      issueTicket: () => ({ ok: false, error: '许可证已过期', code: 'EXPIRED' }),
    })
    vi.stubGlobal('fetch', async (url: string) => {
      const body = String(url).includes('/api/status')
        ? { queue: { queued: 0, running: 0 } }
        : { ok: true, version: '1.0.0', license: { state: 'blocked' } }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const started = await host.start(instance.id)
    expect(started.ok).toBe(true)
    const row = registry.get(instance.id) as unknown as { lastError: string }
    expect(row.lastError).toContain('票据签发被拒绝')
    expect(row.lastError).toContain('许可证已过期')
  })

  it('没有共享目录可写时，启动请求失败并给出明确原因', async () => {
    const instance = lanInstance()
    host.deploy(instance.id, { source: sourceExe })
    // 把目录指向一个不存在的路径（模拟共享掉线）。
    registry.update(instance.id, { dir: join(stateDir, 'gone', 'inst-a') })
    const started = await host.start(instance.id)
    expect(started.ok).toBe(false)
    expect(started.error).toBeTruthy()
    await host.dispose()
  })
})
