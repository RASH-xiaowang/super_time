import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/** 会话列表排序口径：置顶优先，其次按最后消息时间倒序；同时间用 username 稳定排序。 */
export function compareSessions(a: WechatSession, b: WechatSession): number {
  return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    || b.lastTimestamp - a.lastTimestamp
    || a.username.localeCompare(b.username)
}

/**
 * 两个会话行是否在所有界面可见字段上相同。
 *
 * 实时刷新每拍都会拿到新对象；直接替身会让 600 行全部重渲染。这个比较只服务
 * React 的引用稳定，不参与缓存正确性：漏掉一个业务字段最多多渲染一次，不会画错。
 */
function sameSessionRow(a: WechatSession, b: WechatSession): boolean {
  return a.username === b.username
    && a.displayName === b.displayName
    && a.type === b.type
    && a.lastTimestamp === b.lastTimestamp
    && a.summary === b.summary
    && a.unreadCount === b.unreadCount
    && a.draft === b.draft
    && a.pinned === b.pinned
    && a.hidden === b.hidden
    && a.lastMsgType === b.lastMsgType
    && a.lastMsgSubType === b.lastMsgSubType
    && a.lastMsgSender === b.lastMsgSender
    && a.lastMsgSenderName === b.lastMsgSenderName
    && a.bizType === b.bizType
    && a.accountKind === b.accountKind
    && a.enterpriseName === b.enterpriseName
    && a.unreadSince === b.unreadSince
}

/**
 * 把实时刷新的首页并回已加载列表。
 *
 * 只取 `offset=0, limit=120` 的首页：新消息只可能把会话抬到前面，已加载的旧页不必
 * 重取；按 username 替换同会话、补入新会话，再整体排序。未出现在首页的旧会话先保留，
 * 由下一次冷启动/完整刷新做最终清理 —— 这比为了发现删除而每拍重拉 600 条更划算。
 * @param current - 当前已加载列表。
 * @param head - 后端刚返回的最新一页（通常是 120 条）。
 * @returns 合并后的新数组；内容与顺序都没变时返回原数组，避免整表重渲染。
 */
export function mergeSessionHead(
  current: readonly WechatSession[],
  head: readonly WechatSession[],
): readonly WechatSession[] {
  if (head.length === 0) return current
  const headByUsername = new Map(head.map((session) => [session.username, session]))
  const seen = new Set<string>()
  let changed = false
  const merged: WechatSession[] = []
  for (const session of current) {
    seen.add(session.username)
    const fresh = headByUsername.get(session.username)
    if (fresh === undefined || sameSessionRow(session, fresh)) {
      merged.push(session)
      continue
    }
    changed = true
    merged.push(fresh)
  }
  for (const session of head) {
    if (seen.has(session.username)) continue
    seen.add(session.username)
    merged.push(session)
    changed = true
  }
  merged.sort(compareSessions)
  if (!changed) {
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== current[i]) { changed = true; break }
    }
  }
  return changed ? merged : current
}

const APPMSG_PREVIEW: Readonly<Record<number, string>> = {
  5: '[链接]',
  6: '[文件]',
  8: '[表情]',
  19: '[聊天记录]',
  24: '[笔记]',
  33: '[小程序]',
  36: '[小程序]',
  42: '[名片]',
  51: '[视频号]',
  53: '[接龙]',
  57: '[引用]',
  62: '[拍一拍]',
  63: '[直播]',
  68: '[链接]',
  74: '[文件]',
  87: '[群公告]',
  88: '[直播]',
  2000: '[转账]',
  2001: '[红包]',
  2003: '[红包]',
}

function normalizedType(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  const type = Math.trunc(value)
  const mod = 0x100000000
  return type >= 0 ? type % mod : ((type % mod) + mod) % mod
}

function placeholderOf(typeValue: number | undefined, subTypeValue: number | undefined): string {
  if (typeValue === 244135593199) return '[小程序]'
  const type = normalizedType(typeValue)
  const subType = normalizedType(subTypeValue)
  if (type === 1) return ''
  if (type === 3) return '[图片]'
  if (type === 34) return '[语音]'
  if (type === 42 || type === 66) return '[名片]'
  if (type === 43) return '[视频]'
  if (type === 47) return '[表情]'
  if (type === 48) return '[位置]'
  if (type === 49) return APPMSG_PREVIEW[subType] ?? '[应用消息]'
  if (type === 50) return '[通话]'
  if (type === 244 || type === 246) return '[文件]'
  if (type === 10000) return '[系统消息]'
  if (type === 10002) return '[撤回消息]'
  if (type === 11000) return '[无内容消息]'
  if (type === 859832288 || type === 922746960) return '[拍一拍]'
  return type > 0 ? '[消息]' : ''
}

function oneLine(value: string): string {
  return value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
}

function senderNameOf(session: WechatSession, selfUsername: string): string {
  const sender = (session.lastMsgSender ?? '').trim()
  if (sender !== '' && sender === selfUsername.trim()) return '我'
  return (session.lastMsgSenderName ?? '').trim() || sender
}

function withoutKnownSenderPrefix(text: string, session: WechatSession, sender: string): string {
  const candidates = [
    (session.lastMsgSenderName ?? '').trim(),
    (session.lastMsgSender ?? '').trim(),
    sender,
  ].filter((candidate) => candidate !== '')
  for (const candidate of candidates) {
    for (const separator of [':', '：']) {
      const prefix = `${candidate}${separator}`
      if (text.startsWith(prefix)) return text.slice(prefix.length).trim()
    }
  }
  return text
}

/**
 * 会话列表最后一条消息的一行预览。
 *
 * `SessionTable.summary` 对图片、语音、文件等消息可能为空；这时用
 * `lastMsgType / lastMsgSubType` 生成微信同款的 `[图片] / [文件]` 占位。
 * 群聊始终补上最后发送者名称，若 summary 已带同一前缀则不重复。
 */
export function sessionPreviewText(session: WechatSession, selfUsername = ''): string {
  const rawSummary = oneLine(session.summary)
  const placeholder = placeholderOf(session.lastMsgType, session.lastMsgSubType)
  const draft = oneLine(session.draft)
  let body = rawSummary

  // 原始 summary 若是 XML，直接显示会泄漏一大段标签；用类型占位替代。
  if (draft !== '' && (body === '' || /<\/?[a-zA-Z][^>]*>/.test(body))) {
    return `[草稿] ${draft}`
  }
  if (body === '' || /<\/?[a-zA-Z][^>]*>/.test(body)) {
    body = placeholder
  }
  if (body === '') return ''

  if (session.type !== 'group') return body
  const sender = senderNameOf(session, selfUsername)
  if (sender === '') return body
  return `${sender}: ${withoutKnownSenderPrefix(body, session, sender)}`
}

/** 企业微信群聊不在会话名称旁显示“企微”徽标；单聊仍保留。 */
export function shouldShowEnterpriseBadge(
  session: Pick<WechatSession, 'type'>,
  isEnterprise: boolean,
): boolean {
  return isEnterprise && session.type !== 'group'
}
