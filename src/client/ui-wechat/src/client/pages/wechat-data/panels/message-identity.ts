/**
 * 消息行的**复合身份**与两类窗口合并（纯函数，无 React / 网络依赖）。
 *
 * `local_id` 不是会话内唯一：同一位聊天对象的每个消息分片各自从 1 起编号。
 * 真机数据（群 `17660437911@chatroom`）里 `message_0..5` 各有 `local_id 1..N`，
 * 一个窗口同时装着 `message_0` 的 `local_id 1` 与 `message_2` 的 `local_id 1`。
 * 只按 `localId` 建 Map/Set 做合并，会把「老分片里编号相同的那一行」覆盖成最新页的
 * 另一条消息 —— 被覆盖的位置上出现新内容，新内容又按增量追加到尾部，
 * 同一段内容于是同屏出现两次（用户报障的「重复内容」）。
 *
 * 复合身份 = `sort_seq` + `local_id`。`sort_seq` 是库内的排序键，跨分片单调递增，
 * 与分片内的 `local_id` 组合足以区分同一会话里的两条消息；`sort_seq` 缺失的旧响应
 * 退回 `local_id` + `create_time`（仍然是分片内唯一的）。
 *
 * @module message-identity
 */
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'

/** 计算身份所需的最小字段集（`WechatMessage` 或缓存里的旧行都满足）。 */
export type MessageIdentityInput = Pick<WechatMessage, 'localId'> & Partial<Pick<WechatMessage, 'sortSeq' | 'createTime'>>

/**
 * 一条消息在「当前会话窗口」里的身份键。
 * @param m - 消息行。
 * @returns 供 Map/Set 使用的字符串键。
 */
export function messageIdentity(m: MessageIdentityInput): string {
  const seq = Number(m.sortSeq ?? 0)
  if (Number.isFinite(seq) && seq > 0) return `s${seq}:${m.localId}`
  const at = Number(m.createTime ?? 0)
  return `l${m.localId}:${Number.isFinite(at) ? at : 0}`
}

/**
 * 一批消息的身份集合。
 * @param list - 消息行。
 * @returns 复合身份集合。
 */
export function messageIdentitySet(list: readonly MessageIdentityInput[]): Set<string> {
  const keys = new Set<string>()
  for (const m of list) keys.add(messageIdentity(m))
  return keys
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * 同一条消息的两份快照是否**内容一致**（判断「要不要换行」）。
 *
 * 不能让「对象引用不同」直接算变化：后端每拍都会重建消息对象，那样每次推送都会
 * 替换整个可见窗口并重写渲染缓存。也不能只看 `type`/`sortSeq`：编辑消息、撤回文案
 * 和部分就地修改不会推进 `sort_seq`，但正文/系统子类型已经变了。
 * @param a - 旧快照。
 * @param b - 新快照。
 * @returns true 表示内容相同（可沿用旧对象）。
 */
export function sameMessageRow(a: WechatMessage, b: WechatMessage): boolean {
  return a.localId === b.localId
    && a.type === b.type
    && a.subType === b.subType
    && a.sortSeq === b.sortSeq
    && a.isSender === b.isSender
    && a.createTime === b.createTime
    && a.serverId === b.serverId
    && a.msgContent === b.msgContent
    && a.strContent === b.strContent
    && a.typeLabel === b.typeLabel
    && a.displayText === b.displayText
    && a.renderType === b.renderType
    && a.renderLabel === b.renderLabel
    && a.sysKind === b.sysKind
    && a.sender === b.sender
    && a.senderName === b.senderName
    && a.senderEnterpriseName === b.senderEnterpriseName
    && sameJson(a.rich, b.rich)
    && sameJson(a.atUsers, b.atUsers)
}

/** 对账合并的结果：新窗口、真正追加的行、是否发生了替换。 */
export interface LatestWindowMerge {
  /** 合并后的整列表（没有任何变化时就是 `prev` 本身）。 */
  next: readonly WechatMessage[]
  /** `prev` 里没有、被追加到尾部的行（水位只按这批推进）。 */
  added: readonly WechatMessage[]
  /** 是否有行被同身份的新版本替换。 */
  changed: boolean
}

/**
 * 对账：把最新窗口里的新版本按身份换进 `prev`，再把 `prev` 没有的行追加到尾部。
 *
 * 不按 `localId` 单键匹配 —— 见模块头注释：跨分片的同号行不是同一条消息。
 * @param prev - 当前窗口（可能已经往前翻出了历史）。
 * @param latest - 后端返回的最新窗口。
 * @param same - 行内容等值判据（默认 {@link sameMessageRow}，决定「算不算真变了」）。
 * @returns 合并结果；无变化时 `next === prev`，调用方据此保持数组身份。
 */
export function mergeLatestWindow(
  prev: readonly WechatMessage[],
  latest: readonly WechatMessage[],
  same: (a: WechatMessage, b: WechatMessage) => boolean = sameMessageRow,
): LatestWindowMerge {
  const byKey = new Map<string, WechatMessage>()
  for (const m of latest) byKey.set(messageIdentity(m), m)
  let changed = false
  const replaced = prev.map((m) => {
    const cur = byKey.get(messageIdentity(m))
    if (cur === undefined || same(m, cur)) return m
    changed = true
    return cur
  })
  const seen = messageIdentitySet(prev)
  const added: WechatMessage[] = []
  for (const m of latest) {
    const key = messageIdentity(m)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(m)
  }
  if (!changed && added.length === 0) return { next: prev, added, changed }
  return { next: added.length === 0 ? replaced : [...replaced, ...added], added, changed }
}

/**
 * 就地替换：只把 `latest`（以及定向取回的单条 `overrides`）里同身份的行换进 `prev`，
 * 不追加、不改顺序。用于「编辑/恢复原文后刷新」—— 追加由对账负责，这里多追加一行
 * 就等于把一条旧消息重新画到最新位置。
 * @param prev - 当前窗口。
 * @param latest - 后端返回的最新窗口。
 * @param overrides - 定向取回的行（目标不在最新窗口里时用）。
 * @returns 合并后的列表；没有可替换的行时保持 `prev` 的身份。
 */
export function mergeRowsInPlace(
  prev: readonly WechatMessage[],
  latest: readonly WechatMessage[],
  overrides: readonly WechatMessage[] = [],
): readonly WechatMessage[] {
  const byKey = new Map<string, WechatMessage>()
  for (const m of latest) byKey.set(messageIdentity(m), m)
  for (const m of overrides) byKey.set(messageIdentity(m), m)
  let changed = false
  const next = prev.map((m) => {
    const cur = byKey.get(messageIdentity(m))
    if (cur === undefined || sameMessageRow(m, cur)) return m
    changed = true
    return cur
  })
  return changed ? next : prev
}

/**
 * 把更早的一页并到窗口**前面**，并去掉窗口里已有的行。
 *
 * 续页请求按游标是排他的，理论上不会重叠；但重复点「加载更多」、自动补量与手动
 * 点击同一拍进来、或后端在游标边界上给了重叠页时，同一页会被拼两次 —— 那是
 * 一眼可见的「整段消息重复」。这里按复合身份去重，重复页退化成空操作。
 * @param prev - 当前窗口。
 * @param older - 更早的一页（后端返回顺序）。
 * @returns `next` 为拼接后的窗口，`added` 为真正新插入的行。
 */
export function prependOlderWindow(
  prev: readonly WechatMessage[],
  older: readonly WechatMessage[],
): { next: readonly WechatMessage[]; added: readonly WechatMessage[] } {
  const seen = messageIdentitySet(prev)
  const added: WechatMessage[] = []
  for (const m of older) {
    const key = messageIdentity(m)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(m)
  }
  if (added.length === 0) return { next: prev, added }
  return { next: [...added, ...prev], added }
}
