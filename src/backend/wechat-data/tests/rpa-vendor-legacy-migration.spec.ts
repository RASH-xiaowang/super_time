// @vitest-environment node
/**
 * 六家 RPA 厂商的旧参数映射 → 附加参数迁移守卫。
 *
 * 迁移层由契约测试覆盖；本文件把旧配置直接送进真实派发管道，逐家断言最终请求容器
 * 已经拿到迁移后的三条参数，防止「读取时迁移了，但厂商钩子仍读旧字段」的断层。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearTokenCache } from '../src/query/rpa/auth.ts'
import { dispatchRpaRecord } from '../src/query/rpa/dispatch.ts'
import type { RetryFetch } from '../src/net/fetch-retry.ts'
import type {
  RpaBuildDeps,
  RpaInvocationContext,
  RpaVendorAdapter,
} from '../src/query/rpa/types.ts'
import { adapter as bazhuayu } from '../src/query/rpa/vendors/bazhuayu.ts'
import { adapter as yingdao } from '../src/query/rpa/vendors/yingdao.ts'
import { adapter as uipath } from '../src/query/rpa/vendors/uipath.ts'
import { adapter as aliyunRpa } from '../src/query/rpa/vendors/aliyun-rpa.ts'
import { adapter as laiye } from '../src/query/rpa/vendors/laiye.ts'
import { adapter as shizai } from '../src/query/rpa/vendors/shizai.ts'

interface HttpCall {
  body: string
}

interface MockResponse {
  status?: number
  body?: unknown
}

type Responder = (call: HttpCall, index: number) => MockResponse

/** 构造只记录业务请求体的 fetch mock。 */
function transportOf(responder: Responder | MockResponse): {
  fetchImpl: RetryFetch
  calls: HttpCall[]
} {
  const calls: HttpCall[] = []
  const fetchImpl: RetryFetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET').toUpperCase(),
      headers: {},
      body: typeof init?.body === 'string' ? init.body : '',
      contentType: '',
    } as HttpCall)
    const spec = typeof responder === 'function' ? responder(calls[calls.length - 1] as HttpCall, calls.length - 1) : responder
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetchImpl, calls }
}

function makeCtx(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
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
    },
  }
}

function bodyJson(call: HttpCall): Record<string, unknown> {
  return JSON.parse(call.body) as Record<string, unknown>
}

const BUILD_DEPS: RpaBuildDeps = {
  decodedDir: '',
  decodeImage: async () => ({}),
}

beforeEach(() => {
  clearTokenCache()
})

describe('旧版参数映射统一迁移到附加参数', () => {
  const legacy = {
    room: 'legacy_room',
    content: 'legacy_content',
    at: 'legacy_at',
  }
  const expectedObject = {
    legacy_room: '测试群',
    legacy_content: '你好 RPA',
    legacy_at: '张三',
  }
  const expectedArray = [
    { name: 'legacy_room', value: '测试群' },
    { name: 'legacy_content', value: '你好 RPA' },
    { name: 'legacy_at', value: '张三' },
  ]

  const cases: Array<{
    name: string
    adapter: RpaVendorAdapter
    ctx: RpaInvocationContext
    responder: Responder | MockResponse
    businessCallIndex: number
    read: (call: HttpCall) => unknown
    expected: unknown
  }> = [
    {
      name: '八爪鱼 RPA（paramMap → params{}）',
      adapter: bazhuayu,
      ctx: makeCtx({ flowId: 'flow-1', paramMap: legacy }, { apiKey: 'bz-key' }),
      responder: { body: { flowProcessNo: 'proc-legacy' } },
      businessCallIndex: 0,
      read: (call) => bodyJson(call)['params'],
      expected: expectedObject,
    },
    {
      name: '影刀 RPA（paramMap → params[]）',
      adapter: yingdao,
      ctx: makeCtx(
        {
          baseUrl: 'https://api.yingdao.com',
          robotUuid: 'robot-1',
          accountName: 'admin@fckj',
          priority: 'middle',
          paramMap: legacy,
        },
        { accessKeyId: 'ak-1', accessKeySecret: 'sk-1' },
      ),
      responder: (_call, index) => (
        index === 0
          ? { body: { code: 200, data: { accessToken: 'tok-1', expiresIn: 7200 } } }
          : { body: { code: 200, data: { jobUuid: 'job-legacy' } } }
      ),
      businessCallIndex: 1,
      read: (call) => bodyJson(call)['params'],
      expected: [
        { name: 'legacy_room', value: '测试群', type: 'str' },
        { name: 'legacy_content', value: '你好 RPA', type: 'str' },
        { name: 'legacy_at', value: '张三', type: 'str' },
      ],
    },
    {
      name: 'UiPath（inputArgumentsMap → InputArguments）',
      adapter: uipath,
      ctx: makeCtx(
        {
          deployment: 'cloud',
          baseUrl: 'https://cloud.uipath.com',
          organizationName: 'myorg',
          tenantName: 'mytenant',
          folderKey: 'folder-key-1',
          releaseKey: 'release-key-1',
          strategy: 'ModernJobsCount',
          jobsCount: 1,
          authMode: 'pat',
          inputArgumentsMap: legacy,
        },
        { pat: 'pat-token-1' },
      ),
      responder: { body: { value: [{ Key: 'job-legacy', State: 'Pending' }] } },
      businessCallIndex: 0,
      read: (call) => {
        const startInfo = bodyJson(call)['startInfo'] as Record<string, unknown>
        return JSON.parse(String(startInfo['InputArguments']))
      },
      expected: expectedObject,
    },
    {
      name: '阿里云 RPA（appParamsMap → AppParams）',
      adapter: aliyunRpa,
      ctx: makeCtx(
        {
          apiFamily: 'service',
          baseUrl: 'https://console-rpa.aliyun.com',
          appId: 'app-1',
          appVersion: '1.0.0',
          allocateMode: 'auto',
          packId: 'pack-1',
          taskPriority: 85,
          appParamsMap: legacy,
        },
        { accessKeyId: 'ak-1', accessKeySecret: 'sk-1' },
      ),
      responder: { body: { code: 0, success: true, data: { TaskId: 'task-legacy' } } },
      businessCallIndex: 0,
      read: (call) => JSON.parse(new URLSearchParams(call.body).get('AppParams') ?? 'null'),
      expected: expectedArray,
    },
    {
      name: '来也 RPA（parameterMap → parameters[]）',
      adapter: laiye,
      ctx: makeCtx(
        {
          baseUrl: 'https://rpa.example.com:8182',
          flowName: 'finance_report_flow',
          assignType: 'automatic',
          priority: 'high',
          parameterMap: legacy,
        },
        { token: 'rk-company-abc' },
      ),
      responder: {
        body: {
          jsonrpc: '2.0',
          id: '7:11',
          result: JSON.stringify({ return: { code: '0', data: { taskIds: [1] } } }),
        },
      },
      businessCallIndex: 0,
      read: (call) => {
        const body = bodyJson(call)
        const params = body['params'] as Record<string, unknown>
        const args = params['arguments'] as Record<string, unknown>
        return args['parameters']
      },
      expected: [
        { parameterName: 'legacy_room', parameterType: 'string', parameterValue: '测试群' },
        { parameterName: 'legacy_content', parameterType: 'string', parameterValue: '你好 RPA' },
        { parameterName: 'legacy_at', parameterType: 'string', parameterValue: '张三' },
      ],
    },
    {
      name: '实在智能 RPA（inputParamMap → inputParam）',
      adapter: shizai,
      ctx: makeCtx(
        {
          baseUrl: 'https://z-commander-api.ai-indeed.com',
          jobUuid: 'job-uuid-1',
          keyHeader: 'X-App-Key',
          secretHeader: 'X-App-Secret',
          inputParamMap: legacy,
        },
        { appKey: 'ak-key-1', appSecret: 'as-secret-1' },
      ),
      responder: { body: { code: 0, data: { works: [{ workUuid: 'work-legacy' }] } } },
      businessCallIndex: 0,
      read: (call) => bodyJson(call)['inputParam'],
      expected: expectedObject,
    },
  ]

  for (const item of cases) {
    it(item.name, async () => {
      const transport = transportOf(item.responder)
      const outcome = await dispatchRpaRecord({
        adapter: item.adapter,
        ctx: item.ctx,
        deps: { fetchImpl: transport.fetchImpl },
        buildDeps: BUILD_DEPS,
      })
      expect(outcome.status, outcome.error).toBe('sent')
      expect(item.read(transport.calls[item.businessCallIndex] as HttpCall)).toEqual(item.expected)
    })
  }
})
