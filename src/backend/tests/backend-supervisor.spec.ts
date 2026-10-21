/**
 * 后端监管器的行为判据。
 *
 * 原先这些分支住在 main.js 的组合根里，只有真实 Electron 才能观察；抽出后可以用
 * 假 utilityProcess / 假 RPC 句柄确定性覆盖：首启成功、init 失败退避、陈旧 exit 忽略、
 * 重启恢复、退出停止、调用等待就绪。
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { createBackendSupervisor } from '../backend-supervisor.js'

type Boot = { info: { root: string }; methods: string[] }
type ChannelOptions = { onExit: (code: number) => void; onEvent: (name: string, args: unknown[]) => void }
type Handle = {
  init: ReturnType<typeof vi.fn<(arg?: unknown) => Promise<Boot>>>
  call: ReturnType<typeof vi.fn<(method?: unknown, args?: unknown) => Promise<unknown>>>
  dispose: ReturnType<typeof vi.fn<() => void>>
  stats: ReturnType<typeof vi.fn<() => { pending: number }>>
}

function makeHarness(options: {
  initResults?: Array<Boot | Error>
  settings?: Record<string, unknown>
  secrets?: Record<string, unknown>
  restartBackoffMs?: number[]
  env?: Record<string, string>
  isPackaged?: boolean
} = {}) {
  const settings = options.settings ?? {}
  const secrets = options.secrets ?? {}
  const restartBackoffMs = options.restartBackoffMs ?? [1, 1, 1]
  const initResults = options.initResults ?? [{ info: { root: 'D:\\data' }, methods: ['getSessions'] }]
  let initIndex = 0
  const handles: Array<{ handle: Handle; channel: ChannelOptions; child: object }> = []
  const events: Array<[string, unknown[]]> = []
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const applyConfig = vi.fn()
  const recordResolved = vi.fn()
  const restrictWechatState = vi.fn(() => ({ ok: true, failures: [] }))
  const loadWechatSettings = vi.fn(() => ({ ...settings }))
  const mirroredSecretValues = vi.fn(() => ({ ...secrets }))
  const fork = vi.fn(() => ({ stdout: null, stderr: null }))
  const createWorkerChannel = vi.fn((child: object, channel: ChannelOptions) => {
    const result = initResults[initIndex]
    initIndex += 1
    const handle: Handle = {
      init: vi.fn(async () => {
        if (result instanceof Error) throw result
        return result
      }),
      call: vi.fn(async () => ({ ok: true, value: { ok: true } })),
      dispose: vi.fn(),
      stats: vi.fn(() => ({ pending: 0 })),
    }
    handles.push({ handle, channel, child })
    return handle
  })

  const supervisor = createBackendSupervisor({
    isPackaged: options.isPackaged ?? false,
    env: options.env ?? {},
    utilityProcess: { fork },
    diagLog: { write: vi.fn() },
    resolveHangMethods: vi.fn(() => []),
    DEBUG_HANG_ENV: 'SUPERTIME_DEBUG_HANG_METHODS',
    createWorkerChannel,
    onEvent: (name: string, args: unknown[]) => { events.push([name, args]) },
    loadWechatSettings,
    mirroredSecretValues,
    restrictWechatState,
    stateDir: 'D:\\state',
    fs: {
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => '{}'),
    },
    path: {
      join: (...parts: string[]) => parts.join('\\'),
      dirname: (...parts: string[]) => parts.join('\\'),
    },
    applyConfig,
    recordResolved,
    log,
    restartBackoffMs,
    setTimeoutFn: (fn: () => void) => {
      queueMicrotask(fn)
      return { unref: () => {} }
    },
    clearTimeoutFn: vi.fn(),
    setIntervalFn: (fn: () => void) => ({ unref: () => {} }) as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: vi.fn(),
  })

  return {
    supervisor,
    handles,
    events,
    log,
    applyConfig,
    recordResolved,
    restrictWechatState,
    loadWechatSettings,
    mirroredSecretValues,
    fork,
    createWorkerChannel,
  }
}

describe('backend-supervisor', () => {
  it('首启成功：先应用路径配置，再 init、回灌设置、收紧 ACL 并广播 ready', async () => {
    const h = makeHarness({
      settings: { db_dir: 'D:\\wx' },
      secrets: { image_aes_key: '0123456789abcdef' },
    })
    const result = await h.supervisor.bootstrap('D:\\userData')

    expect(result.ok).toBe(true)
    expect(h.applyConfig).toHaveBeenCalledTimes(1)
    expect(h.fork).toHaveBeenCalledTimes(1)
    expect(h.recordResolved).toHaveBeenCalledWith({ root: 'D:\\data' })
    expect(h.handles[0]!.handle.call).toHaveBeenCalledWith('saveWechatConfig', [{
      patch: { db_dir: 'D:\\wx', image_aes_key: '0123456789abcdef' },
    }])
    expect(h.restrictWechatState).toHaveBeenCalledWith({ stateDir: 'D:\\state', dataRoot: 'D:\\data' })
    expect(h.supervisor.status).toEqual({ state: 'ready', restarts: 0, lastError: null })
    expect(h.events.map(([name]) => name)).toContain('wechat-backend/status')
  })

  it('未打包 + `SUPERTIME_BACKEND_INSPECT=1` ⇒ worker 带 `--inspect`（只绑 127.0.0.1，供 heap 归因）', async () => {
    const h = makeHarness({ env: { SUPERTIME_BACKEND_INSPECT: '1', SUPERTIME_BACKEND_INSPECT_PORT: '9333' } })
    await h.supervisor.bootstrap('D:\\userData')
    const calls = h.fork.mock.calls as unknown as Array<unknown[]>
    const opts = calls[0]![2] as { execArgv?: string[] }
    expect(opts.execArgv).toEqual(['--inspect=127.0.0.1:9333'])
  })

  it('打包态即使设了 inspect env 也不给 worker 开调试端口（发行版不能带）', async () => {
    const h = makeHarness({ isPackaged: true, env: { SUPERTIME_BACKEND_INSPECT: '1' } })
    await h.supervisor.bootstrap('D:\\userData')
    const calls = h.fork.mock.calls as unknown as Array<unknown[]>
    const opts = calls[0]![2] as { execArgv?: string[] }
    expect(opts.execArgv).toBeUndefined()
  })

  it('init 失败会 dispose 当前句柄并进入有界退避；下一次 init 成功后恢复', async () => {
    const h = makeHarness({
      initResults: [
        new Error('first init failed'),
        { info: { root: 'D:\\data' }, methods: ['getSessions'] },
      ],
    })
    const result = await h.supervisor.bootstrap('D:\\userData')
    expect(result.ok).toBe(false)
    expect(h.handles[0]!.handle.dispose).toHaveBeenCalledTimes(1)
    // init 失败的收尾同样按握手 dispose（worker 可能已经起来了，注入要还原）
    expect(h.handles[0]!.handle.dispose).toHaveBeenCalledWith(expect.any(Function))
    expect(h.supervisor.status.state).toBe('restarting')

    await vi.waitFor(() => {
      expect(h.supervisor.status.state).toBe('ready')
    })
    expect(h.fork).toHaveBeenCalledTimes(2)
    // 历史语义：首启 init 失败不会回写路径；重启恢复也只回灌设置并收紧 ACL。
    expect(h.recordResolved).toHaveBeenCalledTimes(0)
    expect(h.supervisor.status.restarts).toBe(0)
  })

  it('连续 init 失败达到上限后进入 failed，不再无限重启', async () => {
    const h = makeHarness({
      initResults: [new Error('a'), new Error('b'), new Error('c'), new Error('d')],
    })
    const result = await h.supervisor.bootstrap('D:\\userData')
    expect(result.ok).toBe(false)

    await vi.waitFor(() => {
      expect(h.supervisor.status.state).toBe('failed')
    })
    // 首启一次 + 三次退避重启；第四次不该再拉起。
    expect(h.fork).toHaveBeenCalledTimes(4)
    expect(h.supervisor.status.lastError).toContain('连续 3 次重启失败')
  })

  it('陈旧句柄的迟到 exit 不会动健康的新句柄；当前句柄 exit 才安排重启', async () => {
    const h = makeHarness({
      initResults: [
        { info: { root: 'D:\\old' }, methods: ['getSessions'] },
        { info: { root: 'D:\\new' }, methods: ['getSessions'] },
        { info: { root: 'D:\\replacement' }, methods: ['getSessions'] },
      ],
    })
    await h.supervisor._test.start('D:\\userData')
    h.supervisor._test.setStatus('ready')
    const oldExit = h.handles[0]!.channel.onExit
    await h.supervisor._test.start('D:\\userData')
    const currentExit = h.handles[1]!.channel.onExit

    oldExit(1)
    expect(h.supervisor.backend).toBe(h.handles[1]!.handle)
    expect(h.supervisor.status.state).toBe('ready')

    currentExit(1)
    expect(h.supervisor.backend).toBeNull()
    expect(h.supervisor.status.state).toBe('restarting')
    await vi.waitFor(() => {
      expect(h.supervisor.status.state).toBe('ready')
    })
    expect(h.supervisor.backend).toBe(h.handles[2]!.handle)
  })

  it('stop 清掉待执行重启并 dispose 当前句柄，之后退出事件被忽略', async () => {
    const h = makeHarness({
      initResults: [
        new Error('init failed'),
        { info: { root: 'D:\\data' }, methods: ['getSessions'] },
      ],
    })
    await h.supervisor.bootstrap('D:\\userData')
    await vi.waitFor(() => {
      expect(h.supervisor.status.state).toBe('ready')
    })
    const currentExit = h.handles[1]!.channel.onExit

    h.supervisor.stop()
    expect(h.handles[1]!.handle.dispose).toHaveBeenCalledTimes(1)
    // dispose 是握手：必须带回调，等 worker 收尾（还原注入/清 marker）完成才 kill。
    // 「发完就 kill」会让 worker 的 case 'dispose' 与 exit 兜底都来不及跑。
    expect(h.handles[1]!.handle.dispose).toHaveBeenCalledWith(expect.any(Function))
    expect(h.supervisor.backend).toBeNull()
    expect(h.supervisor.isStopping).toBe(true)

    currentExit(1)
    expect(h.supervisor.status.state).toBe('ready')
    expect(h.fork).toHaveBeenCalledTimes(2)
  })

  it('waitUntilReady 只认 ready+有效句柄，failed/stopping 立即返回 false', async () => {
    const h = makeHarness({
      initResults: [{ info: { root: 'D:\\data' }, methods: ['getSessions'] }],
    })
    h.supervisor._test.setStatus('failed', 'before start')
    expect(await h.supervisor.waitUntilReady(5)).toBe(false)

    await h.supervisor._test.start('D:\\userData')
    h.supervisor._test.setStatus('ready')
    expect(await h.supervisor.waitUntilReady(5)).toBe(true)

    h.supervisor._test.setStatus('failed', 'gone')
    expect(await h.supervisor.waitUntilReady(5)).toBe(false)
  })
})
