/**
 * 消息归属判据：正文里的发送者前缀、分片 Name2Id 里「我」这一行。
 *
 * 这两条都直接决定聊天窗口把一条消息画到左边还是右边，判据必须统一且经真机数据校准
 * （2026-11 抽样，7 个 `message_N.db`、约 19 万行）。
 *
 * @module message-attribution
 */

/** 分片 Name2Id：rowid -> username（空串是微信 4.x 用来标记「登录账号」的行）。 */
export type ShardNames = ReadonlyMap<number, string>

const emptyRowSelfCache = new WeakMap<ShardNames, Map<string, boolean>>()

/**
 * 本分片是否把「我」记成**空 user_name 行**。
 *
 * 不能对每一行都假设「空名 = 我」：实测同一分片里登录账号有独立的命名行
 * （`message_5.db` 的 rowid 2 = 本机 wxid），空名行是**另一个群成员** ——
 * 那些行里的撤回通知写着别人的名字。把空名行认成「我」，这个成员的消息会整批
 * 画到右侧（报障：「有些消息并不是我发的，却显示为我发的」）。
 *
 * 判据与 `calls.ts#findSelfRowId`、`annual-review.ts` 同一口径：先找显式 wxid 行，
 * 找不到才沿旧约定认空行（老分片 / 账号未知时保留原行为）。
 * @param name2id - 本分片 Name2Id（rowid -> username）。
 * @param self - 登录账号 wxid；空串表示账号未知。
 * @returns true 表示本分片的空名行应当作「我」。
 */
export function shardMarksSelfWithEmptyRow(name2id: ShardNames, self: string): boolean {
  let cache = emptyRowSelfCache.get(name2id)
  if (!cache) {
    cache = new Map()
    emptyRowSelfCache.set(name2id, cache)
  }
  const hit = cache.get(self)
  if (hit !== undefined) return hit
  let explicitSelf = false
  let hasEmptyRow = false
  for (const name of name2id.values()) {
    if (self !== '' && name === self) { explicitSelf = true; break }
    if (name === '') hasEmptyRow = true
  }
  const result = self === '' ? hasEmptyRow : hasEmptyRow && !explicitSelf
  cache.set(self, result)
  return result
}

const knownSendersCache = new WeakMap<ShardNames, ReadonlySet<string>>()

/**
 * 分片 Name2Id 里的全部账号（空串除外），用作正文前缀的白名单。
 * @param name2id - 本分片 Name2Id。
 * @returns 账号集合（按分片缓存）。
 */
export function knownSendersOf(name2id: ShardNames): ReadonlySet<string> {
  let set = knownSendersCache.get(name2id)
  if (!set) {
    const built = new Set<string>()
    for (const name of name2id.values()) if (name !== '') built.add(name)
    set = built
    knownSendersCache.set(name2id, set)
  }
  return set
}

/**
 * 从正文解析群消息的发送者前缀（`wxid_xxx:\n正文`）。
 *
 * 判据（真机抽样校准）：
 *  · **只看群会话**：私聊正文没有发送者前缀，`try:\n` 这种代码/正文会被误认成
 *    发送者。自聊里两条以 `try:\n` 开头的消息因此被判成「对方发的」而画到左边。
 *  · 前缀**必须锚在开头**：旧实现全串搜索 `xxx:\n`，正文里的 `iOS&android:\n`
 *    也会命中。抽样里锚定命中的 96,863 条全部是真实前缀，非锚定的唯一一条是误报。
 *  · 前缀 token **必须是本分片 Name2Id 里存在的账号**：群消息前缀就是发送者 wxid
 *    （抽样 96,863/96,863 命中）。这条把「正文恰好以 `Note:\n` 开头」挡掉，
 *    同时保留自定义微信号（如 `piaofeiye`）。
 * @param content - 解码后的消息正文。
 * @param talker - 会话 username（用于排除「群 id 本身」这种系统消息前缀）。
 * @param known - 本分片 Name2Id 的账号集合；未传则不做白名单校验。
 * @returns 发送者 username；不是群前缀时返回 null。
 */
export function senderFromContent(content: string, talker: string, known?: ReadonlySet<string>): string | null {
  if (!content || !talker.endsWith('@chatroom')) return null
  let printable = 0
  for (let i = 0; i < content.length && i < 512; i += 1) {
    const c = content.charCodeAt(i)
    if ((c >= 0x20 && c <= 0x7e) || c >= 0x80) printable += 1
  }
  if (content.length > 0 && printable / Math.min(content.length, 512) < 0.6) return null
  const m = /^([A-Za-z0-9_@.\-]{3,64}):\r?\n/.exec(content)
  if (!m) return null
  const head = m[1] ?? ''
  if (head.includes('<')) return null
  // 系统消息（sysmsg）的内容前缀是【会话本身】，例如
  // "50345516636@chatroom: <sysmsg ...>"。那不是发送者，
  // 若不排除会把系统消息记成"群自己发的"。
  if (head === talker) return null
  if (known !== undefined && !known.has(head)) return null
  return head
}
