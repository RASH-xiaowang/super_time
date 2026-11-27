// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadSnsBody } from '../src/query/sns-cdn-download.ts'
import { fetchSnsCdnImage } from '../src/query/sns-cdn-image.ts'
vi.mock('../src/query/image-key.ts', () => ({ resolveImageKeyPair: () => ({ aesKey: undefined, xorKey: 255 }) }))
vi.mock('../src/query/sns-image.ts', () => ({ resolveSnsImageDataUrl: vi.fn(async () => ({ error: 'synthetic local miss' })) }))
const { createMediaRemotes } = await import('../src/remotes/media.ts')
const url = 'https://mmsns.qpic.cn/mmsns/synthetic/0', png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII=', 'base64')
const roots: string[] = []
let signal: AbortSignal | undefined
const fetcher = (res: Response): typeof fetch => vi.fn(async (_url: unknown, init?: RequestInit) => { signal = init?.signal ?? undefined; return res }) as unknown as typeof fetch
async function rejected(p: Promise<unknown>): Promise<Error> {
  try { await p } catch (error) { return error instanceof Error ? error : new Error(String(error)) }
  throw new Error('Expected download rejection')
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve() }
beforeEach(() => { signal = undefined; vi.useFakeTimers() })
afterEach(async () => { await tick(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('SNS bounded download uses actual WHATWG streams, never real network', () => {
  it('header deadline aborts the actual transport signal and cancels a late response body', async () => {
    let release!: (r: Response) => void
    const f = vi.fn((_u, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>(r => { release = r }) }) as unknown as typeof fetch
    const p = rejected(downloadSnsBody(url, f, { headerTimeoutMs: 5 }))
    await vi.advanceTimersByTimeAsync(6); expect((await p).message).toContain('响应头超时'); expect(signal?.aborted).toBe(true)
    const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel }))); await tick(); expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('a body that never finishes is canceled, unlocked, and its producer stops', async () => {
    let writes = 0, producer: ReturnType<typeof setInterval>
    const cancel = vi.fn(() => clearInterval(producer))
    const body = new ReadableStream<Uint8Array>({ start(c) { producer = setInterval(() => { writes++; c.enqueue(new Uint8Array([1])) }, 2) }, cancel })
    const response = new Response(body), p = rejected(downloadSnsBody(url, fetcher(response), { bodyTimeoutMs: 9 }))
    await vi.advanceTimersByTimeAsync(12); expect((await p).message).toContain('响应体超时'); expect(signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1)
    const atStop = writes; await vi.advanceTimersByTimeAsync(100); expect(writes).toBe(atStop); await tick(); expect(response.body?.locked).toBe(false)
  })
  it('body rejection returns a controlled image error, rather than throwing past fallback', async () => {
    const response = new Response(new ReadableStream({ start(c) { c.error(new Error('synthetic body reject')) } }))
    const r = await fetchSnsCdnImage(url, 'synthetic-token', 'synthetic-seed', fetcher(response))
    expect(r.error).toContain('synthetic body reject'); expect(signal?.aborted).toBe(true); expect(response.body?.locked).toBe(false)
  })
  it.each([undefined, '1', 'nonsense', '-1'])('enforces actual streaming bytes despite content-length=%s', async length => {
    const cancel = vi.fn(); let pulls = 0
    const response = new Response(new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(8)) }, cancel }), { headers: length === undefined ? {} : { 'content-length': length } })
    const p = downloadSnsBody(url, fetcher(response), { maxBytes: 12 })
    await expect(p).rejects.toThrow('体积超过上限'); await tick(); expect(cancel).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true); expect(response.body?.locked).toBe(false); expect(pulls).toBeLessThan(5)
  })
  it('rejects an advertised oversize body without reading it and cancels it', async () => {
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '13' } })
    await expect(downloadSnsBody(url, fetcher(response), { maxBytes: 12 })).rejects.toThrow('体积超过上限'); await tick(); expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('caller cancellation stops an unresolved body and releases the reader', async () => {
    const abort = new AbortController(), cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }))
    const p = rejected(downloadSnsBody(url, fetcher(response), { signal: abort.signal }))
    await tick(); abort.abort(); expect((await p).message).toContain('已取消'); await tick(); expect(cancel).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true); expect(response.body?.locked).toBe(false)
  })
  it('an already-cancelled caller performs no fetch', async () => {
    const abort = new AbortController(); abort.abort(); const f = vi.fn() as unknown as typeof fetch
    await expect(downloadSnsBody(url, f, { signal: abort.signal })).rejects.toThrow('已取消'); expect(f).not.toHaveBeenCalled()
  })
  it('success retains byte identity without content-length, with no cancellation or timer residue', async () => {
    const response = new Response(png), result = await downloadSnsBody(url, fetcher(response))
    expect(result.bytes.equals(png)).toBe(true); expect(signal?.aborted).toBe(false); expect(response.body?.locked).toBe(false)
  })
  it('non-OK and empty responses close their bodies and clear deadlines', async () => {
    const cancel = vi.fn(); await expect(downloadSnsBody(url, fetcher(new Response(new ReadableStream({ cancel }), { status: 503 })))).rejects.toThrow('HTTP 503'); await tick(); expect(cancel).toHaveBeenCalledTimes(1)
    await expect(downloadSnsBody(url, fetcher(new Response(new Uint8Array())))).rejects.toThrow('空响应')
  })
  it('public image adapter keeps whitelist/seed gates before starting download', async () => {
    const f = vi.fn() as unknown as typeof fetch
    expect((await fetchSnsCdnImage('https://invalid.example/synthetic', 't', 's', f)).error).toContain('清单')
    expect((await fetchSnsCdnImage(url, 't', '', f)).error).toContain('种子'); expect(f).not.toHaveBeenCalled()
  })
  it('actual media remote falls back UHD-body rejection -> valid ordinary CDN exactly once each', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sns-download-fallback-t188u-')); roots.push(root); const decrypted = join(root, 'empty-decrypted'); mkdirSync(decrypted)
    const f = vi.fn(async (input: unknown) => String(input).includes('/uhd/') ? new Response(new ReadableStream({ start(c) { c.error(new Error('synthetic UHD body fail')) } })) : new Response(png, { headers: { 'x-enc': '0' } }))
    vi.stubGlobal('fetch', f)
    const remote = createMediaRemotes({ dirs: () => ({ decrypted, decoded: join(root, 'decoded') }), rawWechatBase: () => '', op: () => {}, decryptState: { active: false, op: null } as never, warmDecodedImages: async () => {} })
    const result = await remote.getSnsImageDataUrl({ md5: '0123456789abcdef0123456789abcdef', url, token: 'synthetic-token', seed: 'synthetic-seed', uhdUrl: 'https://mmsns.qpic.cn/mmsns/uhd/2000', uhdToken: 'synthetic-token', uhdSeed: 'synthetic-seed', originalWidth: 1, originalHeight: 1, offline: false })
    expect(result.url).toBe('data:image/png;base64,' + png.toString('base64')); expect(f).toHaveBeenCalledTimes(2)
  })
})
