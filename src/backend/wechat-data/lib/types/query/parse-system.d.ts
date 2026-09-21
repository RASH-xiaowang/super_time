/**
 * 系统消息与 @提及 的解析（M21 拆分）：噪声标签剥离、系统消息文本、@用户名、msgsource 签名。
 *
 * 从 `parse.ts` 原样搬出，**行为逐字节不变**（依赖 `parse-xml.ts`）。
 *
 * @module parse-system
 */
/**
 * 群置顶/取消置顶系统消息（`<sysmsg type="chatroomtopmsg">`）。
 * @param xml - the raw sysmsg XML.
 * @returns the human sentence, or ''.
 */
export declare function parseChatroomTop(xml: string): string;
/**
 * 系统消息里只承载机器语义的节点 —— 展示时必须整块丢掉。
 *
 * 实测撤回两种形态：
 *  - `<revokemsg><content>"Wave" 撤回了一条消息</content><revoketime>0</revoketime></revokemsg>`
 *  - `<revokemsg><replacemsg><![CDATA[…]]></replacemsg><session>…@chatroom</session><newmsgid>…</newmsgid></revokemsg>`
 * 第二种若只做「取文本节点」会得到
 * `50345516636@chatroom 123456789 987654321 "某人" 撤回了一条消息`
 * —— 一串 id 混在正文里（旧实现就是这个症状）。
 */
export declare const SYS_NOISE_TAGS: string[];
/** 去重后的噪声标签（原列表里 `revoketime` 写了两遍，等于白跑一趟）。 */
export declare const SYS_NOISE_TAGS_UNIQUE: string[];
/** 剥掉系统消息里的 id/时间噪声节点，只留可读文本。 */
export declare function stripSystemNoise(xml: string): string;
/**
 * 系统消息（local_type 10000）解析。
 *
 * 旧实现对整段 XML 做「取文本节点」，对撤回消息会把 `<session>`/`<msgid>`/
 * `<newmsgid>` 这些 id 一起显示出来（实测
 * `50345516636@chatroom 123456789 987654321 "某人" 撤回了一条消息`）。
 * 这里按子类型分开处理：撤回只取 `replacemsg`/`content`，置顶自己成句，
 * 其余才退回文本节点。
 * @param xml - the decoded `<sysmsg …>` body.
 * @returns the readable text plus the sub-kind (revoke / top / template / plain).
 */
export declare function parseSystemMessage(xml: string): {
    text: string;
    kind: string;
};
/**
 * 从 `source` 列（`<msgsource><atuserlist>…`）里取被 @ 的 wxid。
 *
 * WeChat 4.x **不在** message_content 里存结构化 @ 列表，而是在 `source` 列的
 * `<msgsource>` XML 里：`<atuserlist><![CDATA[wxid_a,wxid_b]]></atuserlist>`，
 * 全选时是 `notify@all`。没有它，界面只能靠正则猜 `@昵称`，@ 与昵称不对齐时
 * 就会把普通文本里的 `@` 高亮成提及。
 * @param source - the decoded `source` column value.
 * @returns deduped at-usernames (may be empty).
 */
export declare function parseAtUsernames(source: string): string[];
/**
 * `<msgsource>` 里的签名/来源标记（反垃圾签名），仅用于诊断展示。
 * @param source - the decoded `source` column value.
 * @returns the signature text, or ''.
 */
export declare function parseMsgsourceSignature(source: string): string;
