/**
 * 「任务信息」双栏面板的离屏冒烟（SSR，无浏览器，2026-10-19）。
 *
 * 为什么需要它：仓库没有组件级 DOM 测试环境（见 `docs/CONTRIBUTING.md` §7 与 M13/M15
 * 的既定结论），而这一页有几件**只有真渲染一次才看得到**的事实：
 *   · 双栏标题、状态徽标、关键词折叠（超 3 个折「+N」）是否真的画出来；
 *   · 弹窗分组是否含「触发时间 / 触发群聊 / 触发对象 / 触发图片 / 触发文本」五组；
 *   · 任务行是否给出「编辑」入口（点击打开右侧抽屉）与触发方式摘要；
 *   · 抽屉 body 的表单是否含「触发方式」（Webhook / 八爪鱼 RPA）、Webhook 地址 /
 *     FlowId / API Key 字段与「标记已完善」等入口；
 *   · 右栏是否真的按选中任务过滤（未选中任务的那条记录不该出现）。
 *
 * 做法与 `scripts/wordcloud-ssr.tsx` 同一范式：直接渲染**纯展示组件**
 * `TaskCenterView`（取数/副作用在 `TaskCenterPanel`，SSR 不会跑 effect），
 * 数据用 fixture 喂；断言只看静态 HTML，不碰后端、不联网。
 *
 * ⚠️ 编辑抽屉的 body 单独渲染 `TaskEditForm`：抽屉走 kit 的 `Drawer`（Radix Dialog + Portal），
 * 而 `@radix-ui/react-portal` 的 `mounted` 来自 layout effect —— `renderToStaticMarkup` 不执行
 * effect，Portal 在 SSR 下渲染 null。真实浏览器的 `role="dialog"` / Esc / 遮罩语义由
 * `scripts/task-center-e2e.mjs` 覆盖；这里用同一份表单组件验证抽屉内容（非 portal）。
 *
 * 运行：`node scripts/ui-ask-smoke.js scripts/task-center-ssr.tsx`
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  RpaVendorCatalog,
  RpaVendorDescriptor,
  TaskCallbackDispatchResult,
  TaskInfo,
  TaskInfoInput,
  TaskInfoMutationResult,
  TaskInfoStatus,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import { TaskCenterView, type TaskCenterActions } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/TaskCenter.tsx'
import { TaskEditForm } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center-edit-form.tsx'
import { triggerTimeText } from '../src/client/ui-wechat/src/client/pages/wechat-data/panels/task-center.ts'
import { setCapabilities } from '../src/client/ui-wechat/src/client/pages/wechat-data/api.ts'

// SSR 模拟桌面端：凭据「眼睛」等桌面专属控件要按 isDesktop 渲染（与真机一致）。
setCapabilities({ isDesktop: true, isBrowser: false, desktopEquivalent: false, dirPicker: false, capturePanel: false, shellOpen: false, license: false, diag: false, update: false })

/** 本地时区构造时间戳：断言里的「本地化时间」在任何 TZ 下都是同一串字符。 */
const T = (y: number, mo: number, d: number, hh: number, mm: number, ss: number): number => new Date(y, mo - 1, d, hh, mm, ss).getTime()

/** 任务 A：待完善（触发方式 = Webhook，未填地址）；4 个关键词（触发「+1」折叠）。 */
const TASK_A: TaskInfo = {
  id: 1,
  name: '客户报价跟进',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  chatType: 'group',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keywords: ['报价', '合同', '打款', '交付'],
  photoLimit: 3,
  mentionMeOnly: true,
  triggerMethod: 'webhook',
  triggerConfig: {},
  triggerSecretSet: {},
  triggerVendorVersion: '1.0.0',
  callbackUrl: '',
  bazhuayuFlowId: '',
  bazhuayuApiKeySet: false,
  status: 'incomplete',
  createdAt: T(2026, 10, 18, 9, 0, 0),
  updatedAt: T(2026, 10, 18, 9, 0, 0),
  lastTriggeredAt: T(2026, 10, 19, 10, 24, 0),
  triggerCount: 2,
}

/** 任务 B：已完善，触发方式 = Webhook，带 Webhook 地址。 */
const TASK_B: TaskInfo = {
  id: 2,
  name: '上线通知',
  chatUsername: 'wxid_group_b',
  chatName: '发布群',
  chatType: 'group',
  targetUsername: 'wxid_target_b',
  targetName: '运维值班',
  keywords: ['上线'],
  photoLimit: 1,
  mentionMeOnly: false,
  triggerMethod: 'webhook',
  triggerConfig: { url: 'https://example.com/supertime/callback' },
  triggerSecretSet: {},
  triggerVendorVersion: '1.0.0',
  callbackUrl: 'https://example.com/supertime/callback',
  bazhuayuFlowId: '',
  bazhuayuApiKeySet: false,
  status: 'ready',
  createdAt: T(2026, 10, 17, 8, 30, 0),
  updatedAt: T(2026, 10, 19, 8, 30, 0),
  lastTriggeredAt: T(2026, 10, 19, 11, 2, 0),
  triggerCount: 1,
}

/** 任务 C：触发方式 = 八爪鱼 RPA（已填 FlowId、已保存 Key）——用于行内摘要与抽屉 body。 */
const TASK_BAZHUAYU: TaskInfo = {
  id: 3,
  name: '八爪鱼报价同步',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  chatType: 'group',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keywords: ['RPA'],
  photoLimit: 0,
  mentionMeOnly: false,
  triggerMethod: 'bazhuayu',
  triggerConfig: {
    flowId: '6ad859ccee2df270d53fc6e5',
    extraParams: [
      { name: 'order_no', source: 'fixed', fixedValue: 'A-001' },
      { name: 'kw_template', source: 'template', template: '${record.keyword}' },
    ],
  },
  triggerSecretSet: { apiKey: true },
  triggerVendorVersion: '1.0.0',
  callbackUrl: '',
  bazhuayuFlowId: '6ad859ccee2df270d53fc6e5',
  bazhuayuApiKeySet: true,
  status: 'incomplete',
  createdAt: T(2026, 10, 20, 9, 0, 0),
  updatedAt: T(2026, 10, 20, 9, 0, 0),
  triggerCount: 0,
}

/** 任务 D：触发方式 = 影刀 RPA（catalog 动态字段：两个 secret + 应用 UUID + map）。 */
const TASK_YINGDAO: TaskInfo = {
  id: 4,
  name: '影刀报价同步',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  chatType: 'group',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keywords: ['影刀'],
  photoLimit: 0,
  mentionMeOnly: false,
  triggerMethod: 'yingdao',
  triggerConfig: { robotUuid: '73d9a119-7ec7-4226-b679-506afefae667' },
  triggerSecretSet: { accessKeyId: true, accessKeySecret: true },
  triggerVendorVersion: '1.0.0',
  callbackUrl: '',
  bazhuayuFlowId: '',
  bazhuayuApiKeySet: false,
  status: 'incomplete',
  createdAt: T(2026, 10, 20, 9, 30, 0),
  updatedAt: T(2026, 10, 20, 9, 30, 0),
  triggerCount: 0,
}

/** 任务 E：厂商已下线（目录里没有该 id）——保存必须被拒、任务行摘要要显示「不可用」。 */
const TASK_UNKNOWN: TaskInfo = {
  id: 5,
  name: '已下线厂商任务',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  chatType: 'group',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keywords: ['旧'],
  photoLimit: 0,
  mentionMeOnly: false,
  triggerMethod: 'gone-vendor',
  triggerConfig: { legacy: 'x' },
  triggerSecretSet: {},
  triggerVendorVersion: '',
  callbackUrl: '',
  bazhuayuFlowId: '',
  bazhuayuApiKeySet: false,
  status: 'incomplete',
  createdAt: T(2026, 10, 20, 10, 0, 0),
  updatedAt: T(2026, 10, 20, 10, 0, 0),
  triggerCount: 0,
}

/** 厂商描述符夹具（与后端 `listRpaVendors` 的 JSON 同形；前端只认描述符，不认识具体厂商）。 */
const WEBHOOK_VENDOR: RpaVendorDescriptor = {
  id: 'webhook',
  name: 'Webhook',
  vendor: '内置',
  version: '1.0.0',
  summary: '把整条触发记录 JSON POST 到你填写的地址（含图片）',
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
    { key: 'paramMap', label: '参数映射', type: 'map', required: false, advanced: true },
  ],
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
  version: '1.2.0',
  summary: '把任务「附加参数」逐条映射成八爪鱼流程入参（默认不发业务参数），POST 到八爪鱼固定主机启动流程（不发图片）。',
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
        'taskId', 'recordId', 'fixed', 'template',
      ],
    },
  ],
  auth: { modes: [] },
  mapping: {
    style: 'object',
    // 无内置语义参数：Params 完全由附加参数组装（默认 {}）。
    targets: [],
    extrasField: 'extraParams',
  },
  request: { method: 'POST', url: 'https://api-rpa.bazhuayu.com/api/bots/scheduling/start' },
  response: { okHttpStatus: [200] },
  retry: { maxAttempts: 1, retryOn: [] },
  governance: { contentOutbound: true, hosts: [{ kind: 'exact', value: 'api-rpa.bazhuayu.com' }], privacySection: 'G3' },
  risks: ['图片不会发送（RPA 接口没有图片参数）'],
}

const YINGDAO_VENDOR: RpaVendorDescriptor = {
  id: 'yingdao',
  name: '影刀 RPA',
  vendor: '影刀 RPA（YingDao）',
  version: '1.0.0',
  summary: '调用影刀应用运行接口，参数按应用流程引用名映射',
  status: 'stable',
  docs: {
    home: 'https://www.yingdao.com/yddoc/rpa/zh-CN/710488569666060288',
    triggerApi: 'https://api.yingdao.com/oapi/dispatch/v2/job/start',
    lastVerifiedAt: '2026-10-21',
  },
  capabilities: { direction: 'outbound', synchronous: false, completion: 'callback', idempotency: 'vendor-key', deployment: ['cloud', 'onprem'] },
  fields: [
    { key: 'baseUrl', label: '服务地址', type: 'text', required: true, defaultValue: 'https://api.yingdao.com', advanced: true },
    { key: 'robotUuid', label: '应用 UUID', type: 'text', required: true, summary: true, example: '73d9a119-…' },
    { key: 'accountName', label: '机器人账号', type: 'text', required: false, help: '与机器人分组二选一' },
    { key: 'robotClientGroupUuid', label: '机器人分组 UUID', type: 'text', required: false },
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
  mapping: {
    style: 'nameValueTypeArray',
    mapField: 'paramMap',
    targets: [
      { semantic: 'room', defaultKey: 'room_name' },
      { semantic: 'content', defaultKey: 'content' },
      { semantic: 'at', defaultKey: 'at_name' },
    ],
  },
  request: { method: 'POST', url: '${config.baseUrl}/oapi/dispatch/v2/job/start' },
  response: { okHttpStatus: [200], okPath: 'code', okValue: 200, externalTaskIdPath: 'data.jobUuid' },
  retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx'] },
  governance: { contentOutbound: true, hosts: [{ kind: 'exact', value: 'api.yingdao.com' }], allowCustomBaseUrl: true, privacySection: 'G3' },
  risks: ['回调无签名，只能作为信号并用查询接口二次确认', '专有云地址需用户自填'],
  notes: ['官方未给完整响应示例，tokenPath 需联调核对'],
}

const ALIYUN_VENDOR: RpaVendorDescriptor = {
  id: 'aliyun-rpa',
  name: '阿里云 RPA',
  vendor: '阿里云 RPA',
  version: '1.0.0',
  summary: '调用阿里云 RPA CreateTask（实验性，签名与 body 位置待 POC 确认）',
  status: 'experimental',
  docs: {
    home: 'https://help.aliyun.com/product/104798.html',
    triggerApi: 'https://help.aliyun.com/document_detail/104798.html',
    lastVerifiedAt: '2026-10-21',
  },
  capabilities: { direction: 'outbound', synchronous: false, completion: 'callback', idempotency: 'vendor-key', deployment: ['cloud', 'onprem'] },
  fields: [
    { key: 'appId', label: '应用 AppId', type: 'text', required: true },
    { key: 'robotId', label: '机器人 id', type: 'text', required: false },
  ],
  auth: { modes: [{ strategy: 'custom', custom: 'aliyun-rpc-hmac-sha1', fields: [] }] },
  mapping: {
    style: 'formParams',
    mapField: 'paramMap',
    targets: [
      { semantic: 'room', defaultKey: 'room_name' },
      { semantic: 'content', defaultKey: 'content' },
      { semantic: 'at', defaultKey: 'at_name' },
    ],
  },
  request: { method: 'POST', url: 'https://console-rpa.aliyun.com/rpa/openapi/task/createServiceTask' },
  response: { okHttpStatus: [200] },
  retry: { maxAttempts: 1, retryOn: [] },
  governance: { contentOutbound: true, hosts: [{ kind: 'exact', value: 'console-rpa.aliyun.com' }], privacySection: 'G3' },
  risks: ['官方请求示例 body/query 矛盾', '回调无签名', '签名位置待 POC 确认'],
}

/** SSR 注入的厂商目录（顺序即选择器顺序）。 */
const VENDOR_CATALOG: RpaVendorCatalog = {
  items: [WEBHOOK_VENDOR, BAZHUAYU_VENDOR, YINGDAO_VENDOR, ALIYUN_VENDOR],
  registryVersion: '2026-10-21',
}

/** 触发记录 1（任务 A，有图，已投递）。 */
const RECORD_1: TaskTriggerRecord = {
  id: 101,
  taskId: 1,
  taskName: '客户报价跟进',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keyword: '报价',
  text: '客户问：这批货的报价单能今天发一份吗？顺便把上次的合同版本也带上。',
  images: [
    { localId: 9001, createTime: T(2026, 10, 19, 10, 23, 40), sender: '客户经理' },
    { localId: 9002, createTime: T(2026, 10, 19, 10, 23, 52), sender: '客户经理' },
  ],
  messageLocalId: 5001,
  messageSortSeq: 70001,
  triggeredAt: T(2026, 10, 19, 10, 24, 0),
  callbackStatus: 'sent',
  callbackAt: T(2026, 10, 19, 10, 24, 1),
}

/** 触发记录 2（任务 A，无图，待投递）。 */
const RECORD_2: TaskTriggerRecord = {
  id: 102,
  taskId: 1,
  taskName: '客户报价跟进',
  chatUsername: 'wxid_group_a',
  chatName: '报价群',
  targetUsername: 'wxid_target_a',
  targetName: '客户经理',
  keyword: '合同',
  text: '合同盖章版我这边收到了，下午走流程。',
  images: [],
  messageLocalId: 5002,
  messageSortSeq: 70002,
  triggeredAt: T(2026, 10, 19, 9, 5, 30),
  callbackStatus: 'pending',
}

/** 触发记录 3（任务 B）：选中任务 A 时**不该出现**在右栏。 */
const RECORD_OTHER: TaskTriggerRecord = {
  id: 103,
  taskId: 2,
  taskName: '上线通知',
  chatUsername: 'wxid_group_b',
  chatName: '发布群',
  targetUsername: 'wxid_target_b',
  targetName: '运维值班',
  keyword: '上线',
  text: '该记录应被过滤掉',
  images: [],
  messageLocalId: 5003,
  messageSortSeq: 70003,
  triggeredAt: T(2026, 10, 19, 11, 2, 0),
  callbackStatus: 'skipped',
}

/** SSR 用的动作桩：视图只把它们挂到事件上，渲染期不会调用。 */
const OK_MUTATION: TaskInfoMutationResult = { ok: true }
const OK_DISPATCH: TaskCallbackDispatchResult = { ok: true, status: 'sent' }
const ACTIONS: TaskCenterActions = {
  onSelectTask: () => { /* noop */ },
  onToggleEdit: () => { /* noop */ },
  onCloseEdit: () => { /* noop */ },
  onOpenRecord: () => { /* noop */ },
  onCloseRecord: () => { /* noop */ },
  onRefresh: () => { /* noop */ },
  onScan: () => { /* noop */ },
  onSaveTask: (_task: TaskInfo, _input: TaskInfoInput) => Promise.resolve(OK_MUTATION),
  onSetStatus: (_id: number, _status: TaskInfoStatus) => Promise.resolve(OK_MUTATION),
  onDeleteTask: (_id: number) => Promise.resolve(OK_MUTATION),
  onDeleteTasks: (_ids: number[]) => Promise.resolve({ ok: true, removed: 0 }),
  onDeleteTriggers: (_ids: number[]) => Promise.resolve({ ok: true, removed: 0 }),
  onDispatch: (_triggerId: number) => Promise.resolve(OK_DISPATCH),
  onNotice: () => { /* noop */ },
}

/**
 * 抽屉 body 单独渲染用的写动作桩（表单不会在渲染期调用它们）。
 *
 * 为什么不直接渲染整个抽屉：`Drawer` 走 Radix Dialog + Portal，portal 的挂载依赖 layout effect，
 * `renderToStaticMarkup` 不执行 effect ⇒ SSR 下抽屉内容为 null（见文件头注）。这里渲染**同一份**
 * 表单组件，断言抽屉里的配置项真的画得出来；真实浏览器的抽屉语义由 E2E 覆盖。
 */
const FORM_STUBS = {
  onSave: (_input: TaskInfoInput) => Promise.resolve(OK_MUTATION),
  onSetStatus: (_status: TaskInfoStatus) => Promise.resolve(OK_MUTATION),
  onDelete: () => Promise.resolve(OK_MUTATION),
  onNotice: (_text: string) => { /* noop */ },
}
/** 目录正常时的表单公共 props。 */
const FORM_VENDORS = {
  vendorCatalog: VENDOR_CATALOG.items,
  vendorCatalogError: null,
  vendorCatalogLoading: false,
}
/** Webhook 方式的抽屉 body。 */
const webhookFormHtml = renderToStaticMarkup(h(TaskEditForm, { task: TASK_A, ...FORM_VENDORS, ...FORM_STUBS }))
/** 八爪鱼方式（已保存 Key）的抽屉 body。 */
const bazhuayuFormHtml = renderToStaticMarkup(h(TaskEditForm, { task: TASK_BAZHUAYU, ...FORM_VENDORS, ...FORM_STUBS }))
/** 八爪鱼方式（从未配置过 Key）的抽屉 body：placeholder 应提示去填。 */
const bazhuayuNewFormHtml = renderToStaticMarkup(h(TaskEditForm, {
  task: { ...TASK_BAZHUAYU, triggerSecretSet: {}, bazhuayuApiKeySet: false },
  ...FORM_VENDORS,
  ...FORM_STUBS,
}))
/** 影刀方式：catalog 动态字段（账号与鉴权 / 流程与参数 / 高级 / map / 厂商说明）。 */
const yingdaoFormHtml = renderToStaticMarkup(h(TaskEditForm, { task: TASK_YINGDAO, ...FORM_VENDORS, ...FORM_STUBS }))
/** 实验性厂商：状态徽标与 risks。 */
const experimentalFormHtml = renderToStaticMarkup(h(TaskEditForm, {
  task: { ...TASK_UNKNOWN, triggerMethod: 'aliyun-rpa', triggerConfig: {} },
  ...FORM_VENDORS,
  ...FORM_STUBS,
}))
/** 厂商已下线：选择器显示不可用、保存/标记按钮禁用。 */
const unknownVendorFormHtml = renderToStaticMarkup(h(TaskEditForm, { task: TASK_UNKNOWN, ...FORM_VENDORS, ...FORM_STUBS }))
/** 目录读取失败：抽屉里也要显示可读错误（且禁止保存）。 */
const catalogErrorFormHtml = renderToStaticMarkup(h(TaskEditForm, {
  task: TASK_A,
  vendorCatalog: [],
  vendorCatalogError: 'remote unavailable',
  vendorCatalogLoading: false,
  ...FORM_STUBS,
}))

let passed = 0
let failed = 0

/** 断言块（与 wordcloud-ssr 同一口径：一项失败不打断其余项）。 */
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}

/** 极简断言。 */
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** 主场景：选中任务 A、展开任务 A 的编辑表单、打开记录 1 的弹窗。 */
const html = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [TASK_A, TASK_B],
  triggers: [RECORD_1, RECORD_2, RECORD_OTHER],
  selectedTaskId: 1,
  expandedTaskId: 1,
  openRecordId: 101,
  openRecord: RECORD_1,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  tasksStale: false,
  triggersStale: false,
  triggersTotal: 5,
  triggersHasMore: true,
  triggersLoadingMore: false,
  triggersLoadMoreError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  refreshing: false,
  notice: null,
  taskSearch: '报价',
  triggerSearch: '报价',
  triggerSearchDraft: '报价',
  taskBatchMode: false,
  selectedTaskIds: new Set([1]),
  triggerBatchMode: false,
  selectedTriggerIds: new Set([101]),
  vendorCatalog: VENDOR_CATALOG.items,
  actions: ACTIONS,
}))

console.log('任务信息双栏面板 SSR 冒烟')

check('双栏标题与说明渲染出来了', () => {
  ok(html.includes('任务信息'), '缺少左栏标题「任务信息」')
  ok(html.includes('任务触发记录'), '缺少右栏标题「任务触发记录」')
  ok(html.includes('客户报价跟进'), '缺少任务名（左栏没画出来）')
  ok(html.includes('触发记录'), '缺少「触发记录」相关文案')
})

check('任务状态徽标：待完善 / 已完善 都在（颜色档由 Badge 的 data-tone 决定）', () => {
  ok(html.includes('待完善'), '缺少「待完善」')
  ok(html.includes('已完善'), '缺少「已完善」')
  ok(html.includes('data-tone="amber"'), '「待完善」没有 amber 色调')
  ok(html.includes('data-tone="green"'), '「已完善」没有 green 色调')
})

check('任务行信息：会话→目标、关键词折叠 +1、照片张数、未填 Webhook、触发次数', () => {
  ok(html.includes('报价群') && html.includes('客户经理'), '缺少「会话 → 目标」')
  ok(html.includes('>+1<'), '4 个关键词没有折成「+1」')
  ok(html.includes('3 张图片'), '缺少照片张数')
  ok(html.includes('未填 Webhook'), '空 Webhook 地址没有显示「未填 Webhook」')
  ok(html.includes('2 次触发'), '缺少触发次数')
  ok(html.includes(triggerTimeText(RECORD_1.triggeredAt)), '缺少最近触发时间')
})

check('任务行提供「编辑」入口（点击打开右侧抽屉，不改变右栏筛选）', () => {
  ok(html.includes('aria-label="编辑「客户报价跟进」"'), '任务行缺少「编辑」入口')
  ok(html.includes('aria-expanded="true"'), '正在编辑的任务行没有 aria-expanded')
  // 抽屉内容走 Radix Portal：SSR 下不挂载（见文件头注），所以表单不该平铺在视图里。
  ok(!html.includes('aria-label="编辑任务：客户报价跟进"'), '抽屉表单被平铺在视图里了（应只在 Drawer 内）')
})

check('右栏按选中任务过滤：任务 B 的记录不出现', () => {
  ok(html.includes('合同盖章版'), '任务 A 的记录没出现')
  ok(!html.includes('该记录应被过滤掉'), '任务 B 的记录没有被过滤掉（右栏没按 selectedTaskId 过滤）')
  ok(html.includes('报价群') && html.includes('客户经理'), '缺少触发记录的「群聊 / 对象」')
})

check('记录弹窗五组内容齐全（触发时间 / 触发群聊 / 触发对象 / 触发文本 / 触发图片）', () => {
  for (const label of ['触发时间', '触发群聊', '触发对象', '命中关键词', '触发文本', '触发图片']) {
    ok(html.includes(label), `弹窗缺少「${label}」这一组`)
  }
  ok(html.includes('role="dialog"'), '弹窗没有 role="dialog"')
  ok(html.includes('aria-modal="true"'), '弹窗没有 aria-modal')
  ok(html.includes('data-st-dialog="task-center-record"'), '弹窗没有 data-st-dialog 锚点（焦点管理找不到宿主）')
  ok(html.includes('客户问：这批货的报价单'), '缺少触发文本全文')
  ok(html.includes('正在解码触发图片'), '有图片时没有解码中的加载态')
})

check('弹窗回调区：状态徽标 + 重新投递入口', () => {
  ok(html.includes('已投递'), '缺少「已投递」回调状态')
  ok(html.includes('重新投递'), '缺少「重新投递」按钮')
  ok(html.includes('投递时间'), '缺少回调投递时间')
})

check('抽屉 body（Webhook 方式）：任务名 / 触发关键词 / 触发方式选择器 / Webhook 地址 / 照片数量 / 标记已完善 / 删除', () => {
  for (const label of ['任务名', '触发关键词', '触发方式', '照片数量', 'Webhook 地址', 'Webhook', '八爪鱼 RPA', '标记已完善', '删除', '保存']) {
    ok(webhookFormHtml.includes(label), `抽屉表单缺少「${label}」`)
  }
  ok(webhookFormHtml.includes('aria-label="编辑任务：客户报价跟进"'), '抽屉表单没有可访问名（aria-label="编辑任务：<name>"）')
  ok(webhookFormHtml.includes('aria-label="触发方式"'), '「触发方式」选择器没有可访问名')
  ok(webhookFormHtml.includes('<select'), '「触发方式」没有渲染成 select（E2E 用 selectOption）')
  ok(webhookFormHtml.includes('placeholder="https://example.com/webhook"'), 'Webhook 地址 placeholder 不对')
  ok(webhookFormHtml.includes('aria-label="Webhook 地址"'), 'Webhook 地址输入框没有可访问名')
  ok(webhookFormHtml.includes('仅匹配@我的文本'), '群聊抽屉表单缺少「仅匹配@我的文本」')
  ok(webhookFormHtml.includes('@所有人不算'), '勾选项缺少结构化 @ 的边界说明')
  ok(webhookFormHtml.includes('标记已完善前需填写：Webhook 地址'), '缺少按描述符 required 生成的「已完善」前置提示')
})

check('抽屉 body（八爪鱼 RPA 方式）：FlowId / API Key（password、已保存不回显）/ 厂商说明', () => {
  ok(bazhuayuFormHtml.includes('aria-label="编辑任务：八爪鱼报价同步"'), '八爪鱼任务表单没有可访问名')
  ok(bazhuayuFormHtml.includes('aria-label="八爪鱼 FlowId"'), '缺少「八爪鱼 FlowId」输入框')
  ok(bazhuayuFormHtml.includes('placeholder="6ad859ccee2df270d53fc6e5"'), 'FlowId placeholder 不对')
  ok(bazhuayuFormHtml.includes('value="6ad859ccee2df270d53fc6e5"'), 'FlowId 没有回填任务里的值')
  ok(bazhuayuFormHtml.includes('aria-label="八爪鱼 API Key"'), '缺少「八爪鱼 API Key」输入框')
  ok(bazhuayuFormHtml.includes('type="password"'), 'API Key 输入框不是 password（Key 不能明文展示）')
  ok(bazhuayuFormHtml.includes('已保存，留空保持不变'), '已配置 Key 时 placeholder 没有提示「留空保持不变」')
  ok(bazhuayuFormHtml.includes('默认不发业务参数'), '厂商说明没有写清「默认不发业务参数」（v1.2.0 语义）')
  ok(bazhuayuFormHtml.includes('图片不会发送'), '厂商说明没有写清不发图片')
  ok(bazhuayuFormHtml.includes('https://www.bazhuayu.com/'), '厂商说明缺少官方文档地址')
  ok(bazhuayuFormHtml.includes('标记已完善前需填写：FlowId、API Key'), '缺少八爪鱼方式的「已完善」前置提示')
})

check('八爪鱼 Key 从未配置时：placeholder 提示填写（不是「已保存」）', () => {
  ok(bazhuayuNewFormHtml.includes('填写API Key'), '未配置 Key 的 placeholder 不对')
  ok(!bazhuayuNewFormHtml.includes('已保存，留空保持不变'), '从未配置 Key 却提示「已保存」')
})

check('凭据「眼睛」：已保存的 API Key 有「查看」按钮，未配置没有；SSR 只断言存在（点击行为由 E2E 覆盖）', () => {
  ok(bazhuayuFormHtml.includes('aria-label="查看 八爪鱼 API Key"'), '已保存 Key 的字段缺少「查看 八爪鱼 API Key」眼睛按钮')
  ok(bazhuayuFormHtml.includes('查看</button>'), '眼睛按钮文案不对')
  ok(!bazhuayuNewFormHtml.includes('aria-label="查看 八爪鱼 API Key"'), '未配置 Key 却渲染了眼睛按钮')
  ok(!bazhuayuNewFormHtml.includes('隐藏 八爪鱼 API Key'), '未配置 Key 却出现「隐藏」状态')
  // 眼睛按钮不能把明文带进 SSR（服务端只渲染 password 输入框）。
  ok(!bazhuayuFormHtml.includes('e2e-bazhuayu-key'), 'SSR 里出现了凭据原文（服务端不该回显）')
})

check('八爪鱼参数传递（v1.2.0）：没有「参数映射」区块，附加参数渲染固定值 / 自定义模板两行', () => {
  ok(!bazhuayuFormHtml.includes('参数映射'), '八爪鱼 v1.2.0 仍渲染了「参数映射」（内置三参数已移除）')
  ok(!bazhuayuFormHtml.includes('aria-label="参数映射 · 会话名"'), '八爪鱼仍渲染了参数映射的会话名输入')
  ok(bazhuayuFormHtml.includes('附加参数'), '缺少「附加参数」字段')
  ok(bazhuayuFormHtml.includes('八爪鱼流程的入参全部在这里配置'), '附加参数缺少 help 说明（默认不发业务参数）')
  ok(bazhuayuFormHtml.includes('添加附加参数'), '缺少「添加附加参数」按钮')
  ok(bazhuayuFormHtml.includes('最多 20 条'), '附加参数没有展示 maxItems 上限')
  ok(bazhuayuFormHtml.includes('aria-label="附加参数 参数名 1"'), '第一行缺少「附加参数 参数名 1」')
  ok(bazhuayuFormHtml.includes('aria-label="附加参数 值来源 1"'), '第一行缺少「附加参数 值来源 1」')
  ok(bazhuayuFormHtml.includes('aria-label="附加参数 固定值 1"'), '固定值来源没有渲染「附加参数 固定值 1」')
  ok(bazhuayuFormHtml.includes('value="order_no"'), '第一行参数名没有回填 order_no')
  ok(bazhuayuFormHtml.includes('value="A-001"'), '固定值没有回填 A-001')
  ok(bazhuayuFormHtml.includes('aria-label="附加参数 模板 2"'), '第二行缺少「附加参数 模板 2」')
  ok(bazhuayuFormHtml.includes('value="kw_template"'), '第二行参数名没有回填 kw_template')
  ok(bazhuayuFormHtml.includes('value="${record.keyword}"'), '模板没有回填 ${record.keyword}')
  ok(bazhuayuFormHtml.includes('aria-label="删除附加参数 1"'), '缺少「删除附加参数 1」按钮')
  ok(!bazhuayuFormHtml.includes('aria-label="附加参数 固定值 2"'), '模板来源的行不该渲染固定值输入')
})

check('影刀 RPA：catalog 动态字段（账号与鉴权 / 流程与参数 / 高级 / map / 厂商说明）', () => {
  ok(yingdaoFormHtml.includes('aria-label="编辑任务：影刀报价同步"'), '影刀任务表单没有可访问名')
  ok(yingdaoFormHtml.includes('影刀 RPA'), '选择器里没有渲染目录中的「影刀 RPA」')
  ok(yingdaoFormHtml.includes('账号与鉴权'), '缺少「账号与鉴权」分区')
  ok(yingdaoFormHtml.includes('流程与参数'), '缺少「流程与参数」分区')
  ok(yingdaoFormHtml.includes('高级'), '缺少「高级」折叠区')
  ok(yingdaoFormHtml.includes('aria-label="AccessKeyId"'), '缺少 AccessKeyId 凭据字段')
  ok(yingdaoFormHtml.includes('aria-label="AccessKeySecret"'), '缺少 AccessKeySecret 凭据字段')
  ok(yingdaoFormHtml.includes('aria-label="应用 UUID"'), '缺少「应用 UUID」字段')
  ok(yingdaoFormHtml.includes('aria-label="参数映射 · 会话名"'), 'map 字段没有渲染「会话名」参数名输入')
  ok(yingdaoFormHtml.includes('aria-label="参数映射 · 触发文本"'), 'map 字段没有渲染「触发文本」参数名输入')
  ok(yingdaoFormHtml.includes('aria-label="参数映射 · 触发对象"'), 'map 字段没有渲染「触发对象」参数名输入')
  ok(yingdaoFormHtml.includes('value="73d9a119-7ec7-4226-b679-506afefae667"'), '应用 UUID 没有回填任务里的值')
  ok(yingdaoFormHtml.includes('参数核对 2026-10-21'), '厂商说明缺少参数核对时间')
  ok(yingdaoFormHtml.includes('https://api.yingdao.com/oapi/dispatch/v2/job/start'), '厂商说明缺少官方触发接口链接')
  ok(yingdaoFormHtml.includes('回调无签名'), '厂商 risks 没有展示')
})

check('实验性厂商：⚠ 实验性徽标 + risks；已下线厂商：选择器不可用且保存/标记禁用', () => {
  ok(experimentalFormHtml.includes('⚠ 实验性'), '实验性厂商没有警告徽标')
  ok(experimentalFormHtml.includes('body/query 矛盾'), '实验性厂商 risks 没有展示')
  ok(unknownVendorFormHtml.includes('触发方式不可用（厂商已下线）'), '未知厂商没有「触发方式不可用（厂商已下线）」')
  ok(unknownVendorFormHtml.includes('disabled=""'), '未知厂商的「保存 / 标记」按钮没有禁用')
  ok(!unknownVendorFormHtml.includes('aria-label="八爪鱼 FlowId"'), '未知厂商不该渲染动态字段')
})

check('目录读取失败：抽屉里也有可读错误且禁止保存', () => {
  ok(catalogErrorFormHtml.includes('读取触发方式目录失败：remote unavailable'), '抽屉里没有目录读取失败错误')
  ok(catalogErrorFormHtml.includes('disabled=""'), '目录读取失败时保存按钮没有禁用')
})

/** 八爪鱼 fixture 的任务行：行内摘要要能一眼看出触发方式（不打开抽屉）。 */
const bazhuayuRowHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [TASK_BAZHUAYU],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  triggersTotal: 0,
  triggersHasMore: false,
  triggersLoadingMore: false,
  triggersLoadMoreError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  vendorCatalog: VENDOR_CATALOG.items,
  actions: ACTIONS,
}))

check('任务行摘要：八爪鱼 RPA · <flowId>（用户不打开抽屉也能看出触发方式）', () => {
  ok(bazhuayuRowHtml.includes('八爪鱼 RPA · 6ad859ccee2df270d53fc6e5'), '任务行没有显示「八爪鱼 RPA · <flowId>」摘要')
  ok(bazhuayuRowHtml.includes('data-trigger-method="bazhuayu"'), '任务行摘要没有标记触发方式')
  ok(!bazhuayuRowHtml.includes('未填 Webhook'), '八爪鱼任务不该再显示 Webhook 摘要')
})

/** 已下线厂商的任务行：摘要必须显示「触发方式不可用（厂商已下线）」。 */
const unknownRowHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [TASK_UNKNOWN],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  triggersTotal: 0,
  triggersHasMore: false,
  triggersLoadingMore: false,
  triggersLoadMoreError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  vendorCatalog: VENDOR_CATALOG.items,
  actions: ACTIONS,
}))

check('已下线厂商：任务行摘要显示「触发方式不可用（厂商已下线）」', () => {
  ok(unknownRowHtml.includes('触发方式不可用（厂商已下线）'), '任务行没有提示触发方式不可用')
  ok(unknownRowHtml.includes('data-trigger-method="gone-vendor"'), '任务行没有保留触发方式 id')
})

/** 目录读取失败：面板顶部错误条（不是静默只剩 Webhook）。 */
const catalogErrorHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [TASK_A],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  triggersTotal: 0,
  triggersHasMore: false,
  triggersLoadingMore: false,
  triggersLoadMoreError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  vendorCatalog: [],
  vendorCatalogError: 'remote unavailable',
  actions: ACTIONS,
}))

check('触发方式目录读取失败：面板顶部错误条 + 说明「当前不能保存」', () => {
  ok(catalogErrorHtml.includes('读取触发方式目录失败：remote unavailable'), '缺少目录读取失败错误条')
  ok(catalogErrorHtml.includes('当前不能保存触发方式配置'), '错误条没有说明不能保存')
  ok(catalogErrorHtml.includes('role="alert"'), '错误条没有 role="alert"')
})

check('工具条：「刷新」「立即检查」与计数都在', () => {
  ok(html.includes('刷新'), '缺少「刷新」')
  ok(html.includes('立即检查'), '缺少「立即检查」')
  ok(/任务\s*(?:<!-- -->)?\s*2/.test(html), '缺少任务计数')
})

check('两栏搜索：任务与触发记录都有搜索框、占位符和清除按钮', () => {
  ok(html.includes('aria-label="搜索任务"'), '左栏缺少搜索框')
  ok(html.includes('搜索任务名 / 关键词 / 会话'), '左栏搜索占位符不对')
  ok(html.includes('aria-label="搜索触发记录"'), '右栏缺少搜索框')
  ok(html.includes('搜索正文 / 任务 / 会话 / 关键词'), '右栏搜索占位符不对')
  ok((html.match(/aria-label="清除搜索"/g) ?? []).length >= 1, '搜索框没有清除按钮')
})

check('任务行直接提供删除入口（复用危险色共享按钮）', () => {
  ok(html.includes('aria-label="删除任务「客户报价跟进」"'), '任务行缺少直接删除入口')
  ok(html.includes('>删除<'), '任务行删除按钮没有可见文案')
})

/** 批量模式单独渲染：同一场景下切换两栏的批量选择状态。 */
const batchProps = {
    tasks: [TASK_A, TASK_B],
    triggers: [RECORD_1, RECORD_2, RECORD_OTHER],
    selectedTaskId: 1,
    expandedTaskId: null,
    openRecordId: null,
    openRecord: null,
    tasksLoading: false,
    triggersLoading: false,
    tasksError: null,
    triggersError: null,
    tasksReadError: null,
    triggersReadError: null,
    triggersTotal: 3,
    triggersHasMore: false,
    triggersLoadingMore: false,
    triggersLoadMoreError: null,
    onLoadMoreTriggers: () => { /* noop */ },
    scanning: false,
    notice: null,
    taskSearch: '',
    triggerSearch: '',
    triggerSearchDraft: '',
    taskBatchMode: true,
    selectedTaskIds: new Set([1]),
    triggerBatchMode: true,
    selectedTriggerIds: new Set([101]),
    actions: ACTIONS,
} satisfies React.ComponentProps<typeof TaskCenterView>
const batchHtml = renderToStaticMarkup(h(TaskCenterView, batchProps))

check('批量模式：两栏都有全选/清空/删除所选与选中计数', () => {
  for (const label of ['任务批量操作', '触发记录批量操作', '删除所选 (1)', '已选 1 条']) {
    ok(batchHtml.includes(label), `批量模式缺少「${label}」`)
  }
  ok((batchHtml.match(/>全选</g) ?? []).length >= 2, '两栏没有都提供全选')
  ok((batchHtml.match(/>清空</g) ?? []).length >= 2, '两栏没有都提供清空')
  ok(batchHtml.includes('role="checkbox"'), '批量模式行没有复选框语义')
  ok(!batchHtml.includes('aria-label="删除任务「客户报价跟进」"'), '批量模式仍暴露单条删除入口')
})

check('左栏搜索按任务名过滤，未命中的任务不出现', () => {
  ok(html.includes('客户报价跟进'), '命中的任务没有出现')
  ok(!html.includes('上线通知'), '未命中的任务仍被画出来（客户端过滤没生效）')
  ok(html.includes('1 / 2 个任务'), '搜索后的任务计数不对')
})

check('触发记录无匹配空态与清除提示', () => {
  const noMatchHtml = renderToStaticMarkup(h(TaskCenterView, {
    tasks: [TASK_A, TASK_B],
    triggers: [],
    selectedTaskId: null,
    expandedTaskId: null,
    openRecordId: null,
    openRecord: null,
    tasksLoading: false,
    triggersLoading: false,
    tasksError: null,
    triggersError: null,
    tasksReadError: null,
    triggersReadError: null,
    onLoadMoreTriggers: () => { /* noop */ },
    scanning: false,
    notice: null,
    taskSearch: '',
    triggerSearch: '不存在',
    triggerSearchDraft: '不存在',
    actions: ACTIONS,
  }))
  ok(noMatchHtml.includes('没有匹配的触发记录'), '缺少触发记录无匹配空态')
  ok(noMatchHtml.includes('当前搜索「不存在」没有命中'), '无匹配空态没有回显搜索词')
  ok(noMatchHtml.includes('可换个词或清除搜索'), '无匹配空态没有清除搜索引导')
})

check('分页入口：显示真实总数与当前已加载条数', () => {
  ok(html.includes('2 / 5 条'), '右栏标题没有显示「已加载 / 总数」')
  ok(html.includes('加载更多（已 2 / 5）'), '缺少「加载更多」按钮或计数不对')
})

/** 空态场景：没有任务时给出去哪创建的引导，而不是一片空白。 */
const emptyHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: null,
  triggersReadError: null,
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  actions: ACTIONS,
}))

check('空态：没有任务时给「在聊天会话/聊天信息里点新建任务」的引导', () => {
  ok(emptyHtml.includes('还没有任务信息'), '缺少任务空态标题')
  ok(emptyHtml.includes('新建任务'), '缺少「新建任务」引导')
  ok(emptyHtml.includes('还没有任何触发记录'), '缺少记录空态标题')
  ok(!emptyHtml.includes('role="dialog"'), '空态不该渲染记录弹窗')
  ok(!emptyHtml.includes('aria-label="编辑任务：'), '空态不该渲染编辑抽屉的表单')
  ok(!emptyHtml.includes('触发方式'), '空态不该渲染触发方式分区')
})

/** 读错误场景：必须与「确实没有」分开说。 */
const errorHtml = renderToStaticMarkup(h(TaskCenterView, {
  tasks: [],
  triggers: [],
  selectedTaskId: null,
  expandedTaskId: null,
  openRecordId: null,
  openRecord: null,
  tasksLoading: false,
  triggersLoading: false,
  tasksError: null,
  triggersError: null,
  tasksReadError: 'database is locked',
  triggersReadError: 'database is locked',
  onLoadMoreTriggers: () => { /* noop */ },
  scanning: false,
  notice: null,
  taskSearch: '',
  triggerSearch: '',
  triggerSearchDraft: '',
  actions: ACTIONS,
}))

check('读错误：显式错误条（不是「暂无任务」），且带 role="alert"', () => {
  ok(errorHtml.includes('database is locked'), '缺少读错误详情')
  ok(errorHtml.includes('任务库读取失败'), '任务读错误没有独立文案')
  ok(errorHtml.includes('不是「没有任务」'), '任务读错误没有与空态区分')
  ok(errorHtml.includes('触发记录读取失败'), '触发记录读错误没有独立文案')
  ok(errorHtml.includes('role="alert"'), '错误条没有 role="alert"')
  ok(!errorHtml.includes('还没有任务信息'), '读失败时仍画成了「还没有任务信息」空态')
})

console.log(`\n${failed ? '❌' : '✅'} 任务信息面板冒烟：通过 ${String(passed)} 项${failed ? `，失败 ${String(failed)} 项` : ''}`)
if (failed > 0) process.exitCode = 1
