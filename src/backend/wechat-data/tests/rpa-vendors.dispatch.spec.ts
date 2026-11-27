// @vitest-environment node
/**
 * 多 RPA 厂商**派发管道行为守卫**（2026-10-21）。
 *
 * 用注入的 `fetchImpl` mock 对 7 家厂商各跑一遍 `dispatchRpaRecord`（不联网），逐家断言：
 *  · 请求 URL / method 与描述符一致（含固定主机、路径分支、token 换取的先后顺序）；
 *  · 三个语义参数按各自的容器形态正确映射（object / nameValueArray / nameValueTypeArray /
 *    jsonStringObject / MCP parameters[]）；
 *  · **凭据不进请求体**（八爪鱼 Key、Webhook 地址形态、阿里云 SK、来也令牌、实在 AppSecret 等）：
 *    凭据只允许出现在厂商规定的位置（header / form body 的 AccessKeyId / 换 token 请求）；
 *  · 成功时解析出 externalTaskId（影刀 jobUuid / UiPath Job.Key / 阿里云 TaskId / 来也 taskIds[0] /
 *    实在 workUuid），失败（HTTP 非 2xx、业务码失败）归类为 failed；
 *  · 无幂等键的厂商（实在/来也/UiPath）只发 1 次；Webhook/八爪鱼保持旧行为（最多 2 次）。
 *
 * 所有用例都走真实管道代码（template/auth/dispatch），只有 fetch 是假的。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearTokenCache } from '../src/query/rpa/auth.ts'
import { dispatchRpaRecord } from '../src/query/rpa/dispatch.ts'
import type { RetryFetch } from '../src/net/fetch-retry.ts'
import type {
  RpaBuildDeps,
  RpaDispatchDeps,
  RpaDispatchOutcome,
  RpaInvocationContext,
  RpaVendorAdapter,
} from '../src/query/rpa/types.ts'
import type { TaskTriggerImage } from '../src/types-taskcenter.ts'
import { adapter as webhook } from '../src/query/rpa/vendors/webhook.ts'
import { adapter as bazhuayu } from '../src/query/rpa/vendors/bazhuayu.ts'

/** 一次被 mock 记录下来的请求（headers 已 lower-case，便于断言）。 */
interface HttpCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  bodyBytes?: Uint8Array
}

/** mock 响应：`body` 会被 JSON.stringify；或直接给 `rawBody`。 */
interface MockResponse {
  status?: number
  body?: unknown
  rawBody?: string
}

type Responder = (call: HttpCall, index: number) => MockResponse

/** 构造一个记录请求、按 responder 应答的 fetch mock（不联网）。 */
function createTransport(responder: Responder | MockResponse): { deps: RpaDispatchDeps; calls: HttpCall[] } {
  const calls: HttpCall[] = []
  const fetchImpl: RetryFetch = async (input, init) => {
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders !== undefined && rawHeaders !== null && !Array.isArray(rawHeaders) && !(rawHeaders instanceof Headers)) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[key.toLowerCase()] = String(value)
      }
    }
    const call: HttpCall = {
      url: String(input),
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
      ...(init?.body instanceof Uint8Array ? { bodyBytes: new Uint8Array(init.body) } : {}),
    }
    calls.push(call)
    const spec = typeof responder === 'function' ? responder(call, calls.length - 1) : responder
    const text = spec.rawBody !== undefined ? spec.rawBody : JSON.stringify(spec.body ?? {})
    return new Response(text, { status: spec.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { deps: { fetchImpl }, calls }
}

/** 测试图片引用（Webhook 解码用）。 */
const IMAGE_REFS: TaskTriggerImage[] = [
  { localId: 101, createTime: 1_760_000_000_000, sender: '张三', md5: 'md5-1' },
  { localId: 102, createTime: 1_760_000_000_100, sender: '张三' },
]

/** 投递上下文：默认群聊、目标成员张三、触发文本 `你好 RPA`。 */
function makeCtx(
  config: Record<string, unknown>,
  secrets: Record<string, string> = {},
  recordOverride: Partial<RpaInvocationContext['record']> = {},
): RpaInvocationContext {
  return {
    taskId: 7,
    recordId: 11,
    idempotencyKey: '7:11',
    taskName: '测试任务',
    config: config as RpaInvocationContext['config'],
    secrets,
    imageLinks: [],
    record: {
      username: 'wxid_self',
      chatName: '测试群',
      chatType: 'group',
      targetName: '张三',
      targetUsername: 'wxid_zs',
      text: '你好 RPA',
      keyword: 'RPA',
      triggeredAt: 1_760_000_000_000,
      images: [],
      ...recordOverride,
    },
  }
}

/** 图片解码桩：101 成功（data URL），其它解不出来（模拟单张失败）。 */
async function decodeImage(_username: string, localId: number): Promise<{ url?: string; file?: string }> {
  return localId === 101 ? { url: 'data:image/png;base64,AAAA' } : {}
}

let scratch: string[] = []
beforeEach(() => {
  clearTokenCache()
  scratch = []
})
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** 建临时解码目录（Webhook 的 buildDeps.decodedDir）。 */
function makeDecodedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rpa-vendors-'))
  scratch.push(dir)
  return dir
}

/** 跑一次派发（buildDeps 每次新建，避免用例间共享）。 */
async function dispatch(
  adapter: RpaVendorAdapter,
  ctx: RpaInvocationContext,
  deps: RpaDispatchDeps,
  buildDeps: RpaBuildDeps = { decodedDir: makeDecodedDir(), decodeImage },
): Promise<RpaDispatchOutcome> {
  return dispatchRpaRecord({ adapter, ctx, deps, buildDeps })
}

/** 断言请求体是 JSON 并返回对象。 */
function bodyJson(call: HttpCall): Record<string, unknown> {
  const parsed = JSON.parse(call.body) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('请求体不是 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 把换 token 请求体解析成字段字典：兼容 form-urlencoded（官方 OAuth 要求）与 JSON
 * 两种形态（核心 auth 层当前对对象体序列化为 JSON；两种都认，修哪边都不影响本断言）。
 */
function tokenBodyFields(call: HttpCall): Record<string, string> {
  const text = call.body.trim()
  if (text.startsWith('{')) {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) out[key] = String(value)
    return out
  }
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

describe('Webhook（内置）', () => {
  it('成功：整条记录 JSON + 空 params + 图片 data URL；地址只在 URL，凭据无', async () => {
    const transport = createTransport({ status: 200, body: { ok: true } })
    const ctx = makeCtx({ url: 'https://hook.example.com/cb' }, {}, { images: IMAGE_REFS })
    const outcome = await dispatch(webhook, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0]
    expect(call?.url).toBe('https://hook.example.com/cb')
    expect(call?.method).toBe('POST')
    expect(call?.headers['content-type']).toBe('application/json')
    const body = bodyJson(call as HttpCall)
    expect(body['taskId']).toBe(7)
    expect(body['taskName']).toBe('测试任务')
    expect(body['recordId']).toBe(11)
    expect(body['triggeredAt']).toBe(1_760_000_000_000)
    expect(typeof body['triggeredAtText']).toBe('string')
    expect(body['chat']).toEqual({ username: 'wxid_self', name: '测试群', type: 'group' })
    expect(body['target']).toEqual({ username: 'wxid_zs', name: '张三' })
    expect(body['keyword']).toBe('RPA')
    expect(body['text']).toBe('你好 RPA')
    expect(body['params']).toEqual({})
    // 图片逐张解码：第一张成功带 dataUrl，第二张失败只带 error（不让整条回调失败）。
    const images = body['images'] as Array<Record<string, unknown>>
    expect(images).toHaveLength(2)
    expect(images[0]?.['dataUrl']).toBe('data:image/png;base64,AAAA')
    expect(images[1]?.['dataUrl']).toBeUndefined()
    expect(images[1]?.['error']).toBe('图片解码失败')
  })

  it('附加参数解析到 params：固定值/模板/语义来源，旧 paramMap 不迁移', async () => {
    const transport = createTransport({ status: 200, body: { ok: true } })
    const ctx = makeCtx({
      url: 'https://hook.example.com/cb',
      paramMap: { room: 'legacy_room', content: 'legacy_content', at: 'legacy_at' },
      extraParams: [
        { name: 'room_name', source: 'room' },
        { name: 'content', source: 'content' },
        { name: 'at_name', source: 'at' },
        { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
        { name: 'ticket', source: 'template', template: '${record.keyword}-${task.id}' },
      ],
    })
    const outcome = await dispatch(webhook, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent' })
    const body = bodyJson(transport.calls[0] as HttpCall)
    expect(body['params']).toEqual({
      room_name: '测试群',
      content: '你好 RPA',
      at_name: '张三',
      order_no: 'A-001',
      ticket: 'RPA-7',
    })
    expect(body['params']).not.toHaveProperty('legacy_room')
  })

  it('失败：非 2xx → failed，保留可读错误（400 不重试）', async () => {
    const transport = createTransport({ status: 400, rawBody: 'bad request' })
    const outcome = await dispatch(webhook, makeCtx({ url: 'https://hook.example.com/cb' }), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('HTTP 400')
    expect(transport.calls).toHaveLength(1)
  })

  it('multipart：payload JSON + images 原始文件，不再生成 data URL', async () => {
    const decodedDir = makeDecodedDir()
    writeFileSync(join(decodedDir, 'one.png'), Buffer.from('image-bytes'))
    const decodeOptions: Array<{ fileOnly?: boolean } | undefined> = []
    const buildDeps: RpaBuildDeps = {
      decodedDir,
      decodeImage: async (_username, localId, options) => {
        decodeOptions.push(options)
        return localId === 101 ? { file: 'one.png' } : {}
      },
    }
    const transport = createTransport((_call, index) => (
      index === 0 ? { status: 500 } : { status: 200, body: { ok: true } }
    ))
    const ctx = makeCtx(
      {
        url: 'https://hook.example.com/cb',
        imageDelivery: 'multipart',
        extraParams: [
          { name: 'room_name', source: 'room' },
          { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
        ],
      },
      {},
      { images: IMAGE_REFS },
    )
    const outcome = await dispatch(webhook, ctx, transport.deps, buildDeps)
    expect(outcome).toEqual({ status: 'sent' })
    // 5xx 自动重试一次；multipart 字节与 boundary 必须原样复用。
    expect(transport.calls).toHaveLength(2)
    expect(transport.calls[0]?.headers['content-type']).toBe(transport.calls[1]?.headers['content-type'])
    expect(Buffer.from(transport.calls[0]?.bodyBytes ?? [])).toEqual(Buffer.from(transport.calls[1]?.bodyBytes ?? []))
    const call = transport.calls[1] as HttpCall
    expect(call.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(call.body).toBe('')
    expect(call.bodyBytes).toBeDefined()
    expect(Buffer.from(call.bodyBytes ?? []).toString('utf8')).not.toContain('data:image')
    expect(decodeOptions).toEqual([{ fileOnly: true }, { fileOnly: true }])

    const form = await new Response(call.bodyBytes, {
      headers: { 'content-type': call.headers['content-type'] ?? '' },
    }).formData()
    const payload = JSON.parse(String(form.get('payload'))) as Record<string, unknown>
    expect(payload['taskId']).toBe(7)
    expect(payload['params']).toEqual({ room_name: '测试群', order_no: 'A-001' })
    const images = payload['images'] as Array<Record<string, unknown>>
    expect(images).toHaveLength(2)
    expect(images[0]).toMatchObject({
      localId: 101,
      fileField: 'images',
      filename: 'image-01.png',
      contentType: 'image/png',
      size: 11,
    })
    expect(typeof images[0]?.['sha256']).toBe('string')
    expect(images[0]?.['dataUrl']).toBeUndefined()
    expect(images[1]?.['error']).toBe('图片解码失败')

    const file = form.get('images')
    expect(file).toBeInstanceOf(File)
    expect((file as File).name).toBe('image-01.png')
    expect(await (file as File).text()).toBe('image-bytes')
  })

  it('局域网链接：images 带短时 URL，不内嵌 data URL', async () => {
    const transport = createTransport({ status: 200, body: { ok: true } })
    const ctx = makeCtx(
      { url: 'https://hook.example.com/cb', imageDelivery: 'lanUrl' },
      {},
      { images: IMAGE_REFS },
    )
    ctx.imageLinks = [
      {
        localId: 101,
        createTime: 1_760_000_000_000,
        sender: '张三',
        md5: 'md5-1',
        url: 'http://192.168.1.8:8765/api/rpa-media/v1.token-a',
      },
      {
        localId: 102,
        createTime: 1_760_000_000_100,
        sender: '张三',
        error: '图片解码失败',
      },
    ]
    const outcome = await dispatch(webhook, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent' })
    const body = bodyJson(transport.calls[0] as HttpCall)
    const images = body['images'] as Array<Record<string, unknown>>
    expect(images[0]?.['url']).toBe('http://192.168.1.8:8765/api/rpa-media/v1.token-a')
    expect(images[0]?.['md5']).toBe('md5-1')
    expect(images[0]?.['dataUrl']).toBeUndefined()
    expect(images[1]?.['url']).toBeUndefined()
    expect(images[1]?.['error']).toBe('图片解码失败')
    expect(JSON.stringify(body)).not.toContain('data:image')
  })

  it('缺少回调地址 → failed（不发出请求）', async () => {
    const transport = createTransport({ status: 200 })
    const outcome = await dispatch(webhook, makeCtx({}), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('回调地址')
    expect(transport.calls).toHaveLength(0)
  })
})

describe('八爪鱼 RPA（官方 v1 协议，2026-10-21 修正）', () => {
  const API_KEY = 'bz-secret-key-123456'
  // v1.2.0 起没有内置参数：显式配置三个附加参数（还原旧行为的写法）。
  const config = {
    flowId: 'flow-1',
    extraParams: [
      { name: 'room_name', source: 'room' },
      { name: 'content', source: 'content' },
      { name: 'at_name', source: 'at' },
    ],
  }

  it('成功：官方 v1 URL + X-API-Key + camelCase body；flowProcessNo 落 externalTaskId', async () => {
    const transport = createTransport({ status: 200, body: { flowId: 'flow-1', flowProcessNo: 'proc-1' } })
    const outcome = await dispatch(bazhuayu, makeCtx(config, { apiKey: API_KEY }), transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'proc-1' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0] as HttpCall
    // 官方文档：/api/v1/bots/scheduling/start（旧实现漏了 /v1，对端按未认证返回 401）。
    expect(call.url).toBe('https://api-rpa.bazhuayu.com/api/v1/bots/scheduling/start')
    expect(call.method).toBe('POST')
    expect(call.headers['x-api-key']).toBe(API_KEY)
    expect(call.body).not.toContain(API_KEY)
    const body = bodyJson(call)
    expect(Object.keys(body).sort()).toEqual(
      ['flowContentRetrievalMode', 'flowId', 'params'].sort(),
    )
    expect(body['flowId']).toBe('flow-1')
    expect(body['flowContentRetrievalMode']).toBe('ByNewestContent')
    expect(body['params']).toEqual({ room_name: '测试群', content: '你好 RPA', at_name: '张三' })
  })

  it('单聊没有触发对象名时 at 回落会话名（旧实现口径）', async () => {
    const transport = createTransport({ status: 200, body: { flowProcessNo: 'proc-2' } })
    const ctx = makeCtx(config, { apiKey: API_KEY }, { chatType: 'private', targetName: '', targetUsername: '' })
    await dispatch(bazhuayu, ctx, transport.deps)
    const call = transport.calls[0] as HttpCall
    expect(bodyJson(call)['params']).toEqual({ room_name: '测试群', content: '你好 RPA', at_name: '测试群' })
  })

  it('失败：非 2xx → failed（把厂商 description 带进错误原因）', async () => {
    const transport = createTransport({ status: 401, body: { code: 'Unauthorized', description: '身份凭证无效，请重新登录' } })
    const outcome = await dispatch(bazhuayu, makeCtx(config, { apiKey: API_KEY }), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('HTTP 401')
    expect(outcome.error).toContain('身份凭证无效')
    expect(transport.calls).toHaveLength(1)
  })

  it('旧 paramMap 自动迁移为附加参数（升级后不静默漏发）', async () => {
    const transport = createTransport({ status: 200, body: { flowProcessNo: 'proc-legacy' } })
    const ctx = makeCtx({
      flowId: 'flow-1',
      paramMap: { room: 'legacy_room', content: 'legacy_content', at: 'legacy_at' },
    }, { apiKey: API_KEY })
    const outcome = await dispatch(bazhuayu, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'proc-legacy' })
    expect(bodyJson(transport.calls[0] as HttpCall)['params']).toEqual({
      legacy_room: '测试群',
      legacy_content: '你好 RPA',
      legacy_at: '张三',
    })
  })
})

describe('出网前标记', () => {
  it('同一请求链只标记一次；标记失败时一个字节也不发出', async () => {
    const retried = createTransport((_call, index) => (
      index === 0 ? { status: 500, rawBody: 'retry' } : { status: 200, body: { ok: true } }
    ))
    let marked = 0
    const sent = await dispatch(
      webhook,
      makeCtx({ url: 'https://hook.example.com/cb' }),
      {
        ...retried.deps,
        onOutboundAttempt: async () => {
          marked += 1
        },
      },
    )
    expect(sent.status).toBe('sent')
    expect(retried.calls).toHaveLength(2)
    expect(marked).toBe(1)

    const blocked = createTransport({ status: 200, body: { ok: true } })
    const failed = await dispatch(
      webhook,
      makeCtx({ url: 'https://hook.example.com/cb' }),
      {
        ...blocked.deps,
        onOutboundAttempt: async () => {
          throw new Error('投递租约已失效')
        },
      },
    )
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('租约已失效') })
    expect(blocked.calls).toHaveLength(0)
  })
})
