// @vitest-environment node
import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { IncomingMessage, ClientRequest } from 'node:http'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))
import { readReplyPublicHttps } from '../src/query/reply-tools/public-http.ts'
interface FakeReply { status: number; headers: Record<string, string>; chunks?: string[]; hang?: boolean }
let responses: FakeReply[] = []
let requests: Array<{ url: URL; options: RequestOptions }> = []
beforeEach(() => {
  responses = []; requests = []
  vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
  vi.mocked(request).mockImplementation(((url: URL, options: RequestOptions, cb: (res: IncomingMessage) => void) => {
    requests.push({ url, options })
    const fixture = responses.shift() ?? { status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['ok'] }
    const req = new EventEmitter() as EventEmitter & { end(): void }
    req.end = () => {
      if (fixture.hang) return
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroyed: boolean; destroy(e?: Error): void }
      res.statusCode = fixture.status; res.headers = fixture.headers; res.destroyed = false
      res.destroy = e => { res.destroyed = true; if (e) res.emit('error', e) }
      cb(res as unknown as IncomingMessage)
      queueMicrotask(() => { if (!res.destroyed) { for (const chunk of fixture.chunks ?? []) res.emit('data', Buffer.from(chunk)); if (!res.destroyed) res.emit('end') } })
    }
    options.signal?.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true })
    return req as unknown as ClientRequest
  }) as unknown as typeof request)
})
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
describe('reply-only DNS-pinned HTTPS transport', () => {
  it('pins exactly the validated IP for connect, preserving the original hostname for TLS', async () => {
    const r = await readReplyPublicHttps('https://example.com/page', { signal: new AbortController().signal })
    expect(r.text).toBe('ok'); expect(lookup).toHaveBeenCalledTimes(1)
    expect(requests[0]?.url.hostname).toBe('example.com')
    expect(requests[0]?.options.agent).toBe(false)
    const connectLookup = requests[0]?.options.lookup as unknown as (host: string, opts: object, cb: (e: null, ip: string, family: number) => void) => void
    const done = vi.fn(); connectLookup('example.com', {}, done)
    expect(done).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(lookup).toHaveBeenCalledTimes(1)
  })
  it('blocks a redirect to metadata/private space before a second connection', async () => {
    responses.push({ status: 302, headers: { location: 'https://169.254.169.254/latest' } })
    await expect(readReplyPublicHttps('https://example.com', { signal: new AbortController().signal })).rejects.toThrow('public_url_blocked')
    expect(requests).toHaveLength(1)
  })
  it('does not forward provider credentials on cross-origin redirects', async () => {
    responses.push({ status: 302, headers: { location: 'https://other.example/' } })
    await expect(readReplyPublicHttps('https://example.com', { signal: new AbortController().signal, headers: { 'X-Subscription-Token': 'synthetic-key' } })).rejects.toThrow('public_redirect_credentials')
    expect(requests).toHaveLength(1)
  })
  it('has a bounded redirect count', async () => {
    for (let i = 0; i < 5; i++) responses.push({ status: 302, headers: { location: '/next' } })
    await expect(readReplyPublicHttps('https://example.com', { signal: new AbortController().signal })).rejects.toThrow('public_redirect_limit')
    expect(requests).toHaveLength(4)
  })
  it.each([
    { headers: { 'content-type': 'application/octet-stream' }, code: 'public_content_type' },
    { headers: { 'content-type': 'text/plain', 'content-length': '999999' }, code: 'public_body_limit' },
    { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, code: 'public_body_limit' },
  ])('rejects unsupported/oversize body headers $code', async ({ headers, code }) => {
    responses.push({ status: 200, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])) })
    await expect(readReplyPublicHttps('https://example.com', { signal: new AbortController().signal })).rejects.toThrow(code)
  })
  it('enforces the streamed byte limit even without Content-Length', async () => {
    responses.push({ status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['x'.repeat(65537)] })
    await expect(readReplyPublicHttps('https://example.com', { signal: new AbortController().signal })).rejects.toThrow('public_body_limit')
  })
  it('aborts a stalled request and never retries it', async () => {
    vi.useFakeTimers(); responses.push({ status: 200, headers: {}, hang: true })
    const promise = readReplyPublicHttps('https://example.com', { signal: new AbortController().signal })
    const assertion = expect(promise).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(6501); await assertion
    expect(requests).toHaveLength(1)
  })
})
