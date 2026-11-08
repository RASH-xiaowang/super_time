// @vitest-environment node
/**
 * 消息列表局域网 Webhook 的真实 HTTP 路由守卫。
 *
 * 这里不直接调处理器，而是起一个监听在 127.0.0.1 的临时服务，验证：
 *  ① URL 路径令牌正确时 GET 返回协议信息，错误令牌统一 404；
 *  ② POST 落库但下游失败仍返回 200 accepted，避免调用方重放造成重复记录；
 *  ③ Host 校验仍排在业务路由之前，伪造 Host 不会触达 `gatedCall`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MESSAGE_WEBHOOK_PATH_PREFIX,
  deriveMessageWebhookToken,
} from '../wechat-data/src/net/message-webhook.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { createRemoteAccessServer, MESSAGE_WEBHOOK_BODY_BYTES } = require(join(ROOT, 'src', 'backend', 'http-server.js')) as {
  MESSAGE_WEBHOOK_BODY_BYTES: number
  createRemoteAccessServer: (deps: {
    getDataRoot: () => string
    getUiDistDir: () => string
    gatedCall: (method: string, args: unknown[]) => Promise<unknown>
    appVersion: string
    bindHost?: string
    log?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
  }) => {
    start: () => Promise<{ running: boolean; port: number }>
    stop: () => Promise<unknown>
  }
}

const TOKEN = 'message-webhook-spec-token-0123456789'
const scratch: string[] = []
const servers: Array<{ stop: () => Promise<unknown> }> = []
let nextPort = 31800

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await server.stop()
  }
  while (scratch.length > 0) {
    const dir = scratch.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

async function fixture(respond: (method: string, args: unknown[]) => Promise<unknown>) {
  const base = mkdtempSync(join(tmpdir(), 'message-webhook-'))
  scratch.push(base)
  const dataRoot = join(base, 'wechat-data')
  const uiDist = join(base, 'ui-dist')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(uiDist, { recursive: true })
  writeFileSync(join(uiDist, 'index.html'), '<!doctype html><title>probe</title>')
  writeFileSync(join(dataRoot, 'config.json'), JSON.stringify({
    api_enabled: true,
    api_port: nextPort++,
  }))
  writeFileSync(join(dataRoot, 'secrets.json'), JSON.stringify({ api_token: TOKEN }))

  const calls: Array<{ method: string; args: unknown[] }> = []
  const server = createRemoteAccessServer({
    getDataRoot: () => dataRoot,
    getUiDistDir: () => uiDist,
    gatedCall: async (method, args) => {
      calls.push({ method, args })
      return respond(method, args)
    },
    appVersion: 'spec',
    bindHost: '127.0.0.1',
    log: () => undefined,
    warn: () => undefined,
  })
  servers.push(server)
  const state = await server.start()
  expect(state.running).toBe(true)
  const url = 'http://127.0.0.1:' + String(state.port)
  return {
    url,
    path: MESSAGE_WEBHOOK_PATH_PREFIX + deriveMessageWebhookToken(TOKEN),
    calls,
  }
}

function rawGet(base: string, path: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path,
      method: 'GET',
      setHost: false,
      headers: { Host: host, Connection: 'close' },
    }, (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk) => { body += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function rawBodylessPost(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path,
      method: 'POST',
      headers: { Host: url.host, Connection: 'close', ...headers },
    }, (res) => {
      res.setEncoding('utf8')
      let body = ''
      res.on('data', (chunk) => { body += String(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('消息列表局域网 Webhook 路由', () => {
  it('GET 使用稳定路径令牌通检；错误令牌统一 404', async () => {
    const f = await fixture(async () => ({ ok: false }))
    const health = await fetch(f.url + f.path)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({
      ok: true,
      service: 'message-list',
      version: '1.0',
      api: 1,
    })

    const wrong = await fetch(f.url + MESSAGE_WEBHOOK_PATH_PREFIX + 'not-a-valid-token')
    expect(wrong.status).toBe(404)
    expect(f.calls).toEqual([])
  })

  it('POST 经后端落库并投递；下游失败仍返回 accepted=true、delivered=false', async () => {
    let deliveryOk = true
    const f = await fixture(async (method) => {
      expect(method).toBe('ingestMessageListWebhook')
      return {
        ok: true,
        value: deliveryOk
          ? {
              ok: true,
              id: 7,
              created: true,
              record: {
                id: 7,
                status: 'success',
                created: true,
                attempts: 1,
                replyId: 'r-7',
                webhookUrl: 'http://192.0.2.10/webhook/secret-path-token',
              },
            }
          : {
              ok: false,
              error: '未匹配到 Webhook: http://192.0.2.10/webhook/secret-path-token?key=secret-query',
              id: 8,
              created: false,
              record: {
                id: 8,
                status: 'pending',
                created: false,
                attempts: 0,
                replyId: 'r-8',
                webhookUrl: 'http://192.0.2.10/webhook/secret-path-token',
              },
            },
      }
    })
    const payload = {
      target: '文件传输助手',
      message: '你好',
      attachments: [],
    }
    const accepted = await fetch(f.url + f.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(accepted.status).toBe(200)
    const acceptedBody = await accepted.json() as Record<string, unknown>
    expect(acceptedBody).toMatchObject({
      ok: true,
      accepted: true,
      delivered: true,
      record: { id: 7, status: 'success', created: true, attempts: 1 },
    })
    expect(acceptedBody.record).toEqual({
      id: 7,
      status: 'success',
      created: true,
      attempts: 1,
    })
    expect(JSON.stringify(acceptedBody)).not.toMatch(/webhookUrl|replyId|secret-path-token/)
    expect(f.calls).toEqual([{ method: 'ingestMessageListWebhook', args: [payload] }])

    deliveryOk = false
    const pending = await fetch(f.url + f.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(pending.status).toBe(200)
    const pendingBody = await pending.json() as Record<string, unknown>
    expect(pendingBody).toMatchObject({
      ok: true,
      accepted: true,
      delivered: false,
      record: { id: 8, status: 'pending', created: false, attempts: 0 },
    })
    expect(pendingBody.record).toEqual({
      id: 8,
      status: 'pending',
      created: false,
      attempts: 0,
    })
    expect(pendingBody.deliveryError).toContain('未匹配到 Webhook')
    expect(JSON.stringify(pendingBody))
      .not.toMatch(/webhookUrl|replyId|secret-path-token|secret-query/)
  })

  it('Host 校验先于业务路由：伪造 Host 返回 421 且不触发 gatedCall', async () => {
    const f = await fixture(async () => ({ ok: false }))
    const result = await rawGet(f.url, f.path, 'attacker.example')
    expect(result.status).toBe(421)
    expect(result.body).toContain('BAD_HOST')
    expect(f.calls).toEqual([])
  })

  it('坏 JSON 在进入后端前返回 400', async () => {
    const f = await fixture(async () => ({ ok: false }))
    const result = await fetch(f.url + f.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })
    expect(result.status).toBe(400)
    expect(f.calls).toEqual([])
  })

  it('入站 Webhook 严格要求 application/json 与 JSON 对象', async () => {
    const f = await fixture(async () => ({ ok: false }))
    const text = await fetch(f.url + f.path, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ target: '张三', message: '你好' }),
    })
    expect(text.status).toBe(415)
    expect(await text.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } })

    const array = await fetch(f.url + f.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    expect(array.status).toBe(400)
    expect(await array.json()).toMatchObject({ error: { code: 'BAD_JSON_SHAPE' } })
    expect(f.calls).toEqual([])
  })

  it('声明的 Content-Length 超过 30MB 时在读取正文前返回 413', async () => {
    const f = await fixture(async () => ({ ok: false }))
    const result = await rawBodylessPost(f.url, f.path, {
      'content-type': 'application/json',
      'content-length': String(MESSAGE_WEBHOOK_BODY_BYTES + 1),
    })
    expect(result.status).toBe(413)
    expect(result.body).toContain('BODY_TOO_LARGE')
    expect(f.calls).toEqual([])
  })
})
