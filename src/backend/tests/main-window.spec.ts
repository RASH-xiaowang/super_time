/**
 * Main-window event delivery boundary.
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const require = createRequire(import.meta.url)
const { broadcastToWindows, createMainWindow } = require(join(HERE, '..', 'main-window.js'))

interface WindowStubOptions {
  destroyed?: boolean
  contentsDestroyed?: boolean
  crashed?: boolean
  frameDestroyed?: boolean
  mainFrameThrows?: boolean
}

function windowStub(options: WindowStubOptions = {}) {
  const {
    destroyed = false,
    contentsDestroyed = false,
    crashed = false,
    frameDestroyed = false,
    mainFrameThrows = false
  } = options
  const send = vi.fn()
  const frame = {
    isDestroyed: () => frameDestroyed
  }
  const mainFrame = mainFrameThrows
    ? {
        get: () => {
          throw new Error('Render frame was disposed')
        }
      }
    : { value: frame }
  const contents = {
    send,
    isDestroyed: () => contentsDestroyed,
    isCrashed: () => crashed
  }
  Object.defineProperty(contents, 'mainFrame', mainFrame)
  return { win: { isDestroyed: () => destroyed, webContents: contents }, send }
}

describe('main-window 事件广播只到可信主窗口', () => {
  it('合法主窗口收到事件', () => {
    const { win, send } = windowStub()
    broadcastToWindows({ getMainWindow: () => win }, 'wechat:event', { name: 'x', args: [] })
    expect(send).toHaveBeenCalledWith('wechat:event', { name: 'x', args: [] })
  })

  it('窗口不存在或已销毁时直接丢弃，不尝试向所有窗口兜底', () => {
    const destroyed = windowStub({ destroyed: true })
    broadcastToWindows({ getMainWindow: () => destroyed.win }, 'update:event', { state: 'ready' })
    expect(destroyed.send).not.toHaveBeenCalled()

    const missing = windowStub()
    broadcastToWindows({ getMainWindow: () => null }, 'wechat:event', { name: 'x', args: [] })
    expect(missing.send).not.toHaveBeenCalled()
  })

  it('webContents、主帧已销毁或渲染进程已崩溃时不发送', () => {
    for (const options of [
      { contentsDestroyed: true },
      { crashed: true },
      { frameDestroyed: true },
      { mainFrameThrows: true }
    ]) {
      const stub = windowStub(options)
      expect(() =>
        broadcastToWindows({ getMainWindow: () => stub.win }, 'wechat:event', { name: 'x', args: [] })
      ).not.toThrow()
      expect(stub.send, JSON.stringify(options)).not.toHaveBeenCalled()
    }
  })

  it('send 抛异常时被吞掉，广播链路不炸', () => {
    const { win } = windowStub()
    win.webContents.send = vi.fn(() => { throw new Error('destroyed') })
    expect(() => broadcastToWindows({ getMainWindow: () => win }, 'wechat:event', {})).not.toThrow()
  })
})

describe('main-window 渲染进程崩溃恢复', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function mainWindowFixture(env: Record<string, string> = {}) {
    type WebContentsStub = EventEmitter & {
      send: ReturnType<typeof vi.fn>
      reload: ReturnType<typeof vi.fn>
      isDestroyed: () => boolean
      isCrashed: () => boolean
      mainFrame: { isDestroyed: () => boolean }
    }
    let created: BrowserWindowStub | null = null
    class BrowserWindowStub extends EventEmitter {
      options: unknown
      destroyed: boolean
      loadFile: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
      webContents: WebContentsStub

      constructor(options: unknown) {
        super()
        this.options = options
        this.destroyed = false
        this.loadFile = vi.fn()
        this.show = vi.fn()
        const webContents = new EventEmitter() as WebContentsStub
        webContents.send = vi.fn()
        webContents.reload = vi.fn()
        webContents.isDestroyed = () => false
        webContents.isCrashed = () => false
        webContents.mainFrame = { isDestroyed: () => false }
        this.webContents = webContents
        created = this
      }

      isDestroyed(): boolean {
        return this.destroyed
      }
    }
    const ctx = {
      app: { isPackaged: true },
      BrowserWindow: BrowserWindowStub,
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
      fs: { existsSync: () => false },
      path: {
        join: (...parts: string[]) => parts.join('/')
      },
      rootDir: ROOT,
      env,
      entryHtml: join(ROOT, 'src', 'index.html')
    }
    const win = createMainWindow(ctx)
    expect(win).toBe(created)
    return win
  }

  it('oom/crashed 会延迟 reload，延迟期内重复事件不会叠加', () => {
    vi.useFakeTimers()
    const win = mainWindowFixture()

    win.webContents.emit('render-process-gone', {}, { reason: 'oom' })
    win.webContents.emit('render-process-gone', {}, { reason: 'oom' })
    expect(win.webContents.reload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1499)
    expect(win.webContents.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    vi.runAllTimers()
    expect(win.webContents.reload).toHaveBeenCalledTimes(2)

    win.webContents.emit('render-process-gone', {}, { reason: 'oom' })
    vi.runAllTimers()
    expect(win.webContents.reload).toHaveBeenCalledTimes(2)
  })

  it('不可恢复原因不触发 reload', () => {
    vi.useFakeTimers()
    const win = mainWindowFixture()
    win.webContents.emit('render-process-gone', {}, { reason: 'killed' })
    vi.runAllTimers()
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it('窗口关闭或 webContents 销毁时清理待执行的 reload 计时器', () => {
    vi.useFakeTimers()
    const win = mainWindowFixture()

    win.webContents.emit('render-process-gone', {}, { reason: 'oom' })
    win.webContents.emit('destroyed')
    vi.runAllTimers()
    expect(win.webContents.reload).not.toHaveBeenCalled()

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    win.emit('closed')
    vi.runAllTimers()
    expect(win.webContents.reload).not.toHaveBeenCalled()
  })

  it('ELD 诊断计时器与 render-process-gone 监听跟随窗口生命周期清理', () => {
    vi.useFakeTimers()
    const first = mainWindowFixture({ SUPERTIME_ELD: '1' })
    expect(vi.getTimerCount()).toBe(1)
    expect(first.webContents.listenerCount('render-process-gone')).toBe(1)

    first.emit('closed')
    expect(vi.getTimerCount()).toBe(0)
    expect(first.webContents.listenerCount('render-process-gone')).toBe(0)

    const second = mainWindowFixture({ SUPERTIME_ELD: '1' })
    expect(vi.getTimerCount()).toBe(1)
    second.webContents.emit('destroyed')
    expect(vi.getTimerCount()).toBe(0)
    expect(second.webContents.listenerCount('render-process-gone')).toBe(0)
  })
})

describe('入口路径单一来源：IPC 信任与 loadFile 不能各自解析', () => {
  it('main.js 只解析一次入口并同时传给信任守卫与窗口上下文', () => {
    const main = readFileSync(join(ROOT, 'main.js'), 'utf8')
    expect(main).toContain('const appEntryHtml = uiEntryHtml(windowCtx)')
    expect(main).toContain('windowCtx.entryHtml = appEntryHtml')
    expect(main).toContain('entryUrl: pathToFileURL(appEntryHtml).href')
  })

  it('createMainWindow 优先使用同一个预解析入口，不再重新判断构建产物存在性', () => {
    const source = readFileSync(join(ROOT, 'src', 'backend', 'main-window.js'), 'utf8')
    expect(source).toContain('const entryHtml = ctx.entryHtml || uiEntryHtml(ctx)')
    expect(source).toContain('win.loadFile(entryHtml, loadQuery)')
  })
})

describe('主窗口引用生命周期', () => {
  it('main.js 在 closed 后只清空仍指向该窗口的 mainWindow，避免旧窗口被根引用留住', () => {
    const main = readFileSync(join(ROOT, 'main.js'), 'utf8')
    expect(main).toContain("win.once('closed'")
    expect(main).toContain('if (mainWindow === win) mainWindow = null')
  })
})
