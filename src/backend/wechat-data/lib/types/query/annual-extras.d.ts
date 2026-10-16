/** 一行已解码的年度消息（调用方负责解压/编码转换，本模块不碰 DB、不碰 Buffer）。 */
export interface AnnualRowInput {
    /** 微信 type 列。 */
    type: number;
    /** 秒级时间戳。 */
    ts: number;
    /** 已解码正文（XML 与纯文本都在这里）。 */
    text: string;
    /** 发送者显示名。 */
    sender: string;
    /** 是否我发的。 */
    mine: boolean;
}
/** 这条消息所属的会话。 */
export interface AnnualChatInput {
    username: string;
    name: string;
    /** 是否群聊（chatroom）。 */
    isGroup: boolean;
}
/** 年度资金（转账/红包）汇总。 */
export interface AnnualMoney {
    /** 全年资金类消息**笔数**。 */
    count: number;
    /** 金额合计（元，两位小数）。 */
    total: number;
    /** 最大一笔的金额。 */
    topAmount: number;
    /** 最大一笔对应的会话显示名（拿不到就空串）。 */
    topPeerName: string;
    /** 往来金额 TOP5（按金额倒序，同额按 username 升序，保证确定性）。 */
    byPeer: Array<{
        username: string;
        name: string;
        amount: number;
        count: number;
    }>;
}
/** 年度撤回汇总。 */
export interface AnnualRevoke {
    /** 全年撤回条数。 */
    count: number;
    /** 撤回最多的会话显示名（拿不到就空串）。 */
    topPeerName: string;
    /** 24 个时段桶（0..23 点）的撤回条数。 */
    byHour: number[];
}
/** 群聊年度汇总。 */
export interface AnnualGroups {
    /** 全年群聊消息条数（含所有人）。 */
    messages: number;
    /** 群聊占全年全部消息的比例（0..1，全部消息为 0 时给 0）。 */
    share: number;
    /** 最活跃的群 TOP5（按条数倒序，同数按 username 升序）。 */
    top: Array<{
        username: string;
        name: string;
        count: number;
    }>;
}
/**
 * 建一个累加器：`onRow` 每行调一次，`done()` 取结果（可重复调用，不得改内部状态）。
 *
 * 用法（接在 `annual-review.ts` 的行循环里）：
 * ```ts
 * const extras = createAnnualExtras()
 * for (const r of cur) {
 *   extras.onRow({ type, ts, text, sender, mine }, { username, name, isGroup })
 * }
 * const { money, revoke, groups } = extras.done()
 * ```
 * @returns `{ onRow, done }` 两个纯函数。
 */
export declare function createAnnualExtras(): {
    onRow(row: AnnualRowInput, chat: AnnualChatInput): void;
    done(): {
        money: AnnualMoney;
        revoke: AnnualRevoke;
        groups: AnnualGroups;
    };
};
