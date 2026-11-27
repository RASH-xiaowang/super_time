/**
 * 内置触发方式：**Webhook**（把整条触发记录 POST 到用户填写的地址）。
 *
 * 两种图片传输模式：
 *  · `dataUrl`（默认，兼容旧接收端）：整条记录仍是 JSON，图片为 base64 data URL；
 *  · `multipart`：`payload` part 是同一份 JSON 元数据，图片按 `images` 文件 part 发原始字节，
 *    避免 base64 的约 33% 额外体积，也不会在请求体里出现 data URL。
 *
 * 图片逐张解码；单张失败只给该图片写 `error`，不影响其它图片和整条回调。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RpaVendorDescriptor } from '../../../types-rpa.ts'
import type { TaskCallbackPayload } from '../../../types.ts'
import { RPA_PARAM_SOURCES } from '../param-sources.ts'
import { resolveMapped } from '../template.ts'
import type {
  RpaBuildDeps,
  RpaHttpRequest,
  RpaInvocationContext,
  RpaRecordContext,
  RpaVendorAdapter,
} from '../types.ts'

/** 单张图片 data URL 的字符上限（约 6 MB 原始字节；超过就省略该张而不是把整条回调撑爆）。 */
const IMAGE_DATA_URL_MAX = 8_000_000
/** multipart 单张/整单原始字节上限：防止一次回调把进程内存和接收端连接撑爆。 */
const MULTIPART_IMAGE_MAX_BYTES = 20 * 1024 * 1024
const MULTIPART_TOTAL_MAX_BYTES = 60 * 1024 * 1024
/** multipart 固定字段名（接收端按这两个名字取值）。 */
const MULTIPART_PAYLOAD_FIELD = 'payload'
const MULTIPART_IMAGE_FIELD = 'images'
/** 单条失败原因的落库/上报上限（与旧实现同口径）。 */
const ERROR_TEXT_MAX = 500

const descriptor: RpaVendorDescriptor = {
  id: 'webhook',
  name: 'Webhook',
  vendor: '内置 Webhook（标准 HTTP POST）',
  version: '1.2.0',
  summary: '把整条触发记录（含图片）POST 到你填写的地址；附加参数放进 params，支持 JSON base64 与 multipart 二进制。',
  status: 'stable',
  docs: {
    home: 'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Methods/POST',
    triggerApi: 'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Methods/POST',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '内置通道（非厂商 API，2026-10-21 回归核对）',
  },
  capabilities: {
    direction: 'outbound',
    synchronous: true,
    completion: 'none',
    idempotency: 'none',
    deployment: ['cloud', 'onprem'],
  },
  fields: [
    {
      key: 'url',
      label: '回调地址',
      ariaLabel: 'Webhook 地址',
      type: 'text',
      required: true,
      example: 'https://example.com/rpa/callback',
      pattern: '^https?://',
      summary: true,
      help: '只支持 http/https；由你自行保证对端可达并返回 2xx。',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: [...RPA_PARAM_SOURCES],
      help: 'Webhook 仍发送整条触发记录；这里配置的条目会额外放进请求体的 params。默认 params={}，需要会话名 / 触发文本 / 触发对象等字段时逐条添加。',
    },
    {
      key: 'imageDelivery',
      label: '图片传输方式',
      type: 'select',
      required: false,
      advanced: true,
      defaultValue: 'dataUrl',
      options: [
        { value: 'dataUrl', label: 'JSON data URL（兼容旧接收端）' },
        { value: 'multipart', label: 'multipart/form-data（推荐，省约 1/3 体积）' },
        { value: 'lanUrl', label: '局域网链接（对方用 URL 取图）' },
      ],
      help: '局域网链接不把图片字节放进请求体：每张图带一个 http://本机局域网地址/api/rpa-media/… 的短时地址，同一局域网里的机器用这个 URL 取文件。需要先打开「局域网访问」。',
    },
  ],
  auth: {
    // 内置 Webhook 没有凭据：不做任何鉴权（地址本身即用户配置的接收端）。
    modes: [],
  },
  mapping: {
    style: 'object',
    targets: [],
    extrasField: 'extraParams',
  },
  request: {
    method: 'POST',
    url: '${config.url}',
    headers: { 'Content-Type': 'application/json' },
    body: {
      taskId: '${invocation.taskId}',
      recordId: '${invocation.recordId}',
      keyword: '${record.keyword}',
      text: '${record.text}',
    },
  },
  response: {
    okHttpStatus: [200, 201, 202, 204],
  },
  retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx', 'http-429'] },
  governance: {
    contentOutbound: true,
    // 内置 Webhook：hosts 为空 + allowCustomBaseUrl 由核心特判为「任意 http(s)」——
    // 保持旧版「用户自担地址」的口径（旧版允许本机/内网地址）。
    hosts: [],
    allowCustomBaseUrl: true,
    privacySection: 'G3',
  },
  risks: [
    '地址由用户填写：对端不可达或返回非 2xx 时记为失败，最多尝试 2 次（含首次）',
    'dataUrl 模式单张超过约 6MB、multipart 模式单张超过 20MB 或整单超过 60MB，只省略该张并带上 error',
    '隐私闸只对触发文本脱敏（功能名 task_callback），图片不做打码',
  ],
  notes: [
    '默认 imageDelivery=dataUrl，与旧接收端逐字段兼容；改用 multipart 前请确认接收端能从 payload/images 两个字段读取。',
    'lanUrl 复用已有局域网监听面的 /api/rpa-media/<令牌>，一个地址只对应一张图，默认 1 小时过期；未打开局域网访问时该张写 error，不发取不到的地址。',
    '旧版 paramMap 从未影响 Webhook 请求体，因此不自动迁移；如确实需要对应字段，请在「附加参数」里重新添加。',
  ],
}

/** 文件扩展名 → data URL 的 MIME（未知按 jpeg，与解码器默认输出一致）。 */
function imageMimeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}

/** 图片路径是否安全（只接受 `decodedDir` 内的相对路径，拒绝绝对路径与 `..`）。 */
function isSafeDecodedPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  if (normalized.startsWith('..') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false
  return normalized !== ''
}

/** 统一把异常转成可读文本（未知值走 String）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 同一份回调信封（不含图片数组），两种传输模式共用。 */
function callbackEnvelope(ctx: RpaInvocationContext): Omit<TaskCallbackPayload, 'images'> {  const record = ctx.record
  const mapped = resolveMapped(descriptor, ctx)
  if (typeof mapped !== 'object' || mapped === null || Array.isArray(mapped)) {
    throw new Error('Webhook 附加参数解析失败：params 必须是对象')
  }
  return {
    taskId: ctx.taskId,
    taskName: ctx.taskName,
    recordId: ctx.recordId,
    triggeredAt: record.triggeredAt,
    triggeredAtText: new Date(record.triggeredAt).toLocaleString('zh-CN', { hour12: false }),
    chat: { username: record.username, name: record.chatName, type: record.chatType },
    target: { username: record.targetUsername, name: record.targetName },
    keyword: record.keyword,
    text: record.text,
    texts: (record.texts ?? []).map((item) => ({
      localId: item.localId,
      createTime: item.createTime,
      sender: item.sender,
      text: item.text,
    })),
    params: mapped as Record<string, string>,
  }
}

/**
 * 把一条记录的图片引用解码成回调里的 base64 / 错误说明。
 *
 * 单张失败不影响其它：解不出来就写 `error`（用户能看出「这张没带上」），
 * 而不是伪造一张图或让整条回调失败。单张超过 {@link IMAGE_DATA_URL_MAX} 同样省略。
 * @param record - 触发记录快照（含图片引用清单）。
 * @param deps - 图片解码依赖（解码缓存根 + 解码函数）。
 * @returns 回调请求体里的 images 数组。
 */
async function buildPayloadImages(
  record: RpaRecordContext,
  deps: RpaBuildDeps,
): Promise<TaskCallbackPayload['images']> {
  return Promise.all(record.images.map((image) => buildOnePayloadImage(record, image, deps)))
}

/** 把已经签好的局域网地址补到对应图片上。没有地址的那张保持原样。 */
function withLanUrls(
  images: TaskCallbackPayload['images'],
  links: RpaInvocationContext['imageLinks'],
): TaskCallbackPayload['images'] {
  return images.map((image, index) => {
    const url = links[index]?.url
    return typeof url === 'string' && url !== '' ? { ...image, url } : image
  })
}

/** 解码一张回调图片。失败只写在这一张的 `error` 上，不拖住同一批里的其它图片。 */
async function buildOnePayloadImage(
  record: RpaRecordContext,
  image: RpaRecordContext['images'][number],
  deps: RpaBuildDeps,
): Promise<TaskCallbackPayload['images'][number]> {
  const item: TaskCallbackPayload['images'][number] = {
    localId: image.localId,
    createTime: image.createTime,
    sender: image.sender,
  }
  if (image.md5 !== undefined) item.md5 = image.md5
  try {
    const decoded = await deps.decodeImage(record.username, image.localId)
    let dataUrl = typeof decoded.url === 'string' ? decoded.url : ''
    if (dataUrl === '' && typeof decoded.file === 'string' && decoded.file !== '') {
      if (!isSafeDecodedPath(decoded.file)) {
        item.error = '图片路径超出解码目录，已省略'
      } else {
        const bytes = await readFile(join(deps.decodedDir, decoded.file))
        dataUrl = 'data:' + imageMimeOf(decoded.file) + ';base64,' + bytes.toString('base64')
      }
    }
    if (item.error === undefined) {
      if (dataUrl === '') item.error = '图片解码失败'
      else if (dataUrl.length > IMAGE_DATA_URL_MAX) item.error = '图片过大，已省略'
      else item.dataUrl = dataUrl
    }
  } catch (error) {
    item.error = errorText(error).slice(0, ERROR_TEXT_MAX)
  }
  return item
}

/** 组装旧版同形状的回调请求体（字段顺序与含义不变，便于对端逐字节对照）。 */
async function buildCallbackPayload(
  ctx: RpaInvocationContext,
  deps: RpaBuildDeps,
): Promise<TaskCallbackPayload> {
  const images = await buildPayloadImages(ctx.record, deps)
  return { ...callbackEnvelope(ctx), images: withLanUrls(images, ctx.imageLinks) }
}

/** multipart 中的图片元数据（文件字段/文件名/大小/摘要用于接收端校验）。 */
interface MultipartImageMetadata {
  localId: number
  createTime: number
  sender: string
  md5?: string
  error?: string
  fileField?: string
  filename?: string
  contentType?: string
  size?: number
  sha256?: string
}

/** multipart 回调信封（与 dataUrl 模式字段相同，仅 images 增加文件描述）。 */
interface MultipartCallbackPayload extends Omit<TaskCallbackPayload, 'images'> {
  images: MultipartImageMetadata[]
}

/** 一张待写入 multipart 的图片文件。 */
interface MultipartFile {
  filename: string
  contentType: string
  bytes: Buffer
}

/** data URL → 原始字节（仅在 fileOnly 解码仍回退 data URL 时使用）。 */
function bytesFromDataUrl(dataUrl: string): { bytes: Buffer; mime: string } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl)
  if (match === null) return null
  try {
    return { bytes: Buffer.from(match[2] ?? '', 'base64'), mime: match[1] ?? 'image/jpeg' }
  } catch {
    return null
  }
}

/** MIME → 安全扩展名（文件名由本模块生成，不采信远端输入）。 */
function imageExtensionOf(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/bmp') return 'bmp'
  return 'jpg'
}

/** 一张已经读进内存、尚未计入整单上限的 multipart 图片。 */
interface MultipartCandidate {
  item: MultipartImageMetadata
  bytes: Buffer | null
  mime: string
  index: number
}

/** 并行读取一张 multipart 图片。整单上限留到全部读完后按原顺序裁。 */
async function readMultipartCandidate(
  record: RpaRecordContext,
  image: RpaRecordContext['images'][number],
  index: number,
  deps: RpaBuildDeps,
): Promise<MultipartCandidate> {
  const item: MultipartImageMetadata = {
    localId: image.localId,
    createTime: image.createTime,
    sender: image.sender,
  }
  if (image.md5 !== undefined) item.md5 = image.md5
  let bytes: Buffer | null = null
  let mime = 'image/jpeg'
  try {
    const decoded = await deps.decodeImage(record.username, image.localId, { fileOnly: true })
    if (typeof decoded.file === 'string' && decoded.file !== '') {
      if (!isSafeDecodedPath(decoded.file)) {
        item.error = '图片路径超出解码目录，已省略'
      } else {
        const abs = join(deps.decodedDir, decoded.file)
        const info = await stat(abs)
        if (!info.isFile()) throw new Error('解码结果不是文件')
        if (info.size > MULTIPART_IMAGE_MAX_BYTES) item.error = '图片过大，已省略'
        else {
          bytes = await readFile(abs)
          mime = imageMimeOf(decoded.file)
        }
      }
    } else if (typeof decoded.url === 'string' && decoded.url !== '') {
      const fallback = bytesFromDataUrl(decoded.url)
      if (fallback === null) item.error = '图片解码失败'
      else if (fallback.bytes.length > MULTIPART_IMAGE_MAX_BYTES) item.error = '图片过大，已省略'
      else {
        bytes = fallback.bytes
        mime = fallback.mime
      }
    } else {
      item.error = '图片解码失败'
    }
  } catch (error) {
    item.error = errorText(error).slice(0, ERROR_TEXT_MAX)
    bytes = null
  }
  return { item, bytes, mime, index }
}

/**
 * 逐张读取图片文件并生成 multipart 元数据/文件 part。
 * 解码并行；单张失败、超单张上限或累计超整单上限时只给该项写 `error`。
 */
async function buildMultipartImages(
  record: RpaRecordContext,
  deps: RpaBuildDeps,
): Promise<{ images: MultipartImageMetadata[]; files: MultipartFile[] }> {
  const loaded = await Promise.all(record.images.map((image, index) => (
    readMultipartCandidate(record, image, index, deps)
  )))
  const images: MultipartImageMetadata[] = []
  const files: MultipartFile[] = []
  let totalBytes = 0
  for (const candidate of loaded) {
    const item = candidate.item
    const bytes = candidate.bytes
    if (item.error === undefined && bytes !== null) {
      if (totalBytes + bytes.length > MULTIPART_TOTAL_MAX_BYTES) {
        item.error = '图片总量过大，已省略'
      } else {
        const filename = `image-${String(candidate.index + 1).padStart(2, '0')}.${imageExtensionOf(candidate.mime)}`
        item.fileField = MULTIPART_IMAGE_FIELD
        item.filename = filename
        item.contentType = candidate.mime
        item.size = bytes.length
        item.sha256 = createHash('sha256').update(bytes).digest('hex')
        totalBytes += bytes.length
        files.push({ filename, contentType: candidate.mime, bytes })
      }
    }
    images.push(item)
  }
  return { images, files }
}

/** 拼装可重放的 multipart 请求体（Buffer 每次重试复用同一份字节）。 */
function encodeMultipart(payload: MultipartCallbackPayload, files: MultipartFile[]): {
  body: Buffer
  contentType: string
} {
  const boundary = '----SuperTimeWebhook' + randomUUID().replace(/-/g, '')
  const chunks: Buffer[] = []
  const push = (text: string): void => { chunks.push(Buffer.from(text, 'utf8')) }
  push(`--${boundary}\r\n`)
  push(`Content-Disposition: form-data; name="${MULTIPART_PAYLOAD_FIELD}"\r\n`)
  push('Content-Type: application/json; charset=utf-8\r\n\r\n')
  push(JSON.stringify(payload))
  push('\r\n')
  for (const file of files) {
    push(`--${boundary}\r\n`)
    push(`Content-Disposition: form-data; name="${MULTIPART_IMAGE_FIELD}"; filename="${file.filename}"\r\n`)
    push(`Content-Type: ${file.contentType}\r\n\r\n`)
    chunks.push(file.bytes)
    push('\r\n')
  }
  push(`--${boundary}--\r\n`)
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

/**
 * 局域网链接模式的图片清单。
 *
 * 链接在投递前已经签好（`ctx.imageLinks`）。没有签出来时不编造地址，每张写明原因。
 */
function lanImagesOf(ctx: RpaInvocationContext): TaskCallbackPayload['images'] {
  const refs = ctx.record.images
  const links = ctx.imageLinks
  if (links.length === refs.length) {
    return links.map((link, index) => {
      const ref = refs[index]
      const item: TaskCallbackPayload['images'][number] = {
        localId: link.localId,
        createTime: link.createTime,
        sender: link.sender,
      }
      const md5 = link.md5 ?? ref?.md5
      if (md5 !== undefined && md5 !== '') item.md5 = md5
      if (typeof link.url === 'string' && link.url !== '') item.url = link.url
      if (typeof link.error === 'string' && link.error !== '') item.error = link.error
      return item
    })
  }
  return refs.map((image) => {
    const item: TaskCallbackPayload['images'][number] = {
      localId: image.localId,
      createTime: image.createTime,
      sender: image.sender,
      error: '未生成图片链接：本机未打开局域网访问（设置 → 维护与自检 → 局域网访问）',
    }
    if (image.md5 !== undefined && image.md5 !== '') item.md5 = image.md5
    return item
  })
}

/** 组装 multipart 请求（payload JSON + images 原始文件）。 */
async function buildMultipartRequest(
  ctx: RpaInvocationContext,
  deps: RpaBuildDeps,
): Promise<RpaHttpRequest> {
  const { images, files } = await buildMultipartImages(ctx.record, deps)
  const payload: MultipartCallbackPayload = { ...callbackEnvelope(ctx), images }
  const encoded = encodeMultipart(payload, files)
  return {
    method: 'POST',
    url: '',
    headers: { 'Content-Type': encoded.contentType },
    body: '',
    bodyBytes: encoded.body,
    contentType: encoded.contentType,
  }
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装 Webhook 请求：按 `config.imageDelivery` 选择 JSON data URL 或 multipart 文件。
   * @param ctx - 投递上下文（text 已过隐私闸）。
   * @param deps - 图片解码依赖。
   * @returns 可直接发送的 POST 请求。
   * @throws 任务未配置回调地址时抛可读错误。
   */
  async buildRequest(ctx: RpaInvocationContext, deps: RpaBuildDeps): Promise<RpaHttpRequest> {
    const rawUrl = ctx.config['url']
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    if (url === '') throw new Error('Webhook 投递失败：任务未配置回调地址')
    if (ctx.config['imageDelivery'] === 'multipart') {
      const multipart = await buildMultipartRequest(ctx, deps)
      return { ...multipart, url }
    }
    if (ctx.config['imageDelivery'] === 'lanUrl') {
      const payload = { ...callbackEnvelope(ctx), images: lanImagesOf(ctx) }
      return {
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        contentType: 'application/json',
      }
    }
    const payload = await buildCallbackPayload(ctx, deps)
    return {
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      contentType: 'application/json',
    }
  },
}
