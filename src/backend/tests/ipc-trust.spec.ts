/**
 * IPC sender trust boundary.
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { canonicalFileUrl, createIpcTrust, fileUrlFor } = require(join(HERE, '..', 'ipc-trust.js'))

const ENTRY = fileUrlFor(join(HERE, '..', '..', 'client', 'ui-dist', 'index.html'))

function fakeContents(url: string, mainFrame = true) {
  const frame = { url, isMainFrame: mainFrame }
  const contents = {
    id: 1,
    mainFrame: mainFrame ? frame : { url, isMainFrame: true },
    isDestroyed: () => false,
  }
  return { contents, frame }
}

function eventFor(url: string, overrides: Record<string, unknown> = {}) {
  const { contents, frame } = fakeContents(url)
  return {
    sender: contents,
    senderFrame: frame,
    ...overrides,
  }
}

function makeGuard(entryUrl = ENTRY, windowUrl = entryUrl) {
  const { contents } = fakeContents(windowUrl)
  const win = { webContents: contents }
  const logger = { warn: vi.fn() }
  const guard = createIpcTrust({
    getMainWindow: () => win,
    entryUrl,
    logger,
  })
  return {
    guard,
    win,
    logger,
    trustedEvent: (url = windowUrl, overrides: Record<string, unknown> = {}) => {
      const frame = contents.mainFrame as { url: string; isMainFrame: boolean }
      frame.url = url
      return {
        sender: contents,
        senderFrame: frame,
        ...overrides,
      }
    },
  }
}

describe('ipc-trust 来源守卫', () => {
  it('file URL 规范化忽略 query/hash，并统一 Windows 大小写', () => {
    expect(canonicalFileUrl('file:///D:/App/index.html?skeleton=1#top'))
      .toBe('file:///d:/app/index.html')
    expect(canonicalFileUrl('https://example.com/index.html')).toBeNull()
    expect(canonicalFileUrl('')).toBeNull()
  })

  it('缺少主窗口或入口 URL 时拒绝构造（fail closed）', () => {
    expect(() => createIpcTrust({ getMainWindow: () => null, entryUrl: ENTRY }))
      .not.toThrow()
    expect(() => createIpcTrust({ getMainWindow: () => null, entryUrl: 'https://example.com' }))
      .toThrow(/file entryUrl/)
  })

  it('当前主窗口的主 frame + 应用入口 URL 才放行', () => {
    const { guard, trustedEvent } = makeGuard()
    const event = trustedEvent(ENTRY + '?skeleton=1')
    expect(guard.isTrusted(event)).toBe(true)
    expect(guard.wrap('wechat:info', () => 'ok')(event)).toBe('ok')
  })

  it('sender 不是当前主窗口的 webContents 时拒绝', () => {
    const { guard, logger } = makeGuard()
    const other = fakeContents(ENTRY)
    const result = guard.wrap('wechat:call', () => 'unreachable')({
      ...eventFor(ENTRY),
      sender: other.contents,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'IPC_SENDER_REJECTED' } })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sender-mismatch'))
  })

  it('子 frame 或非主 frame 一律拒绝', () => {
    const { guard } = makeGuard()
    const event = eventFor(ENTRY, { senderFrame: { url: ENTRY, isMainFrame: false } })
    expect(guard.wrap('wechat:info', () => 'unreachable')(event).ok).toBe(false)
  })

  it('frame URL 不是应用入口时拒绝，即使 sender 对象相同', () => {
    const { guard, trustedEvent } = makeGuard()
    const event = trustedEvent(fileUrlFor(join(HERE, 'attacker.html')))
    expect(guard.wrap('remote-access:rotate', () => 'unreachable')(event).ok).toBe(false)
  })

  it('ipcMain.on 的拒绝路径不执行 listener，也不抛异常', () => {
    const { guard, logger } = makeGuard()
    const listener = vi.fn()
    const wrapped = guard.wrapOn('window:close', listener)
    wrapped({ sender: {}, senderFrame: null })
    expect(listener).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('window:close'))
  })

  it('合法来源时把原参数透传给 handler', () => {
    const { guard, trustedEvent } = makeGuard()
    const handler = vi.fn((_event: unknown, method: string, args: unknown[]) => ({ method, args }))
    const event = trustedEvent(ENTRY)
    expect(guard.wrap('wechat:call', handler)(event, 'getSessions', [{ limit: 1 }]))
      .toEqual({ method: 'getSessions', args: [{ limit: 1 }] })
  })
})
