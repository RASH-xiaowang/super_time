/**
 * 「任务信息」面板的纯逻辑单测（`task-center.ts`）。
 *
 * 这些是被容器、编辑表单、记录弹窗三处共用的口径，任何一条漂移都会表现成
 * 「同一件事在两个地方说法不同」：状态色、触发方式目录驱动的字段分组/默认值/校验/摘要、
 * 选中项失效后的回落、关键词去重、扫描结果文案。渲染层的接线由
 * `task-center.wiring.spec.ts` 管。
 *
 * 触发方式部分用本文件自造的**厂商描述符夹具**（与后端 `listRpaVendors` 的 JSON 同形），
 * 不 import 任何后端实现 —— 前端只认描述符，不认识具体厂商。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type {
  RpaVendorDescriptor,
  TaskInfo,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  addKeywords,
  appendTriggerPage,
  callbackHostname,
  callbackStatusMeta,
  callbackUrlLabel,
  capTriggerSearchInput,
  configMapValue,
  configTextValue,
  defaultVendorConfig,
  dispatchResultText,
  draftFromTask,
  exceedsBatchLimit,
  fieldAriaLabel,
  filterTasksBySearch,
  filterTriggersByTask,
  findVendorDescriptor,
  flattenTriggerConfig,
  groupVendorFields,
  hasDraftErrors,
  triggerTimeText,
  isHttpCallbackUrl,
  lastTriggeredLabel,
  needsTriggerPageBackfill,
  nextExpandedTaskId,
  nextSelectedTaskId,
  normalizeTriggerSearch,
  photoLimitLabel,
  plainText,
  readyMissingFields,
  readyRequirementHint,
  recordImageCountLabel,
  recordSummary,
  retainSelectedIds,
  removeKeyword,
  scanResultText,
  selectAllIds,
  selectionCountText,
  splitKeywordInput,
  taskCounts,
  taskSaveInput,
  taskScopeLabel,
  taskStatusMeta,
  taskTriggerSummary,
  triggerCountLabel,
  triggerPaneTitle,
  TRIGGER_SEARCH_MAX,
  TASK_BATCH_DELETE_MAX,
  toggleSelectedId,
  validateTaskDraft,
  validateVendorField,
  vendorFields,
  vendorMapTargets,
  visibleKeywords,
  withVendorDefaults,
  type TaskEditDraft,
} from './task-center.ts'
import { flattenConfigValues } from './task-center-param-list.ts'

/** 造一个厂商描述符（只覆盖用到的字段，其余给稳定默认值）。 */
function makeDescriptor(overrides: Partial<RpaVendorDescriptor> = {}): RpaVendorDescriptor {
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

/** 内置 Webhook 描述符（字段：url + 高级 paramMap）。 */
const WEBHOOK: RpaVendorDescriptor = makeDescriptor({
  id: 'webhook',
  name: 'Webhook',
  vendor: '内置',
  summary: '把整条触发记录 JSON POST 到你填写的地址（含图片）',
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
    { key: 'paramMap', label: '参数映射', type: 'map', required: false, advanced: true },
  ],
})

/** 八爪鱼描述符（v1.2.0）：flowId（summary）+ extraParams（paramList）+ apiKey（auth secret）。
 * 没有内置「三个参数」：mapping 无 mapField、targets 为空，所有参数都在附加参数里显式添加。 */
const BAZHUAYU: RpaVendorDescriptor = makeDescriptor({
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

/** 影刀描述符：baseUrl（advanced+默认值）/ robotUuid（必填+summary）/ 两个 secret / map。 */
const YINGDAO: RpaVendorDescriptor = makeDescriptor({
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
    { key: 'paramMap', label: '参数映射', type: 'map', required: false },
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
})

/** 实验性厂商（用于状态徽标与 risks 文案）。 */
const ALIYUN: RpaVendorDescriptor = makeDescriptor({
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
const CATALOG: readonly RpaVendorDescriptor[] = [WEBHOOK, BAZHUAYU, YINGDAO, ALIYUN]

/** 造一条任务（只覆盖用到的字段，其余给稳定默认值）。 */
function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
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
    mentionMeOnly: false,
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
function makeDraft(overrides: Partial<TaskEditDraft> = {}): TaskEditDraft {
  return {
    name: '任务',
    keywords: ['x'],
    photoLimit: 0,
    mentionMeOnly: false,
    triggerMethod: 'webhook',
    config: {},
    secretInputs: {},
    ...overrides,
  }
}

/** 造一条触发记录。 */
function makeRecord(overrides: Partial<TaskTriggerRecord> = {}): TaskTriggerRecord {
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
    messageLocalId: 100,
    messageSortSeq: 200,
    triggeredAt: new Date(2026, 9, 19, 10, 24, 0).getTime(),
    callbackStatus: 'pending',
    ...overrides,
  }
}

describe('状态文案与色调', () => {
  it('待完善 = amber、已完善 = green，且都有解释', () => {
    expect(taskStatusMeta('incomplete').label).toBe('待完善')
    expect(taskStatusMeta('incomplete').tone).toBe('amber')
    expect(taskStatusMeta('incomplete').hint).toContain('不参与触发')
    expect(taskStatusMeta('ready').label).toBe('已完善')
    expect(taskStatusMeta('ready').tone).toBe('green')
  })

  it('回调状态四种各有独立中文：待投递/已投递/投递失败/未配置', () => {
    expect(callbackStatusMeta('pending').label).toBe('待投递')
    expect(callbackStatusMeta('sent').label).toBe('已投递')
    expect(callbackStatusMeta('failed').label).toBe('投递失败')
    expect(callbackStatusMeta('failed').tone).toBe('red')
    expect(callbackStatusMeta('skipped').label).toBe('未配置')
    // 触发方式已泛化为多家厂商，提示文案不能再只说「Webhook 地址」。
    expect(callbackStatusMeta('skipped').hint).toContain('触发方式')
    expect(callbackStatusMeta('pending').hint).toContain('八爪鱼')
  })
})

describe('时间与计数文案', () => {
  it('触发时间复用 utils/format.ts 的 fmtDateTimeSec（毫秒→秒适配，非法值给「—」）', () => {
    expect(triggerTimeText(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04')
    expect(triggerTimeText(0)).toBe('—')
    expect(triggerTimeText(Number.NaN)).toBe('—')
  })

  it('最近触发：有值带时间，无值说「尚未触发」', () => {
    const ts = new Date(2026, 9, 19, 10, 24, 0).getTime()
    expect(lastTriggeredLabel(ts)).toBe('最近触发 2026-10-19 10:24')
    expect(lastTriggeredLabel(undefined)).toBe('尚未触发')
    expect(lastTriggeredLabel(0)).toBe('尚未触发')
  })

  it('次数 / 照片张数 / 记录图片数三处文案口径', () => {
    expect(triggerCountLabel(3)).toBe('3 次触发')
    expect(triggerCountLabel(-1)).toBe('0 次触发')
    expect(photoLimitLabel(0)).toBe('不带图片')
    expect(photoLimitLabel(6)).toBe('6 张图片')
    expect(recordImageCountLabel(0)).toBe('无图片')
    expect(recordImageCountLabel(2)).toBe('图片 2 张')
  })
})

describe('文本摘要与关键词折叠', () => {
  it('多行/连续空白收成一行', () => {
    expect(plainText('  第一行\n\n第二行\t第三行  ')).toBe('第一行 第二行 第三行')
  })

  it('摘要单行截断并补省略号；空文本给「（无文本）」', () => {
    expect(recordSummary('短文本')).toBe('短文本')
    const long = 'a'.repeat(120)
    expect(recordSummary(long, 10)).toBe(`${'a'.repeat(10)}…`)
    expect(recordSummary('   ')).toBe('（无文本）')
  })

  it('关键词最多显示 3 个，其余折成隐藏数', () => {
    expect(visibleKeywords(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b', 'c'], hidden: 1 })
    expect(visibleKeywords(['a'])).toEqual({ shown: ['a'], hidden: 0 })
    expect(visibleKeywords([], 3)).toEqual({ shown: [], hidden: 0 })
  })
})

describe('Webhook 地址辅助（旧展示口径仍是任务行 Webhook 摘要的来源）', () => {
  it('只认 http/https，且必须能解析出主机名', () => {
    expect(isHttpCallbackUrl('http://example.com/hook')).toBe(true)
    expect(isHttpCallbackUrl(' https://example.com:8443/hook ')).toBe(true)
    expect(isHttpCallbackUrl('ftp://example.com')).toBe(false)
    expect(isHttpCallbackUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpCallbackUrl('example.com')).toBe(false)
    expect(isHttpCallbackUrl('')).toBe(false)
  })

  it('主机名展示（含端口）；空/非法回落「未填 Webhook」', () => {
    expect(callbackHostname('https://example.com:8443/a/b')).toBe('example.com:8443')
    expect(callbackHostname('')).toBe('')
    expect(callbackUrlLabel('https://example.com/x')).toBe('example.com')
    expect(callbackUrlLabel('')).toBe('未填 Webhook')
  })
})

describe('右栏过滤与选中一致性', () => {
  const records = [makeRecord({ id: 1, taskId: 1 }), makeRecord({ id: 2, taskId: 2 }), makeRecord({ id: 3, taskId: 1 })]

  it('未选中 = 全部记录；选中 = 只留该任务', () => {
    expect(filterTriggersByTask(records, null)).toHaveLength(3)
    expect(filterTriggersByTask(records, 1).map((r) => r.id)).toEqual([1, 3])
    expect(filterTriggersByTask(records, 9)).toEqual([])
  })

  it('选中项只在任务仍存在时有效（任务被删则回 null）', () => {
    const tasks = [makeTask({ id: 1 }), makeTask({ id: 2 })]
    expect(nextSelectedTaskId(tasks, 2)).toBe(2)
    expect(nextSelectedTaskId(tasks, 9)).toBeNull()
    expect(nextSelectedTaskId(tasks, null)).toBeNull()
    expect(nextSelectedTaskId([], 1)).toBeNull()
  })

  it('编辑项同口径（删除后关闭抽屉）', () => {
    const tasks = [makeTask({ id: 1 })]
    expect(nextExpandedTaskId(tasks, 1)).toBe(1)
    expect(nextExpandedTaskId(tasks, 2)).toBeNull()
    expect(nextExpandedTaskId([], 1)).toBeNull()
  })
})

describe('左栏任务搜索', () => {
  const searchableTasks: readonly TaskInfo[] = [
    makeTask({ id: 1, name: '客户报价跟进', keywords: ['报价', 'Quote'], chatName: '报价群', targetName: '客户经理' }),
    makeTask({ id: 2, name: '上线通知', keywords: ['Deploy'], chatName: '发布群', targetName: '运维值班' }),
  ]

  it('任务名 / 关键词 / 会话 / 对象均可搜，大小写不敏感', () => {
    expect(filterTasksBySearch(searchableTasks, '报价').map((t) => t.id)).toEqual([1])
    expect(filterTasksBySearch(searchableTasks, 'QUOTE').map((t) => t.id)).toEqual([1])
    expect(filterTasksBySearch(searchableTasks, '发布群').map((t) => t.id)).toEqual([2])
    expect(filterTasksBySearch(searchableTasks, '运维').map((t) => t.id)).toEqual([2])
  })

  it('触发方式 id 与配置里的字符串值都可搜（后端也 flatten config 值）', () => {
    const tasks = [
      makeTask({ id: 3, triggerMethod: 'bazhuayu', triggerConfig: { flowId: '6ad859ccee2df270d53fc6e5' } }),
      makeTask({ id: 4, triggerMethod: 'yingdao', triggerConfig: { robotUuid: '73d9a119-7ec7-4226-b679-506afefae667' } }),
    ]
    expect(filterTasksBySearch(tasks, '6AD859').map((t) => t.id)).toEqual([3])
    expect(filterTasksBySearch(tasks, 'yingdao').map((t) => t.id)).toEqual([4])
    expect(filterTasksBySearch(tasks, '73d9a119').map((t) => t.id)).toEqual([4])
  })

  it('空搜索保持原数组身份；无命中返回空数组', () => {
    expect(filterTasksBySearch(searchableTasks, '   ')).toBe(searchableTasks)
    expect(filterTasksBySearch(searchableTasks, '不存在的任务')).toEqual([])
  })
})

describe('触发方式目录：描述符查询与字段分组', () => {
  it('按 id 找描述符；未知/已下线厂商返回 null', () => {
    expect(findVendorDescriptor(CATALOG, 'webhook')?.name).toBe('Webhook')
    expect(findVendorDescriptor(CATALOG, 'bazhuayu')?.name).toBe('八爪鱼 RPA')
    expect(findVendorDescriptor(CATALOG, 'gone-vendor')).toBeNull()
    expect(findVendorDescriptor([], 'webhook')).toBeNull()
  })

  it('字段并集：descriptor.fields + auth.modes[].fields 去重，凭据字段统一 secret=true', () => {
    const bazhuayuFields = vendorFields(BAZHUAYU)
    expect(bazhuayuFields.map((f) => f.key)).toEqual(['flowId', 'extraParams', 'apiKey'])
    expect(bazhuayuFields.find((f) => f.key === 'apiKey')?.secret).toBe(true)
    const yingdaoFields = vendorFields(YINGDAO).map((f) => f.key)
    expect(yingdaoFields).toEqual(['baseUrl', 'robotUuid', 'accountName', 'priority', 'paramMap', 'accessKeyId', 'accessKeySecret'])
    // 同一个凭据字段同时出现在 fields 与 auth.fields 时不应重复。
    const duplicated = makeDescriptor({
      fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }],
      auth: { modes: [{ strategy: 'bearer', fields: [{ key: 'token', label: 'Token', type: 'password', required: true, secret: true }] }] },
    })
    expect(vendorFields(duplicated).filter((f) => f.key === 'token')).toHaveLength(1)
  })

  it('分组：凭据 → 账号与鉴权；普通 → 流程与参数；advanced → 高级', () => {
    const groups = groupVendorFields(vendorFields(YINGDAO))
    expect(groups.auth.map((f) => f.key)).toEqual(['accessKeyId', 'accessKeySecret'])
    expect(groups.config.map((f) => f.key)).toContain('robotUuid')
    expect(groups.advanced.map((f) => f.key)).toEqual(['baseUrl'])
    const webhookGroups = groupVendorFields(vendorFields(WEBHOOK))
    expect(webhookGroups.auth).toEqual([])
    expect(webhookGroups.advanced.map((f) => f.key)).toEqual(['paramMap'])
  })

  it('字段可访问名：ariaLabel 优先，缺省 label（与后端 fieldAriaLabel 同口径）', () => {
    expect(fieldAriaLabel(WEBHOOK.fields[0]!)).toBe('Webhook 地址')
    expect(fieldAriaLabel(BAZHUAYU.fields[0]!)).toBe('八爪鱼 FlowId')
    expect(fieldAriaLabel({ key: 'x', label: 'X 字段', type: 'text', required: false })).toBe('X 字段')
  })

  it('参数映射三个语义位：默认中文标签 + targets.defaultKey', () => {
    expect(vendorMapTargets(YINGDAO)).toEqual([
      { semantic: 'room', label: '会话名', defaultKey: 'room_name' },
      { semantic: 'content', label: '触发文本', defaultKey: 'content' },
      { semantic: 'at', label: '触发对象', defaultKey: 'at_name' },
    ])
    const labeled = makeDescriptor({
      mapping: {
        style: 'object',
        mapField: 'paramMap',
        targets: [{ semantic: 'room', label: '群名', defaultKey: 'roomName' }],
      },
    })
    expect(vendorMapTargets(labeled)[0]?.label).toBe('群名')
  })
})

describe('触发方式目录：默认值、草稿与摘要', () => {
  it('默认配置：字段 defaultValue 预填；map 字段按 targets.defaultKey/字段 defaultValue 生成三键', () => {
    expect(defaultVendorConfig(YINGDAO)).toEqual({
      baseUrl: 'https://api.yingdao.com',
      priority: 'middle',
      paramMap: { room: 'room_name', content: 'content', at: 'at_name' },
    })
    const custom = makeDescriptor({
      fields: [{
        key: 'paramMap',
        label: '参数映射',
        type: 'map',
        required: false,
        defaultValue: { room: 'roomName', content: 'content' },
      }],
    })
    expect(defaultVendorConfig(custom).paramMap).toEqual({ room: 'roomName', content: 'content', at: 'at_name' })
  })

  it('withVendorDefaults：缺键补默认、已有值优先、map 按键合并', () => {
    const merged = withVendorDefaults(YINGDAO, {
      robotUuid: '73d9a119-7ec7',
      paramMap: { room: 'my_room' },
    })
    expect(merged.robotUuid).toBe('73d9a119-7ec7')
    expect(merged.baseUrl).toBe('https://api.yingdao.com')
    expect(merged.paramMap).toEqual({ room: 'my_room', content: 'content', at: 'at_name' })
  })

  it('draftFromTask：配置按目录补默认值、凭据输入恒为空；未知厂商原样保留配置', () => {
    const yingdaoTask = makeTask({
      triggerMethod: 'yingdao',
      triggerConfig: { robotUuid: '73d9a119-7ec7' },
      triggerSecretSet: { accessKeyId: true, accessKeySecret: true },
      triggerVendorVersion: '1.0.0',
    })
    const draft = draftFromTask(yingdaoTask, findVendorDescriptor(CATALOG, 'yingdao'))
    expect(draft.triggerMethod).toBe('yingdao')
    expect(draft.config.robotUuid).toBe('73d9a119-7ec7')
    expect(draft.config.baseUrl).toBe('https://api.yingdao.com')
    expect(draft.secretInputs).toEqual({})

    const unknown = draftFromTask(makeTask({ triggerMethod: 'gone-vendor', triggerConfig: { x: 'y' } }), null)
    expect(unknown.triggerMethod).toBe('gone-vendor')
    expect(unknown.config).toEqual({ x: 'y' })
  })

  it('任务行摘要：Webhook 主机名 / 厂商名称 + summary 字段 / 未知厂商', () => {
    expect(taskTriggerSummary(makeTask({ triggerConfig: { url: 'https://example.com:8443/h' } }), WEBHOOK)).toBe('Webhook example.com:8443')
    expect(taskTriggerSummary(makeTask({ triggerConfig: {} }), WEBHOOK)).toBe('未填 Webhook')
    // 目录未加载时内置 Webhook 仍保持旧文案（不误判成「厂商已下线」）。
    expect(taskTriggerSummary(makeTask({ triggerConfig: { url: 'https://example.com/h' } }), null)).toBe('Webhook example.com')

    const bazhuayuTask = makeTask({ triggerMethod: 'bazhuayu', triggerConfig: { flowId: '6ad859ccee2df270d53fc6e5' } })
    expect(taskTriggerSummary(bazhuayuTask, BAZHUAYU)).toBe('八爪鱼 RPA · 6ad859ccee2df270d53fc6e5')
    const yingdaoTask = makeTask({ triggerMethod: 'yingdao', triggerConfig: { robotUuid: '73d9a119-7ec7' } })
    expect(taskTriggerSummary(yingdaoTask, YINGDAO)).toBe('影刀 RPA · 73d9a119-7ec7')
    // 没有 summary 字段的厂商只显示名称（阿里云 fixture 两个字段都不是 summary）。
    expect(taskTriggerSummary(makeTask({ triggerMethod: 'aliyun-rpa' }), ALIYUN)).toBe('阿里云 RPA')
    expect(taskTriggerSummary(makeTask({ triggerMethod: 'gone-vendor' }), null)).toBe('触发方式不可用（厂商已下线）')
  })

  it('「标记已完善」前置提示按描述符 required 字段生成', () => {
    expect(readyRequirementHint(WEBHOOK)).toBe('标记已完善前需填写：Webhook 地址')
    expect(readyRequirementHint(YINGDAO)).toBe('标记已完善前需填写：服务地址、应用 UUID、AccessKeyId、AccessKeySecret')
    expect(readyRequirementHint(ALIYUN)).toBe('标记已完善前需填写：应用 AppId')
    expect(readyRequirementHint(null)).toBe('请先选择可用的触发方式')
  })
})

describe('触发方式目录：字段校验与「标记已完善」缺项', () => {
  it('validateVendorField：pattern 只约束非空值；select 必须在 options；number 必须是数字', () => {
    const urlField = WEBHOOK.fields[0]!
    expect(validateVendorField(urlField, '')).toBeUndefined()
    expect(validateVendorField(urlField, 'https://example.com/h')).toBeUndefined()
    expect(validateVendorField(urlField, 'ftp://example.com')).toContain('格式不正确')
    const flowField = BAZHUAYU.fields[0]!
    expect(validateVendorField(flowField, 'bad flow')).toContain('格式不正确')
    expect(validateVendorField(flowField, 'flow_1-2')).toBeUndefined()

    const selectField = YINGDAO.fields.find((f) => f.key === 'priority')!
    expect(validateVendorField(selectField, 'high')).toBeUndefined()
    expect(validateVendorField(selectField, 'urgent')).toContain('可选范围')

    const numberField = makeDescriptor().fields[0] ?? { key: 'n', label: '数量', type: 'number' as const, required: false }
    expect(validateVendorField({ ...numberField, type: 'number' }, '12')).toBeUndefined()
    expect(validateVendorField({ ...numberField, type: 'number' }, 'abc')).toContain('数字')
  })

  it('保存校验：任务名/关键词/照片 + 未知厂商拦保存 + 字段行内错误', () => {
    const base = makeDraft({ name: '  ', keywords: [] })
    expect(validateTaskDraft(base, WEBHOOK)).toEqual({ name: '任务名不能为空', keywords: '至少填写 1 个触发关键词' })
    expect(validateTaskDraft(makeDraft(), WEBHOOK)).toEqual({})
    // required 不拦保存（待完善任务可以先不填）。
    expect(validateTaskDraft(makeDraft({ triggerMethod: 'bazhuayu' }), BAZHUAYU)).toEqual({})
    const bad = validateTaskDraft(makeDraft({ config: { url: 'ftp://example.com' } }), WEBHOOK)
    expect(bad.fields?.url).toContain('格式不正确')
    expect(hasDraftErrors(bad)).toBe(true)
    // 未知厂商：保存被拒。
    const unknown = validateTaskDraft(makeDraft({ triggerMethod: 'gone-vendor' }), null)
    expect(unknown.triggerMethod).toContain('触发方式不可用')
    expect(hasDraftErrors(unknown)).toBe(true)
    expect(validateTaskDraft(makeDraft({ photoLimit: 3 }), WEBHOOK)).toEqual({})
    expect(hasDraftErrors({})).toBe(false)
  })

  it('readyMissingFields：required 逐个检查；凭据看「已保存」或「本次输入」', () => {
    const bazhuayuTask = makeTask({ triggerMethod: 'bazhuayu', triggerSecretSet: {} })
    const emptyDraft = makeDraft({ triggerMethod: 'bazhuayu' })
    expect(readyMissingFields(bazhuayuTask, emptyDraft, BAZHUAYU).map((f) => f.key)).toEqual(['flowId', 'apiKey'])

    const filledDraft = makeDraft({
      triggerMethod: 'bazhuayu',
      config: { flowId: '6ad859ccee2df270d53fc6e5' },
      secretInputs: { apiKey: 'key-123' },
    })
    expect(readyMissingFields(bazhuayuTask, filledDraft, BAZHUAYU)).toEqual([])

    const savedKeyTask = makeTask({ triggerMethod: 'bazhuayu', triggerSecretSet: { apiKey: true } })
    const flowOnly = makeDraft({ triggerMethod: 'bazhuayu', config: { flowId: 'flow_1' } })
    expect(readyMissingFields(savedKeyTask, flowOnly, BAZHUAYU)).toEqual([])

    // webhook 缺地址。
    expect(readyMissingFields(makeTask(), makeDraft(), WEBHOOK).map((f) => f.key)).toEqual(['url'])
    // 必填 map：三个语义位都要有值（缺省 map 会由默认值补齐，这里显式清空一个）。
    const requiredMap = makeDescriptor({
      fields: [{ key: 'paramMap', label: '参数映射', type: 'map', required: true }],
    })
    const mapDraft = makeDraft({ triggerMethod: 'demo', config: { paramMap: { room: 'room_name', content: '', at: 'at_name' } } })
    expect(readyMissingFields(makeTask({ triggerMethod: 'demo' }), mapDraft, requiredMap).map((f) => f.key)).toEqual(['paramMap'])
    expect(readyMissingFields(makeTask(), makeDraft(), null)).toEqual([])
  })
})

describe('触发方式目录：保存入参', () => {
  it('triggerMethod 总带；triggerConfig 全量归一（map 三键/数字/布尔/空文本不写）；凭据只带非空输入', () => {
    const task = makeTask({ id: 9, chatType: 'group', triggerMethod: 'webhook' })
    const yingdaoDraft = makeDraft({
      triggerMethod: 'yingdao',
      config: {
        baseUrl: ' https://custom.yingdao.com ',
        robotUuid: ' 73d9a119-7ec7 ',
        priority: 'high',
        paramMap: { room: ' my_room ', content: 'content', at: 'at_name' },
      },
      secretInputs: { accessKeyId: ' ak-1 ', accessKeySecret: '   ' },
    })
    const input = taskSaveInput(task, yingdaoDraft, YINGDAO)
    expect(input.id).toBe(9)
    expect(input.triggerMethod).toBe('yingdao')
    expect(input.triggerConfig).toEqual({
      baseUrl: 'https://custom.yingdao.com',
      robotUuid: '73d9a119-7ec7',
      priority: 'high',
      paramMap: { room: 'my_room', content: 'content', at: 'at_name' },
    })
    // 空白凭据输入 = 没改，必须缺省（缺省 = 后端保留旧值）。
    expect(input.triggerSecret).toEqual({ accessKeyId: 'ak-1' })

    const noSecret = taskSaveInput(task, makeDraft({ triggerMethod: 'yingdao', config: { robotUuid: 'r' } }), YINGDAO)
    expect(noSecret.triggerSecret).toBeUndefined()

    // webhook：url trim 后带上；map 字段按 targets.defaultKey 补全三键。
    const webhookInput = taskSaveInput(makeTask(), makeDraft({ config: { url: ' https://example.com/h ' } }), WEBHOOK)
    expect(webhookInput.triggerConfig).toEqual({
      url: 'https://example.com/h',
      paramMap: { room: 'room_name', content: 'content', at: 'at_name' },
    })
    expect(webhookInput.triggerMethod).toBe('webhook')
    expect(webhookInput.triggerSecret).toBeUndefined()
  })

  it('未知厂商：只带原始 config（UI 会禁止保存，这里兜底不丢数据）', () => {
    const input = taskSaveInput(makeTask(), makeDraft({ triggerMethod: 'gone-vendor', config: { x: 'y' } }), null)
    expect(input.triggerMethod).toBe('gone-vendor')
    expect(input.triggerConfig).toEqual({ x: 'y' })
    expect(input.triggerSecret).toBeUndefined()
  })
})

describe('附加参数（paramList）：值来源 / 默认 / 归一化 / 校验 / 保存', () => {
  const extrasField = BAZHUAYU.fields.find((field) => field.key === 'extraParams')!

  it('validateTaskDraft 合并行内错误：非法格式保存时就拦，合法/空列表放行', () => {
    const bad = makeDraft({
      triggerMethod: 'bazhuayu',
      config: { flowId: 'f1', extraParams: [{ name: '', source: 'fixed' }] },
    })
    const errors = validateTaskDraft(bad, BAZHUAYU)
    expect(errors.fields?.['extraParams:0']).toContain('缺少参数名')
    expect(hasDraftErrors(errors)).toBe(true)
    const good = makeDraft({
      triggerMethod: 'bazhuayu',
      config: { flowId: 'f1', extraParams: [{ name: 'order_no', source: 'fixed', fixedValue: 'A-001' }] },
    })
    expect(validateTaskDraft(good, BAZHUAYU)).toEqual({})
    expect(validateTaskDraft(makeDraft({ triggerMethod: 'bazhuayu' }), BAZHUAYU)).toEqual({})
  })

  it('「标记已完善」required 的 paramList 空数组算缺失', () => {
    const requiredExtras = makeDescriptor({
      id: 'demo',
      fields: [{ key: 'extraParams', label: '附加参数', type: 'paramList', required: true }],
    })
    const missing = readyMissingFields(
      makeTask({ triggerMethod: 'demo' }),
      makeDraft({ triggerMethod: 'demo', config: { extraParams: [] } }),
      requiredExtras,
    )
    expect(missing.map((field) => field.key)).toEqual(['extraParams'])
    const filled = readyMissingFields(
      makeTask({ triggerMethod: 'demo' }),
      makeDraft({ triggerMethod: 'demo', config: { extraParams: [{ name: 'x', source: 'room' }] } }),
      requiredExtras,
    )
    expect(filled).toEqual([])
  })

  it('任务搜索包含附加参数名/固定值/模板（flatten 与后端同口径）', () => {
    const task = makeTask({
      id: 8,
      name: '八爪鱼参数',
      triggerMethod: 'bazhuayu',
      triggerConfig: {
        extraParams: [
          { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
          { name: 'kw', source: 'template', template: '${record.keyword}' },
        ],
      },
    })
    expect(filterTasksBySearch([task], 'order_no')).toHaveLength(1)
    expect(filterTasksBySearch([task], 'a-001')).toHaveLength(1)
    expect(filterTasksBySearch([task], 'record.keyword')).toHaveLength(1)
    expect(flattenConfigValues({ extraParams: [{ name: 'x', source: 'fixed', fixedValue: 'v' }] })).toEqual(['x', 'v'])
    expect(flattenTriggerConfig({ extraParams: [{ name: 'x', source: 'room' }] })).toEqual(['x'])
  })


})

describe('配置值辅助', () => {
  it('configTextValue / configMapValue / flattenTriggerConfig', () => {
    const config = {
      url: ' https://example.com/h ',
      robotUuid: 'abc',
      jobsCount: 2,
      enabled: true,
      paramMap: { room: 'room_name', content: 'content', at: 'at_name' },
    }
    expect(configTextValue(config, 'url')).toBe(' https://example.com/h ')
    expect(configTextValue(config, 'jobsCount')).toBe('2')
    expect(configTextValue(config, 'missing')).toBe('')
    expect(configMapValue(config, 'paramMap')).toEqual({ room: 'room_name', content: 'content', at: 'at_name' })
    expect(configMapValue(config, 'url')).toEqual({})
    expect(flattenTriggerConfig(config)).toEqual(expect.arrayContaining([
      ' https://example.com/h ',
      'abc',
      '2',
      'true',
      'room_name',
      'content',
      'at_name',
    ]))
  })
})

describe('批量选择与删除上限', () => {
  it('单个切换返回新 Set，不修改原选择；再次切换取消', () => {
    const original = new Set([1, 2])
    const added = toggleSelectedId(original, 3)
    expect([...added]).toEqual([1, 2, 3])
    expect([...original]).toEqual([1, 2])
    expect([...toggleSelectedId(added, 2)]).toEqual([1, 3])
  })

  it('全选只覆盖当前可见 id；刷新后清掉不存在的选择', () => {
    expect([...selectAllIds([4, 2])]).toEqual([4, 2])
    const selected = new Set([1, 2, 3])
    expect([...retainSelectedIds(selected, [2, 3, 4])]).toEqual([2, 3])
    const unchanged = new Set([1])
    expect(retainSelectedIds(unchanged, [1]), '未变化时保留原引用').toBe(unchanged)
    expect(retainSelectedIds(new Set(), [1])).toEqual(new Set())
  })

  it('计数文案与 500 条上限同源；超过上限必须整单拒绝', () => {
    expect(selectionCountText(3)).toBe('已选 3 条')
    expect(selectionCountText(-1)).toBe('已选 0 条')
    expect(TASK_BATCH_DELETE_MAX).toBe(500)
    expect(exceedsBatchLimit(TASK_BATCH_DELETE_MAX)).toBe(false)
    expect(exceedsBatchLimit(TASK_BATCH_DELETE_MAX + 1)).toBe(true)
  })
})

describe('编辑草稿：基础字段', () => {
  it('草稿从任务快照复制关键词（改草稿不会污染任务）', () => {
    const task = makeTask({ keywords: ['报价', '合同'] })
    const draft = draftFromTask(task, WEBHOOK)
    draft.keywords.push('交付')
    expect(task.keywords).toEqual(['报价', '合同'])
  })

  it('关键词拆分：逗号（半/全角）、分号、顿号、换行都能分隔，空串丢掉', () => {
    expect(splitKeywordInput('报价,合同，打款;交付；上线、测试\n验收')).toEqual(['报价', '合同', '打款', '交付', '上线', '测试', '验收'])
    expect(splitKeywordInput('  ,,，  ')).toEqual([])
  })

  it('追加关键词去重（大小写不敏感、保留首次写法）；删除同样大小写不敏感', () => {
    const list = addKeywords(['报价'], '合同, 报价, Quote')
    expect(list).toEqual(['报价', '合同', 'Quote'])
    expect(addKeywords(list, 'quote')).toEqual(['报价', '合同', 'Quote'])
    expect(removeKeyword(list, 'QUOTE')).toEqual(['报价', '合同'])
  })

  it('照片数量校验：0–9 的整数，越界/小数被拦下（输入框之外的兜底）', () => {
    const base = makeDraft({ photoLimit: 3 })
    expect(validateTaskDraft(base, WEBHOOK)).toEqual({})
    expect(validateTaskDraft({ ...base, photoLimit: 0 }, WEBHOOK)).toEqual({})
    expect(validateTaskDraft({ ...base, photoLimit: 9 }, WEBHOOK)).toEqual({})
    expect(validateTaskDraft({ ...base, photoLimit: 10 }, WEBHOOK).photoLimit).toContain('0–9')
    expect(validateTaskDraft({ ...base, photoLimit: -1 }, WEBHOOK).photoLimit).toContain('0–9')
    expect(validateTaskDraft({ ...base, photoLimit: 1.5 }, WEBHOOK).photoLimit).toContain('整数')
  })

  it('保存入参带 id 与会话/目标字段，关键词/姓名 trim，照片数夹回 0–9', () => {
    const task = makeTask({ id: 7, chatUsername: 'wxid_chat', chatName: '群名', targetUsername: 'wxid_t', targetName: '对象' })
    const input = taskSaveInput(task, makeDraft({
      name: '  新名  ',
      keywords: [' 报价 '],
      photoLimit: 5,
      mentionMeOnly: true,
      config: { url: ' https://x.test/h ' },
    }), WEBHOOK)
    expect(input.id).toBe(7)
    expect(input.name).toBe('新名')
    expect(input.keywords).toEqual(['报价'])
    expect(input.photoLimit, '2/5 这类原来没有档位的数现在应当原样保留').toBe(5)
    expect(input.mentionMeOnly, '群聊编辑保存必须携带勾选状态').toBe(true)
    expect(input.triggerConfig?.url).toBe('https://x.test/h')
    expect(input.chatUsername).toBe('wxid_chat')
    expect(input.chatName).toBe('群名')
    expect(input.targetUsername).toBe('wxid_t')
    expect(input.targetName).toBe('对象')
    expect(taskSaveInput(task, makeDraft({ photoLimit: 100 }), WEBHOOK).photoLimit).toBe(9)
    expect(taskSaveInput(task, makeDraft({ photoLimit: -3 }), WEBHOOK).photoLimit).toBe(0)
    expect(taskSaveInput(task, makeDraft({ photoLimit: 1.7 }), WEBHOOK).photoLimit).toBe(1)
  })

  it('草稿保留「仅匹配 @我」；单聊保存时强制归一为 false', () => {
    const groupTask = makeTask({ chatType: 'group', mentionMeOnly: true })
    const groupDraft = draftFromTask(groupTask, WEBHOOK)
    expect(groupDraft.mentionMeOnly).toBe(true)
    expect(taskSaveInput(groupTask, groupDraft, WEBHOOK).mentionMeOnly).toBe(true)

    const privateTask = makeTask({ chatType: 'private', targetUsername: 'wxid_chat', targetName: '会话名' })
    expect(taskSaveInput(privateTask, { ...draftFromTask(privateTask, WEBHOOK), mentionMeOnly: true }, WEBHOOK).mentionMeOnly).toBe(false)
  })
})

describe('操作结果文案', () => {
  it('扫描成功：检查数 / 新增数 / 投递数一句话说清', () => {
    expect(scanResultText({ ok: true, tasks: 2, scanned: 12, created: 3, dispatched: 1 }))
      .toBe('扫描完成：检查 12 条新消息，新增 3 条触发记录，投递 1 条回调')
    expect(scanResultText({ ok: true, tasks: 2, scanned: 12, created: 0, dispatched: 0, errors: ['任务 A 失败'] }))
      .toContain('（1 个任务失败）')
    expect(scanResultText({ ok: false, tasks: 0, scanned: 0, created: 0, dispatched: 0, error: '未配置回调' }))
      .toBe('扫描失败：未配置回调')
  })

  it('重投结果：成功/失败/非 sent 状态都有文案', () => {
    expect(dispatchResultText({ ok: true, status: 'sent' })).toBe('已重新投递')
    expect(dispatchResultText({ ok: true, status: 'skipped' })).toBe('投递结果：未配置')
    expect(dispatchResultText({ ok: false, status: 'failed', error: 'HTTP 500' })).toBe('重新投递失败：HTTP 500')
  })
})

describe('标题与作用域文案', () => {
  it('未选中 = 「任务触发记录」；选中带任务名', () => {
    expect(triggerPaneTitle(null)).toBe('任务触发记录')
    expect(triggerPaneTitle(makeTask({ name: '客户报价' }))).toBe('任务触发记录 · 客户报价')
  })

  it('会话 → 目标；单聊同名时不重复', () => {
    expect(taskScopeLabel(makeTask({ chatName: '群名', targetName: '对象' }))).toBe('群名 → 对象')
    expect(taskScopeLabel(makeTask({ chatType: 'private', chatName: '张三', targetName: '张三' }))).toBe('张三')
  })
})
