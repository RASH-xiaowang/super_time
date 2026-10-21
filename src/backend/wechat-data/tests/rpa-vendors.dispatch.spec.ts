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
import { mkdtempSync, rmSync } from 'node:fs'
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
import { adapter as yingdao } from '../src/query/rpa/vendors/yingdao.ts'
import { adapter as uipath } from '../src/query/rpa/vendors/uipath.ts'
import { adapter as aliyunRpa } from '../src/query/rpa/vendors/aliyun-rpa.ts'
import { adapter as laiye } from '../src/query/rpa/vendors/laiye.ts'
import { adapter as shizai } from '../src/query/rpa/vendors/shizai.ts'
import { aliyunRpcSign } from '../src/query/rpa/vendors/aliyun-rpa.ts'

/** 一次被 mock 记录下来的请求（headers 已 lower-case，便于断言）。 */
interface HttpCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
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
  it('成功：整条记录 JSON + 图片 data URL；地址只在 URL，凭据无', async () => {
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
    // 图片逐张解码：第一张成功带 dataUrl，第二张失败只带 error（不让整条回调失败）。
    const images = body['images'] as Array<Record<string, unknown>>
    expect(images).toHaveLength(2)
    expect(images[0]?.['dataUrl']).toBe('data:image/png;base64,AAAA')
    expect(images[1]?.['dataUrl']).toBeUndefined()
    expect(images[1]?.['error']).toBe('图片解码失败')
  })

  it('失败：非 2xx → failed，保留可读错误（400 不重试）', async () => {
    const transport = createTransport({ status: 400, rawBody: 'bad request' })
    const outcome = await dispatch(webhook, makeCtx({ url: 'https://hook.example.com/cb' }), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('HTTP 400')
    expect(transport.calls).toHaveLength(1)
  })

  it('缺少回调地址 → failed（不发出请求）', async () => {
    const transport = createTransport({ status: 200 })
    const outcome = await dispatch(webhook, makeCtx({}), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('回调地址')
    expect(transport.calls).toHaveLength(0)
  })
})

describe('八爪鱼 RPA（内置，回归基线）', () => {
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

  it('成功：固定主机 + X-Api-Key 头 + Params 由附加参数组装（Key 不在 body）', async () => {
    const transport = createTransport({ status: 200, body: {} })
    const outcome = await dispatch(bazhuayu, makeCtx(config, { apiKey: API_KEY }), transport.deps)
    expect(outcome).toEqual({ status: 'sent' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe('https://api-rpa.bazhuayu.com/api/bots/scheduling/start')
    expect(call.method).toBe('POST')
    expect(call.headers['x-api-key']).toBe(API_KEY)
    expect(call.body).not.toContain(API_KEY)
    const body = bodyJson(call)
    expect(body['FlowId']).toBe('flow-1')
    expect(body['FlowContentRetrievalMode']).toBe('ByNewestContent')
    expect(body['SpecifiedPublicationVersion']).toBe('')
    expect(body['SpecifiedBot']).toBe('')
    expect(body['UserStartSource']).toBe('OpenApi')
    expect(body['Params']).toEqual({ room_name: '测试群', content: '你好 RPA', at_name: '张三' })
  })

  it('单聊没有触发对象名时 at_name 回落会话名（旧实现口径）', async () => {
    const transport = createTransport({ status: 200 })
    const ctx = makeCtx(config, { apiKey: API_KEY }, { chatType: 'private', targetName: '', targetUsername: '' })
    await dispatch(bazhuayu, ctx, transport.deps)
    const call = transport.calls[0] as HttpCall
    expect(bodyJson(call)['Params']).toEqual({ room_name: '测试群', content: '你好 RPA', at_name: '测试群' })
  })

  it('失败：非 2xx → failed', async () => {
    const transport = createTransport({ status: 400, rawBody: 'nope' })
    const outcome = await dispatch(bazhuayu, makeCtx(config, { apiKey: API_KEY }), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('HTTP 400')
    expect(transport.calls).toHaveLength(1)
  })
})

describe('影刀 RPA（token-exchange + 二选一字段）', () => {
  const config = {
    baseUrl: 'https://api.yingdao.com',
    robotUuid: 'robot-1',
    accountName: 'admin@fckj',
    priority: 'middle',
  }
  const secrets = { accessKeyId: 'ak-1', accessKeySecret: 'sk-1' }

  it('成功：先 GET token，再 POST job/start；参数 name/value/type；解析 jobUuid', async () => {
    const transport = createTransport((_call, index) => {
      if (index === 0) return { status: 200, body: { code: 200, data: { accessToken: 'tok-1', expiresIn: 7200 } } }
      return { status: 200, body: { code: 200, success: true, data: { jobUuid: 'job-1', idempotentFlag: false } } }
    })
    const outcome = await dispatch(yingdao, makeCtx(config, secrets), transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'job-1' })
    expect(transport.calls).toHaveLength(2)

    const tokenCall = transport.calls[0] as HttpCall
    expect(tokenCall.method).toBe('GET')
    expect(tokenCall.url).toContain('/oapi/token/v2/token/create')
    expect(tokenCall.url).toContain('accessKeyId=ak-1')
    expect(tokenCall.url).toContain('accessKeySecret=sk-1')

    const call = transport.calls[1] as HttpCall
    expect(call.url).toBe('https://api.yingdao.com/oapi/dispatch/v2/job/start')
    expect(call.method).toBe('POST')
    expect(call.headers['authorization']).toBe('Bearer tok-1')
    // 凭据只在换 token 请求里，业务请求的 body/header 不得再出现。
    expect(call.body).not.toContain('sk-1')
    expect(JSON.stringify(call.headers)).not.toContain('sk-1')
    const body = bodyJson(call)
    expect(body['robotUuid']).toBe('robot-1')
    expect(body['idempotentUuid']).toBe('7:11')
    expect(body['accountName']).toBe('admin@fckj')
    expect(body['params']).toEqual([
      { name: 'room_name', value: '测试群', type: 'str' },
      { name: 'content', value: '你好 RPA', type: 'str' },
      { name: 'at_name', value: '张三', type: 'str' },
    ])
  })

  it('accountName 与分组都填时以分组为准（官方口径）', async () => {
    const transport = createTransport((_call, index) => {
      if (index === 0) return { status: 200, body: { code: 200, data: { accessToken: 'tok-1', expiresIn: 7200 } } }
      return { status: 200, body: { code: 200, data: { jobUuid: 'job-2' } } }
    })
    const ctx = makeCtx({ ...config, robotClientGroupUuid: 'group-1' }, secrets)
    await dispatch(yingdao, ctx, transport.deps)
    const body = bodyJson(transport.calls[1] as HttpCall)
    expect(body['robotClientGroupUuid']).toBe('group-1')
    expect(body['accountName']).toBeUndefined()
  })

  it('失败：业务码非 200 → failed（不解析出外部任务 id）', async () => {
    const transport = createTransport((_call, index) => {
      if (index === 0) return { status: 200, body: { code: 200, data: { accessToken: 'tok-1', expiresIn: 7200 } } }
      return { status: 200, body: { code: 500, success: false, msg: '服务异常' } }
    })
    const outcome = await dispatch(yingdao, makeCtx(config, secrets), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('服务异常')
  })
})

describe('UiPath Orchestrator（PAT / OAuth 双模式）', () => {
  const baseConfig = {
    deployment: 'cloud',
    baseUrl: 'https://cloud.uipath.com',
    organizationName: 'myorg',
    tenantName: 'mytenant',
    folderKey: 'folder-key-1',
    releaseKey: 'release-key-1',
    strategy: 'ModernJobsCount',
    jobsCount: 1,
  }
  const jobsBody = { value: [{ Key: 'job-key-1', State: 'Pending' }] }

  it('PAT：Bearer 头 + X-UIPATH-FolderKey + InputArguments 为 JSON 文本；解析 value[0].Key', async () => {
    const transport = createTransport({ status: 200, body: jobsBody })
    const ctx = makeCtx({ ...baseConfig, authMode: 'pat' }, { pat: 'pat-token-1' })
    const outcome = await dispatch(uipath, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'job-key-1' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe(
      'https://cloud.uipath.com/myorg/mytenant/orchestrator_/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs',
    )
    expect(call.headers['authorization']).toBe('Bearer pat-token-1')
    expect(call.headers['x-uipath-folderkey']).toBe('folder-key-1')
    const startInfo = bodyJson(call)['startInfo'] as Record<string, unknown>
    expect(startInfo['ReleaseKey']).toBe('release-key-1')
    expect(startInfo['Strategy']).toBe('ModernJobsCount')
    expect(startInfo['JobsCount']).toBe(1)
    // UiPath 要求 InputArguments 是 JSON 文本字符串，不是对象。
    expect(typeof startInfo['InputArguments']).toBe('string')
    expect(JSON.parse(startInfo['InputArguments'] as string)).toEqual({
      room_name: '测试群',
      content: '你好 RPA',
      at_name: '张三',
    })
  })

  it('OAuth：先换 token（form body），再带 Bearer 调 StartJobs；client_secret 不进业务请求', async () => {
    const transport = createTransport((_call, index) => {
      if (index === 0) return { status: 200, body: { access_token: 'oauth-tok', expires_in: 3600 } }
      return { status: 200, body: jobsBody }
    })
    const ctx = makeCtx(
      { ...baseConfig, authMode: 'oauth', scope: 'OR.Default' },
      { clientId: 'client-1', clientSecret: 'client-secret-1' },
    )
    const outcome = await dispatch(uipath, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'job-key-1' })
    expect(transport.calls).toHaveLength(2)
    const tokenCall = transport.calls[0] as HttpCall
    expect(tokenCall.method).toBe('POST')
    expect(tokenCall.url).toBe('https://cloud.uipath.com/myorg/identity_/connect/token')
    expect(tokenCall.headers['content-type']).toContain('application/x-www-form-urlencoded')
    const tokenFields = tokenBodyFields(tokenCall)
    expect(tokenFields['grant_type']).toBe('client_credentials')
    expect(tokenFields['client_id']).toBe('client-1')
    expect(tokenFields['client_secret']).toBe('client-secret-1')
    expect(tokenFields['scope']).toBe('OR.Default')
    const business = transport.calls[1] as HttpCall
    expect(business.headers['authorization']).toBe('Bearer oauth-tok')
    expect(business.body).not.toContain('client-secret-1')
  })

  it('Standalone：baseUrl 为 Orchestrator 根时拼接 /odata/Jobs/…', async () => {
    const transport = createTransport({ status: 200, body: jobsBody })
    const ctx = makeCtx(
      { ...baseConfig, deployment: 'onprem', baseUrl: 'https://orchestrator.example.com', authMode: 'pat' },
      { pat: 'pat-token-1' },
    )
    await dispatch(uipath, ctx, transport.deps)
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe('https://orchestrator.example.com/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs')
  })

  it('失败：非 2xx 且无幂等键 → 只发 1 次', async () => {
    const transport = createTransport({ status: 500, rawBody: 'boom' })
    const ctx = makeCtx({ ...baseConfig, authMode: 'pat' }, { pat: 'pat-token-1' })
    const outcome = await dispatch(uipath, ctx, transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('HTTP 500')
    expect(transport.calls).toHaveLength(1)
  })
})

describe('阿里云 RPA（experimental，HMAC-SHA1 签名）', () => {
  const serviceConfig = {
    apiFamily: 'service',
    baseUrl: 'https://console-rpa.aliyun.com',
    appId: 'app-1',
    appVersion: '1.0.0',
    allocateMode: 'auto',
    packId: 'pack-1',
    taskPriority: 85,
    appParamsMap: { room: 'room_name', content: 'content', at: 'at_name' },
  }
  const secrets = { accessKeyId: 'ak-1', accessKeySecret: 'sk-secret-1' }

  it('成功：form body 含公共参数 + Signature（服务型大写参数）；解析 data.TaskId', async () => {
    const transport = createTransport({
      status: 200,
      body: { requestId: 'r1', success: true, code: 0, msg: '调用成功', data: { TaskId: 'task-1' } },
    })
    const outcome = await dispatch(aliyunRpa, makeCtx(serviceConfig, secrets), transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'task-1' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe('https://console-rpa.aliyun.com/rpa/openapi/raas/task/CreateTask')
    expect(call.method).toBe('POST')
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(call.headers['x-idempotent-request-id']).toBe('7:11')
    // 凭据原文绝不进 body（SK 只用于本地算签名）。
    expect(call.body).not.toContain('sk-secret-1')
    const params: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(call.body)) params[key] = value
    expect(params['AppId']).toBe('app-1')
    expect(params['AppVersion']).toBe('1.0.0')
    expect(params['AllocateMode']).toBe('auto')
    expect(params['PackId']).toBe('pack-1')
    expect(params['TaskPriority']).toBe('85')
    expect(JSON.parse(params['AppParams'] ?? '[]')).toEqual([
      { name: 'room_name', value: '测试群' },
      { name: 'content', value: '你好 RPA' },
      { name: 'at_name', value: '张三' },
    ])
    expect(params['AccessKeyId']).toBe('ak-1')
    expect(params['SignatureMethod']).toBe('HMAC-SHA1')
    expect(params['SignatureVersion']).toBe('1.0')
    expect(params['Version']).toBe('20200430')
    expect(params['Format']).toBe('json')
    expect(params['Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(String(params['SignatureNonce'])).not.toBe('')
    // 签名可用导出的签名函数复核（去掉 Signature 后重算）。
    const { Signature, ...unsigned } = params
    expect(Signature).toBe(aliyunRpcSign(unsigned, 'sk-secret-1', 'POST'))
  })

  it('本地型：小写参数 + createServiceTask 路径 + clientId', async () => {
    const transport = createTransport({
      status: 200,
      body: { code: 0, success: true, msg: 'ok', data: { taskId: 'local-task-1' } },
    })
    const ctx = makeCtx(
      { ...serviceConfig, apiFamily: 'local', robotId: 'robot-1' },
      secrets,
    )
    const outcome = await dispatch(aliyunRpa, ctx, transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'local-task-1' })
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe('https://console-rpa.aliyun.com/rpa/openapi/task/createServiceTask')
    expect(call.headers['x-idempotent-request-id']).toBeUndefined()
    const params: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(call.body)) params[key] = value
    expect(params['appId']).toBe('app-1')
    expect(params['clientId']).toBe('robot-1')
    expect(params['AppId']).toBeUndefined()
  })

  it('业务码失败（code≠0）→ failed', async () => {
    const transport = createTransport({ status: 200, body: { code: 20000, msg: 'permission.denied' } })
    const outcome = await dispatch(aliyunRpa, makeCtx(serviceConfig, secrets), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('permission.denied')
  })
})

describe('来也 RPA（experimental，MCP JSON-RPC）', () => {
  const config = {
    baseUrl: 'https://rpa.example.com:8182',
    flowName: 'finance_report_flow',
    assignType: 'automatic',
    priority: 'high',
    parameterMap: { room: 'room_name', content: 'content', at: 'at_name' },
  }
  const secrets = { token: 'rk-company-abc' }

  it('成功：tools/call create_task + parameters[]；二次 JSON 解析出 taskIds[0]', async () => {
    const business = {
      return: {
        code: '0',
        message: 'Tasks created successfully',
        data: { taskIds: [4702818380283905] },
      },
    }
    const transport = createTransport({
      status: 200,
      body: { jsonrpc: '2.0', id: '7:11', result: JSON.stringify(business) },
    })
    const outcome = await dispatch(laiye, makeCtx(config, secrets), transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: '4702818380283905' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe('https://rpa.example.com:8182/automation/mcp')
    expect(call.headers['authorization']).toBe('Bearer rk-company-abc')
    expect(call.body).not.toContain('rk-company-abc')
    const body = bodyJson(call)
    expect(body['jsonrpc']).toBe('2.0')
    expect(body['method']).toBe('tools/call')
    const params = body['params'] as Record<string, unknown>
    expect(params['name']).toBe('create_task')
    const args = params['arguments'] as Record<string, unknown>
    expect(args['flowName']).toBe('finance_report_flow')
    expect(args['assignType']).toBe('automatic')
    expect(args['priority']).toBe('high')
    expect(args['parameters']).toEqual([
      { parameterName: 'room_name', parameterType: 'string', parameterValue: '测试群' },
      { parameterName: 'content', parameterType: 'string', parameterValue: '你好 RPA' },
      { parameterName: 'at_name', parameterType: 'string', parameterValue: '张三' },
    ])
  })

  it('业务码失败（return.code=401）→ failed', async () => {
    const transport = createTransport({
      status: 200,
      body: { jsonrpc: '2.0', id: '7:11', result: JSON.stringify({ return: { code: '401', message: 'Invalid or expired access token' } }) },
    })
    const outcome = await dispatch(laiye, makeCtx(config, secrets), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('Invalid or expired access token')
  })

  it('私网地址被主机校验拒绝（不发出请求）', async () => {
    const transport = createTransport({ status: 200 })
    const ctx = makeCtx({ ...config, baseUrl: 'http://127.0.0.1:8182' }, secrets)
    const outcome = await dispatch(laiye, ctx, transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('出网主机不在允许清单内')
    expect(transport.calls).toHaveLength(0)
  })
})

describe('实在智能 RPA（experimental，header 名待联调）', () => {
  const config = {
    baseUrl: 'https://z-commander-api.ai-indeed.com',
    jobUuid: 'job-uuid-1',
    keyHeader: 'X-App-Key',
    secretHeader: 'X-App-Secret',
    inputParamMap: { room: 'room_name', content: 'content', at: 'at_name' },
  }
  const secrets = { appKey: 'ak-key-1', appSecret: 'as-secret-1' }

  it('成功：用户配置的 header 名注入凭据；解析 data.works[0].workUuid', async () => {
    const transport = createTransport({
      status: 200,
      body: { msg: '成功', code: 0, data: { jobUuid: 'job-uuid-1', operation: 1, success: true, works: [{ workUuid: 'work-9' }] } },
    })
    const outcome = await dispatch(shizai, makeCtx(config, secrets), transport.deps)
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'work-9' })
    expect(transport.calls).toHaveLength(1)
    const call = transport.calls[0] as HttpCall
    expect(call.url).toBe('https://z-commander-api.ai-indeed.com/openAPI/v2/job/operation')
    expect(call.headers['x-app-key']).toBe('ak-key-1')
    expect(call.headers['x-app-secret']).toBe('as-secret-1')
    const body = bodyJson(call)
    expect(body['jobUuid']).toBe('job-uuid-1')
    expect(body['operation']).toBe(1)
    expect(body['inputParam']).toEqual({ room_name: '测试群', content: '你好 RPA', at_name: '张三' })
    // 凭据只在 header，不进 body。
    expect(call.body).not.toContain('ak-key-1')
    expect(call.body).not.toContain('as-secret-1')
  })

  it('未联调配置 header 名 → failed 且不发出请求（官方名未公开，不猜）', async () => {
    const transport = createTransport({ status: 200 })
    const ctx = makeCtx({ ...config, keyHeader: '', secretHeader: '' }, secrets)
    const outcome = await dispatch(shizai, ctx, transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('header 名')
    expect(transport.calls).toHaveLength(0)
  })

  it('失败：非 2xx 且无幂等键 → 只发 1 次', async () => {
    const transport = createTransport({ status: 500, rawBody: 'boom' })
    const outcome = await dispatch(shizai, makeCtx(config, secrets), transport.deps)
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('HTTP 500')
    expect(transport.calls).toHaveLength(1)
  })
})

describe('无幂等键厂商只发一次（不自动重试）', () => {
  /** 每家厂商的最小可用配置（只关心请求次数）。 */
  const cases: Array<{ name: string; adapter: RpaVendorAdapter; ctx: RpaInvocationContext }> = [
    {
      name: 'uipath',
      adapter: uipath,
      ctx: makeCtx(
        {
          deployment: 'cloud',
          baseUrl: 'https://cloud.uipath.com',
          organizationName: 'myorg',
          tenantName: 'mytenant',
          folderKey: 'folder-key-1',
          releaseKey: 'release-key-1',
          authMode: 'pat',
        },
        { pat: 'pat-token-1' },
      ),
    },
    {
      name: 'laiye',
      adapter: laiye,
      ctx: makeCtx(
        { baseUrl: 'https://rpa.example.com:8182', flowName: 'flow-1', assignType: 'automatic' },
        { token: 'rk-token' },
      ),
    },
    {
      name: 'shizai',
      adapter: shizai,
      ctx: makeCtx(
        {
          baseUrl: 'https://z-commander-api.ai-indeed.com',
          jobUuid: 'job-uuid-1',
          keyHeader: 'X-App-Key',
          secretHeader: 'X-App-Secret',
        },
        { appKey: 'ak-key-1', appSecret: 'as-secret-1' },
      ),
    },
  ]

  for (const item of cases) {
    it(item.name + '：HTTP 500 只尝试 1 次', async () => {
      const transport = createTransport({ status: 500, rawBody: 'boom' })
      const outcome = await dispatch(item.adapter, item.ctx, transport.deps)
      expect(outcome.status).toBe('failed')
      expect(transport.calls).toHaveLength(1)
    })
  }
})
