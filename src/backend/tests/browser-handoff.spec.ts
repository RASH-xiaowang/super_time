// @vitest-environment node
/**
 * 浏览器交接的接线守卫（2026-10-19）。
 *
 * 只测主进程控制面（不启动 Electron、不打开真实浏览器）：
 *   · 远程服务没开 → rotate（写配置 + 停/对齐 + 配对码）→ 用**实际地址与端口**拼 URL；
 *   · 已经开着 → 只签发一个新配对码，不重复轮换令牌；
 *   · 打开浏览器失败 → 桌面端不许隐藏（失败方向：用户还看得见窗口）；
 *   · 点卡片返回 → 先停服务（浏览器会话作废）再显示主窗口；
 *   · 卡片窗口的形态：右下角、无边框、置顶、可拖动。
 */
import { describe, expect, it } from 'vitest'
import { CARD_HEIGHT, CARD_MARGIN, CARD_WIDTH, cardHtml, createBrowserHandoff } from '../browser-handoff.js'
import type { BrowserHandoff } from '../browser-handoff.js'

/** 一个最小的 BrowserWindow 假件：只记录被调用的方法与构造参数。 */
class FakeWindow {
  static all: FakeWindow[] = []
  opts: Record<string, any>
  shown = false
  destroyed = false
  alwaysOnTop: { value: boolean, level?: string } | null = null
  visibleAllWorkspaces = false
  handlers: Record<string, (...args: any[]) => void> = {}
  ready: (() => void) | null = null
  url = ''
  webContents: { id: number }

  constructor(opts: Record<string, any>) {
    this.opts = opts
    this.webContents = { id: FakeWindow.all.length + 1 }
    FakeWindow.all.push(this)
  }

  setAlwaysOnTop(value: boolean, level?: string): void { this.alwaysOnTop = { value, level }; }
  setVisibleOnAllWorkspaces(value: boolean): void { this.visibleAllWorkspaces = value; }
  on(event: string, cb: (...args: any[]) => void): void { this.handlers[event] = cb; }
  once(_event: string, cb: () => void): void { this.ready = cb; }
  loadURL(url: string): Promise<void> {
    this.url = url
    if (this.ready) this.ready()
    return Promise.resolve()
  }
  showInactive(): void { this.shown = true; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
}

/** 主窗口假件。 */
function fakeMainWindow() {
  const state = { hidden: 0, shown: 0, focused: 0, restored: 0 }
  const win = {
    webContents: { id: 0 },
    isDestroyed: () => false,
    isMinimized: () => false,
    hide: () => { state.hidden += 1; },
    show: () => { state.shown += 1; },
    focus: () => { state.focused += 1; },
    restore: () => { state.restored += 1; },
  }
  return { win, state };
}

/** 远程服务假件：syncWithConfig 时变成「在监听」。 */
interface RemoteState {
  running: boolean
  hasToken: boolean
  address: string
  port: number
  addresses: string[]
  enabled?: boolean
}

function fakeRemote(initial: Partial<RemoteState> = {}) {
  const state: RemoteState = {
    running: false, hasToken: false, address: '', port: 0, addresses: [], ...initial,
  }
  const calls = { stopped: 0, issued: 0, synced: 0 }
  return {
    state,
    calls,
    getState: (): RemoteState => ({ ...state }),
    issuePairingCode: (): string => { calls.issued += 1; return `PAIR-${String(calls.issued)}` },
    syncWithConfig: async (): Promise<RemoteState> => {
      calls.synced += 1
      if (state.enabled !== false) {
        state.running = true
        state.hasToken = true
        state.address = state.address || '192.168.1.5'
        state.port = state.port || 5032
        state.addresses = state.addresses.length > 0 ? state.addresses : [state.address]
      }
      return { ...state }
    },
    stop: async (): Promise<RemoteState> => { calls.stopped += 1; state.running = false; return { ...state } },
  }
}

/** 组装一份控制面。 */
function harness(options: { remote?: ReturnType<typeof fakeRemote>, openThrows?: boolean } = {}) {
  FakeWindow.all = []
  const ipcHandlers = new Map<string, (...args: any[]) => any>()
  const ipcListeners = new Map<string, (...args: any[]) => void>()
  const backendCalls: Array<{ method: string, args: any[] }> = []
  const opened: string[] = []
  const main = fakeMainWindow()
  const remote = options.remote || fakeRemote()
  const api = {
    open: null as BrowserHandoff | null,
    openExternal: async (url: string): Promise<void> => {
      opened.push(url)
      if (options.openThrows === true) throw new Error('no default browser')
    },
    backendCall: async (method: string, args: any[]): Promise<unknown> => {
      backendCalls.push({ method, args })
      return { ok: true, value: { ok: true } }
    },
  }
  api.open = createBrowserHandoff({
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => any) => { ipcHandlers.set(channel, handler); },
      on: (channel: string, handler: (...args: any[]) => void) => { ipcListeners.set(channel, handler); },
    },
    ipcTrust: { wrap: (_channel: string, handler: (...args: any[]) => any) => handler },
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    nativeTheme: { shouldUseDarkColors: true },
    rootDir: 'D:/app',
    remoteAccess: remote,
    backendCall: api.backendCall,
    openExternal: api.openExternal,
    getMainWindow: () => main.win,
  })
  return { handoff: api.open, main, remote, backendCalls, opened, ipcHandlers, ipcListeners, FakeWindow }
}

describe('浏览器交接：打开默认浏览器', () => {
  it('远程服务没开：轮换凭据、按实际地址拼 URL、隐藏桌面并弹右下角卡片', async () => {
    const h = harness()
    const r = await h.handoff.open()
    expect(r.ok).toBe(true)
    expect(h.opened).toHaveLength(1)
    expect(h.opened[0]).toBe('http://192.168.1.5:5032/?t=PAIR-1&mode=desktop')
    expect(h.main.state.hidden).toBe(1)
    expect(h.FakeWindow.all).toHaveLength(1)
    const card = h.FakeWindow.all[0]!
    expect(card.opts.width).toBe(CARD_WIDTH)
    expect(card.opts.height).toBe(CARD_HEIGHT)
    expect(card.opts.frame).toBe(false)
    expect(card.opts.alwaysOnTop).toBe(true)
    expect(card.opts.skipTaskbar).toBe(true)
    expect(card.opts.x).toBe(1920 - CARD_WIDTH - CARD_MARGIN)
    expect(card.opts.y).toBe(1040 - CARD_HEIGHT - CARD_MARGIN)
    expect(card.alwaysOnTop).toEqual({ value: true, level: 'screen-saver' })
    expect(card.visibleAllWorkspaces).toBe(true)
    expect(card.shown).toBe(true)
    // 卡片页面：可拖动区 + 返回按钮（不加载任何业务界面）
    const html = decodeURIComponent(card.url.replace('data:text/html;charset=UTF-8,', ''))
    expect(html).toContain('-webkit-app-region:drag')
    expect(html).toContain('点击返回桌面应用')
    expect(html).toContain('window.handoff.restore()')
    expect(html).not.toContain('electronAPI')
    expect(h.handoff.state()).toEqual({ active: true })
  })

  it('远程服务已经开着：只签发新配对码，不重复轮换令牌', async () => {
    const remote = fakeRemote({ running: true, hasToken: true, address: '10.0.0.9', port: 6100 })
    const h = harness({ remote })
    const r = await h.handoff.open()
    expect(r.ok).toBe(true)
    expect(h.opened[0]).toBe('http://10.0.0.9:6100/?t=PAIR-1&mode=desktop')
    expect(remote.calls.issued).toBe(1)
    expect(h.backendCalls.filter((c) => c.method === 'saveWechatConfig')).toHaveLength(0)
  })

  it('打开浏览器失败：桌面端不许隐藏，并回滚本次启动的服务', async () => {
    const h = harness({ openThrows: true })
    const r = await h.handoff.open()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('打开默认浏览器失败')
    expect(h.main.state.hidden).toBe(0)
    expect(h.FakeWindow.all).toHaveLength(0)
    // rotate 时开的服务要关回去（否则端口白暴露）
    const saved = h.backendCalls.filter((c) => c.method === 'saveWechatConfig')
    expect(saved.some((c) => c.args?.[0]?.patch?.api_enabled === false)).toBe(true)
    expect(h.remote.calls.stopped).toBeGreaterThanOrEqual(1)
  })
})

describe('浏览器交接：点卡片返回桌面', () => {
  it('先停服务（作废浏览器会话）再显示主窗口；卡片销毁', async () => {
    const h = harness()
    await h.handoff.open()
    const card = h.FakeWindow.all[0]!
    const r = await h.handoff.restore()
    expect(r.ok).toBe(true)
    expect(card.destroyed).toBe(true)
    expect(h.main.state.shown).toBe(1)
    expect(h.main.state.focused).toBe(1)
    expect(h.handoff.state()).toEqual({ active: false })
    const saved = h.backendCalls.filter((c) => c.method === 'saveWechatConfig')
    expect(saved.some((c) => c.args?.[0]?.patch?.api_enabled === false)).toBe(true)
    expect(h.remote.calls.stopped).toBeGreaterThanOrEqual(1)
  })

  it('原本就开着的远程访问：收尾只作废会话并重启服务，不改用户的开关配置', async () => {
    const remote = fakeRemote({ running: true, hasToken: true, address: '10.0.0.9', port: 6100 })
    const h = harness({ remote })
    await h.handoff.open()
    await h.handoff.restore()
    expect(h.backendCalls.filter((c) => c.method === 'saveWechatConfig')).toHaveLength(0)
    expect(remote.calls.stopped).toBeGreaterThanOrEqual(1)
    expect(remote.calls.synced).toBeGreaterThanOrEqual(1)
  })

  it('卡片 IPC 只接受卡片自己的 webContents（别的窗口伪造一律忽略）', async () => {
    const h = harness()
    await h.handoff.open()
    const card = h.FakeWindow.all[0]!
    const listener = h.ipcListeners.get('browser-handoff:restore')!
    expect(typeof listener).toBe('function')
    // 伪造发送者：不应恢复
    listener({ sender: { id: 999 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.main.state.shown).toBe(0)
    // 真卡片：恢复
    listener({ sender: card.webContents })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.main.state.shown).toBe(1)
  })

  it('未在交接态时 restore 幂等：仍然把主窗口叫回来（点了要有反应）', async () => {
    const h = harness()
    const r = await h.handoff.restore()
    expect(r.ok).toBe(true)
    expect(h.main.state.shown).toBe(1)
  })
})

describe('卡片页面自身', () => {
  it('深浅两套颜色都生成，且只有返回按钮一个可点动作', () => {
    for (const dark of [true, false]) {
      const html = cardHtml(dark)
      expect(html).toContain('点击返回桌面应用')
      expect(html).toContain('可拖动卡片')
      expect(html).toContain('window.handoff.restore()')
      expect(html).not.toContain('electronAPI')
    }
  })
})
