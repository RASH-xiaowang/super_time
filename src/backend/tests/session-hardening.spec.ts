/**
 * Electron 默认会话的权限边界。
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { installSessionHardening } = require('../session-hardening.js') as {
  installSessionHardening: (
    ses: SessionStub,
    options?: { log?: (...args: unknown[]) => void, isTrustedContents?: (contents: unknown) => boolean },
  ) => void
}

interface SessionStub {
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDevicePermissionHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
}

function sessionStub(): SessionStub {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
  }
}

function handlers(ses: SessionStub) {
  return {
    request: ses.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
      details?: unknown,
    ) => void,
    check: ses.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      origin?: string,
      details?: unknown,
    ) => boolean,
  }
}

describe('默认会话权限默认拒绝', () => {
  it('只放行剪贴板写入与全屏，摄像头/麦克风/定位等一律拒绝', () => {
    const ses = sessionStub()
    installSessionHardening(ses)
    const { request, check } = handlers(ses)

    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      const callback = vi.fn()
      request({}, permission, callback)
      expect(callback, `${permission} 是现有 UI 需要的窄权限`).toHaveBeenCalledWith(true)
      expect(check({}, permission)).toBe(true)
    }

    for (const permission of [
      'media', 'camera', 'microphone', 'geolocation', 'notifications',
      'midi', 'midiSysex', 'hid', 'serial', 'usb', 'openExternal',
    ]) {
      const callback = vi.fn()
      request({}, permission, callback)
      expect(callback, `${permission} 必须默认拒绝`).toHaveBeenCalledWith(false)
      expect(check({}, permission), `${permission} 的同步检查也必须拒绝`).toBe(false)
    }
  })

  it('只信任主窗口内容；其它窗口即使申请安全权限也拒绝', () => {
    const ses = sessionStub()
    const mainContents = { id: 1 }
    installSessionHardening(ses, { isTrustedContents: (contents) => contents === mainContents })
    const { request, check } = handlers(ses)

    const untrusted = vi.fn()
    request({ id: 2 }, 'fullscreen', untrusted)
    expect(untrusted).toHaveBeenCalledWith(false)
    expect(check({ id: 2 }, 'clipboard-sanitized-write')).toBe(false)

    const trusted = vi.fn()
    request(mainContents, 'fullscreen', trusted)
    expect(trusted).toHaveBeenCalledWith(true)
    expect(check(mainContents, 'clipboard-sanitized-write')).toBe(true)
  })

  it('拒绝设备权限与屏幕采集，并记录拒绝原因但不记录业务数据', () => {
    const ses = sessionStub()
    const log = vi.fn()
    installSessionHardening(ses, { log })
    const callback = vi.fn()
    ses.setDisplayMediaRequestHandler.mock.calls[0]?.[0]({}, callback)
    expect(callback).toHaveBeenCalledWith({})
    expect(ses.setDevicePermissionHandler.mock.calls[0]?.[0]()).toBe(false)
    expect(log).toHaveBeenCalledWith('[security] 已拒绝屏幕采集请求')
  })
})
