/**
 * 消息列表的归属校验：这份列表真的属于这个会话吗？
 *
 * 起因（2026-09-20 报障）：某个单聊的消息流里出现了**多个用户的聊天记录**。
 * 数据层并没有串 —— 该会话的消息表里只有两个发送者，服务端返回的也是对的；
 * 串的是**渲染缓存**：`chat-msgs:<talker>` 是按会话存的 JSON 快照，早期版本在
 * 「切会话」的竞态下把上一个会话的列表写了进去，之后每次重开这个会话都从缓存里
 * 读出来，于是「界面显示错的、服务端返回对的」。`Chats.tsx` 里那套 `sessionAlive`
 * 令牌只能防「以后写错」，管不到**已经写坏的**缓存。
 *
 * 因此：**读缓存之后必须核对一次归属**，判据取单聊的硬不变量 ——
 * 单聊里收到的消息，发送者只能是对方（= 会话 username）或自己；出现第三种发送者，
 * 就说明这份列表不是这个会话的。
 *
 * 判据能不能落地取决于发送者字段：后端从 2026-11 起给单聊**接收方向**的消息补上
 * `sender = talker`（见 `query/messages.ts#toWechatMessages`）。此前单聊行没有 `sender`，
 * 这条校验对缓存实际是空转 —— 写坏了也照样通过。现在 `cachedMessagesMatchTalker`
 * 还要求这份缓存**拿得出**归属证据，旧后端/旧缓存留下的裸列表一律不画。
 *
 * 校验失败时丢弃缓存（当作没有缓存、重新取数）：
 * 失败方向是「多取一次网络/磁盘」，而不是「藏掉消息」，所以判据偏严也不会丢内容。
 */

/** 判定所需的最小字段集（`WechatMessage` 的前缀）。 */
export interface ScopableMessage {
  /** 1 = 自己发的。 */
  isSender?: number
  /** 已解析出的发送者 username（解析不出时为空串或缺失）。 */
  sender?: string
}

/**
 * 这份消息列表是否可能属于 `talker`。
 *
 * 群聊恒返回 true（群里本来就有多个发送者，这条判据不适用）。
 * 单聊：允许 `isSender=1`、`sender` 为空（未解析）、`sender === talker`、`sender === selfWxid`；
 * 其余一律判伪。
 * @param list - 待校验的消息列表（缓存里的快照）。
 * @param talker - 会话 username。
 * @param selfWxid - 当前登录账号 wxid（未知时传空）。
 * @returns 归属成立返回 true；判定不了或明显不属于该会话时返回 false。
 */
export function messagesMatchTalker(
  list: readonly ScopableMessage[],
  talker: string,
  selfWxid?: string,
): boolean {
  if (list.length === 0) return true
  if (talker.endsWith('@chatroom')) return true
  const self = (selfWxid ?? '').trim()
  for (const m of list) {
    if (m.isSender === 1) continue
    const who = (m.sender ?? '').trim()
    if (who === '') continue
    if (who === talker) continue
    if (self !== '' && who === self) continue
    return false
  }
  return true
}

/**
 * 渲染缓存是否可用于 `talker` —— 比 {@link messagesMatchTalker} 更严。
 *
 * 单聊缓存里**接收方向**的行必须带 `sender`：一份谁都能通过校验的缓存等于没有校验
 * （2026-09 的脏缓存就是靠这一点存活下来的）。这里要求缓存拿得出至少一行归属证据，
 * 且每一行接收方向的消息都不得缺失发送者；拿不出证据（旧后端返回、旧格式缓存）时
 * 宁可不用 —— 代价只是首屏多一次权威取数，而画错一次是「别人的消息出现在这个窗口」。
 *
 * 群聊仍不适用发送者判据（群里本来就有多个人），归属由缓存信封里的 `talker` 字段负责，
 * 见 `chat-render-cache.ts`。
 * @param list - 缓存里的消息列表。
 * @param talker - 本应拥有这份列表的会话 username。
 * @param selfWxid - 当前登录账号 wxid（未知时传空）。
 * @returns true 表示这份缓存可以安全地先画出来。
 */
export function cachedMessagesMatchTalker(
  list: readonly ScopableMessage[],
  talker: string,
  selfWxid?: string,
): boolean {
  if (!messagesMatchTalker(list, talker, selfWxid)) return false
  if (list.length === 0) return true
  if (talker.endsWith('@chatroom')) return true
  let sawIncoming = false
  for (const m of list) {
    if (m.isSender === 1) continue
    sawIncoming = true
    if ((m.sender ?? '').trim() === '') return false
  }
  // 只有自己发的行时没有任何证据可核对：判为不可用（多取一次即可）。
  return sawIncoming
}
