// @vitest-environment node
/**
 * 多 RPA 厂商**描述符契约守卫**（2026-10-21）。
 *
 * 背景：触发方式从「Webhook / 八爪鱼」硬编码分支升级为「注册表 + 描述符驱动」的通用管道。
 * 描述符是前后端共用的**唯一真源**（UI 动态表单、保存校验、标记已完善、派发都读它），
 * 所以这里把契约钉死：id 唯一/顺序、必填元数据、字段键唯一、必填字段有示例或默认值、
 * secret 字段声明、映射三键、请求/响应/重试/治理字段齐全、experimental 必须写清待联调、
 * 描述符必须可 JSON 序列化（没有 undefined/函数泄漏进 listRpaVendors）。
 *
 * 本文件同时单测阿里云 RPC 签名函数（`aliyunRpcSign`）：签名算法是官方原文口径，
 * 用独立实现的 HMAC-SHA1 重新算一遍，而不是只断言「字符串非空」。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  RPA_REGISTRY_VERSION,
  RPA_VENDORS,
  RPA_VENDOR_MAP,
  findVendor,
  listVendorDescriptors,
} from '../src/query/rpa/registry.ts'
import type { RpaField, RpaVendorDescriptor } from '../src/types-rpa.ts'
import { aliyunRpcSign, canonicalizedQuery, percentEncode } from '../src/query/rpa/vendors/aliyun-rpa.ts'

/** 注册表内固定 id 与顺序（UI 顺序也依赖它）。 */
const EXPECTED_IDS = ['webhook', 'bazhuayu', 'yingdao', 'uipath', 'aliyun-rpa', 'laiye', 'shizai'] as const
/** 参数核对日期（契约要求）。 */
const VERIFIED_AT = '2026-10-21'
/** 明确要求 experimental 的厂商（官方契约有缺失/待联调）。 */
const EXPERIMENTAL_IDS = ['aliyun-rpa', 'laiye', 'shizai']
/** 附加参数允许的值来源（与 `types-rpa.ts` 的 RpaParamSource 同步）。 */
const PARAM_SOURCE_SET = new Set([
  'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
  'taskId', 'recordId', 'fixed', 'template',
])

/** 递归遍历描述符里的每个值，用于「不许有 undefined/函数」守卫。 */
function walkDescriptor(value: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  visit(path, value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkDescriptor(item, path + '[' + String(index) + ']', visit))
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      walkDescriptor(item, path === '' ? key : path + '.' + key, visit)
    }
  }
}

/** 字段是否声明了 secret（顶层 fields 的 secret=true 或出现在 auth.modes[].fields）。 */
function isSecretField(descriptor: RpaVendorDescriptor, field: RpaField): boolean {
  if (field.secret === true) return true
  return descriptor.auth.modes.some((mode) => mode.fields.some((item) => item.key === field.key && item.secret === true))
}

describe('RPA 厂商注册表', () => {
  it('内置顺序与 id 固定', () => {
    expect(RPA_VENDORS.map((adapter) => adapter.descriptor.id)).toEqual([...EXPECTED_IDS])
    expect([...RPA_VENDOR_MAP.keys()]).toEqual([...EXPECTED_IDS])
    expect(RPA_VENDOR_MAP.size).toBe(EXPECTED_IDS.length)
  })

  it('findVendor：命中注册表 / 未知 id 返回 undefined', () => {
    expect(findVendor('webhook')?.descriptor.id).toBe('webhook')
    expect(findVendor('yingdao')?.descriptor.id).toBe('yingdao')
    expect(findVendor('')).toBeUndefined()
    expect(findVendor('vendor-that-does-not-exist')).toBeUndefined()
  })

  it('listVendorDescriptors 返回可序列化副本（改副本不影响注册表）', () => {
    const items = listVendorDescriptors()
    expect(items).toHaveLength(EXPECTED_IDS.length)
    expect(items.map((item) => item.id)).toEqual([...EXPECTED_IDS])
    expect(() => JSON.stringify(items)).not.toThrow()
    const snapshot = JSON.stringify(items)
    const first = items[0]
    if (first !== undefined) first.name = '被改掉的名字'
    expect(RPA_VENDORS[0]?.descriptor.name).not.toBe('被改掉的名字')
    expect(JSON.stringify(listVendorDescriptors())).toBe(snapshot)
  })

  it('注册表版本形如 ISO 日期（与厂商 descriptor.version 分开）', () => {
    expect(RPA_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const adapter of RPA_VENDORS) {
      // 描述符版本是「参数/协议版本」，不是日期，两者不能混用。
      expect(adapter.descriptor.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

describe('厂商描述符契约', () => {
  for (const adapter of RPA_VENDORS) {
    describe(adapter.descriptor.id, () => {
      const descriptor = adapter.descriptor

      it('基础元数据齐全且可序列化', () => {
        expect(String(descriptor.id)).not.toBe('')
        expect(String(descriptor.name)).not.toBe('')
        expect(String(descriptor.vendor)).not.toBe('')
        expect(String(descriptor.version)).not.toBe('')
        expect(String(descriptor.summary)).not.toBe('')
        expect(['stable', 'experimental']).toContain(descriptor.status)
        expect(EXPECTED_IDS).toContain(descriptor.id as (typeof EXPECTED_IDS)[number])
        // 契约：experimental 集合固定（官方未公开字段不许标 stable）。
        expect(descriptor.status === 'experimental').toBe(EXPERIMENTAL_IDS.includes(descriptor.id))
        // 描述符必须能被 listRpaVendors 原样 JSON 往返：任何 undefined/函数都是契约错误。
        walkDescriptor(descriptor, '', (path, value) => {
          expect(value, path + ' 不能是 undefined').not.toBeUndefined()
          expect(typeof value, path + ' 不能是函数').not.toBe('function')
        })
        expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor)
      })

      it('来源文档为 https 且参数核对日期固定', () => {
        expect(descriptor.docs.home).toMatch(/^https:\/\//)
        expect(descriptor.docs.triggerApi).toMatch(/^https:\/\//)
        expect(descriptor.docs.lastVerifiedAt).toBe(VERIFIED_AT)
        expect(String(descriptor.docs.pageVersion ?? '')).not.toBe('')
      })

      it('能力声明合法且与 idempotency 一致', () => {
        expect(descriptor.capabilities.direction).toBe('outbound')
        expect(typeof descriptor.capabilities.synchronous).toBe('boolean')
        expect(['callback', 'poll', 'none']).toContain(descriptor.capabilities.completion)
        expect(['vendor-key', 'none']).toContain(descriptor.capabilities.idempotency)
        expect(descriptor.capabilities.deployment.length).toBeGreaterThan(0)
        for (const item of descriptor.capabilities.deployment) expect(['cloud', 'onprem']).toContain(item)
      })

      it('字段：key 唯一 / 必填有示例或默认值 / secret 声明完整', () => {
        const keys = descriptor.fields.map((field) => field.key)
        expect(new Set(keys).size).toBe(keys.length)
        for (const field of descriptor.fields) {
          expect(String(field.label)).not.toBe('')
          expect(['text', 'password', 'number', 'boolean', 'select', 'map', 'paramList']).toContain(field.type)
          expect(typeof field.required).toBe('boolean')
          if (field.required && field.secret !== true) {
            // 必填字段必须在 UI 上给出可照抄的示例或默认值（secret 除外：不能放示例凭据）。
            expect(field.example !== undefined || field.defaultValue !== undefined, field.key).toBe(true)
          }
          if (field.type === 'paramList') {
            // 附加参数控件：来源白名单非空且只含合法值；maxItems 若声明必须是正整数。
            const sources = field.paramSources ?? []
            expect(sources.length, field.key).toBeGreaterThan(0)
            for (const source of sources) expect(PARAM_SOURCE_SET.has(source), field.key + ':' + source).toBe(true)
            if (field.maxItems !== undefined) {
              expect(Number.isInteger(field.maxItems) && field.maxItems > 0, field.key).toBe(true)
            }
            expect(descriptor.mapping.extrasField, field.key + ' 必须被 mapping.extrasField 引用').toBe(field.key)
          }
          if (field.type === 'select') {
            expect(Array.isArray(field.options), field.key).toBe(true)
            expect(field.options?.length ?? 0).toBeGreaterThan(0)
            if (field.defaultValue !== undefined && typeof field.defaultValue === 'string') {
              expect(field.options?.some((option) => option.value === field.defaultValue), field.key).toBe(true)
            }
          }
          if (field.type === 'map') {
            const value = field.defaultValue
            expect(typeof value, field.key).toBe('object')
            expect(value, field.key).not.toBeNull()
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
              const map = value as Record<string, unknown>
              expect(Object.keys(map).sort()).toEqual(['at', 'content', 'room'])
            }
          }
          // secret 字段必须进 trigger_secret 且只回「是否已配置」。
          if (field.secret === true) expect(isSecretField(descriptor, field)).toBe(true)
        }
      })

      it('鉴权模式：声明合法、custom 必须有 signRequest 钩子', () => {
        expect(Array.isArray(descriptor.auth.modes)).toBe(true)
        // 内置 webhook 无凭据；八爪鱼的 Key 直接写进请求模板 header（X-Api-Key: ${secret.apiKey}），
        // 其余厂商必须有可选的鉴权模式声明。
        if (descriptor.auth.modes.length === 0) {
          expect(['webhook', 'bazhuayu']).toContain(descriptor.id)
        } else {
          expect(descriptor.auth.modes.length).toBeGreaterThan(0)
        }
        for (const mode of descriptor.auth.modes) {
          expect(['header', 'bearer', 'token-exchange', 'custom']).toContain(mode.strategy)
          expect(Array.isArray(mode.fields)).toBe(true)
          if (mode.strategy === 'custom') {
            expect(String(mode.custom ?? '')).not.toBe('')
            expect(typeof adapter.signRequest, descriptor.id + ' 的 custom 模式必须有 signRequest').toBe('function')
          }
          if (mode.strategy === 'bearer' || mode.strategy === 'header') {
            expect(mode.fields.length).toBeGreaterThan(0)
          }
          if (mode.strategy === 'token-exchange') {
            // 换 token 是自包含声明：URL/取 token 路径/有效期路径都要有。
            expect(mode.exchange, descriptor.id).toBeDefined()
            const exchange = mode.exchange
            if (exchange === undefined) continue
            expect(exchange.method).toMatch(/^(GET|POST)$/)
            expect(exchange.url).toMatch(/^(https:\/\/|\$\{config\.baseUrl\})/)
            expect(String(exchange.tokenPath)).not.toBe('')
            expect((exchange.headerPrefix ?? 'Bearer ').startsWith('Bearer')).toBe(true)
          }
          // when 必须指向一个真实存在的配置字段（否则永远选不中）。
          if (mode.when !== undefined) {
            expect(descriptor.fields.some((field) => field.key === mode.when?.field), mode.when.field).toBe(true)
            expect(mode.when.equals.length).toBeGreaterThan(0)
          }
        }
      })

      it('参数映射：三个语义位齐全且 mapField 有对应字段', () => {
        expect(['object', 'nameValueArray', 'nameValueTypeArray', 'jsonStringObject', 'formParams']).toContain(
          descriptor.mapping.style,
        )
        expect(String(descriptor.mapping.mapField)).not.toBe('')
        expect(descriptor.mapping.targets.map((target) => target.semantic).sort()).toEqual(['at', 'content', 'room'])
        for (const target of descriptor.mapping.targets) expect(String(target.defaultKey)).not.toBe('')
        // mapField 建议指向一个 map 字段；没声明字段的厂商（固定参数）允许缺省。
        const mapField = descriptor.fields.find((field) => field.key === descriptor.mapping.mapField)
        if (mapField !== undefined) expect(mapField.type).toBe('map')
      })

      it('请求/响应/重试/治理声明齐全', () => {
        expect(['POST', 'PUT']).toContain(descriptor.request.method)
        // URL 要么是固定 https 主机（内置厂商），要么从配置的 baseUrl 模板拼出。
        expect(descriptor.request.url).toMatch(/^(https:\/\/|\$\{config\.)/)
        expect(descriptor.request.body).not.toBeUndefined()
        for (const [header, value] of Object.entries(descriptor.request.headers ?? {})) {
          expect(typeof header).toBe('string')
          expect(typeof value).toBe('string')
        }
        expect(descriptor.response.okHttpStatus.length).toBeGreaterThan(0)
        for (const status of descriptor.response.okHttpStatus) expect(Number.isInteger(status)).toBe(true)
        if (descriptor.response.okPath !== undefined) expect(descriptor.response.okValue).not.toBeUndefined()
        expect(Number.isInteger(descriptor.retry.maxAttempts)).toBe(true)
        expect(descriptor.retry.maxAttempts).toBeGreaterThanOrEqual(1)
        expect(descriptor.retry.maxAttempts).toBeLessThanOrEqual(5)
        for (const item of descriptor.retry.retryOn) expect(['network', 'http-5xx', 'http-429']).toContain(item)
        // 无幂等键的厂商禁止自动重试（内置 webhook/八爪鱼是行为兼容例外：旧实现就是 2 次）。
        if (descriptor.capabilities.idempotency === 'none' && !['webhook', 'bazhuayu'].includes(descriptor.id)) {
          expect(descriptor.retry.maxAttempts, descriptor.id + ' 无幂等键必须只发 1 次').toBe(1)
        }
      })

      it('治理：隐私章节固定 G3 / 主机白名单（webhook 例外）', () => {
        expect(descriptor.governance.privacySection).toBe('G3')
        expect(descriptor.governance.contentOutbound).toBe(true)
        expect(Array.isArray(descriptor.governance.hosts)).toBe(true)
        if (descriptor.id === 'webhook') {
          // 内置 Webhook：任意 http(s) 地址（旧行为），只靠 allowCustomBaseUrl 放行。
          expect(descriptor.governance.hosts).toHaveLength(0)
          expect(descriptor.governance.allowCustomBaseUrl).toBe(true)
        } else {
          expect(descriptor.governance.hosts.length, descriptor.id).toBeGreaterThan(0)
          for (const host of descriptor.governance.hosts) {
            expect(['exact', 'suffix']).toContain(host.kind)
            expect(String(host.value)).not.toBe('')
            expect(host.value).not.toMatch(/^https?:\/\//)
          }
        }
      })

      it('风险与实验性说明：risks 非空，experimental 写明待联调/POC', () => {
        expect(descriptor.risks.length).toBeGreaterThan(0)
        for (const risk of descriptor.risks) expect(String(risk).trim()).not.toBe('')
        if (descriptor.status === 'experimental') {
          const notes = (descriptor.notes ?? []).join('\n')
          expect(notes.length, descriptor.id + ' 必须写 notes').toBeGreaterThan(0)
          // 契约：官方未公开的字段必须写清「待联调」（或等价的 POC/核对口径）。
          expect(notes + '\n' + descriptor.risks.join('\n')).toMatch(/待联调|联调核对|POC/)
          expect(descriptor.notes?.length ?? 0).toBeGreaterThan(0)
        }
      })
    })
  }
})

describe('逐厂商关键契约（防止重构时悄悄改协议）', () => {
  const byId = new Map(RPA_VENDORS.map((adapter) => [adapter.descriptor.id, adapter]))
  const descriptorOf = (id: string): RpaVendorDescriptor => {
    const adapter = byId.get(id)
    if (adapter === undefined) throw new Error('缺少厂商：' + id)
    return adapter.descriptor
  }

  it('webhook：内置地址字段 / 无凭据 / buildRequest 钩子', () => {
    const adapter = byId.get('webhook')
    expect(adapter).toBeDefined()
    const descriptor = descriptorOf('webhook')
    expect(descriptor.auth.modes).toHaveLength(0)
    expect(typeof adapter?.buildRequest).toBe('function')
    const urlField = descriptor.fields.find((field) => field.key === 'url')
    expect(urlField?.required).toBe(true)
    expect(urlField?.ariaLabel).toBe('Webhook 地址')
    expect(descriptor.retry.maxAttempts).toBe(2)
  })

  it('bazhuayu：固定 URL + X-Api-Key + 旧 body 形状（回归基线）', () => {
    const descriptor = descriptorOf('bazhuayu')
    expect(descriptor.request.url).toBe('https://api-rpa.bazhuayu.com/api/bots/scheduling/start')
    expect(descriptor.request.headers?.['X-Api-Key']).toBe('${secret.apiKey}')
    const flowField = descriptor.fields.find((field) => field.key === 'flowId')
    expect(flowField?.ariaLabel).toBe('八爪鱼 FlowId')
    expect(flowField?.required).toBe(true)
    const apiKeyField = descriptor.fields.find((field) => field.key === 'apiKey')
    expect(apiKeyField?.ariaLabel).toBe('八爪鱼 API Key')
    expect(apiKeyField?.secret).toBe(true)
    expect(apiKeyField?.required).toBe(true)
    const body = descriptor.request.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ['FlowId', 'FlowContentRetrievalMode', 'Params', 'SpecifiedBot', 'SpecifiedPublicationVersion', 'UserStartSource'].sort(),
    )
    expect(body['Params']).toBe('${mapped}')
    expect(body['FlowContentRetrievalMode']).toBe('ByNewestContent')
    expect(body['UserStartSource']).toBe('OpenApi')
  })

  it('yingdao：AK/SK token-exchange + nameValueTypeArray 参数', () => {
    const adapter = byId.get('yingdao')
    const descriptor = descriptorOf('yingdao')
    expect(typeof adapter?.buildRequest).toBe('function')
    expect(descriptor.mapping.style).toBe('nameValueTypeArray')
    expect(descriptor.capabilities.idempotency).toBe('vendor-key')
    const mode = descriptor.auth.modes[0]
    expect(mode?.strategy).toBe('token-exchange')
    expect(mode?.exchange?.url).toBe('${config.baseUrl}/oapi/token/v2/token/create')
    expect(mode?.exchange?.query?.['accessKeyId']).toBe('${secret.accessKeyId}')
    expect(mode?.exchange?.query?.['accessKeySecret']).toBe('${secret.accessKeySecret}')
    expect(mode?.exchange?.tokenPath).toBe('data.accessToken')
    expect(mode?.exchange?.expiresInPath).toBe('expiresIn')
    expect(descriptor.request.url).toBe('${config.baseUrl}/oapi/dispatch/v2/job/start')
    expect(descriptor.response.okPath).toBe('code')
    expect(descriptor.response.okValue).toBe(200)
    expect(descriptor.response.externalTaskIdPath).toBe('data.jobUuid')
    // 官方响应字段名推断必须在 notes 里写明待联调。
    expect((descriptor.notes ?? []).join('\n')).toMatch(/accessToken|token 响应/)
  })

  it('uipath：PAT/OAuth 双模式 + X-UIPATH-FolderKey + Job 数组解析', () => {
    const adapter = byId.get('uipath')
    const descriptor = descriptorOf('uipath')
    expect(descriptor.auth.modes).toHaveLength(2)
    const pat = descriptor.auth.modes.find((mode) => mode.strategy === 'bearer')
    const oauth = descriptor.auth.modes.find((mode) => mode.strategy === 'token-exchange')
    expect(pat?.when).toEqual({ field: 'authMode', equals: ['pat'] })
    expect(oauth?.when).toEqual({ field: 'authMode', equals: ['oauth'] })
    expect(oauth?.exchange?.url).toBe('${config.baseUrl}/${config.organizationName}/identity_/connect/token')
    expect(oauth?.exchange?.tokenPath).toBe('access_token')
    expect(oauth?.exchange?.expiresInPath).toBe('expires_in')
    const body = oauth?.exchange?.body as Record<string, unknown> | undefined
    expect(body?.['grant_type']).toBe('client_credentials')
    expect(body?.['client_id']).toBe('${secret.clientId}')
    expect(body?.['client_secret']).toBe('${secret.clientSecret}')
    expect(descriptor.request.headers?.['X-UIPATH-FolderKey']).toBe('${config.folderKey}')
    expect(descriptor.mapping.style).toBe('jsonStringObject')
    expect(descriptor.response.externalTaskIdPath).toBe('value[0].Key')
    expect(descriptor.retry.maxAttempts).toBe(1)
    expect(typeof adapter?.buildRequest).toBe('function')
    expect(typeof adapter?.parseResponse).toBe('function')
  })

  it('aliyun-rpa：experimental + custom 签名 + 两套接口族', () => {
    const adapter = byId.get('aliyun-rpa')
    const descriptor = descriptorOf('aliyun-rpa')
    expect(descriptor.status).toBe('experimental')
    expect(typeof adapter?.buildRequest).toBe('function')
    expect(typeof adapter?.signRequest).toBe('function')
    const mode = descriptor.auth.modes[0]
    expect(mode?.strategy).toBe('custom')
    expect(mode?.custom).toBe('aliyun-rpc-hmac-sha1')
    expect(mode?.fields.map((field) => field.key).sort()).toEqual(['accessKeyId', 'accessKeySecret'])
    const family = descriptor.fields.find((field) => field.key === 'apiFamily')
    expect(family?.options?.map((option) => option.value).sort()).toEqual(['local', 'service'])
    expect(descriptor.mapping.style).toBe('nameValueArray')
    expect(descriptor.capabilities.idempotency).toBe('vendor-key')
    expect(descriptor.request.url).toBe('${config.baseUrl}/rpa/openapi/raas/task/CreateTask')
    expect(descriptor.response.externalTaskIdPath).toBe('data.TaskId')
  })

  it('laiye：experimental + MCP JSON-RPC + bearer', () => {
    const adapter = byId.get('laiye')
    const descriptor = descriptorOf('laiye')
    expect(descriptor.status).toBe('experimental')
    expect(typeof adapter?.buildRequest).toBe('function')
    expect(typeof adapter?.parseResponse).toBe('function')
    expect(descriptor.auth.modes[0]?.strategy).toBe('bearer')
    expect(descriptor.request.url).toBe('${config.baseUrl}/automation/mcp')
    expect(descriptor.request.method).toBe('POST')
    expect(descriptor.capabilities.completion).toBe('poll')
    expect(descriptor.retry.maxAttempts).toBe(1)
    expect(descriptor.mapping.style).toBe('object')
    expect(descriptor.fields.some((field) => field.key === 'parameterMap' && field.type === 'map')).toBe(true)
  })

  it('shizai：experimental + 用户配置鉴权 header 名 + 单次尝试', () => {
    const adapter = byId.get('shizai')
    const descriptor = descriptorOf('shizai')
    expect(descriptor.status).toBe('experimental')
    expect(typeof adapter?.buildRequest).toBe('function')
    expect(typeof adapter?.signRequest).toBe('function')
    expect(typeof adapter?.parseResponse).toBe('function')
    expect(descriptor.auth.modes[0]?.strategy).toBe('custom')
    expect(descriptor.request.url).toBe('${config.baseUrl}/openAPI/v2/job/operation')
    const keyHeader = descriptor.fields.find((field) => field.key === 'keyHeader')
    const secretHeader = descriptor.fields.find((field) => field.key === 'secretHeader')
    expect(keyHeader?.defaultValue).toBe('')
    expect(secretHeader?.defaultValue).toBe('')
    expect(descriptor.retry.maxAttempts).toBe(1)
    // 官方未公开 header 名：必须写进 notes/risks 提醒联调。
    expect((descriptor.notes ?? []).join('\n')).toMatch(/header 名|header 字段名/)
  })
})

describe('阿里云 RPC 签名（官方 HTTP 调用说明口径）', () => {
  /** 测试里独立实现一遍 RFC3986 编码，避免「用被测函数验证被测函数」。 */
  function encodeRfc3986(text: string): string {
    return encodeURIComponent(text).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  }

  /** 独立实现的规范化查询串：key 字典序 + RFC3986 编码。 */
  function canonical(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((key) => encodeRfc3986(key) + '=' + encodeRfc3986(params[key] ?? ''))
      .join('&')
  }

  const params: Record<string, string> = {
    AccessKeyId: 'ak-test',
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: 'nonce-1',
    Timestamp: '2020-01-01T00:00:00Z',
    Version: '20200430',
    Format: 'json',
    AppId: '2e8e34bf-0000-0000-0000-e1d0add3d95e',
    AppParams: '[{"name":"room_name","value":"测试 群"}]',
    TaskPriority: '50',
  }

  it('percentEncode 按 RFC3986（空格 %20 / * 是 %2A / ~ 不编码）', () => {
    expect(percentEncode('a b')).toBe('a%20b')
    expect(percentEncode('a*b')).toBe('a%2Ab')
    expect(percentEncode("a!'()~")).toBe('a%21%27%28%29~')
  })

  it('canonicalizedQuery 与独立实现一致（排序 + 编码）', () => {
    expect(canonicalizedQuery(params)).toBe(canonical(params))
  })

  it('aliyunRpcSign 与独立 HMAC-SHA1 计算一致', () => {
    const stringToSign = 'POST&' + encodeRfc3986('/') + '&' + encodeRfc3986(canonical(params))
    const expected = createHmac('sha1', 'sk-test' + '&').update(stringToSign, 'utf8').digest('base64')
    expect(aliyunRpcSign(params, 'sk-test')).toBe(expected)
    // 不同 secret / 不同方法必须得到不同签名（防呆：签名没被写死）。
    expect(aliyunRpcSign(params, 'sk-other')).not.toBe(expected)
    expect(aliyunRpcSign(params, 'sk-test', 'GET')).not.toBe(expected)
    expect(aliyunRpcSign({}, 'sk-test')).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})
