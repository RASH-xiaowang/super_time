import type { MessagesSnapshot, WechatMessage } from '../types.ts';
import { richPlaceholder } from './parse.ts';
/**
 * Normalize a wechat local_type.
 *
 * `local_type` 的高 32 位是 **appmsg 子类型 / 属性标志**，低 32 位才是类型。
 * 归一化必须取低 32 位：`25769803825 = 0x6_00000031`（文件）、
 * `8589934592049 = 0x7d0_00000031`（转账）、`244813135921 = 0x39_00000031`
 * （引用）都靠这一步落回 49。
 *
 * 旧实现写的是 `localType > 0x100000000 ? localType % 0x100000000 : localType`，
 * 对负值/恰好等于边界的值语义不明确；这里统一成 `& 0xFFFFFFFF` 语义，
 * 与 SQL 侧的 `(local_type & 4294967295)` 完全一致（此前两处口径不同）。
 * @param localType - raw local_type value from the DB.
 * @returns the normalized (low 32 bit) type value.
 */
export declare function normalizeMsgType(localType: number): number;
/**
 * Human label for a normalized message type (mirror st_control).
 *
 * 标签取值依据本机 138,604 条消息的 local_type 低 32 位普查：
 *   1×92865 文本 / 3×25987 图片 / 49×8740 应用消息 / 43×6646 视频 /
 *   10000×1955 系统消息 / 47×1466 表情 / 34×696 语音 / 50×135 通话 /
 *   48×92 位置 / 11000×13 无内容 / 42×5 名片 / 66×4 企业微信名片
 *
 * 两处经实测纠正、容易想当然的地方：
 *  - 49 不是"链接"：它只是 appmsg 容器。8,740 条里真正的链接只有约 506 条，
 *    其余是文件(6)/引用(57)/小程序(33)/接龙(53)/转账(2000)/合并转发(19)等，
 *    具体种类由 XML 的 <appmsg><type> 决定（见 parseAppmsg）。故通用标签用
 *    "应用消息"，精确种类由 rich 解析给出。
 *  - 10000 不是"撤回消息"：1,955 条中 revokemsg 仅 31 条，
 *    sysmsgtemplate 1,172 条、无 type 属性的纯文本系统消息 752 条。
 *    故通用标签保持"系统消息"，撤回只是其子类型。
 *
 * @param localType - raw local_type value from the DB.
 * @returns the Chinese display label for the type.
 */
export declare function msgTypeLabel(localType: number): string;
/**
 * Decode a DB cell (TEXT or BLOB) to UTF-8 text, handling zstd + GBK.
 *
 * 2026-09-29 导出：撤回原文归档（`revoke-retain.ts`）也要用它 —— 微信的 `message_content`
 * 对**文本**也可能存成 zstd 压缩块（magic `28 B5 2F FD`），不先解码就会存进一堆乱码字节。
 */
export declare function decodeBlobText(v: unknown): string;
/**
 * Strip XML/二进制噪声，得到一句可读的正文预览。
 *
 * 旧实现是「删掉所有 `<...>` 再截断」，这在**标签未闭合或属性特别多**时会翻车：
 * 正则匹配不到 `>`，于是整串属性被当成正文 —— 实测 207 条表情、5,604 条视频消息
 * 由此渲染出 `fromusername = "wxid_..." md5 = "626ac..." …` 这样的属性汤。
 * 现在对 XML 只取**文本节点与 CDATA**（属性一律丢弃）；非 XML（含 base64 头）走原样。
 * @param content - raw message content.
 * @returns a plain-text preview (max 200 chars).
 */
export declare function msgText(content: string): string;
/**
 * rich 描述 → 一句可读占位。
 *
 * 实现已迁到 `parse.ts`（`richPlaceholder`）以便与 `renderType` 分类同源；
 * 这里保留同名导出，避免其它模块的 import 断掉。
 */
export { richPlaceholder };
/**
 * 已删除：原先在分片 Name2Id 解析不到 real_sender_id 时，回退去查
 * message_resource.db 的 SenderName2Id。
 *
 * 这是错的：real_sender_id 是【分片自身 Name2Id 的 rowid】，而 SenderName2Id
 * 是 message_resource.db 自己的 id 空间。实测（本机真实数据）：
 *   - 两个空间同时存在的 719 个 id，**100% 指向不同的人**；
 *   - 分片 Name2Id 每库只有 1 行空串（message_0 的 rowid 40、message_1 的 rowid 6），
 *     但引用它们的消息有 **8,422 条（占全部消息 6%）**，原先全部被安上了错误人名；
 *   - 更糟的是 r.senderUsername 被填了值后，toWechatMessages 里更可靠的
 *     「内容 wxid_xxx:\n 前缀」解析永远轮不到。
 *
 * 现在解析不到就留空：由内容前缀兜底，或由界面显示为未知发送者。
 */
/**
 * 一条待解析的「未读起点」：会话 + `unread_first_msg_srv_id` 的字符串形式。
 */
export interface MsgServerIdLookup {
    /** 会话 username（`WechatSession.username` 的别名；决定 Msg_ 表名与所在分片）。 */
    talker: string;
    /** server_id 的**字符串**形式（SQL 侧 CAST 成 TEXT 比对，见下）。 */
    serverId: string;
}
/**
 * 批量解析「未读从什么时候开始」（第 67 轮，P2：会话未读 N+1）。
 *
 * 旧实现让 `querySessions` 对最多 80 个未读会话逐个调用
 * {@link msgCreateTimeByServerId}，每次都要把**全部**消息分片打开一遍
 * （`withShards` 按表过滤后仍要 open/close 每个含该表的分片）。会话一多，
 * 分片打开次数 = 未读会话数 × 分片数，而且每次查询都只能按
 * `CAST(server_id AS TEXT) = ?` 扫单表、用不上索引（int64 的 server_id 无法直接绑定）。
 *
 * 这里改成：
 *   ① 分片目录只遍历一次，**每个分片只 open 一次**；
 *   ② 同一分片内按表分组，用 `IN (?, ?, …)` 一次取回多行；
 *   ③ 同一张表出现在多个分片时按 catalog 顺序依次尝试，保留旧语义
 *      （第一个 `create_time > 0` 的命中生效）；某分片读失败也只跳过该分片。
 *
 * ⚠️ `server_id` 是 int64：SQL 侧必须 `CAST(server_id AS TEXT)` 比对，否则读出来就
 * `ERR_OUT_OF_RANGE`；同时这也兼容老库里 `server_id` 存成 TEXT 的分片。
 *
 * @param decryptedDir - decrypted root.
 * @param lookups - 按调用方顺序给出的待解析项。
 * @returns 与 `lookups` 等长的数组；解析不到（或无效项）为 `null`。
 */
export declare function msgCreateTimesByServerIds(decryptedDir: string, lookups: ReadonlyArray<MsgServerIdLookup>): Array<number | null>;
/**
 * 用 server_id 反查一条消息的 create_time（第 67 轮）。
 *
 * 用途：`SessionTable.unread_first_msg_srv_id` 指向该会话**最早的一条未读**，
 * 把它换成时间就能显示「未读 48 条 · 最早 2 小时前」，比光一个数字更能判断该先看哪个。
 * 实测本机 41 个未读会话里 39 个能解析（另 2 个 srv_id=0，是合成会话）。
 *
 * 单条查询保留为批量的薄包装：`querySessions` 已改走
 * {@link msgCreateTimesByServerIds}，这里的实现与批量路径共享「分片只开一次」的语义。
 * @param decryptedDir - decrypted root.
 * @param talker - 会话 username（决定 Msg_ 表名与所在分片）。
 * @param serverId - server_id 的**字符串**形式。
 * @returns create_time（epoch 秒），解析不到返回 null。
 */
export declare function msgCreateTimeByServerId(decryptedDir: string, talker: string, serverId: string): number | null;
/**
 * Incrementally fetch messages newer than a `(sort_seq, local_id)` watermark
 * (real-time polling). The composite cursor prevents duplicate `sort_seq`
 * values from skipping messages; omitting `afterLocalId` keeps the legacy
 * `sort_seq > after` behavior for old callers.
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param after - only rows at/after this sort_seq watermark are considered.
 * @param limit - max rows to return (default 200).
 * @param selfUsername - logged-in account wxid (see {@link queryMessages}).
 * @param afterLocalId - optional second cursor segment; when present, rows are
 *   fetched with `sort_seq > after OR (sort_seq = after AND local_id > afterLocalId)`.
 * @returns newer messages plus `hasMore` and the next `(cursor, cursorLocalId)`.
 */
export declare function queryNewMessages(decryptedDir: string, 
/** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
talker: string, after: number, limit?: number, selfUsername?: string, afterLocalId?: number): MessagesSnapshot;
/**
 * Read one talker's messages (keyset pagination across all shards).
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param limit - max rows (per page).
 * @param cursor - previous page's smallest sort_seq (exclusive), or undefined for the newest page.
 * @param selfUsername - logged-in account wxid (used to mark own messages);
 *   when empty, a private-chat heuristic compares the sender against the talker.
 * @param cursorLocalId - 上一页最后一行的 local_id。与 cursor 组成复合游标，
 *   用于消除 sort_seq 重复导致的分页丢消息；不传则退回只按 sort_seq 分页。
 * @param beforeLocalId - optional target local id. When present, the page ends at
 *   this message (inclusive), so jumping to an old quote does not require paging
 *   through the entire conversation.
 * @returns the messages snapshot.
 */
export declare function queryMessages(decryptedDir: string, 
/** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
talker: string, limit?: number, cursor?: number, selfUsername?: string, cursorLocalId?: number, beforeLocalId?: number): MessagesSnapshot;
/** 「截至某条消息」的消息窗口；`found=false` 表示目标已不在当前解密快照里。 */
export interface MessageAtOrBeforeSnapshot {
    messages: WechatMessage[];
    found: boolean;
}
/**
 * Read a bounded message window ending at a specific local message.
 *
 * 推荐回复原先固定读会话最新 20 条；分析面板选中历史消息时，候选会错答最新一句。
 * 这里按 `local_id` 找到目标的全局排序键，再取 `(sort_seq, local_id) <= 目标`
 * 的最后一页，因此无论目标多旧都只读取当前会话，且不会越过目标看到后续消息。
 * @param decryptedDir - 解密数据根。
 * @param localId - 目标消息在当前会话内的 local_id。
 * @param limit - 窗口最多包含多少条消息（含目标）。
 * @param selfUsername - 登录账号 wxid，用于区分「我」和对方/群成员。
 * @param talker - 会话 `WechatSession.username` 的别名（范围边界）。
 * @returns 按时间正序的消息窗口与目标是否存在。
 */
export declare function queryMessagesAtOrBefore(decryptedDir: string, talker: string, localId: number, limit?: number, selfUsername?: string): MessageAtOrBeforeSnapshot;
/** Result of locating one message by its conversation-scoped local id. */
export interface MessageByLocalIdResult {
    found: boolean;
    message?: WechatMessage;
    error?: string;
}
/**
 * Locate one message by `(username, local_id)` without scanning every chat.
 *
 * Attachment export must derive the file name, size, MD5 and creation time from
 * the message itself; taking those values from renderer props would let a stale
 * or forged card point at another conversation's same-name file. A duplicate
 * local id across shards is treated as ambiguous and rejected rather than
 * guessing.
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username or legacy message-table reference.
 * @param localId - conversation-scoped message id.
 * @param selfUsername - optional logged-in account for sender normalization.
 * @returns the canonical parsed message, or an explicit lookup failure.
 */
export declare function queryMessageByLocalId(decryptedDir: string, 
/** 会话微信 ID —— 正名见 `WechatSession.username`。 */
talker: string, localId: number, selfUsername?: string): MessageByLocalIdResult;
/**
 * Resolve one message by its server_id (merged chat-log nested pointers and
 * quoted-message jumps). With `talker`, the lookup is scoped to that
 * conversation and resolves every message type. Without it, the historical
 * behavior is preserved: scan every message table and only resolve type-49
 * appmsg cards.
 *
 * **带签名缓存**（M11）：本机实测「命中」中位 1.8–3.8ms，而**未命中**要 77–80ms —— 它是两轮
 * 扫描（先按整型走 `server_id` 覆盖索引，再对未命中的整轮 `CAST(server_id AS TEXT)` 全表扫，
 * 本机 4 个分片共 304 张 `Msg_` 表 ⇒ 最坏 2432 次查询）。
 *
 * 收益范围要说准（复审纠正过我的说法）：`cachedBySig` 的 maxAge **从写入计时、不是从访问计时**，
 * 所以真正省掉的是「**5 秒内**的重复」——双击、重渲染、失败重试这一类；而「用户点了没找到 →
 * 等同步完成再点」的间隔通常 > 5s（实时同步 tick ≈10s），**那一次仍要重新扫**。
 * 失效按分片目录签名（任一分片被原子替换就变），所以同步落地后不会返回旧结论
 * —— 这条只对「同步走 rename 替换」成立：签名是 mtime+size 指纹，理论上保住时间戳的写入者
 * 可以击穿它（与仓库其它 `cachedBySig` 条目同款限制，非本处新引入）。
 * @param decryptedDir - decrypted data root.
 * @param serverId - server_id as string (may exceed 2^53).
 * @param talker - optional conversation username for a scoped, all-type lookup.
 * @param selfUsername - optional logged-in account for sender normalization.
 * @returns found flag plus the parsed message (when found).
 */
export declare function queryMessageByServerId(decryptedDir: string, serverId: string, 
/** 会话微信 ID —— 正名见 `WechatSession.username`。 */
talker?: string, selfUsername?: string): Promise<{
    found: boolean;
    message?: WechatMessage;
}>;
