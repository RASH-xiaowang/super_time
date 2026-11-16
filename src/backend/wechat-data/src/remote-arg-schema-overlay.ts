/**
 * 生成器缺口的**源码侧参数 schema 覆盖层**。
 *
 * `lib/typert.host.js` 由仓库外的 `@deepseek-ai/dsh-typert-generator` 生成，
 * 新 `@Remote` 方法偶尔会先落源码、后补生成物。直接手改 `lib/**` 会让生成物
 * 失去可重建性，因此这里只登记这些方法的**调用参数**形状，由宿主在加载生成表后
 * 合并。结果形状不进这里：当前入参守卫只执行 `parameters[*].codec.schema`。
 *
 * 登记条件：
 * - 方法已存在真实 `@Remote` 声明；
 * - 生成表里没有该方法；
 * - 参数 schema 与 `gateway-*.ts` 的签名逐字段一致。
 *
 * 生成器补上同名方法后，宿主最后一次合并生成表，同名条目以生成物为准；
 * 届时可删除这里的对应条目。
 */
import { z } from 'zod'

/** 与 Typert 调用表同形的最小参数部分（只保留守卫真正读取的字段）。 */
export interface RemoteArgSchemaOverlayEntry {
  method: string
  parameters: Array<{
    codec: {
      mode: 'strict'
      schema: unknown
    }
  }>
}

/** 只描述一个位置参数，降低大表里重复 codec 外壳的噪声。 */
function one(schema: unknown): RemoteArgSchemaOverlayEntry['parameters'] {
  return [{ codec: { mode: 'strict', schema } }]
}

function remote(method: string, schema?: unknown): RemoteArgSchemaOverlayEntry {
  return { method, parameters: schema === undefined ? [] : one(schema) }
}

const CHAT_AI_REPLY_PROVIDERS = ['dsh-wechat-bridge', 'custom-webhook'] as const
const MESSAGE_LIST_STATUSES = [
  'success', 'failed', 'pending', 'dispatching', 'queued', 'running', 'sent_unconfirmed', '',
] as const
const MESSAGE_LIST_SOURCES = ['first_trigger', 'webhook', 'manual', 'ai_reply', ''] as const

const messageListImageSchema = z.object({
  localId: z.number().optional(),
  createTime: z.number().optional(),
  sender: z.string().optional(),
  md5: z.string().optional(),
  url: z.string().optional(),
  dataUrl: z.string().optional(),
  name: z.string().optional(),
  stagedId: z.string().optional(),
  size: z.number().optional(),
  mime: z.string().optional(),
})

/**
 * 生成表缺口（2026-10-30）。
 *
 * 这些方法都已有真实 `@Remote` 声明，但不在 `typert.host.js` 的 invocation 表中。
 * 2026-10-22 先补齐了四个历史缺口；2026-10-30 又把 AI 回复与消息列表
 * 新增的方法面登记进来，确保它们参与入参形状影子校验，而不是
 * 通过抬高未覆盖上限来“通过”门禁。
 */
export const REMOTE_ARG_SCHEMA_OVERLAY: readonly RemoteArgSchemaOverlayEntry[] = [
  remote('getSelfProfile'),
  remote('listRpaVendors'),
  remote('getFileImageDataUrls', z.object({
    keys: z.array(z.string()),
    thumbFirst: z.boolean().optional(),
  })),
  remote('revealTaskTriggerSecret', z.object({
    id: z.number(),
  })),

  // 单资源原图导出：目标路径与媒体定位字段必须和网关签名一致。
  remote('exportSnsVideo', z.object({
    md5: z.string().optional(),
    timelineId: z.string().optional(),
    mediaId: z.string().optional(),
    url: z.string().optional(),
    key: z.string().optional(),
    dest: z.string(),
  })),
  remote('exportSnsImage', z.object({
    md5: z.string(),
    timelineId: z.string().optional(),
    mediaId: z.string().optional(),
    url: z.string().optional(),
    token: z.string().optional(),
    seed: z.string().optional(),
    key: z.string().optional(),
    originalWidth: z.number().optional(),
    originalHeight: z.number().optional(),
    originalBytes: z.number().optional(),
    uhdUrl: z.string().optional(),
    uhdToken: z.string().optional(),
    uhdSeed: z.string().optional(),
    dest: z.string(),
  })),
  remote('exportChatImage', z.object({
    username: z.string(),
    localId: z.number(),
    dest: z.string(),
  })),
  remote('exportChatVideo', z.object({
    username: z.string(),
    localId: z.number(),
    dest: z.string(),
  })),
  remote('exportChatFile', z.object({
    username: z.string(),
    localId: z.number(),
    dest: z.string(),
  })),
  remote('exportFileImage', z.object({
    md5: z.string(),
    dest: z.string(),
  })),
  remote('exportFileVideo', z.object({
    md5: z.string(),
    dest: z.string(),
  })),
  remote('exportFileAttachment', z.object({
    fileName: z.string(),
    size: z.number().optional(),
    createTime: z.number().optional(),
    md5: z.string().optional(),
    dest: z.string(),
  })),
  remote('exportFavoriteImage', z.object({
    fullMd5: z.string().optional(),
    md5: z.string().optional(),
    thumbMd5: z.string().optional(),
    kind: z.literal('image').optional(),
    dest: z.string(),
  })),
  remote('exportFavoriteVideo', z.object({
    fullMd5: z.string().optional(),
    md5: z.string().optional(),
    thumbMd5: z.string().optional(),
    kind: z.literal('video').optional(),
    dest: z.string(),
  })),
  remote('exportFavoriteFile', z.object({
    fullMd5: z.string().optional(),
    md5: z.string().optional(),
    thumbMd5: z.string().optional(),
    kind: z.literal('file').optional(),
    dest: z.string(),
  })),

  // 会话级 AI 回复：读取状态、默认 Webhook、开关、人格与立即扫描。
  remote('getChatAiReplyState', z.object({
    chatUsername: z.string(),
    chatName: z.string().optional(),
  })),
  remote('getChatAiReplyDefaultWebhook', z.object({
    chatUsername: z.string(),
    chatName: z.string().optional(),
  })),
  remote('saveChatAiReplyDefaultWebhook', z.object({
    chatUsername: z.string(),
    chatName: z.string().optional(),
    webhookUrl: z.string(),
  })),
  remote('listEnabledChatAiReplyStates'),
  remote('setChatAiReplyEnabled', z.object({
    chatUsername: z.string(),
    chatName: z.string().optional(),
    enabled: z.boolean(),
    provider: z.enum(CHAT_AI_REPLY_PROVIDERS).optional(),
    expectedRevision: z.number().optional(),
  })),
  remote('setChatAiReplyPersona', z.object({
    chatUsername: z.string(),
    chatName: z.string().optional(),
    personaName: z.string(),
    personaPrompt: z.string(),
    splitReply: z.boolean().optional(),
    expectedRevision: z.number().optional(),
  })),
  remote('scanChatAiReplyNow'),

  // 消息列表：查询、规则、手动写入、附件暂存与投递诊断。
  remote('listMessageListRecords', z.union([
    z.undefined(),
    z.object({
      search: z.string().optional(),
      status: z.enum(MESSAGE_LIST_STATUSES).optional(),
      source: z.enum(MESSAGE_LIST_SOURCES).optional(),
      ids: z.array(z.number()).optional(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
    }),
  ])),
  remote('listMessageListRules'),
  remote('saveMessageListRule', z.object({
    id: z.number().optional(),
    chatName: z.string().optional(),
    targetName: z.string().optional(),
    webhookUrl: z.string(),
    greetingText: z.string().optional(),
    note: z.string().optional(),
    enabled: z.boolean().optional(),
  })),
  remote('deleteMessageListRule', z.object({
    id: z.number(),
  })),
  remote('insertMessageListRecord', z.object({
    replyId: z.string().optional(),
    chatName: z.string().optional(),
    targetName: z.string(),
    text: z.string(),
    images: z.array(messageListImageSchema).optional(),
    note: z.string().optional(),
    chatUsername: z.string().optional(),
    targetUsername: z.string().optional(),
    triggeredAt: z.number().optional(),
  })),
  remote('stageMessageListAttachment', z.object({
    path: z.string(),
  })),
  remote('resendMessageListRecord', z.object({
    id: z.number(),
  })),
  remote('batchResendMessageListRecords', z.object({
    ids: z.array(z.number()),
  })),
  remote('batchDeleteMessageListRecords', z.object({
    ids: z.array(z.number()),
  })),
  remote('ingestMessageListWebhook', z.object({
    target: z.string().optional(),
    targetName: z.string().optional(),
    chat: z.string().optional(),
    mention: z.string().optional(),
    message: z.string().optional(),
    content: z.string().optional(),
    text: z.string().optional(),
    chatName: z.string().optional(),
    conversationName: z.string().optional(),
    idempotencyKey: z.string().optional(),
    sourceRef: z.string().optional(),
    replyId: z.string().optional(),
    note: z.string().optional(),
    attachments: z.unknown().optional(),
    images: z.unknown().optional(),
    triggeredAt: z.number().optional(),
    chatUsername: z.string().optional(),
    targetUsername: z.string().optional(),
  })),
  remote('getMessageListWebhookInfo'),
  remote('probeMessageListWebhook', z.object({
    recordId: z.number().optional(),
    ruleId: z.number().optional(),
  })),
  remote('queryMessageListWebhookJob', z.object({
    recordId: z.number(),
    jobId: z.string().optional(),
  })),
]
