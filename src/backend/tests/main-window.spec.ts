/**
 * Main-window event delivery boundary.
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const require = createRequire(import.meta.url)
const { broadcastToWindows } = require(join(HERE, '..', 'main-window.js'))

function windowStub(destroyed = false) {
  const send = vi.fn()
  return { win: { isDestroyed: () => destroyed, webContents: { send } }, send }
}

describe('main-window 事件广播只到可信主窗口', () => {
  it('合法主窗口收到事件', () => {
    const { win, send } = windowStub()
    broadcastToWindows({ getMainWindow: () => win }, 'wechat:event', { name: 'x', args: [] })
    expect(send).toHaveBeenCalledWith('wechat:event', { name: 'x', args: [] })
  })

  it('窗口不存在或已销毁时直接丢弃，不尝试向所有窗口兜底', () => {
    const destroyed = windowStub(true)
    broadcastToWindows({ getMainWindow: () => destroyed.win }, 'update:event', { state: 'ready' })
    expect(destroyed.send).not.toHaveBeenCalled()

    const missing = windowStub()
    broadcastToWindows({ getMainWindow: () => null }, 'wechat:event', { name: 'x', args: [] })
    expect(missing.send).not.toHaveBeenCalled()
  })

  it('send 抛异常时被吞掉，广播链路不炸', () => {
    const { win } = windowStub()
    win.webContents.send = vi.fn(() => { throw new Error('destroyed') })
    expect(() => broadcastToWindows({ getMainWindow: () => win }, 'wechat:event', {})).not.toThrow()
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
