/**
 * 客户画像与标签的本机推导层。
 *
 * 这里只做纯函数计算：不请求数据、不读 DOM，也不引入模型推断。首版画像只汇总
 * 联系人资料与 `Contact360Snapshot` 中已经存在的事实，并为每个标签附带可核验的
 * 依据。这样页面、单聊抽屉和群成员抽屉可以共用同一套标签口径，也不会把
 * 「高意向」「高价值」这类没有数据支撑的结论伪装成画像。
 *
 * @module panels/customer-profile
 */
import type { Contact360Snapshot, WechatContact } from '@deepseek-ai/dsh-wechat-data/types'

/** 可作为客户目录来源的联系人分类。 */
export const CUSTOMER_CATEGORY_KEYS = ['friend', 'enterprise', 'member'] as const

export type CustomerCategory = (typeof CUSTOMER_CATEGORY_KEYS)[number]

/** 客户关系标签。`session` 用于无法读取通讯录分类的单聊会话。 */
export type CustomerRelation = 'contact' | 'enterprise' | 'member' | 'group-owner' | 'self' | 'session'

export type CustomerTagCategory = '关系' | '活跃' | '互动' | '商业事实' | '社交' | '数据质量'

/** 标签分类在页面上的固定顺序。 */
export const CUSTOMER_TAG_CATEGORIES: readonly CustomerTagCategory[] = [
  '关系', '活跃', '互动', '商业事实', '社交', '数据质量',
]

export const CUSTOMER_RELATION_LABELS: Readonly<Record<CustomerRelation, string>> = {
  contact: '联系人',
  enterprise: '企业微信',
  member: '群成员',
  'group-owner': '群主',
  self: '本人',
  session: '单聊联系人',
}

/** 页面和共享抽屉使用的最小身份字段。 */
export interface CustomerIdentity {
  username: string
  displayName: string
  nickName?: string
  remark?: string
  alias?: string
  description?: string
  category?: string
  categories?: readonly string[]
  avatarUrl?: string
  /** 企业微信联系人的企业名称。 */
  enterpriseName?: string
  groupName?: string
  groupUsernames?: readonly string[]
}

/** 目录项：保留原始联系人字段，并记录合并后的全部来源分类。 */
export interface CustomerRecord extends WechatContact {
  categories: CustomerCategory[]
}

/** 调用场景与可选的会话内身份。 */
export interface CustomerProfileContext {
  /** 当前时间（epoch 秒）；测试传固定值，线上默认取当前时间。 */
  nowSec?: number
  /** 群成员表里的本人标记。 */
  isSelf?: boolean
  /** 当前成员与群主 username 一致。 */
  isGroupOwner?: boolean
  /** 入口来源，用于无通讯录分类时给出诚实的关系说明。 */
  source?: 'directory' | 'session' | 'group-member'
}

/** 一个可展示、可核验的客户标签。 */
export interface CustomerTag {
  code: string
  label: string
  category: CustomerTagCategory
  evidence: string
  confidence: 'high' | 'medium' | 'low'
  source: 'local-rule'
}

/** 互动活跃度分档。 */
export interface CustomerActivity {
  code: 'active-7d' | 'active-30d' | 'inactive-30d' | 'inactive-90d' | 'none'
  label: string
  evidence: string
  days: number | null
}

const DAY_SECONDS = 24 * 60 * 60
const CATEGORY_PRIORITY: Readonly<Record<CustomerCategory, number>> = {
  friend: 0,
  enterprise: 1,
  member: 2,
}

function asCustomerCategory(category: string | undefined): CustomerCategory | null {
  return CUSTOMER_CATEGORY_KEYS.find((key) => key === category) ?? null
}

/** 是否应出现在客户目录里。群、公众号、服务号、系统号和已删除项都不是客户。 */
export function isCustomerCandidate(contact: WechatContact): boolean {
  const username = contact.username.trim()
  const category = asCustomerCategory(contact.category)
  if (username === '' || category === null) return false
  if (username.endsWith('@chatroom') || username.startsWith('gh_')) return false
  return true
}

const INVISIBLE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

/** 清洗微信资料里常见的控制字符/零宽字符；纯符号资料不能顶替可读姓名。 */
export function cleanCustomerText(value: string | undefined): string {
  return String(value ?? '')
    .replace(INVISIBLE_TEXT, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function nonEmpty(value: string | undefined): string | undefined {
  const text = cleanCustomerText(value)
  return text === '' ? undefined : text
}

/**
 * 合并三个分页/分类结果，并按 username 去重。
 *
 * 同一个人可能既是好友又是群成员。合并后保留更具体的关系优先级，同时把分类与
 * 所属群都保留下来，避免目录里出现两个同名同 ID 的重复客户。
 */
export function mergeCustomerCandidates(batches: ReadonlyArray<ReadonlyArray<WechatContact>>): CustomerRecord[] {
  const byUsername = new Map<string, CustomerRecord>()
  for (const batch of batches) {
    for (const contact of batch) {
      if (!isCustomerCandidate(contact)) continue
      const category = asCustomerCategory(contact.category)
      if (category === null) continue
      const username = contact.username.trim()
      const prev = byUsername.get(username)
      if (!prev) {
        const displayName = nonEmpty(contact.displayName)
          ?? nonEmpty(contact.remark)
          ?? nonEmpty(contact.nickName)
          ?? username
        byUsername.set(username, {
          ...contact,
          username,
          displayName,
          nickName: nonEmpty(contact.nickName) ?? '',
          remark: nonEmpty(contact.remark) ?? '',
          alias: nonEmpty(contact.alias),
          description: nonEmpty(contact.description),
          avatarUrl: nonEmpty(contact.avatarUrl),
          groupName: nonEmpty(contact.groupName),
          categories: [category],
          ...(contact.groupUsernames ? { groupUsernames: [...new Set(contact.groupUsernames)] } : {}),
        })
        continue
      }
      const categories = [...new Set([...prev.categories, category])]
        .sort((a, b) => CATEGORY_PRIORITY[a] - CATEGORY_PRIORITY[b])
      const groupUsernames = [...new Set([...(prev.groupUsernames ?? []), ...(contact.groupUsernames ?? [])])]
      byUsername.set(username, {
        ...prev,
        ...contact,
        username,
        category: categories[0] ?? prev.category,
        displayName: nonEmpty(prev.displayName) ?? nonEmpty(contact.displayName) ?? username,
        nickName: nonEmpty(prev.nickName) ?? nonEmpty(contact.nickName) ?? '',
        remark: nonEmpty(prev.remark) ?? nonEmpty(contact.remark) ?? '',
        alias: nonEmpty(prev.alias) ?? nonEmpty(contact.alias),
        description: nonEmpty(prev.description) ?? nonEmpty(contact.description),
        avatarUrl: nonEmpty(prev.avatarUrl) ?? nonEmpty(contact.avatarUrl),
        enterpriseName: nonEmpty(prev.enterpriseName) ?? nonEmpty(contact.enterpriseName),
        groupName: nonEmpty(prev.groupName) ?? nonEmpty(contact.groupName),
        groupUsernames: groupUsernames.length > 0 ? groupUsernames : prev.groupUsernames,
        categories,
      })
    }
  }
  return [...byUsername.values()].sort((a, b) => {
    return (a.displayName || a.username).localeCompare(b.displayName || b.username, 'zh-Hans-CN')
  })
}

/** 把目录项转成共享视图所需的最小身份对象。 */
export function customerIdentityOf(record: CustomerRecord): CustomerIdentity {
  return {
    username: record.username,
    displayName: nonEmpty(record.displayName)
      ?? nonEmpty(record.remark)
      ?? nonEmpty(record.nickName)
      ?? record.username,
    nickName: nonEmpty(record.nickName),
    remark: nonEmpty(record.remark),
    alias: nonEmpty(record.alias),
    description: nonEmpty(record.description),
    category: record.category,
    categories: record.categories,
    avatarUrl: nonEmpty(record.avatarUrl),
    enterpriseName: nonEmpty(record.enterpriseName),
    groupName: nonEmpty(record.groupName),
    groupUsernames: record.groupUsernames,
  }
}

/** 客户展示名：备注/昵称优先的回退链已由 displayName 承担，这里只兜空值。 */
export function customerDisplayName(identity: CustomerIdentity): string {
  return nonEmpty(identity.displayName)
    ?? nonEmpty(identity.remark)
    ?? nonEmpty(identity.nickName)
    ?? nonEmpty(identity.alias)
    ?? identity.username
}

function categoriesOf(identity: CustomerIdentity): CustomerCategory[] {
  const fromList = (identity.categories ?? []).map(asCustomerCategory).filter((v): v is CustomerCategory => v !== null)
  const single = asCustomerCategory(identity.category)
  return [...new Set(single !== null ? [single, ...fromList] : fromList)]
}

/** 关系标签的判定顺序：本人 > 群主 > 好友 > 企业微信 > 群成员 > 单聊兜底。 */
export function customerRelation(identity: CustomerIdentity, context: CustomerProfileContext = {}): CustomerRelation {
  if (context.isSelf === true) return 'self'
  if (context.isGroupOwner === true) return 'group-owner'
  const categories = categoriesOf(identity)
  if (categories.includes('friend')) return 'contact'
  if (categories.includes('enterprise')) return 'enterprise'
  if (categories.includes('member')) return 'member'
  return context.source === 'group-member' ? 'member' : 'session'
}

function relationEvidence(relation: CustomerRelation): string {
  switch (relation) {
    case 'self': return '群成员表中该成员被标记为“本人”。'
    case 'group-owner': return '群信息中的群主 username 与该成员一致。'
    case 'contact': return '通讯录分类为“联系人”。'
    case 'enterprise': return '通讯录分类为“企业微信联系人”。'
    case 'member': return '通讯录或群成员表显示该用户属于群成员。'
    case 'session': return '该用户来自当前单聊会话；未读取到更细的通讯录分类。'
  }
}

/**
 * 近况分档。边界按“包含端点”处理：恰好 7/30/90 天仍落在较活跃的一档，
 * 超过一天才进入下一档，避免日期取整导致刚满 7 天被误写成“30 天未联系”。
 */
export function customerActivity(snapshot: Contact360Snapshot | null, context: CustomerProfileContext = {}): CustomerActivity {
  const lastTime = snapshot?.messages.lastTime ?? null
  if (snapshot === null || snapshot.messages.count <= 0 || lastTime === null || lastTime <= 0) {
    return { code: 'none', label: '暂无聊天记录', evidence: '本机消息库中尚未找到该用户的聊天记录。', days: null }
  }
  const nowSec = context.nowSec ?? Math.floor(Date.now() / 1000)
  const days = Math.max(0, Math.floor((nowSec - lastTime) / DAY_SECONDS))
  const age = Math.max(0, nowSec - lastTime)
  if (age <= 7 * DAY_SECONDS) {
    return { code: 'active-7d', label: '近 7 天活跃', evidence: `最近一条消息距现在 ${days} 天。`, days }
  }
  if (age <= 30 * DAY_SECONDS) {
    return { code: 'active-30d', label: '近 30 天活跃', evidence: `最近一条消息距现在 ${days} 天。`, days }
  }
  if (age <= 90 * DAY_SECONDS) {
    return { code: 'inactive-30d', label: '30 天未联系', evidence: `最近一条消息距现在 ${days} 天。`, days }
  }
  return { code: 'inactive-90d', label: '90 天未联系', evidence: `最近一条消息距现在 ${days} 天。`, days }
}

function relationTag(identity: CustomerIdentity, context: CustomerProfileContext): CustomerTag {
  const relation = customerRelation(identity, context)
  return {
    code: `relation-${relation}`,
    label: CUSTOMER_RELATION_LABELS[relation],
    category: '关系',
    evidence: relationEvidence(relation),
    confidence: 'high',
    source: 'local-rule',
  }
}

/**
 * 由联系人身份与 360 快照生成本机规则标签。
 *
 * 每条标签都要求 evidence 非空；数据不足时宁可输出“样本较少/暂无聊天记录”，
 * 也不输出商业意向、消费能力等无法从本机数据证明的判断。
 */
export function buildCustomerTags(
  identity: CustomerIdentity,
  snapshot: Contact360Snapshot | null,
  context: CustomerProfileContext = {},
): CustomerTag[] {
  const tags: CustomerTag[] = [relationTag(identity, context)]
  if (snapshot === null) return tags

  const activity = customerActivity(snapshot, context)
  if (activity.code !== 'none') {
    tags.push({
      code: activity.code,
      label: activity.label,
      category: '活跃',
      evidence: activity.evidence,
      confidence: 'high',
      source: 'local-rule',
    })
  }

  const messageCount = snapshot.messages.count
  if (messageCount >= 500) {
    tags.push({
      code: 'high-frequency',
      label: '高频沟通',
      category: '互动',
      evidence: `本机累计 ${messageCount.toLocaleString()} 条聊天记录（达到 500 条阈值）。`,
      confidence: 'high',
      source: 'local-rule',
    })
  } else if (messageCount >= 20) {
    tags.push({
      code: 'sustained-chat',
      label: '有持续聊天记录',
      category: '互动',
      evidence: `本机累计 ${messageCount.toLocaleString()} 条聊天记录（达到 20 条阈值）。`,
      confidence: 'high',
      source: 'local-rule',
    })
  }

  if (snapshot.funds.transfers > 0) {
    tags.push({
      code: 'has-transfer',
      label: '有转账往来',
      category: '商业事实',
      evidence: `本机资金库记录到 ${snapshot.funds.transfers.toLocaleString()} 次转账。`,
      confidence: 'high',
      source: 'local-rule',
    })
  }
  if (snapshot.funds.redpackets > 0) {
    tags.push({
      code: 'has-redpacket',
      label: '有红包往来',
      category: '商业事实',
      evidence: `本机资金库记录到 ${snapshot.funds.redpackets.toLocaleString()} 次红包往来。`,
      confidence: 'high',
      source: 'local-rule',
    })
  }

  if (snapshot.commonGroups.length > 0) {
    tags.push({
      code: 'has-common-group',
      label: '有共同群',
      category: '社交',
      evidence: `联系人与本机账号共同出现在 ${snapshot.commonGroups.length.toLocaleString()} 个群中。`,
      confidence: 'high',
      source: 'local-rule',
    })
  }
  if (snapshot.commonGroups.length > 1) {
    tags.push({
      code: 'multi-group-overlap',
      label: '多群交集',
      category: '社交',
      evidence: `双方共同位于 ${snapshot.commonGroups.length.toLocaleString()} 个群，交集大于一个群。`,
      confidence: 'high',
      source: 'local-rule',
    })
  }
  if (snapshot.moments.count > 0) {
    tags.push({
      code: 'has-moments',
      label: '朋友圈有内容',
      category: '社交',
      evidence: `本机朋友圈库记录到该用户 ${snapshot.moments.count.toLocaleString()} 条内容。`,
      confidence: 'high',
      source: 'local-rule',
    })
  }

  if (messageCount === 0) {
    tags.push({
      code: 'no-chat-history',
      label: '暂无聊天记录',
      category: '数据质量',
      evidence: '本机消息库中未找到与对方的一对一聊天记录。',
      confidence: 'high',
      source: 'local-rule',
    })
  } else if (messageCount < 20) {
    tags.push({
      code: 'small-sample',
      label: '样本较少',
      category: '数据质量',
      evidence: `本机仅有 ${messageCount.toLocaleString()} 条聊天记录，暂不足以形成稳定的互动结论。`,
      confidence: 'medium',
      source: 'local-rule',
    })
  }

  return tags
}

/** 中文展示的置信度。 */
export function confidenceLabel(confidence: CustomerTag['confidence']): string {
  if (confidence === 'high') return '高'
  if (confidence === 'medium') return '中'
  return '低'
}
