/**
 * 消息列表的本机附件暂存。
 *
 * 跨机发送时不能把 Super Time 所在电脑的绝对路径交给 Feather：路径在另一台
 * 电脑上无效，而且会泄露本机目录结构。桌面端选中的文件先复制到这里的受控
 * 随机文件名，消息列表只保存 40 位 hex 资源 id；投递时再读取字节并上传到
 * Feather 的 resource-spool。
 *
 * Webhook 入站不能创建暂存附件；暂存入口由 LOCAL_ONLY Remote 暴露给桌面端。
 */
import { randomBytes } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, join } from 'node:path'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type {
  MessageListAttachmentStageInput,
  MessageListAttachmentStageResult,
  MessageListImage,
} from '../types.ts'

export const MESSAGE_LIST_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES = MESSAGE_LIST_ATTACHMENT_MAX_BYTES
export const MESSAGE_LIST_ATTACHMENT_MAX_COUNT = 9
export const MESSAGE_LIST_ATTACHMENT_URL_MAX = 4096
const STAGED_ID_RE = /^[0-9a-f]{40}$/i
const SPOOL_DIR = 'message-list-spool'
const STAGED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const IMAGE_DATA_PREFIX_MAX = 64
const IMAGE_DATA_PREFIX_RE = /^data:(image\/(?:png|jpe?g|gif|webp|bmp));base64,/i
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MIME_BY_EXT: Record<string, string> = {
  bmp: 'image/bmp',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rar: 'application/vnd.rar',
  txt: 'text/plain',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
}

export interface MessageListAttachmentLimits {
  maxBytes: number
  totalMaxBytes: number
  maxCount: number
}

export interface MessageListAttachmentValidationOptions {
  /**
   * local: 本机手动插入，可带 localId / stagedId；
   * webhook: 不可信入站，只允许受控 http(s) URL 或图片 data URL；
   * stored: 读取历史库，保留旧数据兼容性，但拒绝路径和超预算结构。
   */
  mode?: 'local' | 'webhook' | 'stored'
  /** 兼容旧调用；false 等价于 webhook 模式。 */
  allowStaged?: boolean
  limits?: Partial<MessageListAttachmentLimits>
}

export type MessageListAttachmentValidationResult =
  | { ok: true; images: MessageListImage[] }
  | { ok: false; error: string }

export interface DecodedImageDataUrl {
  bytes: Buffer
  mime: string
}

function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message !== '' ? message : String(e)
}

function positiveLimit(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function limitsOf(options: MessageListAttachmentValidationOptions): MessageListAttachmentLimits {
  return {
    maxBytes: positiveLimit(options.limits?.maxBytes, MESSAGE_LIST_ATTACHMENT_MAX_BYTES),
    totalMaxBytes: positiveLimit(
      options.limits?.totalMaxBytes,
      MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES,
    ),
    maxCount: positiveLimit(options.limits?.maxCount, MESSAGE_LIST_ATTACHMENT_MAX_COUNT),
  }
}

function own(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key)
}

function maxBase64Chars(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4
}

/** 严格解码图片 data URL：只接受白名单 MIME、规范 base64，并校验文件头。 */
export function decodeMessageListImageDataUrl(
  value: unknown,
  maxBytes = MESSAGE_LIST_ATTACHMENT_MAX_BYTES,
): DecodedImageDataUrl | undefined {
  return inspectMessageListImageDataUrl(value, maxBytes).decoded
}

function inspectMessageListImageDataUrl(
  value: unknown,
  maxBytes: number,
): { decoded?: DecodedImageDataUrl; tooLarge: boolean } {
  if (typeof value !== 'string') return { tooLarge: false }
  const prefix = IMAGE_DATA_PREFIX_RE.exec(value.slice(0, IMAGE_DATA_PREFIX_MAX))
  if (prefix === null) return { tooLarge: false }
  const payload = value.slice(prefix[0].length)
  if (
    payload === ''
    || payload.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)
  ) {
    return { tooLarge: false }
  }
  if (payload.length > maxBase64Chars(maxBytes)) {
    return { tooLarge: true }
  }
  let bytes: Buffer
  try {
    bytes = Buffer.from(payload, 'base64')
  } catch {
    return { tooLarge: false }
  }
  if (bytes.byteLength <= 0) return { tooLarge: false }
  if (bytes.byteLength > maxBytes) return { tooLarge: true }
  // Buffer.from 对部分非规范尾巴很宽容；重新编码必须与原文完全一致。
  if (bytes.toString('base64') !== payload) return { tooLarge: false }
  const mime = (prefix[1] ?? '').toLowerCase().replace('image/jpg', 'image/jpeg')
  if (!imageBytesMatchMime(bytes, mime)) return { tooLarge: false }
  return { decoded: { bytes, mime }, tooLarge: false }
}

/** 图片文件头是否与声明 MIME 一致；仅供附件校验与资源上传复用。 */
export function imageBytesMatchMime(bytes: Uint8Array, mime: string): boolean {
  const normalized = normalizeAttachmentMime(mime)
  if (normalized === 'image/png') {
    return bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  }
  if (normalized === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (normalized === 'image/gif') {
    if (bytes.length < 6) return false
    const signature = String.fromCharCode(...bytes.slice(0, 6))
    return signature === 'GIF87a' || signature === 'GIF89a'
  }
  if (normalized === 'image/webp') {
    return bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  }
  if (normalized === 'image/bmp') {
    return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d
  }
  return false
}

function normalizeAttachmentMime(value: string): string {
  const mime = value.trim().toLowerCase().slice(0, 120)
  return mime === 'image/jpg' ? 'image/jpeg' : mime
}

function validAttachmentMime(value: string): string | undefined {
  const mime = normalizeAttachmentMime(value)
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : undefined
}

function knownImageMime(value: string): string | undefined {
  const mime = normalizeAttachmentMime(value)
  return mime === 'image/png'
    || mime === 'image/jpeg'
    || mime === 'image/gif'
    || mime === 'image/webp'
    || mime === 'image/bmp'
    ? mime
    : undefined
}

function ipv4Parts(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const numbers = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : NaN)
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : undefined
}

function blockedIpv4(parts: readonly number[]): boolean {
  const [a = -1, b = -1, c = -1] = parts
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function expandIpv6(value: string): number[] | undefined {
  let text = value.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (text === '') return undefined
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    const embedded = ipv4Parts(text.slice(lastColon + 1))
    if (lastColon < 0 || embedded === undefined) return undefined
    const high = ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0)
    const low = ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0)
    text = text.slice(0, lastColon + 1)
      + high.toString(16) + ':' + low.toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const left = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':')
  const right = halves.length === 2 && (halves[1] ?? '') !== ''
    ? (halves[1] ?? '').split(':')
    : []
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return undefined
  }
  return groups.map((group) => Number.parseInt(group, 16))
}

function embeddedIpv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

function blockedIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return true
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if ((groups[0] ?? 0) < 0x00ff) return true
  const first = groups[0] ?? 0
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true
  if ((first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return true
  if (first === 0x2001 && groups[1] === 0x0db8) return true
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  const compatible = groups.slice(0, 6).every((group) => group === 0)
  const nat64 = first === 0x0064 && groups[1] === 0xff9b
    && groups.slice(2, 6).every((group) => group === 0)
  if (
    (mapped || compatible || nat64)
    && blockedIpv4(embeddedIpv4(groups[6] ?? 0, groups[7] ?? 0))
  ) {
    return true
  }
  if (first === 0x2002 && blockedIpv4(embeddedIpv4(groups[1] ?? 0, groups[2] ?? 0))) {
    return true
  }
  return first === 0x2001 && groups[1] === 0
}

/** 入站 URL 的字面地址/本地主机名是否落在 SSRF 禁止范围。 */
export function isBlockedAttachmentHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal' || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  const family = isIP(host)
  if (family === 4) {
    const parts = ipv4Parts(host)
    return parts === undefined || blockedIpv4(parts)
  }
  if (family === 6) {
    const groups = expandIpv6(host)
    return groups === undefined || blockedIpv6(groups)
  }
  return false
}

export type PublicHttpLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>

export interface PublicHttpFetchOptions {
  fetchImpl?: RetryFetch
  lookup?: PublicHttpLookup
  maxRedirects?: number
}

const defaultPublicHttpLookup: PublicHttpLookup = (hostname) => (
  dnsLookup(hostname, { all: true, verbatim: true })
)

async function assertPublicHttpUrl(url: URL, lookup: PublicHttpLookup): Promise<void> {
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.hostname === ''
    || url.username !== ''
    || url.password !== ''
    || isBlockedAttachmentHost(url.hostname)
  ) {
    throw new Error('附件 URL 指向本机、私网或保留地址')
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return
  const addresses = await lookup(url.hostname)
  if (addresses.length === 0) throw new Error('附件 URL 域名无法解析')
  if (addresses.some((row) => isBlockedAttachmentHost(row.address))) {
    throw new Error('附件 URL 域名解析到本机、私网或保留地址')
  }
}

/**
 * 仅供入站远程附件下载使用：逐跳手动重定向，并在每次 fetch 前校验 DNS。
 * 测试可同时注入 lookup 与 fetch，生产不暴露“跳过校验”的旁路。
 */
export function createPublicHttpFetch(options: PublicHttpFetchOptions = {}): RetryFetch {
  const doFetch: RetryFetch = options.fetchImpl ?? fetch
  const lookup = options.lookup ?? defaultPublicHttpLookup
  const maxRedirects = Number.isSafeInteger(options.maxRedirects)
    ? Math.max(0, Math.min(10, Number(options.maxRedirects)))
    : 5
  return async (input, init) => {
    let current: URL
    try {
      current = new URL(input)
    } catch {
      throw new Error('附件 URL 无效')
    }
    for (let redirects = 0; ; redirects += 1) {
      await assertPublicHttpUrl(current, lookup)
      const response = await doFetch(current.toString(), { ...init, redirect: 'manual' })
      if (!REDIRECT_STATUSES.has(response.status)) return response
      const location = response.headers.get('location')
      if (location === null || location.trim() === '') return response
      if (redirects >= maxRedirects) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('附件 URL 重定向次数过多')
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('附件 URL 重定向地址无效')
      }
      await response.body?.cancel().catch(() => undefined)
      current = next
    }
  }
}

/** 只接受无凭据、无歧义的绝对 http(s) URL。 */
export function controlledAttachmentUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw === '' || raw.length > MESSAGE_LIST_ATTACHMENT_URL_MAX) return undefined
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    if (isBlockedAttachmentHost(url.hostname)) return undefined
    return raw
  } catch {
    return undefined
  }
}

function invalidAttachment(index: number, reason: string): MessageListAttachmentValidationResult {
  return { ok: false, error: `附件 ${String(index + 1)} 无效：${reason}` }
}

/**
 * 统一校验消息列表附件。任何一项非法都会失败整组，绝不截断或静默丢件。
 *
 * 单文件与整组预算都按解码后的二进制字节计算；data URL 的 MIME 头和 base64
 * 膨胀不计入预算，但其内容必须通过严格 base64 与文件头校验。远程 URL 和微信
 * localId 在入站时无法得知字节数，投递阶段还会用同一预算再次校验。
 */
export function validateMessageListImages(
  raw: unknown,
  options: MessageListAttachmentValidationOptions = {},
): MessageListAttachmentValidationResult {
  if (raw === undefined || raw === null) return { ok: true, images: [] }
  if (!Array.isArray(raw)) return { ok: false, error: '附件必须是数组' }
  const mode = options.mode ?? (options.allowStaged === false ? 'webhook' : 'local')
  const limits = limitsOf(options)
  if (raw.length > limits.maxCount) {
    return {
      ok: false,
      error: `附件最多 ${String(limits.maxCount)} 个`,
    }
  }

  const images: MessageListImage[] = []
  let knownBytes = 0
  const accountBytes = (bytes: number, index: number): MessageListAttachmentValidationResult | undefined => {
    if (bytes > limits.maxBytes) {
      return invalidAttachment(index, `单个附件超过 ${String(limits.maxBytes)} 字节上限`)
    }
    if (bytes > limits.totalMaxBytes - knownBytes) {
      return invalidAttachment(index, `附件总大小超过 ${String(limits.totalMaxBytes)} 字节上限`)
    }
    knownBytes += bytes
    return undefined
  }

  for (let index = 0; index < raw.length; index += 1) {
    const candidate = raw[index]
    if (typeof candidate === 'string') {
      const url = controlledAttachmentUrl(candidate)
      if (url !== undefined) {
        images.push({ url })
        continue
      }
      const inspected = inspectMessageListImageDataUrl(candidate, limits.maxBytes)
      const over = inspected.tooLarge
        ? invalidAttachment(index, `单个附件超过 ${String(limits.maxBytes)} 字节上限`)
        : undefined
      if (over !== undefined) return over
      const decoded = inspected.decoded
      if (decoded === undefined) {
        return invalidAttachment(index, '字符串必须是受控 http(s) URL 或严格图片 data URL')
      }
      const totalOver = accountBytes(decoded.bytes.byteLength, index)
      if (totalOver !== undefined) return totalOver
      images.push({ dataUrl: candidate })
      continue
    }
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return invalidAttachment(index, '必须是 URL、data URL 或附件对象')
    }
    const row = candidate as Record<string, unknown>
    if (mode === 'webhook' && own(row, 'stagedId')) {
      return invalidAttachment(index, '入站请求禁止 stagedId')
    }
    if (mode === 'webhook' && own(row, 'localId')) {
      return invalidAttachment(index, '入站请求禁止微信 localId')
    }

    const hasStaged = own(row, 'stagedId')
    const hasLocal = own(row, 'localId')
    const hasUrl = own(row, 'url')
    const hasData = own(row, 'dataUrl')
    const sourceCount = [hasStaged, hasLocal, hasUrl, hasData].filter(Boolean).length
    if (sourceCount !== 1) {
      return invalidAttachment(index, 'url、dataUrl、localId、stagedId 必须且只能提供一个')
    }

    if (hasStaged) {
      const stagedId = typeof row['stagedId'] === 'string' ? row['stagedId'].trim() : ''
      if (!STAGED_ID_RE.test(stagedId)) return invalidAttachment(index, 'stagedId 必须是 40 位 hex')
      if (own(row, 'name') && typeof row['name'] !== 'string') {
        return invalidAttachment(index, 'name 必须是字符串')
      }
      if (own(row, 'size') && (!Number.isSafeInteger(row['size']) || Number(row['size']) <= 0)) {
        return invalidAttachment(index, 'stagedId 的 size 必须是正整数')
      }
      if (typeof row['size'] === 'number') {
        const over = accountBytes(row['size'], index)
        if (over !== undefined) return over
      }
      if (own(row, 'mime') && typeof row['mime'] !== 'string') {
        return invalidAttachment(index, 'mime 必须是字符串')
      }
      const name = safeAttachmentName(row['name'])
      let mime = attachmentMime(name)
      if (typeof row['mime'] === 'string' && row['mime'].trim() !== '') {
        const parsed = validAttachmentMime(row['mime'])
        if (parsed === undefined) return invalidAttachment(index, 'mime 格式无效')
        mime = parsed
      }
      images.push({
        stagedId: stagedId.toLowerCase(),
        name,
        ...(typeof row['size'] === 'number' ? { size: row['size'] } : {}),
        mime,
      })
      continue
    }

    if (hasLocal) {
      const localId = row['localId']
      if (!Number.isSafeInteger(localId) || Number(localId) <= 0) {
        return invalidAttachment(index, 'localId 必须是正整数')
      }
      if (own(row, 'sender') && typeof row['sender'] !== 'string') {
        return invalidAttachment(index, 'sender 必须是字符串')
      }
      if (own(row, 'md5') && typeof row['md5'] !== 'string') {
        return invalidAttachment(index, 'md5 必须是字符串')
      }
      if (own(row, 'name') && typeof row['name'] !== 'string') {
        return invalidAttachment(index, 'name 必须是字符串')
      }
      const createTime = row['createTime']
      if (own(row, 'createTime') && (!Number.isSafeInteger(createTime) || Number(createTime) < 0)) {
        return invalidAttachment(index, 'createTime 必须是非负整数')
      }
      const image: MessageListImage = {
        localId: Number(localId),
        createTime: own(row, 'createTime') ? Number(createTime) : 0,
        sender: typeof row['sender'] === 'string' ? row['sender'].trim().slice(0, 200) : '',
      }
      const md5 = typeof row['md5'] === 'string' ? row['md5'].trim().slice(0, 64) : ''
      if (md5 !== '') image.md5 = md5
      if (own(row, 'name')) {
        const name = safeAttachmentName(row['name'], '')
        if (name !== '') image.name = name
      }
      images.push(image)
      continue
    }

    if (hasUrl) {
      const url = controlledAttachmentUrl(row['url'])
      if (url === undefined) return invalidAttachment(index, 'url 必须是受控 http(s) URL')
      if (own(row, 'name') && typeof row['name'] !== 'string') {
        return invalidAttachment(index, 'name 必须是字符串')
      }
      const image: MessageListImage = { url }
      if (own(row, 'name')) {
        const name = safeAttachmentName(row['name'], '')
        if (name !== '') image.name = name
      }
      images.push(image)
      continue
    }

    const dataUrl = row['dataUrl']
    if (own(row, 'name') && typeof row['name'] !== 'string') {
      return invalidAttachment(index, 'name 必须是字符串')
    }
    const inspected = inspectMessageListImageDataUrl(dataUrl, limits.maxBytes)
    const over = inspected.tooLarge
      ? invalidAttachment(index, `单个附件超过 ${String(limits.maxBytes)} 字节上限`)
      : undefined
    if (over !== undefined) return over
    const decoded = inspected.decoded
    if (decoded === undefined) {
      return invalidAttachment(index, 'dataUrl 的 MIME、base64 或图片内容无效')
    }
    const totalOver = accountBytes(decoded.bytes.byteLength, index)
    if (totalOver !== undefined) return totalOver
    const image: MessageListImage = { dataUrl: String(dataUrl) }
    if (own(row, 'name')) {
      const name = safeAttachmentName(row['name'], '')
      if (name !== '') image.name = name
    }
    images.push(image)
  }
  return { ok: true, images }
}

function spoolPath(decryptedDir: string, id: string): string {
  if (!STAGED_ID_RE.test(id)) throw new Error('附件资源 id 无效')
  return join(decryptedDir, SPOOL_DIR, id.toLowerCase() + '.bin')
}

/** 去掉目录、控制字符和 Windows 保留符号；仅用于展示名，不参与路径。 */
export function safeAttachmentName(value: unknown, fallback = 'attachment.bin'): string {
  const raw = typeof value === 'string' ? basename(value) : ''
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 120)
  return cleaned === '' ? fallback : cleaned
}

export function attachmentMime(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  return match === null ? 'application/octet-stream' : (MIME_BY_EXT[match[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream')
}

/**
 * 把桌面端选中的本机文件复制到受控暂存目录。
 *
 * 只接受普通文件；资源名由服务端随机生成，原文件名只作为展示元数据。
 */
export async function stageMessageListAttachment(
  decryptedDir: string,
  input: MessageListAttachmentStageInput,
): Promise<MessageListAttachmentStageResult> {
  const rawPath = typeof input?.path === 'string' ? input.path.trim() : ''
  if (rawPath === '') return { ok: false, error: '未选择附件' }
  let target: string | undefined
  try {
    const resolved = await realpath(rawPath)
    const name = safeAttachmentName(resolved)
    const mime = attachmentMime(name)
    const expectedImageMime = knownImageMime(mime)
    const id = randomBytes(20).toString('hex')
    const dir = join(decryptedDir, SPOOL_DIR)
    await mkdir(dir, { recursive: true })
    target = spoolPath(decryptedDir, id)
    const source = await open(resolved, 'r')
    try {
      const sourceInfo = await source.stat()
      if (!sourceInfo.isFile()) return { ok: false, error: '只能选择普通文件' }
      if (sourceInfo.size <= 0) return { ok: false, error: '附件为空' }
      if (sourceInfo.size > MESSAGE_LIST_ATTACHMENT_MAX_BYTES) {
        return { ok: false, error: '附件超过 20 MB 上限' }
      }
      const handle = await open(target, 'wx')
      try {
        let offset = 0
        const buffer = Buffer.allocUnsafe(256 * 1024)
        const signature = Buffer.allocUnsafe(16)
        let signatureLength = 0
        while (offset < sourceInfo.size) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.byteLength, sourceInfo.size - offset),
            offset,
          )
          if (bytesRead <= 0) throw new Error('附件读取不完整')
          if (signatureLength < signature.byteLength) {
            const copyLength = Math.min(bytesRead, signature.byteLength - signatureLength)
            buffer.copy(signature, signatureLength, 0, copyLength)
            signatureLength += copyLength
          }
          let written = 0
          while (written < bytesRead) {
            const result = await handle.write(buffer, written, bytesRead - written)
            if (result.bytesWritten <= 0) throw new Error('附件暂存写入不完整')
            written += result.bytesWritten
          }
          offset += bytesRead
        }
        const extra = Buffer.allocUnsafe(1)
        const tail = await source.read(extra, 0, 1, sourceInfo.size)
        const sourceAfter = await source.stat()
        if (
          tail.bytesRead > 0
          || sourceAfter.size !== sourceInfo.size
          || sourceAfter.mtimeMs !== sourceInfo.mtimeMs
        ) {
          throw new Error('源文件在暂存过程中发生变化，请重新选择')
        }
        if (
          expectedImageMime !== undefined
          && !imageBytesMatchMime(signature.subarray(0, signatureLength), expectedImageMime)
        ) {
          throw new Error('图片扩展名与文件头不一致')
        }
        const writtenInfo = await handle.stat()
        if (!writtenInfo.isFile() || writtenInfo.size !== sourceInfo.size) {
          throw new Error('附件暂存大小校验失败')
        }
        return {
          ok: true,
          attachment: {
            stagedId: id,
            name,
            size: writtenInfo.size,
            mime,
          },
        }
      } finally {
        await handle.close()
      }
    } finally {
      await source.close()
    }
  } catch (e) {
    if (target !== undefined) await rm(target, { force: true }).catch(() => undefined)
    return { ok: false, error: '附件暂存失败：' + errorText(e) }
  }
}

/** 读取已暂存字节；调用方只能传消息记录里的 stagedId，不接受路径。 */
export async function readStagedAttachment(
  decryptedDir: string,
  attachment: Pick<MessageListImage, 'stagedId' | 'name' | 'size' | 'mime'>,
  maxBytes = MESSAGE_LIST_ATTACHMENT_MAX_BYTES,
): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
  const id = typeof attachment.stagedId === 'string' ? attachment.stagedId.trim() : ''
  if (!STAGED_ID_RE.test(id)) throw new Error('附件资源 id 无效')
  const path = spoolPath(decryptedDir, id)
  const limit = positiveLimit(maxBytes, MESSAGE_LIST_ATTACHMENT_MAX_BYTES)
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    throw new Error('暂存附件不存在，请重新选择文件')
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('暂存附件不是普通文件')
    if (info.size <= 0) throw new Error('暂存附件为空')
    if (info.size > limit) {
      throw new Error('暂存附件超过当前剩余预算 ' + String(limit) + ' 字节')
    }
    if (
      attachment.size !== undefined
      && (!Number.isSafeInteger(attachment.size)
        || attachment.size <= 0
        || attachment.size !== info.size)
    ) {
      throw new Error('暂存附件大小校验失败')
    }
    const bytes = Buffer.allocUnsafe(info.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead <= 0) throw new Error('暂存附件读取不完整')
      offset += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    const tail = await handle.read(extra, 0, 1, bytes.byteLength)
    if (tail.bytesRead > 0) throw new Error('暂存附件大小已变化，请重新选择文件')
    const after = await handle.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error('暂存附件在读取过程中发生变化，请重新选择文件')
    }
    const name = safeAttachmentName(attachment.name)
    const extensionMime = attachmentMime(name)
    let explicitMime: string | undefined
    if (typeof attachment.mime === 'string' && attachment.mime.trim() !== '') {
      const parsed = validAttachmentMime(attachment.mime)
      if (parsed === undefined) throw new Error('暂存附件 MIME 格式无效')
      explicitMime = parsed
    }
    const extensionImageMime = knownImageMime(extensionMime)
    if (
      extensionImageMime !== undefined
      && explicitMime !== undefined
      && explicitMime !== extensionMime
    ) {
      throw new Error('暂存附件 MIME 与文件名扩展名不一致')
    }
    const mime = explicitMime ?? extensionMime
    const expectedImageMime = extensionImageMime ?? knownImageMime(mime)
    if (expectedImageMime !== undefined && !imageBytesMatchMime(bytes, expectedImageMime)) {
      throw new Error('暂存附件 MIME 与文件头不一致')
    }
    return { bytes, name, mime }
  } finally {
    await handle.close()
  }
}

/**
 * 清理超过 7 天且没有被任何消息记录引用的本机暂存附件。
 *
 * 引用判断在调用方完成（那里能访问任务库）；这里只接受一组仍被引用的 id。
 */
export async function cleanupStagedAttachments(
  decryptedDir: string,
  referencedIds: ReadonlySet<string>,
  now = Date.now(),
): Promise<{ removed: number; failed: number }> {
  const dir = join(decryptedDir, SPOOL_DIR)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { removed: 0, failed: 0 }
  }
  let removed = 0
  let failed = 0
  for (const name of names) {
    const match = /^([0-9a-f]{40})\.bin$/i.exec(name)
    if (match === null) continue
    const id = match[1]?.toLowerCase() ?? ''
    if (referencedIds.has(id)) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (now - info.mtimeMs <= STAGED_RETENTION_MS) continue
      await rm(path)
      removed += 1
    } catch {
      // 单个文件清理失败不影响其它附件；下次再试。
      failed += 1
    }
  }
  return { removed, failed }
}
