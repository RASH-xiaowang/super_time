/** 归档库路径：数据根下（与 `decoded_images` 同级，不进解密目录以免被同步覆盖）。 */
export declare function messageArchivePath(decryptedDir: string): string;
/** 一条归档消息。 */
export interface ArchivedMessage {
    /** 会话标识：`WechatSession.username` 的等价物（本模块用「文件#表名」表示，见 `talkerOfTable`）。 */
    talker: string;
    rowKey: number;
    createTime: number;
    localType: number;
    senderId: number;
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
/** 列表项（与旧的插件来源同形状，面板不需要改）。 */
export interface RetainedRevokeItem {
    sender: string;
    type_label: string;
    content: string;
    create_time: number;
}
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
