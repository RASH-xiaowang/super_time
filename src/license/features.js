/**
 * 许可证功能目录（单一出处）。
 *
 * 这里的 `id` 会写进签名后的 license.json，不能随意改名；
 * 面向客户的中文名与说明只用于签发台和授权状态展示。
 *
 * `wechat-data` 是基础数据引擎，始终随新许可证签发。
 * 旧许可证没有 featureSchemaVersion 时按兼容模式处理，见 service.js。
 */

const FEATURE_SCHEMA_VERSION = 2

/** 新许可证必须包含的基础功能位。 */
const REQUIRED_FEATURES = ['wechat-data']

/** 功能分组：签发台按此顺序分栏，客户只看中文名称与说明。 */
const FEATURE_GROUPS = [
  {
    id: 'base',
    label: '基础',
    description: '本机数据解析与所有可选功能的前置能力。',
  },
  {
    id: 'data',
    label: '数据浏览',
    description: '按业务模块开放本机微信数据的查看、搜索与分析。',
  },
  {
    id: 'ai',
    label: '智能能力',
    description: '使用本机模型或客户自己配置的智能模型。',
  },
  {
    id: 'tools',
    label: '交付与维护',
    description: '导出、备份、隐私与数据维护能力。',
  },
  {
    id: 'apps',
    label: '应用托管',
    description: '由 Super Time 统一授权、部署与管理的本机应用（如 SuperLanguage）。',
  },
]

/**
 * 被托管应用可用的能力位。
 *
 * 这些位写进许可证的 `apps.<appId>.caps`，再由 Super Time 经授权票据下发给实例，
 * 实例在执行前逐条检查 —— 因此新增位必须同时改 `apps/superlanguage/src/license_gate.cpp`
 * 的识别表，否则会落到「未知能力一律拒绝」。
 */
const APP_CAPABILITIES = [
  { id: 'search', label: '会话搜索', description: '只做 Ctrl+F 定位会话，不输入正文。' },
  { id: 'send', label: '文本发送', description: '向目标会话发送文本消息。' },
  { id: 'attachments', label: '附件发送', description: '发送本机文件与附件资源。' },
  { id: 'mention', label: '群成员 @', description: '在群聊里 @ 指定成员。' },
]

/** 托管默认能力：没写 caps 时按全部开放（席位与配额仍然生效）。 */
const DEFAULT_APP_CAPABILITIES = APP_CAPABILITIES.map((item) => item.id)

/** 托管默认每小时任务上限；写进工时只作兜底，实际由 Super Time 覆盖。 */
const DEFAULT_APP_MAX_JOBS_PER_HOUR = 120

/**
 * 所有可签发的功能位。
 * `direct: true` 表示该能力由主进程 IPC 直接校验，不经过 @Remote 方法表。
 */
const FEATURE_CATALOG = [
  {
    id: 'wechat-data',
    label: '基础数据访问',
    group: 'base',
    required: true,
    description: '检测密钥、解密数据库并读取本机微信数据；其他功能都依赖它。',
  },
  {
    id: 'overview',
    label: '数据总览',
    group: 'data',
    description: '首页统计、趋势、地图、词云与关系摘要。',
  },
  {
    id: 'chats',
    label: '聊天会话',
    group: 'data',
    description: '会话、消息、聊天搜索、通话与撤回内容。',
  },
  {
    id: 'contacts',
    label: '通讯录与客户画像',
    group: 'data',
    description: '联系人、群成员、客户全景与社交图谱。',
  },
  {
    id: 'moments',
    label: '朋友圈与洞察',
    group: 'data',
    description: '朋友圈时间线、媒体、作者与洞察分析。',
  },
  {
    id: 'favorites',
    label: '收藏与表情',
    group: 'data',
    description: '收藏内容、表情包与收藏表情统计。',
  },
  {
    id: 'files',
    label: '文件与存储',
    group: 'data',
    description: '文件、媒体资产、公众号文章与存储分析。',
  },
  {
    id: 'ledger',
    label: '资金往来',
    group: 'data',
    description: '转账红包明细、资金汇总与支付状态。',
  },
  {
    id: 'group-insights',
    label: '群聊分析',
    group: 'data',
    description: '群活跃洞察与群聊监控。',
  },
  {
    id: 'knowledge-base',
    label: '知识库与知识图谱',
    group: 'data',
    description: '笔记、知识库文件、分块与知识图谱。',
  },
  {
    id: 'annual-report',
    label: '年度报告',
    group: 'data',
    description: '年度回顾看板与年度叙事。',
  },
  {
    id: 'search',
    label: '全局搜索',
    group: 'data',
    description: '跨消息、联系人、朋友圈等资源的统一搜索与索引。',
  },
  {
    id: 'tasks',
    label: '待办日程',
    group: 'data',
    description: '待办列表、状态更新与从聊天中提取待办。',
  },
  {
    id: 'task-center',
    label: '任务信息与自动触发',
    group: 'data',
    description: '关键词任务、自动化厂商、触发记录与回调。',
  },
  {
    id: 'message-list',
    label: '消息列表与投递',
    group: 'data',
    description: '消息列表、投递记录、消息回调与失败重发。',
  },
  {
    id: 'operation-log',
    label: '操作日志',
    group: 'data',
    description: '查看本机操作审计记录。',
  },
  {
    id: 'ai-ask',
    label: '智能问答',
    group: 'ai',
    description: '微信问答、推荐回复、知识库检索与向量索引。',
  },
  {
    id: 'ai-summary',
    label: '智能总结与摘要',
    group: 'ai',
    description: '每日/周期总结、文件摘要、实体与关联建议。',
  },
  {
    id: 'ai-reply',
    label: '智能自动回复',
    group: 'ai',
    description: '自动回复配置、扫描、消息回调与投递。',
  },
  {
    id: 'message-analysis',
    label: '消息分析',
    group: 'ai',
    description: '分析单条消息的意图、氛围与应对方式；群聊额外判断是否针对你、该不该接话。',
  },
  {
    id: 'voice-transcribe',
    label: '语音转写',
    group: 'ai',
    description: '本地语音识别、模型下载与批量转写。',
  },
  {
    id: 'image-ocr',
    label: '图片文字识别',
    group: 'ai',
    direct: true,
    description: '使用微信原生识别能力提取图片中的文字。',
  },
  {
    id: 'image-ai',
    label: '图片智能理解',
    group: 'ai',
    direct: true,
    description: '把图片交给已配置的视觉模型生成结构化结果。',
  },
  {
    id: 'export',
    label: '数据导出',
    group: 'tools',
    description: '导出会话、朋友圈、收藏、文件与年度报告。',
  },
  {
    id: 'backup',
    label: '备份恢复',
    group: 'tools',
    description: '创建、预览、恢复与删除本机备份。',
  },
  {
    id: 'privacy-audit',
    label: '隐私体检',
    group: 'tools',
    description: '隐私扫描、风险提示与审计记录。',
  },
  {
    id: 'maintenance',
    label: '数据健康与修复',
    group: 'tools',
    description: '数据库体检、损坏修复、原图升级与自动下载。',
  },
  {
    id: 'apps-superlanguage',
    label: '应用托管实例',
    group: 'apps',
    direct: true,
    description: '允许 Super Time 授权、部署与管理 SuperLanguage 实例；实例数由席位数决定。',
  },
]

const KNOWN_FEATURES = FEATURE_CATALOG.map((feature) => feature.id)
const FEATURE_BY_ID = Object.fromEntries(FEATURE_CATALOG.map((feature) => [feature.id, feature]))
const FEATURE_LABELS = Object.fromEntries(FEATURE_CATALOG.map((feature) => [feature.id, feature.label]))

/** 新目录中新增的细粒度功能；旧许可证的基础位仍按旧行为兼容。 */
const GRANULAR_FEATURES = new Set(
  FEATURE_CATALOG
    .filter((feature) => ![
      'wechat-data', 'ai-ask', 'ai-summary', 'export', 'backup', 'privacy-audit', 'voice-transcribe',
      // 2026-11-24：应用托管是**新增的付费能力**，不属于「新增数据模块」。
      // 放进 GRANULAR_FEATURES 会让 featureSchemaVersion≠2 的旧证直接白拿 —— 必须排除。
      'apps-superlanguage',
    ].includes(feature.id))
    .map((feature) => feature.id),
)

/** 签发台/设置页使用的中文名称；未知 ID 原样返回，便于排查。 */
function featureLabel(id) {
  return FEATURE_LABELS[String(id)] || String(id)
}

function isKnownFeature(id) {
  return Object.prototype.hasOwnProperty.call(FEATURE_BY_ID, String(id))
}

module.exports = {
  FEATURE_SCHEMA_VERSION,
  REQUIRED_FEATURES,
  FEATURE_GROUPS,
  FEATURE_CATALOG,
  FEATURE_BY_ID,
  FEATURE_LABELS,
  GRANULAR_FEATURES,
  KNOWN_FEATURES,
  APP_CAPABILITIES,
  DEFAULT_APP_CAPABILITIES,
  DEFAULT_APP_MAX_JOBS_PER_HOUR,
  featureLabel,
  isKnownFeature,
}
