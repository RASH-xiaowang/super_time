import type { LedgerSnapshot } from '../types.ts';
/** 账本计算被取消时的稳定错误码（问答工具据此返回「已取消」而不是「读失败」）。 */
export declare const LEDGER_CANCELED_CODE = "ledger_canceled";
/** 判断异常是否来自取消（而不是数据读取失败）。 */
export declare function isLedgerCanceled(error: unknown): boolean;
/**
 * Compute the funds ledger snapshot.
 *
 * G（2026-09-28 性能修复）：实测 `queryLedger` 无缓存时 **125ms**，而它每次被
 * 「账本面板重渲染 / 切月 / 切回来」都整跑一遍 —— 但它的输入只有三样东西：
 * 会话库、通讯录库、消息分片目录，全都可以用文件签名判断「变没变」。
 * 所以按签名缓存（`cachedBySigAsync`，与 `queryGraph` 同一个入口）。
 *
 * 签名含 `month` 与 `selfUsername`：两者都是查询参数，混用会让「切月后拿到上月数据」
 * 这种错静默发生。等价的单张缓存示例见 `contacts.ts`（把参数编进 key）。
 * @param decryptedDir - decrypted data root.
 * @param month - optional YYYY-MM filter.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @returns the ledger snapshot.
 */
export declare function queryLedger(decryptedDir: string, month?: string, selfUsername?: string): Promise<LedgerSnapshot>;
/** 逐笔资金记录（`get_funds_summary` 的 hits 用；不是面板快照的一部分）。 */
export interface LedgerFundRecord {
    recordType: 'transfers' | 'redpackets';
    /** 相对当前账号的方向：收入 / 支出 / 无法判断（第三方之间）。 */
    direction: 'in' | 'out' | 'unknown';
    /** 本地时区 epoch 秒；0 = 本地数据无法证明时间。 */
    time: number;
    /** 资金记录所属会话（原样存储值）。 */
    session: string;
    /** 交易对方 username（收入=付款人，支出=收款人/会话）。 */
    username: string;
    /** 交易对方显示名。 */
    name: string;
    /** 企业微信联系人的企业名称。 */
    enterpriseName?: string;
    /** 整数分；`null` = 本地卡片没有可证明的人民币金额（不得伪造成 0）。 */
    amountCents: number | null;
    /**
     * 本地证据能证明的状态。
     *
     * `received`/`sent` 只表示资金表把这一笔记成了对应方向；红包的领取/退回
     * 必须有本地系统消息证据才升级成 `received`/`returned`，其余保持 `unknown`。
     */
    status: 'received' | 'sent' | 'returned' | 'claimed-other' | 'invalid' | 'unknown';
    /**
     * 资金表的原始状态值（红包 `hb_status/receive_status`）。
     *
     * 取值域在本仓库没有权威映射，只用于在「状态未确认」时如实附上原值；
     * 绝不据此推断「已领取/已退回」。
     */
    rawStatus?: string;
    transferId?: string;
    sendId?: string;
    serverId?: string;
}
/** 按联系人合并后的收支（TOP 事实用；不截断，由调用方按 top 取）。 */
export interface LedgerContactTotal {
    username: string;
    name: string;
    enterpriseName?: string;
    count: number;
    amountInCents: number;
    amountOutCents: number;
}
/** 范围版账本查询参数（epoch 秒，含端点；0/缺省 = 该端不限）。 */
export interface LedgerRangeOptions {
    from?: number;
    to?: number;
    /** 限定联系人或会话；空 = 全库。 */
    username?: string;
    /** 只算收入或只算支出；缺省 = 全部。 */
    direction?: 'in' | 'out';
    /** 只算转账或只算红包；缺省 = 全部。 */
    kind?: 'transfer' | 'redpacket';
    /** 是否收集异常提醒（默认 true）。 */
    includeWarnings?: boolean;
    /** 取消信号：长循环每 512 行检查一次。 */
    signal?: AbortSignal;
}
/** 范围版账本结果：快照 + 逐笔明细 + 未截断的按人汇总。 */
export interface LedgerRangeResult {
    snapshot: LedgerSnapshot;
    records: LedgerFundRecord[];
    contactTotals: LedgerContactTotal[];
    /**
     * 红包时间无法证明、已回退为「全部时间统计」。true 时调用方必须如实标注，
     * 不能把这个区间内的红包数说成精确值。
     */
    redpacketsAllTime: boolean;
    /** general.db 是否存在（false 时调用方应返回 not_configured）。 */
    generalExists: boolean;
}
/**
 * 范围版资金账本（问答 `get_funds_summary` 的专用入口）。
 *
 * 刻意不改 `queryLedger` 的签名与 month 口径：面板的行为必须逐字不变。
 * 本函数只把同一套计算体换成「显式 epoch 范围 + 可选会话/方向/类型过滤」，
 * 并额外带回逐笔明细与未截断的联系人汇总。
 * @param decryptedDir - decrypted data root.
 * @param options - 范围与过滤参数（epoch 秒，含端点）。
 * @param opts.selfUsername - 当前账号 wxid；为空时方向只能是 unknown。
 * @returns 快照、明细与降级标记。
 */
export declare function queryLedgerRange(decryptedDir: string, options: LedgerRangeOptions, opts?: {
    selfUsername?: string;
}): Promise<LedgerRangeResult>;
