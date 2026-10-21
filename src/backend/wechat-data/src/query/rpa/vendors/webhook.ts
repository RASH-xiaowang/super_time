/**
 * 内置触发方式：**Webhook**（把整条触发记录 JSON POST 到用户逐条填写的地址）。
 *
 * 这是 2026-10-21 之前就有的能力，多厂商改造后成为注册表里的第一个内置厂商：
 *  · URL 来自任务配置 `config.url`（用户填写，只允许 http/https）；
 *  · 请求体沿用 `TaskCallbackPayload` 的形状（任务/记录 id、时间、会话、触发对象、关键词、
 *    已过隐私闸的触发文本、图片 data URL 数组）——**字段一个都不变**；
 *  · 图片逐张解码：解不出来或单张超过约 6MB 时只省略该张并带上 `error`，不让整条回调失败。
 *
 * 由于 payload 形状无法用声明式模板表达（要读图片、要格式化本地时间），本厂商用
 * `buildRequest` 钩子整体组装请求；核心管道只负责主机校验、发送与解析。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RpaVendorDescriptor, RpaMappingTarget } from '../../../types-rpa.ts'
import type { TaskCallbackPayload } from '../../../types.ts'
import type {
  RpaBuildDeps,
  RpaHttpRequest,
  RpaInvocationContext,
  RpaRecordContext,
  RpaVendorAdapter,
} from '../types.ts'

/** 单张图片 data URL 的字符上限（约 6 MB 原始字节；超过就省略该张而不是把整条回调撑爆）。 */
const IMAGE_DATA_URL_MAX = 8_000_000
/** 单条失败原因的落库/上报上限（与旧实现同口径）。 */
const ERROR_TEXT_MAX = 500

/** 三个语义参数位的默认映射键（Webhook 发整条记录，映射只用于描述符完整性/未来扩展）。 */
const MAPPING_TARGETS: RpaMappingTarget[] = [
  { semantic: 'room', defaultKey: 'room_name' },
  { semantic: 'content', defaultKey: 'content' },
  { semantic: 'at', defaultKey: 'at_name' },
]

const descriptor: RpaVendorDescriptor = {
  id: 'webhook',
  name: 'Webhook',
  vendor: '内置 Webhook（标准 HTTP POST）',
  version: '1.0.0',
  summary: '把整条触发记录（含图片）JSON POST 到你填写的地址；默认触发方式，行为与旧版一致。',
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
      key: 'paramMap',
      label: '参数映射',
      type: 'map',
      required: false,
      advanced: true,
      defaultValue: { room: 'room_name', content: 'content', at: 'at_name' },
      help: 'Webhook 发送整条触发记录，不使用参数映射；保留此项仅为描述符完整性。',
    },
  ],
  auth: {
    // 内置 Webhook 没有凭据：不做任何鉴权（地址本身即用户配置的接收端）。
    modes: [],
  },
  mapping: {
    style: 'object',
    mapField: 'paramMap',
    targets: MAPPING_TARGETS,
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
    '图片逐张解码：单张超过约 6MB 或解码失败时只省略该张并带上 error',
    '隐私闸只对触发文本脱敏（功能名 task_callback），图片不做打码',
  ],
  notes: [
    '内置通道（非厂商 API）：请求体形状与 2026-10-21 之前逐字段一致（TaskCallbackPayload + 图片 data URL）。',
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
  const out: TaskCallbackPayload['images'] = []
  for (const image of record.images) {
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
          const bytes = readFileSync(join(deps.decodedDir, decoded.file))
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
    out.push(item)
  }
  return out
}

/** 组装旧版同形状的回调请求体（字段顺序与含义不变，便于对端逐字节对照）。 */
async function buildCallbackPayload(
  ctx: RpaInvocationContext,
  deps: RpaBuildDeps,
): Promise<TaskCallbackPayload> {
  const record = ctx.record
  const images = await buildPayloadImages(record, deps)
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
    images,
  }
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装 Webhook 请求：整条触发记录 JSON + 图片 data URL。
   * @param ctx - 投递上下文（text 已过隐私闸）。
   * @param deps - 图片解码依赖。
   * @returns 可直接发送的 POST 请求。
   * @throws 任务未配置回调地址时抛可读错误。
   */
  async buildRequest(ctx: RpaInvocationContext, deps: RpaBuildDeps): Promise<RpaHttpRequest> {
    const rawUrl = ctx.config['url']
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    if (url === '') throw new Error('Webhook 投递失败：任务未配置回调地址')
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
