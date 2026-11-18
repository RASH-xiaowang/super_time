import type { ChatAiReplyRunRef } from './runner-state.ts';
import type { ChatAiReplyScanDeps, ChatAiReplyState } from './types.ts';
/**
 * 把「上下文时间窗（小时）」换算成消息时间起点。
 *
 * 基准是**触发消息的时间**而不是当前时间：消息可能延迟处理（App 刚启动、积压补发），
 * 用「现在」当基准会把本该回答的那一轮对话直接裁掉，模型甚至拿不到提问。
 * @param anchorCreateTime - 触发消息的 createTime（秒）。
 * @param contextWindowHours - 会话设置：0 表示不限。
 * @returns 起点秒数；0 表示不做时间过滤。
 */
export declare function contextWindowStart(anchorCreateTime: number, contextWindowHours: number | undefined): number;
/** 一次性生成的结果；`canceled` 时 `text` 只含已经流出的部分正文。 */
export interface ChatAiReplyGeneration {
    text: string;
    canceled: boolean;
}
export declare function generateChatAiReply(deps: ChatAiReplyScanDeps, state: ChatAiReplyState, run: ChatAiReplyRunRef): Promise<ChatAiReplyGeneration>;
