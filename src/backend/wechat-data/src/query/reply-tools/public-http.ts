/** HTTPS GET with DNS pinning: validation and connect use the SAME public IP.
 * The attachment helper's hostname/IP deny rules are reused, not its re-resolving fetch.
 * No cookies, proxy credentials, custom model-provided headers, or write methods.
 */
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import { isBlockedAttachmentHost } from '../message-list-attachments.ts'

export interface PublicAddress { address: string; family: number }
export type ReplyLookup = (host: string) => Promise<PublicAddress[]>
const defaultLookup: ReplyLookup = host => lookup(host, { all: true, verbatim: true })
export function throwIfReplyAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('回复生成已取消或超时'), { code: 'reply_aborted' })
}
export function abortableReply<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Work may have synchronously triggered cancellation before this wrapper runs.
  work.catch(() => undefined)
  throwIfReplyAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(Object.assign(new Error('回复生成已取消或超时'), { code: 'reply_aborted' }))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => undefined)
  })
}
/** Exported pure boundary for contract tests; no runtime option can disable it. */
export async function resolveReplyPublicUrl(raw: string, resolve: ReplyLookup = defaultLookup): Promise<{ url: URL; address: PublicAddress }> {
  const url = new URL(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (raw.length > 2048 || url.protocol !== 'https:' || url.username || url.password
    || (url.port !== '' && url.port !== '443') || isBlockedAttachmentHost(host)) {
    throw new Error('public_url_blocked')
  }
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host)
  if (!addresses.length || addresses.some(a => !isIP(a.address) || isBlockedAttachmentHost(a.address))) throw new Error('public_dns_blocked')
  return { url, address: addresses[0]! }
}
export async function readReplyPublicHttps(raw: string, options: {
  signal: AbortSignal; headers?: Record<string, string>; maxRedirects?: number
}): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  const timer = setTimeout(abort, 6500)
  const signal = controller.signal
  try {
    let current = raw
    const redirects = Math.min(3, Math.max(0, options.maxRedirects ?? 3))
    for (let hop = 0; ; hop++) {
      throwIfReplyAborted(signal)
      const { url, address } = await abortableReply(resolveReplyPublicUrl(current), signal)
      throwIfReplyAborted(signal)
      const response = await new Promise<{ text: string; contentType: string; location?: string }>((resolve, reject) => {
        const req = request(url, {
          method: 'GET', signal, agent: false, family: address.family,
          // Pin the validated result. TLS SNI/certificate verification still use url.hostname.
          lookup: (_host, _opts, done) => done(null, address.address, address.family),
          headers: { 'user-agent': 'SuperTime-ReplyTools/1.0', accept: 'application/json,text/html,text/plain;q=0.8', 'accept-encoding': 'identity', ...options.headers },
        }, res => {
          const status = res.statusCode ?? 0
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location
            res.destroy()
            if (!location || hop >= redirects) { reject(new Error('public_redirect_limit')); return }
            const next = new URL(location, url)
            // Never forward provider credentials across an origin boundary.
            if (next.origin !== url.origin && (options.headers || url.searchParams.has('apikey'))) { reject(new Error('public_redirect_credentials')); return }
            resolve({ text: '', contentType: '', location: next.toString() }); return
          }
          if (status < 200 || status >= 300) { res.destroy(); reject(new Error('public_http_' + String(status))); return }
          const contentType = String(res.headers['content-type'] ?? '').toLowerCase()
          if (!/^(application\/(?:json|[^;]+\+json|xhtml\+xml)|text\/(?:plain|html))(?:;|$)/.test(contentType)) {
            res.destroy(); reject(new Error('public_content_type')); return
          }
          if (Number(res.headers['content-length'] ?? 0) > 65536 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
            res.destroy(); reject(new Error('public_body_limit')); return
          }
          const chunks: Buffer[] = []; let bytes = 0
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 65536) { res.destroy(new Error('public_body_limit')); return }
            chunks.push(chunk)
          })
          res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), contentType }))
          res.on('error', reject)
        })
        req.on('error', reject); req.end()
      })
      if (!response.location) return response
      current = response.location
    }
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', abort)
  }
}
