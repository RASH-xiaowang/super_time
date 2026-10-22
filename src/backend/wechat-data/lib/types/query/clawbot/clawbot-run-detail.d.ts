/**
 * ClawBot 自动回复运行详情的落库摘要。
 *
 * 这一层只负责把 {@link ClawbotReplyRunDetail} 压成字段白名单 JSON、解析旧行，
 * 以及合并少量终态字段。所有函数都必须容错：调用方在自动回复主循环和消息列表里，
 * 诊断信息不可写或不可读不能反过来中断回复/列表。
 *
 * @module query/clawbot/clawbot-run-detail
 */
import type { ClawbotReplyAskResult, ClawbotReplyRunDetail } from './clawbot-reply-types.ts';
/**
 * 把运行详情压成可落库白名单 JSON。
 *
 * 失败（循环引用、BigInt、超长）时逐级降级，最终只保留最小诊断字段；
 * 本函数保证不抛异常，因为调用方在自动回复主循环里。
 */
export declare function serializeReplyRunDetail(detail: ClawbotReplyRunDetail): string;
/** 解析旧行/坏 JSON/超范围字段；失败返回 null，绝不把异常抛给消息列表。 */
export declare function parseReplyRunDetail(json: string | null): ClawbotReplyRunDetail | null;
/** 以旧摘要为底覆盖少数终态字段（例如发送失败覆盖 sendDecision）。 */
export declare function mergeReplyRunDetail(json: string | null, runId: number, patch: Partial<ClawbotReplyRunDetail>): string;
/** 从注入的 ask 结果构造落库摘要；成功/降级/拒绝发送共用同一口径。 */
export declare function replyRunDetailJson(runId: number, result: ClawbotReplyAskResult, patch?: Partial<ClawbotReplyRunDetail>): string;
