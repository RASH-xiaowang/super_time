/**
 * AI 回复扫描的汇总留痕。
 *
 * 每一拍扫描只写一条操作日志，且必须「有事实才写」：后台每 10 秒一拍、
 * 会话一多就会把操作日志刷成噪音。这里按 detail 文本做 10 分钟去重，
 * 只记录计数与原因码，**不记录会话正文、模型输出或错误原文**。
 */
/** 同一份汇总 10 分钟内只落一次。 */
export declare const CHAT_AI_REPLY_SCAN_REPORT_DEDUPE_MS: number;
/**
 * 判断这份汇总现在该不该写。
 *
 * `now` 可注入，便于测试确定性；生产使用真实时钟。
 */
export declare function shouldWriteChatAiReplyScanReport(detail: string, now?: number): boolean;
/** 仅用于测试：清空去重记忆。 */
export declare function resetChatAiReplyScanReportDedupe(): void;
/**
 * 把一次扫描里的事件计数拼成稳定的原因串。
 *
 * 顺序固定，保证同一组事实总得到同一段文本（去重才有意义）。
 */
export declare function formatChatAiReplyScanDetail(counts: Readonly<Record<string, number>>): string;
