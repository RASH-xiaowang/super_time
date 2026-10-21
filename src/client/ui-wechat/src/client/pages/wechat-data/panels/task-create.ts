/**
 * 「新建任务」弹窗的**纯逻辑**（2026-10-19）。
 *
 * 与 `task-create-dialog.tsx` 的分工照本仓面板目录的约定：能脱开 DOM 判对错的规则住这里，
 * 渲染只管画。.ts 里不 import React —— 这一族规则（关键词去重、数量/长度夹取、群聊必须选
 * 目标用户、照片档位、默认任务名、成员列表截断）**画错了不会报错**，只有单测能钉住。
 *
 * 三条与后端有关的边界（与 `types-taskcenter.ts` 的注释同源）：
 *  · 关键词「任一命中即触发」⇒ 去重按**大小写不敏感**，但保留用户输入的原样大小写；
 *  · 触发对象：单聊 = 会话对象本身，群聊 = 群内被监听的那个成员（未选不许提交）；
 *  · 照片数量是「触发时取该对象最近 N 张」，不是创建时快照 —— 所以它只是一档配置。
 */
import type { GroupMember, TaskInfoInput } from '@deepseek-ai/dsh-wechat-data/types'

/** 触发关键词个数上限（与后端 `task_info.keywords` 的校验口径对齐）。 */
export const KEYWORD_MAX_COUNT = 20
/** 单个触发关键词的最大字符数。 */
export const KEYWORD_MAX_LEN = 64
/** 触发时携带的照片数量下限（0 = 只带文本，不带图片）。 */
export const PHOTO_LIMIT_MIN = 0
/** 照片数量上限（与后端 `PHOTO_LIMIT_MAX` 一致：再大只会拖慢扫描与回调体积）。 */
export const PHOTO_LIMIT_MAX = 9
/** 默认数量：3 张（最常用的「带点上下文」档）。 */
export const DEFAULT_PHOTO_LIMIT = 3
/** 群成员一次最多画多少行（千人群一次画完会卡住整屏）。 */
export const MEMBER_RENDER_LIMIT = 50
/** 成员数超过这个值、且没有搜索词时，提示用户用搜索缩小范围。 */
export const MEMBER_FILTER_THRESHOLD = 200
/** 群聊未选目标用户时的提示语（弹窗与校验共用一份，避免两处文案漂移）。 */
export const GROUP_TARGET_REQUIRED = '群聊需选择目标用户'

/**
 * 弹窗只需要的会话字段。
 *
 * 为什么不直接用 `WechatSession`：群信息抽屉手里只有 `GroupInfo`（username/name），
 * 没有整条会话；而这三项恰好是弹窗真正用到的全部。`WechatSession` 结构上包含它们，
 * 所以聊天头部/单聊抽屉可以直接把整条会话传进来，不需要为弹窗造一条假会话。
 */
export interface TaskCreateSession {
  username: string
  displayName: string
  type: 'private' | 'group'
}

/** 弹窗表单态（受控）。 */
export interface TaskCreateForm {
  /** 已确认的关键词（回车/逗号/失焦不提交，只认显式添加）。 */
  keywords: string[]
  /** 输入框里的草稿；点「创建任务」时若有残留也会并进去。 */
  keywordDraft: string
  /** 携带照片数量（0..{@link PHOTO_LIMIT_MAX}，可在表单里直接输入）。 */
  photoLimit: number
  /** 群聊是否只匹配结构化 @ 登录账号的消息；单聊不展示该选项。 */
  mentionMeOnly: boolean
  /** 任务名（空 = 自动生成，提交时补默认名）。 */
  name: string
  /** 群聊所选目标成员；单聊保持空串（提交时回填成会话对象）。 */
  targetUsername: string
  /** 目标成员显示名（点击成员时一起存，避免提交时再去列表里翻）。 */
  targetName: string
}

/**
 * 表单初值。
 * @returns 空关键词、默认照片档位、不限制 @、空任务名、未选目标。
 */
export function initialTaskCreateForm(): TaskCreateForm {
  return {
    keywords: [],
    keywordDraft: '',
    photoLimit: DEFAULT_PHOTO_LIMIT,
    mentionMeOnly: false,
    name: '',
    targetUsername: '',
    targetName: '',
  }
}

/**
 * 把一段输入切成候选关键词：按中英文逗号与换行切，去首尾空白，丢掉空片段。
 *
 * 支持换行是为了**粘贴一整列关键词**：用户从备忘录里贴「报价、合同、付款」时，
 * 只认逗号的话会变成一条 64 字上限装不下的长词。粘贴文本里混进的空行也不该变成空 chip。
 * @param raw - 输入框里的原始文本。
 * @returns 按出现顺序排列的候选关键词。
 */
export function parseKeywordInput(raw: string): string[] {
  return raw.split(/[,，\n]/).map((part) => part.trim()).filter((part) => part !== '')
}

/** 一次「添加关键词」的结果：失败时 keywords 原样返回（不做半应用）。 */
export interface KeywordBatchResult {
  ok: boolean
  keywords: string[]
  /** 实际新增了几个（重复项不计）。 */
  added: number
  error?: string
}

/**
 * 批量添加关键词：去重（大小写不敏感）、单条 ≤{@link KEYWORD_MAX_LEN}、
 * 总数 ≤{@link KEYWORD_MAX_COUNT}。**整批原子**——任何一条不合格就整批不落地，
 * 否则用户会看到「一半加进去了、一半没进去」而不知道还差哪一条。
 * @param list - 当前已有关键词。
 * @param raw - 输入框文本（可能含多个，见 {@link parseKeywordInput}）。
 * @returns 新列表与错误（成功时 error 缺省）。
 */
export function addKeywordBatch(list: readonly string[], raw: string): KeywordBatchResult {
  const parts = parseKeywordInput(raw)
  if (parts.length === 0) return { ok: true, keywords: [...list], added: 0 }
  const next = [...list]
  const seen = new Set(next.map((kw) => kw.toLowerCase()))
  let added = 0
  for (const part of parts) {
    if (part.length > KEYWORD_MAX_LEN) {
      return { ok: false, keywords: [...list], added: 0, error: `单个触发关键词不能超过 ${String(KEYWORD_MAX_LEN)} 个字符` }
    }
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    if (next.length >= KEYWORD_MAX_COUNT) {
      return { ok: false, keywords: [...list], added: 0, error: `触发关键词最多 ${String(KEYWORD_MAX_COUNT)} 个` }
    }
    seen.add(key)
    next.push(part)
    added += 1
  }
  return { ok: true, keywords: next, added }
}

/**
 * 删除第 index 个关键词。
 * @param list - 当前关键词。
 * @param index - 目标下标（越界时原样返回，不抛）。
 * @returns 新数组（不修改入参）。
 */
export function removeKeyword(list: readonly string[], index: number): string[] {
  if (index < 0 || index >= list.length) return [...list]
  return list.filter((_, i) => i !== index)
}

/**
 * 某个数是否是可用的照片数量（0..{@link PHOTO_LIMIT_MAX} 的整数）。
 * @param value - 候选值。
 * @returns 合法时为 true。
 */
export function isValidPhotoLimit(value: number): boolean {
  return Number.isInteger(value) && value >= PHOTO_LIMIT_MIN && value <= PHOTO_LIMIT_MAX
}

/**
 * 把输入框里的任意数字收进合法区间（用户直接敲值时不该因为多按一下就把表单卡死）。
 * 非有限数归 0；小数向下取整。
 * @param value - 用户输入或 stepper 给的值。
 * @returns 0..{@link PHOTO_LIMIT_MAX} 的整数。
 */
export function clampPhotoLimit(value: number): number {
  if (!Number.isFinite(value)) return PHOTO_LIMIT_MIN
  return Math.min(PHOTO_LIMIT_MAX, Math.max(PHOTO_LIMIT_MIN, Math.trunc(value)))
}

/**
 * 照片数量的说明（「触发时取该对象最近 N 张图片」）。
 * @param value - 数量。
 * @returns 面向用户的一句话。
 */
export function photoHint(value: number): string {
  return value <= 0
    ? '触发时只带触发文本，不携带图片'
    : `触发时取该对象最近 ${String(value)} 张图片`
}

/**
 * 会话类型的中文名（弹窗右上角徽标用）。
 * @param type - private/group。
 * @returns 中文短标签。
 */
export function chatTypeLabel(type: 'private' | 'group'): string {
  return type === 'group' ? '群聊' : '单聊'
}

/** 默认任务名的输入。 */
export interface DefaultTaskNameOptions {
  chatName: string
  chatType: 'private' | 'group'
  targetName?: string | null
  keywords: readonly string[]
}

/**
 * 自动生成任务名：`会话 · [目标] · 首个关键词`。
 *
 * 为什么带关键词：任务列表里同一会话可以被建多条任务，只写会话名的话两条「张三」分不开。
 * 群聊带上目标成员是同一理由（一个群可以同时监听多个人的不同关键词）。
 * @param options - 会话名/类型/目标/关键词。
 * @returns 非空任务名。
 */
export function defaultTaskName(options: DefaultTaskNameOptions): string {
  const chat = options.chatName.trim() === '' ? '未命名会话' : options.chatName.trim()
  const target = options.chatType === 'group' ? (options.targetName ?? '').trim() : ''
  const subject = target === '' ? chat : `${chat} · ${target}`
  const keyword = (options.keywords[0] ?? '').trim()
  return keyword === '' ? `${subject} 触发任务` : `${subject} · ${keyword}`
}

/** 校验输入（与表单解耦，单测可逐格喂）。 */
export interface TaskCreateValidationInput {
  chatType: 'private' | 'group'
  targetUsername: string
  keywords: readonly string[]
  photoLimit: number
}

/**
 * 提交前校验。返回**第一条**错误文案（UI 一次只显示一行，不需要错误数组）。
 * @param input - 会话类型/目标/关键词/照片档位。
 * @returns 错误文案；可以提交时为 null。
 */
export function validateTaskCreate(input: TaskCreateValidationInput): string | null {
  if (input.chatType === 'group' && input.targetUsername.trim() === '') return GROUP_TARGET_REQUIRED
  if (input.keywords.length === 0) return '请至少填写 1 个触发关键词'
  if (input.keywords.length > KEYWORD_MAX_COUNT) return `触发关键词最多 ${String(KEYWORD_MAX_COUNT)} 个`
  if (input.keywords.some((kw) => kw.length > KEYWORD_MAX_LEN)) return `单个触发关键词不能超过 ${String(KEYWORD_MAX_LEN)} 个字符`
  if (!isValidPhotoLimit(input.photoLimit)) return `照片数量需为 ${String(PHOTO_LIMIT_MIN)}–${String(PHOTO_LIMIT_MAX)} 的整数（0 = 不带图片）`
  return null
}

/** 构建 `TaskInfoInput` 的输入。 */
export interface BuildTaskInfoInputOptions {
  chat: TaskCreateSession
  /** 群聊目标成员；单聊可为 null（会回填成会话对象）。 */
  target?: { username: string; name: string } | null
  keywords: readonly string[]
  photoLimit: number
  /** 群聊是否只匹配 @ 登录账号；缺省 = false。 */
  mentionMeOnly?: boolean
  /** 用户填的任务名；空串 = 自动生成。 */
  name?: string
}

/**
 * 把表单态折成写接口的入参。
 *
 * 单聊的「触发对象」就是会话对象本身（`targetUsername = chat.username`）——
 * 这个回填只发生在这里，界面不给用户第二个选择，避免出现「单聊还要选人」的困惑。
 * 状态固定 `incomplete`：触发方式配置（Webhook 地址 / 八爪鱼 RPA）在【任务信息】里补，
 * 补完才参与触发与投递。
 * @param options - 会话/目标/关键词/照片档位/任务名。
 * @returns 可直接交给 `apiSaveTaskInfo` 的入参。
 */
export function buildTaskInfoInput(options: BuildTaskInfoInputOptions): TaskInfoInput {
  const { chat, target } = options
  const isGroup = chat.type === 'group'
  const targetUsername = isGroup ? (target?.username ?? '') : chat.username
  const targetName = isGroup
    ? (target?.name ?? target?.username ?? '')
    : (chat.displayName || chat.username)
  const keywords = [...options.keywords]
  const typedName = (options.name ?? '').trim()
  const name = typedName === ''
    ? defaultTaskName({ chatName: chat.displayName, chatType: chat.type, targetName: isGroup ? targetName : null, keywords })
    : typedName
  return {
    name,
    chatUsername: chat.username,
    chatName: chat.displayName || chat.username,
    chatType: chat.type,
    targetUsername,
    targetName,
    keywords,
    photoLimit: options.photoLimit,
    mentionMeOnly: isGroup && options.mentionMeOnly === true,
    status: 'incomplete',
  }
}

/** 成员列表的渲染投影。 */
export interface MemberPickResult {
  /** 真正要画的成员（最多 {@link MEMBER_RENDER_LIMIT} 行）。 */
  items: GroupMember[]
  /** 命中搜索词的成员总数（用于「共 N 位」与「还有多少没画」）。 */
  matched: number
  /** 被截断掉、没画的条数。 */
  hidden: number
  /** 成员过多且没搜索词 ⇒ 界面应提示「输入昵称或微信号搜索」。 */
  needQuery: boolean
}

/**
 * 群成员搜索 + 截断。昵称与微信号都参与匹配（与群信息抽屉的 `filterMembers` 同口径）。
 *
 * 为什么在弹窗里也要截断：目标用户是**单选**，一次画上千行既慢又没人会滚到底；
 * 超过 {@link MEMBER_FILTER_THRESHOLD} 位时更该做的是让用户搜索，而不是把滚动条塞满。
 * @param members - 群成员全量。
 * @param rawQuery - 搜索框原文（空 = 不过滤）。
 * @param limit - 最多画多少行（默认 {@link MEMBER_RENDER_LIMIT}）。
 * @returns 渲染投影。
 */
export function pickMembers(members: readonly GroupMember[], rawQuery: string, limit: number = MEMBER_RENDER_LIMIT): MemberPickResult {
  const query = rawQuery.trim().toLowerCase()
  const matched = query === ''
    ? [...members]
    : members.filter((m) => m.name.toLowerCase().includes(query) || m.username.toLowerCase().includes(query))
  const items = matched.slice(0, Math.max(1, limit))
  return {
    items,
    matched: matched.length,
    hidden: Math.max(0, matched.length - items.length),
    needQuery: query === '' && members.length > MEMBER_FILTER_THRESHOLD,
  }
}
