/**
 * 消息记录详情抽屉的纯展示模型。
 *
 * 抽屉必须只读：这里的映射只使用记录里已经落库的字段，不发起任何 Remote 调用。
 * 时间一律走 `timeText`（空值显示「—」），失败文案复用列表的同一份分层口径，
 * 避免列表与详情对同一条记录给出不同结论。
 */
import type { MessageListImage, MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  SOURCE_LABEL,
  messageListFailureCopy,
  messageListRecordStatusHint,
  messageListRecordStatusLabel,
  timeText,
  type MessageListFailureCopy,
} from './message-list-view.ts'

export interface MessageListDetailTime {
  label: string
  value: string
}

export interface MessageListDetailId {
  label: string
  value: string
}

export interface MessageListDetailJob {
  id: string
  state: string
}

/**
 * 这条记录投递时会不会 @ 人、@ 谁。
 *
 * 权威规则在后端 `query/ai-reply/queue-plan.ts`（私聊不 @；群聊只有批次首条
 * @ 提问者）。前端这里只做**展示推导**，字段口径与后端一致；私聊不显示该行
 * （没有 @ 语义，显示「不 @」只会增加噪音）。
 */
export interface MessageListDetailMention {
  /** `@张三` 或 `不 @`。 */
  text: string
  /** 一句原因；空串表示无需解释（正常点名）。 */
  hint: string
}

/**
 * 分段信息：当前段号 / 组内总段数 / 本段正文字符数。
 *
 * 记录契约里只有 `segmentIndex` 与 `segmentCount`，没有整组字数；`total` 因此
 * 明确只表示**本段**正文长度，用于详情抽屉里的「本段 N 字」提示。
 */
export interface MessageListDetailSegments {
  index: number
  count: number
  total: number
}

export interface MessageListDetailModel {
  title: string
  /** 副标题：来源（AI回复 / 手动 / Webhook …）。 */
  sourceLabel: string
  statusLabel: string
  statusHint: string
  showFailure: boolean
  failure: MessageListFailureCopy
  times: MessageListDetailTime[]
  text: string
  images: MessageListImage[]
  ids: MessageListDetailId[]
  /** 原始来源引用，供「复制 sourceRef」使用；空串表示没有。 */
  sourceRef: string
  job?: MessageListDetailJob
  segments?: MessageListDetailSegments
  mention?: MessageListDetailMention
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function textOrDash(value: string): string {
  return value.trim() === '' ? '—' : value
}

/**
 * 推导这条记录投递时会不会 @ 人。
 *
 * 只对群聊给结果：私聊没有 @ 语义，返回 undefined 让界面整行不显示。
 * @param record - 消息记录。
 * @returns `@成员` / `不 @` + 原因；私聊为 undefined。
 */
function mentionOfDetail(record: MessageListRecord): MessageListDetailMention | undefined {
  if (!record.chatUsername.trim().endsWith('@chatroom')) return undefined
  const target = record.targetName.trim()
  if (target === '' || target === record.chatName.trim()) {
    return { text: '不 @', hint: '未解析到提问者，按普通群消息发送' }
  }
  const index = Number(record.segmentIndex ?? 0)
  if (Number.isSafeInteger(index) && index > 1) {
    return { text: '不 @', hint: '同一批次的后续消息，只由首条点名提问者' }
  }
  return { text: '@' + target, hint: '' }
}

/**
 * 把一条记录映射成只读展示模型。
 * @param record - 消息记录。
 * @param now - 生成/停滞判定基准，测试可固定。
 * @returns 详情抽屉所需的全部展示字段。
 */
export function messageListDetailModel(
  record: MessageListRecord,
  now = Date.now(),
): MessageListDetailModel {
  const sourceRef = record.sourceRef?.trim() ?? ''
  const segmentIndex = positiveInt(record.segmentIndex)
  const segmentCount = positiveInt(record.segmentCount)
  const jobId = record.jobId?.trim() ?? ''
  const jobState = record.jobState?.trim() ?? ''
  const segments = segmentIndex === undefined && segmentCount === undefined
    ? undefined
    : {
      index: segmentIndex ?? 1,
      // 脏数据里段号可能大于总段数；展示层夹紧，避免「第 5/3 段」。
      count: Math.max(segmentCount ?? 1, segmentIndex ?? 1),
      total: record.text.length,
    }
  const mention = mentionOfDetail(record)
  return {
    title: '记录 #' + String(record.id),
    sourceLabel: SOURCE_LABEL[record.source],
    statusLabel: messageListRecordStatusLabel(record, now),
    statusHint: messageListRecordStatusHint(record, now),
    showFailure: record.status === 'failed'
      || record.status === 'sent_unconfirmed'
      || record.error.trim() !== ''
      || (record.failureKind ?? '') !== '',
    failure: messageListFailureCopy(record),
    times: [
      { label: '创建时间', value: timeText(record.createdAt) },
      { label: '触发时间', value: timeText(record.triggeredAt) },
      { label: '最近变更', value: timeText(record.updatedAt) },
      { label: '最近尝试', value: timeText(record.lastAttemptAt ?? 0) },
      { label: '任务查询', value: timeText(record.jobCheckedAt ?? 0) },
    ],
    text: record.text,
    images: record.images,
    ids: [
      { label: '记录 ID', value: String(record.id) },
      { label: '回复 ID', value: textOrDash(record.replyId) },
      { label: '来源引用', value: textOrDash(sourceRef) },
    ],
    sourceRef,
    ...(jobId === '' && jobState === ''
      ? {}
      : { job: { id: textOrDash(jobId), state: textOrDash(jobState) } }),
    ...(segments === undefined ? {} : { segments }),
    ...(mention === undefined ? {} : { mention }),
  }
}
