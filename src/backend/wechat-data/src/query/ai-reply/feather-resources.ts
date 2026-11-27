/**
 * Feather 跨机资源暂存。
 *
 * 本机消息列表里的图片可能是微信本地引用、URL 或 data URL；Feather 只能
 * 读取它自己那台电脑上的路径。因此发送前先把字节上传到 Feather 的 spool，
 * 拿到资源 id，再在附件任务里引用 id。上传与发送复用 `sendRequest`，保持
 * 全仓唯一出网调用点。
 */
import { createHash } from 'node:crypto'
import { sendRequest } from '../rpa/dispatch.ts'
import type { RetryFetch } from '../../net/fetch-retry.ts'
import type { MessageListImage } from '../../types.ts'
import {
  MESSAGE_LIST_ATTACHMENT_MAX_BYTES,
  MESSAGE_LIST_ATTACHMENT_MAX_COUNT,
  MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES,
  type PublicHttpLookup,
  attachmentMime,
  controlledAttachmentUrl,
  createPublicHttpFetch,
  decodeMessageListImageDataUrl,
  readStagedAttachment,
} from '../message-list-attachments.ts'

const RESOURCE_RESPONSE_MAX_BYTES = 64 * 1024

export interface FeatherResource {
  id: string
  name: string
  size: number
  sha256: string
}

export interface FeatherResourceDeps {
  fetchImpl?: RetryFetch
  /** Test seam for the SSRF DNS boundary; production uses node:dns lookup. */
  lookup?: PublicHttpLookup
  /** Super Time 解密数据根；读取桌面端暂存附件时必需。 */
  decryptedDir?: string
  /** Resolve WeChat-local image references to bytes (a data URL is sufficient). */
  decodeImage?: (username: string, localId: number) => Promise<{ url?: string }>
  /** Test seam; production uses the shared 20 MB / 9 item message-list budget. */
  limits?: Partial<FeatherResourceLimits>
}

export interface FeatherResourceLimits {
  maxBytes: number
  totalMaxBytes: number
  maxCount: number
}

interface ResourceBytes {
  bytes: Uint8Array
  name: string
  mime: string
}

function retrySpec(): {
  maxAttempts: number
  retryOn: Array<'network' | 'http-5xx' | 'http-429'>
} {
  return {
    maxAttempts: 2,
    retryOn: ['network', 'http-5xx', 'http-429'],
  }
}

function positiveLimit(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function limitsOf(deps: FeatherResourceDeps): FeatherResourceLimits {
  return {
    maxBytes: positiveLimit(deps.limits?.maxBytes, MESSAGE_LIST_ATTACHMENT_MAX_BYTES),
    totalMaxBytes: positiveLimit(
      deps.limits?.totalMaxBytes,
      MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES,
    ),
    maxCount: positiveLimit(deps.limits?.maxCount, MESSAGE_LIST_ATTACHMENT_MAX_COUNT),
  }
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

function tokenizedResourceUrl(webhookUrl: string): string {
  let url: URL
  try {
    url = new URL(webhookUrl)
  } catch {
    throw new Error(' Webhook 地址无效')
  }
  if (!/^\/webhook\/[^/]+\/?$/i.test(url.pathname)) {
    throw new Error('资源上传只支持 /webhook/<token> 地址')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/resources'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function safeName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? ''
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 120)
  return cleaned === '' ? fallback : cleaned
}

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  return (match?.[1] ?? '').toLowerCase()
}

function remoteUrlName(url: string): string {
  try {
    const encoded = new URL(url).pathname.split('/').at(-1) ?? ''
    let decoded = encoded
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      // Keep the encoded path segment; safeName below still strips unsafe characters.
    }
    return safeName(decoded, '')
  } catch {
    // controlledAttachmentUrl already parsed this URL; this is only a defensive fallback.
    return ''
  }
}

function remoteResourceName(image: MessageListImage, url: string): string {
  const explicit = safeName(image.name ?? '', '')
  if (extensionOf(explicit) !== '') return explicit
  const urlName = remoteUrlName(url)
  if (extensionOf(urlName) !== '') return urlName
  return explicit !== '' ? explicit : urlName !== '' ? urlName : 'attachment.bin'
}

function dataUrlBytes(dataUrl: string, maxBytes: number): ResourceBytes {
  const decoded = decodeMessageListImageDataUrl(dataUrl, maxBytes)
  if (decoded === undefined) {
    throw new Error('图片 data URL 的 MIME、base64 或图片内容无效')
  }
  const ext = decoded.mime === 'image/jpeg' ? 'jpg' : decoded.mime.slice('image/'.length)
  return {
    bytes: decoded.bytes,
    name: 'image.' + ext,
    mime: decoded.mime,
  }
}

function imageBytes(image: MessageListImage, maxBytes: number): ResourceBytes {
  if (typeof image.dataUrl === 'string' && image.dataUrl !== '') {
    const decoded = dataUrlBytes(image.dataUrl, maxBytes)
    return {
      ...decoded,
      name: safeName(image.name ?? decoded.name, decoded.name),
    }
  }
  throw new Error('图片缺少可上传的 data URL；远程 URL 或微信本地引用需先由调用方解析')
}

function resourceFromBody(bodyText: string): FeatherResource {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    throw new Error('资源上传返回非 JSON')
  }
  const id = typeof body['id'] === 'string' ? body['id'].trim() : ''
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  const size = Number(body['size'])
  const sha256 = typeof body['sha256'] === 'string' ? body['sha256'].trim().toLowerCase() : ''
  if (body['ok'] !== true || !/^[0-9a-f]{40}$/.test(id)
    || !Number.isSafeInteger(size) || size <= 0
    || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('资源上传响应无效')
  }
  return { id, name: safeName(name, 'resource'), size, sha256 }
}

/** 上传一张图片或一个文件到 Feather 本机 spool；失败即整条记录失败，不静默丢图。 */
export async function uploadFeatherResource(
  webhookUrl: string,
  input: ResourceBytes,
  deps: FeatherResourceDeps = {},
): Promise<FeatherResource> {
  const limits = limitsOf(deps)
  if (input.bytes.byteLength <= 0) throw new Error('资源为空')
  if (input.bytes.byteLength > limits.maxBytes) {
    throw new Error('资源超过 ' + String(limits.maxBytes) + ' 字节单附件上限')
  }
  const name = safeName(input.name, 'resource.bin')
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const response = await sendRequest({
    method: 'POST',
    url: tokenizedResourceUrl(webhookUrl),
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(input.bytes.byteLength),
      'x-feather-filename': name,
      'x-feather-sha256': sha256,
    },
    body: '',
    bodyBytes: input.bytes,
    contentType: 'application/octet-stream',
    responseType: 'bytes',
    maxResponseBytes: RESOURCE_RESPONSE_MAX_BYTES,
  }, deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }, retrySpec())
  if (response.status !== 200 && response.status !== 201) {
    throw new Error('资源上传失败：HTTP ' + String(response.status))
  }
  const text = new TextDecoder().decode(response.bodyBytes ?? new Uint8Array())
  const resource = resourceFromBody(text)
  if (resource.sha256 !== sha256 || resource.size !== input.bytes.byteLength) {
    throw new Error('资源上传校验失败')
  }
  return resource
}

/**
 * 把消息记录里的图片解析为可上传字节。URL 由本机先取回（仍走 sendRequest），
 * 微信本地引用由调用方通过 decodeImage 转成 data URL 后注入。
 */
export async function uploadMessageListImages(
  webhookUrl: string,
  images: MessageListImage[],
  chatUsername: string,
  deps: FeatherResourceDeps = {},
): Promise<string[]> {
  const limits = limitsOf(deps)
  if (images.length > limits.maxCount) {
    throw new Error('单次最多发送 ' + String(limits.maxCount) + ' 个附件')
  }
  const resources: ResourceBytes[] = []
  let totalBytes = 0
  const account = (bytes: Uint8Array): void => {
    if (bytes.byteLength <= 0) throw new Error('附件为空')
    if (bytes.byteLength > limits.maxBytes) {
      throw new Error('附件超过 ' + String(limits.maxBytes) + ' 字节单附件上限')
    }
    if (bytes.byteLength > limits.totalMaxBytes - totalBytes) {
      throw new Error('附件总大小超过 ' + String(limits.totalMaxBytes) + ' 字节预算')
    }
    totalBytes += bytes.byteLength
  }

  for (const image of images) {
    let resource: ResourceBytes
    const remaining = limits.totalMaxBytes - totalBytes
    const currentMaxBytes = Math.min(limits.maxBytes, remaining)
    if (remaining <= 0) {
      throw new Error('附件总大小超过 ' + String(limits.totalMaxBytes) + ' 字节预算')
    }
    const sourceCount = [
      typeof image.stagedId === 'string' && image.stagedId !== '',
      typeof image.url === 'string' && image.url !== '',
      typeof image.dataUrl === 'string' && image.dataUrl !== '',
      image.localId !== undefined && image.localId > 0,
    ].filter(Boolean).length
    if (sourceCount !== 1) {
      throw new Error('每个附件必须且只能提供 stagedId、url、dataUrl、localId 之一')
    }
    if (typeof image.stagedId === 'string' && image.stagedId !== '') {
      if (deps.decryptedDir === undefined) throw new Error('暂存附件缺少数据目录')
      resource = await readStagedAttachment(deps.decryptedDir, image, currentMaxBytes)
    } else if (typeof image.url === 'string' && image.url !== '') {
      const url = controlledAttachmentUrl(image.url)
      if (url === undefined) throw new Error('附件 URL 必须是受控 http(s) 地址')
      const remoteFetch = deps.lookup === undefined
        ? (deps.fetchImpl ?? createPublicHttpFetch())
        : createPublicHttpFetch({
            lookup: deps.lookup,
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          })
      const response = await sendRequest({
        method: 'GET',
        url,
        headers: {},
        body: '',
        contentType: 'application/octet-stream',
        responseType: 'bytes',
        maxResponseBytes: Math.min(limits.maxBytes, remaining + 1),
      }, { fetchImpl: remoteFetch }, retrySpec())
      // 206 只代表 Range 响应的一段，不能把局部字节当成完整附件上传。
      if (response.status !== 200) {
        throw new Error('图片下载失败：HTTP ' + String(response.status))
      }
      const bytes = response.bodyBytes ?? new Uint8Array()
      const name = remoteResourceName(image, url)
      const mime = attachmentMime(name)
      resource = { bytes, name, mime }
    } else {
      if (image.localId !== undefined && image.localId > 0 && deps.decodeImage !== undefined) {
        if (chatUsername === '') throw new Error('微信本地图片缺少会话 username')
        const decoded = await deps.decodeImage(chatUsername, image.localId)
        if (typeof decoded.url !== 'string' || decoded.url === '') {
          throw new Error('微信本地图片解码失败')
        }
        resource = imageBytes(
          { dataUrl: decoded.url, ...(image.name === undefined ? {} : { name: image.name }) },
          limits.maxBytes,
        )
      } else {
        resource = imageBytes(image, limits.maxBytes)
      }
    }
    account(resource.bytes)
    resources.push(resource)
  }

  const ids: string[] = []
  for (const resource of resources) {
    ids.push((await uploadFeatherResource(webhookUrl, resource, deps)).id)
  }
  return ids
}

/** 为调用方提供稳定的错误文案，避免把 fetch 的底层对象直接落库。 */
export function featherResourceError(e: unknown): string {
  return errorText(e).slice(0, 500)
}
