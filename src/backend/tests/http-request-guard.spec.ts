/**
 * 浏览器写请求的 Origin 判定。
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { isAllowedBrowserOrigin, allowBrowserRequest } = require('../http-request-guard.js') as {
  isAllowedBrowserOrigin: (origin: string | undefined, host: string | undefined) => boolean
  allowBrowserRequest: (
    req: { headers: { origin?: string, host?: string, 'sec-fetch-site'?: string } },
    res: object,
    sendJson: (res: object, status: number, payload: object) => void,
    label: string,
  ) => boolean
}

describe('Origin 必须与已校验的 Host 同源', () => {
  it('同源 Origin 放行（端口必须一致）', () => {
    expect(isAllowedBrowserOrigin('http://127.0.0.1:5032', '127.0.0.1:5032')).toBe(true)
    expect(isAllowedBrowserOrigin('http://[::1]:5032', '[::1]:5032')).toBe(true)
    expect(isAllowedBrowserOrigin(undefined, '127.0.0.1:5032')).toBe(true)
  })

  it('跨源、null、协议降级与带路径的伪 Origin 一律拒绝', () => {
    const host = '127.0.0.1:5032'
    for (const origin of [
      'http://127.0.0.1:5033',
      'http://attacker.example',
      'https://127.0.0.1:5032',
      'null',
      '',
      'http://user@127.0.0.1:5032',
      'http://127.0.0.1:5032/not-an-origin',
      'not a url',
    ]) {
      expect(isAllowedBrowserOrigin(origin, host), origin).toBe(false)
    }
  })

  it('拒绝时写 403 且不继续处理', () => {
    const res = {}
    const sendJson = vi.fn()
    const ok = allowBrowserRequest(
      { headers: { origin: 'http://attacker.example', host: '127.0.0.1:5032' } },
      res,
      sendJson,
      '原生能力',
    )
    expect(ok).toBe(false)
    expect(sendJson).toHaveBeenCalledWith(
      res,
      403,
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'ORIGIN_DENIED' }) }),
    )
  })

  it('没有 Origin 的浏览器请求仍按 Sec-Fetch-Site 拒绝同站/跨站', () => {
    const res = {}
    const sendJson = vi.fn()
    expect(allowBrowserRequest(
      { headers: { host: '127.0.0.1:5032', 'sec-fetch-site': 'cross-site' } },
      res,
      sendJson,
      '令牌交换',
    )).toBe(false)
    expect(sendJson).toHaveBeenCalledWith(res, 403, expect.objectContaining({
      error: expect.objectContaining({ code: 'ORIGIN_DENIED' }),
    }))

    expect(allowBrowserRequest(
      { headers: { host: '127.0.0.1:5032', 'sec-fetch-site': 'same-origin' } },
      {},
      vi.fn(),
      '令牌交换',
    )).toBe(true)
  })
})
