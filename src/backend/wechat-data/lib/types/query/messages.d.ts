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
 * 用 server_id 反查一条消息的 create_time（第 67 轮）。
 *
 * 用途：`SessionTable.unread_first_msg_srv_id` 指向该会话**最早的一条未读**，
 * 把它换成时间就能显示「未读 48 条 · 最早 2 小时前」，比光一个数字更能判断该先看哪个。
 * 实测本机 41 个未读会话里 39 个能解析（另 2 个 srv_id=0，是合成会话），
 * 全部解析耗时 ~7ms（复用 catalog 的分片索引），所以可以放在 getSessions 里同步做。
 *
 * ⚠️ `server_id` 是 int64：SQL 侧必须 `CAST(server_id AS TEXT)` 比对，否则读出来就 `ERR_OUT_OF_RANGE`。
 * @param decryptedDir - decrypted root.
 * @param talker - 会话 username（决定 Msg_ 表名与所在分片）。
 * @param serverId - server_id 的**字符串**形式。
 * @returns create_time（epoch 秒），解析不到返回 null。
 */
export declare function msgCreateTimeByServerId(decryptedDir: string, talker: string, serverId: string): number | null;
/**
 * Incrementally fetch messages newer than a sort_seq watermark (real-time
 * polling). Mirrors st_control's monitor delta: any message whose order key
 * is above the seen high-water mark is returned oldest-first for appending.
 * @param decryptedDir - decrypted data root.
 * @param talker - conversation username.
 * @param after - only rows with sort_seq > this watermark are returned.
 * @param limit - max rows to return (default 200).
 * @param selfUsername - logged-in account wxid (see {@link queryMessages}).
 * @returns the newer messages (empty when nothing arrived).
 */
export declare function queryNewMessages(decryptedDir: string, talker: string, after: number, limit?: number, selfUsername?: string): MessagesSnapshot;
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
 * @returns the messages snapshot.
 */
export declare function queryMessages(decryptedDir: string, talker: string, limit?: number, cursor?: number, selfUsername?: string, cursorLocalId?: number): MessagesSnapshot;
/**
 * Resolve one message by its server_id (merged chat-log nested pointers).
 * Scans every message shard / Msg table; only type-49 appmsg cards are
 * resolved.
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
 * @returns found flag plus the parsed message (when found).
 */
export declare function queryMessageByServerId(decryptedDir: string, serverId: string): {
    found: boolean;
    message?: WechatMessage;
};
