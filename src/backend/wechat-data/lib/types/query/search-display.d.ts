/**
 * 搜索命中行的**展示形状**：群前缀切分、发送者名字、可读文本。
 *
 * ## 为什么要单独一个叶子模块
 *
 * 这几个函数原先住在 `search-query.ts` 里，而 `search-scaffold.ts` 与 `search-build.ts`
 * 都要用它们 —— 于是形成 `scaffold → build → query → scaffold` 的值 import 环
 * （第三批 #21 解开的五个环之一）。它们**不碰数据库、不碰索引**，纯粹是字符串处理，
 * 所以天然属于最下面一层：挪出来之后三个文件都只往这个叶子指，方向重新变成单向。
 *
 * 时间格式化**不**在这里：`YYYY-MM-DD HH:MM` 后端已有唯一出处
 * `src/format.ts#fmtDateTimeSec`（两者输出逐字节相同，后者还多挡了 null/NaN），
 * 再造一份会被 `src/backend/tests/format-single-source.spec.ts` 判成第二份实现。
 *
 * @module search-display
 */
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
