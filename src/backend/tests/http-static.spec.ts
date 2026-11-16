// @vitest-environment node
/**
 * 静态资源服务的**错误路径**：stat 失败必须给出状态码。
 *
 * `resolveStaticFile` 与 `sendFile` 之间有一个天然竞态窗口：路径解析通过后，文件仍可能
 * 被升级/清理删掉。旧实现直接 `statSync`，异常会一路冒成 `onRequest` 的 rejection ——
 * 浏览器既收不到 404 也收不到 500，只能挂到超时。这里钉住「文件没了是 404、其它
 * stat 失败是 500」，且都返回 JSON 而不是空连接。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { sendFile } = require(join(__dirname, '..', 'http-static.js')) as {
  sendFile: (res: unknown, file: string, urlPath: string, headOnly?: boolean) => void
}

/** 够用的 ServerResponse 假件：只记录 writeHead/end/destroy。 */
function fakeResponse() {
  const state = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status
      state.headers = headers
      state.headersSent = true
      return state
    },
    end(chunk?: string) {
      if (chunk) state.body += String(chunk)
      state.writableEnded = true
    },
    destroy() { state.destroyed = true },
  }
  return state
}

const scratch: string[] = []
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

describe('静态资源 stat 失败', () => {
  it('文件在解析后被删掉：返回 404 JSON（不能让请求悬挂）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-static-'))
    scratch.push(dir)
    const res = fakeResponse()
    sendFile(res, join(dir, 'gone.html'), '/gone.html')
    expect(res.status).toBe(404)
    expect(res.headers['Content-Type']).toContain('application/json')
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('其它 stat 失败（非法路径）：返回 500 JSON，而不是把异常抛给路由', () => {
    const res = fakeResponse()
    sendFile(res, 'bad\u0000name.html', '/bad.html')
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: 'STATIC_READ_FAILED' } })
  })
})
