import type {
  RpaVendorDescriptor,
  TaskInfo,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import type { TaskEditDraft } from './task-center.ts'

/** 造一个厂商描述符（只覆盖用到的字段，其余给稳定默认值）。 */
export function makeDescriptor(overrides: Partial<RpaVendorDescriptor> = {}): RpaVendorDescriptor {
  return {
    id: 'demo',
    name: '演示厂商',
    vendor: '演示厂商（demo.example）',
    version: '1.0.0',
    summary: '演示用厂商描述符',
    status: 'stable',
    docs: {
      home: 'https://example.com/demo',
      triggerApi: 'https://example.com/demo/trigger',
      lastVerifiedAt: '2026-10-21',
    },
    capabilities: {
      direction: 'outbound',
      synchronous: false,
      completion: 'callback',
      idempotency: 'vendor-key',
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
    request: { method: 'POST', url: '${config.baseUrl}' },
    response: { okHttpStatus: [200] },
    retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx'] },
    governance: { contentOutbound: true, hosts: [], privacySection: 'G3' },
    risks: ['演示风险'],
    ...overrides,
  }
}

/** 内置 Webhook 描述符（字段：url + extraParams + 高级 imageDelivery）。 */
export const WEBHOOK: RpaVendorDescriptor = makeDescriptor({
  id: 'webhook',
  name: 'Webhook',
  vendor: '内置',
  version: '1.2.0',
  summary: '把整条触发记录 POST 到你填写的地址；附加参数放进 params',
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
      paramSources: ['room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType', 'taskId', 'recordId', 'imagesJson', 'imageCount', 'firstImageUrl', 'fixed', 'template'],
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
  mapping: {
    style: 'object',
    targets: [],
    extrasField: 'extraParams',
  },
})

/** 八爪鱼描述符（v1.2.0）：flowId（summary）+ extraParams（paramList）+ apiKey（auth secret）。
 * 没有内置「三个参数」：mapping 无 mapField、targets 为空，所有参数都在附加参数里显式添加。 */
export const BAZHUAYU: RpaVendorDescriptor = makeDescriptor({
  id: 'bazhuayu',
  name: '八爪鱼 RPA',
  summary: '调用八爪鱼启动流程接口',
  fields: [
    {
      key: 'flowId',
      label: '八爪鱼 FlowId',
      type: 'text',
      required: true,
      summary: true,
      ariaLabel: '八爪鱼 FlowId',
      example: '例如 6ad859ccee2df270d53fc6e5',
      pattern: '^[A-Za-z0-9_-]{1,128}$',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: ['room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType', 'taskId', 'recordId', 'fixed', 'template'],
    },
  ],
  auth: {
    modes: [{
      strategy: 'header',
      fields: [
        { key: 'apiKey', label: '八爪鱼 API Key', type: 'password', required: true, secret: true, ariaLabel: '八爪鱼 API Key' },
      ],
    }],
  },
  mapping: {
    style: 'object',
    extrasField: 'extraParams',
    targets: [],
  },
})

/** 影刀描述符：baseUrl（advanced+默认值）/ robotUuid（必填+summary）/ 两个 secret / 附加参数。 */
export const YINGDAO: RpaVendorDescriptor = makeDescriptor({
  id: 'yingdao',
  name: '影刀 RPA',
  summary: '调用影刀应用运行接口',
  fields: [
    { key: 'baseUrl', label: '服务地址', type: 'text', required: true, defaultValue: 'https://api.yingdao.com', advanced: true },
    { key: 'robotUuid', label: '应用 UUID', type: 'text', required: true, summary: true, example: '73d9a119-…' },
    { key: 'accountName', label: '机器人账号', type: 'text', required: false },
    {
      key: 'priority',
      label: '排队优先级',
      type: 'select',
      required: false,
      options: [{ value: 'middle', label: '中' }, { value: 'high', label: '高' }],
      defaultValue: 'middle',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: ['room', 'content', 'at', 'fixed', 'template'],
    },
  ],
  auth: {
    modes: [{
      strategy: 'token-exchange',
      fields: [
        { key: 'accessKeyId', label: 'AccessKeyId', type: 'password', required: true, secret: true },
        { key: 'accessKeySecret', label: 'AccessKeySecret', type: 'password', required: true, secret: true },
      ],
    }],
  },
  mapping: {
    style: 'object',
    targets: [],
    extrasField: 'extraParams',
    legacyMapField: 'paramMap',
  },
})

/** 实验性厂商（用于状态徽标与 risks 文案）。 */
export const ALIYUN: RpaVendorDescriptor = makeDescriptor({
  id: 'aliyun-rpa',
  name: '阿里云 RPA',
  status: 'experimental',
  fields: [
    { key: 'appId', label: '应用 AppId', type: 'text', required: true },
    { key: 'robotId', label: '机器人 id', type: 'text', required: false },
  ],
  risks: ['官方示例 body/query 矛盾', '回调无签名', '签名位置待 POC 确认'],
})

/** 测试目录（顺序即选择器顺序）。 */
export const CATALOG: readonly RpaVendorDescriptor[] = [WEBHOOK, BAZHUAYU, YINGDAO, ALIYUN]

/** 造一条任务（只覆盖用到的字段，其余给稳定默认值）。 */
export function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: 1,
    name: '任务 A',
    chatUsername: 'wxid_chat',
    chatName: '会话名',
    chatType: 'group',
    targetUsername: 'wxid_target',
    targetName: '目标用户',
    keywords: ['报价'],
    photoLimit: 0,
    textLimit: 0,
    mentionMeOnly: false,
    greetingEnabled: false,
    greetingText: '',
    triggerMethod: 'webhook',
    triggerConfig: {},
    triggerSecretSet: {},
    triggerVendorVersion: '',
    callbackUrl: '',
    bazhuayuFlowId: '',
    bazhuayuApiKeySet: false,
    status: 'incomplete',
    createdAt: 1,
    updatedAt: 2,
    triggerCount: 0,
    ...overrides,
  }
}

/** 造一份编辑草稿（触发方式默认 webhook；测试只覆盖关心的字段）。 */
export function makeDraft(overrides: Partial<TaskEditDraft> = {}): TaskEditDraft {
  return {
    name: '任务',
    keywords: ['x'],
    photoLimit: 0,
    textLimit: 0,
    mentionMeOnly: false,
    greetingEnabled: false,
    greetingText: '',
    triggerMethod: 'webhook',
    config: {},
    secretInputs: {},
    ...overrides,
  }
}

/** 造一条触发记录。 */
export function makeRecord(overrides: Partial<TaskTriggerRecord> = {}): TaskTriggerRecord {
  return {
    id: 10,
    taskId: 1,
    taskName: '任务 A',
    chatUsername: 'wxid_chat',
    chatName: '会话名',
    targetUsername: 'wxid_target',
    targetName: '目标用户',
    keyword: '报价',
    text: '客户问报价',
    images: [],
    texts: [],
    messageLocalId: 100,
    messageSortSeq: 200,
    triggeredAt: new Date(2026, 9, 19, 10, 24, 0).getTime(),
    callbackStatus: 'pending',
    ...overrides,
  }
}
