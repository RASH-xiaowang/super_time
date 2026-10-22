import type { RevokedItem, RevokedMedia } from '../types.ts';
/** 归档库路径：数据根下（与 `decoded_images` 同级，不进解密目录以免被同步覆盖）。 */
export declare function messageArchivePath(decryptedDir: string): string;
/**
 * 二进制/压缩内容的**占位标记**前缀（2026-09-29 用户委托决策）。
 *
 * 依据：全量归档 19 万条实测 **219MB**，而其中真正可读、也正是"撤回原文"要看的是文本与 XML；
 * 二进制块（图片/语音载荷、压缩片段）存了也读不出来。所以这类内容只记
 * `标记 + local_type + 字节数`：**该行仍然入库**（"这条消息存在过"与类型信息永久保留），
 * 但不再保存原始字节。既有档案不受影响（`INSERT OR IGNORE` 只增不改）。
 */
export declare const BIN_PREFIX = "\u0001BIN:";
/** 一条归档消息。 */
export interface ArchivedMessage {
    /** 会话标识：`WechatSession.username` 的等价物（本模块用「文件#表名」表示，见 `talkerOfTable`）。 */
    talker: string;
    rowKey: number;
    createTime: number;
    localType: number;
    senderId: number;
    /** 源分片 Name2Id 解析出的真实 wxid（空串表示该行是「自己」的占位或解析不到）。 */
    senderUsername: string;
    /** 源消息的真实 local_id（微信 4.x 实测等于 rowid；老分片缺列时回退 rowid）。 */
    localId: number;
    /** 源消息的 server_id（字符串；可能超过 2^53）。 */
    serverId: string;
    content: string;
}
/**
 * **全量/增量归档**：把每个 `Msg_` 表里的消息内容落进我们自己的库。
 *
 * 幂等：`INSERT OR IGNORE` + 主键 `(talker, row_key)` ⇒ 重复调用只补新行，
 * **已归档的原文永不被后来的"撤回提示/空内容"覆盖**。
 *
 * 性能：按**源库签名**整库跳过 —— 首次要把全部历史归档一遍（19 万行约 2.4s），
 * 之后只要某个 `message_*.db` 的签名没变，那**整个库直接跳过**（只剩一次 stat），
 * 于是空闲时开销接近 0，可以安全地放进同步 tick / 读路径。
 *
 * @param decryptedDir - 解密数据根。
 * @returns 本次新归档条数、扫描表数/行数、跳过的库数。
 */
export declare function archiveMessages(decryptedDir: string): {
    added: number;
    tables: number;
    scanned: number;
    skipped: number;
};
/** 归档库统计：总条数、撤回提示条数、已配到原文的条数。 */
export declare function archiveStats(decryptedDir: string): {
    total: number;
    tips: number;
};
/** 撤回原文的解析结果（纯函数，供测试与列表共用）。 */
export interface RevokedOriginal {
    typeLabel: string;
    content: string;
    retained: boolean;
    statusLabel: string;
    media?: RevokedMedia;
    /** 群消息前缀里的真实发送者 wxid（没有则为空）。 */
    senderUsername: string;
    /** 剥掉群前缀后的正文。 */
    body: string;
}
/**
 * 把归档原文解析成**可直接展示**的类型、正文与媒体元信息。
 *
 * 旧实现只给「原文已保留」一句话，用户必须展开且仍看不到图片/文件/语音信息。
 * 这里复用消息链的同一套解析器（`normalizeMsgType` / `parseMessageContent` /
 * `classifyRender`），保证撤回面板与聊天面板对同一条 XML 的判断一致。
 * @param raw - 归档里的原文（可能带 `\u0001BIN:` 占位或群前缀）。
 * @param rawLocalType - 源消息的 raw `local_type`。
 * @param isGroup - 会话是否群聊（用于剥 `wxid:\n` 前缀与解析 @ 等）。
 * @returns 展示类型、完整正文、保留状态与媒体元信息。
 */
export declare function describeRevokedOriginal(raw: string, rawLocalType: number, isGroup: boolean): RevokedOriginal;
/**
 * 旧调用方兼容形状：`sender/type_label/content/create_time` 始终存在，
 * 新字段（头像 username / 会话 / 媒体）是可选的。
 */
export type RetainedRevokeItem = RevokedItem;
/**
 * 产出「撤回消息」列表：**识别提示 + 配对原文**，全部来自我们自己的归档库。
 *
 * 配对判据：同一 `talker` 下、`row_key` 小于提示行的**最靠后那条**（同会话里紧挨在提示之前）。
 * 配不到就如实标注"原文未保留（撤回发生在归档开始之前）"——不编造。
 *
 * @param decryptedDir - 解密数据根。
 * @param limit - 上限（调用方已裁剪）。
 * @param offset - 偏移。
 * @param q - 关键词（匹配提示文本、发送者、或配到的原文）。
 * @returns 列表项与总数。
 */
export declare function queryRevokedRetained(decryptedDir: string, limit: number, offset: number, q?: string): {
    items: RetainedRevokeItem[];
    total: number;
    readError?: string;
};
