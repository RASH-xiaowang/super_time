/**
 * `query/search.ts` 的「查询侧：兜底扫描生成器、命中投影、可取消的搜索入口」部分（M21 拆分）。
 *
 * 从 `search.ts` 原样搬出，**行为逐字节不变**；`search.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './search.ts'` 的导入一行都不用改。
 *
 * @module search-query
 */
import type { SearchHit } from '../types.ts';
/** Split the group-message sender prefix (`wxid_xxx:\n`) into sender id + body. */
export declare function splitGroupPrefix(text: string, username: string): {
    sender: string;
    body: string;
};
/** Strip the group-message sender prefix (wxid_xxx:\n) from display text. */
export declare function stripGroupPrefix(text: string, username: string): string;
/** 群内发送者的显示名（联系人表里有就用名字，否则退回 wxid）。 */
export declare function senderLabel(sender: string, names: Map<string, string>): string;
/**
 * 从 appmsg / 系统消息的 XML 里抽出可读文本。
 *
 * 微信把「转账、链接、文件、引用、系统提示」这类消息存成
 * `<msg><appmsg><title><![CDATA[微信转账]]></title><des>收到转账1500.00元…</des>…`
 * —— **不是**纯文本。旧索引只收 `local_type=1`，于是「微信转账收到转账1500元」
 * 这类消息完全不在索引里，而它恰恰是「最近一次转账给我的是谁」的唯一答案（实测）。
 * 这里按字段名抽取（title/des/content…），并剥掉标签与 CDATA。
 * @param raw - 原始消息内容（可能是 XML 也可能是纯文本）。
 * @returns 可读文本（无可读内容时返回空串）。
 */
export declare function readableMessageText(raw: string): string;
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
export declare function formatFullTime(ts: number): string;
/** 一条会话窗口内的消息（用于 chunk 级上下文：单条微信消息几乎不构成检索单元）。 */
export interface WindowMessage {
    local_id: number;
    sort_seq: number;
    create_time: number;
    text: string;
    sender: string;
}
/** (分片|表名) → 该表是否存在。窗口展开会按会话反复查同一张表，缓存掉这个探测。 */
export declare const windowTableCache: Map<string, boolean>;
/**
 * 取某个会话在 centerMs 前后 spanMs 内的连续消息（对话窗口）。
 *
 * 为什么便宜：Msg_* 表上带 `(local_type, sort_seq)` 复合索引，窗口查询走
 * `SEARCH ... USING INDEX _TYPE_SEQ`，实测 0ms。这是 chunk 级检索可行的前提 ——
 * 单条消息「我没答应」本身无法回答「谁答应过什么」，必须带上前后的对话。
 *
 * @param decryptedDir - decrypted data root.
 * @param username - 会话 username。
 * @param centerMs - 窗口中心（毫秒时间戳）。
 * @param spanMs - 前后各取多少毫秒。
 * @param limit - 窗口内最多几条。
 * @returns 按时间升序的消息；会话不可读时返回空数组（调用方退化为单条引用）。
 */
export declare function loadMessageWindow(decryptedDir: string, username: string, centerMs: number, spanMs: number, limit?: number): WindowMessage[];
/**
 * Search WeChat's own message_fts.db (message_fts_v4_* + ImgFts*) which
 * covers text AND image messages, mapping session_id back through name2id.
 * @returns hits (empty when the built-in index is absent/empty).
 */
export declare function searchWechatFts(decryptedDir: string, q: string, cap: number, names: Map<string, string>, scopeUsername?: string): {
    hits: SearchHit[];
};
/**
 * 搜索的取消通道（N9）。与导出的 `StreamControl` 同构，但搜索没有进度可言，只留取消令牌。
 */
export interface SearchControl {
    /** 取消令牌；aborted 后兜底扫描尽快收尾，返回已找到的部分并带 `cancelled: true`。 */
    signal?: AbortSignal;
}
/** 兜底扫描的协作粒度：每 128 行查一次取消（在慢 20 倍的 runner 上也能守住 100ms 口径）。 */
export declare const ABORT_CHECK_EVERY_ROWS = 128;
/** 让出事件循环的时间预算：单次不让出的时间超过它就 `await setImmediate`。 */
export declare const YIELD_EVERY_MS = 25;
/**
 * 一行 → 命中（不匹配返回 null）。两个驱动共用，保证匹配与摘要口径只有一份。
 * @param row - 消息表原始行。
 * @param talker - 该行所属会话 username。
 * @param qLower - 已小写的查询词。
 * @param names - username → 显示名。
 * @returns SearchHit 或 null。
 */
export declare function hitFromRow(row: Record<string, unknown>, talker: string, qLower: string, names: Map<string, string>): SearchHit | null;
/**
 * 索引与内置 FTS 两条快路径。都没命中时返回 null —— 由调用方决定要不要走兜底扫描。
 * @param decryptedDir - decrypted data root.
 * @param q - 原始查询词。
 * @param cap - 命中上限。
 * @param names - username → 显示名。
 * @param username - 可选：只搜一个 talker。
 * @returns 命中结果，或 null（两条快路径都没命中）。
 */
export declare function probeIndexedSources(decryptedDir: string, q: string, cap: number, names: Map<string, string>, username?: string): {
    hits: SearchHit[];
    total: number;
    indexed: boolean;
} | null;
/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @returns hits plus whether the index was used.
 */
export declare function searchIndexMessages(decryptedDir: string, query: string, limit?: number, username?: string): {
    hits: SearchHit[];
    total: number;
    indexed: boolean;
};
/**
 * 与 {@link searchIndexMessages} 同一条链路，但**可取消**（N9，界面搜索专用）。
 *
 * 两件事一起做才有意义 ——
 *   · 每 {@link ABORT_CHECK_EVERY_ROWS} 行看一眼 `ctrl.signal`，取消即收尾（返回部分结果 + `cancelled`）；
 *   · 每 {@link YIELD_EVERY_MS} 毫秒 `await setImmediate` 让出 —— **这是取消能生效的前提**：
 *     本函数跑在后端 worker 里，不让出的话 worker 根本读不到 `cancelSearch` 那条消息，
 *     令牌永远不会被 aborted（旧实现实测单次 621ms~2.5s、期间 10ms 定时器 0 次触发）。
 *
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @param ctrl - 可选的取消令牌（见 {@link SearchControl}）。
 * @returns hits plus whether the index was used；被取消时多一个 `cancelled: true`。
 */
export declare function searchIndexMessagesCancellable(decryptedDir: string, query: string, limit?: number, username?: string, ctrl?: SearchControl): Promise<{
    hits: SearchHit[];
    total: number;
    indexed: boolean;
    cancelled?: boolean;
}>;
