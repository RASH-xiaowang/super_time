/**
 * 「任务信息」SSR 冒烟使用的厂商目录夹具。
 *
 * 与后端 `listRpaVendors` 的可序列化结果同形；前端只认描述符，不认识具体厂商。
 * 单独成文件，避免 `task-center-ssr.tsx` 越过 M21 的单文件行数上限。
 */
import type { RpaVendorCatalog, RpaVendorDescriptor } from '@deepseek-ai/dsh-wechat-data/types'

const WEBHOOK_VENDOR: RpaVendorDescriptor = {
  id: 'webhook',
  name: 'Webhook',
  vendor: '内置',
  version: '1.2.0',
  summary: '把整条触发记录 POST 到你填写的地址；附加参数放进 params',
  status: 'stable',
  docs: {
    home: 'https://example.com/docs/webhook',
    triggerApi: 'https://example.com/docs/webhook/trigger',
    lastVerifiedAt: '2026-10-21',
  },
  capabilities: { direction: 'outbound', synchronous: true, completion: 'none', idempotency: 'none', deployment: ['cloud', 'onprem'] },
  fields: [
    {
      key: 'url',
      label: 'Webhook 地址',
      type: 'text',
      required: true,
      ariaLabel: 'Webhook 地址',
      example: 'https://example.com/webhook',
      pattern: '^https?://',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: [
        'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
        'taskId', 'recordId', 'imagesJson', 'imageCount', 'firstImageUrl', 'fixed', 'template',
      ],
      help: '整条触发记录仍会发送；这里配置的条目会额外放进 params。',
    },
    {
      key: 'imageDelivery',
      label: '图片传输方式',
      type: 'select',
      required: false,
      advanced: true,
      defaultValue: 'dataUrl',
      options: [
        { value: 'dataUrl', label: 'JSON data URL' },
        { value: 'multipart', label: 'multipart/form-data' },
      ],
    },
  ],
  auth: { modes: [] },
  mapping: {
    style: 'object',
    targets: [],
    extrasField: 'extraParams',
  },
  request: { method: 'POST', url: '${config.url}' },
  response: { okHttpStatus: [200] },
  retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx'] },
  governance: { contentOutbound: true, hosts: [], allowCustomBaseUrl: true, privacySection: 'G3' },
  risks: ['Webhook 端点由你自行提供，请确保可接收 JSON'],
}

const BAZHUAYU_VENDOR: RpaVendorDescriptor = {
  id: 'bazhuayu',
  name: '八爪鱼 RPA',
  vendor: '八爪鱼 RPA（Bazhuayu）',
  version: '1.4.0',
  summary: '把任务「附加参数」逐条映射成八爪鱼流程入参（默认不发业务参数），POST 到八爪鱼固定主机启动流程；图片仅在显式选择图片类来源时传短时签名直链。',
  status: 'stable',
  docs: {
    home: 'https://www.bazhuayu.com/',
    triggerApi: 'https://www.bazhuayu.com/',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '内置通道（2026-10-21 回归核对；无公开接口页）',
  },
  capabilities: { direction: 'outbound', synchronous: true, completion: 'none', idempotency: 'none', deployment: ['cloud'] },
  fields: [
    {
      key: 'flowId',
      label: 'FlowId',
      type: 'text',
      required: true,
      summary: true,
      ariaLabel: '八爪鱼 FlowId',
      example: '6ad859ccee2df270d53fc6e5',
      help: '八爪鱼流程 id（控制台流程详情里复制）；不是凭据，随任务配置返回。',
    },
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      secret: true,
      ariaLabel: '八爪鱼 API Key',
      help: '只存本机；投递时由后端读出来放进 X-Api-Key 请求头，不进任务列表/Remote 返回值。',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      help: '八爪鱼流程的入参全部在这里配置（默认不发任何业务参数）；需要会话名/触发文本/触发对象时各加一条并选对应值来源。',
      paramSources: [
        'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
        'taskId', 'recordId', 'imagesJson', 'imageCount', 'firstImageUrl', 'fixed', 'template',
      ],
    },
  ],
  auth: { modes: [] },
  mapping: {
    style: 'object',
    targets: [],
    extrasField: 'extraParams',
    legacyMapField: 'paramMap',
  },
  request: { method: 'POST', url: 'https://api-rpa.bazhuayu.com/api/v1/bots/scheduling/start' },
  response: { okHttpStatus: [200] },
  retry: { maxAttempts: 1, retryOn: [] },
  governance: { contentOutbound: true, hosts: [{ kind: 'exact', value: 'api-rpa.bazhuayu.com' }], privacySection: 'G3' },
  risks: [
    '图片默认不发：只有附加参数显式选择 imagesJson / imageCount / firstImageUrl 时，才按所需传签名直链或数量；机器人取图要求本机已打开局域网访问',
  ],
}

/** SSR 注入的厂商目录（顺序即选择器顺序）。 */
export const VENDOR_CATALOG: RpaVendorCatalog = {
  items: [WEBHOOK_VENDOR, BAZHUAYU_VENDOR],
  registryVersion: '2026-11-26',
}
