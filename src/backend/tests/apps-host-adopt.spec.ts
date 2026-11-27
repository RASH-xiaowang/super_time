/**
 * app-host 的「接手已运行实例」判据。
 *
 * 起因：用户点「启动」后界面显示「实例进程已退出（code=0）」，而实例其实一直在跑。
 * 根因有两层：
 *   ① SuperTime 重启后主进程手里没有子进程句柄，`status()` 只看 children 就报「已停止」；
 *   ② 再 spawn 一份副本会被单实例锁拒绝并立即退出（旧版回 0），于是只剩一句「已退出」。
 *
 * 这里钉住修复后的行为（不真的拉起进程）：
 *   · 健康但无子进程句柄 → `running: true` + `adopted: true`；
 *   · `start()` 在这种情况下**不调用 spawn**，直接接手；
 *   · `stop()` 对接手来的实例仍能真的停（走 /api/stop）。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const PORT = 50999
const TOKEN = 'f'.repeat(32)

interface Instance { id: string, name: string, seat: number }
interface Registry {
  create: (input: Record<string, unknown>) => { ok: boolean, instance: Instance }
  get: (id: string) => Instance | null
}
interface DeployResult { ok: boolean, dir?: string, error?: string }
interface HostStatus { ok: boolean, running?: boolean, adopted?: boolean, error?: string }
interface Host {
  deploy: (id: string, options?: { source?: string }) => DeployResult
  start: (id: string) => Promise<{ ok: boolean, adopted?: boolean, error?: string }>
  stop: (id: string) => Promise<{ ok: boolean, adopted?: boolean, already?: boolean }>
  status: (id: string) => Promise<HostStatus>
}

let stateDir = ''
let sourceExe = ''
let registry: Registry
let host: Host
let spawnCalls: string[]
let fetchCalls: string[]

/** 假 spawn：不真的拉起进程，只记录被调用过。 */
function fakeSpawn(): unknown {
  spawnCalls.push('spawn')
  const child = {
    exitCode: null as number | null,
    killed: false,
    once: () => child,
    kill: () => { child.killed = true },
  }
  return child
}

/**
 * 造一个「实例在跑」的 fetch：health 与 status 都成功。
 * `healthy` 由闭包持有，便于 stop 用例把它翻成 false。
 */
function stubFetch(state: { healthy: boolean }): void {
  vi.stubGlobal('fetch', async (url: string) => {
    fetchCalls.push(String(url))
    if (String(url).includes('/api/stop')) {
      state.healthy = false
      return new Response('{"ok":true}', { status: 200 })
    }
    if (!state.healthy) throw new Error('ECONNREFUSED')
    const body = String(url).includes('/api/status')
      ? { queue: { queued: 0, running: 0 }, wechat: { running: true, logged_in: true } }
      : { ok: true, service: 'supertime', version: '1.0.0', license: { state: 'ok' } }
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'supertime-host-adopt-'))
  registry = createAppRegistry({ stateDir, defaultCaps: CAPS, defaultMaxJobsPerHour: 60 })
  spawnCalls = []
  fetchCalls = []
  sourceExe = join(stateDir, 'source', 'SuperLanguage.exe')
  mkdirSync(dirname(sourceExe), { recursive: true })
  writeFileSync(sourceExe, 'fake-exe-bytes')
  host = createAppHost({
    stateDir,
    registry,
    brokerPipe: '\\\\.\\pipe\\supertime-app-v1-test',
    isPackaged: false,
    repoRoot: stateDir,
    fetchTimeoutMs: 2000,
    // 启动失败要等超时；测试压到 400ms，避免真等 25 秒。
    startTimeoutMs: 400,
    spawnFn: fakeSpawn,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(stateDir, { recursive: true, force: true })
})

/** 建实例 + 部署假 exe + 写好 port/token（模拟「实例已在跑」）。 */
function prepareInstance(): Instance {
  const created = registry.create({
    appId: 'superlanguage',
    name: '接手测试',
    maxInstances: 2,
    caps: CAPS,
    maxJobsPerHour: 60,
  })
  expect(created.ok).toBe(true)
  const instance = created.instance
  const deployed = host.deploy(instance.id, { source: sourceExe })
  expect(deployed.ok, deployed.error).toBe(true)
  const dir = deployed.dir as string
  writeFileSync(join(dir, 'api-port.txt'), String(PORT), 'utf8')
  writeFileSync(join(dir, 'api-token.txt'), TOKEN, 'utf8')
  return instance
}

describe('接手已在运行的实例', () => {
  it('没有子进程句柄但 API 健康时，status 报 running + adopted', async () => {
    stubFetch({ healthy: true })
    const instance = prepareInstance()
    const status = await host.status(instance.id)
    expect(status.running).toBe(true)
    expect(status.adopted, '必须标出这是「接手」而不是本进程拉起的').toBe(true)
    expect(status.error).toBe('')
  })

  it('start 在实例已健康时直接接手，不 spawn 第二个副本', async () => {
    stubFetch({ healthy: true })
    const instance = prepareInstance()
    const result = await host.start(instance.id)
    expect(result.ok).toBe(true)
    expect(result.adopted).toBe(true)
    expect(spawnCalls, '不能再拉起一份（会被单实例锁拒绝并秒退）').toEqual([])
  })

  it('实例不健康时才走 spawn，超时会给出可读原因', async () => {
    stubFetch({ healthy: false })
    const instance = prepareInstance()
    const result = await host.start(instance.id)
    expect(spawnCalls.length, '应当尝试拉起一次').toBe(1)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('超时')
  })

  it('stop 对接手来的实例仍然有效（走 /api/stop）', async () => {
    const state = { healthy: true }
    stubFetch(state)
    const instance = prepareInstance()
    expect((await host.status(instance.id)).running).toBe(true)
    const stopped = await host.stop(instance.id)
    expect(stopped.ok).toBe(true)
    expect(fetchCalls.some((url) => url.includes('/api/stop')), '必须真的发出停止请求').toBe(true)
    expect((await host.status(instance.id)).running).toBe(false)
  })
})
