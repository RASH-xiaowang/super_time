// @vitest-environment node
/**
 * 多厂商触发**核心管道**的后端行为守卫（2026-10-21）。
 *
 * 覆盖契约 §3 里不属于单个厂商的部分：
 *  ① 注册表：固定 7 个内置/厂商 id 与顺序、未知 id、可序列化目录副本、`listRpaVendors` 处理器；
 *  ② 模板层：默认值、类型/pattern/URL 校验、必填判定、凭据合并、占位符渲染与参数容器五态；
 *  ③ 鉴权层：bearer / header / token-exchange（缓存）/ custom 钩子、按 when 选择模式；
 *  ④ 派发管道：主机白名单（含 Webhook 任意 http(s) 特例、私有化 baseUrl + 私网拒绝）、
 *     通用响应解析（业务码/外部任务 id）、失败分类、重试次数、非 Webhook 不解码图片；
 *  ⑤ 存储派生：触发记录的 externalTaskId 往返。
 *
 * 全部用合成描述符 + 假 fetch，不联网；不依赖任何具体厂商文件的内容（V 的 spec 另守描述符）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applySecretInput,
  defaultConfigFor,
  fieldAriaLabel,
  missingReadyFields,
  renderRequest,
  validateVendorConfig,
} from '../src/query/rpa/template.ts'
import { applyAuth, clearTokenCache } from '../src/query/rpa/auth.ts'
import type { RpaAuthDeps } from '../src/query/rpa/auth.ts'
import { dispatchRpaRecord } from '../src/query/rpa/dispatch.ts'
import { adapter as bazhuayuAdapter } from '../src/query/rpa/vendors/bazhuayu.ts'
import {
  findVendor,
  listVendorDescriptors,
  RPA_REGISTRY_VERSION,
  RPA_VENDOR_MAP,
  RPA_VENDORS,
} from '../src/query/rpa/registry.ts'
import { createTaskCenterRemotes } from '../src/remotes/task-center.ts'
import { rowToTrigger } from '../src/query/task-center.ts'
import type {
  RpaField,
  RpaTriggerConfig,
  RpaVendorDescriptor,
} from '../src/types-rpa.ts'
import type {
  RpaHttpRequest,
  RpaHttpResponse,
  RpaInvocationContext,
  RpaRecordContext,
  RpaVendorAdapter,
} from '../src/query/rpa/types.ts'

let scratch = ''
let dirs = { decrypted: '', decoded: '' }

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'task-center-rpa-'))
  dirs = { decrypted: join(scratch, 'data', 'decrypted'), decoded: join(scratch, 'data', 'decoded') }
  mkdirSync(dirs.decrypted, { recursive: true })
  mkdirSync(dirs.decoded, { recursive: true })
  clearTokenCache()
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** 合成一条触发记录上下文（text 视为已过隐私闸）。 */
function recordOf(over: Partial<RpaRecordContext> = {}): RpaRecordContext {
  return {
    username: 'wxid_lisi',
    chatName: '李四',
    chatType: 'private',
    targetName: '',
    targetUsername: '',
    text: '发票 内容',
    keyword: '发票',
    triggeredAt: 1_700_000_000_000,
    images: [],
    ...over,
  }
}

/** 合成投递上下文。 */
function ctxOf(over: Partial<RpaInvocationContext> = {}): RpaInvocationContext {
  return {
    taskId: 1,
    recordId: 2,
    idempotencyKey: '1:2',
    taskName: '测试任务',
    record: recordOf(),
    config: {},
    secrets: {},
    ...over,
  }
}

/** 合成厂商描述符（只填核心管道会读的字段）。 */
function descriptorOf(over: Partial<RpaVendorDescriptor> = {}): RpaVendorDescriptor {
  return {
    id: 'test-vendor',
    name: '测试厂商',
    vendor: '测试厂商（单测）',
    version: '1.0.0',
    summary: '单测用描述符',
    status: 'stable',
    docs: {
      home: 'https://example.test/',
      triggerApi: 'https://example.test/api',
      lastVerifiedAt: '2026-10-21',
    },
    capabilities: {
      direction: 'outbound',
      synchronous: true,
      completion: 'none',
      idempotency: 'none',
      deployment: ['cloud'],
    },
    fields: [],
    auth: { modes: [] },
    mapping: {
      style: 'object',
      mapField: 'paramMap',
      targets: [
        { semantic: 'room', defaultKey: 'room_name' },
        { semantic: 'content', defaultKey: 'content' },
        { semantic: 'at', defaultKey: 'at_name' },
      ],
    },
    request: {
      method: 'POST',
      url: 'https://api.example.test/run',
      headers: { 'content-type': 'application/json' },
      body: {},
    },
    response: { okHttpStatus: [200], okPath: 'code', okValue: 200 },
    retry: { maxAttempts: 1, retryOn: [] },
    governance: {
      contentOutbound: true,
      hosts: [{ kind: 'exact', value: 'api.example.test' }],
      privacySection: 'G3',
    },
    risks: ['单测用'],
    ...over,
  }
}

/** 合成适配器。 */
function adapterOf(over: Partial<RpaVendorDescriptor> = {}): RpaVendorAdapter {
  return { descriptor: descriptorOf(over) }
}

/** 默认 buildDeps（只有 Webhook 会用到图片解码）。 */
function buildDepsOf(decodeImage?: () => Promise<{ url?: string; file?: string }>): {
  decodedDir: string
  decodeImage: (username: string, localId: number) => Promise<{ url?: string; file?: string }>
} {
  return {
    decodedDir: dirs.decoded,
    decodeImage: decodeImage ?? (async () => ({ url: 'data:image/png;base64,AAAA' })),
  }
}

/** 市场参数的合成字段集合（给默认值/校验用）。 */
const FIELDS: RpaField[] = [
  { key: 'url', label: '回调地址', type: 'text', required: true, example: 'https://example.test/hook' },
  { key: 'baseUrl', label: '服务地址', type: 'text', required: false, example: 'https://api.example.test' },
  { key: 'robotUuid', label: '应用 UUID', type: 'text', required: true, example: 'uuid-1' },
  {
    key: 'priority', label: '优先级', type: 'select', required: false,
    options: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }],
  },
  { key: 'jobsCount', label: '并发数', type: 'number', required: false, defaultValue: 1 },
  { key: 'paramMap', label: '参数映射', type: 'map', required: false, defaultValue: { room: 'room_name', content: 'content', at: 'at_name' } },
  { key: 'apiKey', label: '八爪鱼 API Key', type: 'password', required: true, secret: true },
]

/** 带字段的合成描述符。 */
function fieldsDescriptor(over: Partial<RpaVendorDescriptor> = {}): RpaVendorDescriptor {
  return descriptorOf({ fields: FIELDS, ...over })
}

describe('注册表与 Remote 目录', () => {
  it('固定 7 个条目与顺序；未知 id 返回 undefined；map 与版本一致', () => {
    expect(RPA_VENDORS.map((adapter) => adapter.descriptor.id)).toEqual([
      'webhook', 'bazhuayu', 'yingdao', 'uipath', 'aliyun-rpa', 'laiye', 'shizai',
    ])
    expect(RPA_VENDOR_MAP.size).toBe(RPA_VENDORS.length)
    expect(findVendor('webhook')).toBe(RPA_VENDOR_MAP.get('webhook'))
    expect(findVendor('')).toBeUndefined()
    expect(findVendor('no-such-vendor')).toBeUndefined()
    expect(RPA_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('listVendorDescriptors 返回可序列化副本（改返回值不影响注册表）', () => {
    const first = listVendorDescriptors()
    expect(first).toHaveLength(RPA_VENDORS.length)
    expect(() => JSON.stringify(first)).not.toThrow()
    const target = first[0]
    if (target !== undefined) target.name = '被改坏的名字'
    expect(listVendorDescriptors()[0]?.name).toBe(RPA_VENDORS[0]?.descriptor.name)
    // 描述符里不应带钩子函数（JSON 往返后仍是同一结构）
    expect(JSON.parse(JSON.stringify(first))).toEqual(first.map((item) => JSON.parse(JSON.stringify(item))))
  })

  it('createTaskCenterRemotes().listRpaVendors() 返回目录与注册表版本', () => {
    const remotes = createTaskCenterRemotes({
      dirs: () => dirs,
      op: () => {},
      selfUsername: () => 'wxid_self',
      privacyGate: (_feature, _stats, texts) => texts,
      imageContext: () => ({ xorKey: 0 }),
    })
    const catalog = remotes.listRpaVendors()
    expect(catalog.registryVersion).toBe(RPA_REGISTRY_VERSION)
    expect(catalog.items.map((item) => item.id)).toEqual(RPA_VENDORS.map((adapter) => adapter.descriptor.id))
    expect(JSON.stringify(catalog)).not.toContain('function')
  })
})

describe('模板层：默认值 / 校验 / 必填 / 凭据合并', () => {
  it('defaultConfigFor 填 defaultValue 与 map 三键；fieldAriaLabel 回退 label', () => {
    const config = defaultConfigFor(fieldsDescriptor())
    expect(config['jobsCount']).toBe(1)
    expect(config['paramMap']).toEqual({ room: 'room_name', content: 'content', at: 'at_name' })
    expect(config['url']).toBeUndefined()
    expect(fieldAriaLabel({ key: 'x', label: '标签', type: 'text', required: false })).toBe('标签')
    expect(fieldAriaLabel({ key: 'x', label: '标签', ariaLabel: '可访问名', type: 'text', required: false })).toBe('可访问名')
  })

  it('validateVendorConfig：数字字符串归一、select/pattern 校验、URL 校验、未知键丢弃', () => {
    const result = validateVendorConfig(fieldsDescriptor(), {
      url: 'https://example.test/hook',
      robotUuid: 'uuid-1',
      jobsCount: '3',
      priority: 'high',
      unknownKey: 'x',
    })
    expect(result.errors).toEqual([])
    expect(result.config['jobsCount']).toBe(3)
    expect(result.config['priority']).toBe('high')
    expect(result.config['unknownKey']).toBeUndefined()

    expect(validateVendorConfig(fieldsDescriptor(), { jobsCount: 'abc' }).errors[0]).toContain('并发数')
    expect(validateVendorConfig(fieldsDescriptor(), { priority: 'nope' }).errors[0]).toContain('不是可选值')
    expect(validateVendorConfig(fieldsDescriptor(), { url: 'ftp://x/y' }).errors).toContain('回调地址必须是合法的 http/https 地址')
    expect(validateVendorConfig(fieldsDescriptor(), { baseUrl: 'not-a-url' }).errors[0]).toContain('服务地址')
  })

  it('missingReadyFields：必填文本/select/凭据缺失；false 布尔不算缺', () => {
    const missing = missingReadyFields(fieldsDescriptor(), {}, {})
    expect(missing).toContain('回调地址')
    expect(missing).toContain('应用 UUID')
    expect(missing).toContain('八爪鱼 API Key')

    const ok = missingReadyFields(fieldsDescriptor(), {
      url: 'https://example.test/hook',
      robotUuid: 'uuid-1',
    }, { apiKey: true })
    expect(ok).toEqual([])
  })

  it('applySecretInput：缺省保留、空串清空、非空覆盖；未知键忽略；pattern 校验', () => {
    const descriptor = descriptorOf({
      fields: [
        { key: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true },
        { key: 'token', label: 'Token', type: 'password', required: false, secret: true, pattern: '^[a-z]+$' },
      ],
    })
    const kept = applySecretInput(descriptor, { apiKey: 'old' }, undefined)
    expect(kept.secrets).toEqual({ apiKey: 'old' })
    expect(kept.set).toEqual({ apiKey: true })

    const cleared = applySecretInput(descriptor, { apiKey: 'old' }, { apiKey: '' })
    expect(cleared.secrets).toEqual({})

    const overridden = applySecretInput(descriptor, { apiKey: 'old' }, { apiKey: 'new', unknown: 'x' })
    expect(overridden.secrets).toEqual({ apiKey: 'new' })
    expect(overridden.errors).toEqual([])

    const badToken = applySecretInput(descriptor, {}, { token: 'ABC' })
    expect(badToken.errors[0]).toContain('Token')
  })
})

describe('模板层：占位符渲染与参数容器', () => {
  it('object 映射：config/secret/record/invocation/mapped 占位符 + 整值替换', () => {
    const descriptor = descriptorOf({
      fields: [{ key: 'robotUuid', label: '应用 UUID', type: 'text', required: true, example: 'u' }],
      request: {
        method: 'POST',
        url: '${config.baseUrl}/run',
        headers: { authorization: 'Bearer ${auth.token}', 'x-task': '${invocation.taskId}' },
        body: {
          robotUuid: '${config.robotUuid}',
          key: '${secret.apiKey}',
          at: '${record.at_name_fallback}',
          params: '${mapped.object}',
        },
      },
    })
    // at 语义走 record.targetName→chatName 回落，模板里不直接写；这里改成一个合法占位符
    descriptor.request.body = { robotUuid: '${config.robotUuid}', key: '${secret.apiKey}', params: '${mapped.object}', taskId: '${invocation.taskId}' }
    const req = renderRequest(descriptor, ctxOf({
      config: { baseUrl: 'https://api.example.test', robotUuid: 'uuid-1' },
      secrets: { apiKey: 'secret-token' },
    }))
    expect(req.url).toBe('https://api.example.test/run')
    expect(req.headers['authorization']).toBe('Bearer ${auth.token}')
    expect(req.headers['x-task']).toBe('1')
    const body = JSON.parse(req.body) as Record<string, unknown>
    expect(body['robotUuid']).toBe('uuid-1')
    expect(body['key']).toBe('secret-token')
    expect(body['taskId']).toBe(1)
    expect(body['params']).toEqual({ room_name: '李四', content: '发票 内容', at_name: '李四' })
  })

  it('五种参数容器形态与单聊 at 回落', () => {
    const styles = [
      ['object', { room_name: '李四', content: '发票 内容', at_name: '李四' }],
      ['nameValueArray', [{ name: 'room_name', value: '李四' }, { name: 'content', value: '发票 内容' }, { name: 'at_name', value: '李四' }]],
      ['nameValueTypeArray', [
        { name: 'room_name', value: '李四', type: 'str' },
        { name: 'content', value: '发票 内容', type: 'str' },
        { name: 'at_name', value: '李四', type: 'str' },
      ]],
    ] as const
    for (const [style, expected] of styles) {
      const descriptor = descriptorOf({
        mapping: { style, mapField: 'paramMap', targets: [{ semantic: 'room', defaultKey: 'room_name' }, { semantic: 'content', defaultKey: 'content' }, { semantic: 'at', defaultKey: 'at_name' }] },
        request: { method: 'POST', url: 'https://api.example.test/run', body: { params: '${mapped.object}' } },
      })
      const req = renderRequest(descriptor, ctxOf())
      expect(JSON.parse(req.body)['params']).toEqual(expected)
    }

    const jsonStyle = descriptorOf({
      mapping: { style: 'jsonStringObject', mapField: 'paramMap', targets: [{ semantic: 'room', defaultKey: 'room_name' }, { semantic: 'content', defaultKey: 'content' }, { semantic: 'at', defaultKey: 'at_name' }] },
      request: { method: 'POST', url: 'https://api.example.test/run', body: { InputArguments: '${mapped.jsonStringObject}' } },
    })
    const jsonReq = renderRequest(jsonStyle, ctxOf({ record: recordOf({ targetName: '小王', chatType: 'group' }) }))
    const inputArguments = JSON.parse(jsonReq.body)['InputArguments'] as string
    expect(JSON.parse(inputArguments)).toEqual({ room_name: '李四', content: '发票 内容', at_name: '小王' })
  })

  it('未知占位符 / 缺值 / 内联对象都抛可读错误（不静默留空）', () => {
    const unknown = descriptorOf({ request: { method: 'POST', url: 'https://api.example.test/run', body: { x: '${nope.x}' } } })
    expect(() => renderRequest(unknown, ctxOf())).toThrow(/未知占位符/)

    const missing = descriptorOf({ request: { method: 'POST', url: 'https://api.example.test/run', body: { x: '${config.robotUuid}' } } })
    expect(() => renderRequest(missing, ctxOf())).toThrow(/缺少值/)

    const inlineObject = descriptorOf({ request: { method: 'POST', url: 'https://api.example.test/run', body: { x: 'value=${mapped.object}' } } })
    expect(() => renderRequest(inlineObject, ctxOf())).toThrow(/只能整值替换/)
  })
})

describe('附加参数（八爪鱼参数增强，2026-10-21）', () => {
  /** 八爪鱼描述符 + request.body 换成直接暴露 Params（沿用真实描述符的字段/映射）。 */
  function bazhuayuWithParams(): RpaVendorDescriptor {
    return {
      ...bazhuayuAdapter.descriptor,
      request: { ...bazhuayuAdapter.descriptor.request, body: { Params: '${mapped}' } },
    }
  }

  it('默认配置仍是三个内置参数（旧行为逐字节不变）', () => {
    const req = renderRequest(bazhuayuWithParams(), ctxOf({ config: { flowId: 'flow-1' }, secrets: { apiKey: 'k-1' } }))
    const params = (JSON.parse(req.body) as Record<string, unknown>)['Params'] as Record<string, string>
    expect(params).toEqual({ room_name: '李四', content: '发票 内容', at_name: '李四' })
  })

  it('参数映射可改三个内置参数名；附加参数按值来源追加', () => {
    const config: RpaTriggerConfig = {
      flowId: 'flow-1',
      paramMap: { room: 'group_name', content: 'text', at: 'user' },
      extraParams: [
        { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
        { name: 'kw', source: 'keyword' },
        { name: 'task', source: 'taskName' },
        { name: 'at2', source: 'at' },
        { name: 'tpl', source: 'template', template: '${record.chatName}/${task.name}' },
        { name: 'typ', source: 'chatType' },
        { name: 'tid', source: 'taskId' },
        { name: 'rid', source: 'recordId' },
        { name: 'content2', source: 'content' },
      ],
    }
    const req = renderRequest(bazhuayuWithParams(), ctxOf({ config, secrets: { apiKey: 'k-1' } }))
    const params = (JSON.parse(req.body) as Record<string, unknown>)['Params'] as Record<string, string>
    expect(params['group_name']).toBe('李四')
    expect(params['text']).toBe('发票 内容')
    expect(params['user']).toBe('李四')
    expect(params['order_no']).toBe('A-001')
    expect(params['kw']).toBe('发票')
    expect(params['task']).toBe('测试任务')
    expect(params['at2']).toBe('李四')
    expect(params['tpl']).toBe('李四/测试任务')
    expect(params['typ']).toBe('单聊')
    expect(params['tid']).toBe('1')
    expect(params['rid']).toBe('2')
    expect(params['content2']).toBe('发票 内容')
    expect(Object.keys(params)).toHaveLength(12)
  })

  it('校验：重名/缺固定值/模板越界/与映射键冲突/超上限都报可读错误', () => {
    const descriptor = bazhuayuWithParams()
    const duplicate = validateVendorConfig(descriptor, {
      extraParams: [
        { name: 'x', source: 'keyword' },
        { name: 'X', source: 'taskName' },
      ],
    })
    expect(duplicate.errors.some((e) => e.includes('参数名重复'))).toBe(true)

    const noFixed = validateVendorConfig(descriptor, {
      extraParams: [{ name: 'x', source: 'fixed' }],
    })
    expect(noFixed.errors.some((e) => e.includes('固定值'))).toBe(true)

    const badTemplate = validateVendorConfig(descriptor, {
      extraParams: [{ name: 'x', source: 'template', template: '${record.notAField}' }],
    })
    expect(badTemplate.errors.some((e) => e.includes('自定义模板字段不在允许清单'))).toBe(true)

    const forbiddenRoot = validateVendorConfig(descriptor, {
      extraParams: [{ name: 'x', source: 'template', template: '${secret.apiKey}' }],
    })
    expect(forbiddenRoot.errors.some((e) => e.includes('只支持 record / task'))).toBe(true)

    const collision = validateVendorConfig(descriptor, {
      extraParams: [{ name: 'room_name', source: 'keyword' }],
    })
    expect(collision.errors.some((e) => e.includes('与参数映射的键重名'))).toBe(true)
    expect((collision.config['extraParams'] as unknown[]).length).toBe(0)

    const tooMany = validateVendorConfig(descriptor, {
      extraParams: Array.from({ length: 21 }, (_, i) => ({ name: 'p' + String(i), source: 'keyword' as const })),
    })
    expect(tooMany.errors.some((e) => e.includes('最多 20 条'))).toBe(true)
  })

  it('校验：合法列表 trim 参数名、保留顺序；空列表合法', () => {
    const descriptor = bazhuayuWithParams()
    const ok = validateVendorConfig(descriptor, {
      extraParams: [
        { name: '  order_no  ', source: 'fixed', fixedValue: ' A-001 ' },
        { name: 'kw', source: 'template', template: '${record.keyword}' },
      ],
    })
    expect(ok.errors).toEqual([])
    expect(ok.config['extraParams']).toEqual([
      { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
      { name: 'kw', source: 'template', template: '${record.keyword}' },
    ])
    const empty = validateVendorConfig(descriptor, { extraParams: [] })
    expect(empty.errors).toEqual([])
    expect(empty.config['extraParams']).toEqual([])
  })

  it('默认配置带空附加参数列表，参数来源白名单完整', () => {
    const defaults = defaultConfigFor(bazhuayuAdapter.descriptor)
    expect(defaults['extraParams']).toEqual([])
    const field = bazhuayuAdapter.descriptor.fields.find((item) => item.key === 'extraParams')
    expect(field?.type).toBe('paramList')
    expect(field?.paramSources).toContain('template')
    expect(field?.paramSources).toContain('fixed')
  })
})

describe('鉴权层', () => {
  const bearerAdapter: RpaVendorAdapter = {
    descriptor: descriptorOf({
      auth: {
        modes: [{ strategy: 'bearer', fields: [{ key: 'token', label: '访问令牌', type: 'password', required: true, secret: true }] }],
      },
    }),
  }

  it('bearer：无占位符时补 Authorization: Bearer <token>；有占位符时替换裸 token', async () => {
    const deps: RpaAuthDeps = { send: async () => { throw new Error('不该换 token') } }
    const plain: RpaHttpRequest = { method: 'POST', url: 'https://api.example.test/run', headers: {}, body: '', contentType: 'application/json' }
    const authed = await applyAuth(bearerAdapter, plain, ctxOf({ secrets: { token: 'tok-1' } }), deps)
    expect(authed.headers['Authorization']).toBe('Bearer tok-1')

    const templated: RpaHttpRequest = { ...plain, headers: { authorization: 'Bearer ${auth.token}' } }
    const replaced = await applyAuth(bearerAdapter, templated, ctxOf({ secrets: { token: 'tok-1' } }), deps)
    expect(replaced.headers['authorization']).toBe('Bearer tok-1')
  })

  it('header：凭据字段 key 即请求头名；缺失凭据报可读错误', async () => {
    const adapter: RpaVendorAdapter = {
      descriptor: descriptorOf({
        auth: {
          modes: [{ strategy: 'header', fields: [{ key: 'X-Api-Key', label: 'API Key', type: 'password', required: true, secret: true }] }],
        },
      }),
    }
    const req: RpaHttpRequest = { method: 'POST', url: 'https://api.example.test/run', headers: {}, body: '', contentType: 'application/json' }
    const authed = await applyAuth(adapter, req, ctxOf({ secrets: { 'X-Api-Key': 'k-1' } }), { send: async () => { throw new Error('noop') } })
    expect(authed.headers['X-Api-Key']).toBe('k-1')
    await expect(applyAuth(adapter, req, ctxOf({ secrets: {} }), { send: async () => { throw new Error('noop') } }))
      .rejects.toThrow(/缺少凭据/)
  })

  it('token-exchange：GET 换 token（无 body）、缓存复用、expiresIn 生效、失败可读', async () => {
    const adapter: RpaVendorAdapter = {
      descriptor: descriptorOf({
        auth: {
          modes: [{
            strategy: 'token-exchange',
            fields: [{ key: 'accessKeyId', label: 'AccessKeyId', type: 'password', required: true, secret: true }],
            exchange: {
              method: 'GET',
              url: '${config.baseUrl}/token/create',
              query: { accessKeyId: '${secret.accessKeyId}' },
              tokenPath: 'data.token',
              expiresInPath: 'data.expiresIn',
            },
          }],
        },
        governance: { contentOutbound: true, hosts: [{ kind: 'exact', value: 'api.example.test' }], allowCustomBaseUrl: true, privacySection: 'G3' },
      }),
    }
    const sent: RpaHttpRequest[] = []
    const deps: RpaAuthDeps = {
      send: async (req) => {
        sent.push(req)
        return { status: 200, bodyText: JSON.stringify({ data: { token: 'tok-1', expiresIn: 3600 } }) }
      },
    }
    const ctx = ctxOf({ config: { baseUrl: 'https://api.example.test' }, secrets: { accessKeyId: 'ak' } })
    const req: RpaHttpRequest = { method: 'POST', url: 'https://api.example.test/run', headers: {}, body: '', contentType: 'application/json' }
    const authed = await applyAuth(adapter, req, ctx, deps)
    expect(authed.headers['Authorization']).toBe('Bearer tok-1')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe('GET')
    expect(sent[0]?.body).toBe('')
    expect(sent[0]?.url).toContain('accessKeyId=ak')

    // 第二次命中缓存：不再请求 token 端点（清缓存后才会重新换）
    await applyAuth(adapter, req, ctx, deps)
    expect(sent).toHaveLength(1)
    clearTokenCache()
    await applyAuth(adapter, req, ctx, deps)
    expect(sent).toHaveLength(2)

    const failing: RpaAuthDeps = { send: async () => ({ status: 500, bodyText: '' }) }
    clearTokenCache()
    await expect(applyAuth(adapter, req, ctx, failing)).rejects.toThrow(/换.*访问令牌失败：HTTP 500/)
  })

  it('token-exchange：form-urlencoded 换 token 体按表单编码（UiPath OAuth 口径）', async () => {
    const adapter: RpaVendorAdapter = {
      descriptor: descriptorOf({
        auth: {
          modes: [{
            strategy: 'token-exchange',
            fields: [
              { key: 'clientId', label: 'Client ID', type: 'password', required: true, secret: true },
              { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, secret: true },
            ],
            exchange: {
              method: 'POST',
              url: '${config.baseUrl}/connect/token',
              contentType: 'application/x-www-form-urlencoded',
              body: {
                grant_type: 'client_credentials',
                client_id: '${secret.clientId}',
                client_secret: '${secret.clientSecret}',
                scope: 'OR.Folders',
              },
              tokenPath: 'access_token',
            },
          }],
        },
      }),
    }
    const sent: RpaHttpRequest[] = []
    const deps: RpaAuthDeps = {
      send: async (req) => {
        sent.push(req)
        return { status: 200, bodyText: JSON.stringify({ access_token: 'tok-2' }) }
      },
    }
    const ctx = ctxOf({
      config: { baseUrl: 'https://cloud.uipath.com' },
      secrets: { clientId: 'cid', clientSecret: 'csec' },
    })
    const req: RpaHttpRequest = { method: 'POST', url: 'https://api.example.test/run', headers: {}, body: '', contentType: 'application/json' }
    const authed = await applyAuth(adapter, req, ctx, deps)
    expect(authed.headers['Authorization']).toBe('Bearer tok-2')
    expect(sent[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(sent[0]?.body ?? '')
    expect(params.get('grant_type')).toBe('client_credentials')
    expect(params.get('client_id')).toBe('cid')
    expect(params.get('client_secret')).toBe('csec')
    expect(params.get('scope')).toBe('OR.Folders')
  })

  it('custom：只调 signRequest，不自动加 Authorization；缺失钩子报错', async () => {
    let signed = 0
    const adapter: RpaVendorAdapter = {
      descriptor: descriptorOf({
        auth: { modes: [{ strategy: 'custom', fields: [], custom: 'test-rpc' }] },
      }),
      signRequest: (req) => {
        signed += 1
        req.headers['x-signature'] = 'sig'
      },
    }
    const req: RpaHttpRequest = { method: 'POST', url: 'https://api.example.test/run', headers: {}, body: '', contentType: 'application/json' }
    const authed = await applyAuth(adapter, req, ctxOf(), { send: async () => { throw new Error('noop') } })
    expect(authed.headers['x-signature']).toBe('sig')
    expect(authed.headers['Authorization']).toBeUndefined()
    expect(signed).toBe(1)

    const noHook: RpaVendorAdapter = { descriptor: adapter.descriptor }
    await expect(applyAuth(noHook, req, ctxOf(), { send: async () => { throw new Error('noop') } }))
      .rejects.toThrow(/没有实现 signRequest/)
  })

  it('auth.modes 按 when.field/equals 选第一个匹配；都不匹配报错', async () => {
    const adapter: RpaVendorAdapter = {
      descriptor: descriptorOf({
        auth: {
          modes: [
            {
              strategy: 'bearer',
              when: { field: 'authMode', equals: ['pat'] },
              fields: [{ key: 'pat', label: 'PAT', type: 'password', required: true, secret: true }],
            },
            {
              strategy: 'header',
              when: { field: 'authMode', equals: ['key'] },
              fields: [{ key: 'X-Key', label: 'Key', type: 'password', required: true, secret: true }],
            },
          ],
        },
      }),
    }
    const req: RpaHttpRequest = { method: 'POST', url: 'https://api.example.test/run', headers: {}, body: '', contentType: 'application/json' }
    const deps: RpaAuthDeps = { send: async () => { throw new Error('noop') } }
    const pat = await applyAuth(adapter, req, ctxOf({ config: { authMode: 'pat' }, secrets: { pat: 'p' } }), deps)
    expect(pat.headers['Authorization']).toBe('Bearer p')
    const key = await applyAuth(adapter, req, ctxOf({ config: { authMode: 'key' }, secrets: { 'X-Key': 'k' } }), deps)
    expect(key.headers['X-Key']).toBe('k')
    await expect(applyAuth(adapter, req, ctxOf({ config: { authMode: 'nope' } }), deps))
      .rejects.toThrow(/未匹配到/)
  })
})

describe('派发管道：主机校验 / 响应解析 / 失败分类 / 重试', () => {
  it('成功：业务码通过并解析 externalTaskId（支持 value[0].Key 路径）', async () => {
    const adapter = adapterOf({
      response: { okHttpStatus: [200], okPath: 'code', okValue: 200, externalTaskIdPath: 'value[0].Key', messagePath: 'message' },
      request: { method: 'POST', url: 'https://api.example.test/run', body: { robot: '${config.robotUuid}', params: '${mapped.object}' } },
    })
    const calls: Array<{ url: string; body: string }> = []
    const outcome = await dispatchRpaRecord({
      adapter,
      ctx: ctxOf({ config: { robotUuid: 'uuid-1' } }),
      deps: {
        fetchImpl: async (url, init) => {
          calls.push({ url, body: String(init?.body) })
          return new Response(JSON.stringify({ code: 200, value: [{ Key: 'job-9' }] }), { status: 200 })
        },
      },
      buildDeps: buildDepsOf(),
    })
    expect(outcome).toEqual({ status: 'sent', externalTaskId: 'job-9' })
    expect(calls[0]?.url).toBe('https://api.example.test/run')
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(body['robot']).toBe('uuid-1')
    expect(body['params']).toEqual({ room_name: '李四', content: '发票 内容', at_name: '李四' })
  })

  it('业务码失败 / HTTP 非 2xx 都返回 failed + 可读原因', async () => {
    const adapter = adapterOf({
      response: { okHttpStatus: [200], okPath: 'code', okValue: 200, messagePath: 'message' },
    })
    const business = await dispatchRpaRecord({
      adapter,
      ctx: ctxOf(),
      deps: { fetchImpl: async () => new Response(JSON.stringify({ code: 500, message: '余额不足' }), { status: 200 }) },
      buildDeps: buildDepsOf(),
    })
    expect(business.status).toBe('failed')
    expect(business.error).toContain('余额不足')

    const httpFail = await dispatchRpaRecord({
      adapter,
      ctx: ctxOf(),
      deps: { fetchImpl: async () => new Response('boom', { status: 404 }) },
      buildDeps: buildDepsOf(),
    })
    expect(httpFail.status).toBe('failed')
    expect(String(httpFail.error)).toContain('404')
  })

  it('主机白名单：不在 governance.hosts 内 → failed 且不发请求', async () => {
    const adapter = adapterOf()
    let requests = 0
    const outcome = await dispatchRpaRecord({
      adapter,
      ctx: ctxOf(),
      deps: {
        fetchImpl: async () => {
          requests += 1
          return new Response(JSON.stringify({ code: 200 }), { status: 200 })
        },
      },
      buildDeps: buildDepsOf(),
    })
    // 合成描述符白名单是 api.example.test，默认 request.url 同 host，先构造越界 URL
    expect(outcome.status).toBe('sent')
    expect(requests).toBe(1)

    const evil = adapterOf({ request: { method: 'POST', url: 'https://evil.example/run', body: {} } })
    let evilRequests = 0
    const blocked = await dispatchRpaRecord({
      adapter: evil,
      ctx: ctxOf(),
      deps: {
        fetchImpl: async () => {
          evilRequests += 1
          return new Response('{}', { status: 200 })
        },
      },
      buildDeps: buildDepsOf(),
    })
    expect(blocked.status).toBe('failed')
    expect(String(blocked.error)).toContain('不在允许清单内')
    expect(evilRequests).toBe(0)
  })

  it('allowCustomBaseUrl：host 等于配置 baseUrl 时放行；localhost/私网 IPv4 字面量仍拒绝', async () => {
    const custom = descriptorOf({
      governance: {
        contentOutbound: true,
        hosts: [{ kind: 'exact', value: 'api.example.test' }],
        allowCustomBaseUrl: true,
        privacySection: 'G3',
      },
      request: { method: 'POST', url: '${config.baseUrl}/run', body: {} },
    })
    const adapter: RpaVendorAdapter = { descriptor: custom }
    const fetchOk = async (): Promise<Response> => new Response(JSON.stringify({ code: 200 }), { status: 200 })
    const allowed = await dispatchRpaRecord({
      adapter,
      ctx: ctxOf({ config: { baseUrl: 'https://private.corp.example' } }),
      deps: { fetchImpl: fetchOk },
      buildDeps: buildDepsOf(),
    })
    expect(allowed.status).toBe('sent')

    for (const baseUrl of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://192.168.1.20:9000']) {
      const blocked = await dispatchRpaRecord({
        adapter,
        ctx: ctxOf({ config: { baseUrl } }),
        deps: { fetchImpl: fetchOk },
        buildDeps: buildDepsOf(),
      })
      expect(blocked.status).toBe('failed')
      expect(String(blocked.error)).toContain('不在允许清单内')
    }
  })

  it('内置 Webhook 特例：hosts 为空 ⇒ 允许任意 http(s)（含本机/内网，保持旧行为）；非 http(s) 拒绝', async () => {
    const webhook = findVendor('webhook')
    expect(webhook).toBeDefined()
    const urls: string[] = []
    const outcome = await dispatchRpaRecord({
      adapter: webhook as RpaVendorAdapter,
      ctx: ctxOf({ config: { url: 'http://127.0.0.1:9999/callback' }, record: recordOf({ targetName: '', chatType: 'private' }) }),
      deps: {
        fetchImpl: async (url) => {
          urls.push(url)
          return new Response('ok', { status: 200 })
        },
      },
      buildDeps: buildDepsOf(),
    })
    expect(outcome.status).toBe('sent')
    expect(urls).toEqual(['http://127.0.0.1:9999/callback'])

    const bad = await dispatchRpaRecord({
      adapter: webhook as RpaVendorAdapter,
      ctx: ctxOf({ config: { url: 'ftp://127.0.0.1/callback' } }),
      deps: { fetchImpl: async () => new Response('ok', { status: 200 }) },
      buildDeps: buildDepsOf(),
    })
    expect(bad.status).toBe('failed')
    expect(String(bad.error)).toContain('http/https')
  })

  it('重试次数取 descriptor.retry.maxAttempts：1 次不重试，2 次对 5xx 重试一次', async () => {
    const once = adapterOf({ retry: { maxAttempts: 1, retryOn: ['http-5xx'] } })
    let onceCalls = 0
    await dispatchRpaRecord({
      adapter: once,
      ctx: ctxOf(),
      deps: {
        fetchImpl: async () => {
          onceCalls += 1
          return new Response('boom', { status: 500 })
        },
      },
      buildDeps: buildDepsOf(),
    })
    expect(onceCalls).toBe(1)

    const twice = adapterOf({ retry: { maxAttempts: 2, retryOn: ['http-5xx'] } })
    let twiceCalls = 0
    const outcome = await dispatchRpaRecord({
      adapter: twice,
      ctx: ctxOf(),
      deps: {
        fetchImpl: async () => {
          twiceCalls += 1
          return new Response('boom', { status: 500 })
        },
      },
      buildDeps: buildDepsOf(),
    })
    expect(outcome.status).toBe('failed')
    expect(twiceCalls).toBe(2)
  })

  it('非 Webhook 厂商不碰图片解码（buildDeps.decodeImage 不被调用）', async () => {
    let decodeCalls = 0
    const outcome = await dispatchRpaRecord({
      adapter: adapterOf(),
      ctx: ctxOf(),
      deps: { fetchImpl: async () => new Response(JSON.stringify({ code: 200 }), { status: 200 }) },
      buildDeps: buildDepsOf(async () => {
        decodeCalls += 1
        return { url: 'data:image/png;base64,AAAA' }
      }),
    })
    expect(outcome.status).toBe('sent')
    expect(decodeCalls).toBe(0)
  })
})

describe('存储派生：externalTaskId 往返', () => {
  it('rowToTrigger 解析 external_task_id；空值不出现该字段', () => {
    const base: Record<string, unknown> = {
      id: 1,
      task_id: 2,
      task_name: '任务',
      chat_username: 'wxid_lisi',
      chat_name: '李四',
      target_username: '',
      target_name: '',
      keyword: '发票',
      text: '内容',
      images: '[]',
      message_local_id: 3,
      message_sort_seq: 4,
      triggered_at: 5,
      callback_status: 'sent',
      external_task_id: 'job-9',
    }
    expect(rowToTrigger(base).externalTaskId).toBe('job-9')
    expect(rowToTrigger({ ...base, external_task_id: '' }).externalTaskId).toBeUndefined()
  })
})
